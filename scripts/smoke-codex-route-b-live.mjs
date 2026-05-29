/**
 * Live Route B smoke: sparse-clone the repo locally, then run actual Codex CLI
 * commands against the clone to verify that:
 *   1. `codex plugin marketplace add <local-clone>` succeeds (manifest found at root)
 *   2. `codex plugin add switchbot@switchbot` succeeds
 *   3. `codex plugin list` output contains `switchbot@switchbot`
 *
 * Uses a local clone (no GitHub network call) and an isolated CODEX_HOME so the
 * test never touches the user's real Codex installation.
 *
 * Skips gracefully when `codex` is not on PATH — the test is optional and only
 * meaningful where Codex Desktop / CLI is installed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);

function which(cmd) {
  const r = spawnSync(
    process.platform === 'win32' ? 'where' : 'which',
    [cmd],
    { encoding: 'utf-8', shell: false },
  );
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

function runGit(args, options = {}) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8', ...options });
}

function runCodex(args, options = {}) {
  return spawnSync('codex', args, {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    ...options,
  });
}

const codexPath = which('codex');
if (!codexPath) {
  console.log('smoke-codex-route-b-live: codex not on PATH — skipped (optional)');
  process.exit(0);
}

const workDir = mkdtempSync(path.join(os.tmpdir(), 'switchbot-route-b-live-'));
const cloneDir = path.join(workDir, 'sparse-clone');
const codexHome = path.join(workDir, 'codex-home');

try {
  mkdirSync(codexHome, { recursive: true });

  // Determine the ref to clone (current branch or SHA)
  let ref;
  try {
    const abbrev = runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    ref = abbrev === 'HEAD' ? runGit(['rev-parse', 'HEAD']).trim() : abbrev;
  } catch (err) {
    throw new Error(`Failed to determine git ref: ${err.message}`);
  }

  // Sparse clone: include the two directories Codex needs
  if (ref.match(/^[0-9a-fA-F]{40}$/)) {
    runGit(['clone', '--no-checkout', repoRoot, cloneDir], { cwd: workDir });
  } else {
    runGit(['clone', '--no-checkout', '--branch', ref, repoRoot, cloneDir], { cwd: workDir });
  }
  runGit(['-C', cloneDir, 'sparse-checkout', 'init', '--cone'], { cwd: workDir });
  runGit(['-C', cloneDir, 'sparse-checkout', 'set', '.agents/plugins', 'packages/codex-plugin'], { cwd: workDir });
  runGit(['-C', cloneDir, 'checkout', ref], { cwd: workDir });

  const env = { ...process.env, CODEX_HOME: codexHome };

  // Step 1: marketplace add against the local clone
  const mktAdd = runCodex(
    ['plugin', 'marketplace', 'add', cloneDir],
    { env, timeout: 30000 },
  );
  if (mktAdd.status !== 0) {
    throw new Error(
      `codex plugin marketplace add failed (exit ${mktAdd.status}):\n${mktAdd.stderr}`,
    );
  }

  // Step 2: plugin add
  const pluginAdd = runCodex(
    ['plugin', 'add', 'switchbot@switchbot'],
    { env, timeout: 15000 },
  );
  if (pluginAdd.status !== 0) {
    throw new Error(
      `codex plugin add failed (exit ${pluginAdd.status}):\n${pluginAdd.stderr}`,
    );
  }

  // Step 3: verify plugin list contains switchbot@switchbot
  const list = runCodex(['plugin', 'list'], { env, timeout: 10000 });
  if (list.status !== 0) {
    throw new Error(`codex plugin list failed (exit ${list.status}):\n${list.stderr}`);
  }
  const listOut = list.stdout + list.stderr;
  if (!/switchbot@switchbot/i.test(listOut)) {
    throw new Error(
      `codex plugin list does not contain switchbot@switchbot after install.\nOutput:\n${listOut}`,
    );
  }

  console.log(`smoke-codex-route-b-live ok: Route B local clone → marketplace add + plugin add + list verified (ref ${ref})`);
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    process.stderr.write(`[smoke-codex-route-b-live] cleanup warning: ${err.message}\n`);
  }
}
