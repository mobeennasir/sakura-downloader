# Snatcher

Paste a link, keep the file. A media downloader for six platforms — YouTube,
Instagram, Facebook, TikTok, Twitter/X and Pinterest — with one URL bar, real
downloads (not new tabs), and batch mode.

Snatcher is a full rebuild of the old Sakura Downloader (v3.0.0): new name,
new Midnight theme, new backend, new frontend, real downloads, and a test
suite. Everything below describes the rebuilt app.

## What it does

- **YouTube** — pick a video, choose a format (2160p down to 1440p, 1080p,
  720p, 480p, audio only), download the file.
- **Instagram** — reels and posts. A reel gives you its video; a post or
  carousel gives you every photo and video inside it, each with its own
  download button.
- **Pinterest** — pins, photos and videos in high quality. The photo/video
  switch filters the results; videos are converted from HLS to a real mp4.
- **TikTok, Facebook, Twitter/X** — paste a link, get the video.
- **Batch** — up to 10 links at once, one per line. Each link is checked on
  its own; one bad link never stops the rest.
- **Real downloads** — files stream through a signed same-origin proxy
  (`/dl`), so the Download button actually downloads.
- **Error pages** — a different animated page per failure: "Lost in space."
  (404), "That link went nowhere.", "That one is locked.", "Too fast. Slow
  down.", "Took too long.", "Something broke on our side."

## Theme — Midnight

Dark midnight-blue ground, cool white ink, one azure signal, square-cut
surfaces, Mona Sans 300 expanded. No warm accents, no glow, no rounded
corners, no light sections. The look is built for the name: a snatcher works
in the dark.

## Quick start

Requires Node.js 22+, ffmpeg, and the [yt-dlp](https://github.com/yt-dlp/yt-dlp)
binary on your PATH.

```bash
git clone https://github.com/mobeennasir/sakura-downloader.git
cd sakura-downloader
npm ci
cp .env.example .env   # optional; all settings have defaults
npm start              # http://localhost:3000
npm test               # vitest + supertest suite (44 tests)
```

## How it works

```
paste a link
  → validate (host allowlist + SSRF check: no private IPs, no lookalikes)
  → resolve (cache + queue + one in-flight call per URL)
  → per-platform adapter (yt-dlp primary for YouTube/Pinterest/TikTok,
    btch-downloader for the rest, each with a fallback)
  → typed media items [{ type: 'video' | 'image', url, thumbnail, ... }]
  → signed /dl link per item → the file streams to the user
```

YouTube uses yt-dlp's `tv_embedded` player client (full format range) with
`android` as fallback. Pinterest videos arrive as HLS playlists, so the proxy
converts them to mp4 with ffmpeg instead of handing over a playlist file.
TikTok is resolved by yt-dlp directly, with btch-downloader as fallback —
there is no third-party API in the middle.

Every failure is one of eleven named errors (`src/errors.js`), each with its
own HTTP status, short message and animated error page. Connection failures
never leak as "Something broke on our side" — that message is reserved for
genuinely unknown errors, and those are logged server-side.

## Stack

Node.js 22 · Express 5 · EJS · yt-dlp · btch-downloader 6.4 · helmet ·
express-rate-limit · pino + pino-pretty · lru-cache · p-queue · vitest +
supertest.

## Configuration

See `.env.example`. The important ones: `PORT` (default 3000), `YTDLP_PATH`
(default `yt-dlp`), `DOWNLOAD_SECRET` (signs `/dl` URLs; random per boot if
unset), `LOG_PRETTY` (1 = colourised pino-pretty logs, 0 = raw JSON).

## Project structure

```
server.js            Express app: routes, rate limit, helmet, signed /dl proxy
src/
  config.js          env config with defaults
  logger.js          pino + pino-pretty
  errors.js          one error taxonomy (code, status, message, error page)
  validate.js        host allowlist + SSRF/DNS checks
  download-links.js  HMAC signing + signed download URL builders
  yt-dlp.js          yt-dlp binary wrapper (info, streaming, client fallback)
  cache.js           LRU cache + in-flight coalescing + upstream queue
  media.js           the universal resolver: every platform → typed items
public/
  css/styles.css     Midnight theme tokens, layout, error animations
  js/snatcher.js     one shared frontend module (fetch, results, batch, history)
  favicon.svg        azure bolt on a dark square
  og.png             social preview image
views/
  home.ejs           hero URL bar + platform grid + recent links
  platform.ejs       one template for all six platforms
  error.ejs          animated error pages, one per error type
  maintenance.ejs    maintenance page
  partials/          head, header, footer, icons (inline SVG, no icon font)
tests/               vitest + supertest (run with `npm test`)
```

## Deploy

Docker image (multi-stage, `node:22-alpine`, non-root, ffmpeg + yt-dlp
installed, healthcheck on `/health`):

```bash
docker build -t snatcher .
docker run -p 3000:3000 snatcher
```

On Koyeb, deploy from the public repo URL. Koyeb does not auto-deploy public
repos — after pushing, trigger the build manually in the Koyeb dashboard.

## Honest limits

- Instagram, TikTok and Facebook fetch from the platform's public pages.
  Whether they work depends on the server's IP: datacentre IPs get
  bot-checked or blocked, and private or login-walled posts never work.
  Failures surface as plain error messages, never as a fake success.
- YouTube quality depends on the player client that answers; the app tries
  `tv_embedded` first (full range) and falls back to `android` (360p).
- Only download media you have the right to keep.

## License

ISC
