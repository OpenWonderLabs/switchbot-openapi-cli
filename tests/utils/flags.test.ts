import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isVerbose,
  isDryRun,
  getTimeout,
  getConfigPath,
  parseDurationToMs,
} from '../../src/utils/flags.js';

describe('utils/flags', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    // Baseline with no flags
    process.argv = ['node', 'test'];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  describe('isVerbose', () => {
    it('returns false when no verbose flag is set', () => {
      expect(isVerbose()).toBe(false);
    });

    it('returns true for --verbose', () => {
      process.argv.push('--verbose');
      expect(isVerbose()).toBe(true);
    });

    it('returns true for -v short flag', () => {
      process.argv.push('-v');
      expect(isVerbose()).toBe(true);
    });
  });

  describe('isDryRun', () => {
    it('returns false when --dry-run is absent', () => {
      expect(isDryRun()).toBe(false);
    });

    it('returns true when --dry-run is present anywhere in argv', () => {
      process.argv.push('devices', 'command', 'ABC', 'turnOn', '--dry-run');
      expect(isDryRun()).toBe(true);
    });
  });

  describe('getTimeout', () => {
    it('defaults to 30000ms', () => {
      expect(getTimeout()).toBe(30_000);
    });

    it('reads the value following --timeout', () => {
      process.argv.push('--timeout', '5000');
      expect(getTimeout()).toBe(5_000);
    });

    it('falls back to default when value is not a positive finite number', () => {
      process.argv.push('--timeout', 'not-a-number');
      expect(getTimeout()).toBe(30_000);
    });

    it('falls back to default for zero or negative values', () => {
      process.argv.push('--timeout', '0');
      expect(getTimeout()).toBe(30_000);
    });
  });

  describe('getConfigPath', () => {
    it('returns undefined when --config is absent', () => {
      expect(getConfigPath()).toBeUndefined();
    });

    it('returns the value following --config', () => {
      process.argv.push('--config', '/tmp/foo.json');
      expect(getConfigPath()).toBe('/tmp/foo.json');
    });

    it('returns undefined when --config is at the very end with no value', () => {
      process.argv.push('--config');
      expect(getConfigPath()).toBeUndefined();
    });
  });

  describe('parseDurationToMs', () => {
    it('accepts ms / s / m / h units', () => {
      expect(parseDurationToMs('500ms')).toBe(500);
      expect(parseDurationToMs('30s')).toBe(30_000);
      expect(parseDurationToMs('5m')).toBe(5 * 60_000);
      expect(parseDurationToMs('2h')).toBe(2 * 60 * 60_000);
    });

    it('accepts d (days) and w (weeks) units', () => {
      expect(parseDurationToMs('1d')).toBe(24 * 60 * 60_000);
      expect(parseDurationToMs('7d')).toBe(7 * 24 * 60 * 60_000);
      expect(parseDurationToMs('1w')).toBe(7 * 24 * 60 * 60_000);
      expect(parseDurationToMs('2w')).toBe(14 * 24 * 60 * 60_000);
    });

    it('treats bare numbers as milliseconds', () => {
      expect(parseDurationToMs('1000')).toBe(1000);
    });

    it('rejects unsupported units and malformed values', () => {
      expect(parseDurationToMs('1y')).toBeNull();
      expect(parseDurationToMs('1year')).toBeNull();
      expect(parseDurationToMs('1month')).toBeNull();
      expect(parseDurationToMs('abc')).toBeNull();
      expect(parseDurationToMs('')).toBeNull();
    });
  });
});
