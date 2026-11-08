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
// YouTube description cannot blow up the response. Returns null when no
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

// ---------------------------------------------------------------------------
// Download filenames. Every file must get a name that is unique to the
// media it came from, or the browser sees the same name twice and asks
// "download again?" — the old scheme was just the title (and Instagram has
// no title at all, so every reel became "Instagram_media_1.mp4").
// Name shape: Title [id] tag.ext — the id comes from the source URL
// (video id, shortcode, tweet id, pin id; a short URL hash when the
// platform hides its ids), the tag is the quality for YouTube or the item
// number for multi-item posts. The id/tag are never truncated away: the
// title is cut to make room for them.
const FILENAME_MAX = 80;

function extractMediaId(rawUrl) {
  let parsed = null;
  try {
    parsed = new URL(rawUrl);
  } catch {
    parsed = null;
  }
  const host = (parsed?.hostname || '').replace(/^www\./, '').replace(/^m\./, '');
  const path = parsed?.pathname || '';
  const params = parsed?.searchParams;
  let id = null;
  if (host === 'youtu.be') {
    id = path.split('/').filter(Boolean)[0] || null;
  } else if (host.endsWith('youtube.com') || host === 'youtube.com') {
    id =
      params?.get('v') ||
      path.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/)?.[1] ||
      null;
  } else if (host === 'instagram.com') {
    id = path.match(/^\/(?:reel|reels|p|tv)\/([^/?#]+)/)?.[1] || null;
  } else if (host === 'tiktok.com') {
    id = path.match(/\/video\/(\d+)/)?.[1] || null;
  } else if (host === 'x.com' || host === 'twitter.com') {
    id = path.match(/\/status\/(\d+)/)?.[1] || null;
  } else if (host.endsWith('pinterest.com')) {
    id = path.match(/\/pin\/(\d+)/)?.[1] || null;
  } else if (host === 'facebook.com' || host === 'fb.watch') {
    id =
      params?.get('v') ||
      params?.get('story_fbid') ||
      path.match(/^\/(?:videos|reel|watch)\/(\d+)/)?.[1] ||
      null;
  }
  if (id) return String(id).slice(0, 32);
  // No id in the URL (e.g. a Facebook share link): a short deterministic
  // hash of the URL still makes every distinct link a distinct filename.
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
  const suffixParts = [];
  if (opts.id) suffixParts.push(`[${String(opts.id).replace(/[^\w-]/g, '')}]`);
  if (opts.tag) suffixParts.push(String(opts.tag).replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_'));
  const suffix = suffixParts.filter(Boolean).join(' ');
  const room = Math.max(0, FILENAME_MAX - (suffix ? suffix.length + 1 : 0));
  let head = base.slice(0, room).replace(/[_-]+$/, '');
  if (!head) head = 'snatcher';
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
  if (items.length === 0) throw Errors.noMedia();
  return { title, thumbnail: items[0].thumbnail || null, items, caption };
}

// ---------------------------------------------------------------------------
// Pinterest — yt-dlp primary (Pinterest extractor: pins, images + video, high
// quality), btch fallback. The old RapidAPI path is gone with the leaked key.
// ---------------------------------------------------------------------------
async function resolvePinterest(url) {
  try {
    const info = await ytdlp.getInfo(url);
    const items = ytdlpInfoToItems(info, info.title || 'Pinterest media', url);
    if (items.length > 0) {
      return {
        title: info.title || 'Pinterest media',
        thumbnail: info.thumbnail || items[0].thumbnail || null,
        items,
        caption: pickCaption(info.description),
      };
    }
    throw Errors.noMedia();
  } catch (err) {
    // A real verdict (private, not found, rate-limited) — do not mask it
    // by falling back to btch.
    if (
      isVerdictError(err) ||
      (err && err.name === 'SnatcherError' && err.code === 'rate_limited')
    ) {
      throw err;
    }
    logger.warn({ err: err.message }, 'yt-dlp Pinterest failed, trying btch');
  }

  const data = await withTimeout(
    pinterest(url),
    config.upstreamTimeoutMs,
    'Pinterest'
  );
  let pin = data && data.result ? data.result : null;
  if (pin && pin.result) pin = pin.result;
  if (!pin || (!pin.video_url && !pin.image)) throw Errors.noMedia();
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
  return { title: pin.title || 'Pinterest media', thumbnail: pin.image || null, items, caption: null };
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
    const items = ytdlpInfoToItems(info, info.title || 'TikTok video', url);
    if (items.length > 0) {
      return { title: info.title || 'TikTok video', thumbnail: info.thumbnail || null, items, caption: pickCaption(info.description) };
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
            title: data.title,
          },
          'TikTok video'
        )
      )
      .filter(Boolean);
    if (items.length > 0) {
      return { title: data.title || 'TikTok video', thumbnail: data.thumbnail || null, items, caption: pickCaption(data.title) };
    }
  }
  throw Errors.noMedia();
}

// ---------------------------------------------------------------------------
// Facebook — btch primary (HD then Normal), yt-dlp fallback.
// ---------------------------------------------------------------------------
async function resolveFacebook(url) {
  try {
    const data = await withTimeout(fbdown(url), config.upstreamTimeoutMs, 'Facebook');
    if (data && data.status === true && (data.HD || data.Normal_video)) {
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
        return { title: 'Facebook video', thumbnail: null, items: best, caption: null };
      }
    }
    throw new Error((data && data.message) || 'No media URL found');
  } catch (err) {
    logger.warn({ err: err.message }, 'fbdown failed, trying yt-dlp for Facebook');
    const info = await ytdlp.getInfo(url);
    const items = ytdlpInfoToItems(info, 'Facebook video', url);
    if (items.length === 0) throw Errors.noMedia();
    return { title: info.title || 'Facebook video', thumbnail: info.thumbnail || null, items, caption: pickCaption(info.description) };
  }
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
    const info = await ytdlp.getInfo(url);
    const items = ytdlpInfoToItems(info, 'Twitter video', url);
    if (items.length === 0) throw Errors.noMedia();
    return { title: info.title || 'Twitter video', thumbnail: info.thumbnail || null, items, caption: pickCaption(info.description, info.title) };
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
function ytdlpInfoToItems(info, fallbackTitle, sourceUrl) {
  const items = [];
  const entries = Array.isArray(info.entries) ? info.entries : [info];
  const pageUrl = sourceUrl || info.webpage_url || info.original_url || null;
  for (const entry of entries) {
    if (!entry) continue;
    const formats = Array.isArray(entry.formats) ? entry.formats : [];
    const videoFormats = formats.filter(
      (f) => f.vcodec && f.vcodec !== 'none' && f.url
    );
    const imageFormats = formats.filter(
      (f) =>
        (!f.vcodec || f.vcodec === 'none') &&
        (!f.acodec || f.acodec === 'none') &&
        f.url &&
        IMAGE_EXTS.has((f.ext || '').toLowerCase())
    );
    if (videoFormats.length > 0) {
      // Direct files first, then HLS; within each, tallest wins.
      const direct = videoFormats.filter((f) => (f.protocol || '') === 'https');
      const pool = direct.length > 0 ? direct : videoFormats;
      const best = [...pool].sort(
        (a, b) => (b.height || 0) - (a.height || 0) || (b.filesize || 0) - (a.filesize || 0)
      )[0];
      const isHls = String(best.protocol || '').startsWith('m3u8');
      const item = normalizeItem(
        {
          url: best.url,
          thumbnail: entry.thumbnail || info.thumbnail || null,
          type: 'video',
          title: entry.title || info.title,
          quality: best.height ? `${best.height}p` : null,
          size: best.filesize || best.filesize_approx || null,
        },
        fallbackTitle
      );
      if (item) {
        if (isHls) {
          // The proxy converts the HLS stream to a real mp4.
          item.ext = 'mp4';
          item.ytdlp = {
            url: pageUrl,
            formatId: best.format_id,
            ext: 'mp4',
            client: info._client || 'tv_embedded',
          };
        }
        items.push(item);
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

// ---------------------------------------------------------------------------
// YouTube info (the two-step flow): title, thumbnail, duration and a format
// picker list. Formats are combined video+audio pairs (video id + audio id),
// plus a best-audio option.
// ---------------------------------------------------------------------------
async function getYouTubeInfo(rawUrl) {
  const { url } = await validateMediaUrl(rawUrl, 'youtube');
  return cachedResolve(`youtube:info:${url}`, async () => {
    const info = await ytdlp.getInfo(url);
    const formats = Array.isArray(info.formats) ? info.formats : [];

    const videoFormats = formats.filter(
      (f) => f.vcodec && f.vcodec !== 'none' && f.ext === 'mp4' && f.height
    );
    const audioFormats = formats.filter(
      (f) => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none')
    );
    const bestAudio = [...audioFormats].sort(
      (a, b) => (b.abr || 0) - (a.abr || 0)
    )[0];

    const byHeight = new Map();
    for (const vf of videoFormats) {
      const existing = byHeight.get(vf.height);
      if (!existing || (vf.filesize || 0) > (existing.filesize || 0)) {
        byHeight.set(vf.height, vf);
      }
    }

    const picked = [...byHeight.values()]
      .sort((a, b) => b.height - a.height)
      .slice(0, 5)
      .map((vf) => {
        const id = bestAudio ? `${vf.format_id}+${bestAudio.format_id}` : `${vf.format_id}`;
        return {
          id,
          type: 'mp4',
          quality: `${vf.height}p`,
          ext: 'mp4',
          size: vf.filesize || vf.filesize_approx || null,
          label: `${vf.height}p · mp4`,
        };
      });

    // Audio on its own: the best few by bitrate, so the Audio section has
    // real choices (m4a / opus / webm) instead of a single take-it-or-leave-it.
    const audioPicked = [...audioFormats]
      .sort((a, b) => (b.abr || 0) - (a.abr || 0))
      .slice(0, 3)
      .map((af) => ({
        id: `${af.format_id}`,
        type: 'audio',
        quality: 'Audio only',
        ext: af.ext || 'm4a',
        size: af.filesize || af.filesize_approx || null,
        label: af.abr ? `Audio · ${af.abr} kbps · ${af.ext || 'm4a'}` : `Audio only · ${af.ext || 'm4a'}`,
      }));

    const pickedFormats = [...picked, ...audioPicked];

    if (pickedFormats.length === 0) throw Errors.noMedia();
    return {
      title: info.title || 'YouTube video',
      thumbnail:
        info.thumbnail ||
        (info.id ? `https://img.youtube.com/vi/${info.id}/maxresdefault.jpg` : null),
      duration: info.duration || null,
      author: info.uploader || null,
      client: info._client || 'tv_embedded',
      caption: pickCaption(info.description),
      formats: pickedFormats,
      videoFormats: picked,
      audioFormats: audioPicked,
    };
  });
}

const RESOLVERS = {
  instagram: resolveInstagram,
  pinterest: resolvePinterest,
  tiktok: resolveTikTok,
  facebook: resolveFacebook,
  twitter: resolveTwitter,
};

// Batch resolution: like resolveMedia, but YouTube links resolve to their
// single best format instead of the format picker — a batch is about grabbing
// files, not choosing qualities per link.
async function resolveForBatch(rawUrl) {
  const platform = detectPlatform(rawUrl);
  if (!platform) throw Errors.invalidUrl('That link is not from a supported platform.');
  if (platform === 'youtube') {
    const info = await getYouTubeInfo(rawUrl);
    const best = info.formats.find((f) => f.type === 'mp4') || info.formats[0];
    if (!best) throw Errors.noMedia();
    return {
      platform,
      title: info.title,
      thumbnail: info.thumbnail,
      caption: info.caption || null,
      items: [
        {
          type: best.type === 'audio' ? 'audio' : 'video',
          url: null,
          thumbnail: info.thumbnail,
          title: info.title,
          quality: best.quality,
          ext: best.ext,
          size: best.size || null,
          sourceUrl: rawUrl,
          ytdlp: {
            url: rawUrl,
            formatId: best.id,
            ext: best.ext,
            client: info.client || 'tv_embedded',
          },
        },
      ],
    };
  }
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
  getYouTubeInfo,
  ytdlpInfoToItems,
  normalizeItem,
  dedupeByUrl,
  pickCaption,
  captionNameBase,
  safeFilename,
  extractMediaId,
  RESOLVERS,
};
