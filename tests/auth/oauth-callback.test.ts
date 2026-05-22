import { describe, it, expect } from 'vitest';
import { bindCallbackServer } from '../../src/auth/oauth-callback.js';

async function get(port: number, path: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  return { status: res.status, body, headers };
}

// Use port 0 so the OS assigns a random free port — avoids conflicts in concurrent tests.
const RAND = 0;

describe('bindCallbackServer — routing', () => {
  it('returns 404 for paths other than /callback', async () => {
    const handle = await bindCallbackServer('state-x', 30_000, RAND);
    const waitP = handle.wait().catch(() => {});
    const resp = await get(handle.port, '/');
    expect(resp.status).toBe(404);
    await get(handle.port, '/callback?error=abort');
    await waitP;
  });
});

describe('bindCallbackServer — security headers', () => {
  it('sends X-Content-Type-Options and X-Frame-Options on all responses', async () => {
    const handle = await bindCallbackServer('hdr-state', 30_000, RAND);
    const waitP = handle.wait().catch(() => {});
    const resp = await get(handle.port, '/callback?error=test');
    expect(resp.headers['x-content-type-options']).toBe('nosniff');
    expect(resp.headers['x-frame-options']).toBe('DENY');
    await waitP;
  });
});

describe('bindCallbackServer — OAuth error param', () => {
  it('returns 400 and rejects wait() with the error', async () => {
    const handle = await bindCallbackServer('state-err', 30_000, RAND);
    const waitP = handle.wait();
    void waitP.catch(() => {}); // prevent unhandled rejection
    const resp = await get(handle.port, '/callback?error=access_denied&error_description=User+denied');
    expect(resp.status).toBe(400);
    await expect(waitP).rejects.toThrow('access_denied');
  });

  it('HTML-escapes error_description to prevent XSS', async () => {
    const handle = await bindCallbackServer('xss-state', 30_000, RAND);
    const waitP = handle.wait().catch(() => {});
    const payload = encodeURIComponent('<script>alert(1)</script>');
    const resp = await get(handle.port, `/callback?error=e&error_description=${payload}`);
    expect(resp.body).not.toContain('<script>');
    expect(resp.body).toContain('&lt;script&gt;');
    await waitP;
  });
});

describe('bindCallbackServer — state mismatch', () => {
  it('returns 400 and rejects wait() on wrong state', async () => {
    const handle = await bindCallbackServer('correct', 30_000, RAND);
    const waitP = handle.wait();
    void waitP.catch(() => {}); // prevent unhandled rejection
    const resp = await get(handle.port, '/callback?code=abc&state=wrong');
    expect(resp.status).toBe(400);
    expect(resp.body).toContain('State mismatch');
    await expect(waitP).rejects.toThrow('state mismatch');
  });
});

describe('bindCallbackServer — missing code', () => {
  it('returns 400 and rejects when code is absent', async () => {
    const handle = await bindCallbackServer('nc-state', 30_000, RAND);
    const waitP = handle.wait();
    void waitP.catch(() => {}); // prevent unhandled rejection
    await get(handle.port, '/callback?state=nc-state');
    await expect(waitP).rejects.toThrow('Missing authorization code');
  });
});

describe('bindCallbackServer — happy path', () => {
  it('returns 200 and resolves wait() with the authorization code', async () => {
    const handle = await bindCallbackServer('good', 30_000, RAND);
    const resp = await get(handle.port, '/callback?code=my-code&state=good');
    expect(resp.status).toBe(200);
    expect(resp.body).toContain('Login successful');
    const result = await handle.wait();
    expect(result.code).toBe('my-code');
  });
});

describe('bindCallbackServer — timeout', () => {
  it('rejects wait() after timeoutMs', async () => {
    const handle = await bindCallbackServer('timeout-state', 30, RAND);
    await expect(handle.wait()).rejects.toThrow('Login timed out');
  });
});

describe('bindCallbackServer — double-close guard', () => {
  it('does not throw ERR_SERVER_NOT_RUNNING when callback and timer race', async () => {
    const handle = await bindCallbackServer('race', 50, RAND);
    const fetchP = get(handle.port, '/callback?code=c&state=race').catch(() => null);
    await expect(Promise.all([handle.wait().catch(e => e), fetchP])).resolves.toBeDefined();
  });
});
