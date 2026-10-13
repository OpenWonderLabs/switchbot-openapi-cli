#!/usr/bin/env node
/**
 * scripts/verify-release.mjs
 * Pre-release verification gate — checks that documented counts and versions
 * match the actual codebase. Exits non-zero if any discrepancy is found.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

let errors = 0;
let warnings = 0;

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  errors++;
}

function warn(msg) {
  console.error(`  ! ${msg}`);
  warnings++;
}

function pass(msg) {
  console.error(`  ✓ ${msg}`);
}

console.error('verify-release: checking pre-release invariants\n');

// 1. MCP tool count — query the built CLI directory, not registration source text.
const agentGuide = readFile('docs/agent-guide.md');
const agentGuideMatch = agentGuide.match(/Available tools\s*\(\s*(\d+)(?:\s+tools)?(?:,|\))/i);
const agentGuideCount = agentGuideMatch ? Number(agentGuideMatch[1]) : null;
const profileMatch = agentGuide.match(/default profile exposes\s+(\d+)\s+tools;\s+`--tools readonly` exposes\s+(\d+)/i);

function runtimeTools(profile) {
  const cli = path.join(ROOT, 'dist', 'index.js');
  if (!fs.existsSync(cli)) {
    fail('dist/index.js is missing; run the release build before verify-release');
    return new Set();
  }
  const result = spawnSync(process.execPath, [cli, '--json', 'mcp', 'tools', '--tools', profile], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SWITCHBOT_TOKEN: '', SWITCHBOT_SECRET: '' },
  });
  if (result.status !== 0) {
    fail(`Built CLI MCP directory failed for profile ${profile}: ${result.stderr.trim() || result.stdout.trim()}`);
    return new Set();
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const tools = parsed?.data?.tools;
    if (!Array.isArray(tools) || tools.some((tool) => typeof tool?.name !== 'string')) {
      fail(`Built CLI MCP directory returned an invalid tool list for profile ${profile}`);
      return new Set();
    }
    const names = new Set(tools.map((tool) => tool.name));
    if (names.size !== tools.length) fail(`Built CLI MCP directory returned duplicate tool names for profile ${profile}`);
    return names;
  } catch (error) {
    fail(`Built CLI MCP directory returned invalid JSON for profile ${profile}: ${error instanceof Error ? error.message : String(error)}`);
    return new Set();
  }
}

const allTools = runtimeTools('all');
const defaultTools = runtimeTools('default');
const readonlyTools = runtimeTools('readonly');
if (agentGuideCount === null) {
  fail('docs/agent-guide.md: could not find the Available tools count');
} else if (allTools.size !== agentGuideCount) {
  fail(`MCP tool count mismatch: built CLI has ${allTools.size}, docs/agent-guide.md says ${agentGuideCount}`);
} else if (![...defaultTools].every((name) => allTools.has(name)) || ![...readonlyTools].every((name) => allTools.has(name))) {
  fail('MCP profile directory contains a tool absent from the built all-tools directory');
} else if (profileMatch && (defaultTools.size !== Number(profileMatch[1]) || readonlyTools.size !== Number(profileMatch[2]))) {
  fail(`MCP profile count mismatch: built default/readonly are ${defaultTools.size}/${readonlyTools.size}, docs say ${profileMatch[1]}/${profileMatch[2]}`);
} else {
  pass(`MCP tools: all=${allTools.size}, default=${defaultTools.size}, readonly=${readonlyTools.size} (built CLI = docs)`);
}

// 2. Doctor check count
const doctorSrc = readFile('src/commands/doctor.ts');
const doctorChecks = new Set(doctorSrc.match(/name: '[^']+'/g) || []);
const doctorCount = doctorChecks.size;
const readme = readFile('README.md');
const readmeDoctorMatch = readme.match(/(\d+)\s*(?:health|doctor|diagnostic)\s*check/i);
if (readmeDoctorMatch) {
  const readmeDoctorCount = Number(readmeDoctorMatch[1]);
  if (doctorCount !== readmeDoctorCount) {
    fail(`Doctor check count mismatch: code has ${doctorCount}, README says ${readmeDoctorCount}`);
  } else {
    pass(`Doctor checks: ${doctorCount} (code = README)`);
  }
} else {
  warn(`README.md: could not find doctor check count pattern — manual verification needed (code has ${doctorCount})`);
}

// 3. Audit version
const auditSrc = readFile('src/utils/audit.ts');
const auditVersionMatch = auditSrc.match(/AUDIT_VERSION\s*=\s*(\d+)/);
const auditVersion = auditVersionMatch ? Number(auditVersionMatch[1]) : null;
const auditDoc = readFile('docs/audit-log.md');
const auditDocMatch = auditDoc.match(/Current:\s*`(\d+)`/);
const auditDocVersion = auditDocMatch ? Number(auditDocMatch[1]) : null;

if (auditVersion === null) {
  fail('src/utils/audit.ts: could not find AUDIT_VERSION constant');
} else if (auditDocVersion === null) {
  fail('docs/audit-log.md: could not find "Current: `N`" pattern');
} else if (auditVersion !== auditDocVersion) {
  fail(`Audit version mismatch: code has ${auditVersion}, docs/audit-log.md says ${auditDocVersion}`);
} else {
  pass(`Audit version: ${auditVersion} (code = docs/audit-log.md)`);
}

// 4. package.json version vs tag (informational)
const pkg = JSON.parse(readFile('package.json'));
pass(`package.json version: ${pkg.version}`);

// 5. Test count (informational — just report, don't fail on mismatch since test count changes frequently)
const readmeTestMatch = readme.match(/(\d{3,})\s*tests/);
if (readmeTestMatch) {
  const readmeTestCount = Number(readmeTestMatch[1]);
  warn(`README says ${readmeTestCount} tests — run \`npm test\` and update if stale`);
} else {
  warn('README.md: could not find test count pattern');
}

// 6. Claude's npm and GitHub installation routes must advertise the same version.
const claudeMetadata = spawnSync(process.execPath, [
  path.join(ROOT, 'packages/claude-code-plugin/lib/verify-release.js'),
  path.join(ROOT, '.claude-plugin/marketplace.json'),
], { cwd: ROOT, encoding: 'utf8' });
if (claudeMetadata.status !== 0) {
  fail(`Claude release metadata: ${claudeMetadata.stderr.trim() || claudeMetadata.error?.message || 'verification failed'}`);
} else {
  pass('Claude release metadata: npm package, both marketplaces, and plugin version agree');
}

// Summary
console.error('');
if (errors > 0) {
  console.error(`FAILED: ${errors} error(s), ${warnings} warning(s)`);
  process.exit(1);
} else if (warnings > 0) {
  console.error(`PASSED with ${warnings} warning(s)`);
} else {
  console.error('PASSED: all checks green');
}
