import { describe, it, expect } from 'vitest';
import { pickCaption } from '../src/media.js';

describe('pickCaption', () => {
  it('returns the first non-empty candidate', () => {
    expect(pickCaption(null, '', '  ', 'hello')).toBe('hello');
  });

  it('trims surrounding whitespace', () => {
    expect(pickCaption('  spaced out  \n')).toBe('spaced out');
  });

  it('returns null when every candidate is empty', () => {
    expect(pickCaption(null, undefined, '', '   ')).toBe(null);
    expect(pickCaption()).toBe(null);
  });

  it('ignores non-string candidates', () => {
    expect(pickCaption(42, { text: 'x' }, 'real')).toBe('real');
  });

  it('caps very long captions at 10000 chars', () => {
    const long = 'x'.repeat(15000);
    const out = pickCaption(long);
    expect(out.length).toBe(10000);
  });

  it('keeps newlines inside the caption (the textarea shows them)', () => {
    expect(pickCaption('line one\nline two')).toBe('line one\nline two');
  });
});
