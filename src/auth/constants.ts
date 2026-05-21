/**
 * SwitchBot consumer app auth configuration.
 *
 * Email/password flow (customize-login page):
 *  1. POST ACCOUNT_API_BASE/account/api/v2/user/login → access_token
 *  2. POST WONDER_API_BASE/openapi/openUser/token { operation:"get", version:2 }
 *     → encrypted openToken + secretKey (AES-128-CBC, hex-encoded)
 *
 * Social OAuth fallback (directOAuth: true):
 *  1. Redirect user to OAUTH_AUTHORIZE_URL → Cognito login
 *  2. Exchange code at OAUTH_TOKEN_URL → access_token
 *  3. POST MOBILE_API_BASE/v2/mobile/management/login → plaintext openToken + secretKey
 */

/** Direct consumer account API (customize-login page). */
export const ACCOUNT_API_BASE = 'https://account.api.switchbot.net';

/** OAuth2 authorization endpoint (social login fallback). */
export const OAUTH_AUTHORIZE_URL = 'https://auth.switch-bot.com/oauth2/authorize';

/** OAuth2 token endpoint (AWS Cognito, social login fallback). */
export const OAUTH_TOKEN_URL = 'https://auth.switch-bot.com/oauth2/token';

/** OAuth2 scope required by social login fallback. */
export const OAUTH_SCOPE = 'openid';

/**
 * Client ID from config.js on www.switch-bot.com/pages/customize-login.
 * Used in the direct login request body (not as an OAuth client_id for localhost redirects).
 */
export const OAUTH_CLIENT_ID = 'emvg3hk2tqu3q37fcw6cwyl4bi';

/** Milliseconds the CLI waits for the user to complete browser login. */
export const LOGIN_TIMEOUT_MS = 120_000;

// ── Mobile management API (OAuth fallback — plaintext token) ─────────────────

export const MOBILE_API_BASE = 'https://wonderlabs.us.api.switchbot.net/homepage';

// ── Wonder OpenAPI (email/password flow — encrypted token) ───────────────────

export const WONDER_API_BASE = 'https://wonderlabs.us.api.switchbot.net/wonder';

/** AES-128-CBC key/IV for decrypting token + secretKey from openUser/token v2. */
export const TOKEN_AES_KEY = 'lrQ0OTvwp9RTsXxk';
export const TOKEN_AES_IV  = '4mdN27rI3bk2LzWa';

export const ENDPOINTS = {
  mobileLogin: '/v2/mobile/management/login',
  openUserToken: '/openapi/openUser/token',
} as const;
