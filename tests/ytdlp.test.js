import { describe, it, expect } from 'vitest';
import { mapYtDlpError, baseArgs } from '../src/yt-dlp.js';

// baseArgs is the shared yt-dlp flag set: quiet, a socket timeout, and the
// login cookies when configured. No per-platform extractor args — yt-dlp
// runs the same for every platform now.
describe('baseArgs', () => {
  it('carries the common flags and no youtube extractor args', () => {
    const args = baseArgs();
    expect(args).toContain('--no-warnings');
    expect(args).toContain('--socket-timeout');
    expect(args.join(' ')).not.toContain('youtube:');
    expect(args.join(' ')).not.toContain('player_client');
  });
});

// yt-dlp's stderr is the only signal for what went wrong. A dead video must
// read as "that link went nowhere" (404), never as "the platform stumbled"
// (502) — retrying a dead link never helps.
describe('mapYtDlpError', () => {
  it('maps dead-video wordings to link_not_found', () => {
    expect(mapYtDlpError('ERROR: [TikTok] xxxxxxxxxxx: This video is unavailable').code).toBe(
      'link_not_found'
    );
    expect(mapYtDlpError('ERROR: [TikTok] abc: Video unavailable').code).toBe(
      'link_not_found'
    );
    expect(
      mapYtDlpError('ERROR: [TikTok] abc: This video is no longer available').code
    ).toBe('link_not_found');
    expect(
      mapYtDlpError('ERROR: [TikTok] abc: This video has been removed').code
    ).toBe('link_not_found');
    expect(mapYtDlpError('ERROR: [TikTok] abc: Video no longer available').code).toBe(
      'link_not_found'
    );
  });

  it('maps private videos to private_or_removed', () => {
    expect(
      mapYtDlpError('ERROR: [TikTok] abc: Private video. Sign in if you have access.').code
    ).toBe('private_or_removed');
    expect(mapYtDlpError('ERROR: [TikTok] abc: This video is private').code).toBe(
      'private_or_removed'
    );
  });

  it('maps the sign-in bot check to forbidden', () => {
    expect(
      mapYtDlpError('ERROR: [TikTok] abc: Sign in to confirm you are not a bot').code
    ).toBe('forbidden');
  });

  it('maps "No video formats found" to no_media, not upstream_error', () => {
    // A Pinterest image pin: yt-dlp's extractor finds no video formats,
    // but the pin (and its image) exists — btch finds it. Retrying never
    // helps, so this must not read as a 502.
    expect(
      mapYtDlpError(
        'ERROR: [Pinterest] 767300855301081893: No video formats found!; please report this issue on https://github.com/yt-dlp/yt-dlp/issues'
      ).code
    ).toBe('no_media');
    expect(mapYtDlpError('ERROR: [TikTok] abc: No formats found!').code).toBe('no_media');
  });

  it('falls through to upstream_error for anything else', () => {
    expect(mapYtDlpError('ERROR: [TikTok] abc: Something odd happened').code).toBe(
      'upstream_error'
    );
    expect(mapYtDlpError('').code).toBe('upstream_error');
  });
});
