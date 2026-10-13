// setup/check-cli.js — verify the installed CLI; leave installation to the user.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatError } from '../lib/error-messages.js';
import { switchbotInvocation } from './cli-invocation.js';

const exec = promisify(execFile);

export const REQUIRED_CLI_VERSION = '3.9.0';

export function versionAtLeast(have, need = REQUIRED_CLI_VERSION) {
  const actual = have.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const required = need.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(actual.length, required.length); index += 1) {
    if ((actual[index] ?? 0) !== (required[index] ?? 0)) {
      return (actual[index] ?? 0) > (required[index] ?? 0);
    }
  }
  return true;
}

async function cliVersion() {
  try {
    const invocation = switchbotInvocation(['--version']);
    const { stdout } = await exec(invocation.command, invocation.args, { timeout: 8000 });
    return stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function checkCli() {
  const installedVersion = await cliVersion();
  if (!installedVersion) return { ok: false, message: formatError('cli-not-installed') };
  if (versionAtLeast(installedVersion)) return { ok: true };
  return {
    ok: false,
    message: `${formatError('cli-version-too-low')}\n  Detected: ${installedVersion}; required: >=${REQUIRED_CLI_VERSION}.`,
  };
}
