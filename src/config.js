'use strict';

const crypto = require('crypto');

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),

  // Path to the yt-dlp binary. Koyeb/Docker installs it at /usr/local/bin/yt-dlp.
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',

  // Secret used to sign /dl download URLs. A random per-boot secret is fine for
  // a single instance; set DOWNLOAD_SECRET in env when running more than one.
  downloadSecret:
    process.env.DOWNLOAD_SECRET || crypto.randomBytes(32).toString('hex'),

  cacheTtlMs: parseInt(process.env.CACHE_TTL_MS || String(10 * 60 * 1000), 10),
  cacheMax: parseInt(process.env.CACHE_MAX || '500', 10),

  upstreamTimeoutMs: parseInt(process.env.UPSTREAM_TIMEOUT_MS || '30000', 10),
  ytdlpTimeoutMs: parseInt(process.env.YTDLP_TIMEOUT_MS || '60000', 10),

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
