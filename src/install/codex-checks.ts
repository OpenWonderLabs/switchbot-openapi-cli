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
  stage: 'marketplace-add' | 'plugin-add';
}

export interface RegisterCodexPluginResult {
  ok: boolean;
  pluginId: string;
  packageRoot: string | null;
  error?: string;
  exitCode?: number;
  stderr?: string;
}

function spawnStr(cmd: string, args: string[], timeout = 10000): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function resolveMarketplaceName(packageRoot: string): string {
  const marketplacePath = path.join(packageRoot, '.agents', 'plugins', 'marketplace.json');
  if (fs.existsSync(marketplacePath)) {
    const marketplace = readJsonObject(marketplacePath);
    if (typeof marketplace?.name === 'string' && marketplace.name) {
      return marketplace.name;
    }
  }
  return path.basename(packageRoot);
}

function resolvePluginName(packageRoot: string): string {
  const manifestPath = path.join(packageRoot, '.codex-plugin', 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = readJsonObject(manifestPath);
    if (typeof manifest?.name === 'string' && manifest.name) {
      return manifest.name;
    }
  }
  return 'switchbot';
}

/**
 * Codex 0.133.0 misclassifies Windows local paths with scoped npm segments
 * like `...\node_modules\@switchbot\codex-plugin` as ref-bearing sources.
 * Bridge through a junction at a stable, app-owned location so the registered
 * marketplace path contains no `@` segment and survives across runs.
 */
function computeAliasPath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    return path.join(localAppData, 'switchbot', 'codex-plugin-marketplace');
  }
  return path.join(os.homedir(), '.switchbot', 'codex-plugin-marketplace');
}

export function resolveMarketplaceSourceRoot(packageRoot: string): string {
  // Codex misclassifies local paths containing `@`-scoped npm segments
  // (e.g. `…/node_modules/@switchbot/codex-plugin`) as ref-bearing git sources,
  // causing `marketplace add` to fail with "--ref is only supported for git
  // marketplace sources". Affects Windows and Linux/macOS alike. Bridge through
  // a symlink/junction at a stable `@`-free location.
  const needsAlias = process.platform === 'win32'
    ? /^[A-Za-z]:[\\/].*[\\/]@[^\\/]+[\\/]/.test(packageRoot)
    : /\/@[^/]+\//.test(packageRoot);

  if (!needsAlias) return packageRoot;

  const aliasRoot = computeAliasPath();
  fs.mkdirSync(path.dirname(aliasRoot), { recursive: true });

  const linkType = process.platform === 'win32' ? 'junction' : 'dir';

  const stat = fs.lstatSync(aliasRoot, { throwIfNoEntry: false });
  if (!stat) {
    fs.symlinkSync(packageRoot, aliasRoot, linkType);
    return aliasRoot;
  }

  if (stat.isSymbolicLink()) {
    let aliasReal: string;
    let packageReal: string;
    try {
      aliasReal = fs.realpathSync(aliasRoot);
      packageReal = fs.realpathSync(packageRoot);
    } catch {
      // Dangling symlink: target was deleted (e.g. nvm switch, npm uninstall).
      // Recreate it pointing at the current packageRoot.
      fs.unlinkSync(aliasRoot);
      fs.symlinkSync(packageRoot, aliasRoot, linkType);
      return aliasRoot;
    }
    const pathsMatch = process.platform === 'win32'
      ? aliasReal.toLowerCase() === packageReal.toLowerCase()
      : aliasReal === packageReal;
    if (pathsMatch) return aliasRoot;
    fs.unlinkSync(aliasRoot);
    fs.symlinkSync(packageRoot, aliasRoot, linkType);
    return aliasRoot;
  }

  const expected = process.platform === 'win32' ? 'junction' : 'symlink';
  throw new Error(`alias path ${aliasRoot} exists and is not a ${expected}; remove it manually and retry`);
}

/** Single authoritative plugin ID resolver. Mirrors install.js:resolvePluginIdentifier. */
export function resolvePluginId(packageRoot: string): string {
  return `${resolvePluginName(packageRoot)}@${resolveMarketplaceName(packageRoot)}`;
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
        hint: 'Install Codex, then re-run: npx @switchbot/openapi-cli codex setup',
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
      detail: { message: 'npm fallback package not installed — run: npx @switchbot/openapi-cli codex setup' },
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
      detail: { message: 'switchbot not in codex plugin list — run: switchbot codex repair' },
    };
  }
  if (/switchbot@/i.test(pluginName) && (/\bnot installed\b/i.test(pluginName) || !/\binstalled\b/i.test(pluginName))) {
    return {
      name: 'codex-plugin-registered',
      status: 'warn',
      detail: {
        pluginName,
        message: 'switchbot appears in codex plugin list but is not installed — run: switchbot codex repair',
      },
    };
  }
  return { name: 'codex-plugin-registered', status: 'ok', detail: { pluginName } };
}

export function runCodexPluginRegistration(packageRoot: string, pluginId: string): RegistrationResult {
  const marketplaceRoot = resolveMarketplaceSourceRoot(packageRoot);
  const mkt = spawnStr('codex', ['plugin', 'marketplace', 'add', marketplaceRoot]);
  if (mkt.status !== 0) {
    return { ok: false, exitCode: mkt.status, stderr: mkt.stderr, stage: 'marketplace-add' };
  }
  // Remove current and legacy IDs; ignore exit codes (best-effort pre-clean).
  for (const id of [pluginId, ...CODEX_PLUGIN_LEGACY_IDS]) {
    spawnStr('codex', ['plugin', 'remove', id]);
  }
  const add = spawnStr('codex', ['plugin', 'add', pluginId]);
  return { ok: add.status === 0, exitCode: add.status, stderr: add.stderr, stage: 'plugin-add' };
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
 * Route A fallback: resolve the locally-installed npm package root and register it.
 * For new installs, prefer registerCodexPluginGit() (Route B).
 */
export function registerCodexPlugin(): RegisterCodexPluginResult {
  const root = resolveCodexPackageRoot();
  if (!root.ok) {
    return { ok: false, pluginId: '', packageRoot: null, error: root.error };
  }
  const pluginId = resolvePluginId(root.packageRoot);
  const r = runCodexPluginRegistration(root.packageRoot, pluginId);
  if (!r.ok) {
    return {
      ok: false,
      pluginId,
      packageRoot: root.packageRoot,
      error: `${r.stage} exit ${r.exitCode}: ${r.stderr}`,
      exitCode: r.exitCode,
      stderr: r.stderr,
    };
  }
  return { ok: true, pluginId, packageRoot: root.packageRoot };
}

// ─── Git-based marketplace registration (Route B) ────────────────────────────
export const CODEX_GIT_MARKETPLACE_REPO   = 'OpenWonderLabs/switchbot-openapi-cli';
export const CODEX_GIT_MARKETPLACE_SPARSE = 'packages/codex-plugin';
export const CODEX_GIT_MARKETPLACE_REF    = 'main';
export const CODEX_PLUGIN_DEFAULT_ID      = 'switchbot@codex-plugin';
// Known IDs from pre-release installs; cleaned up by both Route A and Route B.
export const CODEX_PLUGIN_LEGACY_IDS = ['switchbot@switchbot-skill'];

export function runCodexPluginRegistrationGit(pluginId: string): RegistrationResult {
  const ref = process.env['CODEX_GIT_MARKETPLACE_REF'] || CODEX_GIT_MARKETPLACE_REF;
  const _envTimeout = process.env['CODEX_MARKETPLACE_ADD_TIMEOUT'];
  const _parsedTimeout = Number(_envTimeout ?? '');
  const _timeoutValid = Number.isFinite(_parsedTimeout) && _parsedTimeout > 0;
  if (_envTimeout !== undefined && !_timeoutValid) {
    process.stderr.write(
      `[switchbot] CODEX_MARKETPLACE_ADD_TIMEOUT="${_envTimeout}" is not a valid positive number; using default 60000 ms\n`,
    );
  }
  const timeout = _timeoutValid ? _parsedTimeout : 60000;
  // git clone via marketplace add can take >10 s on slow networks; use 60 s
  const mkt = spawnStr('codex', [
    'plugin', 'marketplace', 'add',
    CODEX_GIT_MARKETPLACE_REPO,
    '--sparse', CODEX_GIT_MARKETPLACE_SPARSE,
    '--ref',    ref,
  ], timeout);
  if (mkt.status !== 0) {
    return { ok: false, exitCode: mkt.status, stderr: mkt.stderr, stage: 'marketplace-add' };
  }
  // Pre-clean: remove current ID and any known legacy IDs; ignore exit codes
  for (const id of [pluginId, ...CODEX_PLUGIN_LEGACY_IDS]) {
    spawnStr('codex', ['plugin', 'remove', id]);
  }
  const add = spawnStr('codex', ['plugin', 'add', pluginId]);
  return { ok: add.status === 0, exitCode: add.status, stderr: add.stderr, stage: 'plugin-add' };
}

export function registerCodexPluginGit(): RegisterCodexPluginResult {
  const pluginId = CODEX_PLUGIN_DEFAULT_ID;
  const r = runCodexPluginRegistrationGit(pluginId);
  if (!r.ok) {
    return {
      ok: false, pluginId, packageRoot: null,
      error: `${r.stage} exit ${r.exitCode}: ${r.stderr}`,
      exitCode: r.exitCode, stderr: r.stderr,
    };
  }
  return { ok: true, pluginId, packageRoot: null };
}

// Install @switchbot/codex-plugin globally if not already present.
// Used by registerCodexPluginAuto as a last resort before retrying Route A.
function installCodexPluginGlobally(): { ok: boolean; installed?: boolean; error?: string } {
  const list = spawnSync(
    'npm', ['list', '-g', '--json', '--depth=0', '@switchbot/codex-plugin'],
    { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 10000 },
  );
  // Parse JSON regardless of exit code: npm exits 1 on peer-dep warnings even
  // when the package is present. Skip the install if the package shows up in the
  // dependency tree either way.
  try {
    const raw = list.stdout ?? '';
    const lines = raw.split('\n');
    const jsonStartIdx = lines.findIndex((l) => l.trimStart().startsWith('{'));
    const jsonStr = jsonStartIdx >= 0 ? lines.slice(jsonStartIdx).join('\n') : raw;
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const deps = (parsed.dependencies ?? {}) as Record<string, unknown>;
    if (deps['@switchbot/codex-plugin']) return { ok: true, installed: false };
  } catch { /* fall through to install */ }
  const install = spawnSync(
    'npm', ['install', '-g', '@switchbot/codex-plugin@latest'],
    { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 120000 },
  );
  if ((install.status ?? 1) !== 0) {
    return { ok: false, error: `npm install -g failed (exit ${install.status ?? 1}): ${install.stderr ?? ''}` };
  }
  // Verify the package now appears in npm list; a mismatch means npm installed
  // to a different prefix than the active one (e.g. nvm switching, sudo vs user).
  const verify = spawnSync(
    'npm', ['list', '-g', '--json', '--depth=0', '@switchbot/codex-plugin'],
    { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 10000 },
  );
  if (verify.status === null) {
    return {
      ok: false,
      error: 'post-install npm list timed out; cannot verify @switchbot/codex-plugin was installed correctly',
    };
  }
  try {
    const vRaw = verify.stdout ?? '';
    const vLines = vRaw.split('\n');
    const vJsonIdx = vLines.findIndex((l) => l.trimStart().startsWith('{'));
    const vJsonStr = vJsonIdx >= 0 ? vLines.slice(vJsonIdx).join('\n') : vRaw;
    const vParsed = JSON.parse(vJsonStr) as Record<string, unknown>;
    const vDeps = (vParsed.dependencies ?? {}) as Record<string, unknown>;
    if (!vDeps['@switchbot/codex-plugin']) {
      return {
        ok: false,
        error: 'npm install -g succeeded but @switchbot/codex-plugin not found in npm list (npm prefix mismatch? Run: npm root -g to verify prefix)',
      };
    }
  } catch { /* verification inconclusive — proceed and let registration catch the error */ }
  return { ok: true, installed: true };
}

/**
 * Try Route B (git marketplace) first; fall back to local npm path if GitHub
 * is unreachable or the clone fails. This preserves air-gapped / corporate
 * environments where @switchbot/codex-plugin is already installed locally.
 */
export function registerCodexPluginAuto(): RegisterCodexPluginResult {
  // Route B: git marketplace — no local npm package required
  const git = registerCodexPluginGit();
  if (git.ok) return git;

  // Route A: local npm path (fast path if already installed)
  const npm = registerCodexPlugin();
  if (npm.ok) return npm;

  // On-demand install: @switchbot/codex-plugin may not be globally installed yet.
  // Covers fresh repair/install scenarios where the npm package is absent.
  const install = installCodexPluginGlobally();
  if (!install.ok) {
    return {
      ok: false,
      pluginId: CODEX_PLUGIN_DEFAULT_ID,
      packageRoot: null,
      error: `Route B failed (${git.error}); Route A failed (${npm.error}); on-demand install failed: ${install.error}. Run: switchbot codex repair`,
    };
  }

  // Retry Route A after successful install
  const retry = registerCodexPlugin();
  const installPhrase = install.installed
    ? 'installed @switchbot/codex-plugin'
    : '@switchbot/codex-plugin already present';
  return retry.ok
    ? retry
    : {
        ...retry,
        pluginId: CODEX_PLUGIN_DEFAULT_ID,
        error: `Route B failed (${git.error}); ${installPhrase} but Route A still failed: ${retry.error}. Run: switchbot codex repair`,
      };
}
