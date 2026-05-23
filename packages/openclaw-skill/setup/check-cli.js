// setup/check-cli.js — verify switchbot CLI is installed; auto-install via npm if missing
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { formatError } from '../lib/error-messages.js';

const exec = promisify(execFile);

async function cliExists() {
  try {
    await exec('switchbot', ['--version'], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

function npmExists() {
  try {
    execFileSync('npm', ['--version'], { timeout: 8000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export async function checkCli() {
  if (await cliExists()) return { ok: true };

  if (!npmExists()) {
    return {
      ok: false,
      message:
        'Error: Node.js / npm is not installed.\n' +
        '  Fix:  Install Node.js from https://nodejs.org, then reopen the SwitchBot channel.\n' +
        '  Hint: Node 18 or later is required.',
    };
  }

  process.stderr.write('[switchbot-channel] CLI not found — auto-installing @switchbot/openapi-cli…\n');
  try {
    execFileSync('npm', ['install', '-g', '@switchbot/openapi-cli'], {
      stdio: 'inherit',
      timeout: 120_000,
    });
  } catch (err) {
    return {
      ok: false,
      message:
        `Error: CLI installation failed: ${err instanceof Error ? err.message : String(err)}\n` +
        `  Fix:  npm install -g @switchbot/openapi-cli\n` +
        `  Hint: Check your network connection and npm permissions.`,
    };
  }

  if (!(await cliExists())) {
    return {
      ok: false,
      message: formatError('cli-not-installed') +
        '\n  (CLI was installed but `switchbot` is still not on PATH — reopen your terminal.)',
    };
  }

  process.stderr.write('[switchbot-channel] CLI installed.\n');
  return { ok: true };
}
