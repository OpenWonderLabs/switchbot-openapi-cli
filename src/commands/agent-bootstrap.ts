import { Command } from 'commander';
import { printJson } from '../utils/output.js';
import { loadCache } from '../devices/cache.js';
import { getEffectiveCatalog } from '../devices/catalog.js';
import { readProfileMeta } from '../config.js';
import { todayUsage, DAILY_QUOTA } from '../utils/quota.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require('../../package.json') as { version: string };

const IDENTITY = {
  product: 'SwitchBot',
  domain: 'IoT smart home device control',
  vendor: 'Wonderlabs, Inc.',
  apiVersion: 'v1.1',
  authMethod: 'HMAC-SHA256 token+secret',
};

const SAFETY_TIERS = {
  read: 'No state mutation; safe to call freely.',
  action: 'Mutates device/cloud state but reversible (turnOn, setColor).',
  destructive: 'Hard to reverse / physical-world side effects (unlock). Requires confirmation.',
};

const QUICK_REFERENCE = {
  discovery: ['devices list', 'devices describe <id>', 'devices status <id>'],
  action: ['devices command <id> <cmd>', 'devices command --name <q> <cmd>', 'scenes execute <id>'],
  safety: ['--dry-run', '--idempotency-key <k>', '--audit-log', '--no-quota'],
  observability: ['doctor --json', 'quota status', 'cache status', 'events mqtt-tail'],
  history: ['history range <id> --since 7d', 'history stats <id>'],
};

interface BootstrapOptions {
  compact?: boolean;
}

export function registerAgentBootstrapCommand(program: Command): void {
  program
    .command('agent-bootstrap')
    .description(
      'Print a compact, aggregate JSON snapshot for agent onboarding — combines identity, cached devices, catalog summary, quota usage, and profile in a single call. Offline-safe; does not hit the API.',
    )
    .option(
      '--compact',
      'Emit an even smaller payload by dropping catalog descriptions and non-essential fields (target: <20 KB).',
    )
    .addHelpText(
      'after',
      `
Output is always JSON (this command ignores --format). It is a one-shot
orientation document for an agent/LLM to understand what's available without
spending quota. It reads from local cache (devices + quota + profile) and the
bundled catalog — no network calls.

For fresher device state, have the agent follow up with:
  $ switchbot devices list --json               # refreshes cache
  $ switchbot devices status <id> --json

Examples:
  $ switchbot agent-bootstrap --compact | wc -c   # fit in agent context window
  $ switchbot agent-bootstrap | jq '.devices | length'
  $ switchbot agent-bootstrap --compact | jq '.quickReference'
`,
    )
    .action((opts: BootstrapOptions) => {
      const compact = Boolean(opts.compact);
      const cache = loadCache();
      const catalog = getEffectiveCatalog();
      const usage = todayUsage();
      const meta = readProfileMeta(undefined);

      const cachedDevices = cache
        ? Object.entries(cache.devices).map(([id, d]) => ({
            deviceId: id,
            type: d.type,
            name: d.name,
            category: d.category,
            roomName: d.roomName ?? null,
          }))
        : [];

      const usedTypes = new Set(cachedDevices.map((d) => d.type.toLowerCase()));
      const relevantCatalog = cachedDevices.length > 0
        ? catalog.filter(
            (e) =>
              usedTypes.has(e.type.toLowerCase()) ||
              (e.aliases ?? []).some((a) => usedTypes.has(a.toLowerCase())),
          )
        : catalog;

      const catalogTypes = relevantCatalog.map((e) => {
        if (compact) {
          return {
            type: e.type,
            category: e.category,
            role: e.role ?? null,
            readOnly: e.readOnly ?? false,
            commands: e.commands.map((c) => c.command),
            statusFields: e.statusFields ?? [],
          };
        }
        return {
          type: e.type,
          category: e.category,
          role: e.role ?? null,
          readOnly: e.readOnly ?? false,
          commands: e.commands.map((c) => ({
            command: c.command,
            parameter: c.parameter,
            destructive: Boolean(c.destructive),
            idempotent: Boolean(c.idempotent),
          })),
          statusFields: e.statusFields ?? [],
        };
      });

      const payload: Record<string, unknown> = {
        schemaVersion: '1.0',
        generatedAt: new Date().toISOString(),
        cliVersion: pkgVersion,
        identity: IDENTITY,
        quickReference: QUICK_REFERENCE,
        safetyTiers: SAFETY_TIERS,
        profile: meta
          ? {
              label: meta.label ?? null,
              description: meta.description ?? null,
              dailyCap: meta.limits?.dailyCap ?? null,
              defaultFlags: meta.defaults?.flags ?? null,
            }
          : null,
        quota: {
          date: usage.date,
          total: usage.total,
          remaining: usage.remaining,
          dailyLimit: DAILY_QUOTA,
        },
        devices: cachedDevices,
        catalog: {
          scope: cachedDevices.length > 0 ? 'used' : 'all',
          types: catalogTypes,
        },
        hints: cachedDevices.length === 0
          ? ['Run `switchbot devices list` once to populate the device cache for richer bootstrap output.']
          : [],
      };

      printJson(payload);
    });
}
