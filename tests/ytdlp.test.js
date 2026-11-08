import { describe, it, expect } from 'vitest';
import { mapYtDlpError } from '../src/yt-dlp.js';

// yt-dlp's stderr is the only signal for what went wrong. A dead video must
// read as "that link went nowhere" (404), never as "the platform stumbled"
// (502) — retrying a dead link never helps.
describe('mapYtDlpError', () => {
  it('maps dead-video wordings to link_not_found', () => {
    expect(mapYtDlpError('ERROR: [youtube] xxxxxxxxxxx: This video is unavailable').code).toBe(
      'link_not_found'
    );
    expect(mapYtDlpError('ERROR: [youtube] abc: Video unavailable').code).toBe(
      'link_not_found'
    );
    expect(
      mapYtDlpError('ERROR: [youtube] abc: This video is no longer available').code
    ).toBe('link_not_found');
    expect(
      mapYtDlpError('ERROR: [youtube] abc: This video has been removed').code
    ).toBe('link_not_found');
    expect(mapYtDlpError('ERROR: [youtube] abc: Video no longer available').code).toBe(
      'link_not_found'
    );
  });

  it('maps private videos to private_or_removed', () => {
    expect(
      mapYtDlpError('ERROR: [youtube] abc: Private video. Sign in if you have access.').code
    ).toBe('private_or_removed');
    expect(mapYtDlpError('ERROR: [youtube] abc: This video is private').code).toBe(
      'private_or_removed'
    );
  });

  it('maps the sign-in bot check to forbidden', () => {
    expect(
      mapYtDlpError('ERROR: [youtube] abc: Sign in to confirm you are not a bot').code
    ).toBe('forbidden');
  });

  it('falls through to upstream_error for anything else', () => {
    expect(mapYtDlpError('ERROR: [youtube] abc: Something odd happened').code).toBe(
      'upstream_error'
    );
    expect(mapYtDlpError('').code).toBe('upstream_error');
  });
});
