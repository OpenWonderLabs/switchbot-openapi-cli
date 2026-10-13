#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OUTCOMES = new Set(['published', 'already-published', 'failed', 'dry-run']);
const GATES = ['artifact', 'exact-candidate', 'required-host'];

function fail(message) {
  throw new Error(message);
}

function options(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (key === 'dry-run') {
      result.set(key, 'true');
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for --${key}`);
    result.set(key, value);
    index += 1;
  }
  return result;
}

function required(args, key) {
  const value = args.get(key);
  if (!value) fail(`Missing required --${key}`);
  return value;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

function readOutcomes(file) {
  const parsed = readJson(file);
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.packages)) {
    fail(`${file} is not a release candidate outcome manifest`);
  }
  const seen = new Set();
  for (const item of parsed.packages) {
    if (!item || typeof item.name !== 'string' || typeof item.version !== 'string' || !OUTCOMES.has(item.outcome)) {
      fail(`${file} contains an invalid package outcome`);
    }
    const candidate = `${item.name}@${item.version}`;
    if (seen.has(candidate)) fail(`${file} records ${candidate} more than once`);
    seen.add(candidate);
  }
  return parsed;
}

function candidateKey(name, version) {
  return `${name}@${version}`;
}

function appendOutcome(file, item) {
  const manifest = existsSync(file) ? readOutcomes(file) : { schemaVersion: 1, packages: [] };
  const candidate = candidateKey(item.name, item.version);
  if (manifest.packages.some((entry) => candidateKey(entry.name, entry.version) === candidate)) {
    fail(`${candidate} already has a recorded outcome`);
  }
  manifest.packages.push(item);
  writeJson(file, manifest);
}

function runNpm(args) {
  return spawnSync('npm', args, { encoding: 'utf8', env: process.env });
}

function isNotFound(result) {
  return /(?:^|\s)(?:E?404)(?:\s|$)|not found/i.test(`${result.stdout}\n${result.stderr}`);
}


function init(args) {
  const file = required(args, 'outcomes');
  if (existsSync(file)) fail(`${file} already exists`);
  const expected = args.get('expected')?.split(',').filter(Boolean) ?? [];
  if (new Set(expected).size !== expected.length) fail('Expected candidates must be unique');
  writeJson(file, { schemaVersion: 1, expected, packages: [] });
}

function record(args) {
  const outcome = required(args, 'outcome');
  if (!OUTCOMES.has(outcome)) fail(`Unsupported outcome: ${outcome}`);
  appendOutcome(required(args, 'outcomes'), {
    name: required(args, 'package'),
    version: required(args, 'version'),
    outcome,
  });
}

function probe(args) {
  const outcomesFile = required(args, 'outcomes');
  const name = required(args, 'package');
  const version = required(args, 'version');
  if (args.get('dry-run') === 'true') {
    appendOutcome(outcomesFile, { name, version, outcome: 'dry-run' });
    process.stdout.write('publish=false\n');
    return;
  }
  if (!process.env.NODE_AUTH_TOKEN) {
    appendOutcome(outcomesFile, { name, version, outcome: 'failed' });
    fail(`NPM authentication is required to publish ${candidateKey(name, version)}`);
  }
  const viewed = runNpm(['view', `${name}@${version}`, 'version', '--json']);
  if (viewed.status === 0) {
    let found;
    try {
      found = JSON.parse(viewed.stdout);
    } catch {
      found = viewed.stdout.trim();
    }
    if (found !== version) {
      appendOutcome(outcomesFile, { name, version, outcome: 'failed' });
      fail(`Registry returned an unexpected version for ${candidateKey(name, version)}`);
    }
    appendOutcome(outcomesFile, { name, version, outcome: 'already-published' });
    process.stdout.write('publish=false\n');
    return;
  }
  if (!isNotFound(viewed)) {
    appendOutcome(outcomesFile, { name, version, outcome: 'failed' });
    fail(`Could not determine whether ${candidateKey(name, version)} is published: ${viewed.stderr.trim()}`);
  }
  process.stdout.write('publish=true\n');
}


function assertOutcomes(args) {
  const manifest = readOutcomes(required(args, 'outcomes'));
  if (manifest.packages.length === 0) fail('Release candidate manifest has no package outcomes');
  if (Array.isArray(manifest.expected)) {
    const recorded = new Set(manifest.packages.map((item) => candidateKey(item.name, item.version)));
    const missing = manifest.expected.filter((candidate) => !recorded.has(candidate));
    if (missing.length > 0) fail(`Release candidate outcomes are missing: ${missing.join(', ')}`);
  }
  const failures = manifest.packages.filter((item) => item.outcome === 'failed' || item.outcome === 'dry-run');
  if (failures.length > 0) {
    fail(`Release candidate is not promotable: ${failures.map((item) => `${candidateKey(item.name, item.version)}=${item.outcome}`).join(', ')}`);
  }
}

function candidate(args) {
  const name = required(args, 'package');
  const version = required(args, 'version');
  const manifest = readOutcomes(required(args, 'outcomes'));
  const item = manifest.packages.find((entry) => entry.name === name && entry.version === version);
  if (!item) fail(`No recorded outcome for ${candidateKey(name, version)}`);
  if (item.outcome === 'failed' || item.outcome === 'dry-run') fail(`${candidateKey(name, version)} has outcome ${item.outcome}`);
  process.stdout.write(`outcome=${item.outcome}\nsmoke=${item.outcome === 'published' ? 'true' : 'false'}\nskip=${item.outcome === 'published' ? 'false' : 'true'}\n`);
}

function readGates(file) {
  const parsed = readJson(file);
  if (!parsed || typeof parsed !== 'object' || !parsed.candidates || typeof parsed.candidates !== 'object') {
    fail(`${file} is not a candidate gate manifest`);
  }
  return parsed;
}

function recordGate(args) {
  const file = required(args, 'gates');
  const candidate = required(args, 'candidate');
  const gates = readGates(file);
  if (gates.candidates[candidate]) fail(`${candidate} already has recorded gates`);
  const result = {};
  for (const gate of GATES) result[gate] = required(args, gate);
  gates.candidates[candidate] = result;
  writeJson(file, gates);
}

function gateStatus(value, candidate, gate) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value[gate];
}

function assertExactHostCandidate(outcomes, hostEvidence) {
  const versions = {
    "@switchbot/openapi-cli": hostEvidence?.candidate?.cliVersion,
    "@switchbot/codex-plugin": hostEvidence?.candidate?.packages?.codex,
    "@switchbot/openclaw-skill": hostEvidence?.candidate?.packages?.openclaw,
    "@switchbot/claude-code-plugin": hostEvidence?.candidate?.packages?.claude,
    "@switchbot/gemini-extension": hostEvidence?.candidate?.packages?.gemini,
  };
  for (const item of outcomes.packages) {
    if (versions[item.name] !== item.version) {
      fail("Required host evidence does not match " + candidateKey(item.name, item.version) + ".");
    }
  }
}

function hasReadonlyDeviceHistoryEvidence(host) {
  const readonly = host?.readonly;
  return readonly?.tool === "device_history"
    && readonly.mode === "raw"
    && readonly.resultShape === "devices"
    && Number.isInteger(readonly.deviceCount)
    && readonly.deviceCount >= 0;
}

function createGates(args) {
  const outcomes = readOutcomes(required(args, "outcomes"));
  const evidence = required(args, "host-evidence");
  const hostEvidence = readJson(evidence);
  const requiredHosts = new Set(["codex", "claude", "gemini", "openclaw"]);
  if (hostEvidence?.status !== "passed" || !Array.isArray(hostEvidence.hosts)) {
    fail("Required host evidence does not report a passed release gate");
  }
  assertExactHostCandidate(outcomes, hostEvidence);
  const hostsByName = new Map(hostEvidence.hosts.map((host) => [host?.name, host]));
  for (const host of requiredHosts) {
    const evidenceForHost = hostsByName.get(host);
    if (evidenceForHost?.status !== "passed") fail("Required host evidence is missing a passed " + host + " host");
    if (!hasReadonlyDeviceHistoryEvidence(evidenceForHost)) {
      fail("Required host evidence is missing a concrete device_history raw result for " + host + ".");
    }
  }
  const gates = { candidates: {} };
  for (const item of outcomes.packages) {
    if (item.outcome !== "published") continue;
    gates.candidates[candidateKey(item.name, item.version)] = Object.fromEntries(GATES.map((gate) => [gate, "passed"]));
  }
  writeJson(required(args, "gates"), gates);
}

function promote(args) {
  if (!process.env.NODE_AUTH_TOKEN) fail('NPM authentication is required to promote a release candidate');
  const outcomes = readOutcomes(required(args, 'outcomes'));
  const gates = readGates(required(args, 'gates'));
  const blocked = [];
  for (const item of outcomes.packages) {
    const candidate = candidateKey(item.name, item.version);
    if (item.outcome === 'failed' || item.outcome === 'dry-run') {
      blocked.push(`${candidate}=${item.outcome}`);
      continue;
    }
    if (item.outcome === 'published') {
      for (const gate of GATES) {
        if (gateStatus(gates.candidates[candidate], candidate, gate) !== 'passed') blocked.push(`${candidate}:${gate}`);
      }
    }
  }
  if (blocked.length > 0) fail(`Promotion blocked: ${blocked.join(', ')}`);
  const summary = { published: [], alreadyPublished: [] };
  for (const item of outcomes.packages) {
    const candidate = candidateKey(item.name, item.version);
    if (item.outcome === 'already-published') {
      summary.alreadyPublished.push(candidate);
      continue;
    }
    const tagged = runNpm(['dist-tag', 'add', candidate, 'latest']);
    if (tagged.status !== 0) fail(`Could not promote ${candidate}: ${tagged.stderr.trim()}`);
    summary.published.push(candidate);
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

try {
  const [command, ...rest] = process.argv.slice(2);
  const args = options(rest);
  if (command === 'init') init(args);
  else if (command === 'record') record(args);
  else if (command === 'probe') probe(args);
  else if (command === 'assert-outcomes') assertOutcomes(args);
  else if (command === 'candidate') candidate(args);
  else if (command === 'record-gate') recordGate(args);
  else if (command === 'create-gates') createGates(args);
  else if (command === 'promote') promote(args);
  else fail(`Unknown command: ${command ?? '<none>'}`);
} catch (error) {
  process.stderr.write(`release-candidate: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
