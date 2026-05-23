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

export function makeRunAuth({ checkCli, checkCredentials, runInherit }) {
  return async function runAuth() {
    const cliCheck = await checkCli();
    if (!cliCheck.ok) {
      process.stderr.write(`[switchbot-codex] ${cliCheck.message}\n`);
      return 1;
    }
    process.stderr.write(`[switchbot-codex] CLI ${cliCheck.version} detected.\n`);

    const credCheck = await checkCredentials();
    if (credCheck.ok) {
      process.stderr.write(`[switchbot-codex] Credentials present (${credCheck.source}). Skipping login.\n`);
      return 0;
    }

    process.stderr.write('[switchbot-codex] Starting browser login...\n');
    const loginCode = await runInherit('switchbot', ['auth', 'login']);
    if (loginCode !== 0) {
      process.stderr.write(`[switchbot-codex] ${formatError('auth-login-failed')}\n`);
      return loginCode;
    }

    process.stderr.write('[switchbot-codex] Verifying credentials via doctor...\n');
    const doctorCode = await runInherit('switchbot', ['doctor']);
    if (doctorCode !== 0) {
      const postLoginCheck = await checkCredentials();
      const errorMessage = postLoginCheck.ok
        ? formatError('doctor-check-failed')
        : postLoginCheck.message ?? formatError(postLoginCheck.errorKey ?? 'doctor-check-failed');
      process.stderr.write(`[switchbot-codex] ${errorMessage}\n`);
      return doctorCode;
    }

    process.stderr.write('[switchbot-codex] Setup complete.\n');
    return 0;
  };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('bin/auth.js');
if (isMain) {
  const runAuth = makeRunAuth({
    checkCli: defaultCheckCli,
    checkCredentials: defaultCheckCredentials,
    runInherit: defaultRunInherit,
  });
  runAuth().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`[switchbot-codex] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
