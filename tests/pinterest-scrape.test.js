import { describe, it, expect } from 'vitest';

import { extractPinterestVideo } from '../src/media.js';

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
});
