import axios from 'axios';
import type { CredentialBundle } from '../credentials/keychain.js';
import {
  OAUTH_CLIENT_ID,
  ACCOUNT_API_BASE,
  MOBILE_API_BASE,
  ENDPOINTS,
} from './constants.js';

// ── Response shapes ───────────────────────────────────────────────────────────

interface TokenResponse {
  statusCode?: number;
  body?: {
    access_token?: string;
    [key: string]: unknown;
  };
  access_token?: string;
}

interface MobileLoginResponse {
  statusCode: number;
  body?: {
    openToken?: string;
    secretKey?: string;
    token?: string;
    secret?: string;
    [key: string]: unknown;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Exchange an OAuth authorization code for SwitchBot v1.1 credentials.
 *
 * Step 1 — POST account.api.switchbot.net/merchant/v1/oauth/token
 *   Exchange the authorization code issued by sp.oauth.switchbot.net for an
 *   access_token using the SwitchBot account API.
 *
 * Step 2 — POST /v2/mobile/management/login  (wonderlabs mobile API)
 *   Uses the access_token to retrieve the v1.1 openToken + secretKey.
 *   These are the long-lived credentials used with HMAC-SHA256 signing.
 */
export async function exchangeCodeForCredentials(
  code: string,
  redirectUri: string,
): Promise<CredentialBundle> {

  // ── Step 1: code → access_token ──────────────────────────────────────────
  let accessToken: string;
  try {
    const resp = await axios.post<TokenResponse>(
      `${ACCOUNT_API_BASE}${ENDPOINTS.oauthToken}`,
      {
        clientId: OAUTH_CLIENT_ID,
        redirectUri,
        grantType: 'authorization_code',
        code,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15_000,
      },
    );

    // Support both top-level access_token and body.access_token response shapes
    const token =
      resp.data?.body?.access_token ??
      (resp.data as { access_token?: string })?.access_token;

    if (!token) {
      throw new Error(`Token endpoint returned no access_token. Body: ${JSON.stringify(resp.data)}`);
    }
    accessToken = token;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const body = err.response?.data;
      throw new Error(
        `Token exchange failed (HTTP ${status ?? 'unknown'}): ` +
          (typeof body === 'object' ? JSON.stringify(body) : String(body ?? err.message)),
      );
    }
    throw err;
  }

  // ── Step 2: access_token → openToken + secretKey ─────────────────────────
  try {
    const resp = await axios.post<MobileLoginResponse>(
      `${MOBILE_API_BASE}${ENDPOINTS.mobileLogin}`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: accessToken,
        },
        timeout: 15_000,
      },
    );

    const body = (resp.data?.body ?? {}) as Record<string, unknown>;
    const token = pickString(body, 'openToken', 'token');
    const secret = pickString(body, 'secretKey', 'secret');

    if (!token || !secret) {
      throw new Error(
        `mobile/management/login returned statusCode=${resp.data?.statusCode} ` +
          `but openToken/secretKey missing. Body: ${JSON.stringify(resp.data?.body)}\n` +
          `If field names differ, update pickString() calls in src/auth/token-exchange.ts.`,
      );
    }

    return { token, secret };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const body = err.response?.data;
      throw new Error(
        `Mobile login failed (HTTP ${status ?? 'unknown'}): ` +
          (typeof body === 'object' ? JSON.stringify(body) : String(body ?? err.message)),
      );
    }
    throw err;
  }
}
