/**
 * macOS Keychain backend.
 *
 * Wraps the built-in `security(1)` CLI so `npm install` stays free of
 * native compile steps. Service name is shared with the Linux and
 * Windows backends (`com.openclaw.switchbot`), so a user migrating a
 * config between machines sees the same lookup shape.
 *
 * Errors never leak credential material — `add-generic-password`
 * receives the password via `-w <value>` on argv, which is visible in
 * `ps` to the current user but not persisted anywhere, and any stderr
 * we surface back up is bounded to the library's own messages
 * (`password not found`, `could not be added`, etc.) rather than our
 * input values.
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

export async function macOsAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  const res = await run('which', ['security']);
  return res.code === 0 && res.stdout.trim().length > 0;
}

async function readField(profile: string, field: 'token' | 'secret'): Promise<string | null> {
  const account = accountFor(profile, field);
  const res = await run('security', [
    'find-generic-password',
    '-s', CREDENTIAL_SERVICE,
    '-a', account,
    '-w',
  ]);
  if (res.code !== 0) return null;
  const value = res.stdout.replace(/\n$/, '');
  return value.length > 0 ? value : null;
}

async function writeField(profile: string, field: 'token' | 'secret', value: string): Promise<void> {
  const account = accountFor(profile, field);
  const res = await run('security', [
    'add-generic-password',
    '-U', // update if exists
    '-s', CREDENTIAL_SERVICE,
    '-a', account,
    '-w', value,
  ]);
  if (res.code !== 0) {
    throw new KeychainError('keychain', 'set', `security(1) exit ${res.code}`);
  }
}

async function deleteField(profile: string, field: 'token' | 'secret'): Promise<void> {
  const account = accountFor(profile, field);
  const res = await run('security', [
    'delete-generic-password',
    '-s', CREDENTIAL_SERVICE,
    '-a', account,
  ]);
  // exit 44 = "The specified item could not be found" — tolerate as idempotent delete.
  if (res.code !== 0 && res.code !== 44) {
    throw new KeychainError('keychain', 'delete', `security(1) exit ${res.code}`);
  }
}

export function createMacOsBackend(): CredentialStore {
  return {
    name: 'keychain',
    async get(profile: string): Promise<CredentialBundle | null> {
      const token = await readField(profile, 'token');
      const secret = await readField(profile, 'secret');
      if (!token || !secret) return null;
      return { token, secret };
    },
    async set(profile: string, creds: CredentialBundle): Promise<void> {
      await writeField(profile, 'token', creds.token);
      await writeField(profile, 'secret', creds.secret);
    },
    async delete(profile: string): Promise<void> {
      await deleteField(profile, 'token');
      await deleteField(profile, 'secret');
    },
    describe(): CredentialStoreDescribe {
      return {
        backend: 'macOS Keychain',
        tag: 'keychain',
        writable: true,
        notes: `Stored under service "${CREDENTIAL_SERVICE}" via security(1).`,
      };
    },
  };
}
