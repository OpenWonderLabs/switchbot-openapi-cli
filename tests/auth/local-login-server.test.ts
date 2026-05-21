import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPost = vi.hoisted(() => vi.fn());
vi.mock('axios', () => ({ default: { post: mockPost } }));

// Stub fs.readFileSync for login.html so tests don't depend on src/auth/web/login.html.
// The test-time __dirname resolves to src/auth/, not dist/auth/, so the real web asset
// lives at dist/web/login.html — unavailable without a build. Return a minimal stub
// that preserves the </head> tag so config injection still works.
vi.mock('node:fs', async (importOriginal) => {
  const realFs = await importOriginal<typeof import('node:fs')>();
  const stub = '<!DOCTYPE html><html><head></head><body></body></html>';
  const patchedReadFileSync = (p: unknown, ...args: unknown[]) => {
    if (typeof p === 'string' && p.endsWith('login.html')) return stub;
    return (realFs.readFileSync as (...a: unknown[]) => unknown)(p, ...args);
  };
  return {
    ...realFs,
    default: { ...realFs.default, readFileSync: patchedReadFileSync },
    readFileSync: patchedReadFileSync,
  };
});

import { bindLoginServer } from '../../src/auth/local-login-server.js';

async function get(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, body, headers };
}

async function postJson(port: number, path: string, data: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  const body = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(body); } catch { /* not JSON */ }
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, body, json, headers };
}

async function drain(handle: Awaited<ReturnType<typeof bindLoginServer>>) {
  const p = handle.wait().catch(() => {});
  await get(handle.port, '/callback?error=abort').catch(() => {});
  await p;
}

describe('bindLoginServer — GET /', () => {
  it('serves login HTML with injected __SWITCHBOT_LOGIN_CONFIG__', async () => {
    const handle = await bindLoginServer(30_000);
    const resp = await get(handle.port, '/');
    expect(resp.status).toBe(200);
    expect(resp.body).toContain('__SWITCHBOT_LOGIN_CONFIG__');
    expect(resp.body).toContain('"callbackBase"');
    expect(resp.headers['x-content-type-options']).toBe('nosniff');
    expect(resp.headers['x-frame-options']).toBe('DENY');
    await drain(handle);
  });
});

describe('bindLoginServer — GET /done', () => {
  it('returns 200 success page', async () => {
    const handle = await bindLoginServer(30_000);
    const resp = await get(handle.port, '/done');
    expect(resp.status).toBe(200);
    expect(resp.body).toContain('Login Successful');
    await drain(handle);
  });
});

describe('bindLoginServer — GET /callback state mismatch', () => {
  it('returns 400 and rejects wait() on wrong state', async () => {
    const handle = await bindLoginServer(30_000);
    const waitP = handle.wait();
    void waitP.catch(() => {});
    const resp = await get(handle.port, '/callback?code=abc&state=WRONG');
    expect(resp.status).toBe(400);
    expect(resp.body).toContain('State mismatch');
    await expect(waitP).rejects.toThrow('state mismatch');
  });
});

describe('bindLoginServer — GET /callback OAuth error', () => {
  it('returns 400 and rejects wait()', async () => {
    const handle = await bindLoginServer(30_000);
    const waitP = handle.wait();
    void waitP.catch(() => {});
    const resp = await get(handle.port, '/callback?error=access_denied');
    expect(resp.status).toBe(400);
    await expect(waitP).rejects.toThrow('access_denied');
  });

  it('HTML-escapes the error string', async () => {
    const handle = await bindLoginServer(30_000);
    const waitP = handle.wait().catch(() => {});
    const payload = encodeURIComponent('<script>xss</script>');
    const resp = await get(handle.port, `/callback?error=${payload}`);
    expect(resp.body).not.toContain('<script>');
    expect(resp.body).toContain('&lt;script&gt;');
    await waitP;
  });
});

describe('bindLoginServer — 404 fallthrough', () => {
  it('returns 404 with security headers for unknown routes', async () => {
    const handle = await bindLoginServer(30_000);
    const resp = await get(handle.port, '/unknown-path');
    expect(resp.status).toBe(404);
    expect(resp.headers['x-content-type-options']).toBe('nosniff');
    await drain(handle);
  });
});

describe('bindLoginServer — POST /auth/email body size cap', () => {
  it('returns 413 when body exceeds 4 KB', async () => {
    const handle = await bindLoginServer(30_000);
    const bigBody = JSON.stringify({ email: 'a@b.com', password: 'x'.repeat(5000) });
    const res = await fetch(`http://127.0.0.1:${handle.port}/auth/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bigBody,
    });
    expect(res.status).toBe(413);
    await drain(handle);
  });
});

describe('bindLoginServer — POST /auth/email invalid JSON', () => {
  it('returns 400 for malformed body', async () => {
    const handle = await bindLoginServer(30_000);
    const res = await fetch(`http://127.0.0.1:${handle.port}/auth/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'NOT JSON',
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { success: boolean };
    expect(data.success).toBe(false);
    await drain(handle);
  });
});

describe('bindLoginServer — POST /auth/email happy path', () => {
  // AES-128-CBC encrypted values for 'open-tok' and 'sec-key' using the
  // hardcoded key/IV from constants.ts (lrQ0OTvwp9RTsXxk / 4mdN27rI3bk2LzWa).
  // decryptField returns the plaintext re-encoded as hex, so expected token/secret
  // are the hex representations of the original plaintext strings.
  const ENC_TOKEN  = '4939095e1119e02b75f3f13627738d5d'; // AES-CBC('open-tok')
  const ENC_SECRET = 'fcbfccf31f48f07675f4d4a3f6a3add2'; // AES-CBC('sec-key')
  const DEC_TOKEN  = '6f70656e2d746f6b';                  // hex('open-tok')
  const DEC_SECRET = '7365632d6b6579';                    // hex('sec-key')

  beforeEach(() => {
    mockPost.mockReset();
    mockPost
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { access_token: 'tok' } } })           // login
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { botRegion: 'eu' } } })               // userinfo
      .mockResolvedValueOnce({ data: { body: { token: ENC_TOKEN, secretKey: ENC_SECRET } } });       // openUserToken
  });

  it('returns 200 {success:true} and resolves wait() with credentials', async () => {
    const handle = await bindLoginServer(30_000);
    const resp = await postJson(handle.port, '/auth/email', { email: 'a@b.com', password: 'pw' });
    expect(resp.status).toBe(200);
    expect((resp.json as { success: boolean }).success).toBe(true);
    const creds = await handle.wait();
    expect(creds).toEqual({ token: DEC_TOKEN, secret: DEC_SECRET });
  });
});

describe('bindLoginServer — POST /auth/email login failure', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockPost.mockResolvedValueOnce({ data: { statusCode: 401, message: 'Invalid credentials' } });
  });

  it('returns 401 without closing the server', async () => {
    const handle = await bindLoginServer(30_000);
    const resp = await postJson(handle.port, '/auth/email', { email: 'bad@b.com', password: 'x' });
    expect(resp.status).toBe(401);
    expect((resp.json as { success: boolean }).success).toBe(false);
    await drain(handle);
  });
});

describe('bindLoginServer — botRegion validation', () => {
  const ENC_TOKEN  = '4939095e1119e02b75f3f13627738d5d';
  const ENC_SECRET = 'fcbfccf31f48f07675f4d4a3f6a3add2';

  beforeEach(() => {
    mockPost.mockReset();
    mockPost
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { access_token: 'tok' } } })
      .mockResolvedValueOnce({ data: { statusCode: 100, body: { botRegion: '../../evil' } } })
      .mockResolvedValueOnce({ data: { body: { token: ENC_TOKEN, secretKey: ENC_SECRET } } });
  });

  it('falls back to "us" region when botRegion contains path-traversal characters', async () => {
    const handle = await bindLoginServer(30_000);
    const waitP = handle.wait().catch(() => {});
    await postJson(handle.port, '/auth/email', { email: 'a@b.com', password: 'pw' });
    await waitP;
    const thirdCallUrl = mockPost.mock.calls[2][0] as string;
    expect(thirdCallUrl).not.toContain('evil');
    expect(thirdCallUrl).toContain('.us.api');
  });
});

describe('bindLoginServer — timeout', () => {
  it('rejects wait() after timeoutMs', async () => {
    const handle = await bindLoginServer(30);
    await expect(handle.wait()).rejects.toThrow('Login timed out');
  });
});

describe('bindLoginServer — double-close guard', () => {
  it('does not throw ERR_SERVER_NOT_RUNNING when finish() is called twice', async () => {
    const handle = await bindLoginServer(20);
    const fetchP = get(handle.port, '/callback?error=race').catch(() => null);
    const [result] = await Promise.all([handle.wait().catch((e: unknown) => e), fetchP]);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).not.toContain('ERR_SERVER_NOT_RUNNING');
  });
});
