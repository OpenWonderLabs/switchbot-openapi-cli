#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageDirectories = new Map([
  ['@switchbot/codex-plugin', 'packages/codex-plugin'],
  ['@switchbot/openclaw-skill', 'packages/openclaw-skill'],
  ['@switchbot/claude-code-plugin', 'packages/claude-code-plugin'],
  ['@switchbot/gemini-extension', 'packages/gemini-extension'],
]);

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return process.argv[index + 1];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout || result.error?.message || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function readOutcomes(file) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value?.schemaVersion !== 1 || !Array.isArray(value.packages)) throw new Error('Invalid release candidate outcome manifest');
  const byName = new Map(value.packages.map((item) => [item.name, item]));
  for (const name of ['@switchbot/openapi-cli', ...packageDirectories.keys()]) {
    const item = byName.get(name);
    if (!item || typeof item.version !== 'string' || !['published', 'already-published'].includes(item.outcome)) {
      throw new Error(`Host verification requires a publishable exact candidate for ${name}`);
    }
  }
  return byName;
}

function packedTarball(spec, directory) {
  const output = run('npm', ['pack', spec, '--json', '--pack-destination', directory], { cwd: root });
  const [entry] = JSON.parse(output);
  if (!entry?.filename) throw new Error(`npm pack did not return a tarball for ${spec}`);
  return path.join(directory, entry.filename);
}

function verifyPackage(file, name, version) {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.name !== name || value.version !== version) {
    throw new Error(`Installed ${name}@${value.version ?? '<unknown>'}, expected ${name}@${version}`);
  }
}

function main() {
  if (!process.env.NODE_AUTH_TOKEN) throw new Error('NPM authentication is required for release host verification');
  const outcomes = readOutcomes(option('--outcomes'));
  const work = mkdtempSync(path.join(os.tmpdir(), 'switchbot-release-host-'));
  try {
    const cli = outcomes.get('@switchbot/openapi-cli');
    run('npm', ['init', '--yes'], { cwd: work });
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `@switchbot/openapi-cli@${cli.version}`], { cwd: work });
    const candidate = path.join(work, 'node_modules', '@switchbot', 'openapi-cli');
    verifyPackage(path.join(candidate, 'package.json'), cli.name, cli.version);
    cpSync(path.join(root, '.agents'), path.join(candidate, '.agents'), { recursive: true });

    for (const [name, relative] of packageDirectories) {
      const item = outcomes.get(name);
      const destination = path.join(candidate, relative);
      mkdirSync(destination, { recursive: true });
      const tarball = packedTarball(`${name}@${item.version}`, work);
      run('tar', ['-xzf', tarball, '--strip-components=1', '-C', destination], { cwd: work });
      verifyPackage(path.join(destination, 'package.json'), name, item.version);
    }

    const hostRunner = path.join(root, 'scripts', 'smoke-host-runtime.mjs');
    const args = [hostRunner, '--candidate', candidate, '--host', 'all'];
    if (process.argv.includes('--require-host')) args.push('--require-host');
    const evidence = process.argv.indexOf('--evidence');
    if (evidence !== -1) args.push('--evidence', process.argv[evidence + 1]);
    const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, stdio: 'inherit' });
    if (result.status !== 0) process.exitCode = result.status ?? 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`smoke-release-host: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
