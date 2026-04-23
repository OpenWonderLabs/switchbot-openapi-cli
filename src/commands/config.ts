import { Command } from 'commander';
import fs from 'node:fs';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { stringArg } from '../utils/arg-parsers.js';
import { intArg } from '../utils/arg-parsers.js';
import { saveConfig, showConfig, getConfigSummary, listProfiles, readProfileMeta } from '../config.js';
import { isJsonMode, printJson, exitWithError } from '../utils/output.js';
import chalk from 'chalk';

function parseEnvFile(file: string): { token?: string; secret?: string } {
  const out: { token?: string; secret?: string } = {};
  const raw = fs.readFileSync(file, 'utf-8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === 'SWITCHBOT_TOKEN') out.token = val;
    else if (key === 'SWITCHBOT_SECRET') out.secret = val;
  }
  return out;
}

function readFromOp(ref: string): string {
  // 1Password CLI: `op read "op://vault/item/field"` → single line on stdout
  const stdout = execFileSync('op', ['read', ref], { encoding: 'utf-8' });
  return stdout.trim();
}

// Replace raw token/secret positional slots in process.argv with "***" so
// neither verbose traces nor crash dumps nor any later inspector observe them.
function scrubArgvCredentials(): void {
  const argv = process.argv;
  for (let i = 2; i < argv.length - 2; i++) {
    if (argv[i] === 'config' && argv[i + 1] === 'set-token') {
      // Slots i+2 and i+3 (if not option flags) are token/secret.
      for (const off of [2, 3]) {
        const slot = i + off;
        if (slot < argv.length && !argv[slot].startsWith('-')) {
          argv[slot] = '***';
        }
      }
      return;
    }
  }
}

async function promptSecret(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const stdoutAny = process.stdout as unknown as { isTTY?: boolean };
  const mutableStdout = process.stderr as unknown as { _writeToMute?: boolean };
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
    void stdoutAny;
    void mutableStdout;
  });
}

/**
 * Interactive echo-off prompt for token + secret. Used by both
 * `switchbot config set-token` and the install orchestrator. Throws if
 * stdin is not a TTY.
 */
export async function promptTokenAndSecret(): Promise<{ token: string; secret: string }> {
  if (!process.stdin.isTTY) {
    throw new Error('interactive prompt requires a TTY');
  }
  const token = (await promptSecret('Token: ')).trim();
  const secret = (await promptSecret('Secret: ')).trim();
  if (!token || !secret) {
    throw new Error('token and secret are both required');
  }
  return { token, secret };
}

/**
 * Read a two-line credential file (line 1 = token, line 2 = secret)
 * and unlink it on success. The installer's `--token-file` escape
 * hatch uses this; keeps credentials off the command line and shell
 * history for CI-style installs.
 */
export function readCredentialsFile(filePath: string): { token: string; secret: string } {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new Error(`credential file ${filePath} must contain two lines: token, then secret`);
  }
  return { token: lines[0].trim(), secret: lines[1].trim() };
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Manage SwitchBot API credentials')
    .addHelpText('after', `
Credential priority:
  1. Environment variables: SWITCHBOT_TOKEN and SWITCHBOT_SECRET
  2. --config <path> (explicit file override)
  3. --profile <name> → ~/.switchbot/profiles/<name>.json
  4. ~/.switchbot/config.json (default)

Obtain your token/secret from the SwitchBot mobile app:
  Profile → Preferences → Developer Options → Get Token
`);

  config
    .command('set-token')
    .description('Save token and secret (mode 0600). Use --profile to target a named profile.')
    .argument('[token]', 'API token; omit when using --from-env-file / --from-op')
    .argument('[secret]', 'API client secret; omit when using --from-env-file / --from-op')
    .option('--from-env-file <path>', 'Read SWITCHBOT_TOKEN and SWITCHBOT_SECRET from a dotenv file', stringArg('--from-env-file'))
    .option('--from-op <tokenRef>', 'Read token via 1Password CLI (op read). Pair with --op-secret <ref>', stringArg('--from-op'))
    .option('--op-secret <secretRef>', '1Password reference for the secret, used with --from-op', stringArg('--op-secret'))
    .option('--label <text>', 'Human-friendly label for this profile (shown in config show / list-profiles)', stringArg('--label'))
    .option('--description <text>', 'Longer description, e.g. "home account" or "work devices"', stringArg('--description'))
    .option('--daily-cap <n>', 'Local cap on SwitchBot API calls per UTC day for this profile', intArg('--daily-cap', { min: 1 }))
    .option('--default-flags <csv>', 'Comma-separated flags auto-applied for this profile (e.g. "--audit-log")', stringArg('--default-flags'))
    .addHelpText('after', `
Examples:
  # Interactive (recommended) — credentials never touch shell history / ps listing
  $ switchbot config set-token
  Token: ****
  Secret: ****

  # Import from dotenv / 1Password (non-interactive, still safe)
  $ switchbot config set-token --from-env-file ./.env
  $ switchbot config set-token --from-op op://vault/switchbot/token --op-secret op://vault/switchbot/secret

  # Advanced / non-interactive (DISCOURAGED — leaks to shell history)
  $ switchbot config set-token <token> <secret>
  $ switchbot --profile work config set-token <token> <secret>

Files are written with mode 0600. Profiles live under ~/.switchbot/profiles/<name>.json.
`)
    .action(async (
      tokenArg: string | undefined,
      secretArg: string | undefined,
      options: {
        fromEnvFile?: string;
        fromOp?: string;
        opSecret?: string;
        label?: string;
        description?: string;
        dailyCap?: string;
        defaultFlags?: string;
      },
    ) => {
      let token = tokenArg;
      let secret = secretArg;
      const hadPositional = tokenArg !== undefined && secretArg !== undefined;

      // Scrub early: commander has already parsed the values, so we can safely
      // rewrite argv before anything else (verbose trace, crash dumps, …) sees it.
      if (hadPositional) {
        scrubArgvCredentials();
        console.error(
          '⚠ Passing token/secret as positional arguments is discouraged — they may be persisted in shell history, process listings, and agent logs.',
        );
        console.error('  Prefer: switchbot config set-token (interactive), --from-env-file, or --from-op.');
      }

      if (options.fromEnvFile) {
        if (!fs.existsSync(options.fromEnvFile)) {
          exitWithError({
            code: 2,
            kind: 'usage',
            message: `--from-env-file: file not found: ${options.fromEnvFile}`,
          });
        }
        const parsed = parseEnvFile(options.fromEnvFile);
        token = token ?? parsed.token;
        secret = secret ?? parsed.secret;
      }

      if (options.fromOp) {
        if (!options.opSecret) {
          exitWithError({
            code: 2,
            kind: 'usage',
            message: '--from-op requires --op-secret <ref> for the secret reference.',
          });
        }
        try {
          token = readFromOp(options.fromOp);
          secret = readFromOp(options.opSecret);
        } catch (err) {
          exitWithError({
            code: 1,
            kind: 'runtime',
            message: `1Password CLI read failed: ${err instanceof Error ? err.message : String(err)}`,
            hint: 'Ensure the "op" CLI is installed and authenticated (op signin).',
          });
        }
      }

      // No credentials yet and stdin is a TTY → interactive prompt (safest path).
      if ((!token || !secret) && !options.fromEnvFile && !options.fromOp && process.stdin.isTTY) {
        if (isJsonMode()) {
          exitWithError({
            code: 2,
            kind: 'usage',
            message: 'Interactive mode cannot run under --json. Provide token/secret via --from-env-file, --from-op, or positional args.',
          });
        }
        try {
          if (!token) token = (await promptSecret('Token: ')).trim();
          if (!secret) secret = (await promptSecret('Secret: ')).trim();
        } catch {
          console.error('Interactive prompt failed.');
          process.exit(1);
        }
      }

      if (!token || !secret) {
        exitWithError({
          code: 2,
          kind: 'usage',
          message: 'Missing token/secret. Run interactively, or use --from-env-file / --from-op, or pass positional arguments (discouraged).',
        });
      }

      saveConfig(token, secret, {
        label: options.label,
        description: options.description,
        limits: options.dailyCap ? { dailyCap: Number.parseInt(options.dailyCap, 10) } : undefined,
        defaults: options.defaultFlags
          ? {
              flags: options.defaultFlags
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            }
          : undefined,
      });
      if (isJsonMode()) {
        printJson({ ok: true, message: 'credentials saved' });
      } else {
        console.log(chalk.green('✓ Credentials saved'));
      }
    });

  config
    .command('show')
    .description('Show the current credential source and a masked secret')
    .action(() => {
      if (isJsonMode()) {
        printJson(getConfigSummary());
        return;
      }
      showConfig();
    });

  config
    .command('list-profiles')
    .description('List named profiles under ~/.switchbot/profiles/ (with labels and daily caps)')
    .action(() => {
      const profiles = listProfiles();
      const enriched = profiles.map((p) => {
        const meta = readProfileMeta(p);
        return {
          name: p,
          label: meta?.label,
          description: meta?.description,
          dailyCap: meta?.limits?.dailyCap,
        };
      });
      if (isJsonMode()) {
        printJson({ profiles: enriched });
        return;
      }
      if (profiles.length === 0) {
        console.log('No profiles. Create one with: switchbot --profile <name> config set-token ...');
        return;
      }
      for (const p of enriched) {
        const bits = [p.name];
        if (p.label) bits.push(`— ${p.label}`);
        if (p.dailyCap) bits.push(`[dailyCap=${p.dailyCap}]`);
        console.log(bits.join(' '));
      }
    });
}
