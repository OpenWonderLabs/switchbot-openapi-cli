import { Command } from 'commander';
import chalk from 'chalk';
import { spawnSync } from 'node:child_process';
import { runDoctorChecks } from './doctor.js';
import {
  checkClaudeCodeCli,
  checkMcpRegistered,
  registerMcp,
  type Check,
} from '../install/claude-code-checks.js';
import { isJsonMode, printJson } from '../utils/output.js';
import { getActiveProfile } from '../lib/request-context.js';
import { getConfigPath } from '../utils/flags.js';

const SWITCHBOT_CLI_PACKAGE = '@switchbot/openapi-cli';

// ── Shared helpers ────────────────────────────────────────────────────────────

async function credentialsPresent(): Promise<boolean> {
  try {
    const { tryLoadConfig } = await import('../config.js');
    const cfg = tryLoadConfig();
    return Boolean(cfg?.token && cfg?.secret);
  } catch {
    return false;
  }
}

function buildAuthLoginArgv(profile: string, configPath?: string): string[] {
  const cliPath = process.argv[1] ?? '';
  return [
    cliPath,
    ...(profile !== 'default' ? ['--profile', profile] : []),
    ...(configPath ? ['--config', configPath] : []),
    'auth', 'login',
  ];
}

// ── Step definitions ──────────────────────────────────────────────────────────

interface StepOutcome {
  step: string;
  status: 'ok' | 'skipped' | 'failed' | 'warn';
  message?: string;
}

interface StepDef {
  name: string;
  description: string;
  skippable: boolean;
}

const SETUP_STEPS: readonly StepDef[] = [
  { name: 'check-claude-cli',      description: 'Verify claude CLI on PATH',                                     skippable: false },
  { name: 'check-network',         description: 'Probe npm registry',                                            skippable: true  },
  { name: 'install-switchbot-cli', description: 'Install @switchbot/openapi-cli if missing or outdated',         skippable: true  },
  { name: 'register-mcp',          description: 'Write switchbot MCP entry to ~/.claude/settings.json',          skippable: false },
  { name: 'auth',                  description: 'Verify credentials; spawn auth login if missing',               skippable: true  },
  { name: 'doctor-verify',         description: 'Run base doctor checks and report health',                      skippable: false },
];

const DEPRECATED_SKIP_NAMES = new Set<string>();

function validateSkip(skip: Set<string>): { ok: true } | { ok: false; offending: string } {
  const skippable = new Set(SETUP_STEPS.filter((s) => s.skippable).map((s) => s.name));
  for (const name of skip) {
    if (DEPRECATED_SKIP_NAMES.has(name)) continue;
    if (!skippable.has(name)) return { ok: false, offending: name };
  }
  return { ok: true };
}

// ── Step implementations ──────────────────────────────────────────────────────

function setupStepCheckClaudeCli(): StepOutcome {
  const c = checkClaudeCodeCli();
  if (c.status === 'fail') {
    const msg = typeof c.detail === 'string' ? c.detail : (c.detail as { message?: string }).message ?? JSON.stringify(c.detail);
    return { step: 'check-claude-cli', status: 'failed', message: msg };
  }
  const detail = c.detail as { version?: string };
  return { step: 'check-claude-cli', status: 'ok', message: `claude ${detail.version ?? ''}`.trim() };
}

function setupStepCheckNetwork(): StepOutcome {
  const r = spawnSync('npm', ['ping'], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout: 5_000,
  });
  if ((r.status ?? 1) === 0) {
    return { step: 'check-network', status: 'ok', message: 'npm registry reachable' };
  }
  return {
    step: 'check-network',
    status: 'warn',
    message: 'npm registry unreachable — install-switchbot-cli will be skipped',
  };
}

function setupStepInstallSwitchbotCli(): StepOutcome {
  const list = spawnSync('npm', ['list', '-g', '--json', '--depth=0', SWITCHBOT_CLI_PACKAGE], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout: 15_000,
  });
  let installed: string | null = null;
  try {
    const parsed = JSON.parse(list.stdout ?? '{}') as { dependencies?: Record<string, { version?: string }> };
    installed = parsed.dependencies?.[SWITCHBOT_CLI_PACKAGE]?.version ?? null;
  } catch { /* not installed */ }

  if (installed !== null) {
    return { step: 'install-switchbot-cli', status: 'ok', message: `already installed (${installed})` };
  }

  const inst = spawnSync('npm', ['install', '-g', `${SWITCHBOT_CLI_PACKAGE}@latest`], {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout: 120_000,
  });
  if ((inst.status ?? 1) !== 0) {
    return {
      step: 'install-switchbot-cli',
      status: 'failed',
      message: `npm install -g failed (exit ${inst.status ?? 1}): ${inst.stderr ?? ''}`,
    };
  }
  return { step: 'install-switchbot-cli', status: 'ok', message: `installed ${SWITCHBOT_CLI_PACKAGE}` };
}

function setupStepRegisterMcp(): StepOutcome {
  const r = registerMcp();
  if (!r.ok) {
    return { step: 'register-mcp', status: 'failed', message: r.error };
  }
  return {
    step: 'register-mcp',
    status: 'ok',
    message: r.alreadyRegistered ? 'already registered' : 'registered switchbot MCP server',
  };
}

async function setupStepAuth(ctx: { profile: string; configPath?: string; nonInteractive: boolean }): Promise<StepOutcome> {
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

async function setupStepDoctorVerify(): Promise<StepOutcome> {
  const CLAUDE_CODE_BASE_SECTIONS = ['node', 'path', 'credentials', 'mcp'] as const;
  const checks: Check[] = (await runDoctorChecks(CLAUDE_CODE_BASE_SECTIONS)) ?? [];
  const mcpCheck = checkMcpRegistered();
  const all = [...checks, mcpCheck];
  const summary = {
    ok:   all.filter((c) => c.status === 'ok').length,
    warn: all.filter((c) => c.status === 'warn').length,
    fail: all.filter((c) => c.status === 'fail').length,
  };
  return {
    step: 'doctor-verify',
    status: summary.fail > 0 ? 'failed' : 'ok',
    message: `${summary.ok} ok, ${summary.warn} warn, ${summary.fail} fail`,
  };
}

export async function isClaudeCodeAlreadyConfigured(): Promise<boolean> {
  if (checkClaudeCodeCli().status !== 'ok') return false;
  if (checkMcpRegistered().status !== 'ok') return false;
  if (!await credentialsPresent()) return false;
  return true;
}

// ── Pipeline runner ───────────────────────────────────────────────────────────

async function runSetup(
  skip: Set<string>,
  ctx: { profile: string; configPath?: string; nonInteractive: boolean },
): Promise<{ outcomes: StepOutcome[]; anyFailed: boolean; preflightFailed: boolean }> {
  const outcomes: StepOutcome[] = [];
  let preflightFailed = false;
  let networkOffline = false;

  for (const step of SETUP_STEPS) {
    if (step.name === 'install-switchbot-cli' && networkOffline && !skip.has(step.name)) {
      outcomes.push({ step: step.name, status: 'skipped', message: 'skipped: npm registry unreachable' });
      continue;
    }
    if (skip.has(step.name)) {
      outcomes.push({ step: step.name, status: 'skipped' });
      continue;
    }
    let outcome: StepOutcome;
    if      (step.name === 'check-claude-cli')      outcome = setupStepCheckClaudeCli();
    else if (step.name === 'check-network')          outcome = setupStepCheckNetwork();
    else if (step.name === 'install-switchbot-cli')  outcome = setupStepInstallSwitchbotCli();
    else if (step.name === 'register-mcp')           outcome = setupStepRegisterMcp();
    else if (step.name === 'auth')                   outcome = await setupStepAuth(ctx);
    else                                             outcome = await setupStepDoctorVerify();

    outcomes.push(outcome);
    if (step.name === 'check-claude-cli' && outcome.status === 'failed') {
      preflightFailed = true;
      break;
    }
    if (step.name === 'check-network' && outcome.status === 'warn') {
      networkOffline = true;
    }
  }
  return { outcomes, anyFailed: outcomes.some((o) => o.status === 'failed'), preflightFailed };
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerClaudeCodeCommand(program: Command): void {
  const claudeCode = program
    .command('claude-code')
    .description('Claude Code integration commands');

  claudeCode
    .command('setup')
    .description('Bootstrap the Claude Code integration: install CLI if missing, register MCP server, auth, verify')
    .option('--skip <names>', 'Comma-separated step names to skip (skippable: "install-switchbot-cli", "auth")')
    .option('--yes', 'Non-interactive mode: do not spawn auth login, fail fast if credentials missing')
    .action(async (opts: { skip?: string; yes?: boolean }, command: Command) => {
      const skip = new Set((opts.skip ?? '').split(',').map((s) => s.trim()).filter(Boolean));
      const skipCheck = validateSkip(skip);
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
          console.log(chalk.bold('switchbot claude-code setup — dry run'));
          console.log('');
          for (const s of SETUP_STEPS) {
            const tag = skip.has(s.name) ? chalk.dim('  · (skip)') : '  •';
            console.log(`${tag} ${s.name.padEnd(24)} ${s.description}`);
          }
          console.log('');
          console.log(chalk.dim('No changes made. Re-run without --dry-run to apply.'));
        }
        process.exit(0);
        return;
      }

      if (skip.size === 0 && await isClaudeCodeAlreadyConfigured()) {
        if (isJsonMode()) {
          printJson({ ok: true, alreadyConfigured: true, outcomes: [] });
        } else {
          console.log(chalk.green('Already configured, nothing to do.'));
          console.log(chalk.dim('Run: switchbot doctor  — to verify health'));
        }
        process.exit(0);
        return;
      }

      if (!isJsonMode()) {
        console.log(chalk.bold('Setting up Claude Code integration...'));
        console.log('');
      }

      const ctx = { profile, configPath, nonInteractive: Boolean(opts.yes) };
      const { outcomes, anyFailed, preflightFailed } = await runSetup(skip, ctx);

      if (isJsonMode()) {
        printJson({ ok: !anyFailed, hasWarnings: outcomes.some((o) => o.status === 'warn'), preflightFailed, outcomes });
      } else {
        for (const o of outcomes) {
          const icon =
            o.status === 'ok'      ? chalk.green('✓') :
            o.status === 'skipped' ? chalk.dim('·') :
            o.status === 'warn'    ? chalk.yellow('⚠') :
                                     chalk.red('✗');
          console.log(`${icon} ${o.step.padEnd(24)} ${o.message ?? ''}`);
        }
        console.log('');
        if (!anyFailed) {
          console.log(chalk.green('Setup complete.'));
          console.log(chalk.dim('Restart Claude Code to load the SwitchBot skill and MCP tools.'));
          console.log(chalk.dim('After restart, ask: "List my SwitchBot devices."'));
        } else if (preflightFailed) {
          console.log(chalk.red('Preflight failed — install Claude Code first (https://claude.ai/claude-code), then re-run.'));
        } else {
          console.log(chalk.yellow('Setup finished with failures.'));
          console.log(chalk.dim('Run: switchbot claude-code setup  — to retry'));
        }
      }

      if (preflightFailed) process.exit(2);
      if (anyFailed) process.exit(1);
      process.exit(0);
    });
}
