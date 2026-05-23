import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string | Record<string, unknown>;
}

export interface RegistrationResult {
  ok: boolean;
  exitCode: number;
  stderr: string;
}

function spawnStr(cmd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout: 10000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Single authoritative plugin ID resolver. Mirrors install.js:resolvePluginIdentifier. */
export function resolvePluginId(packageRoot: string): string {
  const manifestPath = path.join(packageRoot, '.codex-plugin', 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { name?: string };
      if (manifest.name) return `${manifest.name}@${path.basename(packageRoot)}`;
    } catch { /* fall through */ }
  }
  return `switchbot@${path.basename(packageRoot)}`;
}

export function checkCodexCli(): Check {
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  const lookup = spawnStr(lookupCmd, ['codex']);
  if (lookup.status !== 0) {
    return {
      name: 'codex-cli',
      status: 'fail',
      detail: {
        message: 'codex CLI not found on PATH. Install from https://github.com/openai/codex',
        hint: 'Install Codex, then re-run: switchbot install --agent codex',
      },
    };
  }
  const resolvedPath = lookup.stdout.trim().split(/\r?\n/)[0] ?? '';
  const ver = spawnStr('codex', ['--version']);
  const version = ver.status === 0 ? ver.stdout.trim() : null;
  return {
    name: 'codex-cli',
    status: 'ok',
    detail: { path: resolvedPath, version },
  };
}

export function checkCodexPluginNpm(): Check {
  const list = spawnStr('npm', ['list', '-g', '--json', '@cly-org/switchbot-codex-plugin']);
  let parsed: { dependencies?: Record<string, { version?: string }> } = {};
  try {
    parsed = JSON.parse(list.stdout) as typeof parsed;
  } catch {
    return { name: 'codex-plugin-npm', status: 'warn', detail: { message: 'npm list output could not be parsed' } };
  }
  const pkg = parsed?.dependencies?.['@cly-org/switchbot-codex-plugin'];
  if (!pkg) {
    return {
      name: 'codex-plugin-npm',
      status: 'warn',
      detail: { message: 'not installed globally — run: switchbot install --agent codex' },
    };
  }
  let packageRoot: string | null = null;
  const rootResult = spawnStr('npm', ['root', '-g']);
  if (rootResult.status === 0) {
    packageRoot = path.join(rootResult.stdout.trim(), '@cly-org', 'switchbot-codex-plugin');
  }
  return {
    name: 'codex-plugin-npm',
    status: 'ok',
    detail: { version: pkg.version ?? 'unknown', packageRoot },
  };
}

export function checkCodexPluginRegistered(): Check {
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  const lookup = spawnStr(lookupCmd, ['codex']);
  if (lookup.status !== 0) {
    return {
      name: 'codex-plugin-registered',
      status: 'warn',
      detail: { reason: 'codex-cli-missing', message: 'skipped: codex CLI not on PATH' },
    };
  }
  const listResult = spawnStr('codex', ['plugin', 'list']);
  if (listResult.status !== 0) {
    return {
      name: 'codex-plugin-registered',
      status: 'warn',
      detail: { message: 'codex plugin list failed — plugin registration unknown' },
    };
  }
  const raw = listResult.stdout;
  let found = false;
  let pluginName = '';
  try {
    const arr = JSON.parse(raw) as unknown[];
    const match = arr.find(
      (p) => typeof p === 'object' && p !== null && 'name' in p &&
        String((p as Record<string, unknown>).name).includes('switchbot'),
    );
    found = Boolean(match);
    pluginName = found ? String((match as Record<string, unknown>).name) : '';
  } catch {
    const line = raw.split('\n').find((l) => l.toLowerCase().includes('switchbot'));
    found = Boolean(line);
    pluginName = line?.trim() ?? '';
  }
  if (!found) {
    return {
      name: 'codex-plugin-registered',
      status: 'warn',
      detail: { message: 'switchbot plugin not in codex plugin list — run: switchbot install --agent codex' },
    };
  }
  return { name: 'codex-plugin-registered', status: 'ok', detail: { pluginName } };
}

export function runCodexPluginRegistration(packageRoot: string, pluginId: string): RegistrationResult {
  const mkt = spawnStr('codex', ['plugin', 'marketplace', 'add', packageRoot]);
  if (mkt.status !== 0) {
    return { ok: false, exitCode: mkt.status, stderr: mkt.stderr };
  }
  const add = spawnStr('codex', ['plugin', 'add', pluginId]);
  return { ok: add.status === 0, exitCode: add.status, stderr: add.stderr };
}
