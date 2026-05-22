import { describe, it, expect, vi } from 'vitest';

// ── mocks required for importing capabilities.ts and program-builder.ts ────────
const catalogMock = vi.hoisted(() => ({
  getEffectiveCatalog: vi.fn(() => []),
  deriveSafetyTier: vi.fn(() => 'action' as const),
  deriveStatusQueries: vi.fn(() => []),
  CATALOG_SCHEMA_VERSION: '1.0',
}));
const cacheMock = vi.hoisted(() => ({ loadCache: vi.fn(() => ({ list: [], status: {} })) }));
vi.mock('../../src/devices/catalog.js', () => catalogMock);
vi.mock('../../src/devices/cache.js', () => cacheMock);

import { COMMAND_META, enumerateLeafNames, registerCapabilitiesCommand } from '../../src/commands/capabilities.js';
import { buildProgram } from '../../src/program-builder.js';
import { runCli } from '../helpers/cli.js';
import { expectJsonEnvelopeContainingKeys } from '../helpers/contracts.js';

// MCP tool names and other prefixes that legitimately live in COMMAND_META
// but are NOT CLI leaf commands.
const NON_CLI_PREFIXES = [
  'list_', 'get_', 'send_', 'describe_', 'run_', 'search_',
  'account_', 'query_', 'aggregate_',
];

describe('COMMAND_META — exhaustive coverage guard', () => {
  // Derive ground truth from the real CLI program tree — no hardcoded list to maintain.
  // Adding a new command automatically propagates here; only COMMAND_META needs updating.
  const cliLeaves = new Set(enumerateLeafNames(buildProgram()));

  it('has an entry for every CLI leaf command', () => {
    const missing = [...cliLeaves].filter((cmd) => !(cmd in COMMAND_META));
    expect(missing, `COMMAND_META missing entries: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('does not have phantom entries for commands that do not exist', () => {
    const phantom = Object.keys(COMMAND_META).filter(
      (k) => !cliLeaves.has(k) && !NON_CLI_PREFIXES.some((p) => k.startsWith(p)),
    );
    expect(phantom, `Phantom COMMAND_META entries: ${phantom.join(', ')}`).toHaveLength(0);
  });
});

describe('capabilities command — regression output tests', () => {
  it('produces non-empty JSON output with --compact (regression: rules explain missing)', async () => {
    const res = await runCli(registerCapabilitiesCommand, ['capabilities', '--compact']);
    expect(res.exitCode).toBeNull();
    expect(res.stderr.join('')).not.toMatch(/coverage error/i);
    const out = res.stdout.join('');
    expect(out.length).toBeGreaterThan(50);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(parsed, [
      'schemaVersion',
      'agentGuide',
      'identity',
      'surfaces',
      'commands',
      'commandMeta',
      'resources',
    ]) as { commands: Array<{ name: string }> };
    expect(data.commands).toBeDefined();
  });

  it('COMMAND_META has rules explain entry with READ_LOCAL tier', () => {
    const entry = COMMAND_META['rules explain'];
    expect(entry, 'COMMAND_META missing rules explain').toBeDefined();
    expect(entry.agentSafetyTier).toBe('read');
    expect(entry.mutating).toBe(false);
    expect(entry.consumesQuota).toBe(false);
  });

  it('full output catalog is a pointer note referencing schema export', async () => {
    const res = await runCli(registerCapabilitiesCommand, ['capabilities']);
    expect(res.exitCode).toBeNull();
    const parsed = JSON.parse(res.stdout.join('')) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(parsed, [
      'schemaVersion',
      'agentGuide',
      'identity',
      'surfaces',
      'commands',
      'commandMeta',
      'globalFlags',
      'catalog',
      'resources',
      'generatedAt',
    ]) as { catalog?: { note: string } };
    const catalog = data.catalog;
    expect(catalog).toBeDefined();
    expect(catalog).toHaveProperty('note');
    expect(catalog!.note).toContain('schema export');
  });
});
