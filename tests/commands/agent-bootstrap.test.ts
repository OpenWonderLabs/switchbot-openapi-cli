import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { registerAgentBootstrapCommand } from '../../src/commands/agent-bootstrap.js';
import { resetListCache } from '../../src/devices/cache.js';
import { runCli } from '../helpers/cli.js';

async function captureJson(fn: () => void | Promise<void>): Promise<unknown> {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(lines.join('\n')) as unknown;
}

describe('agent-bootstrap', () => {
  const originalArgv = process.argv;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchbot-bootstrap-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    resetListCache();
    const cacheDir = path.join(tmpDir, '.switchbot');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, 'devices.json'),
      JSON.stringify({
        lastUpdated: new Date().toISOString(),
        devices: {
          ABC123: {
            type: 'Bot',
            name: 'Living Room Bot',
            category: 'physical',
            roomName: 'Living Room',
          },
        },
      }),
    );
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    resetListCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits a well-formed bootstrap payload with --compact', async () => {
    process.argv = ['node', 'cli', 'agent-bootstrap', '--compact', '--json'];
    const program = new Command();
    program.exitOverride();
    registerAgentBootstrapCommand(program);
    const payload = await captureJson(async () => {
      await program.parseAsync(['node', 'cli', 'agent-bootstrap', '--compact']);
    }) as { schemaVersion?: string; data?: Record<string, unknown> };
    expect(payload.schemaVersion).toBeDefined();
    const data = payload.data as Record<string, unknown>;
    expect(data.identity).toBeDefined();
    const identity = data.identity as Record<string, unknown>;
    expect(identity.product).toBe('SwitchBot');
    // v2.7.1: agent-bootstrap shares the canonical IDENTITY — carries apiDocs + productCategories.
    expect(identity.apiDocs).toMatch(/OpenWonderLabs/);
    expect(Array.isArray(identity.productCategories)).toBe(true);
    expect(data.safetyTiers).toBeDefined();
    expect(data.quickReference).toBeDefined();
    expect(Array.isArray(data.nameStrategies)).toBe(true);
    expect(data.nameStrategies).toEqual([
      'exact', 'prefix', 'substring', 'fuzzy', 'first', 'require-unique',
    ]);
    expect(Array.isArray(data.devices)).toBe(true);
    expect((data.devices as unknown[]).length).toBe(1);
    expect(data.catalog).toBeDefined();
    const catalog = data.catalog as { scope?: string; types?: unknown[] };
    expect(catalog.scope).toBe('used');
    expect(Array.isArray(catalog.types)).toBe(true);
  });

  it('stays below 20 KB on a small account with --compact', async () => {
    process.argv = ['node', 'cli', 'agent-bootstrap', '--compact', '--json'];
    const program = new Command();
    program.exitOverride();
    registerAgentBootstrapCommand(program);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    await program.parseAsync(['node', 'cli', 'agent-bootstrap', '--compact']);
    spy.mockRestore();
    const bytes = Buffer.byteLength(lines.join('\n'), 'utf8');
    expect(bytes).toBeLessThan(20_000);
  });

  it('quickReference surfaces every command group agents need', async () => {
    // Guard against future commands being added without being surfaced
    // here. If a new top-level command group is wired up (policy in
    // 2.8.0 was the last gap) it must appear in quickReference or
    // agents won't discover it from the compact bootstrap alone.
    process.argv = ['node', 'cli', 'agent-bootstrap', '--compact', '--json'];
    const program = new Command();
    program.exitOverride();
    registerAgentBootstrapCommand(program);
    const payload = await captureJson(async () => {
      await program.parseAsync(['node', 'cli', 'agent-bootstrap', '--compact']);
    }) as { data?: Record<string, unknown> };
    const data = payload.data as Record<string, unknown>;
    const quick = data.quickReference as Record<string, unknown>;
    const expectedKeys = [
      'discovery',
      'action',
      'safety',
      'observability',
      'history',
      'meta',
      'policy',
      'auth',
    ];
    for (const key of expectedKeys) {
      expect(quick[key], `quickReference.${key} is missing`).toBeDefined();
      expect(Array.isArray(quick[key]), `quickReference.${key} should be an array`).toBe(true);
      expect((quick[key] as unknown[]).length, `quickReference.${key} is empty`).toBeGreaterThan(0);
    }
    // policy specifically must mention the three subcommands
    expect(quick.policy).toEqual(
      expect.arrayContaining(['policy validate', 'policy new', 'policy migrate']),
    );
    // auth must surface the keychain entry point so agents discover it
    expect(quick.auth).toEqual(expect.arrayContaining(['auth keychain describe']));
  });

  it('exposes credentialsBackend { name, label, writable }', async () => {
    process.argv = ['node', 'cli', 'agent-bootstrap', '--compact', '--json'];
    const program = new Command();
    program.exitOverride();
    registerAgentBootstrapCommand(program);
    const payload = await captureJson(async () => {
      await program.parseAsync(['node', 'cli', 'agent-bootstrap', '--compact']);
    }) as { data?: Record<string, unknown> };
    const data = payload.data as Record<string, unknown>;
    const backend = data.credentialsBackend as Record<string, unknown>;
    expect(backend).toBeDefined();
    expect(backend.name).toMatch(/keychain|credman|secret-service|file/);
    expect(typeof backend.label).toBe('string');
    expect(typeof backend.writable).toBe('boolean');
  });

  it('policyStatus reports present:false when no policy file is configured', async () => {
    // Point at a path under tmpDir that intentionally doesn't exist.
    const policyPath = path.join(tmpDir, '.config', 'openclaw', 'switchbot', 'policy.yaml');
    process.env.SWITCHBOT_POLICY_PATH = policyPath;
    try {
      process.argv = ['node', 'cli', 'agent-bootstrap', '--compact', '--json'];
      const program = new Command();
      program.exitOverride();
      registerAgentBootstrapCommand(program);
      const payload = await captureJson(async () => {
        await program.parseAsync(['node', 'cli', 'agent-bootstrap', '--compact']);
      }) as { data?: Record<string, unknown> };
      const data = payload.data as Record<string, unknown>;
      const status = data.policyStatus as Record<string, unknown>;
      expect(status).toBeDefined();
      expect(status.present).toBe(false);
      expect(status.valid).toBeNull();
      expect(status.path).toBe(policyPath);
    } finally {
      delete process.env.SWITCHBOT_POLICY_PATH;
    }
  });

  it('policyStatus reports present:true + valid:false for a v0.1 file (unsupported in v3.0)', async () => {
    const policyDir = path.join(tmpDir, '.config', 'openclaw', 'switchbot');
    const policyPath = path.join(policyDir, 'policy.yaml');
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(policyPath, 'version: "0.1"\n');
    process.env.SWITCHBOT_POLICY_PATH = policyPath;
    try {
      process.argv = ['node', 'cli', 'agent-bootstrap', '--compact', '--json'];
      const program = new Command();
      program.exitOverride();
      registerAgentBootstrapCommand(program);
      const payload = await captureJson(async () => {
        await program.parseAsync(['node', 'cli', 'agent-bootstrap', '--compact']);
      }) as { data?: Record<string, unknown> };
      const data = payload.data as Record<string, unknown>;
      const status = data.policyStatus as Record<string, unknown>;
      expect(status.present).toBe(true);
      expect(status.valid).toBe(false);
      expect(status.errorCount).toBeGreaterThan(0);
    } finally {
      delete process.env.SWITCHBOT_POLICY_PATH;
    }
  });

  it('policyStatus reports present:true + valid:false + errorCount when schema rejects', async () => {
    const policyDir = path.join(tmpDir, '.config', 'openclaw', 'switchbot');
    const policyPath = path.join(policyDir, 'policy.yaml');
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(
      policyPath,
      'version: "0.1"\naliases:\n  "bedroom ac": "02-abc-lowercase"\n',
    );
    process.env.SWITCHBOT_POLICY_PATH = policyPath;
    try {
      process.argv = ['node', 'cli', 'agent-bootstrap', '--compact', '--json'];
      const program = new Command();
      program.exitOverride();
      registerAgentBootstrapCommand(program);
      const payload = await captureJson(async () => {
        await program.parseAsync(['node', 'cli', 'agent-bootstrap', '--compact']);
      }) as { data?: Record<string, unknown> };
      const data = payload.data as Record<string, unknown>;
      const status = data.policyStatus as Record<string, unknown>;
      expect(status.present).toBe(true);
      expect(status.valid).toBe(false);
      expect(status.errorCount).toBeGreaterThan(0);
    } finally {
      delete process.env.SWITCHBOT_POLICY_PATH;
    }
  });

  // =====================================================================
  // --sections flag (P1)
  // =====================================================================
  describe('agent-bootstrap --sections', () => {
    it('restricts output to the requested top-level keys', async () => {
      const res = await runCli(registerAgentBootstrapCommand, [
        'agent-bootstrap', '--sections', 'identity,cliVersion',
      ]);
      expect(res.exitCode).toBeNull();
      const out = JSON.parse(res.stdout.join('')) as { data: Record<string, unknown> };
      const keys = Object.keys(out.data);
      expect(keys).toContain('identity');
      expect(keys).toContain('cliVersion');
      expect(keys).not.toContain('catalog');
      expect(keys).not.toContain('hints');
      expect(keys).not.toContain('quota');
    });

    it('includes all keys when --sections is not provided', async () => {
      const res = await runCli(registerAgentBootstrapCommand, ['agent-bootstrap', '--compact']);
      const out = JSON.parse(res.stdout.join('')) as { data: Record<string, unknown> };
      expect(Object.keys(out.data)).toContain('catalog');
      expect(Object.keys(out.data)).toContain('hints');
    });

    it('exits 2 and prints hint when an unknown section name is requested', async () => {
      const res = await runCli(registerAgentBootstrapCommand, [
        'agent-bootstrap', '--sections', 'identity,doesNotExist',
      ]);
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('')).toMatch(/unknown section.*doesNotExist/i);
    });
  });
});
