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
  const { port, wait } = await bindCallbackServer(state, timeoutMs);
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const loginUrl = buildLoginUrl({ redirectUri, state });

  if (noOpen) {
    log(`Open this URL in your browser to sign in:\n\n  ${loginUrl}\n`);
  } else {
    log('Opening SwitchBot login page in your browser…');
    await open(loginUrl);
  }

  log('Waiting for browser login to complete…');
  const { code } = await wait();
  log('Exchanging authorization code for credentials…');
  return exchangeCodeForCredentials(code, redirectUri);
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
