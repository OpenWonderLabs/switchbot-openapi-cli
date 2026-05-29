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
  CODEX_PLUGIN_DEFAULT_ID,
  CODEX_PLUGIN_LEGACY_IDS,
  type Check,
} from '../install/codex-checks.js';
import { isJsonMode, printJson } from '../utils/output.js';
import { getActiveProfile } from '../lib/request-context.js';
import { getConfigPath } from '../utils/flags.js';
import { VERSION } from '../version.js';

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  // Strip pre-release/build metadata (e.g. '3.8.0-rc.1+build' → '3.8.0')
  const core = (v: string) => (v.split(/[-+]/)[0] ?? v).split('.').map(Number);
  const pa = core(a);
  const pb = core(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

function fetchLatestPublishedVersion(packageName: string): { version: string; fromRegistry: boolean } {
  const r = spawnSync(
    'npm', ['view', packageName, 'version'],
    { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 8000 },
  );
  if ((r.status ?? 1) === 0) {
    const v = (r.stdout ?? '').trim();
    if (/^\d+\.\d+\.\d+/.test(v)) return { version: v, fromRegistry: true };
  }
  // Offline or registry error: fall back to the running binary's own version.
  // When invoked via npx, VERSION == latest, so the comparison still works.
  return { version: VERSION, fromRegistry: false };
}

const CODEX_BASE_SECTIONS = ['node', 'path', 'credentials', 'mcp'] as const;
const SWITCHBOT_CLI_PACKAGE = '@switchbot/openapi-cli';

async function runAllCodexDoctorChecks(): Promise<Check[]> {
  const base = (await runDoctorChecks(CODEX_BASE_SECTIONS)) ?? [];
  const codexChecks: Check[] = [
    checkCodexCli(),
    checkCodexPluginNpm(),
    checkCodexPluginRegistered(),
  ].filter(Boolean) as Check[];
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
  status: 'ok' | 'skipped' | 'failed' | 'warn';
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
  pluginAlreadyOk?: boolean;
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

function repairStepPreflightPlugin(ctx: RepairContext): RepairOutcome {
  const check = checkCodexPluginRegistered();
  if (check.status === 'ok') {
    ctx.pluginAlreadyOk = true;
    const detail = check.detail as { pluginName?: string } | undefined;
    const name = detail?.pluginName ? ` (${detail.pluginName})` : '';
    return { step: 'preflight-plugin', status: 'ok', message: `already registered${name} — skipping remove + re-register` };
  }
  const detail = check.detail as { message?: string; reason?: string } | undefined;
  const hint = detail?.message ?? detail?.reason ?? '';
  return { step: 'preflight-plugin', status: 'ok', message: `not registered${hint ? `: ${hint}` : ''} — will register` };
}

function repairStepRemovePlugin(ctx: RepairContext): RepairOutcome {
  if (ctx.pluginAlreadyOk) {
    return { step: 'remove-plugin', status: 'skipped', message: 'plugin already registered — skipped' };
  }
  let pluginId = ctx.codexPluginId;
  if (!pluginId) {
    const root = resolveCodexPackageRoot();
    pluginId = root.ok ? resolvePluginId(root.packageRoot) : CODEX_PLUGIN_DEFAULT_ID;
    ctx.codexPluginId = pluginId;
  }
  for (const id of [...new Set([pluginId, ...CODEX_PLUGIN_LEGACY_IDS])]) {
    const r = spawnSync(
      'codex', ['plugin', 'remove', id],
      { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 15000 },
    );
    if ((r.status ?? 1) !== 0) {
      process.stderr.write(`[switchbot] Warning: codex plugin remove "${id}" exited ${r.status ?? 1} (non-fatal)\n`);
    }
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
  if (ctx.pluginAlreadyOk) {
    return { step: 'register-plugin', status: 'skipped', message: 'plugin already registered — nothing to do' };
  }
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
  { name: 'verify-cli',       description: 'Verify node and switchbot binary on PATH',                    skippable: false },
  { name: 're-auth',          description: 'Check credentials; spawn auth login if missing',              skippable: true  },
  { name: 'preflight-plugin', description: 'Check if Codex plugin is already registered (skips re-register if ok)', skippable: true  },
  { name: 'remove-plugin',    description: 'codex plugin remove (best-effort, non-fatal)',                skippable: true  },
  { name: 'register-plugin',  description: 'codex plugin marketplace add + plugin add',                   skippable: false },
  { name: 'doctor-verify',    description: 'Run Codex doctor checks and report health',                   skippable: false },
];

// Step names removed from SETUP_STEPS/REPAIR_STEPS in past releases; silently
// accepted by --skip for backward compatibility instead of exit 2.
const DEPRECATED_SKIP_NAMES = new Set(['install-codex-plugin']);

function validateSkip(stepDefs: readonly StepDef[], skip: Set<string>): { ok: true } | { ok: false; offending: string } {
  const skippableNames = new Set(stepDefs.filter((s) => s.skippable).map((s) => s.name));
  for (const name of skip) {
    if (DEPRECATED_SKIP_NAMES.has(name)) {
      console.error(`[switchbot] --skip "${name}" is no longer a valid step name and has no effect`);
      continue;
    }
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
    else if (step.name === 'preflight-plugin') outcome = repairStepPreflightPlugin(ctx);
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
        const anyWarn = outcomes.some((o) => o.status === 'warn');
        printJson({ ok: !anyFailed, hasWarnings: anyWarn, preflightFailed, outcomes });
      } else {
        for (const o of outcomes) {
          const icon =
            o.status === 'ok'      ? chalk.green('✓') :
            o.status === 'skipped' ? chalk.dim('·') :
            o.status === 'warn'    ? chalk.yellow('⚠') :
                                     chalk.red('✗');
          console.log(`${icon} ${o.step.padEnd(18)} ${o.message ?? ''}`);
        }
        console.log('');
        printRepairStatusSummary(outcomes);
        console.log('');
        if (!anyFailed) {
          console.log(chalk.green('Repair complete.'));
          console.log(chalk.dim('Restart Codex Desktop to reload the SwitchBot skill and MCP tools.'));
          console.log(chalk.dim('After restart, ask: "List my SwitchBot devices."'));
        } else if (preflightFailed) {
          console.log(chalk.red('Preflight failed — fix the above issue and re-run.'));
        } else {
          console.log(chalk.yellow('Repair finished with failures.'));
          console.log(chalk.dim('Run: switchbot codex repair --skip re-auth'));
        }
      }
      if (preflightFailed) process.exit(2);
      if (anyFailed) process.exit(1);
      process.exit(0);
    });
}

// ─── status summary helpers ───────────────────────────────────────────────────

function statusLine(label: string, ok: boolean | null, note?: string): void {
  const icon = ok === true ? chalk.green('✓') : ok === false ? chalk.red('✗') : chalk.yellow('?');
  const color = ok === true ? chalk.green : ok === false ? chalk.red : chalk.yellow;
  const suffix = note ? chalk.dim(`  — ${note}`) : '';
  console.log(`  ${icon} ${color(label)}${suffix}`);
}

function printSetupStatusSummary(outcomes: SetupOutcome[]): void {
  const find = (name: string) => outcomes.find((o) => o.step === name);
  const isOk = (name: string) => {
    const o = find(name);
    return o ? (o.status === 'ok' || o.status === 'skipped') : null;
  };
  const cliOk = isOk('install-switchbot-cli');
  const authOk = isOk('auth');
  const pluginOk = outcomes.find((o) => o.step === 'register-plugin')?.status === 'ok' ? true
                 : outcomes.find((o) => o.step === 'register-plugin')?.status === 'failed' ? false
                 : null;
  console.log(chalk.bold('Component status:'));
  statusLine('CLI installed     (switchbot)', cliOk, cliOk === false ? 'run: npm install -g @switchbot/openapi-cli@latest' : undefined);
  statusLine('Credentials       (API token)', authOk, authOk === false ? 'run: switchbot auth login' : undefined);
  statusLine('Codex plugin      (switchbot)', pluginOk, pluginOk === false ? 'run: switchbot codex repair' : undefined);
}

function printRepairStatusSummary(outcomes: RepairOutcome[]): void {
  const find = (name: string) => outcomes.find((o) => o.step === name);
  const isOk = (name: string) => {
    const o = find(name);
    return o ? (o.status === 'ok' || o.status === 'skipped') : null;
  };
  const cliOk = isOk('verify-cli');
  const authOk = isOk('re-auth');
  const pluginOk = outcomes.find((o) => o.step === 'register-plugin')?.status === 'ok' ? true
                 : outcomes.find((o) => o.step === 'register-plugin')?.status === 'failed' ? false
                 : null;
  console.log(chalk.bold('Component status:'));
  statusLine('CLI installed     (switchbot)', cliOk);
  statusLine('Credentials       (API token)', authOk, authOk === false ? 'run: switchbot auth login' : undefined);
  statusLine('Codex plugin      (switchbot)', pluginOk, pluginOk === false ? 'run: switchbot codex repair' : undefined);
}

// ─── setup ───────────────────────────────────────────────────────────────────

interface SetupContext {
  profile: string;
  configPath?: string;
  codexPluginId?: string;
  packageRoot?: string | null;
  nonInteractive: boolean;
  upgrade: boolean;
}

type SetupOutcome = StepOutcome;

const SETUP_STEPS: readonly StepDef[] = [
  { name: 'check-codex-cli',       description: 'Verify codex CLI on PATH',                                        skippable: false },
  { name: 'check-network',         description: 'Probe npm registry; print Codex config hint if offline',          skippable: true  },
  { name: 'install-switchbot-cli', description: 'Install @switchbot/openapi-cli if missing or outdated',           skippable: true  },
  { name: 'register-plugin',       description: 'Register plugin (Route B git; npm install + Route A on fallback)', skippable: false },
  { name: 'auth',                  description: 'Verify credentials; spawn auth login if missing',                 skippable: true  },
  { name: 'doctor-verify',         description: 'Run 4 base + 3 Codex checks and report health',                   skippable: false },
];

function setupStepCheckNetwork(): SetupOutcome {
  const r = spawnSync(
    'npm', ['ping'],
    { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 5000 },
  );
  if ((r.status ?? 1) === 0) {
    return { step: 'check-network', status: 'ok', message: 'npm registry reachable' };
  }
  return {
    step: 'check-network',
    status: 'warn',
    message: [
      'npm registry unreachable — install and plugin registration require network access.',
      'To enable network in Codex, add to ~/.codex/config.toml:',
      '  [sandbox_workspace_write]',
      '  network_access = true',
      'Then restart Codex and re-run: switchbot codex setup',
    ].join('\n'),
  };
}

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

function setupStepInstallSwitchbotCli(ctx: SetupContext): SetupOutcome {
  return setupStepInstallGlobalPackage(
    'install-switchbot-cli',
    SWITCHBOT_CLI_PACKAGE,
    { upgrade: ctx.upgrade },
  );
}

function resolveInstalledVersion(packageName: string): string | null {
  const r = spawnSync(
    'npm', ['list', '-g', '--json', '--depth=0', packageName],
    { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 15000 },
  );
  try {
    const parsed = JSON.parse(r.stdout ?? '{}') as {
      dependencies?: Record<string, { version?: string }>;
    };
    return parsed?.dependencies?.[packageName]?.version ?? null;
  } catch {
    return null;
  }
}

function setupStepInstallGlobalPackage(step: string, packageName: string, opts: { upgrade: boolean }): SetupOutcome {
  const list = spawnSync(
    'npm', ['list', '-g', '--json', '--depth=0', packageName],
    { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 15000 },
  );
  let installedVersion: string | null = null;
  try {
    const parsed = JSON.parse(list.stdout ?? '{}') as {
      dependencies?: Record<string, { version?: string }>;
    };
    installedVersion = parsed?.dependencies?.[packageName]?.version ?? null;
  } catch { /* treat as not installed */ }

  if (installedVersion !== null && !opts.upgrade) {
    return { step, status: 'ok', message: `already installed (${installedVersion})` };
  }

  const { version: latestVersion, fromRegistry } = fetchLatestPublishedVersion(packageName);
  const registryNote = fromRegistry ? '' : ' (registry unreachable, used running version as reference)';

  if (installedVersion !== null) {
    if (compareVersions(installedVersion, latestVersion) >= 0) {
      return { step, status: 'ok', message: `already installed (${installedVersion})${registryNote}` };
    }
    const upg = spawnSync(
      'npm', ['install', '-g', `${packageName}@latest`],
      { encoding: 'utf-8', shell: process.platform === 'win32', timeout: 120000 },
    );
    if ((upg.status ?? 1) !== 0) {
      return {
        step,
        status: 'failed',
        message: `npm install -g failed upgrading from ${installedVersion} (exit ${upg.status ?? 1}): ${upg.stderr ?? ''}`,
      };
    }
    const newVersion = resolveInstalledVersion(packageName) ?? latestVersion;
    return { step, status: 'ok', message: `upgraded ${installedVersion} → ${newVersion}` };
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
  const installedNow = resolveInstalledVersion(packageName) ?? latestVersion;
  return { step, status: 'ok', message: `installed ${packageName}@${installedNow}` };
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

export async function isAlreadyConfigured(): Promise<boolean> {
  if (checkCodexCli().status !== 'ok') return false;
  if (!await credentialsPresent()) return false;
  if (checkCodexPluginNpm().status !== 'ok') return false;
  if (checkCodexPluginRegistered().status !== 'ok') return false;
  return true;
}

async function runSetup(
  skip: Set<string>,
  ctx: SetupContext,
): Promise<{ outcomes: SetupOutcome[]; anyFailed: boolean; preflightFailed: boolean }> {
  const outcomes: SetupOutcome[] = [];
  let preflightFailed = false;
  let networkOffline = false;

  for (const step of SETUP_STEPS) {
    // Auto-skip network-dependent steps when check-network warned
    if (step.name === 'install-switchbot-cli' && networkOffline && !skip.has(step.name)) {
      outcomes.push({
        step: step.name,
        status: 'skipped',
        message: 'skipped: npm registry unreachable (see check-network warning above)',
      });
      continue;
    }

    if (skip.has(step.name)) {
      outcomes.push({ step: step.name, status: 'skipped' });
      continue;
    }
    let outcome: SetupOutcome;
    if (step.name === 'check-codex-cli')             outcome = setupStepCheckCodexCli();
    else if (step.name === 'check-network')          outcome = setupStepCheckNetwork();
    else if (step.name === 'install-switchbot-cli')  outcome = setupStepInstallSwitchbotCli(ctx);
    else if (step.name === 'register-plugin')        outcome = setupStepRegisterPlugin(ctx);
    else if (step.name === 'auth')                   outcome = await setupStepAuth(ctx);
    else                                             outcome = await setupStepDoctorVerify();
    outcomes.push(outcome);
    if (step.name === 'check-codex-cli' && outcome.status === 'failed') {
      preflightFailed = true;
      break;
    }
    if (step.name === 'check-network' && outcome.status === 'warn') {
      networkOffline = true;
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
    .option('--upgrade', 'Upgrade @switchbot/openapi-cli to the latest published version if already installed')
    .addHelpText('after', `
Global flags that also apply to this command:
  --dry-run    Print step list without executing any changes
  --json       Emit machine-readable JSON output

Environment variables:
  CODEX_GIT_MARKETPLACE_REF        Git ref used when registering via git marketplace (default: main)
  CODEX_MARKETPLACE_ADD_TIMEOUT    Timeout in ms for "codex plugin marketplace add" (default: 60000)
`)
    .action(async (opts: { skip?: string; yes?: boolean; upgrade?: boolean }, command: Command) => {
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
        upgrade: Boolean(opts.upgrade),
      };

      // Fast path: when no steps are skipped and all required components are already
      // present and healthy, skip the full setup pipeline.
      if (skip.size === 0 && !ctx.upgrade && await isAlreadyConfigured()) {
        if (isJsonMode()) {
          printJson({ ok: true, alreadyConfigured: true, outcomes: [] });
        } else {
          console.log(chalk.green('Already configured, nothing to do.'));
          console.log(chalk.dim('Run: switchbot codex doctor  — to verify health'));
        }
        process.exit(0);
        return;
      }

      if (!isJsonMode()) console.log(chalk.bold('Setting up Codex integration...'));
      if (!isJsonMode()) console.log('');

      const { outcomes, anyFailed, preflightFailed } = await runSetup(skip, ctx);

      if (isJsonMode()) {
        const anyWarn = outcomes.some((o) => o.status === 'warn');
        printJson({ ok: !anyFailed, hasWarnings: anyWarn, preflightFailed, outcomes });
      } else {
        for (const o of outcomes) {
          const icon =
            o.status === 'ok'      ? chalk.green('✓') :
            o.status === 'skipped' ? chalk.dim('·') :
            o.status === 'warn'    ? chalk.yellow('⚠') :
                                     chalk.red('✗');
          console.log(`${icon} ${o.step.padEnd(22)} ${o.message ?? ''}`);
        }
        console.log('');
        printSetupStatusSummary(outcomes);
        console.log('');
        if (!anyFailed) {
          console.log(chalk.green('Setup complete.'));
          console.log(chalk.dim('Restart Codex Desktop to load the SwitchBot skill and MCP tools.'));
          console.log(chalk.dim('After restart, ask: "List my SwitchBot devices."'));
        } else if (preflightFailed) {
          console.log(chalk.red('Preflight failed — install Codex CLI first, then re-run.'));
        } else {
          console.log(chalk.yellow('Setup finished with failures.'));
          console.log(chalk.dim('Run: switchbot codex repair'));
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
