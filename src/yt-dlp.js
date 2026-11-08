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
// client's result — so getInfo races them in parallel instead (see below).
// player_skip=webpage skips the initial webpage fetch, where the "sign in
// to confirm you're not a bot" page usually triggers; the formats and
// description come from the player response instead.
const YTDLP_CLIENTS = ['tv_embedded', 'android', 'ios', 'mweb', 'web', 'web_safari'];

function isYouTubeUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';
  } catch {
    return false;
  }
}

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
// why a bad paste still showed up as configured while YouTube kept asking
// for sign-in. This reads the file yt-dlp actually gets and checks it is a
// real Netscape cookies file carrying a YouTube login session. Never logs
// or returns a value — only a status. Statuses:
//   'not-configured' — no cookies env/file at all
//   'unreadable' — the file could not be read (the earlier write failed)
//   'invalid' — not a cookies file, or no youtube.com lines in it
//   'missing-session' — cookies present, but no login session in them
//     (exported while signed out, or only consent cookies)
//   'ok' — a login session is present
const SESSION_COOKIE_NAMES = new Set(['SID', 'HSID', 'SSID', 'APISID', 'SAPISID']);

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
  const youtubeLines = cookieLines.filter((l) => {
    const fields = l.split('\t');
    if (fields.length < 7) return false;
    const domain = fields[0].toLowerCase();
    return domain === 'youtube.com' || domain.endsWith('.youtube.com');
  });
  if (youtubeLines.length === 0) {
    return { status: 'invalid', detail: 'no youtube.com cookies in file' };
  }
  const names = new Set();
  for (const line of youtubeLines) {
    const name = line.split('\t')[5];
    if (name) names.add(name);
  }
  const session = [...SESSION_COOKIE_NAMES].filter((n) => names.has(n));
  if (session.length === 0) {
    return {
      status: 'missing-session',
      detail: 'no YouTube login session cookies (SID/HSID/SSID)',
    };
  }
  return {
    status: 'ok',
    detail: `${youtubeLines.length} youtube.com cookies, session present`,
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
      'YouTube cookies configured but not usable — re-export while signed in to YouTube'
    );
  }
  return `configured (${status}: ${detail})`;
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

    // AbortSignal (used by getInfo's client race): another client won, so
    // kill this one. Rejects with code 'aborted' — the race ignores it.
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
//
// For YouTube, the player clients race in two waves: tv_embedded + android
// first, the other four 5 s later if nothing won yet. The old sequential
// chain took ~95 s when every client failed (the sign-in wall on a flagged
// IP — ~18 s per client), and the browser gives up at 60 s; racing all
// six at once fixed that but slowed the winner ~3x (4 s alone, 12 s in a
// six-way race — six Python processes fighting over one IP). Two waves
// keep the common case at ~4 s and bound the failure path at ~15 s. The
// first client that returns wins and the rest are killed; when every
// client fails, the verdict error is reported (not the last retry's
// noise), so a dead link still reads as dead. Per-attempt timeout is
// 15 s. And when BOTH wave-1 clients time out, the IP is being throttled
// — the other four would hang the same way, so the race stops there with
// a clear throttling error instead of burning another ~20 s. Non-YouTube
// URLs use one client only (player_client is YouTube-specific; racing six
// copies of a Pinterest lookup would just burn CPU).
async function getInfo(url) {
  const clients = isYouTubeUrl(url) ? YTDLP_CLIENTS : [YTDLP_CLIENTS[0]];
  const controller = new AbortController();
  const runAttempt = (client) =>
    (async () => {
      try {
        const { stdout } = await runYtDlp(
          ['-j', '--no-playlist', ...baseArgs(client), url],
          { timeoutMs: 15000, signal: controller.signal }
        );
        const firstLine = stdout
          .split('\n')
          .find((line) => line.trim().startsWith('{'));
        if (!firstLine) throw Errors.noMedia();
        return { ...JSON.parse(firstLine), _client: client };
      } catch (err) {
        if (!err || err.code !== 'aborted') {
          logger.warn(
            { client, err: err.message },
            'yt-dlp client failed, trying next'
          );
        }
        throw err;
      }
    })();

  return new Promise((resolve, reject) => {
    let done = false;
    let remaining = clients.length;
    const errors = [];
    const wave1 = new Set(clients.slice(0, 2));
    let wave1Timeouts = 0;
    const settle = (value, err, client) => {
      if (done) return;
      if (value) {
        done = true;
        controller.abort();
        resolve(value);
        return;
      }
      // Both wave-1 clients timed out: the platform is throttling this
      // server's IP, and wave 2 would hang the same way. Stop now with a
      // clear message instead of making the user wait out every client.
      if (err && err.code === 'timeout' && wave1.has(client)) {
        wave1Timeouts += 1;
        if (wave1Timeouts >= 2) {
          done = true;
          clearTimeout(wave2Timer);
          controller.abort();
          return reject(
            Errors.rateLimited(
              'YouTube is throttling this server right now. Try again in a few minutes.'
            )
          );
        }
      }
      if (err && err.code !== 'aborted') errors.push(err);
      if (--remaining === 0) {
        done = true;
        // A verdict error is the answer when every client agrees the link
        // is dead/private/has no formats — report it, not the last
        // retry's noise.
        const verdict = errors.find(
          (e) => isVerdictError(e) || e.code === 'no_media'
        );
        if (verdict) return reject(verdict);
        const last = errors[errors.length - 1];
        if (last) {
          logger.warn({ err: last.message }, 'yt-dlp failed on every client');
          return reject(last);
        }
        reject(Errors.upstreamError());
      }
    };
    const attempt = (client) => {
      runAttempt(client).then(
        (value) => settle(value, null, client),
        (err) => settle(null, err, client)
      );
    };
    clients.slice(0, 2).forEach(attempt);
    const wave2Timer = setTimeout(() => {
      if (!done) clients.slice(2).forEach(attempt);
    }, 5000);
    wave2Timer.unref();
  });
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

function downloadToFile(url, formatId, client, destPath) {
  return new Promise((resolve, reject) => {
    const format = formatId || 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b';
    const useClient = YTDLP_CLIENTS.includes(client) ? client : YTDLP_CLIENTS[0];
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
    const child = spawn(config.ytdlpPath, ['-f', format, '-o', destPath, ...baseArgs(useClient), '--concurrent-fragments', '5', '--hls-prefer-ffmpeg', url], {
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

module.exports = { runYtDlp, getInfo, streamDownload, downloadToFile, cleanupDownloadFiles, binaryAvailable, cookiesPath, hasCookies, cookiesStatus, validateCookiesContent, mapYtDlpError, baseArgs, YTDLP_CLIENTS, FORMAT_ID_RE };
