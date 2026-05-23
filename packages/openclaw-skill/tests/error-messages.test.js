import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ERRORS, formatError } from '../lib/error-messages.js';

describe('ERRORS registry', () => {
  const EXPECTED_KEYS = [
    'auth-not-configured',
    'auth-login-failed',
    'token-expired',
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

describe('formatError', () => {
  it('returns a string with Error:, Fix:, and Hint: lines', () => {
    const out = formatError('auth-not-configured');
    assert.match(out, /^Error:/m);
    assert.match(out, /Fix:/m);
    assert.match(out, /Hint:/m);
  });

  it('embeds the reason for auth-not-configured', () => {
    const out = formatError('auth-not-configured');
    assert.ok(out.includes('credentials are not configured'), out);
  });

  it('fix for token-expired contains logout && login', () => {
    const out = formatError('token-expired');
    assert.ok(out.includes('auth logout'), out);
    assert.ok(out.includes('auth login'), out);
  });

  it('throws for unknown key', () => {
    assert.throws(() => formatError('no-such-key'), /unknown error key/);
  });
});
