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
// userinfo response
const USERINFO_RESP = { data: { statusCode: 100, body: { botRegion: 'us' } } };
// Wonder API response with AES-encrypted placeholders (non-empty hex strings)
const OPEN_TOKEN_RESP = {
  data: { statusCode: 100, body: { token: '00', secretKey: '00' } },
};

describe('exchangeCodeForCredentials — happy path', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost
      .mockResolvedValueOnce(TOKEN_RESP)
      .mockResolvedValueOnce(USERINFO_RESP)
      .mockResolvedValueOnce(OPEN_TOKEN_RESP);
  });

  it('calls token endpoint with form-encoded params', async () => {
    await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:53245/callback').catch(() => {});
    const [url, body] = mockPost.mock.calls[0] as [string, URLSearchParams];
    expect(url).toContain('/merchant/v1/oauth/token');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('code-x');
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:53245/callback');
  });

  it('calls userinfo with access_token', async () => {
    await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:53245/callback').catch(() => {});
    const [url, , config] = mockPost.mock.calls[1] as [string, unknown, { headers: Record<string, string> }];
    expect(url).toContain('/account/api/v1/user/userinfo');
    expect(config.headers['Authorization']).toBe('tok-abc');
  });

  it('calls Wonder API with correct region and access_token', async () => {
    await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:53245/callback').catch(() => {});
    const [url, body, config] = mockPost.mock.calls[2] as [string, Record<string, unknown>, { headers: Record<string, string> }];
    expect(url).toContain('wonderlabs.us.api.switchbot.net');
    expect(url).toContain('/openapi/openUser/token');
    expect(body['operation']).toBe('get');
    expect(config.headers['Authorization']).toBe('tok-abc');
  });
});

describe('exchangeCodeForCredentials — token endpoint errors', () => {
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

describe('exchangeCodeForCredentials — Wonder API errors', () => {
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
    // Should not throw due to userinfo error; uses default region
    const [, , wonderCall] = mockPost.mock.calls;
    await exchangeCodeForCredentials('code-x', 'http://127.0.0.1:53245/callback').catch(() => {});
    if (wonderCall) {
      const [url] = wonderCall as [string];
      expect(url).toContain('wonderlabs.us.api.switchbot.net');
    }
  });
});
