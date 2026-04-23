/**
 * Default install steps used by `switchbot install` (Phase 3B in-repo).
 *
 * Each factory returns an `InstallStep<InstallContext>` whose `execute`
 * and `undo` both operate on the shared context. Steps are intentionally
 * small — each one either mutates one system (keychain / filesystem /
 * symlink) or captures input, never a mix. The orchestrator composes
 * them in `src/commands/install.ts`.
 *
 * The step runner (`src/install/steps.ts`) handles rollback on failure;
 * these factories just make sure every `execute` records what it needs
 * into the context so the matching `undo` can unwind it.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { InstallStep } from './steps.js';
import {
  scaffoldPolicyFile,
  PolicyFileExistsError,
  type ScaffoldPolicyResult,
} from '../commands/policy.js';
import { promptTokenAndSecret, readCredentialsFile } from '../commands/config.js';
import { selectCredentialStore, type CredentialStore, type CredentialBundle } from '../credentials/keychain.js';

export type AgentName = 'claude-code' | 'cursor' | 'copilot' | 'none';

export interface InstallContext {
  /** Profile to write credentials under (default `default`). */
  profile: string;
  /** Which agent to link the skill for. `none` → skip skill step. */
  agent: AgentName;
  /** Absolute path to a local clone of openclaw-switchbot-skill, or undefined. */
  skillPath?: string;
  /** Policy file path (default: from resolvePolicyPath()). */
  policyPath: string;
  /** Non-interactive credential file, read once and unlinked on success. */
  tokenFile?: string;
  /** True if stdout is not a TTY; forbids interactive prompting. */
  nonInteractive?: boolean;

  // --- Filled in by steps as they run ---
  credentials?: CredentialBundle;
  credentialStore?: CredentialStore;
  credentialsWereStored?: boolean;
  policyScaffoldResult?: ScaffoldPolicyResult;
  skillLinkPath?: string;
  skillLinkCreated?: boolean;
  skillRecipePrinted?: boolean;
  doctorOk?: boolean;
  doctorReport?: unknown;
}

// ---------------------------------------------------------------------------
// Step 1: capture credentials (memory only — no side effects until step 2)
// ---------------------------------------------------------------------------

export function stepPromptCredentials(): InstallStep<InstallContext> {
  return {
    name: 'prompt-credentials',
    description: 'Collect SwitchBot token + secret (interactive unless --token-file)',
    async execute(ctx) {
      if (ctx.credentials) return; // already provided via API consumer

      if (ctx.tokenFile) {
        const creds = readCredentialsFile(ctx.tokenFile);
        ctx.credentials = creds;
        return;
      }

      if (ctx.nonInteractive) {
        throw new Error(
          'no --token-file and stdin is not a TTY; pass --token-file <path> to install non-interactively',
        );
      }

      ctx.credentials = await promptTokenAndSecret();
    },
    undo() {
      // No disk state created; clearing memory is enough.
      // The calling process will exit shortly after rollback, but null
      // the field for defence-in-depth.
      return;
    },
  };
}

// ---------------------------------------------------------------------------
// Step 2: write credentials to keychain (or file fallback)
// ---------------------------------------------------------------------------

export function stepWriteKeychain(): InstallStep<InstallContext> {
  return {
    name: 'write-keychain',
    description: 'Store credentials in the OS keychain (falls back to ~/.switchbot/config.json)',
    async execute(ctx) {
      if (!ctx.credentials) {
        throw new Error('internal: credentials missing at write-keychain; prompt step must run first');
      }
      const store = await selectCredentialStore();
      await store.set(ctx.profile, ctx.credentials);
      ctx.credentialStore = store;
      ctx.credentialsWereStored = true;
    },
    async undo(ctx) {
      if (!ctx.credentialsWereStored || !ctx.credentialStore) return;
      try {
        await ctx.credentialStore.delete(ctx.profile);
      } finally {
        ctx.credentialsWereStored = false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Step 3: scaffold policy.yaml if missing (skip if present, don't clobber)
// ---------------------------------------------------------------------------

export function stepScaffoldPolicy(): InstallStep<InstallContext> {
  return {
    name: 'scaffold-policy',
    description: 'Create a starter policy.yaml (only if none exists)',
    execute(ctx) {
      try {
        const result = scaffoldPolicyFile(ctx.policyPath, { skipExisting: true });
        ctx.policyScaffoldResult = result;
      } catch (err) {
        if (err instanceof PolicyFileExistsError) {
          // skipExisting is true → this branch is unreachable, but be
          // defensive against future changes.
          return;
        }
        throw err;
      }
    },
    undo(ctx) {
      const r = ctx.policyScaffoldResult;
      if (!r || r.skipped) return;
      // Only remove the file if WE created it (skipped === false means
      // we wrote fresh content to a path that did not exist before).
      try {
        fs.unlinkSync(r.policyPath);
      } catch {
        // best-effort; do not fail rollback on cleanup
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Step 4: install skill into the agent's skills directory
// ---------------------------------------------------------------------------

/**
 * Compute the on-disk location where an agent expects to find this skill.
 * Only `claude-code` has an automation path today; others are informational
 * (the installer will print a recipe instead of creating anything).
 */
export function skillLinkPathFor(agent: AgentName, home: string = os.homedir()): string | null {
  if (agent === 'claude-code') {
    return path.join(home, '.claude', 'skills', 'switchbot');
  }
  return null;
}

export function stepSymlinkSkill(): InstallStep<InstallContext> {
  return {
    name: 'symlink-skill',
    description: 'Link the skill into ~/.claude/skills/switchbot (Claude Code)',
    execute(ctx) {
      if (ctx.agent === 'none') return;

      if (!ctx.skillPath) {
        // Informational path: print the recipe, do not fail. Undo can
        // safely no-op in this branch.
        ctx.skillRecipePrinted = true;
        return;
      }

      const target = path.resolve(ctx.skillPath);
      if (!fs.existsSync(target)) {
        throw new Error(`--skill-path does not exist: ${target}`);
      }
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) {
        throw new Error(`--skill-path is not a directory: ${target}`);
      }

      const linkPath = skillLinkPathFor(ctx.agent);
      if (!linkPath) {
        // Non-automating agent: print a recipe instead of creating state.
        ctx.skillRecipePrinted = true;
        return;
      }

      if (fs.existsSync(linkPath)) {
        const st = fs.lstatSync(linkPath);
        if (st.isSymbolicLink()) {
          // Already linked (possibly to a different path). We treat this
          // as a no-op to keep install idempotent; uninstall will remove.
          ctx.skillLinkPath = linkPath;
          ctx.skillLinkCreated = false;
          return;
        }
        throw new Error(
          `${linkPath} exists and is not a symlink; refusing to clobber (move it aside and re-run)`,
        );
      }

      fs.mkdirSync(path.dirname(linkPath), { recursive: true });

      // Windows: regular symlinks require admin or Developer Mode. A
      // directory junction works for any user and is transparent to
      // most tools. Unix: plain symlink.
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(target, linkPath, linkType);
      ctx.skillLinkPath = linkPath;
      ctx.skillLinkCreated = true;
    },
    undo(ctx) {
      if (!ctx.skillLinkCreated || !ctx.skillLinkPath) return;
      try {
        fs.unlinkSync(ctx.skillLinkPath);
      } catch {
        // best-effort
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Step 5: run `doctor --json` and capture the verdict. Failures are
// surfaced to the orchestrator WITHOUT throwing, so a doctor fail does
// NOT trigger a full install rollback. The install command inspects
// ctx.doctorOk after runInstall() returns.
// ---------------------------------------------------------------------------

export interface DoctorSpawnResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type DoctorSpawner = (cliPath: string, profile: string) => DoctorSpawnResult;

function defaultDoctorSpawner(cliPath: string, profile: string): DoctorSpawnResult {
  const args = profile === 'default' ? [cliPath, 'doctor', '--json'] : [cliPath, '--profile', profile, 'doctor', '--json'];
  const r = spawnSync(process.execPath, args, { encoding: 'utf-8' });
  return {
    ok: r.status === 0,
    exitCode: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

export function stepDoctorVerify(opts: { cliPath: string; spawner?: DoctorSpawner } = { cliPath: '' }): InstallStep<InstallContext> {
  const spawner = opts.spawner ?? defaultDoctorSpawner;
  const cliPath = opts.cliPath;
  return {
    name: 'doctor-verify',
    description: 'Verify the install with switchbot doctor --json',
    execute(ctx) {
      if (!cliPath) {
        // Fail closed: without a known CLI path we cannot spawn doctor.
        // Mark not-ok but still succeed (no rollback).
        ctx.doctorOk = false;
        ctx.doctorReport = { skipped: true, reason: 'no cliPath provided' };
        return;
      }
      const r = spawner(cliPath, ctx.profile);
      ctx.doctorOk = r.ok;
      try {
        ctx.doctorReport = r.stdout ? JSON.parse(r.stdout) : { exitCode: r.exitCode, stderr: r.stderr };
      } catch {
        ctx.doctorReport = { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
      }
      // NOTE: never throw here. Doctor failure is reported; rollback is
      // opt-in by the user via `switchbot uninstall`.
    },
    undo() {
      return;
    },
  };
}
