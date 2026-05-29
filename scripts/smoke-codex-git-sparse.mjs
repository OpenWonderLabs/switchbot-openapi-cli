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
  runGit(['-C', stagingDir, 'sparse-checkout', 'set', '.claude-plugin', 'packages/codex-plugin', 'packages/claude-code-plugin'], { cwd: workDir });
  runGit(['-C', stagingDir, 'checkout', ref], { cwd: workDir });

  // .claude-plugin/marketplace.json — Claude Code plugin marketplace entry point
  const rootMarketplacePath = path.join(stagingDir, '.claude-plugin', 'marketplace.json');
  // packages/codex-plugin/.agents/plugins/marketplace.json — Codex Route B entry point
  const packageMarketplacePath = path.join(stagingDir, 'packages', 'codex-plugin', '.agents', 'plugins', 'marketplace.json');
  const pluginMcpPath = path.join(stagingDir, 'packages', 'codex-plugin', 'plugins', 'switchbot', '.mcp.json');
  // packages/claude-code-plugin/plugins/switchbot — Claude Code plugin source
  const claudeCodePluginJsonPath = path.join(stagingDir, 'packages', 'claude-code-plugin', 'plugins', 'switchbot', '.claude-plugin', 'plugin.json');

  for (const requiredPath of [rootMarketplacePath, packageMarketplacePath, pluginMcpPath, claudeCodePluginJsonPath]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`sparse checkout missing ${path.relative(stagingDir, requiredPath)}`);
    }
  }

  // Root marketplace must point to the Claude Code plugin directory
  const rootMarketplace = readJson(rootMarketplacePath);
  if (rootMarketplace?.name !== 'switchbot') {
    throw new Error(`root marketplace name must be switchbot, got ${rootMarketplace?.name ?? '<missing>'}`);
  }
  const rootPlugin = rootMarketplace?.plugins?.find((plugin) => plugin?.name === 'switchbot');
  if (rootPlugin?.source !== './packages/claude-code-plugin/plugins/switchbot') {
    throw new Error(
      `root marketplace switchbot source must be ./packages/claude-code-plugin/plugins/switchbot, got ${rootPlugin?.source ?? '<missing>'}`,
    );
  }

  const packageMarketplace = readJson(packageMarketplacePath);
  if (packageMarketplace?.name !== 'switchbot') {
    throw new Error(`package marketplace name must be switchbot, got ${packageMarketplace?.name ?? '<missing>'}`);
  }
  const packagePlugin = packageMarketplace?.plugins?.find((plugin) => plugin?.name === 'switchbot');
  if (packagePlugin?.source !== './plugins/switchbot') {
    throw new Error(`package marketplace switchbot source must be ./plugins/switchbot, got ${packagePlugin?.source ?? '<missing>'}`);
  }

  console.log(`codex git sparse smoke ok: ref ${ref} exposes Claude Code and Codex marketplace manifests with correct sources`);
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (error) {
    process.stderr.write(`[smoke-codex-git-sparse] cleanup warning: ${error.message}\n`);
  }
}
