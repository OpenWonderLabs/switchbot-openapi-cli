#!/usr/bin/env node
// packages/openclaw-skill/bin/start.js
//
// Default entry point for the @switchbot/openclaw-skill plugin.
//
// Subcommands:
//   setup       Interactive bootstrap: verify CLI installed + >=3.7.1,
//               run `switchbot doctor` to confirm auth.
//   --version   Print the plugin version.
//   --help      Print this help.
//
// Default (no args): bootstrap wrapper — auto-installs CLI, verifies credentials,
// starts daemon if needed, then exec switchbot mcp serve (exposes all 24 MCP tools).
// Only credential setup requires user action; everything else is automatic.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const cmd = process.argv[2];

if (cmd === 'setup') {
  const { runSetup } = await import('./setup-flow.js');
  await runSetup();
} else if (cmd === '--version' || cmd === '-v') {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
  console.log(pkg.version);
} else if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(`switchbot-openclaw — MCP plugin for SwitchBot smart-home control

Usage:
  switchbot-openclaw             Start the stdio MCP server (default; used by MCP hosts).
  switchbot-openclaw setup       Interactive CLI install + token bootstrap.
  switchbot-openclaw --version   Print the plugin version.
  switchbot-openclaw --help      Show this help.

See https://github.com/OpenWonderLabs/switchbot-openapi-cli for full docs.`);
} else {
  // Default: bootstrap wrapper — auto-configure then hand off to switchbot mcp serve.
  // MCP mode must NOT write to stdout (it's the JSON-RPC channel); use stderr for logs.

  const { checkCli } = await import('../setup/check-cli.js');
  const { checkCredentials } = await import('../setup/check-credentials.js');
  const { checkDaemon } = await import('../setup/check-daemon.js');

  function setupRequired(message) {
    process.stderr.write(`[switchbot-channel] Setup required: ${message}\n`);
    process.stdout.write(JSON.stringify({ setupRequired: true, message }) + '\n');
    process.exit(1);
  }

  // [1] CLI installed? → auto-install if missing
  const cliCheck = await checkCli();
  if (!cliCheck.ok) setupRequired(cliCheck.message);

  // [2] Credentials configured? (must be done by user — can't automate token input)
  const credCheck = await checkCredentials();
  if (!credCheck.ok) setupRequired(credCheck.message);

  // [3] Daemon needed? → auto-start if automation rules are active
  await checkDaemon();

  // [4] Hand off to switchbot mcp serve — exposes all 24 MCP tools
  try {
    execFileSync('switchbot', ['mcp', 'serve'], { stdio: 'inherit' });
  } catch (err) {
    process.stderr.write(
      `[switchbot-channel] switchbot mcp serve exited: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}
