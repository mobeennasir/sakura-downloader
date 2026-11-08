import { describe, it, expect } from 'vitest';
import {
  signDownload,
  verifyDownload,
  buildYtDlpDownloadUrl,
  buildDirectDownloadUrl,
  ytdlpPayload,
  directPayload,
  needsBuffer,
} from '../src/download-links.js';
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
  // built in one place — per-item links — so one helper builds it.
  it('builds a signed url that verifies', () => {
    const url = buildYtDlpDownloadUrl({
      url: 'https://www.pinterest.com/pin/1125618500656146145/',
      formatId: '137+140',
      ext: 'mp4',
      filename: 'A_Promise_Kept.mp4',
    });
    expect(url).toContain('/dl?ytdlp=');
    expect(url).toContain('f=137%2B140');
    expect(url).toContain('name=A_Promise_Kept.mp4');
    const params = new URL(url, 'http://localhost').searchParams;
    const payload = `ytdlp=${params.get('ytdlp')}&f=${params.get('f')}&ext=${params.get('ext')}`;
    expect(verifyDownload(payload, params.get('sig'))).toBe(true);
  });

  it('carries no client parameter in the url', () => {
    const url = buildYtDlpDownloadUrl({
      url: 'https://www.pinterest.com/pin/1/',
      formatId: 'V_HLSV3_MOBILE-1025',
      ext: 'mp4',
      filename: 'pin.mp4',
    });
    expect(url).not.toContain('c=');
  });

  it('carries an exact size and buffer flag inside the signature', () => {
    const url = buildYtDlpDownloadUrl({
      url: 'https://www.pinterest.com/pin/1125618500656146145/',
      formatId: '137+140',
      ext: 'mp4',
      filename: 'A_Promise_Kept.mp4',
      size: 41123456,
      buffer: true,
    });
    expect(url).toContain('s=41123456');
    expect(url).toContain('b=1');
    const params = new URL(url, 'http://localhost').searchParams;
    const payload = ytdlpPayload({
      url: params.get('ytdlp'),
      formatId: params.get('f'),
      ext: params.get('ext'),
      size: params.get('s'),
      buffer: params.get('b') === '1',
    });
    expect(verifyDownload(payload, params.get('sig'))).toBe(true);
  });

  it('a tampered size does not verify', () => {
    const url = buildYtDlpDownloadUrl({
      url: 'https://www.pinterest.com/pin/1125618500656146145/',
      formatId: '140',
      ext: 'm4a',
      filename: 'audio.m4a',
      size: 5000000,
    });
    const params = new URL(url, 'http://localhost').searchParams;
    const tampered = ytdlpPayload({
      url: params.get('ytdlp'),
      formatId: params.get('f'),
      ext: params.get('ext'),
      size: '9999999',
    });
    expect(verifyDownload(tampered, params.get('sig'))).toBe(false);
  });
});

describe('needsBuffer', () => {
  it('buffers merged formats and HLS, streams single files', () => {
    expect(needsBuffer({ formatId: '137+140', isHls: false })).toBe(true);
    expect(needsBuffer({ formatId: '140', isHls: false })).toBe(false);
    expect(needsBuffer({ formatId: 'V_HLSV3_MOBILE-1025', isHls: true })).toBe(true);
    expect(needsBuffer({ formatId: null, isHls: false })).toBe(false);
  });
});

describe('buildDirectDownloadUrl', () => {
  it('builds a signed url that verifies, with and without a size', () => {
    const withSize = buildDirectDownloadUrl({
      url: 'https://example.com/video.mp4',
      filename: 'video.mp4',
      size: 123456,
    });
    expect(withSize).toContain('s=123456');
    const p1 = new URL(withSize, 'http://localhost').searchParams;
    expect(
      verifyDownload(directPayload({ url: p1.get('u'), size: p1.get('s') }), p1.get('sig'))
    ).toBe(true);

    const noSize = buildDirectDownloadUrl({ url: 'https://example.com/video.mp4', filename: 'video.mp4' });
    expect(noSize).not.toContain('s=');
    const p2 = new URL(noSize, 'http://localhost').searchParams;
    expect(
      verifyDownload(directPayload({ url: p2.get('u') }), p2.get('sig'))
    ).toBe(true);
  });

  it('a tampered size does not verify', () => {
    const url = buildDirectDownloadUrl({
      url: 'https://example.com/video.mp4',
      filename: 'video.mp4',
      size: 123456,
    });
    const params = new URL(url, 'http://localhost').searchParams;
    expect(
      verifyDownload(directPayload({ url: params.get('u'), size: '654321' }), params.get('sig'))
    ).toBe(false);
  });
});
