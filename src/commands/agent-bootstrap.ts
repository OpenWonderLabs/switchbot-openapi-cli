import { Command } from 'commander';
import { printJson } from '../utils/output.js';
import { loadCache } from '../devices/cache.js';
import {
  getEffectiveCatalog,
  deriveSafetyTier,
  CATALOG_SCHEMA_VERSION,
} from '../devices/catalog.js';
import { readProfileMeta } from '../config.js';
import { todayUsage, DAILY_QUOTA } from '../utils/quota.js';
import { ALL_STRATEGIES } from '../utils/name-resolver.js';
import { IDENTITY } from './identity.js';
import {
  resolvePolicyPath,
  loadPolicyFile,
  PolicyFileNotFoundError,
  PolicyYamlParseError,
} from '../policy/load.js';
import { validateLoadedPolicy } from '../policy/validate.js';
import { selectCredentialStore, CredentialBackendName } from '../credentials/keychain.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version: pkgVersion } = require('../../package.json') as { version: string };

/**
 * Schema version of the agent-bootstrap payload. Must stay in lockstep
 * with the catalog schema — bootstrap consumers (AI agents) reason about
 * catalog-derived fields (safetyTier, destructive flag), so a drift
 * between the two would silently break their assumptions. `doctor`
 * fails the `catalog-schema` check when these differ.
 */
export const AGENT_BOOTSTRAP_SCHEMA_VERSION = CATALOG_SCHEMA_VERSION;

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
  meta: ['devices meta set <id> --alias <name>', 'devices meta list', 'devices meta get <id>'],
  policy: ['policy validate', 'policy new', 'policy migrate'],
  auth: ['auth keychain describe', 'auth keychain migrate', 'auth keychain get'],
};

interface PolicyStatus {
  present: boolean;
  valid: boolean | null;
  path: string;
  schemaVersion?: string;
  errorCount?: number;
}

function readPolicyStatus(): PolicyStatus {
  // Lightweight read — used by the bootstrap payload so agents know whether
  // a policy file exists and is healthy without shelling out to
  // `switchbot policy validate`. Parallel to `checkPolicy` in doctor but
  // returns a more compact shape (no first-error drill-down; agents who
  // want that run the dedicated command).
  const policyPath = resolvePolicyPath();
  try {
    const loaded = loadPolicyFile(policyPath);
    const result = validateLoadedPolicy(loaded);
    return {
      present: true,
      valid: result.valid,
      path: policyPath,
      schemaVersion: result.schemaVersion,
      errorCount: result.valid ? 0 : result.errors.length,
    };
  } catch (err) {
    if (err instanceof PolicyFileNotFoundError) {
      return { present: false, valid: null, path: policyPath };
    }
    if (err instanceof PolicyYamlParseError) {
      return { present: true, valid: false, path: policyPath, errorCount: 1 };
    }
    return { present: false, valid: null, path: policyPath };
  }
}

interface CredentialsBackend {
  name: CredentialBackendName;
  label: string;
  writable: boolean;
}

async function readCredentialsBackend(): Promise<CredentialsBackend> {
  try {
    const store = await selectCredentialStore();
    const desc = store.describe();
    return { name: store.name, label: desc.backend, writable: desc.writable };
  } catch {
    return { name: 'file', label: 'File (~/.switchbot/config.json)', writable: true };
  }
}

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
    .action(async (opts: BootstrapOptions) => {
      const compact = Boolean(opts.compact);
      const cache = loadCache();
      const catalog = getEffectiveCatalog();
      const usage = todayUsage();
      const meta = readProfileMeta(undefined);
      const credentialsBackend = await readCredentialsBackend();

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
          commands: e.commands.map((c) => {
            const tier = deriveSafetyTier(c, e);
            return {
              command: c.command,
              parameter: c.parameter,
              safetyTier: tier,
              destructive: tier === 'destructive',
              idempotent: Boolean(c.idempotent),
            };
          }),
          statusFields: e.statusFields ?? [],
        };
      });

      const payload: Record<string, unknown> = {
        schemaVersion: AGENT_BOOTSTRAP_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        cliVersion: pkgVersion,
        identity: IDENTITY,
        quickReference: QUICK_REFERENCE,
        safetyTiers: SAFETY_TIERS,
        nameStrategies: [...ALL_STRATEGIES],
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
        policyStatus: readPolicyStatus(),
        credentialsBackend,
        devices: cachedDevices,
        catalog: {
          scope: cachedDevices.length > 0 ? 'used' : 'all',
          types: catalogTypes,
        },
        // hints: empty array means no hints to report; always emitted, never null.
        // An empty array signals "nothing to act on" — agents should not treat
        // it as a disabled or missing field.
        hints: cachedDevices.length === 0
          ? ['Run `switchbot devices list` once to populate the device cache for richer bootstrap output.']
          : [],
      };

      printJson(payload);
    });
}
