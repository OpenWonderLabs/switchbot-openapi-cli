import { Command } from 'commander';
import chalk from 'chalk';
import { runDoctorChecks } from './doctor.js';
import {
  checkCodexCli,
  checkCodexPluginNpm,
  checkCodexPluginRegistered,
  type Check,
} from '../install/codex-checks.js';
import { isJsonMode, printJson } from '../utils/output.js';

const CODEX_BASE_SECTIONS = ['node', 'path', 'credentials', 'mcp'] as const;

async function runAllCodexDoctorChecks(): Promise<Check[]> {
  const base = await runDoctorChecks(CODEX_BASE_SECTIONS);
  const codexChecks: Check[] = [
    checkCodexCli(),
    checkCodexPluginNpm(),
    checkCodexPluginRegistered(),
  ];
  return [...base, ...codexChecks];
}

function printDoctorChecks(checks: Check[], quiet: boolean): void {
  for (const c of checks) {
    if (quiet && c.status === 'ok') continue;
    const icon =
      c.status === 'ok'   ? chalk.green('✓') :
      c.status === 'warn' ? chalk.yellow('!') :
                            chalk.red('✗');
    const detailStr =
      typeof c.detail === 'string'
        ? c.detail
        : typeof (c.detail as { message?: unknown }).message === 'string'
          ? (c.detail as { message: string }).message
          : JSON.stringify(c.detail);
    console.log(`${icon} ${c.name.padEnd(24)} ${detailStr}`);
  }
}

function registerCodexDoctorSubcommand(codex: Command): void {
  codex
    .command('doctor')
    .description(
      'Check Codex integration health (7 checks: node, path, credentials, mcp, codex-cli, npm plugin, registered)',
    )
    .option('-q, --quiet', 'Only show warn/fail checks')
    .action(async (opts: { quiet?: boolean }) => {
      const checks = await runAllCodexDoctorChecks();
      const summary = {
        ok:   checks.filter((c) => c.status === 'ok').length,
        warn: checks.filter((c) => c.status === 'warn').length,
        fail: checks.filter((c) => c.status === 'fail').length,
      };
      const hasFail = summary.fail > 0;
      const overall: 'ok' | 'warn' | 'fail' =
        hasFail ? 'fail' : summary.warn > 0 ? 'warn' : 'ok';

      if (isJsonMode()) {
        printJson({ ok: !hasFail, overall, summary, checks });
      } else {
        printDoctorChecks(checks, Boolean(opts.quiet));
        console.log('');
        console.log(`${summary.ok} ok, ${summary.warn} warn, ${summary.fail} fail`);
      }
      process.exit(hasFail ? 1 : 0);
    });
}

export function registerCodexCommand(program: Command): void {
  const codex = program
    .command('codex')
    .description('Codex integration management (register, health, repair)');
  registerCodexDoctorSubcommand(codex);
}
