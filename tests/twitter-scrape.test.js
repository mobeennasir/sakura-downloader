import { describe, it, expect } from 'vitest';

import { extractTwitterPhotos } from '../src/media.js';

// yt-dlp's Twitter extractor only handles videos, and btch's twitter
// handler finds no media URL for photo posts — so photo tweets failed
// outright. The tweet page itself carries the photos on pbs.twimg.com,
// plus the tweet text in og:description for the caption. No third-party
// API, no key.
const PHOTO_PAGE = `<!doctype html><html><head><meta property="og:title" content="Bitcoin AlphaX (@BitcoinAlphaX) on X"/><meta property="og:description" content="🎁 iPhone 18 Pro Max giveaway 🍎🔥"/></head><body><img src="https://pbs.twimg.com/media/HWh7zcQWkAAxbq9.jpg"/><img src="https://pbs.twimg.com/media/HWh7zcQWkAAxbq9?format=webp"/><img src="https:\\/\\/pbs.twimg.com\\/media\\/HWh7zx4XsAAMVqy.jpg"/></body></html>`;

const VIDEO_PAGE = `<!doctype html><html><head><meta property="og:title" content="NASA (@NASA) on X"/></head><body><video src="https://video.twimg.com/amplify_video/1816862298276806656/vid/avc1/1920x1080/oK8_XCGVEC35PlUf.mp4?tag=16"></video><img src="https://pbs.twimg.com/media/GTbKx_BXEAAp3_N.jpg"/></body></html>`;

describe('extractTwitterPhotos', () => {
  it('returns every photo once, preferring the plain image URL', () => {
    const out = extractTwitterPhotos(PHOTO_PAGE);
    expect(out.photos).toEqual([
      'https://pbs.twimg.com/media/HWh7zcQWkAAxbq9.jpg',
      'https://pbs.twimg.com/media/HWh7zx4XsAAMVqy.jpg',
    ]);
  });

  it('takes the author from og:title and the tweet text as caption', () => {
    const out = extractTwitterPhotos(PHOTO_PAGE);
    expect(out.title).toBe('Bitcoin AlphaX (@BitcoinAlphaX) on X');
    expect(out.caption).toBe('🎁 iPhone 18 Pro Max giveaway 🍎🔥');
  });

  it('returns null for a video tweet — the poster still is not the media', () => {
    expect(extractTwitterPhotos(VIDEO_PAGE)).toBeNull();
  });

  it('returns null when the page has no photos', () => {
    expect(extractTwitterPhotos('<html><head></head><body>just text</body></html>')).toBeNull();
    expect(extractTwitterPhotos('')).toBeNull();
    expect(extractTwitterPhotos(null)).toBeNull();
  });
});
