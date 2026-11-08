import { describe, it, expect } from 'vitest';

import { extractPinterestVideo, isHlsUrl } from '../src/media.js';

// The pin page carries the video as a progressive MP4 in its HTML:
// https://v1.pinimg.com/videos/iht/expMp4/<hash>_<width>w.mp4 — plain in the
// markup and escaped (https:\/\/...) inside the embedded __PWS_DATA__
// JSON. yt-dlp finds no formats for video pins from a flagged datacenter
// IP, and btch returns video_url null (thumbnail only), so this scrape is
// the alternative that gets the video itself. No third-party API, no key.
const PAGE = `<!doctype html><html><head><title>A Promise Kept | Shriram Life Insurance | Story commercial ads, Financial protection</title></head><body><script id="__PWS_DATA__" type="application/json">{"x":"https:\\/\\/v1.pinimg.com\\/videos\\/iht\\/expMp4\\/fb\\/8b\\/4b\\/fb8b4bd655dccd0aa39eba6f8af49101_480w.mp4","y":"https://v1.pinimg.com/videos/iht/expMp4/fb/8b/4b/fb8b4bd655dccd0aa39eba6f8af49101_720w.mp4","z":"https://i.pinimg.com/originals/c3/3b/f5/c33bf5a27f711480b7eebf22b4200d25.jpg"}</script></body></html>`;

describe('extractPinterestVideo', () => {
  it('picks the widest progressive MP4 and unescapes slashes', () => {
    const out = extractPinterestVideo(PAGE);
    expect(out.videoUrl).toBe(
      'https://v1.pinimg.com/videos/iht/expMp4/fb/8b/4b/fb8b4bd655dccd0aa39eba6f8af49101_720w.mp4'
    );
    expect(out.width).toBe(720);
  });

  it('takes the pin title without the trailing tag segment', () => {
    expect(extractPinterestVideo(PAGE).title).toBe(
      'A Promise Kept | Shriram Life Insurance'
    );
  });

  it('takes the originals image as thumbnail', () => {
    expect(extractPinterestVideo(PAGE).thumbnail).toBe(
      'https://i.pinimg.com/originals/c3/3b/f5/c33bf5a27f711480b7eebf22b4200d25.jpg'
    );
  });

  it('returns null when the page has no video', () => {
    expect(
      extractPinterestVideo(
        '<html><head><title>Just a photo</title></head></html>'
      )
    ).toBeNull();
    expect(extractPinterestVideo('')).toBeNull();
    expect(extractPinterestVideo(null)).toBeNull();
  });

  it('falls back to any progressive MP4 under /videos/ when there is no expMp4 width suffix', () => {
    const page = `<html><head><title>Clip</title></head><body>{"u":"https://v1.pinimg.com/videos/iht/abc123def456.mp4"}</body></html>`;
    const out = extractPinterestVideo(page);
    expect(out.videoUrl).toBe('https://v1.pinimg.com/videos/iht/abc123def456.mp4');
    expect(out.width).toBeNull();
  });

  it('does not mistake an HLS manifest for a video file', () => {
    const page = `<html><head><title>Clip</title></head><body>{"u":"https://v1.pinimg.com/videos/iht/hls/abc123def456.m3u8"}</body></html>`;
    expect(extractPinterestVideo(page)).toBeNull();
  });

  it('returns null for a pin whose page carries only HLS manifests (several widths, no expMp4)', () => {
    // His pin (pin.it/6dZmTUDw1): yt-dlp returns only .m3u8 formats and
    // the page carries the same manifests — no progressive MP4 anywhere.
    // The resolver must fall through (to btch) instead of returning a
    // playlist as if it were a file.
    const page = `<html><head><title>Pin</title></head><body>{"a":"https://v1.pinimg.com/videos/iht/hls/38/63/ab/3863abb7fedf4c59c6f8daa52045bb7a_240w.m3u8","b":"https://v1.pinimg.com/videos/iht/hls/38/63/ab/3863abb7fedf4c59c6f8daa52045bb7a_720w.m3u8","c":"https://v1.pinimg.com/videos/iht/hls/38/63/ab/3863abb7fedf4c59c6f8daa52045bb7a_audio.m3u8"}</body></html>`;
    expect(extractPinterestVideo(page)).toBeNull();
  });
});

describe('isHlsUrl', () => {
  it('matches .m3u8 manifests, with or without a query string', () => {
    expect(isHlsUrl('https://v1.pinimg.com/videos/iht/hls/abc_720w.m3u8')).toBe(true);
    expect(isHlsUrl('https://example.com/stream.m3u8?token=abc')).toBe(true);
  });

  it('does not match progressive MP4s or non-strings', () => {
    expect(isHlsUrl('https://v1.pinimg.com/videos/iht/expMp4/abc_720w.mp4')).toBe(false);
    expect(isHlsUrl('https://example.com/video.mp4')).toBe(false);
    expect(isHlsUrl(null)).toBe(false);
    expect(isHlsUrl(undefined)).toBe(false);
  });
});
