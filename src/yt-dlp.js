'use strict';

// yt-dlp, used directly (the binary is spawned — no wrapper library, the
// published wrapper is deprecated). Covers Pinterest and the Instagram
// fallback. Every call has a timeout; a hung binary is killed.

const { spawn } = require('child_process');
const config = require('./config');
const { Errors } = require('./errors');
const logger = require('./logger');

// A format id goes to a spawned process: only yt-dlp format selectors may
// pass — no spaces, no shell characters, no flags.
const FORMAT_ID_RE = /^[0-9a-zA-Z+_-]+$/;

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

// Cookies validation — "configured" only means the env var is set, which is
// why a bad paste still showed up as configured while the platforms kept
// asking for sign-in. This reads the file yt-dlp actually gets and checks
// it is a real Netscape cookies file carrying an Instagram or Facebook
// login session — the session is what lets yt-dlp fetch captions from a
// datacenter IP. Never logs or returns a value — only a status. Statuses:
//   'not-configured' — no cookies env/file at all
//   'unreadable' — the file could not be read (the earlier write failed)
//   'invalid' — not a cookies file, or no instagram.com / facebook.com
//     lines in it
//   'missing-session' — cookies present, but no login session in them
//     (exported while signed out, or only consent cookies)
//   'ok' — a login session is present
const SESSION_COOKIES = {
  instagram: new Set(['sessionid']),
  facebook: new Set(['c_user', 'xs']),
};

function validateCookiesContent(content) {
  if (!content || typeof content !== 'string' || !content.trim()) {
    return { status: 'invalid', detail: 'empty cookies content' };
  }
  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const cookieLines = lines.filter((l) => !l.startsWith('#'));
  if (cookieLines.length === 0) {
    return { status: 'invalid', detail: 'no cookie lines in file' };
  }
  const byPlatform = { instagram: [], facebook: [] };
  for (const line of cookieLines) {
    const fields = line.split('\t');
    if (fields.length < 7) continue;
    const domain = fields[0].toLowerCase();
    if (domain === 'instagram.com' || domain.endsWith('.instagram.com')) {
      byPlatform.instagram.push(line);
    } else if (domain === 'facebook.com' || domain.endsWith('.facebook.com')) {
      byPlatform.facebook.push(line);
    }
  }
  const present = Object.keys(byPlatform).filter((p) => byPlatform[p].length > 0);
  if (present.length === 0) {
    return { status: 'invalid', detail: 'no instagram.com or facebook.com cookies in file' };
  }
  const withSession = present.filter((p) => {
    const names = new Set(byPlatform[p].map((line) => line.split('\t')[5]));
    return [...SESSION_COOKIES[p]].some((n) => names.has(n));
  });
  if (withSession.length === 0) {
    return {
      status: 'missing-session',
      detail: 'no login session cookies (instagram sessionid, facebook c_user/xs)',
    };
  }
  return {
    status: 'ok',
    detail:
      withSession.length > 1
        ? 'instagram + facebook sessions present'
        : `${withSession[0]} session present`,
  };
}

// The one-line cookies status for /health/ready. Reads the same file yt-dlp
// gets, so it answers whether the cookies are usable — not just present.
// Logs once when they are configured but unusable, so the Koyeb logs say so.
let cookiesStatusLogged = false;
function cookiesStatus() {
  if (!hasCookies()) return 'not configured';
  const file = cookiesPath();
  if (!file) return 'configured (unreadable — could not write cookies file)';
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return 'configured (unreadable — could not read cookies file)';
  }
  const { status, detail } = validateCookiesContent(content);
  if (status === 'ok') return 'configured (valid session)';
  if (!cookiesStatusLogged) {
    cookiesStatusLogged = true;
    logger.warn(
      { cookiesStatus: status, detail },
      'Login cookies configured but not usable — re-export while signed in to Instagram/Facebook'
    );
  }
  return `configured (${status}: ${detail})`;
}

function baseArgs() {
  const args = ['--no-warnings', '--socket-timeout', '15'];
  const cookies = cookiesPath();
  if (cookies) args.push('--cookies', cookies);
  return args;
}

function runYtDlp(args, { timeoutMs, signal } = {}) {
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

    // AbortSignal: lets a caller kill a run in flight. Rejects with code
    // 'aborted'.
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      const err = new Error('aborted');
      err.code = 'aborted';
      reject(err);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const settle = (fn) => (...a) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(...a);
    };

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
    child.on('error', settle((err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.error({ err }, 'yt-dlp spawn failed');
      reject(
        Errors.upstreamError('The downloader is not available right now.')
      );
    }));
    child.on('close', settle((code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(mapYtDlpError(stderr));
      }
    }));
  });
}

function mapYtDlpError(stderr) {
  const s = stderr || '';
  if (/sign in to confirm|not a bot/i.test(s)) {
    return Errors.forbidden(
      'The media service asked this server to sign in. Try again later — it usually clears.'
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
  // it. It is deterministic: no retry will find formats, so this maps to
  // no_media. The resolver then falls back to its other adapter (btch
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

// Full metadata for a URL (video, pin, post). One yt-dlp call, 15 s cap.
// Returns the parsed JSON. On failure the mapped error is thrown —
// verdict errors (private, not found, invalid) are final, so the
// resolver does not retry them.
async function getInfo(url) {
  const { stdout } = await runYtDlp(['-j', '--no-playlist', ...baseArgs(), url], {
    timeoutMs: 15000,
  });
  const firstLine = stdout
    .split('\n')
    .find((line) => line.trim().startsWith('{'));
  if (!firstLine) throw Errors.noMedia();
  return JSON.parse(firstLine);
}

// Stream a download to an Express response. formatId is a yt-dlp -f selector
// (e.g. "137+140" or a single format id). The response headers (content type,
// disposition, filename) are set by the caller.
function streamDownload(res, url, formatId) {
  const format = formatId || 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b';
  const child = spawn(
    config.ytdlpPath,
    ['-f', format, '-o', '-', ...baseArgs(), url],
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
  }, config.ytdlpDownloadTimeoutMs);
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
    // A failed stream used to answer a bare 502 with no log line at all —
    // log the cause (the /dl 502s in the Koyeb log carried no error).
    logger.warn({ url, formatId }, 'streamDownload spawn failed');
    if (!res.headersSent) res.status(502).end();
    else res.end();
  });
  child.on('close', (code) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    if (code === 0) {
      res.end();
    } else {
      logger.warn({ url, formatId, code, bytes }, 'streamDownload yt-dlp exited non-zero');
      if (!res.headersSent) {
        res.status(502).end();
      } else {
        res.end();
      }
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

function downloadToFile(url, formatId, destPath) {
  return new Promise((resolve, reject) => {
    const format = formatId || 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b';
    // HLS/DASH fragments download five at a time instead of one after
    // another: Pinterest's audio rendition has 70+ fragments, and fetching
    // them sequentially took over five minutes for one short pin (the video
    // part finished in a minute, the audio part was still on fragment 72).
    // Progressive files have no fragments, so the flag is a no-op for them.
    // HLS itself goes through ffmpeg, not yt-dlp's native downloader:
    // ffmpeg's HLS client is roughly twice as fast here (1m56s vs ~4min
    // for the same merged pin), and ffmpeg is already a hard dependency
    // for merges. Direct range GETs prove the CDN is fast per request —
    // the throttle is per-stream (~78 KiB/s from this VM), so the
    // download of a ~2m46s pin still takes ~2 minutes; that is the
    // platform's speed, not the app stalling.
    const child = spawn(config.ytdlpPath, ['-f', format, '-o', destPath, ...baseArgs(), '--concurrent-fragments', '5', '--hls-prefer-ffmpeg', url], {
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

module.exports = { runYtDlp, getInfo, streamDownload, downloadToFile, cleanupDownloadFiles, binaryAvailable, cookiesPath, hasCookies, cookiesStatus, validateCookiesContent, mapYtDlpError, baseArgs, FORMAT_ID_RE };
