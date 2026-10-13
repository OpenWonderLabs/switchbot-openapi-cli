#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npmEntry = process.env.npm_execpath;
const evidenceIndex = process.argv.indexOf('--evidence');
const evidencePath = evidenceIndex === -1 ? null : process.argv[evidenceIndex + 1];
if (!npmEntry) throw new Error('Run this smoke through npm run smoke:openclaw-bootstrap.');
if (evidenceIndex !== -1 && !evidencePath) throw new Error('--evidence requires a path.');
if (!existsSync(path.join(root, 'dist/index.js'))) throw new Error('Build the CLI before running native bootstrap smoke.');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || result.error?.message || `exit ${result.status}`);
  return result.stdout;
}

const work = mkdtempSync(path.join(os.tmpdir(), 'switchbot-native bootstrap-'));
const home = path.join(work, 'home');
const cliProject = path.join(work, 'CLI project');
const globalPrefix = path.join(work, 'Global CLI prefix');
const plugin = path.join(work, 'isolated plugin');
const evidence = {
  status: 'running',
  os: { platform: process.platform, release: os.release(), arch: process.arch },
  node: process.version,
  credentialFixture: 'dummy-local-only',
  cloudAuthentication: 'not exercised; local readonly operation only',
  layers: [],
  routes: [],
};
let client;
try {
  for (const directory of [home, cliProject, plugin]) mkdirSync(directory, { recursive: true });
  const pack = (workspace) => {
    const args = ['pack', '--json', '--pack-destination', work];
    if (workspace) args.push('--workspace', workspace);
    else args.push('--ignore-scripts');
    const [item] = JSON.parse(run(process.execPath, [npmEntry, ...args], { cwd: root }));
    return item;
  };
  const cliPack = pack();
  const pluginPack = pack('@switchbot/openclaw-skill');
  evidence.cliVersion = cliPack.version;
  evidence.pluginVersion = pluginPack.version;
  evidence.layers.push('exact-local-artifacts-packed');
  run(process.execPath, [npmEntry, 'install', '--prefix', cliProject, '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', path.join(work, cliPack.filename)], { cwd: work });
  run(process.execPath, [npmEntry, 'install', '--global', '--prefix', globalPrefix, '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', path.join(work, cliPack.filename)], { cwd: work });
  run('tar', ['-xzf', path.join(work, pluginPack.filename), '--strip-components=1', '-C', plugin], { cwd: work });
  assert.equal(existsSync(path.join(plugin, 'node_modules', '@switchbot', 'openapi-cli')), false);
  evidence.layers.push('cli-installed-outside-plugin-ancestry');

  const environment = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: work,
    TMP: work,
    TMPDIR: work,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    LANG: process.env.LANG ?? 'C.UTF-8',
    SWITCHBOT_TOKEN: 'native-smoke-dummy-token',
    SWITCHBOT_SECRET: 'native-smoke-dummy-secret',
  };
  const routes = [
    { name: 'local-bin', bin: path.join(cliProject, 'node_modules', '.bin') },
    { name: 'global-prefix', bin: process.platform === 'win32' ? globalPrefix : path.join(globalPrefix, 'bin') },
  ];
  for (const route of routes) {
    const shim = path.join(route.bin, process.platform === 'win32' ? 'switchbot.cmd' : 'switchbot');
    assert.equal(existsSync(shim), true);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(plugin, 'bin/start.js')],
      cwd: plugin,
      env: { ...environment, PATH: [route.bin, path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter) },
      stderr: 'inherit',
    });
    client = new Client({ name: 'switchbot-native-bootstrap-smoke', version: '1.0.0' });
    try {
      await client.connect(transport);
      const catalog = await client.listTools();
      assert.equal(catalog.tools.some((tool) => tool.name === 'device_diary'), true);
      const history = await client.callTool({ name: 'device_history', arguments: { mode: 'raw' } });
      assert.notEqual(history.isError, true);
      assert.deepEqual(history.structuredContent?.devices, []);
      evidence.routes.push({
        name: route.name,
        toolCount: catalog.tools.length,
        readonly: { tool: 'device_history', arguments: { mode: 'raw' }, result: history.structuredContent },
      });
    } finally {
      await client.close();
      client = undefined;
    }
  }
  evidence.layers.push('native-local-and-global-bootstrap-initialized', 'release-candidate-tool-catalog', 'readonly-tool-invoked');
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed';
  evidence.detail = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  if (client) await client.close();
  rmSync(work, { recursive: true, force: true });
  evidence.layers.push('isolated-runtime-removed');
  const output = `${JSON.stringify(evidence, null, 2)}\n`;
  if (evidencePath) {
    mkdirSync(path.dirname(path.resolve(evidencePath)), { recursive: true });
    writeFileSync(evidencePath, output);
  }
  process.stdout.write(output);
}
