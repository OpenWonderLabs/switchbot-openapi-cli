/**
 * Policy file loader + path resolver — unit tests.
 *
 * Covers the failure modes we see in the wild:
 *   - ENOENT wraps in PolicyFileNotFoundError
 *   - YAML syntax errors wrap in PolicyYamlParseError with line info
 *   - utf-8 BOM, CRLF, and non-ASCII (Chinese) aliases all parse
 *   - path resolution precedence: --policy flag > env > default
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  loadPolicyFile,
  resolvePolicyPath,
  PolicyFileNotFoundError,
  PolicyYamlParseError,
  DEFAULT_POLICY_PATH,
} from '../../src/policy/load.js';
import { validateLoadedPolicy } from '../../src/policy/validate.js';

describe('policy loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-policy-load-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws PolicyFileNotFoundError for a missing file', () => {
    const missing = path.join(tmpDir, 'nope.yaml');
    expect(() => loadPolicyFile(missing)).toThrowError(PolicyFileNotFoundError);
    try {
      loadPolicyFile(missing);
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyFileNotFoundError);
      expect((err as PolicyFileNotFoundError).policyPath).toBe(missing);
    }
  });

  it('throws PolicyYamlParseError on syntax errors and records line numbers', () => {
    const p = path.join(tmpDir, 'policy.yaml');
    // Flow-style list left unclosed — yaml@2 surfaces this as a hard error.
    fs.writeFileSync(p, 'version: "0.1"\naliases: [unterminated\n', 'utf-8');
    try {
      loadPolicyFile(p);
      throw new Error('expected PolicyYamlParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(PolicyYamlParseError);
      const pe = err as PolicyYamlParseError;
      expect(pe.policyPath).toBe(p);
      expect(pe.yamlErrors.length).toBeGreaterThan(0);
    }
  });

  it('strips utf-8 BOM transparently (v0.1 file loads but fails unsupported-version)', () => {
    const p = path.join(tmpDir, 'policy.yaml');
    const bom = '\uFEFF';
    fs.writeFileSync(p, `${bom}version: "0.1"\n`, 'utf-8');
    const loaded = loadPolicyFile(p);
    // Loader must succeed (no throw); v0.1 is rejected at the validation layer.
    expect(loaded).toBeDefined();
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it('handles CRLF line endings (v0.1 file loads but fails unsupported-version)', () => {
    const p = path.join(tmpDir, 'policy.yaml');
    fs.writeFileSync(p, 'version: "0.1"\r\naliases:\r\n  "lamp": "01-ABC-12345"\r\n', 'utf-8');
    const loaded = loadPolicyFile(p);
    expect(loaded).toBeDefined();
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it('preserves non-ASCII alias keys (utf-8, e.g. Chinese) — loader succeeds, validator rejects v0.1', () => {
    const p = path.join(tmpDir, 'policy.yaml');
    fs.writeFileSync(
      p,
      ['version: "0.1"', 'aliases:', '  "客厅灯": "01-202407090924-26354212"', ''].join('\n'),
      'utf-8',
    );
    const loaded = loadPolicyFile(p);
    // The loader must preserve the non-ASCII key regardless of schema version.
    const aliases = (loaded.data as { aliases: Record<string, string> }).aliases;
    expect(aliases['客厅灯']).toBe('01-202407090924-26354212');
    // Validation now rejects v0.1.
    const result = validateLoadedPolicy(loaded);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.keyword === 'unsupported-version')).toBe(true);
  });

  it('exposes the raw source string for snippet rendering', () => {
    const p = path.join(tmpDir, 'policy.yaml');
    const src = 'version: "0.1"\n';
    fs.writeFileSync(p, src, 'utf-8');
    const loaded = loadPolicyFile(p);
    expect(loaded.source).toBe(src);
    expect(loaded.path).toBe(p);
  });
});

describe('resolvePolicyPath', () => {
  it('prioritizes the --policy flag over env and default', () => {
    const resolved = resolvePolicyPath({
      flag: '/tmp/from-flag.yaml',
      env: { SWITCHBOT_POLICY_PATH: '/tmp/from-env.yaml' },
    });
    // resolved goes through path.resolve — just assert the tail matches.
    expect(resolved.endsWith('from-flag.yaml')).toBe(true);
  });

  it('falls back to SWITCHBOT_POLICY_PATH when the flag is absent', () => {
    const resolved = resolvePolicyPath({
      env: { SWITCHBOT_POLICY_PATH: path.join(os.tmpdir(), 'from-env.yaml') },
    });
    expect(resolved.endsWith('from-env.yaml')).toBe(true);
  });

  it('ignores blank-string flag and env values', () => {
    const resolved = resolvePolicyPath({
      flag: '   ',
      env: { SWITCHBOT_POLICY_PATH: '' },
    });
    expect(resolved).toBe(DEFAULT_POLICY_PATH);
  });

  it('returns DEFAULT_POLICY_PATH when neither flag nor env is set', () => {
    const resolved = resolvePolicyPath({ env: {} });
    expect(resolved).toBe(DEFAULT_POLICY_PATH);
  });

  // Deliberate gap pin: resolvePolicyPath has no awareness of the CLI's
  // --profile flag today. If profile-aware policy paths ever land (e.g.
  // ~/.config/openclaw/switchbot/profiles/<profile>/policy.yaml), this
  // assertion needs updating alongside the "File location" section in
  // docs/policy-reference.md.
  it('does not derive the path from a profile hint (current behavior)', () => {
    const resolved = resolvePolicyPath({ env: { SWITCHBOT_PROFILE: 'work' } });
    expect(resolved).toBe(DEFAULT_POLICY_PATH);
    expect(resolved).not.toContain('work');
    expect(resolved).not.toContain('profiles');
  });
});
