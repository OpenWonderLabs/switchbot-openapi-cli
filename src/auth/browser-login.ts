import open from 'open';
import { generateState } from './pkce.js';
import { bindCallbackServer } from './oauth-callback.js';
import { bindLoginServer } from './local-login-server.js';
import { exchangeCodeForCredentials } from './token-exchange.js';
import { OAUTH_AUTHORIZE_URL, OAUTH_CLIENT_ID, OAUTH_SCOPE, LOGIN_TIMEOUT_MS } from './constants.js';
import type { CredentialBundle } from '../credentials/keychain.js';

export interface BrowserLoginOptions {
  /** When true, print the login URL instead of opening the browser. */
  noOpen?: boolean;
  /** Override the default timeout in milliseconds. */
  timeoutMs?: number;
  /** Status message sink (defaults to console.log). */
  log?: (msg: string) => void;
  /**
   * When true, skip the custom local login page and open SwitchBot's
   * OAuth authorize URL directly (original flow, useful for debugging).
   */
  directOAuth?: boolean;
}

/**
 * Browser-based login flow.
 *
 * Default path — custom local login page:
 *   1. Start a local HTTP server that serves web/login.html.
 *   2. Open browser to http://127.0.0.1:<port>/ (custom SwitchBot-style UI).
 *   3. User logs in (email/password or social OAuth via Cognito).
 *   4. Server receives the OAuth callback and exchanges code for credentials.
 *
 * Fallback path (directOAuth: true) — original Cognito redirect:
 *   1. Generate PKCE state.
 *   2. Bind a one-shot callback server.
 *   3. Open SwitchBot's authorize URL directly.
 *   4. Await callback → exchange code for credentials.
 */
export async function browserLogin(options: BrowserLoginOptions = {}): Promise<CredentialBundle> {
  const {
    noOpen = false,
    timeoutMs = LOGIN_TIMEOUT_MS,
    log = console.log,
    directOAuth = false,
  } = options;

  if (directOAuth) {
    return browserLoginDirect({ noOpen, timeoutMs, log });
  }

  // ── Custom local login page ─────────────────────────────────────────────
  const { port, wait } = await bindLoginServer(timeoutMs);
  const loginUrl = `http://127.0.0.1:${port}/`;

  if (noOpen) {
    log(`Open this URL in your browser to sign in:\n\n  ${loginUrl}\n`);
  } else {
    log('Opening SwitchBot login page in your browser…');
    await open(loginUrl);
  }

  log('Waiting for browser login to complete…');
  return wait();
}

/** Original direct-OAuth fallback (opens auth.switch-bot.com authorize URL). */
async function browserLoginDirect(
  options: Required<Pick<BrowserLoginOptions, 'noOpen' | 'timeoutMs' | 'log'>>,
): Promise<CredentialBundle> {
  const { noOpen, timeoutMs, log } = options;
  const state = generateState();
  const { port, wait } = await bindCallbackServer(state, timeoutMs);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorizeUrl = buildAuthorizeUrl({ redirectUri, state });

  if (noOpen) {
    log(`Open this URL in your browser to sign in:\n\n  ${authorizeUrl}\n`);
  } else {
    log('Opening SwitchBot login page in your browser…');
    await open(authorizeUrl);
  }

  log('Waiting for browser login to complete…');
  const { code } = await wait();
  log('Exchanging authorization code for credentials…');
  return exchangeCodeForCredentials(code, redirectUri);
}

function buildAuthorizeUrl(params: { redirectUri: string; state: string }): string {
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', OAUTH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', OAUTH_SCOPE);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  return url.toString();
}
