'use strict';

const crypto = require('crypto');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),

  // Path to the yt-dlp binary. Koyeb/Docker installs it at /usr/local/bin/yt-dlp.
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',

  // Login cookies for yt-dlp (--cookies), used for Instagram + Facebook:
  // from a datacenter IP, yt-dlp's caption fetches get bot-checked without
  // a logged-in session. YTDLP_COOKIES holds the Netscape cookies.txt
  // CONTENT (set it in Koyeb as a secret env var — never commit it, never
  // log it); YTDLP_COOKIES_FILE is a path to a cookies.txt file instead,
  // for local runs. The cookies are only ever handed to yt-dlp.
  ytdlpCookies: process.env.YTDLP_COOKIES || null,
  ytdlpCookiesFile: process.env.YTDLP_COOKIES_FILE || null,

  // Pinterest login cookies, for the pin-page scrape. Pinterest serves a
  // datacenter IP a pin page without the video; a logged-in session gets
  // the full page (with the progressive MP4). PINTEREST_COOKIES holds the
  // raw Cookie header value (set it in Koyeb as a secret env var — never
  // commit it, never log it). Unset = anonymous scrape, as before.
  pinterestCookies: process.env.PINTEREST_COOKIES || null,

  // WhatsApp number the error page's "Report on WhatsApp" button writes
  // to (wa.me link, digits only, no +). The owner's number, given for
  // error reports — it is public by design: the button is how users reach
  // him. Override with REPORT_WHATSAPP_NUMBER if it ever changes.
  reportWhatsappNumber: process.env.REPORT_WHATSAPP_NUMBER || '923136701631',

  // Secret used to sign /dl download URLs. A random per-boot secret is fine for
  // a single instance; set DOWNLOAD_SECRET in env when running more than one.
  downloadSecret:
    process.env.DOWNLOAD_SECRET || crypto.randomBytes(32).toString('hex'),

  cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || String(10 * 60 * 1000), 10),
  cacheMax: parseInt(process.env.CACHE_MAX || '500', 10),

  upstreamTimeoutMs: parseInt(process.env.UPSTREAM_TIMEOUT_MS || '30000', 10),
  ytdlpTimeoutMs: parseInt(process.env.YTDLP_TIMEOUT_MS || '60000', 10),
  // Downloads are different from info lookups: a 2160p merge can take
  // minutes on a slow pipe, and killing it mid-file gives the user a 504
  // for a download that would have finished. 10 minutes. streamDownload
  // (the live /dl stream) uses this too — a throttled CDN can take a
  // minute for a 2 MB TikTok file, so the 60 s info timeout must not kill
  // a download that is still moving.
  ytdlpDownloadTimeoutMs: parseInt(
    process.env.YTDLP_DOWNLOAD_TIMEOUT_MS || String(10 * 60 * 1000),
    10
  ),

  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(60 * 1000), 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '60', 10),

  queueConcurrency: parseInt(process.env.QUEUE_CONCURRENCY || '3', 10),
  batchMaxUrls: parseInt(process.env.BATCH_MAX_URLS || '10', 10),

  // Hard cap on a single proxied download (2 GB default).
  maxDownloadBytes: parseInt(
    process.env.MAX_DOWNLOAD_BYTES || String(2 * 1024 * 1024 * 1024),
    10
  ),
};

module.exports = config;
