import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const workDir = mkdtempSync(path.join(os.tmpdir(), 'switchbot-claude-code-pack-smoke-'));
const packed = [];

function runNpm(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return execFileSync(process.execPath, [npmExecPath, ...args], options);
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return execFileSync(npmCmd, args, options);
}

function pack(args) {
  const out = runNpm(['pack', '--json', ...args], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  const [result] = JSON.parse(out);
  if (!result?.filename) {
    throw new Error(`npm pack did not return a filename: ${out}`);
  }
  const tarball = path.join(repoRoot, result.filename);
  packed.push(tarball);
  return tarball;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf-8'));
}

try {
  const cliTarball = pack([]);
  const pluginTarball = pack(['--workspace', '@switchbot/claude-code-plugin']);

  runNpm(['init', '-y'], {
    cwd: workDir,
    stdio: 'ignore',
  });
  runNpm(['install', cliTarball, pluginTarball], {
    cwd: workDir,
    stdio: 'inherit',
  });

  const cliPkg = readJson(path.join(repoRoot, 'package.json'));
  const installedCliPkg = readJson(path.join(workDir, 'node_modules', '@switchbot', 'openapi-cli', 'package.json'));
  if (installedCliPkg.version !== cliPkg.version) {
    throw new Error(`installed CLI version mismatch: expected ${cliPkg.version}, got ${installedCliPkg.version}`);
  }

  const pluginRoot = path.join(workDir, 'node_modules', '@switchbot', 'claude-code-plugin');
  const pluginPkg = readJson(path.join(pluginRoot, 'package.json'));
  const peer = pluginPkg.peerDependencies?.['@switchbot/openapi-cli'];
  if (!peer || peer.includes('workspace:')) {
    throw new Error(`claude-code plugin peerDependency is not publishable: ${peer ?? '<missing>'}`);
  }

  for (const requiredPath of [
    '.claude-plugin/hooks.json',
    '.claude-plugin/marketplace.json',
    'bin/auth.js',
    'plugins/switchbot/.claude-plugin/hooks.json',
    'plugins/switchbot/.claude-plugin/plugin.json',
    'plugins/switchbot/.mcp.json',
    'plugins/switchbot/skills/switchbot/SKILL.md',  // must be packed: plugin.json declares skills: ./skills/
  ]) {
    const fullPath = path.join(pluginRoot, ...requiredPath.split('/'));
    if (!existsSync(fullPath)) {
      throw new Error(`claude-code plugin tarball missing ${requiredPath}`);
    }
  }

  const marketplace = readJson(path.join(pluginRoot, '.claude-plugin', 'marketplace.json'));
  if (marketplace?.name !== 'switchbot') {
    throw new Error(`marketplace name must be switchbot, got ${marketplace?.name ?? '<missing>'}`);
  }
  const switchbotEntry = marketplace?.plugins?.find((p) => p?.name === 'switchbot');
  if (switchbotEntry?.source !== './plugins/switchbot') {
    throw new Error(`marketplace switchbot plugin source must be './plugins/switchbot', got ${switchbotEntry?.source ?? '<missing>'}`);
  }

  const hooks = readJson(path.join(pluginRoot, '.claude-plugin', 'hooks.json'));
  if (hooks?.onInstall?.command !== 'node') {
    throw new Error(`onInstall command must be 'node', got ${hooks?.onInstall?.command ?? '<missing>'}`);
  }
  const hookArgs = hooks?.onInstall?.args ?? [];
  if (!Array.isArray(hookArgs) || hookArgs.length === 0) {
    throw new Error(`onInstall args must be a non-empty array, got ${JSON.stringify(hookArgs)}`);
  }
  const hookScript = path.resolve(path.join(pluginRoot, '.claude-plugin'), hookArgs[0]);
  if (!existsSync(hookScript)) {
    throw new Error(`onInstall args[0] resolves to a non-existent file: ${hookScript}`);
  }

  // Verify plugin-level hooks (the ones Claude Code actually executes, since source → ./plugins/switchbot)
  const pluginJson = readJson(path.join(pluginRoot, 'plugins', 'switchbot', '.claude-plugin', 'plugin.json'));
  if (pluginJson?.skills !== './skills/') {
    throw new Error(`plugin.json skills must be './skills/', got ${pluginJson?.skills ?? '<missing>'}`);
  }

  const pluginHooks = readJson(path.join(pluginRoot, 'plugins', 'switchbot', '.claude-plugin', 'hooks.json'));
  if (pluginHooks?.onInstall?.command !== 'node') {
    throw new Error(`plugin-level onInstall command must be 'node', got ${pluginHooks?.onInstall?.command ?? '<missing>'}`);
  }
  const pluginHookArgs = pluginHooks?.onInstall?.args ?? [];
  if (!Array.isArray(pluginHookArgs) || pluginHookArgs.length === 0) {
    throw new Error(`plugin-level onInstall args must be a non-empty array, got ${JSON.stringify(pluginHookArgs)}`);
  }
  const pluginHookScript = path.resolve(
    path.join(pluginRoot, 'plugins', 'switchbot', '.claude-plugin'),
    pluginHookArgs[0],
  );
  if (!existsSync(pluginHookScript)) {
    throw new Error(`plugin-level onInstall args[0] resolves to a non-existent file: ${pluginHookScript}`);
  }

  // Verify auth.js syntax is valid
  execFileSync(process.execPath, ['--check', path.join(pluginRoot, 'bin', 'auth.js')], {
    encoding: 'utf-8',
  });

  // Verify auth.js exports makeRunOnInstall and behaves correctly with mock deps
  const { makeRunOnInstall } = await import(
    pathToFileURL(path.join(pluginRoot, 'bin', 'auth.js')).href
  );
  const runOnInstall = makeRunOnInstall({
    checkCli: async () => ({ ok: false, message: 'CLI not found' }),
    checkCredentials: async () => ({ ok: false, message: 'No credentials' }),
    runInherit: async () => 0,
  });
  const exitCode = await runOnInstall();
  if (exitCode !== 1) {
    throw new Error(`makeRunOnInstall with missing CLI must return 1 (non-blocking), got ${exitCode}`);
  }

  console.log('claude-code pack-install smoke ok: tarballs install, required files present, marketplace and hooks valid, auth.js non-blocking');
} finally {
  for (const tarball of packed) {
    rmSync(tarball, { force: true });
  }
  rmSync(workDir, { recursive: true, force: true });
}
