import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';

// Must match TOKEN_AES_KEY / TOKEN_AES_IV in src/auth/constants.ts
const AES_KEY = Buffer.from('lrQ0OTvwp9RTsXxk', 'utf8');
const AES_IV  = Buffer.from('4mdN27rI3bk2LzWa', 'utf8');

// ── Fixture design ────────────────────────────────────────────────────────────
//
// The SwitchBot Wonder API stores credentials as raw binary bytes, not as
// human-readable strings.  It AES-128-CBC-encrypts those binary bytes and
// returns the ciphertext hex-encoded in the openUser/token response.
//
// `decryptField` therefore decrypts the ciphertext and calls .toString('hex')
// to produce a stable, header-safe hex representation of the binary payload.
// Using .toString('utf8') here was incorrect: it produced garbled output when
// the plaintext bytes fell outside printable ASCII, which caused HTTP header
// validation errors ("invalid header characters" bug).
//
// IMPORTANT: Do NOT change encryptField below to encrypt a UTF-8 string and
// expect it back as a string — that model does not match the real API.  The
// fixture intentionally uses fixed binary buffers so that the tests mirror the
// actual Wonder API encoding contract.

/** Fixed 48-byte binary token payload (matches real token length after decryption). */
const FIXTURE_TOKEN_BIN  = Buffer.from(
  'b1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' +
  'f7e8d9ca0b1c2d3e4f5a6b7c8d9e0f1a' ,
  'hex',
); // 48 raw bytes → 96-char hex string (matches observed live token length)

/** Fixed 16-byte binary secret payload. */
const FIXTURE_SECRET_BIN = Buffer.from('8cabcdef12345678fedcba9876543210', 'hex'); // 16 raw bytes → 32-char hex

/** What decryptField must return: hex representation of the binary payload. */
const FIXTURE_TOKEN  = FIXTURE_TOKEN_BIN.toString('hex');   // 96 chars
const FIXTURE_SECRET = FIXTURE_SECRET_BIN.toString('hex');  // 32 chars

/**
 * Mirrors the Wonder API server-side encryption:
 * AES-128-CBC encrypt raw binary bytes → return hex-encoded ciphertext.
 */
function encryptField(rawBytes: Buffer): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
  return Buffer.concat([cipher.update(rawBytes), cipher.final()]).toString('hex');
}

const mockPost = vi.hoisted(() => vi.fn());

vi.mock('axios', () => {
  const isAxiosError = (err: unknown): boolean =>
    typeof err === 'object' && err !== null && '__isAxiosError' in err;
  return {
    default: { post: mockPost, isAxiosError },
    isAxiosError,
  };
});

import { exchangeCodeForCredentials } from '../../src/auth/token-exchange.js';

function makeAxiosError(status: number, data: unknown) {
  return Object.assign(new Error(`HTTP ${status}`), {
    __isAxiosError: true,
    response: { status, data },
  });
}

const TOKEN_RESP = { data: { access_token: 'tok-abc', token_type: 'Bearer' } };
const USERINFO_RESP = { data: { statusCode: 100, body: { botRegion: 'us' } } };
// Wonder API response: binary credential bytes AES-encrypted, ciphertext hex-encoded
const OPEN_TOKEN_RESP = {
  data: {
    statusCode: 100,
    body: {
      token:     encryptField(FIXTURE_TOKEN_BIN),
      secretKey: encryptField(FIXTURE_SECRET_BIN),
    },
  },
};

describe("exchangeCodeForCredentials — happy path", () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost
      .mockResolvedValueOnce(TOKEN_RESP)
      .mockResolvedValueOnce(USERINFO_RESP)
      .mockResolvedValueOnce(OPEN_TOKEN_RESP);
  });

  it('calls token endpoint with form-encoded params', async () => {
    await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:53245/callback');
    const [url, body] = mockPost.mock.calls[0] as [string, URLSearchParams];
    expect(url).toContain('/merchant/v1/oauth/token');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-x');
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:53245/callback');
  });

  it('calls userinfo with access_token', async () => {
    await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:53245/callback');
    const [url, , config] = mockPost.mock.calls[1] as [string, unknown, { headers: Record<string, string> }];
    expect(url).toContain('/account/api/v1/user/userinfo');
    expect(config.headers['Authorization']).toBe('tok-abc');
  });

  it('calls Wonder API with correct region and access_token', async () => {
    await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:53245/callback');
    const [url, body, config] = mockPost.mock.calls[2] as [string, Record<string, unknown>, { headers: Record<string, string> }];
    expect(url).toContain('wonderlabs.us.api.switchbot.net');
    expect(url).toContain('/openapi/openUser/token');
    expect(body['operation']).toBe('get');
    expect(config.headers['Authorization']).toBe('tok-abc');
  });
});

describe("exchangeCodeForCredentials — token endpoint errors", () => {
  beforeEach(() => { mockPost.mockReset(); });

  it('throws with HTTP status when token endpoint returns 4xx', async () => {
    mockPost.mockRejectedValueOnce(makeAxiosError(400, { error: 'invalid_grant' }));
    await expect(exchangeCodeForCredentials('bad', 'http://127.0.0.1:53245/callback'))
      .rejects.toThrow('400');
  });

  it('throws when token response has no access_token', async () => {
    mockPost.mockResolvedValueOnce({ data: { token_type: 'Bearer' } });
    await expect(exchangeCodeForCredentials('code-z', 'http://127.0.0.1:53245/callback'))
      .rejects.toThrow('access_token');
  });

  it('re-throws non-axios errors', async () => {
    mockPost.mockRejectedValueOnce(new Error('network failure'));
    await expect(exchangeCodeForCredentials('code-z', 'http://127.0.0.1:53245/callback'))
      .rejects.toThrow('network failure');
  });
});

describe("exchangeCodeForCredentials — Wonder API errors", () => {
  beforeEach(() => { mockPost.mockReset(); });

  it('throws with HTTP status when Wonder API returns 5xx', async () => {
    mockPost
      .mockResolvedValueOnce(TOKEN_RESP)
      .mockResolvedValueOnce(USERINFO_RESP)
      .mockRejectedValueOnce(makeAxiosError(503, {}));
    await expect(exchangeCodeForCredentials('code-x', 'http://127.0.0.1:53245/callback'))
      .rejects.toThrow('503');
  });

  it('throws when Wonder API response body is missing token fields', async () => {
    mockPost
      .mockResolvedValueOnce(TOKEN_RESP)
      .mockResolvedValueOnce(USERINFO_RESP)
      .mockResolvedValueOnce({ data: { statusCode: 100, body: {} } });
    await expect(exchangeCodeForCredentials('code-x', 'http://127.0.0.1:53245/callback'))
      .rejects.toThrow();
  });

  it('falls back to default region when userinfo fails', async () => {
    mockPost
      .mockResolvedValueOnce(TOKEN_RESP)
      .mockRejectedValueOnce(new Error('userinfo network error'))
      .mockResolvedValueOnce(OPEN_TOKEN_RESP);
    await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:53245/callback');
    const [, , wonderCall] = mockPost.mock.calls;
    expect(wonderCall).toBeDefined();
    const [url] = wonderCall as [string];
    expect(url).toContain('wonderlabs.us.api.switchbot.net');
  });
});

describe("exchangeCodeForCredentials — decrypts Wonder API binary payload as hex", () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost
      .mockResolvedValueOnce(TOKEN_RESP)
      .mockResolvedValueOnce(USERINFO_RESP)
      .mockResolvedValueOnce(OPEN_TOKEN_RESP);
  });

  it('returns binary credential bytes as hex strings (96-char token, 32-char secret)', async () => {
    const res = await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:53245/callback');
    // Hex strings: only [0-9a-f], no whitespace or non-ASCII that would break HTTP headers
    expect(res.token).toBe(FIXTURE_TOKEN);
    expect(res.secret).toBe(FIXTURE_SECRET);
    expect(res.token).toMatch(/^[0-9a-f]+$/);
    expect(res.secret).toMatch(/^[0-9a-f]+$/);
  });

  it('token and secret lengths match hex-encoded binary payload', async () => {
    const res = await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:53245/callback');
    expect(res.token.length).toBe(FIXTURE_TOKEN_BIN.length * 2);
    expect(res.secret.length).toBe(FIXTURE_SECRET_BIN.length * 2);
  });
});
