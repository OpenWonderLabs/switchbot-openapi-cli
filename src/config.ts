import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfigPath, getProfile } from './utils/flags.js';

export interface SwitchBotConfig {
  token: string;
  secret: string;
}

/**
 * Credential file resolution priority:
 *   1. --config <path> (absolute override — wins over everything)
 *   2. --profile <name> → ~/.switchbot/profiles/<name>.json
 *   3. default        → ~/.switchbot/config.json
 *
 * Env SWITCHBOT_TOKEN+SWITCHBOT_SECRET still take priority inside loadConfig.
 */
export function configFilePath(): string {
  const override = getConfigPath();
  if (override) return path.resolve(override);
  const profile = getProfile();
  if (profile) {
    return path.join(os.homedir(), '.switchbot', 'profiles', `${profile}.json`);
  }
  return path.join(os.homedir(), '.switchbot', 'config.json');
}

export function profileFilePath(profile: string): string {
  return path.join(os.homedir(), '.switchbot', 'profiles', `${profile}.json`);
}

export function listProfiles(): string[] {
  const dir = path.join(os.homedir(), '.switchbot', 'profiles');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

export function loadConfig(): SwitchBotConfig {
  const envToken = process.env.SWITCHBOT_TOKEN;
  const envSecret = process.env.SWITCHBOT_SECRET;
  if (envToken && envSecret) {
    return { token: envToken, secret: envSecret };
  }

  const file = configFilePath();
  if (!fs.existsSync(file)) {
    const profile = getProfile();
    const hint = profile
      ? `No credentials configured for profile "${profile}". Run: switchbot --profile ${profile} config set-token <token> <secret>`
      : 'No credentials configured. Run: switchbot config set-token <token> <secret>';
    console.error(`${hint}\nOr set SWITCHBOT_TOKEN and SWITCHBOT_SECRET environment variables.`);
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const cfg = JSON.parse(raw) as SwitchBotConfig;
    if (!cfg.token || !cfg.secret) {
      console.error(`Invalid config format in ${file}. Please re-run: switchbot config set-token`);
      process.exit(1);
    }
    return cfg;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to read config file ${file}: ${errorMsg}`);
    console.error('Please re-run: switchbot config set-token');
    process.exit(1);
  }
}

/**
 * Explicit-profile config loader — unlike `loadConfig`, does NOT read
 * `process.argv`, so it's safe for server contexts (MCP HTTP transport)
 * where each request carries its own profile hint. Throws instead of
 * calling `process.exit` so the caller can respond to the request.
 */
export function loadConfigForProfile(profile?: string): SwitchBotConfig {
  const envToken = process.env.SWITCHBOT_TOKEN;
  const envSecret = process.env.SWITCHBOT_SECRET;
  if (!profile && envToken && envSecret) {
    return { token: envToken, secret: envSecret };
  }

  const file = profile
    ? profileFilePath(profile)
    : path.join(os.homedir(), '.switchbot', 'config.json');

  if (!fs.existsSync(file)) {
    throw new Error(
      profile
        ? `No credentials configured for profile "${profile}" (expected file: ${file})`
        : `No credentials configured (expected file: ${file})`,
    );
  }

  const raw = fs.readFileSync(file, 'utf-8');
  const cfg = JSON.parse(raw) as SwitchBotConfig;
  if (!cfg.token || !cfg.secret) {
    throw new Error(`Invalid config format in ${file}`);
  }
  return cfg;
}

export function saveConfig(token: string, secret: string): void {
  const file = configFilePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const cfg: SwitchBotConfig = { token, secret };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function showConfig(): void {
  const envToken = process.env.SWITCHBOT_TOKEN;
  const envSecret = process.env.SWITCHBOT_SECRET;

  if (envToken && envSecret) {
    console.log('Credential source: environment variables');
    console.log(`token : ${envToken}`);
    console.log(`secret: ${maskSecret(envSecret)}`);
    return;
  }

  const file = configFilePath();
  if (!fs.existsSync(file)) {
    console.log('No credentials configured');
    return;
  }

  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const cfg = JSON.parse(raw) as SwitchBotConfig;
    console.log(`Credential source: ${file}`);
    console.log(`token : ${cfg.token}`);
    console.log(`secret: ${maskSecret(cfg.secret)}`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to read config file ${file}: ${errorMsg}`);
  }
}

function maskSecret(secret: string): string {
  if (secret.length <= 4) return '****';
  return secret.slice(0, 2) + '*'.repeat(secret.length - 4) + secret.slice(-2);
}
