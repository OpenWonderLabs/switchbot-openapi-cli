import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const workDir = mkdtempSync(path.join(os.tmpdir(), 'switchbot-codex-git-sparse-'));
const stagingDir = path.join(workDir, 'marketplace-add');

function runGit(args, options = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    ...options,
  });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

try {
  let ref = process.env.CODEX_GIT_MARKETPLACE_REF;
  if (!ref) {
    try {
      const abbrev = runGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      ref = abbrev === 'HEAD'
        ? runGit(['rev-parse', 'HEAD']).trim()  // detached HEAD: use full SHA
        : abbrev;
    } catch (err) {
      throw new Error(`Failed to determine git ref for smoke test: ${err.message}`);
    }
  }

  // Clone: use --branch only for named branches; for SHAs clone without --branch then checkout
  if (ref.match(/^[0-9a-fA-F]{40}$/)) {
    runGit(['clone', '--no-checkout', repoRoot, stagingDir], { cwd: workDir });
  } else {
    runGit(['clone', '--no-checkout', '--branch', ref, repoRoot, stagingDir], { cwd: workDir });
  }
  runGit(['-C', stagingDir, 'sparse-checkout', 'init', '--cone'], { cwd: workDir });
  runGit(['-C', stagingDir, 'sparse-checkout', 'set', '.agents/plugins', '.claude-plugin', 'packages/codex-plugin', 'packages/claude-code-plugin'], { cwd: workDir });
  runGit(['-C', stagingDir, 'checkout', ref], { cwd: workDir });

  // <repo-root>/.agents/plugins/marketplace.json — Codex Route B entry point (Codex validates manifest at checkout root)
  const rootCodexMarketplacePath = path.join(stagingDir, '.agents', 'plugins', 'marketplace.json');
  // packages/codex-plugin/.agents/plugins/marketplace.json — package-level entry (Route A / resolveMarketplaceName fallback)
  const packageMarketplacePath = path.join(stagingDir, 'packages', 'codex-plugin', '.agents', 'plugins', 'marketplace.json');
  const pluginMcpPath = path.join(stagingDir, 'packages', 'codex-plugin', 'plugins', 'switchbot', '.mcp.json');
  // packages/claude-code-plugin/plugins/switchbot — Claude Code plugin source
  const claudeCodePluginJsonPath = path.join(stagingDir, 'packages', 'claude-code-plugin', 'plugins', 'switchbot', '.claude-plugin', 'plugin.json');

  for (const requiredPath of [rootCodexMarketplacePath, packageMarketplacePath, pluginMcpPath, claudeCodePluginJsonPath]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`sparse checkout missing ${path.relative(stagingDir, requiredPath)}`);
    }
  }

  // Repo-root Codex manifest: Codex validates this file when `codex plugin marketplace add <path>` is called.
  // It must exist at the checkout root and its source must point to the real plugin directory.
  const rootCodexMarketplace = readJson(rootCodexMarketplacePath);
  if (rootCodexMarketplace?.name !== 'switchbot') {
    throw new Error(`root Codex marketplace name must be switchbot, got ${rootCodexMarketplace?.name ?? '<missing>'}`);
  }
  const rootCodexPlugin = rootCodexMarketplace?.plugins?.find((p) => p?.name === 'switchbot');
  if (rootCodexPlugin?.source !== './packages/codex-plugin/plugins/switchbot') {
    throw new Error(
      `root Codex marketplace switchbot source must be ./packages/codex-plugin/plugins/switchbot, got ${rootCodexPlugin?.source ?? '<missing>'}`,
    );
  }

  const packageMarketplace = readJson(packageMarketplacePath);
  if (packageMarketplace?.name !== 'switchbot') {
    throw new Error(`package marketplace name must be switchbot, got ${packageMarketplace?.name ?? '<missing>'}`);
  }
  const packagePlugin = packageMarketplace?.plugins?.find((p) => p?.name === 'switchbot');
  if (packagePlugin?.source !== './plugins/switchbot') {
    throw new Error(`package marketplace switchbot source must be ./plugins/switchbot, got ${packagePlugin?.source ?? '<missing>'}`);
  }

  console.log(`codex git sparse smoke ok: ref ${ref} exposes Codex root manifest + package manifest with correct sources`);
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(`[smoke-codex-git-sparse] cleanup warning: ${error.message}\n`);
  }
}
