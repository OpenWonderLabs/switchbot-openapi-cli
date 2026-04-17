import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfigPath } from './utils/flags.js';

export interface SwitchBotConfig {
  token: string;
  secret: string;
}

function configFilePath(): string {
  const override = getConfigPath();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.switchbot', 'config.json');
}

export function loadConfig(): SwitchBotConfig {
  // Environment variables take priority (useful for CI)
  const envToken = process.env.SWITCHBOT_TOKEN;
  const envSecret = process.env.SWITCHBOT_SECRET;
  if (envToken && envSecret) {
    return { token: envToken, secret: envSecret };
  }

  const file = configFilePath();
  if (!fs.existsSync(file)) {
    console.error(
      'No credentials configured. Please run: switchbot config set-token <token> <secret>\n' +
      'Or set the SWITCHBOT_TOKEN and SWITCHBOT_SECRET environment variables.'
    );
    process.exit(1);
  }

  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const cfg = JSON.parse(raw) as SwitchBotConfig;
    if (!cfg.token || !cfg.secret) {
      console.error('Invalid config.json format. Please re-run: switchbot config set-token');
      process.exit(1);
    }
    return cfg;
  } catch {
    console.error('Failed to read config file. Please re-run: switchbot config set-token');
    process.exit(1);
  }
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
  } catch {
    console.error('Failed to read config file');
  }
}

function maskSecret(secret: string): string {
  if (secret.length <= 4) return '****';
  return secret.slice(0, 2) + '*'.repeat(secret.length - 4) + secret.slice(-2);
}
