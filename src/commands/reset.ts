import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import chalk from 'chalk';
import { isJsonMode, printJson } from '../utils/output.js';
import { selectCredentialStore } from '../credentials/keychain.js';
import { listProfiles } from '../config.js';
import { getActiveProfile } from '../lib/request-context.js';

const BASE = path.join(os.homedir(), '.switchbot');

const DATA_ITEMS = [
  { key: 'cache',          label: 'Device cache',      path: path.join(BASE, 'cache'),          type: 'dir'  },
  { key: 'devices',        label: 'Devices list cache', path: path.join(BASE, 'devices.json'),   type: 'file' },
  { key: 'quota',          label: 'Quota counter',      path: path.join(BASE, 'quota.json'),     type: 'file' },
  { key: 'device-history', label: 'Device history',     path: path.join(BASE, 'device-history'), type: 'dir'  },
  { key: 'device-meta',    label: 'Device metadata',    path: path.join(BASE, 'device-meta.json'), type: 'file' },
  { key: 'audit',          label: 'Audit log',          path: path.join(BASE, 'audit.log'),      type: 'file' },
] as const;

type ItemKey = typeof DATA_ITEMS[number]['key'];

type ResetResult = { key: string; label: string; status: 'removed' | 'absent' | 'failed'; error?: string };

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'y' || ans.trim().toLowerCase() === 'yes');
    });
  });
}

function removeItem(itemPath: string, type: 'file' | 'dir'): 'removed' | 'absent' | 'failed' {
  if (!fs.existsSync(itemPath)) return 'absent';
  try {
    if (type === 'dir') {
      fs.rmSync(itemPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(itemPath);
    }
    return 'removed';
  } catch {
    return 'failed';
  }
}

function statusIcon(status: ResetResult['status']): string {
  if (status === 'removed') return chalk.green('✓');
  if (status === 'absent')  return chalk.dim('–');
  return chalk.red('✗');
}

export function registerResetCommand(program: Command): void {
  program
    .command('reset')
    .description('Clear all local account data: credentials, cache, quota, history, and metadata')
    .option('-y, --yes', 'skip confirmation prompt')
    .option('--keep-credentials', 'preserve keychain/config credentials, only clear data files')
    .action(async (opts: { yes?: boolean; keepCredentials?: boolean }) => {
      const profile = getActiveProfile() ?? 'default';
      const extraProfiles = listProfiles();

      if (!opts.yes) {
        console.error(chalk.yellow('This will permanently delete:'));
        if (!opts.keepCredentials) {
          console.error(`  • Credentials for profile "${profile}"${extraProfiles.length ? ` and ${extraProfiles.length} other profile(s)` : ''} (keychain + config files)`);
        }
        for (const item of DATA_ITEMS) {
          console.error(`  • ${item.label}`);
        }
        console.error('');
        const ok = await confirm('Continue?');
        if (!ok) {
          console.error('Aborted.');
          process.exit(0);
        }
      }

      const results: ResetResult[] = [];

      // ── Credentials ──────────────────────────────────────────────────────────
      if (!opts.keepCredentials) {
        const profilesToWipe = [profile, ...extraProfiles.filter(p => p !== profile)];
        const store = await selectCredentialStore();

        for (const p of profilesToWipe) {
          try {
            await store.delete(p);
            results.push({ key: `creds:${p}`, label: `Credentials (${p})`, status: 'removed' });
          } catch {
            results.push({ key: `creds:${p}`, label: `Credentials (${p})`, status: 'absent' });
          }
        }

        // Also remove file-based credential files
        const configFile = path.join(BASE, 'config.json');
        const profilesDir = path.join(BASE, 'profiles');
        const cfgStatus = removeItem(configFile, 'file');
        if (cfgStatus !== 'absent') {
          results.push({ key: 'config-file', label: 'Config file (config.json)', status: cfgStatus });
        }
        const profStatus = removeItem(profilesDir, 'dir');
        if (profStatus !== 'absent') {
          results.push({ key: 'profiles-dir', label: 'Profiles directory', status: profStatus });
        }
      }

      // ── Data files ───────────────────────────────────────────────────────────
      for (const item of DATA_ITEMS) {
        const status = removeItem(item.path, item.type as 'file' | 'dir');
        results.push({ key: item.key, label: item.label, status });
      }

      if (isJsonMode()) {
        printJson({ reset: true, results });
        return;
      }

      console.error('');
      for (const r of results) {
        const icon = statusIcon(r.status);
        const statusText = r.status === 'removed' ? chalk.green('removed')
          : r.status === 'absent' ? chalk.dim('not found')
          : chalk.red(`failed${r.error ? ': ' + r.error : ''}`);
        console.error(`  ${icon} ${r.label}: ${statusText}`);
      }

      const removed = results.filter(r => r.status === 'removed').length;
      const failed  = results.filter(r => r.status === 'failed').length;
      console.error('');

      if (failed > 0) {
        console.error(chalk.red(`Reset complete with ${failed} error(s). Some items may need manual cleanup.`));
        process.exit(1);
      } else {
        console.error(chalk.green(`Reset complete. ${removed} item(s) removed.`));
      }
    });
}
