import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const pluginTarball = pack(['--workspace', '@switchbot/claude-code-plugin']);

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

  const pluginRoot = path.join(workDir, 'node_modules', '@switchbot', 'claude-code-plugin');
  const pluginPkg = readJson(path.join(pluginRoot, 'package.json'));
  const peer = pluginPkg.peerDependencies?.['@switchbot/openapi-cli'];
  if (!peer || peer.includes('workspace:')) {
    throw new Error(`claude-code plugin peerDependency is not publishable: ${peer ?? '<missing>'}`);
  }

  for (const requiredPath of [
    '.claude-plugin/marketplace.json',
    'bin/auth.js',
    'lib/verify-release.js',
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

  // Run the same version guard against the installed artifact, not checkout copies.
  execFileSync(process.execPath, [path.join(pluginRoot, 'lib', 'verify-release.js')], {
    encoding: 'utf-8',
  });
  for (const layout of ['', 'plugins/switchbot']) {
    if (existsSync(path.join(pluginRoot, layout, '.claude-plugin', 'hooks.json'))) {
      throw new Error(`claude-code plugin ${layout || 'package root'} must not ship unsupported onInstall hooks`);
    }
  }
  const pluginJson = readJson(path.join(pluginRoot, 'plugins', 'switchbot', '.claude-plugin', 'plugin.json'));
  if (Object.hasOwn(pluginJson, 'hooks')) {
    throw new Error('Claude plugin manifest must not declare unsupported install hooks');
  }
  if (pluginJson.skills !== './skills/') {
    throw new Error(`plugin.json skills must be './skills/', got ${pluginJson.skills ?? '<missing>'}`);
  }

  // Verify auth.js syntax is valid
  execFileSync(process.execPath, ['--check', path.join(pluginRoot, 'bin', 'auth.js')], {
    encoding: 'utf-8',
  });

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
  const output = execFileSync(
    process.execPath,
    [path.join(pluginRoot, pluginPkg.bin['switchbot-claude-auth'])],
    { cwd: workDir, env: runtimeEnv, encoding: 'utf-8', timeout: 30_000 },
  );
  if (output !== '') throw new Error(`Claude manual auth helper emitted unexpected stdout: ${output}`);
  console.log('claude-code pack-install smoke ok: installed metadata versions match; unsupported install hooks are absent; manual setup works with isolated dummy credentials');
} finally {
  for (const tarball of packed) {
    rmSync(tarball, { force: true });
  }
  rmSync(workDir, { recursive: true, force: true });
}
