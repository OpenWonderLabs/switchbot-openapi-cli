import { describe, it, expect, vi } from 'vitest';

// ── mocks required for importing capabilities.ts ────────────────────────────
const catalogMock = vi.hoisted(() => ({
  getEffectiveCatalog: vi.fn(() => []),
  deriveSafetyTier: vi.fn(() => 'action' as const),
  deriveStatusQueries: vi.fn(() => []),
}));
const cacheMock = vi.hoisted(() => ({ loadCache: vi.fn(() => ({ list: [], status: {} })) }));
vi.mock('../../src/devices/catalog.js', () => catalogMock);
vi.mock('../../src/devices/cache.js', () => cacheMock);

import { COMMAND_META } from '../../src/commands/capabilities.js';
import { registerCapabilitiesCommand } from '../../src/commands/capabilities.js';
import { runCli } from '../helpers/cli.js';

// ── comprehensive list of every CLI leaf command ──────────────────────────────
// Regression guard: when a new subcommand is added to the CLI, it MUST be added
// here AND to COMMAND_META. If either is missing, this test fails with a clear
// "missing: <name>" message.
const ALL_EXPECTED_LEAF_COMMANDS = [
  'agent-bootstrap',
  'auth keychain describe', 'auth keychain get', 'auth keychain set',
  'auth keychain delete', 'auth keychain migrate',
  'cache show', 'cache clear',
  'capabilities',
  'catalog path', 'catalog show', 'catalog search', 'catalog diff', 'catalog refresh',
  'completion',
  'config set-token', 'config show', 'config list-profiles', 'config agent-profile',
  'daemon start', 'daemon stop', 'daemon status', 'daemon reload',
  'devices list', 'devices status', 'devices command', 'devices types',
  'devices commands', 'devices describe', 'devices batch', 'devices watch',
  'devices explain', 'devices expand',
  'devices meta set', 'devices meta get', 'devices meta list', 'devices meta clear',
  'doctor',
  'events tail', 'events mqtt-tail',
  'health check', 'health serve',
  'history show', 'history replay', 'history range', 'history stats',
  'history verify', 'history aggregate',
  'install',
  'mcp serve',
  'plan schema', 'plan validate', 'plan suggest', 'plan run',
  'plan save', 'plan list', 'plan review', 'plan approve', 'plan execute',
  'policy validate', 'policy new', 'policy migrate', 'policy diff',
  'policy add-rule', 'policy backup', 'policy restore',
  'quota status', 'quota reset',
  'rules suggest', 'rules lint', 'rules list', 'rules run', 'rules reload',
  'rules tail', 'rules replay', 'rules webhook-rotate-token', 'rules webhook-show-token',
  'rules conflicts', 'rules doctor', 'rules summary', 'rules last-fired',
  'rules explain',
  'schema export',
  'scenes list', 'scenes execute', 'scenes describe',
  'scenes validate', 'scenes simulate', 'scenes explain',
  'status-sync run', 'status-sync start', 'status-sync stop', 'status-sync status',
  'uninstall',
  'upgrade-check',
  'webhook setup', 'webhook query', 'webhook update', 'webhook delete',
] as const;

// MCP tool names and other prefixes that legitimately live in COMMAND_META
// but are NOT CLI leaf commands.
const NON_CLI_PREFIXES = [
  'list_', 'get_', 'send_', 'describe_', 'run_', 'search_',
  'account_', 'query_', 'aggregate_',
];

describe('COMMAND_META — exhaustive coverage guard', () => {
  it('has an entry for every known CLI leaf command', () => {
    const missing = ALL_EXPECTED_LEAF_COMMANDS.filter((cmd) => !(cmd in COMMAND_META));
    expect(missing, `COMMAND_META missing entries: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('does not have phantom entries for commands that do not exist', () => {
    const knownSet = new Set<string>(ALL_EXPECTED_LEAF_COMMANDS);
    const phantom = Object.keys(COMMAND_META).filter(
      (k) => !knownSet.has(k) && !NON_CLI_PREFIXES.some((p) => k.startsWith(p)),
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
    const parsed = JSON.parse(out) as { data: { commands: Array<{ name: string }> } };
    expect(parsed).toHaveProperty('data');
    expect(parsed.data).toHaveProperty('commands');
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
    const parsed = JSON.parse(res.stdout.join('')) as { data: { catalog?: { note: string } } };
    const catalog = parsed.data.catalog;
    expect(catalog).toBeDefined();
    expect(catalog).toHaveProperty('note');
    expect(catalog!.note).toContain('schema export');
  });
});
