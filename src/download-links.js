'use strict';

const crypto = require('crypto');
const config = require('./config');

// HMAC signatures for /dl download URLs. The proxy only streams a URL that
// Snatcher itself produced — it is never an open proxy. Payloads are short
// canonical strings, e.g. `u=<url>` or `yt=<url>&f=<formatId>`.

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

// One signed download URL for a yt-dlp stream (YouTube formats, Pinterest
// HLS videos, any item whose file must be converted, not proxied as-is).
// The payload is canonical so the proxy can verify it with verifyDownload.
function buildYtDlpDownloadUrl({ url, formatId, ext, client, filename }) {
  const useClient = client || 'tv_embedded';
  const useExt = ext || 'mp4';
  const payload = `ytdlp=${url}&f=${formatId}&ext=${useExt}&c=${useClient}`;
  return (
    `/dl?ytdlp=${encodeURIComponent(url)}` +
    `&f=${encodeURIComponent(formatId)}` +
    `&ext=${encodeURIComponent(useExt)}` +
    `&c=${encodeURIComponent(useClient)}` +
    `&name=${encodeURIComponent(filename || 'snatcher_media.mp4')}` +
    `&sig=${signDownload(payload)}`
  );
}

module.exports = { signDownload, verifyDownload, buildYtDlpDownloadUrl };
