import { describe, it, expect } from 'vitest';
import { safeFilename, extractMediaId, captionNameBase } from '../src/media.js';

// Download filenames: every file gets a name unique to the media it came
// from, or the browser sees the same name twice and asks "download again?".
// Name shape: First caption words [id] tag.ext — caption words when the
// post has a caption, else the title, else the platform; the [id] is the
// media id from the source URL (or a short hash of the URL when the
// platform hides its ids), so two posts with the same opening words still
// get different names, while the same file re-downloaded gets the same
// name — which is the one case where the prompt is correct.
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

describe('extractMediaId', () => {
  it('pulls the id from each platform URL shape', () => {
    expect(extractMediaId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ'
    );
    expect(extractMediaId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(extractMediaId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ'
    );
    expect(extractMediaId('https://www.instagram.com/reel/DDWV2JeSGrG/')).toBe(
      'DDWV2JeSGrG'
    );
    expect(extractMediaId('https://www.instagram.com/p/ABC123xyz/')).toBe('ABC123xyz');
    expect(extractMediaId('https://www.tiktok.com/@u/video/7234567890123456789')).toBe(
      '7234567890123456789'
    );
    expect(extractMediaId('https://x.com/NASA/status/1816862466816496101')).toBe(
      '1816862466816496101'
    );
    expect(extractMediaId('https://in.pinterest.com/pin/1125618500656146145/')).toBe(
      '1125618500656146145'
    );
  });

  it('falls back to a short deterministic hash when no id is in the URL', () => {
    const a = extractMediaId('https://www.facebook.com/share/v/abc123/');
    const b = extractMediaId('https://www.facebook.com/share/v/abc123/');
    const c = extractMediaId('https://www.facebook.com/share/v/different/');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).toBe(b); // same link, same name — re-download prompts, correctly
    expect(a).not.toBe(c); // different link, different name — no prompt
  });
});

describe('safeFilename', () => {
  it('builds caption words + id + quality', () => {
    expect(
      safeFilename('Good morning everyone', 'mp4', { id: 'DDWV2JeSGrG', tag: '720p' })
    ).toBe('Good_morning_everyone [DDWV2JeSGrG] 720p.mp4');
  });

  it('keeps the id and tag when a long title is truncated', () => {
    const name = safeFilename('A'.repeat(100), 'mp4', { id: 'dQw4w9WgXcQ', tag: '1080p' });
    expect(name).toContain('[dQw4w9WgXcQ]');
    expect(name).toContain('1080p');
    expect(name.length).toBeLessThanOrEqual(84); // 80-char base + ".mp4"
  });

  it('does not mangle a name that already carries its extension', () => {
    expect(safeFilename('My Video.mp4', 'mp4')).toBe('My_Video.mp4');
  });

  it('falls back to a plain name when there is no caption, title or id', () => {
    expect(safeFilename(null, 'mp4', {})).toBe('snatcher.mp4');
  });
});
