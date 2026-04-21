import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getConfigPath } from './utils/flags.js';
import { getActiveProfile } from './lib/request-context.js';

export interface SwitchBotConfig {
  token: string;
  secret: string;
  label?: string;
  description?: string;
  limits?: { dailyCap?: number };
  defaults?: { flags?: string[] };
}

export interface ConfigSummary {
  source: 'env' | 'file' | 'none' | 'invalid';
  path?: string;
  token?: string;
  secret?: string;
  label?: string;
  description?: string;
  dailyCap?: number;
  defaultFlags?: string[];
}

function sanitizeOptionalString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Credential file resolution priority:
 *   1. --config <path> (absolute override — wins over everything)
 *   2. active profile (ALS request context, else --profile flag) → ~/.switchbot/profiles/<name>.json
 *   3. default        → ~/.switchbot/config.json
 *
 * Env SWITCHBOT_TOKEN+SWITCHBOT_SECRET still take priority inside loadConfig.
 */
export function configFilePath(): string {
  const override = getConfigPath();
  if (override) return path.resolve(override);
  const profile = getActiveProfile();
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
    const profile = getActiveProfile();
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
      console.error('Invalid config format. Please re-run: switchbot config set-token');
      process.exit(1);
    }
    return cfg;
  } catch {
    console.error('Failed to read config file. Please re-run: switchbot config set-token');
    process.exit(1);
  }
}

/**
 * Like loadConfig but returns null instead of exiting. Use this in code paths
 * that want graceful degradation (e.g. optional MQTT init in `mcp serve`).
 */
export function tryLoadConfig(): SwitchBotConfig | null {
  const envToken = process.env.SWITCHBOT_TOKEN;
  const envSecret = process.env.SWITCHBOT_SECRET;
  if (envToken && envSecret) return { token: envToken, secret: envSecret };

  const file = configFilePath();
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const cfg = JSON.parse(raw) as SwitchBotConfig;
    if (!cfg.token || !cfg.secret) return null;
    return cfg;
  } catch {
    return null;
  }
}

export function saveConfig(token: string, secret: string, extras?: Partial<SwitchBotConfig>): void {
  const file = configFilePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Merge with existing file so label/limits/defaults aren't dropped when the
  // user just rotates the token.
  let existing: Partial<SwitchBotConfig> = {};
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<SwitchBotConfig>;
    } catch {
      existing = {};
    }
  }

  const cfg: SwitchBotConfig = {
    token,
    secret,
    ...(existing.label ? { label: existing.label } : {}),
    ...(existing.description ? { description: existing.description } : {}),
    ...(existing.limits ? { limits: existing.limits } : {}),
    ...(existing.defaults ? { defaults: existing.defaults } : {}),
  };
  if (extras) {
    const label = sanitizeOptionalString(extras.label);
    const description = sanitizeOptionalString(extras.description);
    if (label !== undefined) cfg.label = label;
    if (description !== undefined) cfg.description = description;
    if (extras.limits) cfg.limits = { ...(cfg.limits ?? {}), ...extras.limits };
    if (extras.defaults) cfg.defaults = { ...(cfg.defaults ?? {}), ...extras.defaults };
  }

  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/**
 * Read a profile's metadata (label / description / limits / defaults) without
 * exposing the token/secret. Returns null when the file is missing or invalid.
 */
export function readProfileMeta(profile?: string): {
  label?: string;
  description?: string;
  limits?: { dailyCap?: number };
  defaults?: { flags?: string[] };
  path: string;
} | null {
  const file = profile
    ? profileFilePath(profile)
    : path.join(os.homedir(), '.switchbot', 'config.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const cfg = JSON.parse(raw) as SwitchBotConfig;
    return {
      label: cfg.label,
      description: cfg.description,
      limits: cfg.limits,
      defaults: cfg.defaults,
      path: file,
    };
  } catch {
    return null;
  }
}

export function showConfig(): void {
  const summary = getConfigSummary();
  if (summary.source === 'env') {
    console.log('Credential source: environment variables');
    console.log(`token : ${summary.token ?? ''}`);
    console.log(`secret: ${summary.secret ?? ''}`);
    return;
  }
  if (summary.source === 'none') {
    console.log('No credentials configured');
    return;
  }
  if (summary.source === 'invalid') {
    console.error('Failed to read config file');
    return;
  }
  console.log(`Credential source: ${summary.path}`);
  if (summary.label) console.log(`label : ${summary.label}`);
  if (summary.description) console.log(`desc  : ${summary.description}`);
  console.log(`token : ${summary.token ?? ''}`);
  console.log(`secret: ${summary.secret ?? ''}`);
  if (summary.dailyCap) console.log(`limits: dailyCap=${summary.dailyCap}`);
  if (summary.defaultFlags?.length) console.log(`defaults: ${summary.defaultFlags.join(' ')}`);
}

export function getConfigSummary(): ConfigSummary {
  const envToken = process.env.SWITCHBOT_TOKEN;
  const envSecret = process.env.SWITCHBOT_SECRET;

  if (envToken && envSecret) {
    return {
      source: 'env',
      token: maskCredential(envToken),
      secret: maskSecret(envSecret),
    };
  }

  const file = configFilePath();
  if (!fs.existsSync(file)) {
    return { source: 'none' };
  }

  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const cfg = JSON.parse(raw) as SwitchBotConfig;
    return {
      source: 'file',
      path: file,
      label: cfg.label,
      description: cfg.description,
      token: maskCredential(cfg.token),
      secret: maskSecret(cfg.secret),
      dailyCap: cfg.limits?.dailyCap,
      defaultFlags: cfg.defaults?.flags,
    };
  } catch {
    return { source: 'invalid', path: file };
  }
}

function maskCredential(token: string): string {
  if (token.length <= 8) return '*'.repeat(Math.max(4, token.length));
  return token.slice(0, 4) + '*'.repeat(token.length - 8) + token.slice(-4);
}

function maskSecret(secret: string): string {
  if (secret.length <= 4) return '****';
  return secret.slice(0, 2) + '*'.repeat(secret.length - 4) + secret.slice(-2);
}
