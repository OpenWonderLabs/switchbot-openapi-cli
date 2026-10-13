#!/usr/bin/env node
/**
 * Gemini extension release gate — static validation (NOT a pack+install test).
 * Validates: manifest schema, GEMINI.md existence, command file count, MCP server config.
 * The Gemini extension is installed via `gemini extensions link`, not npm, so no tarball test applies.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const extDir = resolve(__dirname, '../packages/gemini-extension');

function hasCommand(command) {
  const result = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    [command],
    { encoding: 'utf8', shell: false },
  );
  return result.status === 0;
}

if (process.argv.includes('--require-host') && !hasCommand('gemini')) {
  console.error('Gemini host is required for release verification but is not on PATH.');
  process.exit(1);
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// 1. Manifest parseable
const manifestPath = resolve(extDir, 'gemini-extension.json');
if (!existsSync(manifestPath)) fail('gemini-extension.json not found');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

// 2. Required manifest fields
if (!manifest.name) fail('manifest missing name');
if (!manifest.version) fail('manifest missing version');
if (!manifest.contextFileName) fail('manifest missing contextFileName');
if (!manifest.mcpServers?.switchbot) fail('manifest missing mcpServers.switchbot');
if (!manifest.mcpServers.switchbot.env) fail('manifest missing mcpServers.switchbot.env');

// 3. GEMINI.md exists
const contextPath = resolve(extDir, manifest.contextFileName);
if (!existsSync(contextPath)) fail(`${manifest.contextFileName} not found`);

// 4. Command files present
const commandsDir = resolve(extDir, 'commands/switchbot');
const tomlFiles = readdirSync(commandsDir).filter((f) => f.endsWith('.toml'));
if (tomlFiles.length < 23) fail(`expected ≥23 command files, found ${tomlFiles.length}`);

// 5. MCP server has correct command
const server = manifest.mcpServers.switchbot;
if (server.command !== 'switchbot') fail(`mcpServers.switchbot.command = "${server.command}", expected "switchbot"`);

console.log(`OK: gemini-extension manifest valid (${tomlFiles.length} commands, env mapped)`);
