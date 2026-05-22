import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import chalk from 'chalk';
import { isJsonMode, printJson } from '../utils/output.js';
import { isDryRun, getConfigPath } from '../utils/flags.js';
import { selectCredentialStore } from '../credentials/keychain.js';
import { listProfiles } from '../config.js';
import { getActiveProfile } from '../lib/request-context.js';

const BASE = path.join(os.homedir(), '.switchbot');

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

function removeItem(itemPath: string, type: 'file' | 'dir'): { status: 'removed' | 'absent' | 'failed'; error?: string } {
  if (!fs.existsSync(itemPath)) return { status: 'absent' };
  try {
    if (type === 'dir') {
      fs.rmSync(itemPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(itemPath);
    }
    return { status: 'removed' };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
}

function makeDataItems(dataDir: string): Array<{ key: string; label: string; path: string; type: 'file' | 'dir' }> {
  // quota / device-history / audit are always global (their writers hardcode ~/.switchbot regardless of --config)
  return [
    { key: 'cache',          label: 'Device cache',       path: path.join(dataDir, 'cache'),            type: 'dir'  },
    { key: 'devices',        label: 'Devices list cache', path: path.join(dataDir, 'devices.json'),     type: 'file' },
    { key: 'quota',          label: 'Quota counter',      path: path.join(BASE, 'quota.json'),          type: 'file' },
    { key: 'device-history', label: 'Device history',     path: path.join(BASE, 'device-history'),      type: 'dir'  },
    { key: 'device-meta',    label: 'Device metadata',    path: path.join(dataDir, 'device-meta.json'), type: 'file' },
    { key: 'status',         label: 'Status cache',       path: path.join(dataDir, 'status.json'),      type: 'file' },
    { key: 'audit',          label: 'Audit log',          path: path.join(BASE, 'audit.log'),           type: 'file' },
  ];
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

      const configOverride = getConfigPath();
      const dataDir = configOverride
        ? path.dirname(path.resolve(configOverride))
        : BASE;
      const dataItems = makeDataItems(dataDir);

      if (isDryRun()) {
        const preview: string[] = [];
        if (!opts.keepCredentials) {
          const profilesToWipe = [profile, ...extraProfiles.filter(p => p !== profile)];
          for (const p of profilesToWipe) preview.push(`Credentials (${p})`);
          preview.push('Config file (config.json)');
          if (!configOverride) preview.push('Profiles directory');
        }
        for (const item of dataItems) preview.push(item.label);
        if (isJsonMode()) {
          printJson({ dryRun: true, wouldDelete: preview });
        } else {
          console.error(chalk.dim('[dry-run] Would delete:'));
          for (const p of preview) console.error(chalk.dim(`  • ${p}`));
        }
        return;
      }

      if (!opts.yes) {
        console.error(chalk.yellow('This will permanently delete:'));
        if (!opts.keepCredentials) {
          console.error(`  • Credentials for profile "${profile}"${extraProfiles.length ? ` and ${extraProfiles.length} other profile(s)` : ''} (keychain + config files)`);
        }
        for (const item of dataItems) {
          console.error(`  • ${item.label}`);
        }
        console.error('');
        const ok = await confirm('Continue?');
        if (!ok) {
          console.error('Aborted.');
          return;
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
            results.push({ key: `creds:${p}`, label: `Credentials (${p})`, status: 'failed' });
          }
        }

        // Also remove file-based credential files
        const configFile = configOverride
          ? path.resolve(configOverride)
          : path.join(BASE, 'config.json');
        const cfgStatus = removeItem(configFile, 'file');
        if (cfgStatus.status !== 'absent') {
          results.push({ key: 'config-file', label: 'Config file (config.json)', ...cfgStatus });
        }
        if (!configOverride) {
          const profilesDir = path.join(BASE, 'profiles');
          const profStatus = removeItem(profilesDir, 'dir');
          if (profStatus.status !== 'absent') {
            results.push({ key: 'profiles-dir', label: 'Profiles directory', ...profStatus });
          }
        }
      }

      // ── Data files ───────────────────────────────────────────────────────────
      for (const item of dataItems) {
        const result = removeItem(item.path, item.type);
        results.push({ key: item.key, label: item.label, ...result });
      }

      if (isJsonMode()) {
        printJson({ reset: true, results });
        if (results.some(r => r.status === 'failed')) process.exit(1);
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
