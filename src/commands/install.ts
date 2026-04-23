/**
 * `switchbot install` — one-command bootstrap (Phase 3B in-repo).
 *
 * Collapses the 7-step Quickstart (credentials → policy → skill link →
 * doctor verify) into a single orchestrated command with automatic
 * rollback on any step failure. The step library
 * (`src/install/default-steps.ts`) does the heavy lifting; this file
 * composes the steps based on user flags, drives the step runner, and
 * formats the outcome.
 *
 * Design notes:
 * - `switchbot install` assumes the CLI is already on PATH (the user
 *   ran `npm i -g @switchbot/openapi-cli` to get here). We do not
 *   re-install the CLI from inside itself.
 * - Doctor verification is NOT a step — if it failed, an automatic
 *   rollback would destroy good state. Instead we print a "next: run
 *   `switchbot doctor`" hint after success.
 */

import { Command, InvalidArgumentError } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { resolvePolicyPath } from '../policy/load.js';
import { runInstall, type InstallStep } from '../install/steps.js';
import { runPreflight } from '../install/preflight.js';
import {
  stepPromptCredentials,
  stepWriteKeychain,
  stepScaffoldPolicy,
  stepSymlinkSkill,
  stepDoctorVerify,
  type AgentName,
  type InstallContext,
} from '../install/default-steps.js';
import { isJsonMode, printJson } from '../utils/output.js';
import { getActiveProfile } from '../lib/request-context.js';
import chalk from 'chalk';

const AGENT_VALUES: readonly AgentName[] = ['claude-code', 'cursor', 'copilot', 'none'] as const;

interface InstallCliOptions {
  agent?: string;
  skillPath?: string;
  tokenFile?: string;
  skip?: string;
  force?: boolean;
  verify?: boolean;
}

function parseAgent(value: string | undefined): AgentName {
  if (!value) return 'claude-code';
  if (!(AGENT_VALUES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`--agent must be one of ${AGENT_VALUES.join(', ')} (got "${value}")`);
  }
  return value as AgentName;
}

function parseSkipList(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

function printRecipe(ctx: InstallContext): void {
  if (!ctx.skillRecipePrinted) return;
  const lines: string[] = [];
  lines.push('');
  lines.push(chalk.bold(`Skill-install recipe for agent=${ctx.agent}:`));
  switch (ctx.agent) {
    case 'claude-code':
      lines.push(
        '  # re-run with --skill-path pointing at your local clone of openclaw-switchbot-skill',
        '  switchbot install --agent claude-code --skill-path /path/to/openclaw-switchbot-skill',
      );
      break;
    case 'cursor':
      lines.push(
        '  # Cursor expects a rules file, not a skill directory. See:',
        '  #   openclaw-switchbot-skill/docs/agents/cursor.md',
      );
      break;
    case 'copilot':
      lines.push(
        '  # Copilot merges instructions into .github/copilot-instructions.md. See:',
        '  #   openclaw-switchbot-skill/docs/agents/copilot.md',
      );
      break;
    case 'none':
      lines.push('  (none — skill step skipped)');
      break;
  }
  console.error(lines.join('\n'));
}

function printDryRun(steps: InstallStep<InstallContext>[], ctx: InstallContext): void {
  if (isJsonMode()) {
    printJson({
      dryRun: true,
      profile: ctx.profile,
      agent: ctx.agent,
      skillPath: ctx.skillPath ?? null,
      policyPath: ctx.policyPath,
      steps: steps.map((s) => ({ name: s.name, description: s.description })),
    });
    return;
  }
  console.log(chalk.bold('switchbot install — dry run'));
  console.log(`  profile: ${ctx.profile}`);
  console.log(`  agent:   ${ctx.agent}`);
  console.log(`  skill:   ${ctx.skillPath ?? '(none — recipe will be printed)'}`);
  console.log(`  policy:  ${ctx.policyPath}`);
  console.log('');
  console.log(chalk.bold('Steps that would run (in order):'));
  for (const s of steps) {
    console.log(`  • ${s.name}${s.description ? `  — ${s.description}` : ''}`);
  }
  console.log('');
  console.log(chalk.dim('No changes made. Re-run without --dry-run to apply.'));
}

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('One-command bootstrap: credentials + policy + skill link (rolls back on failure)')
    .option('--agent <name>', `target agent: ${AGENT_VALUES.join(' | ')} (default: claude-code)`)
    .option('--skill-path <dir>', 'local clone of openclaw-switchbot-skill (enables auto-link)')
    .option('--token-file <path>', 'two-line credential file (token, secret); read once and deleted on success')
    .option('--skip <names>', 'comma-separated list of step names to skip (e.g. "scaffold-policy,symlink-skill")')
    .option('--force', 'replace an existing skill symlink pointing at a different path; allow link even without SKILL.md')
    .option('--verify', 'after a successful install, run `switchbot doctor --json` as a warn-only post-check')
    .addHelpText(
      'after',
      `
The global --dry-run flag previews the step list without making changes.
Global --json emits the install report as JSON to stdout.

Exit codes:
  0  success
  2  preflight check failed (nothing changed)
  3  step failed; rollback completed
  4  step failed; rollback had residue (see output)

Examples:
  # Interactive install, Claude Code skill not linked (recipe printed):
  switchbot install

  # Full install with skill link:
  switchbot install --skill-path ../openclaw-switchbot-skill

  # Non-interactive (CI) install:
  printf '%s\\n%s\\n' "$TOKEN" "$SECRET" > /tmp/sb-creds
  switchbot install --token-file /tmp/sb-creds --skill-path ./skill
`,
    )
    .action(async (opts: InstallCliOptions, command: Command) => {
      const agent = parseAgent(opts.agent);
      const profile = getActiveProfile() ?? 'default';
      const skip = parseSkipList(opts.skip);
      const skillPath = opts.skillPath ? path.resolve(opts.skillPath) : undefined;
      const tokenFile = opts.tokenFile ? path.resolve(opts.tokenFile) : undefined;
      const force = Boolean(opts.force);
      const verify = Boolean(opts.verify);
      const globalOpts = command.parent?.opts() ?? {};
      const dryRun = Boolean(globalOpts.dryRun);

      // Pre-flight: read-only checks, never mutate anything.
      const pf = await runPreflight({
        agent,
        expectSkillLink: agent === 'claude-code' && Boolean(skillPath),
      });
      if (!pf.ok) {
        if (isJsonMode()) {
          printJson({ ok: false, stage: 'preflight', preflight: pf });
        } else {
          console.error(chalk.red('✗ preflight failed — nothing changed'));
          for (const c of pf.checks) {
            const mark = c.status === 'fail' ? chalk.red('✗') : c.status === 'warn' ? chalk.yellow('!') : chalk.green('✓');
            console.error(`  ${mark} ${c.name}: ${c.message}`);
            if (c.hint) console.error(`      hint: ${c.hint}`);
          }
        }
        process.exit(2);
      }

      const ctx: InstallContext = {
        profile,
        agent,
        skillPath,
        tokenFile,
        policyPath: resolvePolicyPath(),
        nonInteractive: !process.stdin.isTTY && !tokenFile,
      };

      const allSteps: InstallStep<InstallContext>[] = [
        stepPromptCredentials(),
        stepWriteKeychain(),
        stepScaffoldPolicy(),
        stepSymlinkSkill({ force }),
      ];
      const steps = allSteps.filter((s) => !skip.has(s.name));

      if (dryRun) {
        printDryRun(steps, ctx);
        return;
      }

      const report = await runInstall<InstallContext>(steps, { context: ctx });

      // Delete the token file now that credentials are committed.
      if (report.ok && tokenFile) {
        try {
          fs.unlinkSync(tokenFile);
        } catch {
          // non-fatal: credentials are already in the keychain
        }
      }

      // A7: opt-in post-install verification. Doctor is NEVER part of the
      // rollback chain — a failing doctor after a good install would
      // destroy working state. So we run it AFTER runInstall resolves, as
      // a warn-only check. The outcome is reported but never flips the
      // command's exit code.
      if (report.ok && verify) {
        const cliPath = process.argv[1] ?? '';
        const step = stepDoctorVerify({ cliPath });
        await step.execute(ctx);
      }

      if (isJsonMode()) {
        printJson({
          ok: report.ok,
          profile: ctx.profile,
          agent: ctx.agent,
          report,
          preflight: pf,
          policyPath: ctx.policyPath,
          policyScaffolded: ctx.policyScaffoldResult && !ctx.policyScaffoldResult.skipped,
          skillLinkPath: ctx.skillLinkPath,
          skillLinkCreated: Boolean(ctx.skillLinkCreated),
          verify: verify ? { ok: ctx.doctorOk ?? null, report: ctx.doctorReport ?? null } : undefined,
        });
      } else if (report.ok) {
        console.log(chalk.green('✓ install complete'));
        if (ctx.skillLinkCreated) console.log(`  linked skill: ${ctx.skillLinkPath}`);
        if (ctx.policyScaffoldResult?.skipped === false) console.log(`  wrote policy: ${ctx.policyScaffoldResult.policyPath}`);
        printRecipe(ctx);
        if (verify) {
          if (ctx.doctorOk) {
            console.log(chalk.green('✓ doctor --json: all green'));
          } else {
            console.log(chalk.yellow('! doctor --json reported issues — install is committed; run `switchbot doctor` to inspect'));
          }
        }
        console.log('');
        console.log(chalk.bold('Next:'));
        console.log('  switchbot doctor        # verify the setup');
        console.log('  switchbot devices list  # smoke test');
      } else {
        console.error(chalk.red(`✗ install failed at step: ${report.failedAt}`));
        const residue = report.outcomes.some((o) => o.status === 'rollback-failed');
        for (const o of report.outcomes) {
          const tag =
            o.status === 'succeeded' ? chalk.green('✓') :
            o.status === 'failed' ? chalk.red('✗') :
            o.status === 'rolled-back' ? chalk.yellow('↺') :
            o.status === 'rollback-failed' ? chalk.red('!!') :
            chalk.dim('·');
          const msg = o.status === 'failed' || o.status === 'rollback-failed' ? ` — ${o.error}` : '';
          console.error(`  ${tag} ${o.step} [${o.status}]${msg}`);
        }
        if (residue) {
          console.error(chalk.red('Rollback left residue. Run `switchbot uninstall` to clean up or review output above.'));
          process.exit(4);
        }
        process.exit(3);
      }
    });
}
