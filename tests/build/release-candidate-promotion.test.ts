import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';

const PACKAGE_OUTCOMES = [
  { name: '@switchbot/openapi-cli', version: '3.9.0', outcome: 'published' },
  { name: '@switchbot/codex-plugin', version: '0.2.0', outcome: 'already-published' },
  { name: '@switchbot/openclaw-skill', version: '0.2.0', outcome: 'already-published' },
  { name: '@switchbot/claude-code-plugin', version: '0.2.0', outcome: 'already-published' },
  { name: '@switchbot/gemini-extension', version: '0.2.0', outcome: 'already-published' },
];

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function promoteWithRegistry(
  packages: typeof PACKAGE_OUTCOMES,
  registry: Record<string, { latest?: string }>,
  registryError?: 'unavailable' | 'malformed',
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'switchbot-promotion-registry-'));
  tempDirs.push(directory);
  const outcomes = path.join(directory, 'outcomes.json');
  const gates = path.join(directory, 'gates.json');
  const state = structuredClone(registry);
  writeFileSync(outcomes, JSON.stringify({ schemaVersion: 1, packages }));
  writeFileSync(gates, JSON.stringify({ candidates: Object.fromEntries(packages.map(item => [
    `${item.name}@${item.version}`, { artifact: 'passed', 'exact-candidate': 'passed', 'required-host': 'passed' },
  ])) }));
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const url = decodeURIComponent(request.url ?? '/');
    if (request.method === 'GET') {
      if (registryError === 'unavailable') { response.writeHead(503); response.end('{}'); return; }
      if (registryError === 'malformed') { response.end('invalid-json'); return; }
      const name = url.startsWith('/-/package/') ? url.slice('/-/package/'.length, -'/dist-tags'.length) : url.slice(1);
      const candidate = packages.find(item => item.name === name);
      if (!candidate) { response.writeHead(404); response.end('{}'); return; }
      const tags = { next: candidate.version, ...state[name] };
      const versions = new Set([candidate.version, ...(state[name]?.latest ? [state[name].latest] : [])]);
      response.end(JSON.stringify(url.startsWith('/-/package/') ? tags : {
        name, 'dist-tags': tags, versions: Object.fromEntries([...versions].map(version => [version, { name, version }])),
      }));
    } else if (request.method === 'PUT' && url.endsWith('/dist-tags/latest')) {
      const name = url.slice('/-/package/'.length, -'/dist-tags/latest'.length);
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        state[name] = { ...state[name], latest: JSON.parse(body) };
        response.end('{}');
      });
    } else {
      response.writeHead(404);
      response.end('{}');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Registry fixture did not bind TCP');
  try {
    const child = spawn(process.execPath, [
      'scripts/release-candidate.mjs', 'promote', '--outcomes', outcomes, '--gates', gates,
    ], { cwd: process.cwd(), env: {
      ...process.env, NODE_AUTH_TOKEN: 'offline-fixture',
      NPM_CONFIG_REGISTRY: `http://127.0.0.1:${address.port}`,
      NPM_CONFIG_USERCONFIG: path.join(directory, 'isolated.npmrc'),
      NPM_CONFIG_CACHE: path.join(directory, 'npm-cache'), NPM_CONFIG_FETCH_RETRIES: '0',
    } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const [status] = await once(child, 'close');
    return { result: { status, stdout, stderr }, registry: state };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('release candidate promotion', () => {
  it('rejects a stale package before changing any candidate latest tags', async () => {
    const registry = {
      '@switchbot/openapi-cli': { latest: '3.8.1' },
      '@switchbot/codex-plugin': { latest: '0.3.0' },
    };
    const candidate = PACKAGE_OUTCOMES.map(item => item.name === '@switchbot/codex-plugin'
      ? { ...item, outcome: 'published' } : item);
    const promotion = await promoteWithRegistry(candidate, registry);
    expect(promotion.result.status).toBe(1);
    expect(promotion.registry).toEqual(registry);
  });

  it.each([
    [undefined, '3.9.0', true],
    ['3.9.0', '3.9.0', true],
    ['3.9.0', '3.10.0', true],
    ['3.9.0-beta.10', '3.9.0-beta.2', false],
    ['3.9.0', '3.9.0-beta.1', false],
    ['invalid', '3.9.0', false],
    ['3.9.0', 'invalid', false],
  ] as const)('guards latest=%s against candidate=%s', async (latest, version, allowed) => {
    const registry = { '@switchbot/openapi-cli': latest === undefined ? {} : { latest } };
    const packages = PACKAGE_OUTCOMES.map(item => item.name === '@switchbot/openapi-cli' ? { ...item, version } : item);
    const promotion = await promoteWithRegistry(packages, registry);
    expect(promotion.result.status, promotion.result.stderr).toBe(allowed ? 0 : 1);
    expect(promotion.registry).toEqual(allowed ? { '@switchbot/openapi-cli': { latest: version } } : registry);
  });

  it('promotes a newer CLI while leaving already-published plugin tags unchanged', async () => {
    const promotion = await promoteWithRegistry(PACKAGE_OUTCOMES, {
      '@switchbot/openapi-cli': { latest: '3.8.1' },
      '@switchbot/codex-plugin': { latest: '0.3.0' },
    });
    expect(promotion.result.status, promotion.result.stderr).toBe(0);
    expect(promotion.registry).toEqual({
      '@switchbot/openapi-cli': { latest: '3.9.0' },
      '@switchbot/codex-plugin': { latest: '0.3.0' },
    });
    expect(JSON.parse(promotion.result.stdout)).toEqual({
      published: ['@switchbot/openapi-cli@3.9.0'],
      alreadyPublished: [
        '@switchbot/codex-plugin@0.2.0', '@switchbot/openclaw-skill@0.2.0',
        '@switchbot/claude-code-plugin@0.2.0', '@switchbot/gemini-extension@0.2.0',
      ],
    });
  });

  it.each(['unavailable', 'malformed'] as const)('blocks promotion when registry metadata is %s', async error => {
    const registry = { '@switchbot/openapi-cli': { latest: '3.8.1' } };
    const promotion = await promoteWithRegistry(PACKAGE_OUTCOMES, registry, error);
    expect(promotion.result.status).toBe(1);
    expect(promotion.registry).toEqual(registry);
  });

  it('rejects passed host evidence from a different candidate', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'switchbot-release-evidence-'));
    tempDirs.push(directory);
    const outcomes = path.join(directory, 'outcomes.json');
    const evidence = path.join(directory, 'host-evidence.json');
    const gates = path.join(directory, 'gates.json');
    writeFileSync(outcomes, JSON.stringify({ schemaVersion: 1, packages: PACKAGE_OUTCOMES }));
    writeFileSync(evidence, JSON.stringify({
      status: 'passed',
      candidate: {
        cliVersion: '3.8.1',
        packages: { codex: '0.1.0', claude: '0.1.0', gemini: '0.1.0', openclaw: '0.1.0' },
      },
      hosts: ['codex', 'claude', 'gemini', 'openclaw'].map((name) => ({ name, status: 'passed' })),
    }));

    const result = spawnSync(process.execPath, [
      'scripts/release-candidate.mjs', 'create-gates', '--outcomes', outcomes, '--host-evidence', evidence, '--gates', gates,
    ], { cwd: process.cwd(), encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(existsSync(gates)).toBe(false);
  });

  it("accepts matching readonly evidence for the published candidate", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "switchbot-release-evidence-success-"));
    tempDirs.push(directory);
    const outcomes = path.join(directory, "outcomes.json");
    const evidence = path.join(directory, "host-evidence.json");
    const gates = path.join(directory, "gates.json");
    writeFileSync(outcomes, JSON.stringify({ schemaVersion: 1, packages: PACKAGE_OUTCOMES }));
    writeFileSync(evidence, JSON.stringify({
      status: "passed",
      candidate: {
        cliVersion: "3.9.0",
        packages: { codex: "0.2.0", claude: "0.2.0", gemini: "0.2.0", openclaw: "0.2.0" },
      },
      hosts: ["codex", "claude", "gemini", "openclaw"].map((name) => ({
        name,
        status: "passed",
        readonly: { tool: "device_history", mode: "raw", resultShape: "devices", deviceCount: 0 },
      })),
    }));

    const result = spawnSync(process.execPath, [
      "scripts/release-candidate.mjs", "create-gates", "--outcomes", outcomes, "--host-evidence", evidence, "--gates", gates,
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(gates, "utf8"))).toEqual({
      candidates: {
        "@switchbot/openapi-cli@3.9.0": {
          artifact: "passed", "exact-candidate": "passed", "required-host": "passed",
        },
      },
    });
  });

  it("rejects list-only host evidence for an otherwise matching candidate", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "switchbot-release-evidence-list-only-"));
    tempDirs.push(directory);
    const outcomes = path.join(directory, "outcomes.json");
    const evidence = path.join(directory, "host-evidence.json");
    const gates = path.join(directory, "gates.json");
    writeFileSync(outcomes, JSON.stringify({ schemaVersion: 1, packages: PACKAGE_OUTCOMES }));
    writeFileSync(evidence, JSON.stringify({
      status: "passed",
      candidate: {
        cliVersion: "3.9.0",
        packages: { codex: "0.2.0", claude: "0.2.0", gemini: "0.2.0", openclaw: "0.2.0" },
      },
      hosts: ["codex", "claude", "gemini", "openclaw"].map((name) => ({ name, status: "passed", tools: ["device_diary", "device_history"] })),
    }));

    const result = spawnSync(process.execPath, [
      "scripts/release-candidate.mjs", "create-gates", "--outcomes", outcomes, "--host-evidence", evidence, "--gates", gates,
    ], { cwd: process.cwd(), encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(existsSync(gates)).toBe(false);
  });

  it('blocks dist-tags until exact candidate and every required host pass', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'switchbot-release-candidate-'));
    tempDirs.push(directory);
    const outcomes = path.join(directory, 'outcomes.json');
    const gatesFile = path.join(directory, 'gates.json');
    const npmLog = path.join(directory, 'npm.log');
    const npmBin = path.join(directory, 'npm');
    writeFileSync(outcomes, JSON.stringify({ schemaVersion: 1, packages: PACKAGE_OUTCOMES }));
    writeFileSync(npmBin, `#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"${npmLog}\"\n`);
    chmodSync(npmBin, 0o755);

    const runPromotion = (gateState: Record<string, string>) => {
      writeFileSync(gatesFile, JSON.stringify(gateManifest(gateState)));
      return spawnSync(process.execPath, [
        'scripts/release-candidate.mjs', 'promote', '--outcomes', outcomes, '--gates', gatesFile,
      ], {
        cwd: process.cwd(),
        env: { ...process.env, NODE_AUTH_TOKEN: 'offline-fixture', PATH: `${directory}:${process.env.PATH}` },
        encoding: 'utf8',
      });
    };

    const required = Object.fromEntries(PACKAGE_OUTCOMES.flatMap(({ name, version }) => {
      const candidate = `${name}@${version}`;
      return ['artifact', 'exact-candidate', 'required-host'].map((gate) => [
        `${candidate}:${gate}`,
        'passed',
      ]);
    }));
    const gateManifest = (overrides: Record<string, string>) => ({
      candidates: Object.fromEntries(PACKAGE_OUTCOMES.map(({ name, version }) => {
        const candidate = `${name}@${version}`;
        return [candidate, Object.fromEntries(['artifact', 'exact-candidate', 'required-host'].map((gate) => [
          gate,
          overrides[`${candidate}:${gate}`] ?? 'passed',
        ]))];
      })),
    });

    const exactCandidateFailure = runPromotion({
      ...required,
      '@switchbot/openapi-cli@3.9.0:exact-candidate': 'failed',
    });
    expect(exactCandidateFailure.status).toBe(1);
    expect(() => readFileSync(npmLog, 'utf8')).toThrow();

    const requiredHostFailure = runPromotion({
      ...required,
      '@switchbot/openapi-cli@3.9.0:exact-candidate': 'passed',
      '@switchbot/openapi-cli@3.9.0:required-host': 'failed',
    });
    expect(requiredHostFailure.status).toBe(1);
    expect(() => readFileSync(npmLog, 'utf8')).toThrow();

    writeFileSync(outcomes, JSON.stringify({
      schemaVersion: 1,
      packages: PACKAGE_OUTCOMES.map((item) => item.name === '@switchbot/codex-plugin'
        ? { ...item, outcome: 'failed' }
        : item),
    }));
    const failedPlugin = runPromotion(required);
    expect(failedPlugin.status).toBe(1);
    expect(() => readFileSync(npmLog, 'utf8')).toThrow();
  });
});
