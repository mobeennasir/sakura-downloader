import { describe, it, expect } from 'vitest';
import { ytdlpInfoToItems } from '../src/media.js';

// A download must never be silent: the tallest format is usually a
// video-only DASH stream, so the picker has to prefer audio. Order:
// combined (video + audio) > no codec info (progressive files, whose
// extractors don't report codecs) > video-only merged with audio-only.
const info = (formats) => ({
  title: 'Test reel',
  thumbnail: null,
  _client: 'tv_embedded',
  formats,
});

describe('ytdlpInfoToItems audio selection', () => {
  it('prefers a combined format over a taller video-only one', () => {
    const items = ytdlpInfoToItems(
      info([
        { format_id: 'v1280', ext: 'mp4', protocol: 'https', vcodec: 'vp09', acodec: 'none', height: 1280, url: 'https://cdn.example/v1280.mp4' },
        { format_id: 'c720', ext: 'mp4', protocol: 'https', vcodec: 'avc1', acodec: 'mp4a', height: 720, url: 'https://cdn.example/c720.mp4' },
      ]),
      'Test reel',
      'https://www.instagram.com/reel/TEST/'
    );
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://cdn.example/c720.mp4');
    expect(items[0].ytdlp).toBeUndefined();
  });

  it('picks a no-codec-info progressive file over a video-only stream', () => {
    const items = ytdlpInfoToItems(
      info([
        { format_id: 'dash-a', ext: 'm4a', protocol: 'https', vcodec: 'none', acodec: 'mp4a', url: 'https://cdn.example/a.m4a' },
        { format_id: '3', ext: 'mp4', protocol: 'https', url: 'https://cdn.example/prog.mp4' },
        { format_id: 'dash-v', ext: 'mp4', protocol: 'https', vcodec: 'vp09', acodec: 'none', height: 1280, url: 'https://cdn.example/v.mp4' },
      ]),
      'Test reel',
      'https://www.instagram.com/reel/TEST/'
    );
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://cdn.example/prog.mp4');
    expect(items[0].ytdlp).toBeUndefined();
  });

  it('merges video-only with audio-only when nothing is combined', () => {
    const items = ytdlpInfoToItems(
      info([
        { format_id: 'dash-v', ext: 'mp4', protocol: 'https', vcodec: 'vp09', acodec: 'none', height: 1280, url: 'https://cdn.example/v.mp4' },
        { format_id: 'dash-a', ext: 'm4a', protocol: 'https', vcodec: 'none', acodec: 'mp4a', abr: 128, url: 'https://cdn.example/a.m4a' },
      ]),
      'Test reel',
      'https://www.instagram.com/reel/TEST/'
    );
    expect(items).toHaveLength(1);
    expect(items[0].ext).toBe('mp4');
    expect(items[0].ytdlp).toBeDefined();
    expect(items[0].ytdlp.formatId).toBe('dash-v+dash-a');
  });

  it('merges Pinterest HLS video with its audio rendition, whose codec is undeclared', () => {
    // Real Pinterest formats: the audio rendition reports acodec null
    // (not "mp4a", not "none") while video renditions report acodec
    // "none". The old hasAudio saw no audio at all and the pin
    // downloaded silent.
    const items = ytdlpInfoToItems(
      info([
        { format_id: 'V_HLSV3_MOBILE-audio-1', ext: 'mp4', protocol: 'm3u8_native', vcodec: 'none', acodec: null, url: 'https://cdn.example/audio.m3u8' },
        { format_id: 'V_HLSV3_MOBILE-211', ext: 'mp4', protocol: 'm3u8_native', vcodec: 'avc1.64080C', acodec: 'none', height: 144, url: 'https://cdn.example/v144.m3u8' },
        { format_id: 'V_HLSV3_MOBILE-489', ext: 'mp4', protocol: 'm3u8_native', vcodec: 'avc1.64081E', acodec: 'none', height: 414, url: 'https://cdn.example/v414.m3u8' },
      ]),
      'Test pin',
      'https://www.pinterest.com/pin/TEST/'
    );
    expect(items).toHaveLength(1);
    expect(items[0].ytdlp).toBeDefined();
    expect(items[0].ytdlp.formatId).toBe('V_HLSV3_MOBILE-489+V_HLSV3_MOBILE-audio-1');
  });

  it('falls back to the silent file only when no audio stream exists', () => {
    const items = ytdlpInfoToItems(
      info([
        { format_id: 'dash-v', ext: 'mp4', protocol: 'https', vcodec: 'vp09', acodec: 'none', height: 1280, url: 'https://cdn.example/v.mp4' },
      ]),
      'Test reel',
      'https://www.instagram.com/reel/TEST/'
    );
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://cdn.example/v.mp4');
  });
});
