import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

describe('release candidate promotion', () => {
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
    writeFileSync(outcomes, JSON.stringify({ schemaVersion: 1, packages: PACKAGE_OUTCOMES }));

    const promoted = runPromotion({
      ...required,
      '@switchbot/openapi-cli@3.9.0:exact-candidate': 'passed',
      '@switchbot/openapi-cli@3.9.0:required-host': 'passed',
    });
    expect(promoted.status).toBe(0);
    expect(JSON.parse(promoted.stdout)).toMatchObject({
      published: ['@switchbot/openapi-cli@3.9.0'],
      alreadyPublished: [
        '@switchbot/codex-plugin@0.2.0',
        '@switchbot/openclaw-skill@0.2.0',
        '@switchbot/claude-code-plugin@0.2.0',
        '@switchbot/gemini-extension@0.2.0',
      ],
    });
    expect(readFileSync(npmLog, 'utf8')).toBe('dist-tag add @switchbot/openapi-cli@3.9.0 latest\n');
  });
});
