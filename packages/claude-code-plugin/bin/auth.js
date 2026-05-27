#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { checkCli as defaultCheckCli } from '../setup/check-cli.js';
import { checkCredentials as defaultCheckCredentials } from '../setup/check-credentials.js';
import { formatError } from '../lib/error-messages.js';

function defaultRunInherit(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: 'inherit' });
    p.on('close', code => resolve(code ?? 0));
    p.on('error', () => resolve(127));
  });
}

export function makeRunOnInstall({ checkCli, checkCredentials, runInherit }) {
  return async function runOnInstall() {
    const cliCheck = await checkCli();
    if (!cliCheck.ok) {
      process.stderr.write(`[switchbot-claude] ${cliCheck.message}\n`);
      return 1;
    }
    process.stderr.write(`[switchbot-claude] CLI ${cliCheck.version} detected.\n`);

    const credCheck = await checkCredentials();
    if (credCheck.ok) {
      process.stderr.write(`[switchbot-claude] Credentials present (${credCheck.source}). Setup complete.\n`);
      return 0;
    }

    process.stderr.write('[switchbot-claude] SwitchBot credentials not found. Opening browser login...\n');
    const loginCode = await runInherit('switchbot', ['auth', 'login']);
    if (loginCode !== 0) {
      process.stderr.write(`[switchbot-claude] ${formatError('auth-login-failed')}\n`);
      return loginCode;
    }

    const postCheck = await checkCredentials();
    if (!postCheck.ok) {
      process.stderr.write(`[switchbot-claude] ${postCheck.message ?? formatError(postCheck.errorKey ?? 'auth-login-failed')}\n`);
      return 1;
    }

    process.stderr.write('[switchbot-claude] Setup complete.\n');
    return 0;
  };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('bin/auth.js');
if (isMain) {
  const run = makeRunOnInstall({
    checkCli: defaultCheckCli,
    checkCredentials: defaultCheckCredentials,
    runInherit: defaultRunInherit,
  });
  run().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`[switchbot-claude] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
