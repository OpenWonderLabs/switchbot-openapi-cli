#!/usr/bin/env node
/**
 * scripts/verify-release.mjs
 * Pre-release verification gate — checks that documented counts and versions
 * match the actual codebase. Exits non-zero if any discrepancy is found.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}

function countMatches(content, regex) {
  return (content.match(regex) || []).length;
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

// 1. MCP tool count
const mcpSrc = readFile('src/commands/mcp.ts');
const mcpToolCount = countMatches(mcpSrc, /server\.registerTool\(/g);
const agentGuide = readFile('docs/agent-guide.md');
const agentGuideMatch = agentGuide.match(/Available tools \((\d+)\)/);
const agentGuideCount = agentGuideMatch ? Number(agentGuideMatch[1]) : null;

if (agentGuideCount === null) {
  fail('docs/agent-guide.md: could not find "Available tools (N)" heading');
} else if (mcpToolCount !== agentGuideCount) {
  fail(`MCP tool count mismatch: code has ${mcpToolCount}, docs/agent-guide.md says ${agentGuideCount}`);
} else {
  pass(`MCP tools: ${mcpToolCount} (code = docs/agent-guide.md)`);
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
