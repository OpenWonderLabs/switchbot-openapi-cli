import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

export function buildAuthHeaders(token: string, secret: string): Record<string, string> {
  const t = String(Date.now());  // 13-digit millisecond timestamp
  const nonce = uuidv4();        // unique per request
  const data = token + t + nonce;
  const sign = crypto
    .createHmac('sha256', secret)
    .update(data)
    .digest('base64')
    .toUpperCase();              // API requires uppercase

  return {
    Authorization: token,
    t,
    sign,
    nonce,
    src: 'OpenClaw',
    'Content-Type': 'application/json',
  };
}
