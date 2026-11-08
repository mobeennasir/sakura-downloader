import { describe, it, expect } from 'vitest';
import { signDownload, verifyDownload, buildYtDlpDownloadUrl } from '../src/download-links.js';
import { FORMAT_ID_RE } from '../src/yt-dlp.js';

describe('signed download links', () => {
  it('a signed payload verifies', () => {
    const payload = 'u=https://example.com/video.mp4';
    const sig = signDownload(payload);
    expect(verifyDownload(payload, sig)).toBe(true);
  });

  it('a tampered payload does not verify', () => {
    const sig = signDownload('u=https://example.com/video.mp4');
    expect(verifyDownload('u=https://example.com/other.mp4', sig)).toBe(false);
  });

  it('a forged signature does not verify', () => {
    expect(verifyDownload('u=https://example.com/video.mp4', 'deadbeef')).toBe(false);
  });

  it('a missing signature does not verify', () => {
    expect(verifyDownload('u=https://example.com/video.mp4', undefined)).toBe(false);
    expect(verifyDownload('u=https://example.com/video.mp4', '')).toBe(false);
  });
});

describe('FORMAT_ID_RE', () => {
  // RED: this constant does not exist yet. A format id goes to a spawned
  // process, so only yt-dlp format selectors may pass.
  it('accepts real yt-dlp format selectors', () => {
    expect(FORMAT_ID_RE.test('137')).toBe(true);
    expect(FORMAT_ID_RE.test('137+140')).toBe(true);
    expect(FORMAT_ID_RE.test('V_HLSV3_MOBILE-1025')).toBe(true);
    expect(FORMAT_ID_RE.test('bv*[ext=mp4]+ba[ext=m4a]')).toBe(false);
  });

  it('rejects anything with shell characters or spaces', () => {
    expect(FORMAT_ID_RE.test('137; rm -rf /')).toBe(false);
    expect(FORMAT_ID_RE.test('137 140')).toBe(false);
    expect(FORMAT_ID_RE.test('$(id)')).toBe(false);
    expect(FORMAT_ID_RE.test('137`id`')).toBe(false);
    expect(FORMAT_ID_RE.test('')).toBe(false);
  });
});

describe('buildYtDlpDownloadUrl', () => {
  // RED: this helper does not exist yet. The signed yt-dlp download URL is
  // built in two places (per-item links and YouTube convert) — one helper.
  it('builds a signed url that verifies', () => {
    const url = buildYtDlpDownloadUrl({
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      formatId: '137+140',
      ext: 'mp4',
      client: 'tv_embedded',
      filename: 'Rick_Astley.mp4',
    });
    expect(url).toContain('/dl?ytdlp=');
    expect(url).toContain('f=137%2B140');
    expect(url).toContain('name=Rick_Astley.mp4');
    const params = new URL(url, 'http://localhost').searchParams;
    const payload = `ytdlp=${params.get('ytdlp')}&f=${params.get('f')}&ext=${params.get('ext')}&c=${params.get('c')}`;
    expect(verifyDownload(payload, params.get('sig'))).toBe(true);
  });

  it('defaults the client when none is given', () => {
    const url = buildYtDlpDownloadUrl({
      url: 'https://www.pinterest.com/pin/1/',
      formatId: 'V_HLSV3_MOBILE-1025',
      ext: 'mp4',
      filename: 'pin.mp4',
    });
    expect(url).toContain('c=tv_embedded');
  });
});
