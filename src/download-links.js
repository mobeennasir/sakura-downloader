'use strict';

const crypto = require('crypto');
const config = require('./config');

// HMAC signatures for /dl download URLs. The proxy only streams a URL that
// Snatcher itself produced — it is never an open proxy. Payloads are short
// canonical strings, e.g. `u=<url>` or `ytdlp=<url>&f=<formatId>`.

function signDownload(payload) {
  return crypto
    .createHmac('sha256', config.downloadSecret)
    .update(payload)
    .digest('hex')
    .slice(0, 32);
}

function verifyDownload(payload, sig) {
  if (!sig || typeof sig !== 'string') return false;
  const expected = signDownload(payload);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Whether a yt-dlp download must be fetched to a temp file first instead of
// streamed live. Two cases, both with unknowable output size: a merged
// format (`137+140` — video + audio remuxed, output is bigger than either
// input) and an HLS manifest converted to mp4. A wrong Content-Length is
// worse than none (the browser truncates or hangs), so these buffer first
// and the proxy serves the real file size from disk.
function needsBuffer({ formatId, isHls }) {
  return Boolean(isHls) || (typeof formatId === 'string' && formatId.includes('+'));
}

// Canonical payload for a yt-dlp download. `size` is the exact file size in
// bytes — only ever set for a single-file stream (never for a buffered one,
// where the proxy stats the finished file). `buffer` marks the buffered
// case. Both ride inside the signature, so a client cannot lie about them.
function ytdlpPayload({ url, formatId, ext, client, size, buffer }) {
  const useClient = client || 'tv_embedded';
  const useExt = ext || 'mp4';
  let payload = `ytdlp=${url}&f=${formatId}&ext=${useExt}&c=${useClient}`;
  if (size) payload += `&s=${size}`;
  if (buffer) payload += `&b=1`;
  return payload;
}

// One signed download URL for a yt-dlp stream (YouTube formats, Pinterest
// HLS videos, any item whose file must be converted, not proxied as-is).
// The payload is canonical so the proxy can verify it with verifyDownload.
function buildYtDlpDownloadUrl({ url, formatId, ext, client, filename, size, buffer }) {
  const useClient = client || 'tv_embedded';
  const useExt = ext || 'mp4';
  const payload = ytdlpPayload({ url, formatId, ext: useExt, client: useClient, size, buffer });
  let out =
    `/dl?ytdlp=${encodeURIComponent(url)}` +
    `&f=${encodeURIComponent(formatId)}` +
    `&ext=${encodeURIComponent(useExt)}` +
    `&c=${encodeURIComponent(useClient)}`;
  if (size) out += `&s=${encodeURIComponent(String(size))}`;
  if (buffer) out += `&b=1`;
  out +=
    `&name=${encodeURIComponent(filename || 'snatcher_media.mp4')}` +
    `&sig=${signDownload(payload)}`;
  return out;
}

// Canonical payload for a direct CDN stream. `size` is the exact file size
// when the resolver knew it (a yt-dlp filesize); the proxy falls back to a
// HEAD request on the upstream when it is absent.
function directPayload({ url, size }) {
  return size ? `u=${url}&s=${size}` : `u=${url}`;
}

function buildDirectDownloadUrl({ url, filename, size }) {
  const payload = directPayload({ url, size });
  let out = `/dl?u=${encodeURIComponent(url)}`;
  if (size) out += `&s=${encodeURIComponent(String(size))}`;
  out +=
    `&name=${encodeURIComponent(filename || 'snatcher_media.mp4')}` +
    `&sig=${signDownload(payload)}`;
  return out;
}

module.exports = {
  signDownload,
  verifyDownload,
  buildYtDlpDownloadUrl,
  buildDirectDownloadUrl,
  ytdlpPayload,
  directPayload,
  needsBuffer,
};
