import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const MOBILE_RESP_OK = {
  data: { statusCode: 100, body: { openToken: 'open-tok', secretKey: 'sec-key' } },
};

describe('exchangeCodeForCredentials — happy path', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValueOnce(TOKEN_RESP).mockResolvedValueOnce(MOBILE_RESP_OK);
  });

  it('returns { token, secret } on success', async () => {
    const result = await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:9000/callback');
    expect(result).toEqual({ token: 'open-tok', secret: 'sec-key' });
  });

  it('calls the token endpoint first with correct params', async () => {
    await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:9000/callback');
    const [url, body] = mockPost.mock.calls[0] as [string, Record<string, string>];
    expect(url).toContain('/merchant/v1/oauth/token');
    expect(body.grantType).toBe('authorization_code');
    expect(body.code).toBe('code-x');
    expect(body.redirectUri).toBe('http://127.0.0.1:9000/callback');
  });

  it('passes access_token as Authorization header to mobile endpoint', async () => {
    await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:9000/callback');
    const [url, , config] = mockPost.mock.calls[1] as [string, unknown, { headers: Record<string, string> }];
    expect(url).toContain('mobile/management/login');
    expect(config.headers['Authorization']).toBe('tok-abc');
  });

  it('accepts alternate field names token/secret in mobile response', async () => {
    mockPost.mockReset();
    mockPost
      .mockResolvedValueOnce(TOKEN_RESP)
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { token: 'alt-tok', secret: 'alt-sec' } } });
    const result = await exchangeCodeForCredentials('code-y', 'http://127.0.0.1:9000/callback');
    expect(result).toEqual({ token: 'alt-tok', secret: 'alt-sec' });
  });
});

describe('exchangeCodeForCredentials — token endpoint errors', () => {
  beforeEach(() => { mockPost.mockReset(); });

  it('throws with HTTP status when token endpoint returns 4xx', async () => {
    mockPost.mockRejectedValueOnce(makeAxiosError(400, { error: 'invalid_grant' }));
    await expect(exchangeCodeForCredentials('bad', 'http://127.0.0.1:9000/callback'))
      .rejects.toThrow('400');
  });

  it('throws when token response has no access_token', async () => {
    mockPost.mockResolvedValueOnce({ data: { token_type: 'Bearer' } });
    await expect(exchangeCodeForCredentials('code-z', 'http://127.0.0.1:9000/callback'))
      .rejects.toThrow('access_token');
  });

  it('re-throws non-axios errors', async () => {
    mockPost.mockRejectedValueOnce(new Error('network failure'));
    await expect(exchangeCodeForCredentials('code-z', 'http://127.0.0.1:9000/callback'))
      .rejects.toThrow('network failure');
  });
});

describe('exchangeCodeForCredentials — mobile endpoint errors', () => {
  beforeEach(() => { mockPost.mockReset(); });

  it('throws with HTTP status when mobile endpoint returns 5xx', async () => {
    mockPost
      .mockResolvedValueOnce(TOKEN_RESP)
      .mockRejectedValueOnce(makeAxiosError(503, {}));
    await expect(exchangeCodeForCredentials('code-x', 'http://127.0.0.1:9000/callback'))
      .rejects.toThrow('503');
  });

  it('throws when mobile response body is missing token fields', async () => {
    mockPost
      .mockResolvedValueOnce(TOKEN_RESP)
      .mockResolvedValueOnce({ data: { statusCode: 100, body: {} } });
    await expect(exchangeCodeForCredentials('code-x', 'http://127.0.0.1:9000/callback'))
      .rejects.toThrow();
  });
});
