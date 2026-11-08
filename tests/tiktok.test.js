import { describe, it, expect } from 'vitest';

import { ytdlpInfoToItems } from '../src/media.js';

// TikTok's CDN (Akamai) rejects a direct server-side fetch of the signed
// video URL with 403, whatever User-Agent or Referer is sent — but yt-dlp
// downloads the same video fine. So TikTok items must carry a yt-dlp
// descriptor (the /dl proxy re-fetches through yt-dlp) instead of a direct
// CDN download link. Every other platform keeps direct downloads.
//
// NOTE: resolveTikTok itself is not unit-tested here — vitest cannot mock
// the CJS requires inside src/media.js (its require() calls bypass the
// mocked module registry, so the real extractor ran and the tests timed
// out). The resolver paths are verified instead by the scratch script in
// ~/workspace/sakura-verify/tiktok-resolver-check.js and by a live
// resolve + download against the real video.
const TIKTOK_URL = 'https://www.tiktok.com/@tiktok/video/7697388485807787286';
const CDN_1080 = 'https://v16-webapp-prime.us.tiktok.com/video/tos/no1a/okTayIVEBTT7UAojwifOAZQBEiARC1CCwz3IKS?expire=1794297345';
const CDN_720 = 'https://v16-webapp-prime.us.tiktok.com/video/tos/no1a/other720?expire=1794297345';

const tiktokInfo = () => ({
  title: 'TikTok video',
  description: 'A test video',
  thumbnail: 'https://cdn.example/thumb.jpg',
  formats: [
    { format_id: 'download', ext: 'mp4', protocol: 'https', vcodec: 'h264', acodec: 'aac', height: 720, filesize: 1619814, url: CDN_720 },
    { format_id: 'bytevc1_1080p_788199-0', ext: 'mp4', protocol: 'https', vcodec: 'h264', acodec: 'aac', height: 1080, filesize: 2118484, url: CDN_1080 },
    { format_id: 'dash-v', ext: 'mp4', protocol: 'https', vcodec: 'vp09', acodec: 'none', height: 1440, url: 'https://cdn.example/v1440.mp4' },
    { format_id: 'dash-a', ext: 'm4a', protocol: 'https', vcodec: 'none', acodec: 'mp4a', abr: 128, url: 'https://cdn.example/a.m4a' },
  ],
});

describe('TikTok downloads go through yt-dlp', () => {
  it('forceYtdlp routes a direct combined TikTok format through yt-dlp', () => {
    const items = ytdlpInfoToItems(tiktokInfo(), 'TikTok video', TIKTOK_URL, { forceYtdlp: true });
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe(CDN_1080);
    expect(items[0].ext).toBe('mp4');
    expect(items[0].ytdlp).toBeDefined();
    expect(items[0].ytdlp.url).toBe(TIKTOK_URL);
    expect(items[0].ytdlp.formatId).toBe('bytevc1_1080p_788199-0');
  });

  it('without forceYtdlp the same format stays a direct download', () => {
    const items = ytdlpInfoToItems(tiktokInfo(), 'TikTok video', TIKTOK_URL);
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe(CDN_1080);
    expect(items[0].ytdlp).toBeUndefined();
  });
});
