import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ERRORS, formatError } from '../lib/error-messages.js';

describe('codex-plugin ERRORS registry', () => {
  const EXPECTED_KEYS = [
    'auth-not-configured',
    'auth-login-failed',
    'token-expired',
    'credentials-invalid',
    'doctor-check-failed',
    'cli-not-installed',
    'cli-version-too-low',
  ];

  it('defines all required keys', () => {
    for (const key of EXPECTED_KEYS) {
      assert.ok(key in ERRORS, `missing key: ${key}`);
    }
  });

  it('each entry has reason, fix, and hint', () => {
    for (const [key, entry] of Object.entries(ERRORS)) {
      assert.ok(entry.reason, `${key}: missing reason`);
      assert.ok(entry.fix,    `${key}: missing fix`);
      assert.ok(entry.hint,   `${key}: missing hint`);
    }
  });
});

describe('formatError (codex-plugin)', () => {
  it('returns structured output for auth-login-failed', () => {
    const out = formatError('auth-login-failed');
    assert.match(out, /Error:/);
    assert.match(out, /Fix:/);
    assert.match(out, /Hint:/);
    assert.ok(out.includes('auth login'), out);
  });

  it('throws for unknown key', () => {
    assert.throws(() => formatError('no-such-key'), /unknown error key/);
  });
});
