import { describe, it, expect, vi, beforeEach } from 'vitest';

import { browserLogin } from '../../src/auth/browser-login.js';
import { SP_OAUTH_LOGIN_URL, OAUTH_CLIENT_ID, OAUTH_SCOPE } from '../../src/auth/constants.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const waitMock    = vi.fn();
const bindMock    = vi.fn();
const exchangeMock = vi.fn();
const openMock    = vi.fn();

vi.mock('../../src/auth/csrf.js', () => ({
  generateState: () => 'fixed-test-state',
}));

vi.mock('../../src/auth/oauth-callback.js', () => ({
  bindCallbackServer: (...args: unknown[]) => bindMock(...args),
}));

vi.mock('../../src/auth/token-exchange.js', () => ({
  exchangeCodeForCredentials: (...args: unknown[]) => exchangeMock(...args),
}));

vi.mock('open', () => ({
  default: (...args: unknown[]) => openMock(...args),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function captureLog(): { log: (m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (m) => lines.push(m), lines };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('browserLogin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bindMock.mockResolvedValue({ port: 53245, wait: waitMock });
    exchangeMock.mockResolvedValue({ token: 'tok', secret: 'sec' });
  });

  it('constructs login URL with correct client_id, scope, state, response_type, and redirect_uri', async () => {
    waitMock.mockResolvedValue({ code: 'code-1' });
    const { log, lines } = captureLog();
    await browserLogin({ noOpen: true, log });

    const urlMatch = lines.join('\n').match(/https?:\/\/\S+/);
    expect(urlMatch).not.toBeNull();
    const url = new URL(urlMatch![0]);
    expect(url.origin + url.pathname).toBe(SP_OAUTH_LOGIN_URL);
    expect(url.searchParams.get('client_id')).toBe(OAUTH_CLIENT_ID);
    expect(url.searchParams.get('scope')).toBe(OAUTH_SCOPE);
    expect(url.searchParams.get('state')).toBe('fixed-test-state');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it('when noOpen is true: prints the URL and does not call open()', async () => {
    waitMock.mockResolvedValue({ code: 'code-1' });
    const { log, lines } = captureLog();
    await browserLogin({ noOpen: true, log });

    expect(openMock).not.toHaveBeenCalled();
    expect(lines.join('\n')).toContain(SP_OAUTH_LOGIN_URL);
  });

  it('when noOpen is false: calls open() with the login URL', async () => {
    waitMock.mockResolvedValue({ code: 'code-1' });
    await browserLogin({ noOpen: false, log: () => {} });

    expect(openMock).toHaveBeenCalledOnce();
    const openedUrl = openMock.mock.calls[0][0] as string;
    expect(openedUrl).toContain(SP_OAUTH_LOGIN_URL);
    expect(openedUrl).toContain(OAUTH_CLIENT_ID);
  });

  it('passes code and redirect URI to exchangeCodeForCredentials', async () => {
    waitMock.mockResolvedValue({ code: 'auth-code-xyz' });
    await browserLogin({ noOpen: true, log: () => {} });

    expect(exchangeMock).toHaveBeenCalledOnce();
    const [code, redirectUri] = exchangeMock.mock.calls[0] as [string, string];
    expect(code).toBe('auth-code-xyz');
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it('returns the credential bundle resolved by exchangeCodeForCredentials', async () => {
    waitMock.mockResolvedValue({ code: 'c' });
    exchangeMock.mockResolvedValue({ token: 'T-123', secret: 'S-456' });

    const result = await browserLogin({ noOpen: true, log: () => {} });
    expect(result).toEqual({ token: 'T-123', secret: 'S-456' });
  });

  it('propagates rejection from wait() without calling exchangeCodeForCredentials', async () => {
    waitMock.mockRejectedValue(new Error('Login timed out'));

    await expect(browserLogin({ noOpen: true, log: () => {} }))
      .rejects.toThrow('Login timed out');
    expect(exchangeMock).not.toHaveBeenCalled();
  });
});
