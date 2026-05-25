import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const workDir = mkdtempSync(path.join(os.tmpdir(), 'switchbot-codex-prefix-'));
const prefixDir = path.join(workDir, 'prefix');
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

try {
  const cliTarball = pack([]);
  const pluginTarball = pack(['--workspace', '@switchbot/codex-plugin']);

  runNpm(['install', '-g', '--prefix', prefixDir, cliTarball, pluginTarball], {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  const pluginRoot = path.join(prefixDir, 'node_modules', '@switchbot', 'codex-plugin');
  const cliRoot = path.join(prefixDir, 'node_modules', '@switchbot', 'openapi-cli');
  if (!existsSync(pluginRoot)) {
    throw new Error(`installed plugin root not found: ${pluginRoot}`);
  }
  if (!existsSync(cliRoot)) {
    throw new Error(`installed CLI root not found: ${cliRoot}`);
  }

  const pluginPkg = readJson(path.join(pluginRoot, 'package.json'));
  const cliPkg = readJson(path.join(cliRoot, 'package.json'));
  if (pluginPkg.version !== '0.1.3') {
    throw new Error(`expected installed codex-plugin version 0.1.3, got ${pluginPkg.version}`);
  }

  const {
    makeInstall,
    resolvePluginIdentifier,
    resolveMarketplaceSourceRoot,
  } = await import(pathToFileURL(path.join(pluginRoot, 'bin', 'install.js')).href);

  const pluginId = resolvePluginIdentifier(pluginRoot);
  if (pluginId !== 'switchbot@switchbot') {
    throw new Error(`installed plugin resolved ${pluginId}, expected switchbot@switchbot`);
  }

  const marketplaceRoot = resolveMarketplaceSourceRoot(pluginRoot);
  const calls = [];
  const installCode = await makeInstall({
    checkCli: async () => ({ ok: true, version: cliPkg.version }),
    runInherit: async (cmd, args) => {
      calls.push({ cmd, args });
      return 0;
    },
    packageRoot: pluginRoot,
    runAuth: async () => 0,
  })();
  if (installCode !== 0) {
    throw new Error(`installed Route A makeInstall exited ${installCode}`);
  }

  const sequence = calls.map(({ cmd, args }) => `${cmd} ${args.join(' ')}`);
  for (const expected of [
    'codex plugin remove switchbot@switchbot',
    'codex plugin remove switchbot@codex-plugin',
    'codex plugin remove switchbot@switchbot-skill',
    'codex plugin marketplace remove switchbot',
    'codex plugin marketplace remove codex-plugin',
    'codex plugin marketplace remove switchbot-skill',
    `codex plugin marketplace add ${marketplaceRoot}`,
    'codex plugin add switchbot@switchbot',
    'switchbot doctor',
  ]) {
    if (!sequence.includes(expected)) {
      throw new Error(`installed Route A flow missing "${expected}"\nactual:\n${sequence.join('\n')}`);
    }
  }

  console.log(`codex temp-prefix Route A smoke ok: installed @switchbot/codex-plugin@${pluginPkg.version} resolves ${pluginId}`);
} finally {
  for (const tarball of packed) {
    rmSync(tarball, { force: true });
  }
  rmSync(workDir, { recursive: true, force: true });
}
