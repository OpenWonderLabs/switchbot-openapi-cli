import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  const out = runNpm(['pack', '--json', ...(args.length === 0 ? ['--ignore-scripts'] : []), ...args], {
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
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', cliTarball, pluginTarball], {
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
  for (const layout of ['', 'plugins/switchbot']) {
    const manifestDirectory = path.join(pluginRoot, layout, '.codex-plugin');
    const manifest = readJson(path.join(manifestDirectory, 'plugin.json'));
    if (Object.hasOwn(manifest, 'hooks')) {
      throw new Error(`codex plugin ${layout || 'package root'} manifest must not contain hooks`);
    }
    if (existsSync(path.join(manifestDirectory, 'hooks.json'))) {
      throw new Error(`codex plugin ${layout || 'package root'} must not ship .codex-plugin/hooks.json`);
    }
  }

  const pluginManifest = readJson(path.join(pluginRoot, '.codex-plugin', 'plugin.json'));
  if (pluginManifest?.interface?.displayName !== 'SwitchBot') {
    throw new Error(`plugin displayName must be SwitchBot, got ${pluginManifest?.interface?.displayName ?? '<missing>'}`);
  }

  const marketplace = readJson(path.join(pluginRoot, '.agents', 'plugins', 'marketplace.json'));
  if (marketplace?.name !== 'switchbot') {
    throw new Error(`marketplace name must be switchbot so switchbot@switchbot resolves, got ${marketplace?.name ?? '<missing>'}`);
  }
  const switchbotEntry = marketplace?.plugins?.find((p) => p?.name === 'switchbot');
  if (switchbotEntry?.source !== './plugins/switchbot') {
    throw new Error(`marketplace switchbot plugin source must be './plugins/switchbot', got ${switchbotEntry?.source ?? '<missing>'}`);
  }

  const home = path.join(workDir, 'home');
  mkdirSync(home);
  const runtimeEnv = {
    PATH: `${path.join(workDir, 'node_modules', '.bin')}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TMPDIR: workDir, TMP: workDir, TEMP: workDir,
    SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec,
    SWITCHBOT_TOKEN: 'local-smoke-only-token',
    SWITCHBOT_SECRET: 'local-smoke-only-secret',
  };
  const cliEntrypoint = path.join(workDir, 'node_modules', '@switchbot', 'openapi-cli', installedCliPkg.bin.switchbot);
  const setupOut = execFileSync(
    process.execPath,
    [cliEntrypoint, 'codex', 'setup', '--dry-run', '--json'],
    { cwd: workDir, env: runtimeEnv, encoding: 'utf-8' },
  );
  const setup = JSON.parse(setupOut);
  const names = (setup.data?.steps ?? []).map((step) => step.name);
  for (const expected of [
    'check-codex-cli', 'install-switchbot-cli', 'register-plugin', 'auth', 'doctor-verify',
  ]) {
    if (!names.includes(expected)) {
      throw new Error(`codex setup dry-run missing step ${expected}; got ${names.join(', ')}`);
    }
  }
  const setupHelper = spawnSync(
    process.execPath,
    [path.join(pluginRoot, pluginPkg.bin['switchbot-codex-auth'])],
    {
      cwd: workDir,
      env: runtimeEnv,
      encoding: 'utf-8',
      timeout: 30_000,
    },
  );
  if (setupHelper.status !== 0 || setupHelper.stdout !== '') {
    throw new Error(
      `codex manual auth helper failed isolated credential discovery; exit ${setupHelper.status}\nstdout:\n${setupHelper.stdout}\nstderr:\n${setupHelper.stderr}`,
    );
  }


  console.log(
    'codex pack-install smoke ok: both installed layouts are hook-free; setup dry-run and manual auth work without real credentials or host registration',
  );
} finally {
  for (const tarball of packed) {
    rmSync(tarball, { force: true });
  }
  rmSync(workDir, { recursive: true, force: true });
}
