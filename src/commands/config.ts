import { Command } from 'commander';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { saveConfig, showConfig, listProfiles } from '../config.js';
import { isJsonMode, printJson, printErrorEnvelope } from '../utils/output.js';
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
    .option('--from-env-file <path>', 'Read SWITCHBOT_TOKEN and SWITCHBOT_SECRET from a dotenv file')
    .option('--from-op <tokenRef>', 'Read token via 1Password CLI (op read). Pair with --op-secret <ref>')
    .option('--op-secret <secretRef>', '1Password reference for the secret, used with --from-op')
    .addHelpText('after', `
Examples:
  $ switchbot config set-token <token> <secret>
  $ switchbot --profile work config set-token <token> <secret>
  $ switchbot config set-token --from-env-file ./.env
  $ switchbot config set-token --from-op op://vault/switchbot/token --op-secret op://vault/switchbot/secret

Files are written with mode 0600. Profiles live under ~/.switchbot/profiles/<name>.json.
`)
    .action(async (
      tokenArg: string | undefined,
      secretArg: string | undefined,
      options: { fromEnvFile?: string; fromOp?: string; opSecret?: string },
    ) => {
      let token = tokenArg;
      let secret = secretArg;

      if (options.fromEnvFile) {
        if (!fs.existsSync(options.fromEnvFile)) {
          const msg = `--from-env-file: file not found: ${options.fromEnvFile}`;
          if (isJsonMode()) {
            printErrorEnvelope({ code: 2, kind: 'usage', message: msg });
          } else {
            console.error(msg);
          }
          process.exit(2);
        }
        const parsed = parseEnvFile(options.fromEnvFile);
        token = token ?? parsed.token;
        secret = secret ?? parsed.secret;
      }

      if (options.fromOp) {
        if (!options.opSecret) {
          const msg = '--from-op requires --op-secret <ref> for the secret reference.';
          if (isJsonMode()) {
            printErrorEnvelope({ code: 2, kind: 'usage', message: msg });
          } else {
            console.error(msg);
          }
          process.exit(2);
        }
        try {
          token = readFromOp(options.fromOp);
          secret = readFromOp(options.opSecret);
        } catch (err) {
          const msg = `1Password CLI read failed: ${err instanceof Error ? err.message : String(err)}`;
          if (isJsonMode()) {
            printErrorEnvelope({ code: 1, kind: 'runtime', message: msg, hint: 'Ensure the "op" CLI is installed and authenticated (op signin).' });
          } else {
            console.error(msg);
            console.error('Ensure the "op" CLI is installed and authenticated (op signin).');
          }
          process.exit(1);
        }
      }

      if (!token || !secret) {
        const msg = 'Missing token/secret. Provide positional arguments or use --from-env-file / --from-op.';
        if (isJsonMode()) {
          printErrorEnvelope({ code: 2, kind: 'usage', message: msg });
        } else {
          console.error(msg);
        }
        process.exit(2);
      }

      saveConfig(token, secret);
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
      showConfig();
    });

  config
    .command('list-profiles')
    .description('List named profiles under ~/.switchbot/profiles/')
    .action(() => {
      const profiles = listProfiles();
      if (isJsonMode()) {
        printJson({ profiles });
        return;
      }
      if (profiles.length === 0) {
        console.log('No profiles. Create one with: switchbot --profile <name> config set-token ...');
        return;
      }
      for (const p of profiles) console.log(p);
    });
}
