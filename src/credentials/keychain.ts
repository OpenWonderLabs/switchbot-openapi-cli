/**
 * OS-keychain credential store abstraction.
 *
 * F1 scope (plan: `feat/v2.8-policy-tooling`):
 *   - Defines the `CredentialStore` contract the rest of the CLI can
 *     depend on (token/secret per profile, auditable describe(), best-
 *     effort delete()).
 *   - Ships four backends: `macos` (security(1)), `linux`
 *     (secret-tool), `windows` (PowerShell + Win32 CredRead/CredWrite)
 *     and `file` (the existing `~/.switchbot/config.json` shape as
 *     last-resort fallback).
 *   - `selectCredentialStore()` picks the OS-native backend first and
 *     silently degrades to `file` whenever a backend is absent or
 *     non-writable — so a fresh Linux box without libsecret installed
 *     still Just Works.
 *
 * Out of scope here: migrating existing users off `~/.switchbot/config.json`
 * into the keychain. F3's `switchbot auth keychain migrate` subcommand
 * handles the explicit opt-in; F2 only wires the *read* path.
 *
 * Design choices:
 *   - No native bindings. Every native backend shells out to an
 *     OS-provided CLI / interpreter, which keeps `npm install` free of
 *     compile steps on CI machines.
 *   - Errors never leak credential material to logs or stderr. On any
 *     subprocess failure backends return `null` (read) or throw a
 *     `KeychainError` without the input token/secret in the message.
 *   - Service / account namespacing is identical across backends
 *     (`com.openclaw.switchbot` / `<profile>:<field>`) so a user can
 *     move between machines and expect `switchbot auth keychain get`
 *     to produce the same lookup shape.
 */

export const CREDENTIAL_SERVICE = 'com.openclaw.switchbot';
export const CREDENTIAL_FIELDS = ['token', 'secret'] as const;
export type CredentialField = (typeof CREDENTIAL_FIELDS)[number];

export interface CredentialBundle {
  token: string;
  secret: string;
}

export type CredentialBackendName = 'keychain' | 'credman' | 'secret-service' | 'file';

export interface CredentialStoreDescribe {
  /** User-facing short name, e.g. "macOS Keychain" or "Credential Manager (Windows)". */
  backend: string;
  /** Implementation tag; what `CredentialStore.name` returns. */
  tag: CredentialBackendName;
  /** Whether `set()`/`delete()` are expected to succeed. */
  writable: boolean;
  /** Optional one-line note surfaced by doctor and `auth keychain describe`. */
  notes?: string;
}

export interface CredentialStore {
  readonly name: CredentialBackendName;
  get(profile: string): Promise<CredentialBundle | null>;
  set(profile: string, creds: CredentialBundle): Promise<void>;
  delete(profile: string): Promise<void>;
  describe(): CredentialStoreDescribe;
}

/**
 * Thrown when a backend cannot service a `set`/`delete` request even
 * though it reported itself as writable. Never includes the
 * credential material in the message.
 */
export class KeychainError extends Error {
  constructor(
    public readonly backend: CredentialBackendName,
    public readonly operation: 'get' | 'set' | 'delete',
    message: string,
  ) {
    super(`[${backend}] ${operation} failed: ${message}`);
    this.name = 'KeychainError';
  }
}

/** Encode the account string used by every native backend. Kept public
 * so F3's CLI can show what the underlying keychain will see. */
export function accountFor(profile: string, field: CredentialField): string {
  return `${profile}:${field}`;
}

/**
 * Select the best backend for the current platform. The caller does
 * not need to handle "no keychain available" — this function always
 * returns a store, falling back to the file backend if necessary.
 *
 * Detection is done eagerly at call time (cheap `which` probe) so a
 * long-running process reflects environment changes (e.g. user
 * installs secret-tool after first run). Selection does NOT mutate
 * any state; calling it twice returns fresh instances.
 */
export async function selectCredentialStore(opts: { preferFile?: boolean } = {}): Promise<CredentialStore> {
  if (opts.preferFile) {
    const { createFileBackend } = await import('./backends/file.js');
    return createFileBackend();
  }

  const platform = process.platform;
  if (platform === 'darwin') {
    const { createMacOsBackend, macOsAvailable } = await import('./backends/macos.js');
    if (await macOsAvailable()) return createMacOsBackend();
  } else if (platform === 'linux') {
    const { createLinuxBackend, linuxAvailable } = await import('./backends/linux.js');
    if (await linuxAvailable()) return createLinuxBackend();
  } else if (platform === 'win32') {
    const { createWindowsBackend, windowsAvailable } = await import('./backends/windows.js');
    if (await windowsAvailable()) return createWindowsBackend();
  }

  const { createFileBackend } = await import('./backends/file.js');
  return createFileBackend();
}
