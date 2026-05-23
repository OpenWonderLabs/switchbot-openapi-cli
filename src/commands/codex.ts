import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runDoctorChecks } from './doctor.js';
import {
  checkCodexCli,
  checkCodexPluginNpm,
  checkCodexPluginRegistered,
  runCodexPluginRegistration,
  resolvePluginId,
  resolveCodexPackageRoot,
  type Check,
} from '../install/codex-checks.js';
import { isJsonMode, printJson } from '../utils/output.js';
import { getActiveProfile } from '../lib/request-context.js';

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

// ─── repair ──────────────────────────────────────────────────────────────────

interface RepairContext {
  profile: string;
  codexPluginId: string;
  packageRoot: string | null;
  nonInteractive: boolean;
}

interface RepairOutcome {
  step: string;
  status: 'ok' | 'skipped' | 'failed';
  message?: string;
}

async function repairStepVerifyCli(_ctx: RepairContext): Promise<RepairOutcome> {
  const checks = await runDoctorChecks(['node', 'path']);
  const fail = checks.find((c) => c.status === 'fail');
  if (fail) {
    const msg = typeof fail.detail === 'string'
      ? fail.detail
      : (fail.detail as { message?: string }).message ?? JSON.stringify(fail.detail);
    return { step: 'verify-cli', status: 'failed', message: msg };
  }
  return { step: 'verify-cli', status: 'ok', message: 'node + path ok' };
}

async function credentialsPresent(): Promise<boolean> {
  try {
    const { tryLoadConfig } = await import('../config.js');
    const cfg = tryLoadConfig();
    return Boolean(cfg && cfg.token && cfg.secret);
  } catch {
    return false;
  }
}

async function repairStepReAuth(ctx: RepairContext): Promise<RepairOutcome> {
  if (await credentialsPresent()) {
    return { step: 're-auth', status: 'ok', message: 'credentials present' };
  }
  if (ctx.nonInteractive) {
    return {
      step: 're-auth',
      status: 'failed',
      message: JSON.stringify({ reason: 'credentials-missing', hint: 'run: switchbot auth login' }),
    };
  }
  const r = spawnSync('switchbot', ['auth', 'login'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if ((r.status ?? 1) !== 0) {
    return { step: 're-auth', status: 'failed', message: `auth login exited ${r.status ?? 1}` };
  }
  return { step: 're-auth', status: 'ok', message: 'auth login completed' };
}

function repairStepRemovePlugin(ctx: RepairContext): RepairOutcome {
  const r = spawnSync(
    'codex', ['plugin', 'remove', ctx.codexPluginId],
    { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 15000 },
  );
  if ((r.status ?? 1) !== 0) {
    return { step: 'remove-plugin', status: 'failed', message: `exit ${r.status ?? 1} (non-fatal)` };
  }
  return { step: 'remove-plugin', status: 'ok' };
}

function repairStepRegisterPlugin(ctx: RepairContext): RepairOutcome {
  let packageRoot: string;
  if (ctx.packageRoot) {
    packageRoot = ctx.packageRoot;
  } else {
    const root = resolveCodexPackageRoot();
    if (!root.ok) {
      return { step: 'register-plugin', status: 'failed', message: root.error };
    }
    packageRoot = root.packageRoot;
  }
  const pluginId = resolvePluginId(packageRoot);
  const result = runCodexPluginRegistration(packageRoot, pluginId);
  if (!result.ok) {
    return { step: 'register-plugin', status: 'failed', message: `exit ${result.exitCode}: ${result.stderr}` };
  }
  return { step: 'register-plugin', status: 'ok', message: 'marketplace add + plugin add succeeded' };
}

async function repairStepDoctorVerify(): Promise<RepairOutcome> {
  const checks = await runAllCodexDoctorChecks();
  const summary = {
    ok:   checks.filter((c) => c.status === 'ok').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
  };
  return {
    step: 'doctor-verify',
    status: summary.fail > 0 ? 'failed' : 'ok',
    message: `${summary.ok} ok, ${summary.warn} warn, ${summary.fail} fail`,
  };
}

const REPAIR_STEPS = [
  { name: 'verify-cli',      description: 'Verify node and switchbot binary on PATH',    skippable: false },
  { name: 're-auth',         description: 'Check credentials; hint if missing',           skippable: true  },
  { name: 'remove-plugin',   description: 'codex plugin remove (best-effort, non-fatal)', skippable: true  },
  { name: 'register-plugin', description: 'codex plugin marketplace add + plugin add',    skippable: false },
  { name: 'doctor-verify',   description: 'Run Codex doctor checks and report health',    skippable: false },
] as const;

async function runRepair(
  skip: Set<string>,
  ctx: RepairContext,
): Promise<{ outcomes: RepairOutcome[]; anyFailed: boolean; preflightFailed: boolean }> {
  const outcomes: RepairOutcome[] = [];
  let preflightFailed = false;

  for (const step of REPAIR_STEPS) {
    if (skip.has(step.name)) {
      outcomes.push({ step: step.name, status: 'skipped' });
      continue;
    }
    let outcome: RepairOutcome;
    if (step.name === 'verify-cli')           outcome = await repairStepVerifyCli(ctx);
    else if (step.name === 're-auth')          outcome = await repairStepReAuth(ctx);
    else if (step.name === 'remove-plugin')    outcome = repairStepRemovePlugin(ctx);
    else if (step.name === 'register-plugin')  outcome = repairStepRegisterPlugin(ctx);
    else                                       outcome = await repairStepDoctorVerify();
    outcomes.push(outcome);
    if (step.name === 'verify-cli' && outcome.status === 'failed') {
      preflightFailed = true;
      break;
    }
  }
  const anyFailed = outcomes.some((o) => o.status === 'failed');
  return { outcomes, anyFailed, preflightFailed };
}

function registerCodexRepairSubcommand(codex: Command): void {
  codex
    .command('repair')
    .description('Repair the Codex integration: re-check auth, re-register plugin, verify health')
    .option('--skip <names>', 'Comma-separated step names to skip (e.g. "re-auth,remove-plugin")')
    .option('--yes', 'Non-interactive mode: skip spawning auth login, return machine-readable error if credentials missing')
    .action(async (opts: { skip?: string; yes?: boolean }, command: Command) => {
      const skip = new Set(
        (opts.skip ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      );
      const globalOpts = command.parent?.parent?.opts() ?? {};
      const dryRun = Boolean(globalOpts.dryRun);
      const profile = getActiveProfile() ?? 'default';

      if (dryRun) {
        if (isJsonMode()) {
          printJson({
            dryRun: true,
            steps: REPAIR_STEPS.map((s) => ({
              name: s.name,
              description: s.description,
              skippable: s.skippable,
              willSkip: skip.has(s.name),
            })),
          });
        } else {
          console.error(chalk.bold('switchbot codex repair — dry run'));
          console.error('');
          console.error(chalk.bold('Steps (in order):'));
          for (const s of REPAIR_STEPS) {
            const tag = skip.has(s.name) ? chalk.dim('  · (skip)') : '  •';
            console.error(`${tag} ${s.name.padEnd(18)} ${s.description}`);
          }
          console.error('');
          console.error(chalk.dim('No changes made. Re-run without --dry-run to apply.'));
        }
        process.exit(0);
        return;
      }

      const root = resolveCodexPackageRoot();
      const ctx: RepairContext = {
        profile,
        codexPluginId: root.ok ? resolvePluginId(root.packageRoot) : 'switchbot@switchbot-codex-plugin',
        packageRoot: root.ok ? root.packageRoot : null,
        nonInteractive: Boolean(opts.yes),
      };

      if (!isJsonMode()) console.log(chalk.bold('Repairing Codex integration...'));
      if (!isJsonMode()) console.log('');

      const { outcomes, anyFailed, preflightFailed } = await runRepair(skip, ctx);

      if (isJsonMode()) {
        printJson({ ok: !anyFailed, preflightFailed, outcomes });
      } else {
        for (const o of outcomes) {
          const icon =
            o.status === 'ok'      ? chalk.green('✓') :
            o.status === 'skipped' ? chalk.dim('·') :
                                     chalk.red('✗');
          console.log(`${icon} ${o.step.padEnd(18)} ${o.message ?? ''}`);
        }
        console.log('');
        if (!anyFailed) {
          console.log(chalk.green('Repair complete. Restart Codex and run: switchbot devices list'));
        } else if (preflightFailed) {
          console.log(chalk.red('Preflight failed — fix the above issue and re-run.'));
        } else {
          console.log(chalk.yellow('Repair finished with failures. Review the output above.'));
        }
      }
      if (preflightFailed) process.exit(2);
      if (anyFailed) process.exit(1);
      process.exit(0);
    });
}

export function registerCodexCommand(program: Command): void {
  const codex = program
    .command('codex')
    .description('Codex integration management (register, health, repair)');
  registerCodexDoctorSubcommand(codex);
  registerCodexRepairSubcommand(codex);
}
