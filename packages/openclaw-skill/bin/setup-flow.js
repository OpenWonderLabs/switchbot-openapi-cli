// packages/openclaw-skill/bin/setup-flow.js
// Interactive setup for the SwitchBot OpenClaw plugin. Guides the user
// through installing the underlying @switchbot/openapi-cli, verifying
// version >= 3.7.1, and confirming credentials via `switchbot doctor`.
//
// This module is invoked only via `switchbot-openclaw setup`. It is
// never loaded on the MCP-server path, so it is free to write to stdout.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { formatError } from '../lib/error-messages.js';

const exec = promisify(execFile);
const REQUIRED_CLI = '3.7.1';

async function hasCli() {
  try {
    await exec('switchbot', ['--version'], { timeout: 5000 });
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    // Non-ENOENT errors still mean the binary ran; treat as present.
    return true;
  }
}

async function cliVersion() {
  try {
    const { stdout } = await exec('switchbot', ['--version'], { timeout: 5000 });
    const m = stdout.trim().match(/\d+\.\d+\.\d+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

function versionAtLeast(have, need) {
  const a = have.split('.').map((n) => parseInt(n, 10) || 0);
  const b = need.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true;
}

async function npmPrefix() {
  try {
    const { stdout } = await exec('npm', ['config', 'get', 'prefix'], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function prefixLikelyNeedsSudo(prefix) {
  if (!prefix) return false;
  if (process.platform === 'win32') return false;
  return /^\/usr(\/|$)/.test(prefix) || /^\/opt(\/|$)/.test(prefix);
}

function runInherit(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('close', (code) => resolve(code ?? 0));
    p.on('error', () => resolve(127));
  });
}

export async function runSetup() {
  console.log('SwitchBot plugin setup');
  console.log('======================');
  console.log('');

  // Step 1: CLI on PATH?
  if (!(await hasCli())) {
    console.log('[1/3] SwitchBot CLI not found on PATH.');
    console.log('');
    console.log(formatError('cli-not-installed'));
    const prefix = await npmPrefix();
    if (prefixLikelyNeedsSudo(prefix)) {
      console.log('');
      console.log(`Your npm global prefix is system-owned (${prefix}), so the install`);
      console.log('will fail with EACCES unless you pick one of:');
      console.log('  sudo npm install -g @switchbot/openapi-cli@latest');
      console.log('  — or change the prefix first:');
      console.log('      npm config set prefix ~/.npm-global');
      console.log('      export PATH="$HOME/.npm-global/bin:$PATH"');
    }
    console.log('');
    console.log('Then re-run: switchbot-openclaw setup');
    process.exit(1);
  }

  const version = await cliVersion();
  console.log(`[1/3] SwitchBot CLI detected (version: ${version ?? 'unknown'}).`);

  // Step 2: version gate
  if (!version) {
    console.log('');
    console.log(formatError('cli-version-too-low'));
    process.exit(1);
  }
  if (!versionAtLeast(version, REQUIRED_CLI)) {
    console.log('');
    console.log(`[2/3] CLI ${version} is below the ${REQUIRED_CLI} minimum required by this plugin.`);
    console.log(formatError('cli-version-too-low'));
    process.exit(1);
  }
  console.log(`[2/3] Version satisfies >= ${REQUIRED_CLI}.`);
  console.log('');

  // Step 3: auth / connectivity via doctor
  console.log('[3/3] Running `switchbot doctor` to verify credentials and connectivity...');
  console.log('');
  const code = await runInherit('switchbot', ['doctor']);
  if (code !== 0) {
    console.log('');
    console.log(formatError('token-expired'));
    console.log('');
    console.log('Then re-run: switchbot-openclaw setup');
    process.exit(1);
  }

  console.log('');
  console.log('Setup complete.');
  console.log('Restart your MCP host (OpenClaw / Claude Desktop / Cursor / …) to');
  console.log('pick up the switchbot plugin. The MCP server starts automatically');
  console.log('when invoked with no arguments: `switchbot-openclaw`.');
}
