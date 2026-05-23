import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

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

export interface RegisterCodexPluginResult {
  ok: boolean;
  pluginId: string;
  packageRoot: string;
  error?: string;
  exitCode?: number;
  stderr?: string;
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
  const list = spawnStr('npm', ['list', '-g', '--json', '@switchbot/codex-plugin']);
  let parsed: { dependencies?: Record<string, { version?: string }> } = {};
  try {
    parsed = JSON.parse(list.stdout) as typeof parsed;
  } catch {
    return { name: 'codex-plugin-npm', status: 'warn', detail: { message: 'npm list output could not be parsed' } };
  }
  const pkg = parsed?.dependencies?.['@switchbot/codex-plugin'];
  if (!pkg) {
    return {
      name: 'codex-plugin-npm',
      status: 'warn',
      detail: { message: 'not installed — run: npm install -g @switchbot/codex-plugin && switchbot install --agent codex' },
    };
  }
  let packageRoot: string | null = null;
  const rootResult = spawnStr('npm', ['root', '-g']);
  if (rootResult.status === 0) {
    packageRoot = path.join(rootResult.stdout.trim(), '@switchbot', 'codex-plugin');
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
      detail: { message: 'switchbot not in codex plugin list — run: npm install -g @switchbot/codex-plugin && switchbot install --agent codex' },
    };
  }
  return { name: 'codex-plugin-registered', status: 'ok', detail: { pluginName } };
}

export function runCodexPluginRegistration(packageRoot: string, pluginId: string): RegistrationResult {
  return withSafeMarketplacePath(packageRoot, (safePath) => {
    const mkt = spawnStr('codex', ['plugin', 'marketplace', 'add', safePath]);
    if (mkt.status !== 0) {
      return { ok: false, exitCode: mkt.status, stderr: mkt.stderr };
    }
    const add = spawnStr('codex', ['plugin', 'add', pluginId]);
    return { ok: add.status === 0, exitCode: add.status, stderr: add.stderr };
  });
}

/**
 * codex CLI <= 0.133.0 misparses local paths containing `@` (e.g. the
 * `@switchbot/codex-plugin` install dir under `npm root -g`) as `owner/repo@ref`
 * git refs, rejecting them with "--ref is only supported for git marketplace
 * sources". Bridge via a junction (Windows) or symlink (POSIX) at a path
 * without `@`. The link is removed after the codex commands finish.
 *
 * If the link cannot be created (no fs perms, mocked test env), the original
 * packageRoot is passed through unchanged so a future codex release that fixes
 * the upstream parser still works.
 */
function withSafeMarketplacePath<T>(packageRoot: string, fn: (safePath: string) => T): T {
  if (!packageRoot.includes('@')) return fn(packageRoot);
  const safePath = path.join(os.tmpdir(), `switchbot-codex-marketplace-${process.pid}`);
  let linkCreated = false;
  try {
    try { fs.unlinkSync(safePath); } catch { /* ENOENT or stale link */ }
    fs.symlinkSync(packageRoot, safePath, process.platform === 'win32' ? 'junction' : 'dir');
    linkCreated = true;
  } catch {
    return fn(packageRoot);
  }
  try {
    return fn(safePath);
  } finally {
    if (linkCreated) {
      try { fs.unlinkSync(safePath); } catch { /* swallow */ }
    }
  }
}

export function resolveCodexPackageRoot(): { ok: true; packageRoot: string } | { ok: false; error: string } {
  const r = spawnSync('npm', ['root', '-g'], {
    encoding: 'utf-8', shell: process.platform === 'win32', timeout: 10000,
  });
  if (!r || (r.status ?? 1) !== 0) {
    return { ok: false, error: `npm root -g failed (exit ${r?.status ?? 1}): ${r?.stderr ?? ''}` };
  }
  const packageRoot = path.join((r.stdout ?? '').trim(), '@switchbot', 'codex-plugin');
  return { ok: true, packageRoot };
}

/**
 * 共享注册 helper：封装 resolveCodexPackageRoot → resolvePluginId → runCodexPluginRegistration。
 * `install --agent codex`、`codex repair`、`codex setup` 三处注册步骤都通过此函数执行，
 * 禁止再各自内联 `npm root -g` 或 pluginId 拼接。
 */
export function registerCodexPlugin(): RegisterCodexPluginResult {
  const root = resolveCodexPackageRoot();
  if (!root.ok) {
    return { ok: false, pluginId: '', packageRoot: '', error: root.error };
  }
  const pluginId = resolvePluginId(root.packageRoot);
  const r = runCodexPluginRegistration(root.packageRoot, pluginId);
  if (!r.ok) {
    return {
      ok: false,
      pluginId,
      packageRoot: root.packageRoot,
      error: `exit ${r.exitCode}: ${r.stderr}`,
      exitCode: r.exitCode,
      stderr: r.stderr,
    };
  }
  return { ok: true, pluginId, packageRoot: root.packageRoot };
}
