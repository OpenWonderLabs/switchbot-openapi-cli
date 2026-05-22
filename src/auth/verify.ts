import axios from 'axios';
import { buildAuthHeaders } from '../auth.js';
import type { CredentialBundle } from '../credentials/keychain.js';

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export async function verifyCredentials(creds: CredentialBundle): Promise<VerifyResult> {
  try {
    const resp = await axios.get<{ statusCode: number }>(
      'https://api.switch-bot.com/v1.1/devices',
      { headers: buildAuthHeaders(creds.token, creds.secret), timeout: 10_000 },
    );
    if (resp.data?.statusCode === 100) return { ok: true };
    return { ok: false, reason: `API returned statusCode ${resp.data?.statusCode}` };
  } catch (err) {
    if (axios.isAxiosError(err)) {
      if (err.response?.status === 401) {
        return { ok: false, reason: 'API rejected the credentials (401). The decrypted token or secret may be wrong.' };
      }
      return { ok: false, reason: `Network error: ${err.message}` };
    }
    return { ok: false, reason: String(err) };
  }
}
