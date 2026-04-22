/**
 * File-backed credential store.
 *
 * Reads/writes the same `~/.switchbot/config.json` shape the CLI has
 * used since v1.0, so a fresh install on a machine without a keychain
 * still works and legacy users can migrate in-place via
 * `switchbot auth keychain migrate` without data loss.
 *
 * Profile layout (inherited from `src/config.ts`):
 *   - default profile → `~/.switchbot/config.json`
 *   - named profile   → `~/.switchbot/profiles/<name>.json`
 *
 * This backend only owns the `token` and `secret` fields — label /
 * description / limits / defaults are preserved on write by merging
 * with the existing JSON, keeping parity with `saveConfig()`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CredentialBundle,
  CredentialStore,
  CredentialStoreDescribe,
  KeychainError,
} from '../keychain.js';

function profilePath(profile: string): string {
  if (profile === 'default') {
    return path.join(os.homedir(), '.switchbot', 'config.json');
  }
  return path.join(os.homedir(), '.switchbot', 'profiles', `${profile}.json`);
}

function readJson(file: string): Record<string, unknown> | null {
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function createFileBackend(): CredentialStore {
  return {
    name: 'file',
    async get(profile: string): Promise<CredentialBundle | null> {
      const file = profilePath(profile);
      const data = readJson(file);
      if (!data) return null;
      const token = typeof data.token === 'string' ? data.token : '';
      const secret = typeof data.secret === 'string' ? data.secret : '';
      if (!token || !secret) return null;
      return { token, secret };
    },
    async set(profile: string, creds: CredentialBundle): Promise<void> {
      const file = profilePath(profile);
      const dir = path.dirname(file);
      try {
        fs.mkdirSync(dir, { recursive: true });
        const existing = readJson(file) ?? {};
        const next = { ...existing, token: creds.token, secret: creds.secret };
        fs.writeFileSync(file, JSON.stringify(next, null, 2), { mode: 0o600 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new KeychainError('file', 'set', msg);
      }
    },
    async delete(profile: string): Promise<void> {
      const file = profilePath(profile);
      try {
        if (!fs.existsSync(file)) return;
        const existing = readJson(file);
        if (existing) {
          delete existing.token;
          delete existing.secret;
          if (Object.keys(existing).length === 0) {
            fs.unlinkSync(file);
          } else {
            fs.writeFileSync(file, JSON.stringify(existing, null, 2), { mode: 0o600 });
          }
        } else {
          fs.unlinkSync(file);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new KeychainError('file', 'delete', msg);
      }
    },
    describe(): CredentialStoreDescribe {
      return {
        backend: 'File (~/.switchbot/)',
        tag: 'file',
        writable: true,
        notes: 'Last-resort fallback; credentials stored in a 0600 JSON file.',
      };
    },
  };
}
