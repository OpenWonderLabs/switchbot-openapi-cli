import crypto from 'node:crypto';
import axios from 'axios';
import type { CredentialBundle } from '../credentials/keychain.js';
import {
  OAUTH_CLIENT_ID,
  OAUTH_CLIENT_SECRET,
  ACCOUNT_API_BASE,
  TOKEN_AES_KEY,
  TOKEN_AES_IV,
  ENDPOINTS,
  KNOWN_BOT_REGIONS,
  DEFAULT_BOT_REGION,
} from './constants.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function decryptField(hexCipher: string): string {
  const key = Buffer.from(TOKEN_AES_KEY, 'utf8');
  const iv  = Buffer.from(TOKEN_AES_IV,  'utf8');
  const d   = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([d.update(Buffer.from(hexCipher, 'hex')), d.final()]).toString('utf8');
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Exchange an OAuth authorization code for SwitchBot v1.1 credentials.
 *
 * Step 1 — POST account.api.switchbot.net/merchant/v1/oauth/token  (form-encoded)
 *   Exchange the authorization code for an access_token.
 *
 * Step 2 — POST account.api.switchbot.net/account/api/v1/user/userinfo
 *   Get the user's botRegion to select the correct regional Wonder API.
 *
 * Step 3 — POST wonderlabs.{region}.api.switchbot.net/wonder/openapi/openUser/token
 *   Retrieve AES-128-CBC encrypted openToken + secretKey, then decrypt.
 */
export async function exchangeCodeForCredentials(
  code: string,
  redirectUri: string,
): Promise<CredentialBundle> {

  // ── Step 1: code → access_token ──────────────────────────────────────────
  let accessToken: string;
  try {
    const resp = await axios.post<Record<string, unknown>>(
      `${ACCOUNT_API_BASE}${ENDPOINTS.oauthToken}`,
      new URLSearchParams({
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code,
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15_000,
      },
    );

    const data = resp.data;
    // Support both top-level and body-wrapped access_token
    const bodyData = (data['body'] as Record<string, unknown> | undefined) ?? data;
    const token = typeof bodyData['access_token'] === 'string' ? bodyData['access_token'] : undefined;

    if (!token) {
      throw new Error(`Token endpoint returned no access_token. Body: ${JSON.stringify(data)}`);
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

  // ── Step 2: access_token → botRegion ────────────────────────────────────
  let botRegion = DEFAULT_BOT_REGION;
  try {
    const resp = await axios.post<{ statusCode?: number; body?: { botRegion?: string } }>(
      `${ACCOUNT_API_BASE}${ENDPOINTS.userInfo}`,
      {},
      {
        headers: { 'Content-Type': 'application/json', Authorization: accessToken },
        timeout: 15_000,
      },
    );
    const raw = resp.data?.body?.botRegion ?? '';
    if (KNOWN_BOT_REGIONS.has(raw)) botRegion = raw;
  } catch {
    // Non-fatal: fall back to default region
  }

  // ── Step 3: Wonder API → encrypted credentials → decrypt ─────────────────
  try {
    const wonderBase = `https://wonderlabs.${botRegion}.api.switchbot.net/wonder`;
    const resp = await axios.post<{ statusCode?: number; body?: Record<string, unknown> }>(
      `${wonderBase}${ENDPOINTS.openUserToken}`,
      { operation: 'get', version: 2 },
      {
        headers: { 'Content-Type': 'application/json', Authorization: accessToken },
        timeout: 15_000,
      },
    );

    const body = (resp.data?.body ?? {}) as Record<string, unknown>;
    const encToken  = typeof body['token']     === 'string' ? body['token']     : undefined;
    const encSecret = typeof body['secretKey'] === 'string' ? body['secretKey'] : undefined;

    if (!encToken || !encSecret) {
      throw new Error(
        `openUser/token returned statusCode=${resp.data?.statusCode} ` +
          `but token/secretKey missing. Full response: ${JSON.stringify(resp.data)}`,
      );
    }

    return { token: decryptField(encToken), secret: decryptField(encSecret) };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      const body = err.response?.data;
      throw new Error(
        `Credentials fetch failed (HTTP ${status ?? 'unknown'}): ` +
          (typeof body === 'object' ? JSON.stringify(body) : String(body ?? err.message)),
      );
    }
    throw err;
  }
}
