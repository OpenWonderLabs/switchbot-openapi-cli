import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import axios from 'axios';
import { buildAuthHeaders } from '../auth.js';
import type { MqttCredential } from './types.js';

const CREDENTIAL_ENDPOINT = 'https://api.switchbot.net/v1.1/iot/credential';
const CREDENTIAL_CACHE_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '~', '.switchbot', 'mqtt-credential.json');
const TTL_MS = 3600000; // 1 hour

async function ensureCachedir(): Promise<void> {
  const dir = path.dirname(CREDENTIAL_CACHE_PATH);
  await fs.mkdir(dir, { recursive: true });
}

export async function fetchCredential(token: string, secret: string): Promise<MqttCredential> {
  const headers = buildAuthHeaders(token, secret);
  const response = await axios.post<{
    statusCode: number;
    body: {
      brokerUrl: string;
      clientId: string;
      topics: string[];
      tls: { caBase64: string; certBase64: string; keyBase64: string };
      qos: number;
    };
  }>(CREDENTIAL_ENDPOINT, {}, { headers });

  if (response.data.statusCode !== 100) {
    const msg = (response.data.body as Record<string, unknown>).message || 'Unknown error';
    throw new Error(`Credential fetch failed: ${msg}`);
  }

  const body = response.data.body;
  return {
    brokerUrl: body.brokerUrl,
    clientId: body.clientId,
    topics: body.topics,
    tls: body.tls,
    qos: body.qos,
    expiresAt: Date.now() + TTL_MS,
  };
}

export async function loadCachedCredential(): Promise<MqttCredential | null> {
  try {
    const data = await fs.readFile(CREDENTIAL_CACHE_PATH, 'utf-8');
    const cred = JSON.parse(data) as MqttCredential;
    if (cred.expiresAt > Date.now()) {
      return cred;
    }
  } catch {
    // Cache miss or parse error; will re-fetch
  }
  return null;
}

export async function saveCachedCredential(cred: MqttCredential): Promise<void> {
  await ensureCachedir();
  const tmp = `${CREDENTIAL_CACHE_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cred, null, 2));
  await fs.rename(tmp, CREDENTIAL_CACHE_PATH);
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
