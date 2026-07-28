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
  // Root-level marketplace.json is the authoritative source: it is what
  // `codex plugin marketplace add <path>` validates and what Codex registers
  // the marketplace name from. Always prefer it so the constructed plugin ID
  // (e.g. switchbot@switchbot) matches what Codex expects for `plugin add`.
  const rootManifestPath = path.join(packageRoot, 'marketplace.json');
  if (fs.existsSync(rootManifestPath)) {
    const manifest = readJsonObject(rootManifestPath);
    if (typeof manifest?.name === 'string' && manifest.name) {
      return manifest.name;
    }
  }
  // Legacy fallback: .agents/plugins/marketplace.json (present in packages
  // published before the root-level manifest was introduced).
  const agentsPluginsPath = path.join(packageRoot, '.agents', 'plugins', 'marketplace.json');
  if (fs.existsSync(agentsPluginsPath)) {
    const manifest = readJsonObject(agentsPluginsPath);
    if (typeof manifest?.name === 'string' && manifest.name) {
      return manifest.name;
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

function createAlias(src: string, dest: string, type: fs.symlink.Type): void {
  try {
    fs.symlinkSync(src, dest, type);
  } catch (err: unknown) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'EPERM') {
      throw new Error(
        `Cannot create ${type} at ${dest}: permission denied (EPERM). ` +
          `On Windows, run the installer from an elevated terminal, ` +
          `or install to a path without @-scoped segments.`,
      );
    }
    throw err;
  }
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
    createAlias(packageRoot, aliasRoot, linkType);
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
      createAlias(packageRoot, aliasRoot, linkType);
      return aliasRoot;
    }
    const pathsMatch = process.platform === 'win32'
      ? aliasReal.toLowerCase() === packageReal.toLowerCase()
      : aliasReal === packageReal;
    if (pathsMatch) return aliasRoot;
    fs.unlinkSync(aliasRoot);
    createAlias(packageRoot, aliasRoot, linkType);
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
        /switchbot@/i.test(String((p as Record<string, unknown>).name)),
    );
    found = Boolean(match);
    pluginName = found ? String((match as Record<string, unknown>).name) : '';
  } catch {
    // Only match plugin-ID lines (contain '@'), not marketplace title lines like "Marketplace switchbot"
    const pluginLine = raw.split('\n').find((l) => /switchbot@/i.test(l));
    found = Boolean(pluginLine);
    pluginName = pluginLine?.trim() ?? '';
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
  // Pre-clean before marketplace add: removing the last plugin from a marketplace
  // causes Codex to auto-delete the marketplace entry, so removes must happen
  // before we register the new marketplace — not after.
  for (const id of [...new Set([pluginId, ...CODEX_PLUGIN_LEGACY_IDS])]) {
    spawnStr('codex', ['plugin', 'remove', id]);
  }
  // Also remove the marketplace records: when plugin remove deletes the last plugin,
  // Codex removes the directory but leaves a stale DB record. The next `marketplace add`
  // then says "already added" without recreating the directory, causing `plugin add` to fail.
  for (const name of CODEX_MARKETPLACE_LEGACY_NAMES) {
    spawnStr('codex', ['plugin', 'marketplace', 'remove', name]);
  }
  const mkt = spawnStr('codex', ['plugin', 'marketplace', 'add', marketplaceRoot]);
  if (mkt.status !== 0) {
    return { ok: false, exitCode: mkt.status, stderr: mkt.stderr, stage: 'marketplace-add' };
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
export const CODEX_GIT_MARKETPLACE_REPO    = 'OpenWonderLabs/switchbot-openapi-cli';
export const CODEX_GIT_MARKETPLACE_SPARSE  = 'packages/codex-plugin';
// Root-level .agents/plugins/marketplace.json — required so Codex validates the
// manifest at the checkout root (it does not descend into sparse subdirectories).
export const CODEX_GIT_MARKETPLACE_SPARSE2 = '.agents/plugins';
export const CODEX_GIT_MARKETPLACE_REF     = 'main';
export const CODEX_PLUGIN_DEFAULT_ID       = 'switchbot@switchbot';
// Known IDs from pre-release installs; cleaned up by both Route A and Route B.
export const CODEX_PLUGIN_LEGACY_IDS = ['switchbot@codex-plugin', 'switchbot@switchbot-skill'];
// Marketplace names derived from legacy IDs (pluginName@marketplaceName → marketplaceName).
// Removed before marketplace add to clear stale Codex internal state — when plugin remove
// deletes the last plugin in a marketplace Codex removes the directory but leaves a DB record,
// causing the next `marketplace add` to say "already added" without recreating the directory.
export const CODEX_MARKETPLACE_LEGACY_NAMES = ['switchbot', 'codex-plugin', 'switchbot-skill'];

function isCodexProcessRunning(): boolean {
  if (process.platform !== 'win32') return false;
  const r = spawnStr('tasklist', ['/FI', 'IMAGENAME eq Codex.exe', '/NH', '/FO', 'CSV'], 5000);
  return r.status === 0 && r.stdout.toLowerCase().includes('codex.exe');
}

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
  // Pre-clean before marketplace add: removing the last plugin from a marketplace
  // causes Codex to auto-delete the marketplace entry, so removes must happen
  // before we register the new marketplace — not after.
  for (const id of [...new Set([pluginId, ...CODEX_PLUGIN_LEGACY_IDS])]) {
    spawnStr('codex', ['plugin', 'remove', id]);
  }
  // Also remove the marketplace records to clear stale Codex DB state (see Route A counterpart).
  for (const name of CODEX_MARKETPLACE_LEGACY_NAMES) {
    spawnStr('codex', ['plugin', 'marketplace', 'remove', name]);
  }
  // git clone via marketplace add can take >10 s on slow networks; use 60 s
  const mktArgs = [
    'plugin', 'marketplace', 'add',
    CODEX_GIT_MARKETPLACE_REPO,
    '--sparse', CODEX_GIT_MARKETPLACE_SPARSE,
    '--sparse', CODEX_GIT_MARKETPLACE_SPARSE2,
    '--ref',    ref,
  ];
  let mkt = spawnStr('codex', mktArgs, timeout);
  // On Windows, git holds file handles briefly after clone (os error 32).
  // If the local npm package is already available (Route A), skip retries and
  // return immediately so registerCodexPluginAuto can fall back to Route A
  // without burning 17 s of wait time. Only retry when Route A is absent
  // (fresh machine with no npm package installed yet).
  if (mkt.status !== 0 && process.platform === 'win32' && mkt.stderr.includes('os error 32')) {
    if (isCodexProcessRunning()) {
      process.stderr.write(
        '[switchbot] Warning: Codex.exe is running. Close Codex Desktop before running setup to avoid file-lock errors.\n',
      );
    }
    const _routeARoot = resolveCodexPackageRoot();
    const routeAAvailable = _routeARoot.ok && fs.existsSync(_routeARoot.packageRoot);
    const delays = routeAAvailable ? [] : [2000, 5000, 10000];
    for (const delay of delays) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      mkt = spawnStr('codex', mktArgs, timeout);
      if (mkt.status === 0 || !mkt.stderr.includes('os error 32')) break;
    }
  }
  if (mkt.status !== 0) {
    return { ok: false, exitCode: mkt.status, stderr: mkt.stderr, stage: 'marketplace-add' };
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
  // Idempotency guard: if the plugin is already registered and healthy, skip all mutation.
  const preCheck = checkCodexPluginRegistered();
  if (preCheck.status === 'ok') {
    const d = preCheck.detail;
    const pluginName = typeof d === 'object' && d !== null && 'pluginName' in d
      ? String(d.pluginName)
      : undefined;
    return { ok: true, pluginId: pluginName ?? CODEX_PLUGIN_DEFAULT_ID, packageRoot: null };
  }

  // Route B: git marketplace — no local npm package required
  const git = registerCodexPluginGit();
  if (git.ok) return git;

  // When Route B fails with a Windows file-lock (os error 32) the git clone
  // held open handles that Codex couldn't release. Route A uses the local npm
  // package and never touches git, so fall back and log the specific reason.
  if (process.platform === 'win32' && (git.stderr ?? git.error ?? '').includes('os error 32')) {
    process.stderr.write('[switchbot] Route B: Windows file-lock (os error 32) — falling back to Route A (local npm path)\n');
  }

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
