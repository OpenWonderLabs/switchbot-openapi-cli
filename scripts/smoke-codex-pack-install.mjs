import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const workDir = mkdtempSync(path.join(os.tmpdir(), 'switchbot-codex-pack-smoke-'));
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
  const pluginTarball = pack(['--workspace', '@switchbot/codex-plugin']);

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

  const pluginRoot = path.join(workDir, 'node_modules', '@switchbot', 'codex-plugin');
  const pluginPkg = readJson(path.join(pluginRoot, 'package.json'));
  const peer = pluginPkg.peerDependencies?.['@switchbot/openapi-cli'];
  if (!peer || peer.includes('workspace:')) {
    throw new Error(`codex plugin peerDependency is not publishable: ${peer ?? '<missing>'}`);
  }

  for (const requiredPath of [
    '.agents/plugins/marketplace.json',
    '.codex-plugin/plugin.json',
    '.codex-plugin/hooks.json',
    '.mcp.json',
    'skills/switchbot/SKILL.md',
    'bin/auth.js',
    'bin/install.js',
  ]) {
    const fullPath = path.join(pluginRoot, ...requiredPath.split('/'));
    if (!existsSync(fullPath)) {
      throw new Error(`codex plugin tarball missing ${requiredPath}`);
    }
  }

  const pluginManifest = readJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
  if (pluginManifest?.interface?.displayName !== 'SwitchBot') {
    throw new Error(`plugin displayName must be SwitchBot, got ${pluginManifest?.interface?.displayName ?? '<missing>'}`);
  }

  const marketplace = readJson(path.join(pluginRoot, '.agents', 'plugins', 'marketplace.json'));
  if (marketplace?.name !== 'codex-plugin') {
    throw new Error(`marketplace name must be codex-plugin so switchbot@codex-plugin resolves, got ${marketplace?.name ?? '<missing>'}`);
  }
  const switchbotEntry = marketplace?.plugins?.find((p) => p?.name === 'switchbot');
  if (switchbotEntry?.source?.path !== '../../') {
    throw new Error(`marketplace switchbot plugin source.path must be '../../' (codex resolves it from .agents/plugins/marketplace.json up to packageRoot), got ${switchbotEntry?.source?.path ?? '<missing>'}`);
  }

  const hooks = readJson(path.join(pluginRoot, '.codex-plugin', 'hooks.json'));
  const hookArgs = hooks?.onInstall?.args ?? [];
  if (!Array.isArray(hookArgs) || !hookArgs.includes('--hook')) {
    throw new Error(`onInstall hook must run auth.js --hook, got ${JSON.stringify(hookArgs)}`);
  }

  const switchbotBin = process.platform === 'win32'
    ? path.join(workDir, 'node_modules', '.bin', 'switchbot.cmd')
    : path.join(workDir, 'node_modules', '.bin', 'switchbot');
  const setupOut = execFileSync(
    switchbotBin,
    ['codex', 'setup', '--dry-run', '--json'],
    {
      cwd: workDir,
      encoding: 'utf-8',
      shell: process.platform === 'win32',
    },
  );
  const setup = JSON.parse(setupOut);
  const steps = setup.data?.steps ?? setup.steps ?? [];
  const names = steps.map((s) => s.name);
  for (const expected of [
    'check-codex-cli',
    'install-switchbot-cli',
    'install-codex-plugin',
    'register-plugin',
    'auth',
    'doctor-verify',
  ]) {
    if (!names.includes(expected)) {
      throw new Error(`codex setup dry-run missing step ${expected}; got ${names.join(', ')}`);
    }
  }

  const envPath = `${path.join(workDir, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}`;
  const hook = spawnSync(
    process.execPath,
    [path.join(pluginRoot, 'bin', 'auth.js'), '--hook'],
    {
      cwd: workDir,
      env: { ...process.env, PATH: envPath },
      encoding: 'utf-8',
      shell: process.platform === 'win32',
      timeout: 30_000,
    },
  );
  if ((hook.status ?? 1) !== 0) {
    throw new Error(`codex plugin onInstall hook must exit 0; got ${hook.status ?? 1}\nstderr:\n${hook.stderr}`);
  }

  console.log('codex pack-install smoke ok: tarballs install, setup dry-run includes plugin install, hook is non-blocking');
} finally {
  for (const tarball of packed) {
    rmSync(tarball, { force: true });
  }
  rmSync(workDir, { recursive: true, force: true });
}
