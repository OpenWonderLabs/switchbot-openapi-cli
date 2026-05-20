import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import axios from 'axios';
import { generateState } from './csrf.js';
import { getFreePort, escapeHtml } from './utils.js';
import {
  OAUTH_CLIENT_ID,
  OAUTH_SCOPE,
  OAUTH_TOKEN_URL,
  ACCOUNT_API_BASE,
  WONDER_API_BASE,
  ENDPOINTS,
  LOGIN_TIMEOUT_MS,
} from './constants.js';
import type { CredentialBundle } from '../credentials/keychain.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoginServerHandle {
  /** Port the server is listening on (open browser to http://127.0.0.1:<port>/) */
  port: number;
  /** Resolves with credentials once the user completes login, or rejects on timeout/error. */
  wait(): Promise<CredentialBundle>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, 'web');

function getLoginHtml(state: string, port: number): string {
  const filePath = path.join(WEB_DIR, 'login.html');
  let html: string;
  try {
    html = fs.readFileSync(filePath, 'utf8');
  } catch {
    // Fallback minimal page if web/login.html is missing
    html = `<!DOCTYPE html><html><body>
      <p>Login page not found. Run <code>npm run build</code>.</p>
    </body></html>`;
  }
  // Inject runtime config just before </head>
  const config = JSON.stringify({
    clientId: OAUTH_CLIENT_ID,
    cognitoDomain: 'https://auth.switch-bot.com',
    scope: OAUTH_SCOPE,
    state,
    callbackBase: `http://127.0.0.1:${port}`,
  });
  return html.replace(
    '</head>',
    `<script>window.__SWITCHBOT_LOGIN_CONFIG__ = ${config};</script>\n</head>`,
  );
}

function successHtml(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>SwitchBot — Login Successful</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;background:linear-gradient(135deg,#1a2f4a,#0f1e33);
display:flex;align-items:center;justify-content:center;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.card{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);
border-radius:20px;padding:40px 48px;text-align:center;
box-shadow:0 20px 60px rgba(0,0,0,.35)}
.icon{width:56px;height:56px;background:rgba(22,163,74,.2);border-radius:50%;
display:flex;align-items:center;justify-content:center;margin:0 auto 20px}
.icon svg{width:28px;height:28px;stroke:#86efac;fill:none;stroke-width:2.5}
h1{color:#fff;font-size:20px;margin-bottom:10px}
p{color:rgba(255,255,255,.55);font-size:14px}
</style></head>
<body><div class="card">
<div class="icon"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
<h1>Login Successful</h1>
<p>Credentials saved. You can close this tab and return to your terminal.</p>
</div></body></html>`;
}

function errorHtml(detail: string): string {
  const escaped = escapeHtml(detail);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>SwitchBot — Login Failed</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{min-height:100vh;background:linear-gradient(135deg,#1a2f4a,#0f1e33);
display:flex;align-items:center;justify-content:center;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.card{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);
border-radius:20px;padding:40px 48px;text-align:center;
box-shadow:0 20px 60px rgba(0,0,0,.35)}
h1{color:#fca5a5;font-size:20px;margin-bottom:10px}
p{color:rgba(255,255,255,.55);font-size:13px}
</style></head>
<body><div class="card">
<h1>Login Failed</h1>
<p>${escaped}</p>
</div></body></html>`;
}

/** Get botRegion then call wonder openapi to retrieve openToken + secretKey. */
async function fetchCredentials(accessToken: string): Promise<CredentialBundle> {
  // Detect botRegion for region-aware API routing
  let botRegion = 'us';
  try {
    const userInfoResp = await axios.post<{
      statusCode: number;
      body?: { botRegion?: string };
    }>(
      `${ACCOUNT_API_BASE}/account/api/v1/user/userinfo`,
      {},
      {
        headers: { 'Content-Type': 'application/json', Authorization: accessToken },
        timeout: 10_000,
      },
    );
    const region = userInfoResp.data?.body?.botRegion;
    if (typeof region === 'string' && region) botRegion = region;
  } catch {
    // Non-fatal — fall back to "us"
  }

  // Allowlist: reject any region value that is not 2–8 lowercase ASCII letters.
  if (!/^[a-z]{2,8}$/.test(botRegion)) botRegion = 'us';

  const wonderHost = WONDER_API_BASE.replace('.us.api', `.${botRegion}.api`);

  const resp = await axios.post<{
    statusCode?: number;
    resultCode?: number;
    body?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }>(
    `${wonderHost}${ENDPOINTS.openUserToken}`,
    { operation: 'get', version: 2 },
    {
      headers: { 'Content-Type': 'application/json', Authorization: accessToken },
      timeout: 15_000,
    },
  );

  // API may nest credentials under `body` or `data`
  const payload = (resp.data?.body ?? resp.data?.data ?? resp.data) as Record<string, unknown>;
  const token = [payload['openToken'], payload['token']].find(
    (v): v is string => typeof v === 'string' && !!v,
  );
  const secret = [payload['secretKey'], payload['secret']].find(
    (v): v is string => typeof v === 'string' && !!v,
  );

  if (!token || !secret) {
    const code = resp.data?.statusCode ?? resp.data?.resultCode;
    throw new Error(
      `openUser/token returned code=${code} but openToken/secretKey missing. ` +
        `Response: ${JSON.stringify(resp.data)}`,
    );
  }
  return { token, secret };
}

/** Exchange authorization code → access_token → CredentialBundle. */
async function exchangeCode(code: string, redirectUri: string): Promise<CredentialBundle> {
  const tokenResp = await axios.post<{ access_token?: string }>(
    OAUTH_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      code,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15_000 },
  );

  const accessToken = tokenResp.data.access_token;
  if (!accessToken) {
    throw new Error(`Token exchange returned no access_token: ${JSON.stringify(tokenResp.data)}`);
  }

  return fetchCredentials(accessToken);
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Start a local HTTP server that serves the custom SwitchBot login page and
 * handles the OAuth callback.
 *
 * The caller gets back `{ port, wait() }`:
 * - Open browser to `http://127.0.0.1:<port>/`
 * - Call `wait()` to receive the CredentialBundle once the user finishes login.
 *
 * The server shuts itself down after the first successful login or on timeout.
 */
export async function bindLoginServer(
  timeoutMs = LOGIN_TIMEOUT_MS,
): Promise<LoginServerHandle> {
  const port = await getFreePort();
  const state = generateState();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  let resolveResult!: (r: CredentialBundle) => void;
  let rejectResult!: (e: Error) => void;
  const resultPromise = new Promise<CredentialBundle>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  let finished = false;

  const finish = (creds: CredentialBundle | null, err?: Error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    server.close();
    if (err) rejectResult(err); else resolveResult(creds!);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    const html = (code: number, body: string) => {
      res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
      res.end(body);
    };
    const json = (code: number, body: object) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...SECURITY_HEADERS });
      res.end(JSON.stringify(body));
    };

    // ── GET / — serve login page ─────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/') {
      html(200, getLoginHtml(state, port));
      return;
    }

    // ── GET /done — success page ─────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/done') {
      html(200, successHtml());
      return;
    }

    // ── GET /callback — OAuth authorization code callback ───────────────────
    if (req.method === 'GET' && url.pathname === '/callback') {
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const errorDesc = url.searchParams.get('error_description') ?? '';

      if (error) {
        const msg = `${error}${errorDesc ? ': ' + errorDesc : ''}`;
        html(400, errorHtml(msg));
        finish(null, new Error(`OAuth error: ${msg}`));
        return;
      }

      if (returnedState !== state) {
        html(400, errorHtml('State mismatch — possible CSRF. Please try again.'));
        finish(null, new Error('OAuth state mismatch'));
        return;
      }

      if (!code) {
        html(400, errorHtml('Missing authorization code in callback.'));
        finish(null, new Error('Missing authorization code'));
        return;
      }

      html(200, `<!DOCTYPE html><html><head><meta charset="utf-8">
        <style>body{min-height:100vh;background:linear-gradient(135deg,#1a2f4a,#0f1e33);
        display:flex;align-items:center;justify-content:center;
        font-family:-apple-system,sans-serif;color:rgba(255,255,255,.7)}</style>
        </head><body><p>Completing sign-in…</p></body></html>`);

      exchangeCode(code, redirectUri)
        .then(creds => finish(creds))
        .catch(err => finish(null, err instanceof Error ? err : new Error(String(err))));
      return;
    }

    // ── POST /auth/email — email / password proxy ────────────────────────────
    if (req.method === 'POST' && url.pathname === '/auth/email') {
      const BODY_LIMIT = 4 * 1024;
      let body = '';
      let bodySize = 0;
      let over = false;

      req.on('data', (chunk: Buffer) => {
        bodySize += chunk.length;
        if (bodySize > BODY_LIMIT) {
          if (!over) {
            over = true;
            json(413, { success: false, message: 'Request body too large.' });
            req.resume();
          }
          return;
        }
        body += chunk;
      });

      req.on('end', () => {
        if (over) return;
        let email: string, password: string;
        try {
          ({ email, password } = JSON.parse(body));
        } catch {
          json(400, { success: false, message: 'Invalid request body.' });
          return;
        }
        handleEmailLogin(email, password)
          .then(creds => {
            json(200, { success: true });
            finish(creds);
          })
          .catch(err => {
            const msg = err instanceof Error ? err.message : String(err);
            json(401, { success: false, message: msg });
          });
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
    res.end('Not found');
  });

  server.listen(port, '127.0.0.1');

  const timer = setTimeout(() => {
    finish(null, new Error('Login timed out. Please run `switchbot auth login` again.'));
  }, timeoutMs);

  return { port, wait: () => resultPromise };
}

// ── Email / password auth (SwitchBot consumer REST API) ──────────────────────

/**
 * Direct email/password login using the SwitchBot consumer account API.
 *
 * Flow mirrors customize-login page's Vue component:
 *  1. POST /account/api/v2/user/login → access_token (or mfa_token if MFA required)
 *  2. If MFA: not yet supported — throw with a helpful message
 *  3. POST /account/api/v1/user/userinfo → botRegion
 *  4. POST wonderlabs.{botRegion}.api.switchbot.net/homepage/v2/mobile/management/login → openToken + secretKey
 */
async function handleEmailLogin(
  email: string,
  password: string,
): Promise<CredentialBundle> {
  // Step 1 — authenticate with username + password
  const loginResp = await axios.post<{
    statusCode: number;
    body?: {
      access_token?: string;
      mfa_token?: string;
      mfa_enabled?: boolean;
      status?: string;
    };
    message?: string;
  }>(
    `${ACCOUNT_API_BASE}/account/api/v2/user/login`,
    {
      clientId: OAUTH_CLIENT_ID,
      deviceInfo: {
        deviceId: randomUUID().replace(/-/g, ''),
        model: 'CLI',
        deviceName: 'switchbot-cli',
      },
      grantType: 'password',
      username: email,
      password,
      dialCode: '',
      verifyCode: '',
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 },
  );

  const loginBody = loginResp.data?.body ?? {};

  if (loginResp.data?.statusCode !== 100) {
    const msg = loginResp.data?.message ?? `Login failed (statusCode=${loginResp.data?.statusCode})`;
    throw new Error(msg);
  }

  if (loginBody.mfa_enabled && loginBody.mfa_token) {
    throw new Error(
      'This account has MFA enabled. MFA login is not yet supported in CLI browser login. ' +
        'Please use `switchbot auth login --direct` to sign in, or disable MFA on your account.',
    );
  }

  const accessToken = loginBody.access_token;
  if (!accessToken) {
    throw new Error(`Login returned no access_token. Body: ${JSON.stringify(loginResp.data?.body)}`);
  }

  return fetchCredentials(accessToken);
}
