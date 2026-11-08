'use strict';

// yt-dlp, used directly (the binary is spawned — no wrapper library, the
// published wrapper is deprecated). Covers YouTube, Pinterest, and the
// Instagram fallback. Every call has a timeout; a hung binary is killed.

const { spawn } = require('child_process');
const config = require('./config');
const { Errors, isVerdictError } = require('./errors');
const logger = require('./logger');

// A format id goes to a spawned process: only yt-dlp format selectors may
// pass — no spaces, no shell characters, no flags.
const FORMAT_ID_RE = /^[0-9a-zA-Z+_-]+$/;

// Player clients, in order. tv_embedded returns the full format range
// (2160p down) and gets past the bot check; android is the reliable fallback
// (360p combined). A chain in one call does not work — yt-dlp keeps only one
// client's result — so the code retries client by client instead.
const YTDLP_CLIENTS = ['tv_embedded', 'android'];

function baseArgs(client) {
  return [
    '--extractor-args',
    `youtube:player_client=${client}`,
    '--no-warnings',
    '--socket-timeout',
    '15',
  ];
}

function runYtDlp(args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ytdlpPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        reject(Errors.upstreamTimeout('The media service took too long.'));
      }
    }, timeoutMs || config.ytdlpTimeoutMs);
    timer.unref();

    child.stdout.on('data', (d) => {
      stdout += d;
      // Never buffer an unbounded download into memory.
      if (stdout.length > 32 * 1024 * 1024) {
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.error({ err }, 'yt-dlp spawn failed');
      reject(
        Errors.upstreamError('The downloader is not available right now.')
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(mapYtDlpError(stderr));
      }
    });
  });
}

function mapYtDlpError(stderr) {
  const s = stderr || '';
  if (/sign in to confirm|not a bot/i.test(s)) {
    return Errors.forbidden(
      'YouTube asked this server to sign in. Try again later — it usually clears.'
    );
  }
  if (/empty media response|not accessible without being logged-in/i.test(s)) {
    return Errors.privateOrRemoved();
  }
  if (/private video|private post|login required|only available to|this video is private/i.test(s)) {
    return Errors.privateOrRemoved();
  }
  if (/video unavailable|not found|404|no video could be found/i.test(s)) {
    return Errors.linkNotFound();
  }
  if (/rate.?limit|429|too many requests/i.test(s)) {
    return Errors.rateLimited();
  }
  if (/unsupported url|no suitable extractor/i.test(s)) {
    return Errors.invalidUrl();
  }
  logger.warn({ stderr: s.slice(0, 500) }, 'yt-dlp failed');
  return Errors.upstreamError();
}

// Full metadata for a URL (video, pin, post). Returns the parsed JSON plus
// `_client` — which player client worked, so the download uses the same one.
// Verdict errors (private, not found, invalid) are not retried: another
// client will not change them.
async function getInfo(url) {
  let lastError = null;
  for (const client of YTDLP_CLIENTS) {
    try {
      const { stdout } = await runYtDlp([
        '-j',
        '--no-playlist',
        ...baseArgs(client),
        url,
      ]);
      const firstLine = stdout
        .split('\n')
        .find((line) => line.trim().startsWith('{'));
      if (!firstLine) throw Errors.noMedia();
      return { ...JSON.parse(firstLine), _client: client };
    } catch (err) {
      lastError = err;
      if (isVerdictError(err)) {
        throw err;
      }
      logger.warn({ client, err: err.message }, 'yt-dlp client failed, trying next');
    }
  }
  throw lastError || Errors.upstreamError();
}

// Stream a download to an Express response. formatId is a yt-dlp -f selector
// (e.g. "137+140" or a single format id). The response headers (content type,
// disposition, filename) are set by the caller. `client` is the player client
// that worked for the info call; it defaults to the first one.
function streamDownload(res, url, formatId, client) {
  const format = formatId || 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b';
  const useClient = YTDLP_CLIENTS.includes(client) ? client : YTDLP_CLIENTS[0];
  const child = spawn(
    config.ytdlpPath,
    ['-f', format, '-o', '-', ...baseArgs(useClient), url],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let bytes = 0;
  let finished = false;
  const timer = setTimeout(() => {
    if (!finished) {
      finished = true;
      child.kill('SIGKILL');
      if (!res.headersSent) res.status(504).end();
      else res.destroy();
    }
  }, config.ytdlpTimeoutMs);
  timer.unref();

  child.stdout.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > config.maxDownloadBytes) {
      child.kill('SIGKILL');
      res.destroy();
      return;
    }
    res.write(chunk);
  });
  child.stderr.on('data', () => {
    // Progress noise; the log stays clean.
  });
  child.on('error', () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (!res.headersSent) res.status(502).end();
    else res.end();
  });
  child.on('close', (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (code === 0) {
      res.end();
    } else if (!res.headersSent) {
      res.status(502).end();
    } else {
      res.end();
    }
  });
  return child;
}

async function binaryAvailable() {
  try {
    const { stdout } = await runYtDlp(['--version'], { timeoutMs: 10000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

module.exports = { runYtDlp, getInfo, streamDownload, binaryAvailable, FORMAT_ID_RE };
