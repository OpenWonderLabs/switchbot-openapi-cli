import { describe, it, expect, afterEach } from 'vitest';
import { isSensitiveHeader, maskValue, redactHeaders } from '../../src/utils/redact.js';

const savedArgv = [...process.argv];
afterEach(() => {
  process.argv = [...savedArgv];
});

describe('redact utilities (C6)', () => {
  it('recognises the SwitchBot HMAC headers as sensitive', () => {
    expect(isSensitiveHeader('Authorization')).toBe(true);
    expect(isSensitiveHeader('authorization')).toBe(true);
    expect(isSensitiveHeader('sign')).toBe(true);
    expect(isSensitiveHeader('t')).toBe(true);
    expect(isSensitiveHeader('nonce')).toBe(true);
    expect(isSensitiveHeader('token')).toBe(true);
    expect(isSensitiveHeader('Content-Type')).toBe(false);
  });

  it('maskValue keeps 2 chars on each side', () => {
    expect(maskValue('abcdefgh')).toBe('ab****gh');
    expect(maskValue('12345678901234567890')).toMatch(/^12\*+90$/);
    expect(maskValue('abc')).toBe('****');
  });

  it('redactHeaders masks sensitive entries and leaves others intact', () => {
    const { safe, redactedCount } = redactHeaders({
      Authorization: 'fake-token-abcdefghij',
      sign: 'SIGNATUREABCDEFGH',
      'Content-Type': 'application/json',
      'content-length': '42',
    });
    expect(redactedCount).toBe(2);
    expect(safe.Authorization).not.toBe('fake-token-abcdefghij');
    expect(safe.Authorization.startsWith('fa')).toBe(true);
    expect(safe.sign).not.toBe('SIGNATUREABCDEFGH');
    expect(safe['Content-Type']).toBe('application/json');
    expect(safe['content-length']).toBe('42');
  });

  it('--trace-unsafe disables redaction', () => {
    process.argv = [...savedArgv, '--trace-unsafe'];
    const { safe, redactedCount } = redactHeaders({
      Authorization: 'fake-token-abcdefghij',
    });
    expect(redactedCount).toBe(0);
    expect(safe.Authorization).toBe('fake-token-abcdefghij');
  });
});
