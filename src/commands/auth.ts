/**
 * `switchbot auth` command group (v2.9 preview, part of Phase 3A).
 *
 * Surfaces the credential store abstraction added in F1/F2 so users
 * can introspect, write to, delete from, and migrate into the OS
 * keychain without editing `~/.switchbot/config.json` by hand.
 *
 * All subcommands honour the active `--profile <name>` flag so a user
 * who runs multiple accounts keeps the keychain entries cleanly
 * partitioned.
 *
 * No credential material is ever printed in plain text. `get` emits
 * a masked summary only; `set` reads via a TTY prompt (echo-off) or a
 * file passed via `--stdin-file <path>`. `migrate` never touches the
 * keychain unless the backend reports `writable: true`.
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { exitWithError, isJsonMode, printJson } from '../utils/output.js';
import { stringArg } from '../utils/arg-parsers.js';
import { getActiveProfile } from '../lib/request-context.js';
import {
  CredentialBundle,
  selectCredentialStore,
} from '../credentials/keychain.js';

function activeProfile(): string {
  return getActiveProfile() ?? 'default';
}

function maskValue(value: string): string {
  if (value.length === 0) return '';
  if (value.length <= 4) return '*'.repeat(value.length);
  const head = value.slice(0, 2);
  const tail = value.slice(-2);
  return `${head}${'*'.repeat(Math.max(4, value.length - 4))}${tail}`;
}

async function promptSecret(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  return new Promise((resolve) => {
    process.stderr.write(question);
    const stdin = process.stdin as unknown as NodeJS.ReadStream & { setRawMode?: (m: boolean) => void };
    let answer = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          if (stdin.setRawMode) stdin.setRawMode(false);
          stdin.pause();
          process.stderr.write('\n');
          rl.close();
          resolve(answer);
          return;
        }
        if (ch === '\u0003') {
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          answer = answer.slice(0, -1);
          continue;
        }
        answer += ch;
      }
    };
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

function readStdinFile(filePath: string): CredentialBundle {
  if (!fs.existsSync(filePath)) {
    exitWithError({
      code: 2,
      kind: 'usage',
      message: `--stdin-file: file not found: ${filePath}`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    exitWithError({
      code: 2,
      kind: 'usage',
      message: `--stdin-file: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as { token?: unknown }).token !== 'string' ||
    typeof (parsed as { secret?: unknown }).secret !== 'string'
  ) {
    exitWithError({
      code: 2,
      kind: 'usage',
      message: '--stdin-file must contain a JSON object with "token" and "secret" strings.',
    });
  }
  const { token, secret } = parsed as { token: string; secret: string };
  if (!token || !secret) {
    exitWithError({
      code: 2,
      kind: 'usage',
      message: '--stdin-file: token and secret must be non-empty.',
    });
  }
  return { token, secret };
}

type MigrationSourceCleanup = 'kept' | 'deleted' | 'scrubbed';

function cleanupMigratedSourceFile(sourceFile: string, parsed: Record<string, unknown>): MigrationSourceCleanup {
  const next = { ...parsed };
  delete next.token;
  delete next.secret;

  if (Object.keys(next).length === 0) {
    fs.unlinkSync(sourceFile);
    return 'deleted';
  }

  fs.writeFileSync(sourceFile, JSON.stringify(next, null, 2), { mode: 0o600 });
  return 'scrubbed';
}

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command('auth')
    .description('Manage SwitchBot credentials in the OS keychain (preview)');

  const keychain = auth
    .command('keychain')
    .description('OS keychain backend (describe/get/set/delete/migrate)');

  keychain
    .command('describe')
    .description('Show which credential backend is active on this machine')
    .action(async () => {
      const store = await selectCredentialStore();
      const desc = store.describe();
      if (isJsonMode()) {
        printJson(desc);
        return;
      }
      console.log(`backend : ${desc.backend}`);
      console.log(`tag     : ${desc.tag}`);
      console.log(`writable: ${desc.writable ? 'yes' : 'no'}`);
      if (desc.notes) console.log(`notes   : ${desc.notes}`);
    });

  keychain
    .command('get')
    .description('Check whether the active profile has credentials (masked output)')
    .action(async () => {
      const profile = activeProfile();
      const store = await selectCredentialStore();
      const creds = await store.get(profile);
      if (!creds) {
        if (isJsonMode()) {
          printJson({ profile, backend: store.name, present: false });
          return;
        }
        console.log(`No credentials found for profile "${profile}" in backend "${store.name}".`);
        process.exit(1);
      }
      if (isJsonMode()) {
        printJson({
          profile,
          backend: store.name,
          present: true,
          token: { length: creds.token.length, masked: maskValue(creds.token) },
          secret: { length: creds.secret.length, masked: maskValue(creds.secret) },
        });
        return;
      }
      console.log(`profile : ${profile}`);
      console.log(`backend : ${store.name}`);
      console.log(`token   : ${maskValue(creds.token)} (${creds.token.length} chars)`);
      console.log(`secret  : ${maskValue(creds.secret)} (${creds.secret.length} chars)`);
    });

  keychain
    .command('set')
    .description('Write token and secret to the keychain for the active profile')
    .option('--stdin-file <path>', 'Read {"token","secret"} JSON from file (for non-TTY environments)', stringArg('--stdin-file'))
    .action(async (options: { stdinFile?: string }) => {
      const profile = activeProfile();
      const store = await selectCredentialStore();

      if (!store.describe().writable) {
        exitWithError({
          code: 1,
          kind: 'runtime',
          message: `backend "${store.name}" is not writable on this machine`,
          hint: 'Install the OS keychain helper or use ~/.switchbot/config.json directly.',
        });
      }

      let bundle: CredentialBundle;
      if (options.stdinFile) {
        bundle = readStdinFile(options.stdinFile);
      } else if (process.stdin.isTTY) {
        const token = (await promptSecret('Token : ')).trim();
        const secret = (await promptSecret('Secret: ')).trim();
        if (!token || !secret) {
          exitWithError({
            code: 2,
            kind: 'usage',
            message: 'Both token and secret are required.',
          });
        }
        bundle = { token, secret };
      } else {
        exitWithError({
          code: 2,
          kind: 'usage',
          message: 'Non-TTY input requires --stdin-file <path>.',
        });
      }

      try {
        await store.set(profile, bundle!);
      } catch (err) {
        exitWithError({
          code: 1,
          kind: 'runtime',
          message: `keychain write failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      if (isJsonMode()) {
        printJson({ profile, backend: store.name, written: true });
        return;
      }
      console.log(`Stored credentials for profile "${profile}" in backend "${store.name}".`);
    });

  keychain
    .command('delete')
    .description('Remove credentials for the active profile from the keychain')
    .option('--yes', 'Skip the interactive confirmation prompt')
    .action(async (options: { yes?: boolean }) => {
      const profile = activeProfile();
      const store = await selectCredentialStore();

      if (!options.yes && process.stdin.isTTY) {
        const reply = (await promptSecret(`Delete credentials for profile "${profile}" from backend "${store.name}"? type DELETE to confirm: `)).trim();
        if (reply !== 'DELETE') {
          if (isJsonMode()) {
            printJson({ profile, backend: store.name, deleted: false, reason: 'cancelled' });
            return;
          }
          console.log('Aborted.');
          process.exit(0);
        }
      }

      try {
        await store.delete(profile);
      } catch (err) {
        exitWithError({
          code: 1,
          kind: 'runtime',
          message: `keychain delete failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      if (isJsonMode()) {
        printJson({ profile, backend: store.name, deleted: true });
        return;
      }
      console.log(`Deleted credentials for profile "${profile}" in backend "${store.name}".`);
    });

  keychain
    .command('migrate')
    .description('Copy credentials from ~/.switchbot/config.json (or --profile) into the keychain')
    .option('--delete-file', 'Remove the source credential file when possible; otherwise scrub token/secret and keep metadata')
    .action(async (options: { deleteFile?: boolean }) => {
      const profile = activeProfile();
      const store = await selectCredentialStore();

      if (!store.describe().writable) {
        exitWithError({
          code: 1,
          kind: 'runtime',
          message: `backend "${store.name}" is not writable on this machine`,
        });
      }

      const sourceFile = profile === 'default'
        ? path.join(os.homedir(), '.switchbot', 'config.json')
        : path.join(os.homedir(), '.switchbot', 'profiles', `${profile}.json`);

      if (!fs.existsSync(sourceFile)) {
        exitWithError({
          code: 2,
          kind: 'usage',
          message: `source file not found: ${sourceFile}`,
          hint: 'Run "switchbot config set-token" first or use "switchbot auth keychain set" directly.',
        });
      }

      let parsed: Record<string, unknown>;
      try {
        const raw = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new Error('expected a JSON object');
        }
        parsed = raw as Record<string, unknown>;
      } catch (err) {
        exitWithError({
          code: 1,
          kind: 'runtime',
          message: `failed to parse ${sourceFile}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      const token = typeof parsed!.token === 'string' ? parsed!.token : '';
      const secret = typeof parsed!.secret === 'string' ? parsed!.secret : '';
      if (!token || !secret) {
        exitWithError({
          code: 1,
          kind: 'runtime',
          message: `source file missing token or secret: ${sourceFile}`,
        });
      }

      try {
        await store.set(profile, { token, secret });
      } catch (err) {
        exitWithError({
          code: 1,
          kind: 'runtime',
          message: `keychain write failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      let cleanup: MigrationSourceCleanup = 'kept';
      if (options.deleteFile) {
        try {
          cleanup = cleanupMigratedSourceFile(sourceFile, parsed);
        } catch (err) {
          // Non-fatal: migration succeeded, we just couldn't clean up.
          console.error(`warning: could not remove ${sourceFile}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (isJsonMode()) {
        printJson({
          profile,
          backend: store.name,
          migrated: true,
          sourceFile,
          sourceDeleted: cleanup === 'deleted',
          sourceScrubbed: cleanup === 'scrubbed',
        });
        return;
      }
      console.log(`Migrated profile "${profile}" to backend "${store.name}".`);
      const cleanupNote = cleanup === 'deleted'
        ? ' (deleted)'
        : cleanup === 'scrubbed'
        ? ' (credentials removed; metadata kept)'
        : '';
      console.log(`source: ${sourceFile}${cleanupNote}`);
      if (!options.deleteFile) {
        console.log('Source file kept — pass --delete-file on the next run to remove it.');
      }
    });
}
