/**
 * Policy v0.1 schema validation — unit tests.
 *
 * Drives `validateLoadedPolicy` against a matrix of real-looking YAML
 * documents and asserts:
 *   - valid fixtures pass with no errors
 *   - invalid fixtures surface the expected `keyword` (ajv) at the
 *     expected instancePath
 *   - destructive actions cannot be pre-approved in `never_confirm`
 *     (the skill's primary safety invariant)
 *   - quiet_hours uses `dependentRequired` so partial configs fail
 *
 * We load through `loadPolicyFile` because the validator consumes the
 * full `LoadedPolicy` envelope (data + doc + source), and we want the
 * tests to exercise the same path production uses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPolicyFile } from '../../src/policy/load.js';
import { validateLoadedPolicy } from '../../src/policy/validate.js';

function writeAndLoad(tmpDir: string, yaml: string) {
  const p = path.join(tmpDir, 'policy.yaml');
  fs.writeFileSync(p, yaml, 'utf-8');
  return loadPolicyFile(p);
}

describe('policy validator (v0.1)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-policy-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts the shipped starter template verbatim', () => {
    const templatePath = path.resolve(__dirname, '../../src/policy/examples/policy.example.yaml');
    const loaded = loadPolicyFile(templatePath);
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a minimal policy with only the version field', () => {
    const loaded = writeAndLoad(tmpDir, 'version: "0.1"\n');
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(true);
  });

  it('accepts nulls on every optional block (commented-out YAML parses as null)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.1"',
        'aliases:',
        'confirmations:',
        'quiet_hours:',
        'audit:',
        'automation:',
        'cli:',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(true);
  });

  it('flags a missing version field with a clear hint', () => {
    const loaded = writeAndLoad(tmpDir, 'aliases:\n  "lamp": "01-ABC-12345"\n');
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const missing = result.errors.find((e) => e.keyword === 'required');
    expect(missing).toBeDefined();
    expect(missing!.message).toContain('version');
    expect(missing!.hint).toContain('0.1');
  });

  it('rejects a wrong version constant and hints at migrate', () => {
    const loaded = writeAndLoad(tmpDir, 'version: "0.2"\n');
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const versionErr = result.errors.find((e) => e.path === '/version' && e.keyword === 'const');
    expect(versionErr).toBeDefined();
    expect(versionErr!.hint).toContain('migrate');
  });

  it('rejects an unknown top-level key and points to it', () => {
    const loaded = writeAndLoad(tmpDir, 'version: "0.1"\nbogus: 1\n');
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const extra = result.errors.find((e) => e.keyword === 'additionalProperties');
    expect(extra).toBeDefined();
    expect(extra!.message).toContain('bogus');
    expect(extra!.line).toBe(2);
  });

  it('accepts an aliases map with canonical deviceId format', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.1"',
        'aliases:',
        '  "living room light": "01-202407090924-26354212"',
        '  "bedroom AC":        "02-202502111234-85411230"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(true);
  });

  it('rejects lowercased deviceIds with a deviceId-format hint', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'aliases:', '  "lamp": "not-a-device-id"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const patternErr = result.errors.find((e) => e.keyword === 'pattern');
    expect(patternErr).toBeDefined();
    expect(patternErr!.path).toBe('/aliases/lamp');
    expect(patternErr!.hint).toContain('devices list');
  });

  for (const destructive of ['lock', 'unlock', 'deleteWebhook', 'deleteScene', 'factoryReset']) {
    it(`rejects "${destructive}" inside confirmations.never_confirm`, () => {
      const loaded = writeAndLoad(
        tmpDir,
        [
          'version: "0.1"',
          'confirmations:',
          '  never_confirm:',
          `    - "${destructive}"`,
          '',
        ].join('\n'),
      );
      const result = validateLoadedPolicy(loaded);
      expect(result.valid).toBe(false);
      const notErr = result.errors.find(
        (e) => e.keyword === 'not' && e.path.startsWith('/confirmations/never_confirm/'),
      );
      expect(notErr).toBeDefined();
      expect(notErr!.hint).toMatch(/destructive/);
    });
  }

  it('accepts non-destructive actions in never_confirm (e.g. turnOn/turnOff)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      [
        'version: "0.1"',
        'confirmations:',
        '  never_confirm:',
        '    - "turnOn"',
        '    - "turnOff"',
        '',
      ].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(true);
  });

  it('accepts well-formed quiet_hours', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'quiet_hours:', '  start: "22:00"', '  end:   "08:00"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(true);
  });

  it('rejects out-of-range hours (25:00) with a pattern error', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'quiet_hours:', '  start: "25:00"', '  end:   "08:00"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const patternErr = result.errors.find((e) => e.keyword === 'pattern' && e.path.includes('quiet_hours'));
    expect(patternErr).toBeDefined();
  });

  it('rejects quiet_hours with only `start` (dependentRequired)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'quiet_hours:', '  start: "22:00"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const depErr = result.errors.find((e) => e.keyword === 'dependentRequired');
    expect(depErr).toBeDefined();
    expect(depErr!.message).toContain('end');
  });

  it('rejects quiet_hours with only `end` (dependentRequired)', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'quiet_hours:', '  end: "08:00"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const depErr = result.errors.find((e) => e.keyword === 'dependentRequired');
    expect(depErr).toBeDefined();
    expect(depErr!.message).toContain('start');
  });

  it('accepts audit.retention as "never" or "<n>d|w|m"', () => {
    for (const retention of ['never', '90d', '4w', '6m']) {
      const loaded = writeAndLoad(
        tmpDir,
        ['version: "0.1"', 'audit:', `  retention: "${retention}"`, ''].join('\n'),
      );
      const result = validateLoadedPolicy(loaded);
      expect(result.valid, `retention=${retention}`).toBe(true);
    }
  });

  it('rejects audit.retention without a unit suffix', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'audit:', '  retention: "10"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'pattern')).toBe(true);
  });

  it('accepts cli.cache_ttl in "<n>s|m|h" format', () => {
    for (const ttl of ['30s', '5m', '2h']) {
      const loaded = writeAndLoad(
        tmpDir,
        ['version: "0.1"', 'cli:', `  cache_ttl: "${ttl}"`, ''].join('\n'),
      );
      const result = validateLoadedPolicy(loaded);
      expect(result.valid, `cache_ttl=${ttl}`).toBe(true);
    }
  });

  it('reports line and column for the offending value', () => {
    const loaded = writeAndLoad(
      tmpDir,
      ['version: "0.1"', 'aliases:', '  "lamp": "lowercase-bad"', ''].join('\n'),
    );
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    const patternErr = result.errors.find((e) => e.keyword === 'pattern');
    expect(patternErr).toBeDefined();
    expect(patternErr!.line).toBe(3);
    expect(typeof patternErr!.col).toBe('number');
  });
});
