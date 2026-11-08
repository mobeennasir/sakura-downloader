import { describe, it, expect } from 'vitest';
import { safeFilename, urlFingerprint, captionNameBase } from '../src/media.js';

// Download filenames: every file gets a name unique to the media it came
// from, or the browser sees the same name twice and asks "download again?".
// Name shape: First caption words tag.ext when the post has a caption,
// else Title fingerprint tag.ext — the fingerprint is a short hash of the
// link, so it looks random and differs for every post, but the same file
// re-downloaded gets the same name (the one case where the prompt is
// correct). No media id appears in any filename.
describe('captionNameBase', () => {
  it('takes the first six words of a caption', () => {
    expect(captionNameBase('One two three four five six seven eight')).toBe(
      'One two three four five six'
    );
    expect(captionNameBase('Short caption')).toBe('Short caption');
  });

  it('returns null for a missing or blank caption', () => {
    expect(captionNameBase(null)).toBeNull();
    expect(captionNameBase('   ')).toBeNull();
  });
});

describe('urlFingerprint', () => {
  it('is a short hex string, stable per link and different per link', () => {
    const a = urlFingerprint('https://www.instagram.com/reel/DDWV2JeSGrG/');
    const b = urlFingerprint('https://www.instagram.com/reel/DDWV2JeSGrG/');
    const c = urlFingerprint('https://www.instagram.com/reel/OTHER123/');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).toBe(b); // same link, same name — re-download prompts, correctly
    expect(a).not.toBe(c); // different link, different name — no prompt
  });
});

describe('safeFilename', () => {
  it('builds caption words + quality with no media id', () => {
    expect(safeFilename('Good morning everyone', 'mp4', { tag: '720p' })).toBe(
      'Good_morning_everyone 720p.mp4'
    );
  });

  it('keeps the quality tag when a long title is truncated', () => {
    const name = safeFilename('A'.repeat(100), 'mp4', { tag: '1080p' });
    expect(name).toContain('1080p');
    expect(name.length).toBeLessThanOrEqual(86); // 80-char base + " 1080p" is inside it + ".mp4"
    expect(name.endsWith('.mp4')).toBe(true);
  });

  it('does not mangle a name that already carries its extension', () => {
    expect(safeFilename('My Video.mp4', 'mp4')).toBe('My_Video.mp4');
  });

  it('falls back to a plain name when there is no caption, title or tag', () => {
    expect(safeFilename(null, 'mp4', {})).toBe('snatcher.mp4');
  });
});
