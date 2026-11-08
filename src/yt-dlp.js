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
// (360p combined). ios, mweb, web and web_safari are further fallbacks —
// Koyeb's IP has been seen blocked on the first two, so the retry keeps
// going. A chain in one call does not work — yt-dlp keeps only one
// client's result — so the code retries client by client instead.
// player_skip=webpage skips the initial webpage fetch, where the "sign in
// to confirm you're not a bot" page usually triggers; the formats and
// description come from the player response instead.
const YTDLP_CLIENTS = ['tv_embedded', 'android', 'ios', 'mweb', 'web', 'web_safari'];

// Login cookies for yt-dlp (--cookies), when configured. The content comes
// from the YTDLP_COOKIES env var (a Koyeb secret) and is written once to a
// 0600 file in the OS temp dir — never logged, never committed. Returns the
// file path, or null when no cookies are configured.
const fs = require('fs');
const os = require('os');
const path = require('path');

let cookiesFilePath = null;
let cookiesResolved = false;
function cookiesPath() {
  if (cookiesResolved) return cookiesFilePath;
  cookiesResolved = true;
  if (config.ytdlpCookiesFile) {
    try {
      if (fs.existsSync(config.ytdlpCookiesFile)) {
        cookiesFilePath = config.ytdlpCookiesFile;
      }
    } catch {
      // No usable file — fall through to no cookies.
    }
    return cookiesFilePath;
  }
  if (config.ytdlpCookies) {
    const dest = path.join(os.tmpdir(), 'snatcher-cookies.txt');
    try {
      fs.writeFileSync(dest, config.ytdlpCookies, { mode: 0o600 });
      cookiesFilePath = dest;
    } catch (err) {
      logger.warn({ err: err.message }, 'could not write cookies file, continuing without');
    }
  }
  return cookiesFilePath;
}

function hasCookies() {
  return Boolean(config.ytdlpCookies || config.ytdlpCookiesFile);
}

function baseArgs(client) {
  const args = [
    '--extractor-args',
    `youtube:player_client=${client}`,
    '--extractor-args',
    'youtube:player_skip=webpage',
    '--no-warnings',
    '--socket-timeout',
    '15',
  ];
  const cookies = cookiesPath();
  if (cookies) args.push('--cookies', cookies);
  return args;
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
  // A pin/post yt-dlp's extractor cannot read at all ("No video formats
  // found!") — the content exists, but there is no downloadable format in
  // it. It is deterministic: no other player client will find formats
  // either, so this maps to no_media and getInfo stops retrying after the
  // first client. The resolver then falls back to its other adapter (btch
  // for Pinterest), which often does find the media — an image pin reads
  // exactly this way.
  if (/no video formats found|no formats found/i.test(s)) {
    return Errors.noMedia();
  }
  // Dead / removed videos. yt-dlp's message is "This video is unavailable"
  // — "video" and "unavailable" are NOT adjacent, so a plain
  // /video unavailable/ never matches it and the error fell through to a
  // 502 "the platform stumbled". Match the real wordings.
  if (/this video is unavailable|this video is no longer available|video unavailable|video has been removed|video no longer available|not found|404|no video could be found/i.test(s)) {
    return Errors.linkNotFound();
  }
  if (/rate.?limit|429|too many requests/i.test(s)) {
    return Errors.rateLimited();
  }
  if (/unsupported url|no suitable extractor/i.test(s)) {
    return Errors.invalidUrl();
  }
  // Single-line safe: collapse newlines so one failure stays one log line.
  logger.warn({ stderr: s.replace(/\s+/g, ' ').trim().slice(0, 300) }, 'yt-dlp failed');
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
      // Verdict errors are final — and no_media is deterministic too. A
      // client that finds no formats will not differ on the next one, so
      // retrying all six burns ~2 minutes and the browser gives up first
      // (60 s frontend timeout), before the resolver's other adapter ever
      // gets its turn. Stop after the first client and let the caller
      // fall back.
      if (isVerdictError(err) || (err && err.code === 'no_media')) {
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

// Fetch a download to a file on disk (merged formats, HLS conversions).
// The caller stats the finished file for its exact size, serves it with a
// real Content-Length, then deletes it. Resolves with the output path on
// exit 0, rejects mapped on failure.
// yt-dlp with -o <dest> leaves siblings on failure: <stem>.f401.mp4 (video
// part), <stem>.f140.m4a (audio part), <stem>.temp.mp4 (merge output) and
// <stem>.mp4.part (in-progress download). A failed or killed download must
// not leave hundreds of MB behind — on this VM /tmp is only 512 MB, and one
// leftover 2160p part is enough to fail the next merge. Delete the dest and
// every file sharing its stem. Best effort: a leftover temp file is waste,
// not a user-facing error.
async function cleanupDownloadFiles(destPath) {
  const dir = path.dirname(destPath);
  const stem = path.basename(destPath).replace(/\.[^.]+$/, '');
  try {
    const names = await fs.promises.readdir(dir);
    await Promise.all(
      names
        .filter((n) => n === path.basename(destPath) || n.startsWith(`${stem}.`))
        .map((n) => fs.promises.unlink(path.join(dir, n)).catch(() => {}))
    );
  } catch {
    // Best effort.
  }
}

function downloadToFile(url, formatId, client, destPath) {
  return new Promise((resolve, reject) => {
    const format = formatId || 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b';
    const useClient = YTDLP_CLIENTS.includes(client) ? client : YTDLP_CLIENTS[0];
    const child = spawn(config.ytdlpPath, ['-f', format, '-o', destPath, ...baseArgs(useClient), url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        cleanupDownloadFiles(destPath);
        reject(Errors.upstreamTimeout('The media service took too long.'));
      }
    }, config.ytdlpDownloadTimeoutMs);
    timer.unref();
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.error({ err }, 'yt-dlp spawn failed');
      cleanupDownloadFiles(destPath);
      reject(Errors.upstreamError('The downloader is not available right now.'));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(destPath);
      else {
        cleanupDownloadFiles(destPath);
        reject(mapYtDlpError(stderr));
      }
    });
  });
}

async function binaryAvailable() {
  try {
    const { stdout } = await runYtDlp(['--version'], { timeoutMs: 10000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

module.exports = { runYtDlp, getInfo, streamDownload, downloadToFile, cleanupDownloadFiles, binaryAvailable, cookiesPath, hasCookies, mapYtDlpError, baseArgs, YTDLP_CLIENTS, FORMAT_ID_RE };
