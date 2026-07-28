#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, join } from 'node:path';
import { existsSync, readFileSync, realpathSync, symlinkSync, lstatSync, unlinkSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import { checkCli as defaultCheckCli } from '../setup/check-cli.js';
import { checkCredentials as defaultCheckCredentials } from '../setup/check-credentials.js';
import { makeRunAuth } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultPackageRoot = resolve(__dirname, '..');
const defaultFsDeps = { lstatSync, realpathSync, symlinkSync, unlinkSync, mkdirSync };

function defaultRunInherit(cmd, args) {
  return new Promise((resolveFn) => {
    const p = spawn(cmd, args, { stdio: 'inherit', shell: true });
    p.on('close', code => resolveFn(code ?? 0));
    p.on('error', () => resolveFn(127));
  });
}

export function resolvePluginIdentifier(packageRoot) {
  let marketplaceName = basename(packageRoot);

  // Check manifest paths in priority order; stop at first valid name found.
  // Sequential independent if blocks allow fallbacks to work even if earlier
  // files exist but have invalid JSON (e.g., interrupted write).
  const manifestPaths = [
    join(packageRoot, '.agents', 'plugins', 'marketplace.json'),
    join(packageRoot, 'marketplace.json'),
  ];
  for (const p of manifestPaths) {
    if (existsSync(p)) {
      try {
        const m = JSON.parse(readFileSync(p, 'utf8'));
        if (m?.name) { marketplaceName = m.name; break; }
      } catch {}
    }
  }

  let pluginName = 'switchbot';
  const pluginManifestPath = join(packageRoot, '.codex-plugin', 'plugin.json');
  if (existsSync(pluginManifestPath)) {
    try {
      const pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf8'));
      if (pluginManifest?.name) {
        pluginName = pluginManifest.name;
      }
    } catch {}
  }

  return `${pluginName}@${marketplaceName}`;
}

function computeAliasPath() {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    return join(localAppData, 'switchbot', 'codex-plugin-marketplace');
  }
  return join(os.homedir(), '.switchbot', 'codex-plugin-marketplace');
}

function createAlias(src, dest, type, deps) {
  try {
    deps.symlinkSync(src, dest, type);
  } catch (err) {
    if (err && err.code === 'EPERM') {
      throw new Error(
        `Cannot create ${type} at ${dest}: permission denied (EPERM). ` +
          `On Windows, run the installer from an elevated terminal, ` +
          `or install to a path without @-scoped segments.`,
      );
    }
    throw err;
  }
}

export function resolveMarketplaceSourceRoot(packageRoot, deps = defaultFsDeps) {
  // NOTE: This function is FROZEN. The canonical implementation lives in
  // src/install/codex-checks.ts. Do NOT sync new changes here.
  // The switchbot-codex-install binary is deprecated; use: switchbot codex setup
  const needsAlias = process.platform === 'win32'
    ? /^[A-Za-z]:[\\/].*[\\/]@[^\\/]+[\\/]/.test(packageRoot)
    : /\/@[^/]+\//.test(packageRoot);

  if (!needsAlias) {
    return packageRoot;
  }

  const aliasRoot = computeAliasPath();
  deps.mkdirSync(dirname(aliasRoot), { recursive: true });
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';

  const stat = deps.lstatSync(aliasRoot, { throwIfNoEntry: false });
  if (!stat) {
    createAlias(packageRoot, aliasRoot, linkType, deps);
    return aliasRoot;
  }

  if (stat.isSymbolicLink()) {
    let aliasReal;
    let packageReal;
    try {
      aliasReal = deps.realpathSync(aliasRoot);
      packageReal = deps.realpathSync(packageRoot);
    } catch {
      // Dangling symlink: target was deleted (e.g. nvm switch, npm uninstall).
      deps.unlinkSync(aliasRoot);
      createAlias(packageRoot, aliasRoot, linkType, deps);
      return aliasRoot;
    }
    const pathsMatch = process.platform === 'win32'
      ? aliasReal.toLowerCase() === packageReal.toLowerCase()
      : aliasReal === packageReal;
    if (pathsMatch) {
      return aliasRoot;
    }
    deps.unlinkSync(aliasRoot);
    createAlias(packageRoot, aliasRoot, linkType, deps);
    return aliasRoot;
  }

  const expected = process.platform === 'win32' ? 'junction' : 'symlink';
  throw new Error(`alias path ${aliasRoot} exists and is not a ${expected}; remove it manually and retry`);
}

function formatCodexFailure(step) {
  return [
    `[switchbot-codex] Codex CLI not found while running ${step}.`,
    '[switchbot-codex] Install or open Codex first, then run: npx @switchbot/openapi-cli codex setup',
  ].join('\n');
}

const CODEX_PLUGIN_LEGACY_IDS = ['switchbot@codex-plugin', 'switchbot@switchbot-skill'];
const CODEX_MARKETPLACE_LEGACY_NAMES = ['switchbot', 'codex-plugin', 'switchbot-skill'];

export function makeInstall({ checkCli, runInherit, packageRoot, runAuth, resolveRoot = resolveMarketplaceSourceRoot }) {
  return async function install() {
    process.stderr.write(
      '[switchbot-codex] WARNING: switchbot-codex-install is deprecated.\n' +
      '[switchbot-codex] Preferred: npx @switchbot/openapi-cli codex setup\n' +
      '[switchbot-codex] This binary continues to work during the transition period.\n'
    );
    const cliCheck = await checkCli();
    if (!cliCheck.ok) {
      process.stderr.write('[switchbot-codex] CLI not found. Installing @switchbot/openapi-cli...\n');
      const installCode = await runInherit('npm', ['install', '-g', '@switchbot/openapi-cli@latest']);
      if (installCode !== 0) {
        process.stderr.write('[switchbot-codex] CLI install failed. Run manually: npm install -g @switchbot/openapi-cli@latest\n');
        return installCode;
      }
    } else {
      process.stderr.write(`[switchbot-codex] CLI ${cliCheck.version} detected.\n`);
    }

    const pluginName = resolvePluginIdentifier(packageRoot);
    // Pre-clean before marketplace add: removing the last plugin from a marketplace
    // causes Codex to auto-delete the marketplace entry, so removes must happen
    // before we register the new marketplace — not after.
    for (const id of [...new Set([pluginName, ...CODEX_PLUGIN_LEGACY_IDS])]) {
      process.stderr.write(`[switchbot-codex] Removing stale plugin ${id} if present...\n`);
      const removeCode = await runInherit('codex', ['plugin', 'remove', id]);
      if (removeCode !== 0) {
        process.stderr.write(`[switchbot-codex] Warning: plugin remove exited ${removeCode}; continuing.\n`);
      }
    }

    let marketplaceRoot;
    try {
      marketplaceRoot = resolveRoot(packageRoot);
    } catch (err) {
      process.stderr.write(`[switchbot-codex] Cannot prepare marketplace path: ${err.message}\n`);
      return 1;
    }
    // Also remove marketplace records: stale DB entries cause marketplace add to say
    // "already added" without recreating the directory, making plugin add fail.
    for (const name of CODEX_MARKETPLACE_LEGACY_NAMES) {
      process.stderr.write(`[switchbot-codex] Removing stale marketplace ${name} if present...\n`);
      const mktRemoveCode = await runInherit('codex', ['plugin', 'marketplace', 'remove', name]);
      if (mktRemoveCode !== 0) {
        process.stderr.write(`[switchbot-codex] Warning: marketplace remove exited ${mktRemoveCode}; continuing.\n`);
      }
    }
    process.stderr.write(`[switchbot-codex] Registering plugin at ${marketplaceRoot}...\n`);
    const marketplaceCode = await runInherit('codex', ['plugin', 'marketplace', 'add', marketplaceRoot]);
    if (marketplaceCode !== 0) {
      if (marketplaceCode === 127) {
        process.stderr.write(`${formatCodexFailure('codex plugin marketplace add')}\n`);
        return marketplaceCode;
      }
      process.stderr.write('[switchbot-codex] Marketplace registration failed.\n');
      return marketplaceCode;
    }

    process.stderr.write(`[switchbot-codex] Adding plugin ${pluginName}...\n`);
    const pluginCode = await runInherit('codex', ['plugin', 'add', pluginName]);
    if (pluginCode !== 0) {
      if (pluginCode === 127) {
        process.stderr.write(`${formatCodexFailure('codex plugin add')}\n`);
        return pluginCode;
      }
      process.stderr.write(
        '[switchbot-codex] "codex plugin add" failed — your Codex version may not support it.\n' +
        '[switchbot-codex] Fallback: run npx @switchbot/openapi-cli codex setup after updating Codex.\n'
      );
      return pluginCode;
    }

    process.stderr.write('[switchbot-codex] Verifying credentials after install...\n');
    const authCode = await runAuth();
    if (authCode !== 0) {
      process.stderr.write(
        '[switchbot-codex] Plugin installed, but authentication still needs attention.\n'
      );
      return authCode;
    }

    process.stderr.write('[switchbot-codex] Running final doctor check...\n');
    const doctorCode = await runInherit('switchbot', ['doctor']);
    if (doctorCode !== 0) {
      process.stderr.write(
        '[switchbot-codex] Install completed, but the CLI health check still has failures.\n' +
        '[switchbot-codex] Fix: switchbot doctor\n'
      );
      return doctorCode;
    }

    process.stderr.write('[switchbot-codex] Install complete. Restart Codex and try listing your devices.\n');
    return 0;
  };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('bin/install.js');
if (isMain) {
  const install = makeInstall({
    checkCli: defaultCheckCli,
    runInherit: defaultRunInherit,
    packageRoot: defaultPackageRoot,
    runAuth: makeRunAuth({
      checkCli: defaultCheckCli,
      checkCredentials: defaultCheckCredentials,
      runInherit: defaultRunInherit,
    }),
  });
  install().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`[switchbot-codex] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
