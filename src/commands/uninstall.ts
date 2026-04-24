/**
 * `switchbot uninstall` — reverse of `switchbot install`.
 *
 * Unlike install, uninstall is not rollback-safe (there's nothing to
 * roll back to). It removes individual pieces independently and keeps
 * going if any single removal fails — the user gets a report and can
 * clean up leftovers manually. Every destructive step defaults to
 * confirmation; `--yes` skips the prompt.
 *
 * What it removes, from least to most destructive:
 *   1. skill symlink  (~/.claude/skills/switchbot)     — default: yes
 *   2. credentials    (keychain entry for the profile) — default: yes  (requires --remove-creds OR --yes)
 *   3. policy.yaml    (only on --remove-policy)         — default: no  (user edits may live here)
 *
 * The CLI itself is never uninstalled: install did not install it,
 * and yanking your own binary mid-run is impolite. Users who want it
 * gone run `npm rm -g @switchbot/openapi-cli`.
 */

import { Command, InvalidArgumentError } from 'commander';
import fs from 'node:fs';
import readline from 'node:readline';
import { resolvePolicyPath } from '../policy/load.js';
import { skillLinkPathFor, type AgentName } from '../install/default-steps.js';
import { selectCredentialStore } from '../credentials/keychain.js';
import { isJsonMode, printJson } from '../utils/output.js';
import { getActiveProfile } from '../lib/request-context.js';
import chalk from 'chalk';

const AGENT_VALUES: readonly AgentName[] = ['claude-code', 'cursor', 'copilot', 'none'] as const;

interface UninstallCliOptions {
  agent?: string;
  removePolicy?: boolean;
  removeCreds?: boolean;
  yes?: boolean;
  purge?: boolean;
}

function parseAgent(value: string | undefined): AgentName {
  if (!value) return 'claude-code';
  if (!(AGENT_VALUES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`--agent must be one of ${AGENT_VALUES.join(', ')} (got "${value}")`);
  }
  return value as AgentName;
}

async function prompt(question: string, defaultYes: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return defaultYes;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
    rl.question(question + suffix, (ans) => {
      rl.close();
      const a = ans.trim().toLowerCase();
      if (!a) return resolve(defaultYes);
      resolve(a === 'y' || a === 'yes');
    });
  });
}

type ActionStatus = 'removed' | 'skipped' | 'absent' | 'failed';
interface ActionOutcome {
  action: string;
  status: ActionStatus;
  detail?: string;
  error?: string;
}

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('Reverse of `switchbot install`: remove skill link, credentials, (optionally) policy')
    .option('--agent <name>', `target agent: ${AGENT_VALUES.join(' | ')} (default: claude-code)`)
    .option('--remove-creds', 'delete credentials from the OS keychain (default: prompt)')
    .option('--remove-policy', 'also delete policy.yaml (default: keep — user edits may live there)')
    .option('-y, --yes', 'assume yes to every confirmation prompt (non-interactive)')
    .option('--purge', 'shorthand for --yes --remove-creds --remove-policy: remove everything without prompting')
    .addHelpText(
      'after',
      `
The global --dry-run flag previews what would be removed.
Global --json emits a structured removal report.

What is never removed here:
  - the CLI itself (use: npm rm -g @switchbot/openapi-cli)
  - audit.log (it's your receipt; delete by hand if you want)

Examples:
  # Interactive: prompts before each destructive step
  switchbot uninstall

  # Non-interactive, remove everything including the policy
  switchbot uninstall --yes --remove-policy

  # One-shot: remove absolutely everything without prompting
  switchbot uninstall --purge
`,
    )
    .action(async (opts: UninstallCliOptions, command: Command) => {
      const agent = parseAgent(opts.agent);
      const profile = getActiveProfile() ?? 'default';
      const purge = Boolean(opts.purge);
      const yes = Boolean(opts.yes) || purge;
      const removePolicy = Boolean(opts.removePolicy) || purge;
      const removeCreds = Boolean(opts.removeCreds) || yes;
      const globalOpts = command.parent?.opts() ?? {};
      const dryRun = Boolean(globalOpts.dryRun);

      const policyPath = resolvePolicyPath();
      const skillLink = skillLinkPathFor(agent);

      const plan: { action: string; detail: string; run: () => Promise<ActionOutcome> }[] = [];

      // --- Plan: skill symlink removal (default yes) ---
      if (skillLink) {
        plan.push({
          action: 'remove-skill-link',
          detail: skillLink,
          run: async () => {
            if (!fs.existsSync(skillLink)) {
              return { action: 'remove-skill-link', status: 'absent', detail: skillLink };
            }
            const stat = fs.lstatSync(skillLink);
            if (!stat.isSymbolicLink()) {
              return {
                action: 'remove-skill-link',
                status: 'skipped',
                detail: `${skillLink} exists but is not a symlink — leaving it alone`,
              };
            }
            const ok = yes ? true : await prompt(`Remove skill link ${skillLink}?`, true);
            if (!ok) return { action: 'remove-skill-link', status: 'skipped', detail: skillLink };
            try {
              fs.unlinkSync(skillLink);
              return { action: 'remove-skill-link', status: 'removed', detail: skillLink };
            } catch (err) {
              return {
                action: 'remove-skill-link',
                status: 'failed',
                detail: skillLink,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          },
        });
      }

      // --- Plan: credential removal (requires --remove-creds OR --yes) ---
      plan.push({
        action: 'remove-credentials',
        detail: `profile=${profile}`,
        run: async () => {
          if (!removeCreds) {
            return {
              action: 'remove-credentials',
              status: 'skipped',
              detail: 'pass --remove-creds to delete keychain entry',
            };
          }
          const ok = yes ? true : await prompt(`Delete credentials for profile "${profile}" from the keychain?`, false);
          if (!ok) return { action: 'remove-credentials', status: 'skipped', detail: `profile=${profile}` };
          try {
            const store = await selectCredentialStore();
            await store.delete(profile);
            return {
              action: 'remove-credentials',
              status: 'removed',
              detail: `profile=${profile} (backend=${store.describe().tag})`,
            };
          } catch (err) {
            return {
              action: 'remove-credentials',
              status: 'failed',
              detail: `profile=${profile}`,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      });

      // --- Plan: policy.yaml removal (opt-in) ---
      plan.push({
        action: 'remove-policy',
        detail: policyPath,
        run: async () => {
          if (!removePolicy) {
            return {
              action: 'remove-policy',
              status: 'skipped',
              detail: 'pass --remove-policy to delete policy.yaml',
            };
          }
          if (!fs.existsSync(policyPath)) {
            return { action: 'remove-policy', status: 'absent', detail: policyPath };
          }
          const ok = yes ? true : await prompt(`Delete policy file ${policyPath}?`, false);
          if (!ok) return { action: 'remove-policy', status: 'skipped', detail: policyPath };
          try {
            fs.unlinkSync(policyPath);
            return { action: 'remove-policy', status: 'removed', detail: policyPath };
          } catch (err) {
            return {
              action: 'remove-policy',
              status: 'failed',
              detail: policyPath,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      });

      if (dryRun) {
        if (isJsonMode()) {
          printJson({
            dryRun: true,
            profile,
            agent,
            plan: plan.map(({ action, detail }) => ({ action, detail })),
          });
        } else {
          console.log(chalk.bold('switchbot uninstall — dry run'));
          console.log(`  profile: ${profile}`);
          console.log(`  agent:   ${agent}`);
          console.log('');
          console.log(chalk.bold('Would run:'));
          for (const p of plan) console.log(`  • ${p.action}  — ${p.detail}`);
          console.log('');
          console.log(chalk.dim('No changes made. Re-run without --dry-run (add --yes to skip prompts).'));
        }
        return;
      }

      const outcomes: ActionOutcome[] = [];
      for (const p of plan) {
        outcomes.push(await p.run());
      }

      const anyFailed = outcomes.some((o) => o.status === 'failed');
      if (isJsonMode()) {
        printJson({ ok: !anyFailed, profile, agent, outcomes });
      } else {
        console.log(chalk.bold('switchbot uninstall'));
        for (const o of outcomes) {
          const tag =
            o.status === 'removed' ? chalk.green('✓') :
            o.status === 'absent' ? chalk.dim('·') :
            o.status === 'skipped' ? chalk.yellow('↷') :
            chalk.red('✗');
          console.log(`  ${tag} ${o.action} [${o.status}]  ${o.detail ?? ''}`);
          if (o.error) console.log(`      ${chalk.red(o.error)}`);
        }
      }
      if (anyFailed) process.exit(3);
    });
}
