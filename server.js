'use strict';

// Snatcher — paste a link, grab the media. Express 5 + EJS.
// The server is a resolver + signed download proxy: it never stores media,
// and /dl only streams URLs Snatcher itself produced (HMAC-signed).

const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');

const config = require('./src/config');
const logger = require('./src/logger');
const { SnatcherError, Errors, errorPageFor, toSnatcherError } = require('./src/errors');
const { validateMediaUrl, validateProxyUrl, detectPlatform } = require('./src/validate');
const {
  verifyDownload,
  buildYtDlpDownloadUrl,
  buildDirectDownloadUrl,
  ytdlpPayload,
  directPayload,
  needsBuffer,
} = require('./src/download-links');
const { resolveMedia, resolveForBatch, getYouTubeInfo, safeFilename, urlFingerprint, captionNameBase } = require('./src/media');
const ytdlp = require('./src/yt-dlp');
const { FORMAT_ID_RE } = ytdlp;
const { cachedResolve, cacheStats, queue } = require('./src/cache');

const app = express();
app.set('trust proxy', 1); // Koyeb terminates TLS in front of us.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- middleware ------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com', 'https://api.fontshare.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdn.fontshare.com'],
        imgSrc: ["'self'", 'data:', 'https:'],
        mediaSrc: ["'self'", 'https:'],
        connectSrc: ["'self'"],
      },
    },
  })
);
app.use(compression());
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
// Static assets revalidate on every load (max-age 0, ETag handles the 304).
// A long cache here once stuck the old Midnight stylesheet in browsers for a
// full day after the Coral redeploy — the browser never even asked the server
// for the new CSS, so no rebuild could fix it. Revalidation costs nothing
// (304 when unchanged) and a changed file is picked up immediately.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// Request log: method + pathname + status + ms only. Never the query string
// or body — those can carry a pasted (possibly private) post URL.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const pathname = req.path;
    logger.info(
      { method: req.method, path: pathname, status: res.statusCode, ms: Date.now() - start },
      'request'
    );
  });
  next();
});

// Downloads + API calls are the abusable surface: 60/min per IP.
const apiLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  max: config.rateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => {
    const err = Errors.rateLimited();
    if (req.path.startsWith('/api/') || req.path === '/dl') {
      return res.status(429).json({ success: false, error: err.message, code: err.code });
    }
    return res.redirect('/error?code=rate_limited');
  },
});
app.use(['/api', '/dl'], apiLimiter);

// --- platform pages --------------------------------------------------------
const PLATFORMS = {
  instagram: {
    key: 'instagram',
    name: 'Instagram',
    title: 'Instagram Downloader',
    subtitle: 'Reels, posts and carousels — every photo and video inside, yours to pick.',
    placeholder: 'Paste your Instagram link here...',
    hint: 'Works with reels, single posts and carousel posts.',
  },
  youtube: {
    key: 'youtube',
    name: 'YouTube',
    title: 'YouTube Downloader',
    subtitle: 'Pick a video, choose the quality, grab the file.',
    placeholder: 'Paste your YouTube link here...',
    hint: 'Videos and Shorts. Pick a format after the info loads.',
  },
  pinterest: {
    key: 'pinterest',
    name: 'Pinterest',
    title: 'Pinterest Downloader',
    subtitle: 'Pins, photos and videos in high quality.',
    placeholder: 'Paste your Pinterest link here...',
    hint: 'Use the Photos / Videos switch to filter the results.',
  },
  tiktok: {
    key: 'tiktok',
    name: 'TikTok',
    title: 'TikTok Downloader',
    subtitle: 'Videos without the watermark.',
    placeholder: 'Paste your TikTok link here...',
    hint: 'Paste any TikTok video link.',
  },
  facebook: {
    key: 'facebook',
    name: 'Facebook',
    title: 'Facebook Downloader',
    subtitle: 'Videos from posts, reels and watch.',
    placeholder: 'Paste your Facebook link here...',
    hint: 'Paste a Facebook video, reel or post link.',
  },
  twitter: {
    key: 'twitter',
    name: 'Twitter/X',
    title: 'Twitter/X Downloader',
    subtitle: 'Videos from posts, in the best quality available.',
    placeholder: 'Paste your Twitter/X link here...',
    hint: 'Paste a tweet link with a video.',
  },
};

const PLATFORM_KEYS = Object.keys(PLATFORMS);

// --- helpers ---------------------------------------------------------------
function withDownloadLinks(platform, title, items, sourceUrl, caption) {
  const captionBase = captionNameBase(caption);
  // Name base: the caption's first words when the post has one, else the
  // title/platform plus the link's fingerprint — the fingerprint is what
  // keeps every no-caption file distinct. No media id in any name.
  const base =
    captionBase ||
    `${title || platform} ${sourceUrl ? urlFingerprint(sourceUrl) : ''}`.trim();
  return items.map((item, i) => {
    const filename = safeFilename(base, item.ext, {
      tag: items.length > 1 ? String(i + 1) : undefined,
    });
    let downloadUrl;
    if (item.ytdlp && item.ytdlp.url && item.ytdlp.formatId) {
      // HLS / segmented media: the proxy converts it to a real file.
      // Merged formats and HLS buffer to disk first (their output size is
      // unknowable until the file exists); single files stream live with
      // their exact size in the signed payload.
      const buffer = needsBuffer({
        formatId: item.ytdlp.formatId,
        isHls: /\.m3u8(\?|$)/i.test(item.url || ''),
      });
      downloadUrl = buildYtDlpDownloadUrl({
        url: item.ytdlp.url,
        formatId: item.ytdlp.formatId,
        ext: item.ytdlp.ext || 'mp4',
        client: item.ytdlp.client,
        filename,
        size: buffer ? null : item.size,
        buffer: buffer || undefined,
      });
    } else {
      downloadUrl = buildDirectDownloadUrl({ url: item.url, filename, size: item.size || null });
    }
    return {
      ...item,
      downloadUrl,
      filename,
    };
  });
}

function sendApiError(res, err) {
  const e = toSnatcherError(err);
  logger.warn({ code: e.code, status: e.status }, 'api error');
  return res.status(e.status).json({ success: false, error: e.message, code: e.code });
}

// --- health ----------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

app.get('/health/ready', async (req, res) => {
  const ytdlpVersion = await ytdlp.binaryAvailable();
  res.status(200).json({
    status: ytdlpVersion ? 'ready' : 'degraded',
    checks: {
      ytdlp: ytdlpVersion ? `ok (${ytdlpVersion})` : 'missing',
      cookies: ytdlp.hasCookies() ? 'configured' : 'not configured',
      cache: cacheStats(),
      queue: { pending: queue.pending, size: queue.size },
    },
    timestamp: new Date().toISOString(),
  });
});

// --- pages -----------------------------------------------------------------
app.get('/', (req, res) => {
  res.render('home', { platforms: PLATFORMS });
});

app.get('/error', (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : 'unknown';
  const page = errorPageFor(code);
  // "Report on WhatsApp" prefills a message to the owner with the error
  // and the link that failed, so the user only has to tap send. The URL
  // rides in as ?url= from the redirect and is used only when it parses
  // as a real http(s) link — anything else is dropped, never echoed.
  let attemptedUrl = null;
  if (typeof req.query.url === 'string' && req.query.url.length <= 2000) {
    try {
      const parsed = new URL(req.query.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        attemptedUrl = req.query.url;
      }
    } catch {
      // Not a URL — leave it out of the report.
    }
  }
  const lines = [
    'Snatcher error report',
    `Error: ${code} — ${page.title}`,
    `Link: ${attemptedUrl || 'not given'}`,
    `Time: ${new Date().toISOString()}`,
  ];
  const reportUrl = `https://wa.me/${config.reportWhatsappNumber}?text=${encodeURIComponent(lines.join('\n'))}`;
  res.status(page.status).render('error', { code, page, platforms: PLATFORMS, reportUrl });
});

app.get('/:platform', (req, res, next) => {
  const platform = req.params.platform.toLowerCase();
  // Fixed routes defined below (e.g. /dl) must not be swallowed by this
  // catch-all — let them fall through.
  if (platform === 'dl') return next();
  // Browsers still ask for /favicon.ico even though the page links the SVG
  // — serve the same file instead of a 404.
  if (platform === 'favicon.ico') {
    return res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
  }
  const cfg = PLATFORMS[platform];
  if (!cfg) return res.redirect('/error?code=not_found');
  res.render('platform', { platform: cfg, platforms: PLATFORMS });
});

// --- YouTube: two-step flow (info → format → convert) -----------------------
app.post('/api/youtube/info', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'URL is required', code: 'invalid_url' });
    const info = await getYouTubeInfo(url);
    res.json({ success: true, data: info });
  } catch (err) {
    sendApiError(res, err);
  }
});

app.post('/api/youtube/convert', async (req, res) => {
  try {
    const { url, formatId } = req.body || {};
    if (!url || !formatId) {
      return res.status(400).json({ success: false, error: 'URL and format are required', code: 'invalid_url' });
    }
    // formatId goes to a spawned process: only yt-dlp format selectors.
    if (!FORMAT_ID_RE.test(formatId)) {
      throw Errors.invalidUrl('That format is not valid.');
    }
    const { url: cleanUrl } = await validateMediaUrl(url, 'youtube');
    const info = await getYouTubeInfo(cleanUrl);
    const format = info.formats.find((f) => f.id === formatId);
    if (!format) throw Errors.invalidUrl('That format is not available for this video.');
    const captionBase = captionNameBase(info.caption);
    const base = captionBase || `${info.title} ${urlFingerprint(cleanUrl)}`;
    const filename = safeFilename(base, format.ext, {
      tag: format.quality,
    });
    // Merged video+audio buffers to disk first (output size unknowable
    // until merged); a single audio file streams live with its exact size.
    const buffer = format.id.includes('+');
    const downloadUrl = buildYtDlpDownloadUrl({
      url: cleanUrl,
      formatId,
      ext: format.ext,
      client: info.client,
      filename,
      size: buffer ? null : format.size,
      buffer: buffer || undefined,
    });
    res.json({
      success: true,
      data: {
        downloadUrl,
        title: info.title,
        format: format.type,
        quality: format.quality,
        filename,
      },
    });
  } catch (err) {
    sendApiError(res, err);
  }
});

// --- per-platform resolve ----------------------------------------------------
app.post('/:platform/download', async (req, res) => {
  try {
    const platform = req.params.platform.toLowerCase();
    if (!PLATFORM_KEYS.includes(platform) || platform === 'youtube') {
      throw Errors.unsupportedPlatform(
        platform === 'youtube'
          ? 'YouTube uses the info → format → convert flow.'
          : undefined
      );
    }
    const { url, mediaType } = req.body || {};
    if (!url) {
      return res.status(400).json({ success: false, error: 'URL is required', code: 'invalid_url' });
    }
    const result = await resolveMedia(url, platform);
    let items = result.items;
    // Pinterest keeps its photo/video selector: it filters the unified items.
    if (platform === 'pinterest' && (mediaType === 'photo' || mediaType === 'video')) {
      const want = mediaType === 'photo' ? 'image' : 'video';
      const filtered = items.filter((item) => item.type === want);
      if (filtered.length > 0) items = filtered;
    }
    res.json({
      success: true,
      platform,
      title: result.title,
      thumbnail: result.thumbnail,
      caption: result.caption || null,
      mediaItems: withDownloadLinks(platform, result.title, items, url, result.caption),
    });
  } catch (err) {
    sendApiError(res, err);
  }
});

// --- batch: many links, one call ---------------------------------------------
app.post('/api/batch', async (req, res) => {
  try {
    const { urls } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ success: false, error: 'Send an array of URLs.', code: 'invalid_url' });
    }
    if (urls.length > config.batchMaxUrls) {
      return res.status(400).json({
        success: false,
        error: `At most ${config.batchMaxUrls} links per batch.`,
        code: 'invalid_url',
      });
    }
    const results = await Promise.all(
      urls.map(async (rawUrl) => {
        try {
          const result = await resolveForBatch(rawUrl);
          return {
            url: rawUrl,
            platform: result.platform,
            success: true,
            title: result.title,
            thumbnail: result.thumbnail,
            caption: result.caption || null,
            mediaItems: withDownloadLinks(result.platform, result.title, result.items, rawUrl, result.caption),
          };
        } catch (err) {
          const e = toSnatcherError(err);
          return { url: rawUrl, platform: detectPlatform(rawUrl), success: false, error: e.message, code: e.code };
        }
      })
    );
    res.json({ success: true, results });
  } catch (err) {
    sendApiError(res, err);
  }
});

// --- signed download proxy ---------------------------------------------------
// /dl streams a file Snatcher resolved. The signature proves Snatcher made
// the link, so this is never an open proxy. `ytdlp` items stream through
// yt-dlp with the chosen format (it converts HLS to mp4); everything else
// streams the CDN URL.
app.get('/dl', async (req, res) => {
  try {
    const { u, ytdlp: ytdlpUrl, f, ext, c, s, b, sig } = req.query;
    // `s` is the exact file size in bytes when the resolver knew it; `b=1`
    // marks a download that must buffer to disk first (merged / converted
    // output). Both ride inside the signature, so a client cannot lie
    // about them — a wrong Content-Length would corrupt the download.
    const size = /^\d+$/.test(s || '') ? parseInt(s, 10) : null;
    const buffer = b === '1';
    if (ytdlpUrl) {
      const payload = ytdlpPayload({
        url: ytdlpUrl,
        formatId: f || '',
        ext: ext || '',
        client: c || '',
        size: size || undefined,
        buffer: buffer || undefined,
      });
      if (!verifyDownload(payload, sig)) {
        return res.status(403).json({ success: false, error: 'That download link is not valid.', code: 'forbidden' });
      }
      const platform = detectPlatform(ytdlpUrl);
      if (!platform) throw Errors.invalidUrl();
      const { url: cleanUrl } = await validateMediaUrl(ytdlpUrl, platform);
      if (f && !FORMAT_ID_RE.test(f)) throw Errors.invalidUrl();
      const safeExt = /^[a-z0-9]{2,5}$/.test(ext || '') ? ext : 'mp4';
      const filename = safeFilename(req.query.name || 'snatcher_media', safeExt);
      const isAudio = safeExt === 'm4a' || safeExt === 'mp3' || safeExt === 'opus' || safeExt === 'webm';
      if (buffer) {
        // Merged / converted output: fetch to a temp file first, then serve
        // it with the real size from disk — the browser gets an exact total
        // and a working progress bar. The temp file is deleted after.
        const tmpPath = path.join(os.tmpdir(), `snatcher-${crypto.randomUUID()}.${safeExt}`);
        try {
          await ytdlp.downloadToFile(cleanUrl, f || undefined, c || undefined, tmpPath);
          const stat = await fs.promises.stat(tmpPath);
          if (stat.size > config.maxDownloadBytes) {
            await fs.promises.unlink(tmpPath).catch(() => {});
            return res.status(502).json({ success: false, error: 'That file is too large.', code: 'upstream_error' });
          }
          res.setHeader('Content-Type', isAudio ? 'audio/mp4' : 'video/mp4');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Content-Length', stat.size);
          const stream = fs.createReadStream(tmpPath);
          stream.on('error', () => res.end());
          stream.on('close', () => fs.promises.unlink(tmpPath).catch(() => {}));
          stream.pipe(res);
        } catch (err) {
          await ytdlp.cleanupDownloadFiles(tmpPath);
          throw err;
        }
        return;
      }
      res.setHeader('Content-Type', isAudio ? 'audio/mp4' : 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      if (size) res.setHeader('Content-Length', size);
      ytdlp.streamDownload(res, cleanUrl, f || undefined, c || undefined);
      return;
    }

    if (!u) {
      return res.status(400).json({ success: false, error: 'Nothing to download.', code: 'invalid_url' });
    }
    const payload = directPayload({ url: u, size: size || undefined });
    if (!verifyDownload(payload, sig)) {
      return res.status(403).json({ success: false, error: 'That download link is not valid.', code: 'forbidden' });
    }
    const cleanUrl = await validateProxyUrl(u);
    const urlExt = (new URL(cleanUrl).pathname.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i) || [])[1] || 'mp4';
    const filename = safeFilename(req.query.name || 'snatcher_media', urlExt.toLowerCase());
    // Content-Length, in order: the signed size the resolver knew, a HEAD
    // on the upstream, the GET response's own header. Without one the
    // browser shows an unknown total and no progress.
    let contentLength = size;
    if (!contentLength) {
      try {
        const head = await axios.head(cleanUrl, {
          timeout: config.upstreamTimeoutMs,
          headers: { 'User-Agent': 'Snatcher/3.0' },
        });
        const len = parseInt(head.headers['content-length'], 10);
        if (Number.isFinite(len) && len > 0) contentLength = len;
      } catch {
        // No size from HEAD — stream without one, as before.
      }
    }
    const upstream = await axios.get(cleanUrl, {
      responseType: 'stream',
      timeout: config.upstreamTimeoutMs,
      maxContentLength: config.maxDownloadBytes,
      headers: { 'User-Agent': 'Snatcher/3.0' },
    });
    const contentType = upstream.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    if (contentLength) res.setHeader('Content-Length', contentLength);
    else if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }
    let bytes = 0;
    upstream.data.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > config.maxDownloadBytes) upstream.data.destroy();
    });
    upstream.data.on('error', () => {
      if (!res.headersSent) res.status(502).end();
      else res.end();
    });
    upstream.data.pipe(res);
  } catch (err) {
    if (!res.headersSent) sendApiError(res, err);
    else res.end();
  }
});

// --- errors ------------------------------------------------------------------
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path === '/dl') {
    return res.status(404).json({ success: false, error: 'Not found.', code: 'not_found' });
  }
  res.redirect('/error?code=not_found');
});

app.use((err, req, res, next) => {
  const e = toSnatcherError(err);
  logger.error({ err: e, code: e.code }, 'unhandled error');
  if (req.path.startsWith('/api/') || req.path === '/dl') {
    return res.status(e.status).json({ success: false, error: e.message, code: e.code });
  }
  res.redirect(`/error?code=${e.code}`);
});

if (require.main === module) {
  app.listen(config.port, () => {
    logger.info(`Snatcher server running at http://localhost:${config.port}`);
    logger.info(`Platforms: ${PLATFORM_KEYS.map((k) => `/${k}`).join(', ')}`);
  });
}

module.exports = app;
