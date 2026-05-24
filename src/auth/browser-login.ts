import { existsSync } from 'fs';
import open from 'open';
import { generateState } from './csrf.js';
import { bindCallbackServer } from './oauth-callback.js';
import { exchangeCodeForCredentials } from './token-exchange.js';
import { SP_OAUTH_LOGIN_URL, OAUTH_CLIENT_ID, OAUTH_SCOPE, LOGIN_TIMEOUT_MS } from './constants.js';
import type { CredentialBundle } from '../credentials/keychain.js';

export interface BrowserLoginOptions {
  /** When true, print the login URL instead of opening the browser. */
  noOpen?: boolean;
  /** Override the default timeout in milliseconds. */
  timeoutMs?: number;
  /** Status message sink (defaults to console.log). */
  log?: (msg: string) => void;
}

/**
 * Browser-based login flow.
 *
 *   1. Bind a one-shot local callback server.
 *   2. Open sp.oauth.switchbot.net/login with client_id, redirect_uri, state.
 *   3. User logs in (email/password or social — all handled by the hosted page).
 *   4. Hosted page redirects back with code → exchange for credentials.
 */
export async function browserLogin(options: BrowserLoginOptions = {}): Promise<CredentialBundle> {
  const {
    noOpen = false,
    timeoutMs = LOGIN_TIMEOUT_MS,
    log = console.log,
  } = options;

  const state = generateState();
  const { port, wait, close } = await bindCallbackServer(state, timeoutMs);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const loginUrl = buildLoginUrl({ redirectUri, state });

  if (noOpen) {
    log(`Open this URL in your browser to sign in:\n\n  ${loginUrl}\n`);
  } else {
    log('Opening SwitchBot login page in your browser…');
    const opened = await tryOpenBrowser(loginUrl);
    if (!opened) {
      const isWsl = process.platform === 'linux' && process.env['WSL_DISTRO_NAME'] !== undefined;
      const hint = isWsl ? ' (WSL detected — open the URL in your Windows browser)' : '';
      log(`Could not open browser automatically${hint}. Open this URL in your browser to sign in:\n\n  ${loginUrl}\n`);
    }
  }

  log('Waiting for browser login to complete…');
  const deadline = Date.now() + timeoutMs;
  const countdown = startCountdown(deadline);
  try {
    const { code } = await wait();
    countdown.stop();
    log('Exchanging authorization code for credentials…');
    return exchangeCodeForCredentials(code, redirectUri);
  } catch (err) {
    countdown.stop();
    close();
    throw err;
  }
}

function buildLoginUrl(params: { redirectUri: string; state: string }): string {
  const url = new URL(SP_OAUTH_LOGIN_URL);
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  return url.toString();
}

// open v10 spawns PowerShell (via wsl-utils) when running inside WSL, but attaches
// an error handler only when wait:true. With the default wait:false, ENOENT fires
// via process.nextTick — before the returned Promise resolves — so no try/catch
// around `await open()` can intercept it and the process crashes. Pre-check the
// executable path in WSL to avoid the unhandled 'error' event entirely.
async function tryOpenBrowser(url: string): Promise<boolean> {
  if (process.platform === 'linux' && process.env['WSL_DISTRO_NAME'] !== undefined) {
    // WSL: open delegates to PowerShell via wsl-utils. Check the default Windows
    // mount path; if missing, fall back to printing the URL rather than crashing.
    // Known limitation: non-default root= mounts in /etc/wsl.conf are not checked —
    // if PS lives elsewhere open() will still be skipped here.
    const wslPsPath = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    if (!existsSync(wslPsPath)) return false;
  }
  try {
    await open(url);
    return true;
  } catch {
    return false;
  }
}

function startCountdown(deadline: number): { stop(): void } {
  if (!process.stderr.isTTY) return { stop() {} };

  const write = (s: string) => process.stderr.write(s);
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    write(`\r  ${remaining}s remaining…   `);
  };

  tick();
  const id = setInterval(tick, 1000);

  return {
    stop() {
      clearInterval(id);
      write('\r\x1b[K'); // erase countdown line
    },
  };
}
