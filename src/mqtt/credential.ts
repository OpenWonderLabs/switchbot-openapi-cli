import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import crypto from 'node:crypto';
import axios from 'axios';
import { ApiError } from '../api/client.js';
import { MqttError } from './errors.js';
import type { MqttCredential } from './types.js';
import { getProfile } from '../utils/flags.js';

const CREDENTIAL_ENDPOINT = 'https://api.switchbot.net/v1.1/iot/credential';
const TTL_MS = 3600000; // 1 hour
const EARLY_EXPIRY_MS = 600_000; // 10 minutes — refresh before the credential expires

// The SwitchBot /iot/credential endpoint uses a different signing convention
// from the public OpenAPI: the nonce is the literal string "OpenClaw", the
// signature is NOT uppercased, and the `t` header is a number, not a string.
// The request body must include a short random instanceId — without it the
// endpoint responds with statusCode 190 "param is invalid".
const CREDENTIAL_NONCE = 'OpenClaw';

function credentialCachePath(): string {
  const profile = getProfile();
  const filename = profile ? `mqtt-credential.${profile}.json` : 'mqtt-credential.json';
  return path.join(os.homedir(), '.switchbot', filename);
}

async function ensureCachedir(): Promise<void> {
  const dir = path.dirname(credentialCachePath());
  await fs.mkdir(dir, { recursive: true });
}

function generateInstanceId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 12; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function buildCredentialHeaders(token: string, secret: string): Record<string, string | number> {
  const ts = Date.now().toString();
  const sign = crypto
    .createHmac('sha256', Buffer.from(secret, 'utf8'))
    .update(Buffer.from(token + ts + CREDENTIAL_NONCE, 'utf8'))
    .digest('base64');
  return {
    Authorization: token,
    sign,
    t: Number(ts),
    nonce: CREDENTIAL_NONCE,
    'Content-Type': 'application/json',
  };
}

interface CredentialResponseBody {
  channels?: {
    mqtt?: {
      brokerUrl?: string;
      clientId?: string;
      topics?: { status?: string };
      qos?: number;
      tls?: {
        enabled?: boolean;
        caBase64?: string;
        certBase64?: string;
        keyBase64?: string;
      };
    };
  };
}

interface CredentialResponseEnvelope {
  statusCode: number;
  body?: CredentialResponseBody;
  message?: string;
}

function extractErrorMessage(data: CredentialResponseEnvelope | undefined): string {
  if (!data) return 'Unknown error';
  // /iot/credential surfaces errors at the OUTER `message` field, not inside `body`.
  if (typeof data.message === 'string' && data.message.length > 0) return data.message;
  const body = data.body as unknown;
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as Record<string, unknown>).message;
    if (typeof m === 'string' && m.length > 0) return m;
  }
  return 'Unknown error';
}

export async function fetchCredential(token: string, secret: string): Promise<MqttCredential> {
  const headers = buildCredentialHeaders(token, secret);
  const body = { instanceId: generateInstanceId() };
  let response;
  try {
    response = await axios.post<CredentialResponseEnvelope>(CREDENTIAL_ENDPOINT, body, { headers });
  } catch (err) {
    if (axios.isAxiosError(err)) {
      const status = err.response?.status;
      if (status === 401) {
        throw new ApiError(
          'Credential fetch failed: invalid token/secret for /iot/credential',
          401,
          {
            retryable: false,
            hint: "Re-run 'switchbot config set-token <token> <secret>', or verify SWITCHBOT_TOKEN / SWITCHBOT_SECRET.",
          }
        );
      }
      if (status === 429) {
        throw new ApiError(
          'Credential fetch failed: daily 10,000-request quota exceeded',
          429,
          {
            retryable: true,
            hint: 'Daily quota is 10,000 requests/account — retry after midnight UTC.',
          }
        );
      }
      if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || !err.response) {
        throw new MqttError(
          `Credential fetch timed out: ${err.message}`,
          'mqtt-connect-timeout',
          { retryable: true }
        );
      }
    }
    throw err;
  }

  if (response.data.statusCode !== 100) {
    const msg = extractErrorMessage(response.data);
    const code = response.data.statusCode;
    if (code === 401) {
      throw new ApiError(`Credential fetch failed: ${msg}`, 401, {
        retryable: false,
        hint: "Re-run 'switchbot config set-token <token> <secret>', or verify SWITCHBOT_TOKEN / SWITCHBOT_SECRET.",
      });
    }
    if (code === 429) {
      throw new ApiError(`Credential fetch failed: ${msg}`, 429, {
        retryable: true,
        hint: 'Daily quota is 10,000 requests/account — retry after midnight UTC.',
      });
    }
    throw new Error(`Credential fetch failed: ${msg}`);
  }

  const mqtt = response.data.body?.channels?.mqtt;
  if (!mqtt || !mqtt.brokerUrl || !mqtt.clientId || !mqtt.topics?.status || !mqtt.tls) {
    throw new Error(
      'Credential fetch failed: malformed response (missing channels.mqtt fields). ' +
      'Run with --verbose to see the raw response; verify your SwitchBot account MQTT access.',
    );
  }
  const { caBase64, certBase64, keyBase64 } = mqtt.tls;
  if (!caBase64 || !certBase64 || !keyBase64) {
    throw new Error(
      'Credential fetch failed: malformed response (missing TLS material). ' +
      'Run with --verbose to see the raw response; verify your SwitchBot account MQTT access.',
    );
  }

  return {
    brokerUrl: mqtt.brokerUrl,
    clientId: mqtt.clientId,
    topics: [mqtt.topics.status],
    tls: { caBase64, certBase64, keyBase64 },
    qos: typeof mqtt.qos === 'number' ? mqtt.qos : 1,
    expiresAt: Date.now() + TTL_MS,
  };
}

export async function loadCachedCredential(): Promise<MqttCredential | null> {
  try {
    const data = await fs.readFile(credentialCachePath(), 'utf-8');
    const cred = JSON.parse(data) as MqttCredential;
    const timeUntilExpiry = cred.expiresAt - Date.now();
    if (timeUntilExpiry > EARLY_EXPIRY_MS) {
      return cred;
    }
  } catch {
    // Cache miss or parse error; will re-fetch
  }
  return null;
}

export async function saveCachedCredential(cred: MqttCredential): Promise<void> {
  await ensureCachedir();
  const cachePath = credentialCachePath();
  const tmp = `${cachePath}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(cred, null, 2));
    await fs.rename(tmp, cachePath);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export async function getCredential(token: string, secret: string, noCache = false): Promise<MqttCredential> {
  if (!noCache) {
    const cached = await loadCachedCredential();
    if (cached) return cached;
  }
  const fresh = await fetchCredential(token, secret);
  await saveCachedCredential(fresh);
  return fresh;
}
