import { Command } from 'commander';
import {
  getEffectiveCatalog,
  deriveSafetyTier,
  deriveStatusQueries,
  type DeviceCatalogEntry,
  type SafetyTier,
} from '../devices/catalog.js';
import { RESOURCE_CATALOG } from '../devices/resources.js';
import { loadCache } from '../devices/cache.js';
import { printJson } from '../utils/output.js';
import { enumArg, stringArg } from '../utils/arg-parsers.js';
import { IDENTITY } from './identity.js';

/** Collect the distinct catalog safety tiers actually used across the given entries. Sorted. */
function collectSafetyTiersInUse(entries: DeviceCatalogEntry[]): SafetyTier[] {
  const seen = new Set<SafetyTier>();
  for (const e of entries) {
    for (const c of e.commands) {
      seen.add(deriveSafetyTier(c, e));
    }
    // P11: statusQueries contribute the 'read' tier.
    if (deriveStatusQueries(e).length > 0) {
      seen.add('read');
    }
  }
  return [...seen].sort();
}

/** P11: total number of read-only queries exposed across the catalog. */
function countStatusQueries(entries: DeviceCatalogEntry[]): number {
  return entries.reduce((n, e) => n + deriveStatusQueries(e).length, 0);
}

export type AgentSafetyTier = 'read' | 'action' | 'destructive';
export type Verifiability = 'local' | 'deviceConfirmed' | 'deviceDependent' | 'none';
export type RiskLevel = 'low' | 'medium' | 'high';
export type IdempotencyHint = 'safe' | 'caution' | 'non-idempotent';
export type RecommendedMode = 'direct' | 'plan' | 'review-before-execute';

const AGENT_GUIDE = {
  safetyTiers: {
    read: 'No state mutation; safe to call freely — does not consume quota unless noted.',
    action: 'Mutates device or cloud state but is reversible and routine (turnOn, setColor).',
    destructive: 'Hard to reverse / physical-world side effects (unlock, garage open, delete key). Requires explicit user confirmation.',
  },
  riskLevels: {
    low: 'Read-only or non-mutating. Safe to call autonomously.',
    medium: 'Mutates state (action tier). Prefer `plan` workflow. Reversible.',
    high: 'Destructive / hard-to-reverse. Must go through review-before-execute. Requires --yes or plan approval.',
  },
  recommendedModes: {
    direct: 'May be called directly without a plan step.',
    plan: 'Prefer batching in a plan for traceability and dry-run support.',
    'review-before-execute': 'Must be reviewed/approved before execution. Use `plan run --require-approval` or pass --yes interactively.',
  },
  verifiability: {
    local: 'Result is fully verifiable from the CLI return value itself.',
    deviceConfirmed: 'Device returns an ack with an observable state field.',
    deviceDependent: 'Verifiability depends on the specific device (IR is never verifiable).',
    none: 'No feedback — e.g. IR transmission. Pair with an external sensor to confirm.',
  },
};

// Per-command (CLI leaf) semantic safety metadata. Read by agents BEFORE
// constructing a plan so they can flag destructive steps or skip unnecessary
// quota-consumers on a dry-run.
interface CommandMeta {
  mutating: boolean;
  consumesQuota: boolean;
  idempotencySupported: boolean;
  agentSafetyTier: AgentSafetyTier;
  verifiability: Verifiability;
  typicalLatencyMs: number;
}

interface RiskMeta {
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  supportsDryRun: boolean;
  idempotencyHint: IdempotencyHint;
  recommendedMode: RecommendedMode;
}

function deriveRiskMeta(meta: CommandMeta): RiskMeta {
  const riskLevel: RiskLevel = meta.agentSafetyTier === 'destructive' ? 'high'
    : meta.agentSafetyTier === 'action' ? 'medium' : 'low';
  return {
    riskLevel,
    requiresConfirmation: meta.agentSafetyTier === 'destructive',
    supportsDryRun: meta.mutating,
    idempotencyHint: meta.idempotencySupported ? 'safe' : meta.mutating ? 'non-idempotent' : 'safe',
    recommendedMode: meta.agentSafetyTier === 'destructive' ? 'review-before-execute'
      : meta.agentSafetyTier === 'action' ? 'plan' : 'direct',
  };
}

const COMMAND_META: Record<string, CommandMeta> = {
  // devices: reads
  'devices list':     { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 600 },
  'devices status':   { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 500 },
  'devices describe': { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 600 },
  'devices types':    { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 20 },
  'devices commands': { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 20 },
  'devices watch':    { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 500 },
  // devices meta (local metadata — no quota, no API call)
  'devices meta set':   { mutating: true,  consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'action',    verifiability: 'local',            typicalLatencyMs: 5 },
  'devices meta get':   { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',      verifiability: 'local',            typicalLatencyMs: 5 },
  'devices meta list':  { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',      verifiability: 'local',            typicalLatencyMs: 5 },
  'devices meta clear': { mutating: true,  consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'action',    verifiability: 'local',            typicalLatencyMs: 5 },
  // devices: actions
  'devices command':  { mutating: true,  consumesQuota: true,  idempotencySupported: true,  agentSafetyTier: 'action',      verifiability: 'deviceDependent',  typicalLatencyMs: 800 },
  'devices batch':    { mutating: true,  consumesQuota: true,  idempotencySupported: true,  agentSafetyTier: 'action',      verifiability: 'deviceDependent',  typicalLatencyMs: 1200 },
  // scenes
  'scenes list':      { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 500 },
  'scenes execute':   { mutating: true,  consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'action',      verifiability: 'deviceDependent',  typicalLatencyMs: 1500 },
  'scenes describe':  { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 500 },
  // webhook
  'webhook setup':    { mutating: true,  consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'action',      verifiability: 'local',            typicalLatencyMs: 500 },
  'webhook query':    { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 500 },
  'webhook delete':   { mutating: true,  consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'destructive', verifiability: 'local',            typicalLatencyMs: 500 },
  // quota
  'quota status':     { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 10 },
  'quota show':       { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 10 },
  'quota reset':      { mutating: true,  consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'action',      verifiability: 'local',            typicalLatencyMs: 10 },
  // doctor / schema / capabilities / catalog / config / cache / events / history / plan
  'doctor':           { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 900 },
  'schema export':    { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 20 },
  'capabilities':     { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 15 },
  'catalog':          { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 15 },
  'config set-token': { mutating: true,  consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'destructive', verifiability: 'local',            typicalLatencyMs: 5 },
  'config show':      { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 5 },
  'config list-profiles': { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',    verifiability: 'local',            typicalLatencyMs: 5 },
  'cache status':     { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 5 },
  'cache clear':      { mutating: true,  consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'action',      verifiability: 'local',            typicalLatencyMs: 5 },
  'events mqtt-tail': { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 500 },
  'history show':     { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 20 },
  'history replay':   { mutating: true,  consumesQuota: true,  idempotencySupported: true,  agentSafetyTier: 'action',      verifiability: 'deviceDependent',  typicalLatencyMs: 1000 },
  'history range':    { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 50 },
  'history stats':    { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 20 },
  'history aggregate': { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 80 },
  'plan run':         { mutating: true,  consumesQuota: true,  idempotencySupported: true,  agentSafetyTier: 'action',      verifiability: 'deviceDependent',  typicalLatencyMs: 2000 },
  'plan validate':    { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 10 },
  'plan schema':      { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 10 },
  'completion':       { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 5 },
  'mcp serve':        { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 10 },
};

function metaFor(command: string): CommandMeta | null {
  return COMMAND_META[command] ?? null;
}

const MCP_TOOLS = [
  'list_devices',
  'get_device_status',
  'send_command',
  'describe_device',
  'list_scenes',
  'run_scene',
  'search_catalog',
  'account_overview',
  'get_device_history',
  'query_device_history',
  'aggregate_device_history',
];

const IDEMPOTENCY_CONTRACT = {
  flag: '--idempotency-key <key>',
  windowSeconds: 60,
  replayBehavior: 'Same (command, parameter, deviceId) within window → returns cached result with replayed:true.',
  conflictBehavior: 'Same key + different (command, parameter) within window → exit 2, error:"idempotency_conflict".',
  keyStorage: 'In-memory SHA-256 fingerprint; raw key never stored, no disk persistence.',
  scope: 'Process-local. Replay + conflict apply within a single long-lived process (MCP session, devices batch, plan run, history replay). Independent CLI invocations do NOT share cache — each fresh `node` process starts empty.',
  mcp: 'MCP send_command accepts the same idempotencyKey field with identical semantics.',
};

interface CompactLeaf {
  name: string;
  mutating: boolean;
  consumesQuota: boolean;
  idempotencySupported: boolean;
  agentSafetyTier: AgentSafetyTier;
  verifiability: Verifiability;
  typicalLatencyMs: number;
  riskLevel: RiskLevel;
  requiresConfirmation: boolean;
  supportsDryRun: boolean;
  idempotencyHint: IdempotencyHint;
  recommendedMode: RecommendedMode;
}

function enumerateLeaves(program: Command, prefix = ''): CompactLeaf[] {
  const out: CompactLeaf[] = [];
  for (const cmd of program.commands) {
    const full = prefix ? `${prefix} ${cmd.name()}` : cmd.name();
    if (cmd.commands.length === 0) {
      const meta = metaFor(full);
      if (meta) {
        out.push({ name: full, ...meta, ...deriveRiskMeta(meta) });
      } else {
        // Unknown leaf → default to read-safe with a warning flag so agents notice.
        const defaultMeta: CommandMeta = {
          mutating: false,
          consumesQuota: false,
          idempotencySupported: false,
          agentSafetyTier: 'read',
          verifiability: 'local',
          typicalLatencyMs: 50,
        };
        out.push({ name: full, ...defaultMeta, ...deriveRiskMeta(defaultMeta) });
      }
    } else {
      out.push(...enumerateLeaves(cmd, full));
    }
  }
  return out;
}

function projectObject<T extends Record<string, unknown>>(obj: T, fields: string[]): Partial<T> {
  const out: Partial<T> = {};
  for (const f of fields) {
    if (f in obj) (out as Record<string, unknown>)[f] = obj[f];
  }
  return out;
}

export function registerCapabilitiesCommand(program: Command): void {
  const SURFACES = ['cli', 'mcp', 'plan', 'mqtt', 'all'] as const;
  program
    .command('capabilities')
    .description('Print a machine-readable manifest of SwitchBot CLI capabilities (for AI agent bootstrap)')
    .option('--minimal', 'Omit per-subcommand flag details to reduce output size (alias of --compact)')
    .option('--compact', 'Emit a compact summary: identity + leaf command list with safety metadata only')
    .option('--used', 'Restrict the catalog summary to device types present in the local cache. Mirrors `schema export --used`.')
    .option('--surface <s>', 'Restrict surfaces block to one of: cli, mcp, plan, mqtt, all (default: all)', enumArg('--surface', SURFACES))
    .option('--project <csv>', 'Project top-level fields (e.g. --project identity,commands,agentGuide)', stringArg('--project'))
    .action((opts: { minimal?: boolean; compact?: boolean; used?: boolean; surface?: string; project?: string }) => {
      const compact = Boolean(opts.minimal || opts.compact);
      const catalog = getEffectiveCatalog();
      const leaves = enumerateLeaves(program);

      const fullCommands = compact
        ? undefined
        : [
            ...program.commands,
            { name: () => 'help', description: () => 'Display help for a command', commands: [], options: [], registeredArguments: [] } as unknown as Command,
          ].map((c) => {
            const full = c.name();
            const entry: Record<string, unknown> = {
              name: full,
              description: c.description(),
            };
            entry.subcommands = c.commands.map((s) => {
              const leafName = `${full} ${s.name()}`;
              const meta = metaFor(leafName);
              return {
                name: s.name(),
                description: s.description(),
                args: s.registeredArguments.map((a) => ({
                  name: a.name(),
                  required: a.required,
                  variadic: a.variadic,
                })),
                flags: s.options.map((o) => ({
                  flags: o.flags,
                  description: o.description,
                })),
                ...(meta ?? {}),
              };
            });
            const selfMeta = metaFor(full);
            if (selfMeta) Object.assign(entry, selfMeta);
            return entry;
          });

      const globalFlags = compact
        ? undefined
        : program.options.map((opt) => ({ flags: opt.flags, description: opt.description }));

      const surfaces = {
        mcp: {
          entry: 'mcp serve',
          protocol: 'stdio (default) or --port <n> for HTTP',
          tools: MCP_TOOLS,
          resources: ['switchbot://events'],
          toolMeta: 'Each MCP tool mirrors the CLI leaf command metadata (mutating, consumesQuota, agentSafetyTier, idempotencySupported).',
        },
        mqtt: {
          mode: 'consumer',
          authSource: 'SWITCHBOT_TOKEN + SWITCHBOT_SECRET (auto-provisioned via POST /v1.1/iot/credential)',
          cliCmd: 'events mqtt-tail',
          mcpResource: 'switchbot://events',
          protocol: 'MQTTS with TLS client certificates (AWS IoT)',
        },
        plan: {
          schemaCmd: 'plan schema',
          validateCmd: 'plan validate -',
          runCmd: 'plan run -',
        },
        cli: {
          catalogCmd: 'schema export',
          discoveryCmd: 'capabilities',
          healthCmd: 'doctor --json',
          healthCmdSchemaVersion: 1,
          helpFlag: '--help',
          idempotencyContract: IDEMPOTENCY_CONTRACT,
        },
      };

      const filteredSurfaces = (() => {
        if (!opts.surface || opts.surface === 'all') return surfaces;
        const picked: Record<string, unknown> = {};
        if (opts.surface in surfaces) {
          picked[opts.surface] = (surfaces as Record<string, unknown>)[opts.surface];
        }
        return picked;
      })();

      const roles = [...new Set(catalog.map((e) => e.role ?? 'other'))].sort();

      const payload: Record<string, unknown> = {
        version: program.version(),
        schemaVersion: '2',
        agentGuide: AGENT_GUIDE,
        identity: IDENTITY,
        surfaces: filteredSurfaces,
        commands: compact ? leaves : fullCommands,
        // Flat command → meta map keyed by full command path. Published in
        // addition to the tree (where every leaf `subcommands[*]` already
        // carries the same fields via spread) so agents can do O(1) lookup
        // without walking the tree. Includes derived risk metadata fields.
        commandMeta: Object.fromEntries(
          Object.entries(COMMAND_META).map(([k, v]) => [k, { ...v, ...deriveRiskMeta(v) }])
        ),
        ...(globalFlags ? { globalFlags } : {}),
        catalog: {
          typeCount: catalog.length,
          roles,
          destructiveCommandCount: catalog.reduce(
            (n, e) =>
              n + e.commands.filter((c) => deriveSafetyTier(c, e) === 'destructive').length,
            0,
          ),
          safetyTiersInUse: collectSafetyTiersInUse(catalog),
          readOnlyTypeCount: catalog.filter((e) => e.readOnly).length,
          readOnlyQueryCount: countStatusQueries(catalog),
        },
        resources: RESOURCE_CATALOG,
      };
      if (!compact) payload.generatedAt = new Date().toISOString();

      if (opts.used) {
        const cache = loadCache();
        if (!cache || Object.keys(cache.devices).length === 0) {
          // No cache → return the payload unchanged but add a `usedFilter` note
          // so agents know the filter was requested but noop'd.
          payload.usedFilter = { applied: false, reason: 'no local cache — run `switchbot devices list` first' };
        } else {
          const seen = new Set<string>();
          for (const id of Object.keys(cache.devices)) {
            const t = cache.devices[id].type;
            if (t) seen.add(t);
          }
          const filteredCatalog = catalog.filter((e) =>
            seen.has(e.type) || (e.aliases ?? []).some((a) => seen.has(a)),
          );
          payload.catalog = {
            typeCount: filteredCatalog.length,
            roles: [...new Set(filteredCatalog.map((e) => e.role ?? 'other'))].sort(),
            destructiveCommandCount: filteredCatalog.reduce(
              (n, e) =>
                n + e.commands.filter((c) => deriveSafetyTier(c, e) === 'destructive').length,
              0,
            ),
            safetyTiersInUse: collectSafetyTiersInUse(filteredCatalog),
            readOnlyTypeCount: filteredCatalog.filter((e) => e.readOnly).length,
            readOnlyQueryCount: countStatusQueries(filteredCatalog),
          };
          payload.usedFilter = { applied: true, typesInCache: [...seen].sort() };
        }
      }

      const projected = opts.project
        ? projectObject(payload, opts.project.split(',').map((s) => s.trim()).filter(Boolean))
        : payload;

      printJson(projected);
    });
}
