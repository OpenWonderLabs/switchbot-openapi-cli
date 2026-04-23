/**
 * Webhook bearer-token management for the rules engine.
 *
 * Responsibilities:
 *   - Resolve the bearer token the listener will accept. The order is
 *     env var (SWITCHBOT_WEBHOOK_TOKEN) → on-disk cache
 *     (~/.switchbot/webhook-token, chmod 0600) → generate a fresh
 *     32-byte hex token and persist it.
 *   - Rotate the token on demand (`rules webhook-rotate-token` cli).
 *
 * Why not the OS keychain (F1 abstraction)? The webhook bearer is a
 * single opaque string, whereas `CredentialStore` is shaped around the
 * SwitchBot {token,secret} bundle. Fitting a one-field artifact into
 * that contract bloats every profile; keeping it in a 0600 file gives
 * the same protection the CLI has used for `~/.switchbot/config.json`.
 * Promotion into the keychain is a future follow-up once the
 * abstraction grows a generic single-value slot.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const ENV_TOKEN = 'SWITCHBOT_WEBHOOK_TOKEN';
const DEFAULT_FILE = '.switchbot/webhook-token';

export interface WebhookTokenStoreOptions {
  /** Override the resolved token path — tests use a tmpdir. */
  filePath?: string;
  /**
   * Override the environment lookup. When set to `false` the env var is
   * not consulted; useful for tests that want the file path exercised
   * even though a token is set in the shell.
   */
  envLookup?: () => string | undefined;
}

export class WebhookTokenStore {
  private readonly filePath: string;
  private readonly envLookup: () => string | undefined;

  constructor(opts: WebhookTokenStoreOptions = {}) {
    this.filePath = opts.filePath ?? path.join(os.homedir(), DEFAULT_FILE);
    this.envLookup = opts.envLookup ?? (() => process.env[ENV_TOKEN]);
  }

  /**
   * Return a bearer token, creating + persisting one if none exists yet.
   * Env var wins when set; otherwise the on-disk token is read (and
   * generated on first call).
   */
  getOrCreate(): string {
    const fromEnv = this.envLookup();
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

    const existing = this.readFromDisk();
    if (existing) return existing;

    const fresh = generateToken();
    this.writeToDisk(fresh);
    return fresh;
  }

  /**
   * Read the persisted token, returning null when the file is absent
   * or empty. Does NOT consult the env var — callers that want the
   * env-aware path should use `getOrCreate()`.
   */
  readFromDisk(): string | null {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8').trim();
      return raw.length > 0 ? raw : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Write a new token, persisting with 0600 perms. */
  rotate(): string {
    const fresh = generateToken();
    this.writeToDisk(fresh);
    return fresh;
  }

  getFilePath(): string {
    return this.filePath;
  }

  private writeToDisk(token: string): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filePath, `${token}\n`, { mode: 0o600 });
    // mkdirSync + writeFileSync race can leave broader perms on Windows
    // (perm bits are mostly advisory there anyway), but on POSIX we
    // re-chmod to be explicit about intent.
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // non-POSIX filesystems may reject chmod — intentional best effort.
    }
  }
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}
