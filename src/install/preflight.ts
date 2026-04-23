/**
 * Install-orchestrator pre-flight (Phase 3A · F5).
 *
 * Pure library — no CLI entry. Consumers (e.g. a future
 * `openclaw plugins install` command) call `runPreflight()` and decide
 * whether to proceed based on the returned result. Nothing here mutates
 * user state: every check is read-only.
 *
 * The check list mirrors `docs/design/phase3-install.md` step 1 minus
 * the bits that require external services (npm registry / SwitchBot API
 * reachability are left for the installer itself to probe when it has
 * a plan to retry, since they are the flakiest of the lot).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolvePolicyPath, loadPolicyFile, PolicyFileNotFoundError } from '../policy/load.js';
import { validateLoadedPolicy } from '../policy/validate.js';
import { selectCredentialStore } from '../credentials/keychain.js';

export type PreflightStatus = 'ok' | 'warn' | 'fail';

export interface PreflightCheck {
  name: string;
  status: PreflightStatus;
  message: string;
  hint?: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  /** True when no check is at 'fail'. Warnings are informational. */
  ok: boolean;
}

export interface PreflightOptions {
  /**
   * Minimum required major version of Node.js. Defaults to 18 (current
   * package.json "engines.node" floor).
   */
  minNodeMajor?: number;
  /**
   * Override process.version for deterministic tests.
   */
  nodeVersion?: string;
  /**
   * Override process.platform for tests.
   */
  platform?: NodeJS.Platform;
  /**
   * Target agent. When set to `claude-code` the preflight probes that
   * `~/.claude/` (or the skills directory underneath it) is writable, so
   * the later symlink-skill step fails fast with a clear message.
   * Unset (or `none`/`cursor`/`copilot`) skips the check.
   */
  agent?: 'claude-code' | 'cursor' | 'copilot' | 'none';
}

function parseMajor(version: string): number | null {
  const m = /^v?(\d+)\./.exec(version);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function checkNodeVersion(opts: PreflightOptions): PreflightCheck {
  const required = opts.minNodeMajor ?? 18;
  const version = opts.nodeVersion ?? process.version;
  const major = parseMajor(version);
  if (major === null) {
    return {
      name: 'node',
      status: 'fail',
      message: `unrecognised Node.js version string: ${version}`,
      hint: 'reinstall Node.js from https://nodejs.org',
    };
  }
  if (major < required) {
    return {
      name: 'node',
      status: 'fail',
      message: `Node.js ${version} < required v${required}`,
      hint: `upgrade Node.js to v${required} or later`,
    };
  }
  return { name: 'node', status: 'ok', message: `Node.js ${version}` };
}

function checkPolicy(): PreflightCheck {
  const policyPath = resolvePolicyPath();
  try {
    const loaded = loadPolicyFile(policyPath);
    const result = validateLoadedPolicy(loaded);
    if (result.valid) {
      return {
        name: 'policy',
        status: 'ok',
        message: `policy at ${policyPath} validates (v${result.schemaVersion ?? '?'})`,
      };
    }
    return {
      name: 'policy',
      status: 'warn',
      message: `policy at ${policyPath} has ${result.errors.length} validation error(s)`,
      hint: 'run "switchbot policy validate" to see details before installing',
    };
  } catch (err) {
    if (err instanceof PolicyFileNotFoundError) {
      return {
        name: 'policy',
        status: 'ok',
        message: `no policy at ${policyPath} (installer will scaffold one)`,
      };
    }
    return {
      name: 'policy',
      status: 'warn',
      message: `policy at ${policyPath} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'move the file aside, then re-run — the installer will scaffold a fresh copy',
    };
  }
}

async function checkKeychain(): Promise<PreflightCheck> {
  try {
    const store = await selectCredentialStore();
    const desc = store.describe();
    if (desc.writable) {
      return {
        name: 'keychain',
        status: 'ok',
        message: `credential backend: ${desc.backend}`,
      };
    }
    return {
      name: 'keychain',
      status: 'warn',
      message: `credential backend ${desc.backend} is not writable — will fall back to file`,
      hint: desc.notes ?? 'install the OS keychain helper to get native credential storage',
    };
  } catch (err) {
    return {
      name: 'keychain',
      status: 'warn',
      message: `keychain probe failed: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'the installer will fall back to the file backend',
    };
  }
}

function checkHomeDirWritable(opts: PreflightOptions): PreflightCheck {
  const home = os.homedir();
  try {
    // Attempt a write probe under ~/.switchbot without creating clutter.
    const probe = path.join(home, '.switchbot', `.preflight-${process.pid}-${Date.now()}`);
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    fs.unlinkSync(probe);
    void opts;
    return { name: 'home', status: 'ok', message: `writable: ${home}` };
  } catch (err) {
    return {
      name: 'home',
      status: 'fail',
      message: `cannot write under ${home}: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'check ownership and permissions on your home directory',
    };
  }
}

function checkAgentSkillDirWritable(opts: PreflightOptions): PreflightCheck | null {
  if (opts.agent !== 'claude-code') return null;
  const home = os.homedir();
  const target = path.join(home, '.claude', 'skills');
  try {
    fs.mkdirSync(target, { recursive: true });
    const probe = path.join(target, `.preflight-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { name: 'agent-skills-dir', status: 'ok', message: `writable: ${target}` };
  } catch (err) {
    return {
      name: 'agent-skills-dir',
      status: 'fail',
      message: `cannot prepare ${target}: ${err instanceof Error ? err.message : String(err)}`,
      hint: 'open Claude Code once (it will create ~/.claude) or create the directory manually',
    };
  }
}

/**
 * Run every pre-flight check and return a combined result. Safe to
 * call multiple times; no state is cached.
 */
export async function runPreflight(options: PreflightOptions = {}): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  checks.push(checkNodeVersion(options));
  checks.push(checkPolicy());
  checks.push(await checkKeychain());
  checks.push(checkHomeDirWritable(options));
  const agentCheck = checkAgentSkillDirWritable(options);
  if (agentCheck) checks.push(agentCheck);
  const ok = checks.every((c) => c.status !== 'fail');
  return { checks, ok };
}
