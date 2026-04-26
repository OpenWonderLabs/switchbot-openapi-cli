import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

// Catalog and cache are imported transitively by many register*Command calls;
// mock them so the registration does not try to load real files.
const catalogMock = vi.hoisted(() => ({
  getEffectiveCatalog: vi.fn(() => []),
  deriveSafetyTier: vi.fn(() => 'action' as const),
  deriveStatusQueries: vi.fn(() => []),
  findCatalogEntry: vi.fn(() => null),
}));
const cacheMock = vi.hoisted(() => ({
  loadCache: vi.fn(() => ({ list: [], status: {} })),
}));
vi.mock('../../src/devices/catalog.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/devices/catalog.js')>();
  return { ...actual, ...catalogMock };
});
vi.mock('../../src/devices/cache.js', async (importActual) => {
  const actual = await importActual<typeof import('../../src/devices/cache.js')>();
  return { ...actual, ...cacheMock };
});

// This test is the regression guard for v3.3.1 where `mcp tools` and
// `mcp list-tools` were registered in mcp.ts but not added to COMMAND_META.
// The coverage check inside `capabilities` only fires when the FULL program
// (every register*Command) has been wired up — the existing unit tests only
// registered `capabilities` itself, so the missing entries slipped past CI.
// This test registers every top-level command the real CLI registers, then
// invokes `capabilities` so `validateCommandMetaCoverage` sees the whole tree.

// Imports are awaited sequentially rather than in Promise.all — on Windows
// under vitest, a 25-way Promise.all of dynamic imports of ESM modules (each
// with its own transitive chain) starves the import queue and wedges for >30s.
// Serial imports finish in ~1.5s.
async function buildFullProgram(): Promise<Command> {
  const program = new Command();
  // Mirror src/index.ts registration order.
  const modules: Array<[string, string]> = [
    ['../../src/commands/config.js', 'registerConfigCommand'],
    ['../../src/commands/devices.js', 'registerDevicesCommand'],
    ['../../src/commands/scenes.js', 'registerScenesCommand'],
    ['../../src/commands/webhook.js', 'registerWebhookCommand'],
    ['../../src/commands/completion.js', 'registerCompletionCommand'],
    ['../../src/commands/mcp.js', 'registerMcpCommand'],
    ['../../src/commands/quota.js', 'registerQuotaCommand'],
    ['../../src/commands/catalog.js', 'registerCatalogCommand'],
    ['../../src/commands/cache.js', 'registerCacheCommand'],
    ['../../src/commands/events.js', 'registerEventsCommand'],
    ['../../src/commands/doctor.js', 'registerDoctorCommand'],
    ['../../src/commands/schema.js', 'registerSchemaCommand'],
    ['../../src/commands/history.js', 'registerHistoryCommand'],
    ['../../src/commands/plan.js', 'registerPlanCommand'],
    ['../../src/commands/capabilities.js', 'registerCapabilitiesCommand'],
    ['../../src/commands/agent-bootstrap.js', 'registerAgentBootstrapCommand'],
    ['../../src/commands/policy.js', 'registerPolicyCommand'],
    ['../../src/commands/rules.js', 'registerRulesCommand'],
    ['../../src/commands/auth.js', 'registerAuthCommand'],
    ['../../src/commands/install.js', 'registerInstallCommand'],
    ['../../src/commands/uninstall.js', 'registerUninstallCommand'],
    ['../../src/commands/status-sync.js', 'registerStatusSyncCommand'],
    ['../../src/commands/health.js', 'registerHealthCommand'],
    ['../../src/commands/upgrade-check.js', 'registerUpgradeCheckCommand'],
    ['../../src/commands/daemon.js', 'registerDaemonCommand'],
  ];
  for (const [modPath, fnName] of modules) {
    const mod = (await import(modPath)) as Record<string, (p: Command) => void>;
    mod[fnName](program);
  }
  program.exitOverride();
  return program;
}

describe('capabilities coverage against the fully-registered CLI', () => {
  it(
    'validateCommandMetaCoverage passes for every leaf command in the real program',
    { timeout: 30_000 },
    async () => {
      const program = await buildFullProgram();
      const stdout: string[] = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        stdout.push(args.map(String).join(' '));
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`__exit__:${code}`);
      }) as never);
      try {
        await program.parseAsync(['node', 'switchbot', 'capabilities', '--compact']);
      } finally {
        logSpy.mockRestore();
        exitSpy.mockRestore();
      }
      const out = stdout.join('');
      expect(out.length).toBeGreaterThan(50);
      const parsed = JSON.parse(out) as { data?: { commands?: Array<{ name: string }> } };
      expect(parsed.data).toBeDefined();
      expect(parsed.data!.commands).toBeDefined();
      // Sanity: the coverage check would have thrown before printJson ran,
      // so reaching this line already proves every leaf has COMMAND_META.
    },
  );
});
