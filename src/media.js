'use strict';

// The universal media layer. Every platform resolves to the same shape:
//
//   { platform, title, thumbnail, items: [{ type, url, thumbnail, title,
//       width, height, quality, ext, size }] }
//
// type is always 'video' or 'image', detected per item — this is the
// universal function: a post, a reel, a pin or a video all come back as a
// list of typed items, each with its own download button on the frontend.
// A carousel post returns every image/video in it; a single video returns
// one item. The Pinterest photo/video toggle in the UI is just a filter over
// these items.

const crypto = require('node:crypto');
const axios = require('axios');
const { igdl, ttdl, fbdown, twitter, pinterest } = require('btch-downloader');
const config = require('./config');
const logger = require('./logger');
const { Errors, toSnatcherError, isVerdictError } = require('./errors');
const { validateMediaUrl, detectPlatform } = require('./validate');
const ytdlp = require('./yt-dlp');
const { cachedResolve } = require('./cache');

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm3u8', 'mkv']);

function extFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const match = path.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function guessTypeFromUrl(url) {
  const ext = extFromUrl(url);
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return 'video';
}

// Magic bytes → the file's real type. igdl hands back extension-less
// proxy URLs (d.rapidcdn.app/v2?token=...), so the extension guess calls
// every image a video and the file is saved as .mp4 (the player shows
// 0:00 for a JPEG wearing an mp4 name). The first bytes never lie.
function classifyMediaBytes(buf) {
  if (!buf || buf.length < 12) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image', ext: 'jpg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: 'image', ext: 'png' };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { type: 'image', ext: 'webp' };
  if (b.toString('ascii', 0, 4) === 'GIF8') return { type: 'image', ext: 'gif' };
  if (b.toString('ascii', 4, 8) === 'ftyp') return { type: 'video', ext: 'mp4' };
  return null;
}

// Read the first 16 bytes of a URL and classify the real file. Only for
// extension-less URLs. Streams, never downloads the whole file: a Range
// request returns 16 bytes, and if the server ignores Range the stream is
// destroyed after the first chunk. Best effort — null on any failure, and
// the caller keeps its guessed type.
async function sniffMediaType(url, timeoutMs = 8000) {
  try {
    const res = await axios.get(url, {
      responseType: 'stream',
      timeout: timeoutMs,
      maxRedirects: 5,
      headers: { Range: 'bytes=0-15', 'User-Agent': 'Snatcher/3.0' },
      validateStatus: (s) => s === 200 || s === 206,
    });
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of res.data) {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= 16) break;
      }
    } finally {
      if (res.data && typeof res.data.destroy === 'function') res.data.destroy();
    }
    return classifyMediaBytes(Buffer.concat(chunks));
  } catch {
    return null;
  }
}

function normalizeItem(raw, fallbackTitle) {
  const url = raw.url || raw.mediaUrl || raw.downloadUrl;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return null;
  let type = String(raw.type || '').toLowerCase();
  if (type !== 'video' && type !== 'image') type = guessTypeFromUrl(url);
  const thumbnail =
    raw.thumbnail && raw.thumbnail !== url ? raw.thumbnail : null;
  return {
    type,
    url,
    thumbnail,
    title: raw.title || fallbackTitle || 'media',
    width: raw.width || null,
    height: raw.height || null,
    quality: raw.quality || null,
    ext: extFromUrl(url) || (type === 'video' ? 'mp4' : 'jpg'),
    size: raw.size || raw.filesize || null,
  };
}

function dedupeByUrl(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

// Captions: the text attached to the post/video, when the source provides
// one. First non-empty candidate wins; trimmed and capped so a very long
// description cannot blow up the response. Returns null when no
// source has caption text — the frontend hides the caption box then.
// Not every source carries one: igdl (Instagram) returns media URLs only,
// so Instagram captions appear only when the yt-dlp path ran.
const CAPTION_MAX = 10000;
function pickCaption(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim().slice(0, CAPTION_MAX);
    }
  }
  return null;
}

// Best-effort caption for resolvers whose primary source carries no caption
// text (igdl for Instagram, fbdown for Facebook): ask yt-dlp for the post's
// description. It runs alongside the primary fetch, has a short timeout,
// and never fails the download — a missing caption just means no caption
// box, as before. 25 s, not 15 s: on the 0.1 vCPU free tier the yt-dlp
// spawn + extractor alone often takes longer than 15 s, so the caption
// fetch kept timing out and most Facebook videos showed no caption.
// The caption fetch is best-effort and must never dominate the resolve:
// yt-dlp answers in 2–5 s when it works, and fails at ~15 s when the
// datacenter IP is throttled — waiting the full 25 s bought nothing but
// a 15 s loading screen and, on Koyeb, a null caption anyway. 10 s keeps
// the fast successes and cuts the throttled failures short.
const CAPTION_FETCH_TIMEOUT_MS = 10000;
async function fetchCaption(url) {
  try {
    const info = await withTimeout(
      ytdlp.getInfo(url),
      CAPTION_FETCH_TIMEOUT_MS,
      'caption'
    );
    return pickCaption(info.description);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Download filenames. Every file must get a name unique to the media it
// came from, or the browser sees the same name twice and asks "download
// again?" — the old scheme was just the title, and Instagram has no
// title at all, so every reel became "Instagram_media_1.mp4".
// Name shape: First caption words tag.ext, or Title tag.ext when there
// is no caption. The tag is the item number for multi-item posts. The tag is never truncated away: the title is
// cut to make room for it. No media id appears in the name.

// A short fingerprint of a URL — looks random, but the same link always
// gives the same fingerprint. Used only when a download has no caption:
// it makes every no-caption file's name different from every other post's,
// while the same file re-downloaded still gets the same name (the one case
// where the browser SHOULD ask about downloading again). It is not a media
// id — no platform identifier appears in the filename.
function urlFingerprint(rawUrl) {
  return crypto.createHash('sha1').update(String(rawUrl || '')).digest('hex').slice(0, 8);
}

// The name base for a download: the first words of the caption, when the
// media has one. Six words is enough to recognise the file and short
// enough to stay a filename. Returns null when there is no usable caption
// — the caller falls back to the title, then the platform name. Sanitising
// happens in safeFilename, so leading emojis / hashtags / mentions simply
// drop out ("#summer vibes" -> "summer_vibes").
const CAPTION_NAME_WORDS = 6;
function captionNameBase(caption) {
  if (typeof caption !== 'string' || !caption.trim()) return null;
  const words = caption.trim().split(/\s+/).slice(0, CAPTION_NAME_WORDS).join(' ');
  return words || null;
}

function safeFilename(title, ext, opts = {}) {
  const useExt = /^[a-z0-9]{2,5}$/i.test(ext || '') ? ext.toLowerCase() : 'mp4';
  // The /dl proxy re-sanitises a name that already carries its extension —
  // strip it first, or "Title.mp4" becomes the mangled "Titlemp4.mp4".
  let base = String(title || 'snatcher').replace(new RegExp(`\\.${useExt}$`, 'i'), '');
  base = base
    .replace(/[^\w\s\[\]-]/g, '')
    .trim()
    .replace(/\s+/g, '_');
  // Download filenames. Every file must get a name unique to the media it
  // came from, or the browser sees the same name twice and asks "download
  // again?" — the old scheme was just the title, and Instagram has no
  // title at all, so every reel became "Instagram_media_1.mp4".
  // Name shape: First caption words tag.ext, or Title tag.ext when there
  // is no caption. The tag is the item number for multi-item posts. The tag is never truncated away: the title is
  // cut to make room for it. No media id appears in the name.
  const FILENAME_MAX = 80;
  const suffixParts = [];
  if (opts.tag) suffixParts.push(String(opts.tag).replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_'));
  const suffix = suffixParts.filter(Boolean).join(' ');
  const room = Math.max(0, FILENAME_MAX - (suffix ? suffix.length + 1 : 0));
  let head = base.slice(0, room).replace(/[_-]+$/, '');
  // A title in a non-Latin script (Urdu, Arabic, Chinese) sanitises to
  // nothing — the ASCII-only strip is required (HTTP headers cannot carry
  // those bytes) — so fall back to the caller's platform + fingerprint
  // instead of a bare "snatcher.mp4" that collides with every other one.
  if (!head) {
    head = String(opts.fallback || 'snatcher')
      .replace(/[^\w\s\[\]-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, room)
      .replace(/[_-]+$/, '') || 'snatcher';
  }
  return `${head}${suffix ? ` ${suffix}` : ''}.${useExt}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Errors.upstreamTimeout(`${label} took too long.`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Instagram — Reels AND posts. igdl returns every media URL in the post;
// the old sqrt-based "dedupe" is replaced by dedupe-by-URL, so a carousel
// keeps all of its images/videos. If igdl yields a single item for a /p/
// post, yt-dlp is tried as well and the two lists are merged.
// ---------------------------------------------------------------------------
async function resolveInstagram(url) {
  let items = [];
  let title = 'Instagram media';
  let caption = null;

  // igdl carries no caption text, so read the post's description with
  // yt-dlp alongside — best effort, never blocks the download.
  const captionPromise = fetchCaption(url);

  try {
    const data = await withTimeout(igdl(url), config.upstreamTimeoutMs, 'Instagram');
    const raw = Array.isArray(data && data.result)
      ? data.result
      : data && data.result
        ? [data.result]
        : [];
    title = (data && data.title) || title;
    items = raw
      .map((entry) =>
        typeof entry === 'string'
          ? normalizeItem({ url: entry }, title)
          : normalizeItem(
              {
                url: entry.url,
                thumbnail: entry.thumbnail,
                type: entry.type,
                title: entry.title,
              },
              title
            )
      )
      .filter(Boolean);
  } catch (err) {
    logger.warn({ err: err.message }, 'igdl failed, trying yt-dlp for Instagram');
  }

  const isPost = /instagram\.com\/p\//i.test(url);
  if (items.length === 0 || (isPost && items.length === 1)) {
    try {
      const info = await ytdlp.getInfo(url);
      const extra = ytdlpInfoToItems(info, title, url);
      items = dedupeByUrl([...items, ...extra]);
      if (info.title) title = info.title;
      caption = pickCaption(info.description);
    } catch (err) {
      if (items.length === 0) throw toSnatcherError(err);
      logger.warn({ err: err.message }, 'yt-dlp Instagram fallback failed');
    }
  }

  items = dedupeByUrl(items);
  // igdl's URLs are extension-less proxy links, so the extension guess
  // called every image a video and the file was saved as .mp4 (the player
  // showed 0:00 for a JPEG wearing an mp4 name). Sniff the real bytes for
  // those items and fix the type + extension. The sniff is authoritative,
  // so yt-dlp video items (also extension-less) keep their video type —
  // the extra request is one per item, in parallel.
  const ambiguous = items.filter((item) => !extFromUrl(item.url));
  if (ambiguous.length > 0) {
    const found = await Promise.all(ambiguous.map((item) => sniffMediaType(item.url)));
    found.forEach((sniffed, i) => {
      if (!sniffed) return;
      ambiguous[i].type = sniffed.type;
      ambiguous[i].ext = sniffed.ext;
    });
  }
  if (items.length === 0) throw Errors.noMedia();
  if (!caption) caption = await captionPromise;
  return { title, thumbnail: items[0].thumbnail || null, items, caption };
}

// ---------------------------------------------------------------------------
// Pinterest — yt-dlp primary (Pinterest extractor: pins, images + video, high
// quality), btch fallback. The old RapidAPI path is gone with the leaked key.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Pinterest page scrape — the alternative when yt-dlp finds no formats.
// yt-dlp's Pinterest extractor works from some IPs and not others (Koyeb's
// datacenter IP gets a page with no video data — "No media in that link"),
// and btch's Pinterest handler returns the thumbnail only (video_url null)
// for video pins. The pin page itself still carries a progressive MP4:
// https://v1.pinimg.com/videos/iht/expMp4/<hash>_<width>w.mp4 — one plain
// GET with a browser UA finds it. No third-party API, no key: the page is
// the source. Runs only after yt-dlp fails, before btch, so image pins
// still go through btch as before.
// An HLS manifest (.m3u8) is a playlist, not a file — the /dl proxy cannot
// turn one into an mp4, so an HLS-only result is not a downloadable result.
function isHlsUrl(url) {
  return typeof url === 'string' && /\.m3u8(\?|$)/i.test(url);
}

const PINTEREST_MP4_RE =
  /https:\/\/v1\.pinimg\.com\/videos\/[A-Za-z0-9\/_.\-]*?expMp4\/[A-Za-z0-9\/_.\-]*?_(\d+)w\.mp4/g;
const PINTEREST_THUMB_RE =
  /https:\/\/i\.pinimg\.com\/originals\/[A-Za-z0-9\/_.\-]+\.(?:jpg|jpeg|png|webp)/;

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Pure: pull the video (widest progressive MP4), title and thumbnail out of
// a pin page's HTML. Returns null when the page carries no video.
function extractPinterestVideo(html) {
  if (!html || typeof html !== 'string') return null;
  // Pinterest embeds JSON with escaped slashes (https:\/\/...) — unescape
  // once so one regex covers both plain and embedded URLs.
  const text = html.replace(/\\\//g, '/');
  let best = null;
  for (const match of text.matchAll(PINTEREST_MP4_RE)) {
    const width = parseInt(match[1], 10);
    if (!best || width > best.width) best = { videoUrl: match[0], width };
  }
  if (!best) {
    // Not every pin's video is an expMp4 with a width suffix — take any
    // progressive MP4 under /videos/ instead of giving up (and handing
    // btch the thumbnail). HLS manifests (.m3u8) are deliberately not
    // matched: they are playlists, not files, and the proxy cannot turn
    // one into an mp4 without a yt-dlp format id (yt-dlp already failed
    // on this pin).
    const generic = text.match(
      /https:\/\/v1\.pinimg\.com\/videos\/[A-Za-z0-9\/_.\-]*?\.mp4/
    );
    if (generic) best = { videoUrl: generic[0], width: null };
  }
  if (!best) return null;
  const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
  let title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : null;
  // The page title is "Pin title | tag, tag, ..." — drop the trailing tag
  // segment, keep the pin title (which itself may contain " | ").
  if (title) title = title.replace(/ \| [^|]*$/, '').trim() || null;
  const thumbMatch = text.match(PINTEREST_THUMB_RE);
  return {
    videoUrl: best.videoUrl,
    width: best.width,
    title,
    thumbnail: thumbMatch ? thumbMatch[0] : null,
  };
}

async function fetchPinterestViaScrape(url, timeoutMs) {
  const { data } = await axios.get(url, {
    timeout: timeoutMs,
    maxContentLength: 8 * 1024 * 1024,
    maxRedirects: 5,
    responseType: 'text',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      // A logged-in session gets the full pin page (with the video) where
      // a datacenter IP gets a variant without it — PINTEREST_COOKIES
      // holds the cookie header value (a Koyeb secret, never committed,
      // never logged), same pattern as YTDLP_COOKIES. Unset = anonymous.
      ...(config.pinterestCookies ? { Cookie: config.pinterestCookies } : {}),
    },
    validateStatus: (status) => status >= 200 && status < 400,
  });
  const result = extractPinterestVideo(data);
  if (!result) {
    // No video in the page at all — log the page size so the next
    // diagnosis can tell a challenge/block page (tiny) from a pin whose
    // video simply is not a progressive MP4 (full page, no match).
    logger.warn({ bytes: data.length }, 'Pinterest page scrape found no video');
  }
  return result;
}

async function fetchPinterestViaBtch(url, timeoutMs) {
  const data = await withTimeout(pinterest(url), timeoutMs, 'Pinterest');
  let pin = data && data.result ? data.result : null;
  if (pin && pin.result) pin = pin.result;
  if (!pin || (!pin.video_url && !pin.image)) throw Errors.noMedia();
  return pin;
}

async function resolvePinterest(url) {
  try {
    const info = await ytdlp.getInfo(url);
    const items = ytdlpInfoToItems(info, info.title || 'Pinterest media', url);
    // yt-dlp's Pinterest extractor returns HLS manifests (.m3u8) only for
    // some pins — a playlist, not a file. Drop the HLS items: the page
    // scrape below carries the progressive MP4 for the same pin, and an
    // HLS-only result must fall through to it instead of being returned
    // as if it were downloadable.
    const downloadable = items.filter((it) => !isHlsUrl(it.url));
    if (downloadable.length > 0) {
      return {
        title: info.title || 'Pinterest media',
        thumbnail: info.thumbnail || downloadable[0].thumbnail || null,
        items: downloadable,
        caption: pickCaption(info.description),
      };
    }
    if (items.length > 0) {
      logger.warn('yt-dlp Pinterest returned HLS only, trying page scrape');
    }
    throw Errors.noMedia();
  } catch (err) {
    // A real verdict (private, not found, rate-limited) — do not mask it
    // by falling back to btch. An HLS-only result (thrown as no_media
    // above) is not a verdict: it falls through to the scrape below.
    if (
      isVerdictError(err) ||
      (err && err.name === 'SnatcherError' && err.code === 'rate_limited')
    ) {
      throw err;
    }
    logger.warn({ err: err.message }, 'yt-dlp Pinterest failed, trying page scrape');
  }

  // yt-dlp found no formats (its usual failure on a flagged datacenter IP)
  // — try the pin page itself before btch, which only returns the image
  // for video pins (video_url null).
  try {
    const scraped = await fetchPinterestViaScrape(url, config.upstreamTimeoutMs);
    if (scraped && scraped.videoUrl) {
      const items = [
        normalizeItem(
          {
            url: scraped.videoUrl,
            thumbnail: scraped.thumbnail,
            type: 'video',
            title: scraped.title,
            quality: scraped.width ? `${scraped.width}p` : null,
          },
          'Pinterest video'
        ),
      ].filter(Boolean);
      if (items.length > 0) {
        return {
          title: scraped.title || 'Pinterest video',
          thumbnail: scraped.thumbnail || null,
          items,
          caption: pickCaption(scraped.title),
        };
      }
    }
  } catch (err) {
    logger.warn(
      { err: err.message, status: err.response && err.response.status },
      'Pinterest page scrape failed, trying btch'
    );
  }

  // Pinterest's scraper flakes: it sometimes returns nothing for a pin it
  // serves fine a minute later (seen live 2026-11-08 — first attempt
  // no_media, an immediate retry returned the image). One retry, only when
  // the first attempt failed fast: a timeout is not retried, the frontend's
  // 60 s budget would not survive a second full wait.
  let pin;
  try {
    pin = await fetchPinterestViaBtch(url, config.upstreamTimeoutMs);
  } catch (err) {
    if (err && err.code === 'timeout') throw err;
    pin = await fetchPinterestViaBtch(url, 15000);
  }
  const items = [
    normalizeItem(
      {
        url: pin.video_url || pin.image,
        thumbnail: pin.image || null,
        type: pin.video_url ? 'video' : 'image',
        title: pin.title,
      },
      'Pinterest media'
    ),
  ].filter(Boolean);
  return { title: pin.title || 'Pinterest media', thumbnail: pin.image || null, items, caption: pickCaption(pin.title) };
}

// ---------------------------------------------------------------------------
// TikTok — yt-dlp primary (talks to TikTok directly), btch ttdl fallback.
// No third-party API in the middle: the old silvatechinc fallback is gone —
// it is an unvetted service on a random domain, and it was dying mid-TLS
// handshake (ECONNRESET) anyway.
// ---------------------------------------------------------------------------
async function resolveTikTok(url) {
  try {
    const info = await ytdlp.getInfo(url);
    // TikTok's title IS the caption (yt-dlp returns the caption as the
    // title), so copying it into title AND item titles AND caption renders
    // the same text three times. The caption lives in `caption` only;
    // the title is a neutral label.
    // TikTok's CDN (Akamai) rejects a direct server-side fetch of the
    // signed video URL (403), so the download must go through yt-dlp —
    // forceYtdlp makes every item carry its format id for the /dl proxy.
    // ytdlpInfoToItems takes the item title from the info's own title
    // (the caption, for TikTok), so override it here — the caption lives
    // in `caption` only.
    const items = ytdlpInfoToItems(info, 'TikTok video', url, { forceYtdlp: true }).map((item) => ({
      ...item,
      title: 'TikTok video',
    }));
    if (items.length > 0) {
      return { title: 'TikTok video', thumbnail: info.thumbnail || null, items, caption: pickCaption(info.description) };
    }
    throw Errors.noMedia();
  } catch (err) {
    if (isVerdictError(err)) {
      throw err;
    }
    logger.warn({ err: err.message }, 'yt-dlp TikTok failed, trying ttdl');
  }

  const data = await withTimeout(ttdl(url), config.upstreamTimeoutMs, 'TikTok');
  if (data && data.status === true && Array.isArray(data.video) && data.video[0]) {
    const items = data.video
      .map((videoUrl) =>
        normalizeItem(
          {
            url: videoUrl,
            thumbnail: data.thumbnail || null,
            type: 'video',
            title: 'TikTok video',
          },
          'TikTok video'
        )
      )
      .filter(Boolean);
    // The ttdl URL is a dl.tiktokio.com proxy link (not a TikTok CDN
    // link). It answers 200 + video/mp4 to a plain GET from most IPs,
    // but the server-side fetch 403s from Koyeb's datacenter IP — so
    // the download goes browser-direct (withDownloadLinks hands the
    // raw tiktokio URL to the loader, which fetches it from the user's
    // own IP; it sends `access-control-allow-origin: *`). No yt-dlp
    // re-run, which is what 502'd on the throttled Koyeb IP.
    if (items.length > 0) {
      return { title: 'TikTok video', thumbnail: data.thumbnail || null, items, caption: pickCaption(data.title) };
    }
  }
  throw Errors.noMedia();
}

// ---------------------------------------------------------------------------
// Twitter/X page scrape — photo tweets. yt-dlp's Twitter extractor only
// handles videos ("No video could be found in this tweet" / "Media #1 is
// not a video" for a photo post), and btch's twitter handler finds no
// media URL for them either. The tweet page itself carries the photos:
// https://pbs.twimg.com/media/<id>.jpg — one plain GET with a browser UA
// finds them, plus the tweet text in og:description for the caption.
// Runs only after both video paths fail. Guard: when the page carries
// video.twimg.com URLs it is a VIDEO tweet — the video paths already tried
// and failed, so the scrape must not hand back the video's poster still
// as if it were the media. No third-party API, no key: the page is the
// source.
const TWITTER_MEDIA_RE =
  /https:\/\/pbs\.twimg\.com\/media\/([A-Za-z0-9_-]+)\.(jpg|jpeg|png|webp)/g;
const TWITTER_VIDEO_RE = /https:\/\/video\.twimg\.com\//;

function extractTwitterPhotos(html) {
  if (!html || typeof html !== 'string') return null;
  const text = html.replace(/\\\//g, '/');
  // A video tweet's page carries its poster stills on pbs.twimg.com too —
  // the video paths already tried and failed, so do not hand the poster
  // back as the media.
  if (TWITTER_VIDEO_RE.test(text)) return null;
  const byId = new Map();
  for (const match of text.matchAll(TWITTER_MEDIA_RE)) {
    if (!byId.has(match[1])) {
      byId.set(match[1], `https://pbs.twimg.com/media/${match[1]}.${match[2]}`);
    }
  }
  if (byId.size === 0) return null;
  const meta = (property) => {
    const m = text.match(
      new RegExp(`<meta property="${property}" content="([^"]*)"`, 'i')
    );
    return m ? decodeHtmlEntities(m[1]).trim() || null : null;
  };
  return {
    photos: [...byId.values()],
    title: meta('og:title'),
    caption: meta('og:description'),
  };
}

async function fetchTwitterViaScrape(url, timeoutMs) {
  const { data } = await axios.get(url, {
    timeout: timeoutMs,
    maxContentLength: 4 * 1024 * 1024,
    maxRedirects: 5,
    responseType: 'text',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    validateStatus: (status) => status >= 200 && status < 400,
  });
  return extractTwitterPhotos(data);
}

// ---------------------------------------------------------------------------
// Facebook — btch primary (HD then Normal), yt-dlp fallback.
// ---------------------------------------------------------------------------
async function resolveFacebook(url) {
  // fbdown carries no caption text, so read the post's description with
  // yt-dlp alongside — best effort, never blocks the download.
  const captionPromise = fetchCaption(url);
  // fbdown is intermittent (works ~2/3 times live) — one fast retry on a
  // no-video response before falling through to the slow yt-dlp path,
  // which burns ~27 s to a 504 when the backend is having a bad minute.
  // A timeout is not retried: the 30 s budget would not survive a second
  // full wait.
  let data = null;
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      data = await withTimeout(fbdown(url), config.upstreamTimeoutMs, 'Facebook');
      if (data && data.status === true && (data.HD || data.Normal_video)) break;
      lastErr = new Error((data && data.message) || 'No media URL found');
      data = null;
    } catch (err) {
      lastErr = err;
      data = null;
      if (err && err.code === 'timeout') break;
    }
  }
  if (data) {
    const items = [data.HD, data.Normal_video]
      .filter(Boolean)
      .map((videoUrl, i) =>
        normalizeItem(
          {
            url: videoUrl,
            type: 'video',
            title: 'Facebook video',
            quality: i === 0 && data.HD ? 'HD' : 'SD',
          },
          'Facebook video'
        )
      )
      .filter(Boolean);
    const best = dedupeByUrl(items);
    if (best.length > 0) {
      return { title: 'Facebook video', thumbnail: null, items: best, caption: await captionPromise };
    }
  }
  logger.warn({ err: lastErr && lastErr.message }, 'fbdown failed, trying yt-dlp for Facebook');
  const info = await ytdlp.getInfo(url);
  const items = ytdlpInfoToItems(info, 'Facebook video', url);
  if (items.length === 0) throw Errors.noMedia();
  return { title: info.title || 'Facebook video', thumbnail: info.thumbnail || null, items, caption: pickCaption(info.description) };
}

// ---------------------------------------------------------------------------
// Twitter/X — btch primary (best quality: HD, then SD, then any), yt-dlp
// fallback. Thumbnails fall back to nothing, never to the video URL itself.
// ---------------------------------------------------------------------------
async function resolveTwitter(url) {
  try {
    const data = await withTimeout(twitter(url), config.upstreamTimeoutMs, 'Twitter');
    let bestUrl = null;
    if (Array.isArray(data && data.url)) {
      for (const item of data.url) {
        if (item && typeof item === 'object' && typeof item.hd === 'string' && item.hd.startsWith('http')) {
          bestUrl = item.hd;
          break;
        }
      }
      if (!bestUrl) {
        for (const item of data.url) {
          if (item && typeof item === 'object' && typeof item.sd === 'string' && item.sd.startsWith('http')) {
            bestUrl = item.sd;
            break;
          }
        }
      }
      if (!bestUrl) {
        for (const item of data.url) {
          if (typeof item === 'string' && item.startsWith('http')) {
            bestUrl = item;
            break;
          }
          if (item && typeof item === 'object') {
            const val = Object.values(item).find(
              (v) => typeof v === 'string' && v.startsWith('http')
            );
            if (val) {
              bestUrl = val;
              break;
            }
          }
        }
      }
    } else if (data && typeof data.url === 'string' && data.url.startsWith('http')) {
      bestUrl = data.url;
    }
    if (data && data.status === true && bestUrl) {
      const items = [
        normalizeItem(
          { url: bestUrl, type: 'video', title: data.title },
          'Twitter video'
        ),
      ].filter(Boolean);
      // The btch title IS the tweet text — that is the caption here.
      return { title: data.title || 'Twitter video', thumbnail: null, items, caption: pickCaption(data.title) };
    }
    throw new Error('No media URL found. The post might be private, restricted, or unavailable.');
  } catch (err) {
    logger.warn({ err: err.message }, 'btch twitter failed, trying yt-dlp for Twitter');
    let ytdlpErr = null;
    try {
      const info = await ytdlp.getInfo(url);
      const items = ytdlpInfoToItems(info, 'Twitter video', url);
      if (items.length === 0) throw Errors.noMedia();
      return { title: info.title || 'Twitter video', thumbnail: info.thumbnail || null, items, caption: pickCaption(info.description, info.title) };
    } catch (e) {
      ytdlpErr = e;
      logger.warn({ err: e.message }, 'yt-dlp Twitter failed, trying page scrape');
    }
    // Photo tweets have no video: yt-dlp and btch both fail on them. The
    // tweet page itself carries the photos — that is the alternative.
    try {
      const scraped = await fetchTwitterViaScrape(url, config.upstreamTimeoutMs);
      if (scraped && scraped.photos.length > 0) {
        const items = scraped.photos
          .map((photoUrl) =>
            normalizeItem({ url: photoUrl, type: 'image', title: scraped.title }, 'X photo')
          )
          .filter(Boolean);
        if (items.length > 0) {
          return {
            title: scraped.title || 'X post',
            thumbnail: items[0].url,
            items,
            caption: pickCaption(scraped.caption),
          };
        }
      }
    } catch (scrapeErr) {
      logger.warn({ err: scrapeErr.message }, 'Twitter page scrape failed');
    }
    throw ytdlpErr || err;
  }
}

// ---------------------------------------------------------------------------
// yt-dlp info → universal items. Handles: a single video, a playlist-style
// entries list (carousels/sidecars), and image pins (formats with an image
// extension and no video/audio codec). Direct (https) formats are preferred;
// HLS manifests (m3u8, e.g. Pinterest videos) are NOT downloadable as a file,
// so those items carry a `ytdlp` field and the /dl proxy converts them to mp4
// with ffmpeg instead of handing the user a playlist file.
// ---------------------------------------------------------------------------
function ytdlpInfoToItems(info, fallbackTitle, sourceUrl, opts = {}) {
  const items = [];
  const entries = Array.isArray(info.entries) ? info.entries : [info];
  const pageUrl = sourceUrl || info.webpage_url || info.original_url || null;
  // forceYtdlp: route the file through yt-dlp at download time instead of
  // handing the browser a direct CDN URL. TikTok needs this: its CDN
  // (Akamai) rejects a direct server-side fetch of the signed video URL
  // with 403, whatever User-Agent or Referer is sent — but yt-dlp
  // downloads the same video fine, so the /dl proxy must re-fetch it
  // through yt-dlp. Only TikTok sets this; every other platform keeps
  // direct CDN downloads, which are faster and their CDNs allow them.
  const forceYtdlp = opts.forceYtdlp === true;
  for (const entry of entries) {
    if (!entry) continue;
    const formats = Array.isArray(entry.formats) ? entry.formats : [];
    // Audio matters: a video-only file downloads silent, and the tallest
    // format is usually a video-only DASH stream. Pick in order:
    // 1. a combined format (video + audio in one file), tallest wins;
    // 2. a format with no codec info at all (some extractors don't report
    //    codecs for progressive files — those are combined files);
    // 3. the best video-only format merged with the best audio-only
    //    format (the proxy merges them with ffmpeg, buffered to disk).
    // An audio stream counts even when its codec is undeclared:
    // Pinterest's HLS audio rendition reports acodec null while its
    // video renditions report acodec 'none'. A format that is explicitly
    // video-less (vcodec 'none') and not explicitly audio-less
    // (acodec !== 'none') is audio with an unknown codec — without this
    // the picker sees no audio at all and hands back a silent video.
    const hasAudio = (f) =>
      Boolean(f.acodec && f.acodec !== 'none') ||
      (f.vcodec === 'none' && f.acodec !== 'none' && Boolean(f.url));
    const hasVideo = (f) => Boolean(f.vcodec && f.vcodec !== 'none');
    const byHeight = (a, b) =>
      (b.height || 0) - (a.height || 0) || (b.filesize || 0) - (a.filesize || 0);
    // Direct files first, then HLS; within each, tallest wins.
    const preferDirect = (pool) => {
      const direct = pool.filter((f) => (f.protocol || '') === 'https');
      const use = direct.length > 0 ? direct : pool;
      return [...use].sort(byHeight)[0];
    };
    const videoFormats = formats.filter((f) => hasVideo(f) && f.url);
    const noInfoFormats = formats.filter(
      (f) => !f.vcodec && !f.acodec && f.url && (f.ext || '').toLowerCase() === 'mp4'
    );
    const audioFormats = formats.filter((f) => !hasVideo(f) && hasAudio(f) && f.url);
    const imageFormats = formats.filter(
      (f) =>
        (!f.vcodec || f.vcodec === 'none') &&
        (!f.acodec || f.acodec === 'none') &&
        f.url &&
        IMAGE_EXTS.has((f.ext || '').toLowerCase())
    );
    const makeVideoItem = (format, ytdlp) => {
      const isHls = String(format.protocol || '').startsWith('m3u8');
      const item = normalizeItem(
        {
          url: format.url,
          thumbnail: entry.thumbnail || info.thumbnail || null,
          type: 'video',
          title: entry.title || info.title,
          quality: format.height ? `${format.height}p` : null,
          size: format.filesize || format.filesize_approx || null,
        },
        fallbackTitle
      );
      if (!item) return null;
      if (isHls || ytdlp || forceYtdlp) {
        // HLS is converted to a real mp4 by the proxy; a merged
        // video+audio pair is merged by it the same way. With forceYtdlp
        // (TikTok) a direct file goes through yt-dlp the same way, so the
        // descriptor is the format itself, not a merge.
        item.ext = 'mp4';
        item.ytdlp = ytdlp || {
          url: pageUrl,
          formatId: format.format_id,
          ext: 'mp4',
        };
      }
      return item;
    };
    const combined = videoFormats.filter((f) => hasAudio(f));
    const best =
      (combined.length > 0 ? preferDirect(combined) : null) ||
      (noInfoFormats.length > 0 ? preferDirect(noInfoFormats) : null);
    if (best) {
      const item = makeVideoItem(best);
      if (item) items.push(item);
    } else if (videoFormats.length > 0) {
      const videoOnly = videoFormats.filter((f) => !hasAudio(f));
      const video = videoOnly.length > 0 ? preferDirect(videoOnly) : null;
      const audio =
        audioFormats.length > 0
          ? [...audioFormats].sort((a, b) => (b.abr || 0) - (a.abr || 0))[0]
          : null;
      if (video && audio) {
        const item = makeVideoItem(video, {
          url: pageUrl,
          formatId: `${video.format_id}+${audio.format_id}`,
          ext: 'mp4',
        });
        if (item) items.push(item);
      } else if (video) {
        // No audio stream exists at all — a muted original has no audio
        // to keep, so the silent file is better than nothing.
        const item = makeVideoItem(video);
        if (item) items.push(item);
      }
    } else if (imageFormats.length > 0) {
      const best = [...imageFormats].sort(
        (a, b) => (b.width || 0) - (a.width || 0)
      )[0];
      items.push(
        normalizeItem(
          {
            url: best.url,
            thumbnail: entry.thumbnail || info.thumbnail || null,
            type: 'image',
            title: entry.title || info.title,
            width: best.width || null,
            height: best.height || null,
            size: best.filesize || best.filesize_approx || null,
          },
          fallbackTitle
        )
      );
    } else if (entry.url && typeof entry.url === 'string' && entry.url.startsWith('http')) {
      items.push(
        normalizeItem(
          {
            url: entry.url,
            thumbnail: entry.thumbnail || info.thumbnail || null,
            type: guessTypeFromUrl(entry.url),
            title: entry.title || info.title,
          },
          fallbackTitle
        )
      );
    }
  }
  return dedupeByUrl(items.filter(Boolean));
}

const RESOLVERS = {
  instagram: resolveInstagram,
  pinterest: resolvePinterest,
  tiktok: resolveTikTok,
  facebook: resolveFacebook,
  twitter: resolveTwitter,
};

// Batch resolution: like resolveMedia, but returns the platform too, so the
// batch route can label each link.
async function resolveForBatch(rawUrl) {
  const platform = detectPlatform(rawUrl);
  if (!platform) throw Errors.invalidUrl('That link is not from a supported platform.');
  const result = await resolveMedia(rawUrl, platform);
  return { platform, title: result.title, thumbnail: result.thumbnail, caption: result.caption || null, items: result.items };
}

// The universal function: one entry point for every platform. Validates the
// URL (SSRF allowlist + DNS), resolves through cache + queue, and returns the
// typed item list. Throws SnatcherError on any failure.
async function resolveMedia(rawUrl, platform) {
  const { url, platform: detected } = await validateMediaUrl(rawUrl, platform);
  const p = platform || detected;
  if (!RESOLVERS[p]) throw Errors.unsupportedPlatform();
  return cachedResolve(`resolve:${p}:${url}`, async () => {
    try {
      const result = await RESOLVERS[p](url);
      if (!result.items || result.items.length === 0) throw Errors.noMedia();
      return { platform: p, title: result.title, thumbnail: result.thumbnail, caption: result.caption || null, items: result.items };
    } catch (err) {
      throw toSnatcherError(err);
    }
  });
}

module.exports = {
  resolveMedia,
  resolveForBatch,
  ytdlpInfoToItems,
  normalizeItem,
  dedupeByUrl,
  pickCaption,
  captionNameBase,
  safeFilename,
  urlFingerprint,
  extractPinterestVideo,
  fetchPinterestViaScrape,
  isHlsUrl,
  extractTwitterPhotos,
  fetchTwitterViaScrape,
  classifyMediaBytes,
  sniffMediaType,
  RESOLVERS,
};
