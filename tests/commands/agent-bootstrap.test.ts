import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Command } from 'commander';
import { registerAgentBootstrapCommand } from '../../src/commands/agent-bootstrap.js';
import { resetListCache } from '../../src/devices/cache.js';

function captureJson(fn: () => void): unknown {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    fn();
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

  it('emits a well-formed bootstrap payload with --compact', () => {
    process.argv = ['node', 'cli', 'agent-bootstrap', '--compact', '--json'];
    const program = new Command();
    program.exitOverride();
    registerAgentBootstrapCommand(program);
    const payload = captureJson(() => {
      program.parse(['node', 'cli', 'agent-bootstrap', '--compact']);
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

  it('stays below 20 KB on a small account with --compact', () => {
    process.argv = ['node', 'cli', 'agent-bootstrap', '--compact', '--json'];
    const program = new Command();
    program.exitOverride();
    registerAgentBootstrapCommand(program);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    program.parse(['node', 'cli', 'agent-bootstrap', '--compact']);
    spy.mockRestore();
    const bytes = Buffer.byteLength(lines.join('\n'), 'utf8');
    expect(bytes).toBeLessThan(20_000);
  });

  it('quickReference surfaces every command group agents need', () => {
    // Guard against future commands being added without being surfaced
    // here. If a new top-level command group is wired up (policy in
    // 2.8.0 was the last gap) it must appear in quickReference or
    // agents won't discover it from the compact bootstrap alone.
    process.argv = ['node', 'cli', 'agent-bootstrap', '--compact', '--json'];
    const program = new Command();
    program.exitOverride();
    registerAgentBootstrapCommand(program);
    const payload = captureJson(() => {
      program.parse(['node', 'cli', 'agent-bootstrap', '--compact']);
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
  });
});
