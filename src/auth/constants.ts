/**
 * SwitchBot consumer app auth configuration.
 *
 * Email/password flow (customize-login page):
 *  1. POST ACCOUNT_API_BASE/account/api/v2/user/login → access_token
 *  2. POST WONDER_API_BASE/openapi/openUser/token { operation:"get", version:2 }
 *     → encrypted openToken + secretKey (AES-128-CBC, hex-encoded)
 *
 * Browser OAuth flow (sp.oauth.switchbot.net):
 *  1. Open SP_OAUTH_LOGIN_URL with client_id, redirect_uri, scope, state → user logs in
 *  2. SPA redirects back with code
 *  3. POST ACCOUNT_API_BASE/merchant/v1/oauth/token → access_token
 *  4. POST MOBILE_API_BASE/v2/mobile/management/login → plaintext openToken + secretKey
 */

/** Direct consumer account API (customize-login page). */
export const ACCOUNT_API_BASE = 'https://account.api.switchbot.net';

/** SwitchBot hosted OAuth login page. */
export const SP_OAUTH_LOGIN_URL = 'https://sp.oauth.switchbot.net/login';

/** OAuth2 scope required by browser login. */
export const OAUTH_SCOPE = 'api_login';

/**
 * Consumer app client ID (from customize-login page).
 * Used in the email/password login request body sent to account API.
 */
export const ACCOUNT_CLIENT_ID = 'emvg3hk2tqu3q37fcw6cwyl4bi';

/**
 * Merchant OAuth2 client registered with sp.oauth.switchbot.net.
 * Used as client_id when opening the hosted login page and exchanging codes.
 */
export const OAUTH_CLIENT_ID = 'wrZlijGQevZHVyGeINSQGUVEHw';
export const OAUTH_CLIENT_SECRET = 'aFDbbDdGiUSGCgRbCvAHpMNokcQDnIDbDhaVYbWWpRaZxuuwugR';

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
  userInfo: '/account/api/v1/user/userinfo',
  oauthToken: '/merchant/v1/oauth/token',
} as const;

/** Allowlist of known bot-region labels returned by /account/api/v1/user/userinfo. */
export const KNOWN_BOT_REGIONS = new Set(['us', 'eu', 'as']);

/** Fallback region when the returned botRegion value is absent or unknown. */
export const DEFAULT_BOT_REGION = 'us';
