import { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { runDoctorChecks, formatDoctorChecks } from './doctor.js';
import {
  checkCodexCli,
  checkCodexPluginNpm,
  checkCodexPluginRegistered,
  registerCodexPluginAuto,
  resolvePluginId,
  resolveCodexPackageRoot,
  type Check,
} from '../install/codex-checks.js';
import { isJsonMode, printJson } from '../utils/output.js';
import { getActiveProfile } from '../lib/request-context.js';
import { getConfigPath } from '../utils/flags.js';

const CODEX_BASE_SECTIONS = ['node', 'path', 'credentials', 'mcp'] as const;
const SWITCHBOT_CLI_PACKAGE = '@switchbot/openapi-cli';

async function runAllCodexDoctorChecks(): Promise<Check[]> {
  const base = await runDoctorChecks(CODEX_BASE_SECTIONS);
  const codexChecks: Check[] = [
    checkCodexCli(),
    checkCodexPluginNpm(),
    checkCodexPluginRegistered(),
  ];
  return [...base, ...codexChecks];
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
        formatDoctorChecks(checks, Boolean(opts.quiet));
        console.log('');
        console.log(`${summary.ok} ok, ${summary.warn} warn, ${summary.fail} fail`);
        if (hasFail || summary.warn > 0) {
          console.log(chalk.dim('Run: switchbot codex repair'));
        }
      }
      process.exit(hasFail ? 1 : 0);
    });
}

// ─── shared helpers ──────────────────────────────────────────────────────────

/**
 * argv builder shared by `codex repair re-auth` and `codex setup auth`.
 * Spawns the current `switchbot` binary (via process.execPath + cliPath) so
 * the subprocess inherits `--profile` / `--config` from the active scope and
 * credentials are written/read against the correct profile.
 */
function buildAuthLoginArgv(profile: string, configPath?: string): string[] {
  const cliPath = process.argv[1] ?? '';
  return [
    cliPath,
    ...(profile !== 'default' ? ['--profile', profile] : []),
    ...(configPath ? ['--config', configPath] : []),
    'auth', 'login',
  ];
}

interface StepOutcome {
  step: string;
  status: 'ok' | 'skipped' | 'failed';
  message?: string;
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

// ─── repair ──────────────────────────────────────────────────────────────────

interface RepairContext {
  profile: string;
  configPath?: string;
  codexPluginId?: string;
  packageRoot?: string | null;
  nonInteractive: boolean;
}

type RepairOutcome = StepOutcome;

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
  const argv = buildAuthLoginArgv(ctx.profile, ctx.configPath);
  const r = spawnSync(process.execPath, argv, { stdio: 'inherit' });
  if ((r.status ?? 1) !== 0) {
    return { step: 're-auth', status: 'failed', message: `auth login exited ${r.status ?? 1}` };
  }
  return { step: 're-auth', status: 'ok', message: 'auth login completed' };
}

function repairStepRemovePlugin(ctx: RepairContext): RepairOutcome {
  let pluginId = ctx.codexPluginId;
  if (!pluginId) {
    const root = resolveCodexPackageRoot();
    pluginId = root.ok ? resolvePluginId(root.packageRoot) : 'switchbot@codex-plugin';
    ctx.codexPluginId = pluginId;
  }
  const r = spawnSync(
    'codex', ['plugin', 'remove', pluginId],
    { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 15000 },
  );
  if ((r.status ?? 1) !== 0) {
    return { step: 'remove-plugin', status: 'failed', message: `exit ${r.status ?? 1} (non-fatal)` };
  }
  return { step: 'remove-plugin', status: 'ok' };
}

function stepRegisterPluginShared(stepName: string, ctx: { codexPluginId?: string; packageRoot?: string | null }): StepOutcome {
  const r = registerCodexPluginAuto();
  if (!r.ok) {
    return { step: stepName, status: 'failed', message: r.error };
  }
  ctx.codexPluginId = r.pluginId;
  ctx.packageRoot = r.packageRoot;
  return { step: stepName, status: 'ok', message: 'marketplace add + plugin add succeeded' };
}

function repairStepRegisterPlugin(ctx: RepairContext): RepairOutcome {
  return stepRegisterPluginShared('register-plugin', ctx);
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

interface StepDef {
  name: string;
  description: string;
  skippable: boolean;
}

const REPAIR_STEPS: readonly StepDef[] = [
  { name: 'verify-cli',      description: 'Verify node and switchbot binary on PATH',    skippable: false },
  { name: 're-auth',         description: 'Check credentials; spawn auth login if missing', skippable: true  },
  { name: 'remove-plugin',   description: 'codex plugin remove (best-effort, non-fatal)', skippable: true  },
  { name: 'register-plugin', description: 'codex plugin marketplace add + plugin add',    skippable: false },
  { name: 'doctor-verify',   description: 'Run Codex doctor checks and report health',    skippable: false },
];

// Step names removed from SETUP_STEPS/REPAIR_STEPS in past releases; silently
// accepted by --skip for backward compatibility instead of exit 2.
const DEPRECATED_SKIP_NAMES = new Set(['install-codex-plugin']);

function validateSkip(stepDefs: readonly StepDef[], skip: Set<string>): { ok: true } | { ok: false; offending: string } {
  const skippableNames = new Set(stepDefs.filter((s) => s.skippable).map((s) => s.name));
  for (const name of skip) {
    if (DEPRECATED_SKIP_NAMES.has(name)) continue;
    if (!skippableNames.has(name)) {
      return { ok: false, offending: name };
    }
  }
  return { ok: true };
}

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
      const skipCheck = validateSkip(REPAIR_STEPS, skip);
      if (!skipCheck.ok) {
        console.error(`invalid --skip: '${skipCheck.offending}' is not skippable`);
        process.exit(2);
        return;
      }
      const globalOpts = command.parent?.parent?.opts() ?? {};
      const dryRun = Boolean(globalOpts.dryRun);
      const profile = getActiveProfile() ?? 'default';
      const configPath = getConfigPath();

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

      const ctx: RepairContext = {
        profile,
        configPath,
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

// ─── setup ───────────────────────────────────────────────────────────────────

interface SetupContext {
  profile: string;
  configPath?: string;
  codexPluginId?: string;
  packageRoot?: string | null;
  nonInteractive: boolean;
}

type SetupOutcome = StepOutcome;

const SETUP_STEPS: readonly StepDef[] = [
  { name: 'check-codex-cli',       description: 'Verify codex CLI on PATH',                                        skippable: false },
  { name: 'install-switchbot-cli', description: 'Install @switchbot/openapi-cli if missing',                       skippable: true  },
  { name: 'register-plugin',       description: 'Register plugin (Route B git; npm install + Route A on fallback)', skippable: false },
  { name: 'auth',                  description: 'Verify credentials; spawn auth login if missing',                 skippable: true  },
  { name: 'doctor-verify',         description: 'Run 4 base + 3 Codex checks and report health',                   skippable: false },
];

function setupStepCheckCodexCli(): SetupOutcome {
  const c = checkCodexCli();
  if (c.status === 'fail') {
    const msg = typeof c.detail === 'string'
      ? c.detail
      : (c.detail as { message?: string }).message ?? JSON.stringify(c.detail);
    return { step: 'check-codex-cli', status: 'failed', message: msg };
  }
  const detail = typeof c.detail === 'object' && c.detail !== null
    ? c.detail as { path?: string; version?: string | null }
    : {};
  const where = detail.path ? `${detail.path}${detail.version ? ` (${detail.version})` : ''}` : 'on PATH';
  return { step: 'check-codex-cli', status: 'ok', message: where };
}

function setupStepInstallSwitchbotCli(): SetupOutcome {
  return setupStepInstallGlobalPackage(
    'install-switchbot-cli',
    SWITCHBOT_CLI_PACKAGE,
  );
}

function setupStepInstallGlobalPackage(step: string, packageName: string): SetupOutcome {
  const list = spawnSync(
    'npm', ['list', '-g', '--json', '--depth=0', packageName],
    { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 15000 },
  );
  let installed = false;
  try {
    const parsed = JSON.parse(list.stdout ?? '{}') as { dependencies?: Record<string, unknown> };
    installed = Boolean(parsed?.dependencies?.[packageName]);
  } catch { /* treat as not installed */ }
  if (installed) {
    return { step, status: 'ok', message: 'already installed' };
  }
  const inst = spawnSync(
    'npm', ['install', '-g', `${packageName}@latest`],
    { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 120000 },
  );
  if ((inst.status ?? 1) !== 0) {
    return {
      step,
      status: 'failed',
      message: `npm install -g failed (exit ${inst.status ?? 1}): ${inst.stderr ?? ''}`,
    };
  }
  return { step, status: 'ok', message: `installed ${packageName}@latest` };
}

function setupStepRegisterPlugin(ctx: SetupContext): SetupOutcome {
  const r = registerCodexPluginAuto();
  if (!r.ok) {
    return { step: 'register-plugin', status: 'failed', message: r.error };
  }
  ctx.codexPluginId = r.pluginId;
  ctx.packageRoot = r.packageRoot;
  const via = r.packageRoot ? 'local npm (Route A fallback)' : 'git marketplace (Route B)';
  return { step: 'register-plugin', status: 'ok', message: `registered via ${via}` };
}

async function setupStepAuth(ctx: SetupContext): Promise<SetupOutcome> {
  if (await credentialsPresent()) {
    return { step: 'auth', status: 'ok', message: 'credentials present' };
  }
  if (ctx.nonInteractive) {
    return {
      step: 'auth',
      status: 'failed',
      message: JSON.stringify({ reason: 'credentials-missing', hint: 'run: switchbot auth login' }),
    };
  }
  const argv = buildAuthLoginArgv(ctx.profile, ctx.configPath);
  const r = spawnSync(process.execPath, argv, { stdio: 'inherit' });
  if ((r.status ?? 1) !== 0) {
    return { step: 'auth', status: 'failed', message: `auth login exited ${r.status ?? 1}` };
  }
  return { step: 'auth', status: 'ok', message: 'auth login completed' };
}

async function setupStepDoctorVerify(): Promise<SetupOutcome> {
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

async function runSetup(
  skip: Set<string>,
  ctx: SetupContext,
): Promise<{ outcomes: SetupOutcome[]; anyFailed: boolean; preflightFailed: boolean }> {
  const outcomes: SetupOutcome[] = [];
  let preflightFailed = false;

  for (const step of SETUP_STEPS) {
    if (skip.has(step.name)) {
      outcomes.push({ step: step.name, status: 'skipped' });
      continue;
    }
    let outcome: SetupOutcome;
    if (step.name === 'check-codex-cli')             outcome = setupStepCheckCodexCli();
    else if (step.name === 'install-switchbot-cli')  outcome = setupStepInstallSwitchbotCli();
    else if (step.name === 'register-plugin')        outcome = setupStepRegisterPlugin(ctx);
    else if (step.name === 'auth')                   outcome = await setupStepAuth(ctx);
    else                                             outcome = await setupStepDoctorVerify();
    outcomes.push(outcome);
    if (step.name === 'check-codex-cli' && outcome.status === 'failed') {
      preflightFailed = true;
      break;
    }
  }
  const anyFailed = outcomes.some((o) => o.status === 'failed');
  return { outcomes, anyFailed, preflightFailed };
}

function registerCodexSetupSubcommand(codex: Command): void {
  codex
    .command('setup')
    .description('Bootstrap the Codex integration end-to-end: install packages if missing, register plugin, auth, verify')
    .option('--skip <names>', 'Comma-separated step names to skip (skippable: "install-switchbot-cli", "auth"; deprecated no-ops: "install-codex-plugin")')
    .option('--yes', 'Non-interactive mode: do not spawn auth login, fail fast if credentials missing')
    .addHelpText('after', `
Environment variables:
  CODEX_GIT_MARKETPLACE_REF        Git ref used when registering via git marketplace (default: main)
  CODEX_MARKETPLACE_ADD_TIMEOUT    Timeout in ms for "codex plugin marketplace add" (default: 60000)
`)
    .action(async (opts: { skip?: string; yes?: boolean }, command: Command) => {
      const skip = new Set(
        (opts.skip ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      );
      const skipCheck = validateSkip(SETUP_STEPS, skip);
      if (!skipCheck.ok) {
        console.error(`invalid --skip: '${skipCheck.offending}' is not skippable`);
        process.exit(2);
        return;
      }
      const globalOpts = command.parent?.parent?.opts() ?? {};
      const dryRun = Boolean(globalOpts.dryRun);
      const profile = getActiveProfile() ?? 'default';
      const configPath = getConfigPath();

      if (dryRun) {
        if (isJsonMode()) {
          printJson({
            dryRun: true,
            steps: SETUP_STEPS.map((s) => ({
              name: s.name,
              description: s.description,
              skippable: s.skippable,
              willSkip: skip.has(s.name),
            })),
          });
        } else {
          console.error(chalk.bold('switchbot codex setup — dry run'));
          console.error('');
          console.error(chalk.bold('Steps (in order):'));
          for (const s of SETUP_STEPS) {
            const tag = skip.has(s.name) ? chalk.dim('  · (skip)') : '  •';
            console.error(`${tag} ${s.name.padEnd(22)} ${s.description}`);
          }
          console.error('');
          console.error(chalk.dim('No changes made. Re-run without --dry-run to apply.'));
        }
        process.exit(0);
        return;
      }

      const ctx: SetupContext = {
        profile,
        configPath,
        nonInteractive: Boolean(opts.yes),
      };

      if (!isJsonMode()) console.log(chalk.bold('Setting up Codex integration...'));
      if (!isJsonMode()) console.log('');

      const { outcomes, anyFailed, preflightFailed } = await runSetup(skip, ctx);

      if (isJsonMode()) {
        printJson({ ok: !anyFailed, preflightFailed, outcomes });
      } else {
        for (const o of outcomes) {
          const icon =
            o.status === 'ok'      ? chalk.green('✓') :
            o.status === 'skipped' ? chalk.dim('·') :
                                     chalk.red('✗');
          console.log(`${icon} ${o.step.padEnd(22)} ${o.message ?? ''}`);
        }
        console.log('');
        if (!anyFailed) {
          console.log(chalk.green('Setup complete. Restart Codex and run: switchbot devices list'));
        } else if (preflightFailed) {
          console.log(chalk.red('Preflight failed — install Codex CLI first, then re-run.'));
        } else {
          console.log(chalk.yellow('Setup finished with failures. Review the output above.'));
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
    .description('Codex integration management (setup, register, health, repair)');
  registerCodexDoctorSubcommand(codex);
  registerCodexRepairSubcommand(codex);
  registerCodexSetupSubcommand(codex);
}
