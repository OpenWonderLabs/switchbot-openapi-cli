#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { checkCli as defaultCheckCli } from '../setup/check-cli.js';

function defaultRunInherit(cmd, args) {
  return new Promise((resolveFn) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true });
    child.on('close', (code) => resolveFn(code ?? 0));
    child.on('error', () => resolveFn(127));
  });
}

export function makeInstall({ checkCli, runInherit }) {
  return async function install() {
    process.stderr.write(
      '[switchbot-codex] WARNING: switchbot-codex-install is deprecated.\n' +
      '[switchbot-codex] Preferred: npx @switchbot/openapi-cli codex setup\n' +
      '[switchbot-codex] This binary continues to work during the transition period.\n'
    );
    const cliCheck = await checkCli();
    if (!cliCheck.ok) {
      process.stderr.write('[switchbot-codex] CLI not found. Installing @switchbot/openapi-cli...\n');
      const installCode = await runInherit('npm', ['install', '-g', '@switchbot/openapi-cli@latest']);
      if (installCode !== 0) {
        process.stderr.write('[switchbot-codex] CLI install failed. Run manually: npm install -g @switchbot/openapi-cli@latest\n');
        return installCode;
      }
      const installedCli = await checkCli();
      if (!installedCli.ok) {
        process.stderr.write(`[switchbot-codex] ${installedCli.message}\n`);
        return 1;
      }
    } else {
      process.stderr.write(`[switchbot-codex] CLI ${cliCheck.version} detected.\n`);
    }

    process.stderr.write('[switchbot-codex] Delegating registration to switchbot codex setup...\n');
    const setupCode = await runInherit('switchbot', ['codex', 'setup']);
    if (setupCode !== 0) {
      process.stderr.write('[switchbot-codex] Delegated Codex setup failed.\n');
    }
    return setupCode;
  };
}

const isMain = process.argv[1]?.replace(/\\/g, '/').endsWith('bin/install.js');
if (isMain) {
  const install = makeInstall({
    checkCli: defaultCheckCli,
    runInherit: defaultRunInherit,
  });
  install().then(code => process.exit(code)).catch(err => {
    process.stderr.write(`[switchbot-codex] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
