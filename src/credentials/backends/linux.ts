/**
 * Linux libsecret backend.
 *
 * Shells out to `secret-tool(1)` — the libsecret CLI shipped by most
 * distros when GNOME Keyring or KWallet is available. We intentionally
 * avoid a native binding so `npm install` doesn't drag in a build
 * toolchain on minimal CI images.
 *
 * On a fresh Linux box without secret-tool installed (or without a
 * secret service daemon running), `linuxAvailable()` returns false and
 * `selectCredentialStore()` falls back to the file backend. We do NOT
 * try to `apt install libsecret-tools` on the user's behalf.
 */

import { spawn } from 'node:child_process';
import {
  accountFor,
  CREDENTIAL_SERVICE,
  CredentialBundle,
  CredentialStore,
  CredentialStoreDescribe,
  KeychainError,
} from '../keychain.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], stdin?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (buf) => {
      stdout += buf.toString('utf-8');
    });
    proc.stderr.on('data', (buf) => {
      stderr += buf.toString('utf-8');
    });
    proc.on('error', () => resolve({ code: 127, stdout, stderr }));
    proc.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
    if (stdin !== undefined) {
      proc.stdin.write(stdin);
    }
    proc.stdin.end();
  });
}

export async function linuxAvailable(): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const which = await run('which', ['secret-tool']);
  if (which.code !== 0 || which.stdout.trim().length === 0) return false;
  // Probe the secret service is actually running. `secret-tool search`
  // with a bogus attribute returns 0 on miss but 1 when the D-Bus
  // service isn't reachable — so we use the exit code to distinguish.
  const probe = await run('secret-tool', ['search', 'service', CREDENTIAL_SERVICE]);
  return probe.code === 0 || probe.code === 1;
}

async function readField(profile: string, field: 'token' | 'secret'): Promise<string | null> {
  const account = accountFor(profile, field);
  const res = await run('secret-tool', [
    'lookup',
    'service', CREDENTIAL_SERVICE,
    'account', account,
  ]);
  if (res.code !== 0) return null;
  const value = res.stdout.replace(/\n$/, '');
  return value.length > 0 ? value : null;
}

async function writeField(profile: string, field: 'token' | 'secret', value: string): Promise<void> {
  const account = accountFor(profile, field);
  const label = `SwitchBot CLI (${account})`;
  // `secret-tool store` reads the password from stdin.
  const res = await run(
    'secret-tool',
    ['store', '--label', label, 'service', CREDENTIAL_SERVICE, 'account', account],
    value,
  );
  if (res.code !== 0) {
    throw new KeychainError('secret-service', 'set', `secret-tool exit ${res.code}`);
  }
}

async function deleteField(profile: string, field: 'token' | 'secret'): Promise<void> {
  const account = accountFor(profile, field);
  const res = await run('secret-tool', [
    'clear',
    'service', CREDENTIAL_SERVICE,
    'account', account,
  ]);
  // secret-tool returns 0 even when nothing matched, so we tolerate
  // both 0 and the "nothing to clear" path transparently.
  if (res.code !== 0) {
    throw new KeychainError('secret-service', 'delete', `secret-tool exit ${res.code}`);
  }
}

async function restoreField(profile: string, field: 'token' | 'secret', value: string | null): Promise<void> {
  try {
    if (value === null) {
      await deleteField(profile, field);
      return;
    }
    await writeField(profile, field, value);
  } catch {
    // Best effort only. The original write error is the actionable failure.
  }
}

export function createLinuxBackend(): CredentialStore {
  return {
    name: 'secret-service',
    async get(profile: string): Promise<CredentialBundle | null> {
      const token = await readField(profile, 'token');
      const secret = await readField(profile, 'secret');
      if (!token || !secret) return null;
      return { token, secret };
    },
    async set(profile: string, creds: CredentialBundle): Promise<void> {
      const previousToken = await readField(profile, 'token');
      const previousSecret = await readField(profile, 'secret');
      try {
        await writeField(profile, 'token', creds.token);
        await writeField(profile, 'secret', creds.secret);
      } catch (err) {
        await restoreField(profile, 'token', previousToken);
        await restoreField(profile, 'secret', previousSecret);
        throw err;
      }
    },
    async delete(profile: string): Promise<void> {
      await deleteField(profile, 'token');
      await deleteField(profile, 'secret');
    },
    describe(): CredentialStoreDescribe {
      return {
        backend: 'Secret Service (libsecret)',
        tag: 'secret-service',
        writable: true,
        notes: `Stored under service "${CREDENTIAL_SERVICE}" via secret-tool.`,
      };
    },
  };
}
