/**
 * Live Route B smoke: copy the current candidate content locally, then run actual
 * Codex CLI commands against the copy to verify that:
 *   1. `codex plugin marketplace add <local-clone>` succeeds (manifest found at root)
 *   2. `codex plugin add switchbot@switchbot` succeeds
 *   3. `codex plugin list` output contains `switchbot@switchbot`
 *
 * Uses a local candidate fixture (no GitHub network call) and an isolated CODEX_HOME so the
 * test never touches the user's real Codex installation.
 *
 * Skips gracefully when `codex` is not on PATH — the test is optional and only
 * meaningful where Codex Desktop / CLI is installed.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

function runCodex(args, options = {}) {
  return spawnSync('codex', args, {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    ...options,
  });
}

const codexPath = which('codex');
if (!codexPath) {
  if (process.argv.includes('--require-host')) {
    console.error('Codex host is required for release verification but is not on PATH.');
    process.exit(1);
  }
  console.log('smoke-codex-route-b-live: codex not on PATH — skipped (optional)');
  process.exit(0);
}

const workDir = mkdtempSync(path.join(os.tmpdir(), 'switchbot-route-b-live-'));
const candidateDir = path.join(workDir, 'candidate');
const codexHome = path.join(workDir, 'codex-home');

function isolatedEnvironment() {
  const env = {
    ...process.env,
    HOME: path.join(workDir, 'home'),
    USERPROFILE: path.join(workDir, 'home'),
    XDG_CONFIG_HOME: path.join(workDir, 'xdg-config'),
    XDG_CACHE_HOME: path.join(workDir, 'xdg-cache'),
    XDG_DATA_HOME: path.join(workDir, 'xdg-data'),
    CODEX_HOME: codexHome,
  };
  for (const name of [
    'SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  ]) delete env[name];
  return env;
}

try {
  mkdirSync(codexHome, { recursive: true });

  // Copy the current worktree content rather than cloning HEAD: release candidates can
  // include uncommitted package changes that must be what the host actually loads.
  cpSync(path.join(repoRoot, '.agents'), path.join(candidateDir, '.agents'), { recursive: true });
  cpSync(
    path.join(repoRoot, 'packages', 'codex-plugin'),
    path.join(candidateDir, 'packages', 'codex-plugin'),
    { recursive: true },
  );

  const env = isolatedEnvironment();

  // Step 1: marketplace add against the current candidate fixture
  const mktAdd = runCodex(
    ['plugin', 'marketplace', 'add', candidateDir],
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

  console.log(`smoke-codex-route-b-live ok: Route B current candidate fixture → marketplace add + plugin add + list verified`);
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    process.stderr.write(`[smoke-codex-route-b-live] cleanup warning: ${err.message}\n`);
  }
}
