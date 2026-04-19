import { describe, it, expect } from 'vitest';
import { levenshtein, normalizeDeviceName } from '../../src/utils/string.js';

describe('levenshtein', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
  });

  it('returns length of b for empty a', () => {
    expect(levenshtein('', 'abc')).toBe(3);
  });

  it('returns length of a for empty b', () => {
    expect(levenshtein('abc', '')).toBe(3);
  });

  it('computes classic kitten→sitting distance of 3', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  it('computes single substitution', () => {
    expect(levenshtein('abc', 'axc')).toBe(1);
  });

  it('computes single insertion', () => {
    expect(levenshtein('ac', 'abc')).toBe(1);
  });

  it('computes single deletion', () => {
    expect(levenshtein('abc', 'ac')).toBe(1);
  });

  it('is case-sensitive', () => {
    expect(levenshtein('ABC', 'abc')).toBe(3);
  });
});

describe('normalizeDeviceName', () => {
  it('lowercases', () => {
    expect(normalizeDeviceName('Living Room AC')).toBe('living room ac');
  });

  it('strips punctuation replacing with space', () => {
    expect(normalizeDeviceName('客厅-空调!')).toBe('客厅 空调');
  });

  it('collapses multiple spaces', () => {
    expect(normalizeDeviceName('a   b  c')).toBe('a b c');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalizeDeviceName('  hello  ')).toBe('hello');
  });

  it('preserves Chinese characters', () => {
    expect(normalizeDeviceName('客厅空调')).toBe('客厅空调');
  });
});
