import crypto from 'node:crypto';
import { buildAuthHeaders } from '../auth.js';

export interface MqttCredential {
  brokerUrl: string;
  region: string;
  clientId: string;
  topics: {
    status: string;
  };
  qos: number;
  tls: {
    enabled: boolean;
    caBase64: string;
    certBase64: string;
    keyBase64: string;
  };
}

const CREDENTIAL_ENDPOINT = 'https://api.switchbot.net/v1.1/iot/credential';

export async function fetchMqttCredential(token: string, secret: string): Promise<MqttCredential> {
  // Derive a stable instance ID per token so the server can track this client.
  const instanceId = crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);

  const headers = buildAuthHeaders(token, secret);
  const res = await fetch(CREDENTIAL_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({ instanceId }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    throw new Error(`MQTT credential request failed: HTTP ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { statusCode: number; body: unknown };

  if (json.statusCode !== 100) {
    throw new Error(`MQTT credential API error: statusCode ${json.statusCode}`);
  }

  // Response shape: { statusCode, body: { body: { channels: { mqtt: ... } } } }
  const outer = json.body as Record<string, unknown>;
  const inner = ((outer.body as Record<string, unknown> | undefined) ?? outer) as Record<string, unknown>;
  const channels = inner.channels as { mqtt: MqttCredential } | undefined;

  if (!channels?.mqtt) {
    throw new Error('Unexpected MQTT credential response — channels.mqtt missing');
  }

  return channels.mqtt;
}
