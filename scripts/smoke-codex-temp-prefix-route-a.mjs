import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);

function hasCommand(command) {
  const result = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    [command],
    { encoding: 'utf8', shell: false },
  );
  return result.status === 0;
}

const hostAvailable = hasCommand('codex');
if (process.argv.includes('--require-host') && !hostAvailable) {
  console.error('Codex host is required for release verification but is not on PATH.');
  process.exit(1);
}
const workDir = mkdtempSync(path.join(os.tmpdir(), 'switchbot-codex-prefix-'));
const prefixDir = path.join(workDir, 'prefix');
const packed = [];
const home = path.join(workDir, 'home');
mkdirSync(home);
const runtimeEnv = {
  PATH: `${process.platform === 'win32' ? prefixDir : path.join(prefixDir, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`,
  HOME: home, USERPROFILE: home,
  CODEX_HOME: path.join(home, '.codex'),
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
mkdirSync(runtimeEnv.CODEX_HOME, { recursive: true });
let marketplaceInstalled = false;
let pluginInstalled = false;

function runCodex(args) {
  return execFileSync('codex', args, {
    cwd: workDir, env: runtimeEnv, encoding: 'utf8',
    timeout: 30_000, shell: process.platform === 'win32',
  });
}
const expectedPluginVersion = JSON.parse(
  readFileSync(path.join(repoRoot, 'packages', 'codex-plugin', 'package.json'), 'utf-8')
).version;

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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

try {
  const cliTarball = pack([]);
  const pluginTarball = pack(['--workspace', '@switchbot/codex-plugin']);

  runNpm(['install', '-g', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefixDir, cliTarball, pluginTarball], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  // On Linux/macOS, `npm install -g --prefix` puts packages under lib/node_modules/;
  // on Windows they go directly under node_modules/.
  const nodeModulesDir =
    process.platform === 'win32'
      ? path.join(prefixDir, 'node_modules')
      : path.join(prefixDir, 'lib', 'node_modules');
  const pluginRoot = path.join(nodeModulesDir, '@switchbot', 'codex-plugin');
  const cliRoot = path.join(nodeModulesDir, '@switchbot', 'openapi-cli');
  if (!existsSync(pluginRoot)) {
    throw new Error(`installed plugin root not found: ${pluginRoot}`);
  }
  if (!existsSync(cliRoot)) {
    throw new Error(`installed CLI root not found: ${cliRoot}`);
  }

  const pluginPkg = readJson(path.join(pluginRoot, 'package.json'));
  const cliPkg = readJson(path.join(cliRoot, 'package.json'));
  if (pluginPkg.version !== expectedPluginVersion) {
    throw new Error(`expected installed codex-plugin version ${expectedPluginVersion}, got ${pluginPkg.version}`);
  }

  const actualCliVersion = execFileSync(process.execPath, [path.join(cliRoot, cliPkg.bin.switchbot), '--version'], {
    cwd: workDir, env: runtimeEnv, encoding: 'utf8',
  }).trim();
  if (actualCliVersion !== cliPkg.version) throw new Error('Installed CLI version mismatch');
  execFileSync(process.execPath, [path.join(pluginRoot, pluginPkg.bin['switchbot-codex-auth'])], {
    cwd: workDir, env: runtimeEnv, stdio: 'inherit', timeout: 30_000,
  });

  if (hostAvailable) {
    // Codex parses @ in marketplace paths as a ref separator; use a local alias
    // of the exact installed package rather than a source checkout or mock.
    const marketplaceRoot = path.join(workDir, 'marketplace');
    symlinkSync(pluginRoot, marketplaceRoot, process.platform === 'win32' ? 'junction' : 'dir');
    runCodex(['plugin', 'marketplace', 'add', marketplaceRoot]);
    marketplaceInstalled = true;
    runCodex(['plugin', 'add', 'switchbot@switchbot']);
    pluginInstalled = true;
    const listed = runCodex(['plugin', 'list']);
    if (!listed.includes('switchbot@switchbot')) {
      throw new Error('Codex did not list the plugin installed from the temporary npm prefix');
    }
    console.log(`codex temp-prefix Route A smoke ok: exact installed @switchbot/codex-plugin@${pluginPkg.version} registered in isolated Codex HOME`);
  } else {
    console.log(`codex temp-prefix package smoke ok: @switchbot/codex-plugin@${pluginPkg.version}; native registration skipped (Codex absent; use --require-host to fail closed)`);
  }
} finally {
  const cleanupErrors = [];
  for (const [installed, args] of [
    [pluginInstalled, ['plugin', 'remove', 'switchbot@switchbot']],
    [marketplaceInstalled, ['plugin', 'marketplace', 'remove', 'switchbot']],
  ]) {
    if (installed) {
      try { runCodex(args); } catch (error) { cleanupErrors.push(error); }
    }
  }
  for (const tarball of packed) {
    rmSync(tarball, { force: true });
  }
  rmSync(workDir, { recursive: true, force: true });
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Codex isolated registration cleanup failed');
}
