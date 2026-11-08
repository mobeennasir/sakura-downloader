import { describe, it, expect } from 'vitest';
import { validateMediaUrl, detectPlatform } from '../src/validate.js';
import { Errors, isVerdictError } from '../src/errors.js';

describe('detectPlatform', () => {
  it('identifies each platform by host', () => {
    expect(detectPlatform('https://www.instagram.com/reel/abc/')).toBe('instagram');
    expect(detectPlatform('https://youtu.be/dQw4w9WgXcQ')).toBe('youtube');
    expect(detectPlatform('https://pin.it/abc123')).toBe('pinterest');
    expect(detectPlatform('https://vt.tiktok.com/abc/')).toBe('tiktok');
    expect(detectPlatform('https://fb.watch/abc/')).toBe('facebook');
    expect(detectPlatform('https://x.com/user/status/123')).toBe('twitter');
  });

  it('returns null for anything else', () => {
    expect(detectPlatform('https://example.com/video')).toBeNull();
    expect(detectPlatform('not a url')).toBeNull();
  });
});

describe('validateMediaUrl', () => {
  it('accepts a matching platform link', async () => {
    const { url, platform } = await validateMediaUrl(
      'https://www.instagram.com/reel/abc123/',
      'instagram'
    );
    expect(platform).toBe('instagram');
    expect(url).toContain('instagram.com');
  });

  it('rejects a link from the wrong platform', async () => {
    await expect(
      validateMediaUrl('https://www.tiktok.com/@u/video/1', 'instagram')
    ).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('rejects a lookalike host', async () => {
    await expect(
      validateMediaUrl('https://instagram.com.evil.com/reel/abc', 'instagram')
    ).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('rejects localhost (SSRF)', async () => {
    await expect(
      validateMediaUrl('http://localhost:3000/health', 'instagram')
    ).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('rejects a private IP literal', async () => {
    await expect(
      validateMediaUrl('http://192.168.1.10/video.mp4', 'instagram')
    ).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('rejects non-http schemes', async () => {
    await expect(
      validateMediaUrl('ftp://instagram.com/reel/abc', 'instagram')
    ).rejects.toMatchObject({ code: 'invalid_url' });
  });

  it('detects the platform when none is given', async () => {
    const { platform } = await validateMediaUrl('https://www.youtube.com/watch?v=x');
    expect(platform).toBe('youtube');
  });
});

describe('isVerdictError', () => {
  // RED: this helper does not exist yet. A verdict error (private, not found,
  // invalid) must never trigger a retry with another client or adapter.
  it('is true for private, not-found and invalid-url errors', () => {
    expect(isVerdictError(Errors.privateOrRemoved())).toBe(true);
    expect(isVerdictError(Errors.linkNotFound())).toBe(true);
    expect(isVerdictError(Errors.invalidUrl())).toBe(true);
  });

  it('is false for upstream and timeout errors', () => {
    expect(isVerdictError(Errors.upstreamError())).toBe(false);
    expect(isVerdictError(Errors.upstreamTimeout())).toBe(false);
    expect(isVerdictError(new Error('boom'))).toBe(false);
    expect(isVerdictError(null)).toBe(false);
  });
});
