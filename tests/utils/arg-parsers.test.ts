import { describe, it, expect } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { intArg, durationArg, stringArg, enumArg } from '../../src/utils/arg-parsers.js';

describe('intArg', () => {
  const parse = intArg('--max');

  it('accepts a plain positive integer', () => {
    expect(parse('5')).toBe('5');
    expect(parse('30000')).toBe('30000');
    expect(parse('0')).toBe('0');
  });

  it('rejects flag-like tokens but not pure negative integers', () => {
    // Bare negative integers fall through to min/max so the error classifies
    // as a range error instead of "requires a numeric value".
    expect(parse('-5')).toBe('-5');
    expect(() => parse('--help')).toThrow(InvalidArgumentError);
    expect(() => parse('--help')).toThrow(/requires a numeric value/);
    expect(() => parse('-x')).toThrow(/requires a numeric value/);
  });

  it('rejects non-numeric strings', () => {
    expect(() => parse('abc')).toThrow(/must be an integer/);
    expect(() => parse('5.5')).toThrow(/must be an integer/);
    expect(() => parse('1e2abc')).toThrow(/must be an integer/);
  });

  it('enforces min / max bounds when provided', () => {
    const bounded = intArg('--port', { min: 1, max: 65535 });
    expect(bounded('8080')).toBe('8080');
    expect(() => bounded('0')).toThrow(/>= 1/);
    expect(() => bounded('70000')).toThrow(/<= 65535/);
  });

  it('reports negative values as a range error (not flag-like) when min is set', () => {
    const bounded = intArg('--max', { min: 1 });
    expect(() => bounded('-1')).toThrow(/>= 1/);
    expect(() => bounded('-100')).toThrow(/>= 1/);
  });

  it('rejects values that look like subcommand names', () => {
    // `switchbot --timeout devices list` — Commander would normally swallow
    // "devices" as the --timeout value; argParser must catch it.
    expect(() => parse('devices')).toThrow(/must be an integer/);
  });
});

describe('durationArg', () => {
  const parse = durationArg('--interval');

  it('accepts valid durations', () => {
    expect(parse('30s')).toBe('30s');
    expect(parse('500ms')).toBe('500ms');
    expect(parse('1m')).toBe('1m');
    expect(parse('1h')).toBe('1h');
    expect(parse('1000')).toBe('1000'); // bare ms
  });

  it('rejects values starting with "-"', () => {
    expect(() => parse('--help')).toThrow(/requires a duration value/);
    expect(() => parse('-5s')).toThrow(/requires a duration value/);
  });

  it('rejects malformed durations', () => {
    expect(() => parse('abc')).toThrow(/must look like/);
    expect(() => parse('devices')).toThrow(/must look like/);
  });
});

describe('stringArg', () => {
  const parse = stringArg('--profile');

  it('accepts normal strings', () => {
    expect(parse('home')).toBe('home');
    expect(parse('my-profile_2')).toBe('my-profile_2');
  });

  it('allows a single-dash value (ambiguous, leave to caller)', () => {
    expect(parse('-single-dash')).toBe('-single-dash');
  });

  it('rejects values that start with "--"', () => {
    expect(() => parse('--help')).toThrow(InvalidArgumentError);
    expect(() => parse('--help')).toThrow(/looks like another option/);
    expect(() => parse('--whatever')).toThrow(/looks like another option/);
  });

  it('rejects values in the disallow list (e.g. subcommand names)', () => {
    // `switchbot --profile devices list` — "devices" is a subcommand name; we
    // want a clearer error than the default "unknown command 'list'".
    const parseWithDisallow = stringArg('--profile', { disallow: ['devices', 'scenes'] });
    expect(() => parseWithDisallow('devices')).toThrow(/subcommand name/);
    expect(() => parseWithDisallow('scenes')).toThrow(/subcommand name/);
    expect(parseWithDisallow('home')).toBe('home');
  });
});

describe('enumArg', () => {
  const parse = enumArg('--format', ['table', 'json', 'jsonl']);

  it('accepts values in the allowed set', () => {
    expect(parse('table')).toBe('table');
    expect(parse('json')).toBe('json');
  });

  it('rejects values not in the allowed set', () => {
    expect(() => parse('xml')).toThrow(/must be one of: table, json, jsonl/);
    expect(() => parse('--help')).toThrow(/must be one of/);
  });
});
