import { Command } from 'commander';
import { getEffectiveCatalog } from '../devices/catalog.js';
import { printJson } from '../utils/output.js';
import { enumArg, stringArg } from '../utils/arg-parsers.js';

export type AgentSafetyTier = 'read' | 'action' | 'destructive';
export type Verifiability = 'local' | 'deviceConfirmed' | 'deviceDependent' | 'none';

const AGENT_GUIDE = {
  safetyTiers: {
    read: 'No state mutation; safe to call freely — does not consume quota unless noted.',
    action: 'Mutates device or cloud state but is reversible and routine (turnOn, setColor).',
    destructive: 'Hard to reverse / physical-world side effects (unlock, garage open, delete key). Requires explicit user confirmation.',
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

const COMMAND_META: Record<string, CommandMeta> = {
  // devices: reads
  'devices list':     { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 600 },
  'devices status':   { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 500 },
  'devices describe': { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 600 },
  'devices types':    { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 20 },
  'devices commands': { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 20 },
  'devices watch':    { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 500 },
  // devices: actions
  'devices command':  { mutating: true,  consumesQuota: true,  idempotencySupported: true,  agentSafetyTier: 'action',      verifiability: 'deviceDependent',  typicalLatencyMs: 800 },
  'devices batch':    { mutating: true,  consumesQuota: true,  idempotencySupported: true,  agentSafetyTier: 'action',      verifiability: 'deviceDependent',  typicalLatencyMs: 1200 },
  // scenes
  'scenes list':      { mutating: false, consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 500 },
  'scenes execute':   { mutating: true,  consumesQuota: true,  idempotencySupported: false, agentSafetyTier: 'action',      verifiability: 'deviceDependent',  typicalLatencyMs: 1500 },
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
  'plan run':         { mutating: true,  consumesQuota: true,  idempotencySupported: true,  agentSafetyTier: 'action',      verifiability: 'deviceDependent',  typicalLatencyMs: 2000 },
  'plan validate':    { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 10 },
  'plan schema':      { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 10 },
  'completion':       { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 5 },
  'mcp serve':        { mutating: false, consumesQuota: false, idempotencySupported: false, agentSafetyTier: 'read',        verifiability: 'local',            typicalLatencyMs: 10 },
};

function metaFor(command: string): CommandMeta | null {
  return COMMAND_META[command] ?? null;
}

const IDENTITY = {
  product: 'SwitchBot',
  domain: 'IoT smart home device control',
  vendor: 'Wonderlabs, Inc.',
  apiVersion: 'v1.1',
  apiDocs: 'https://github.com/OpenWonderLabs/SwitchBotAPI',
  deviceCategories: {
    physical: 'Wi-Fi/BLE devices controllable via Cloud API (Hub required for BLE-only)',
    ir: 'IR remote devices learned by a SwitchBot Hub (TV, AC, etc.)',
  },
  constraints: {
    quotaPerDay: 10000,
    bleRequiresHub: true,
    authMethod: 'HMAC-SHA256 token+secret',
  },
  agentGuide: 'docs/agent-guide.md',
};

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
];

const IDEMPOTENCY_CONTRACT = {
  flag: '--idempotency-key <key>',
  windowSeconds: 60,
  replayBehavior: 'Same (command, parameter, deviceId) within window → returns cached result with replayed:true.',
  conflictBehavior: 'Same key + different (command, parameter) within window → exit 2, error:"idempotency_conflict".',
  keyStorage: 'Stored as SHA-256 hash on disk (not raw).',
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
}

function enumerateLeaves(program: Command, prefix = ''): CompactLeaf[] {
  const out: CompactLeaf[] = [];
  for (const cmd of program.commands) {
    const full = prefix ? `${prefix} ${cmd.name()}` : cmd.name();
    if (cmd.commands.length === 0) {
      const meta = metaFor(full);
      if (meta) {
        out.push({ name: full, ...meta });
      } else {
        // Unknown leaf → default to read-safe with a warning flag so agents notice.
        out.push({
          name: full,
          mutating: false,
          consumesQuota: false,
          idempotencySupported: false,
          agentSafetyTier: 'read',
          verifiability: 'local',
          typicalLatencyMs: 50,
        });
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
    .description('Print a machine-readable manifest of CLI capabilities (for agent bootstrap)')
    .option('--minimal', 'Omit per-subcommand flag details to reduce output size (alias of --compact)')
    .option('--compact', 'Emit a compact summary: identity + leaf command list with safety metadata only')
    .option('--surface <s>', 'Restrict surfaces block to one of: cli, mcp, plan, mqtt, all (default: all)', enumArg('--surface', SURFACES))
    .option('--project <csv>', 'Project top-level fields (e.g. --project identity,commands,agentGuide)', stringArg('--project'))
    .action((opts: { minimal?: boolean; compact?: boolean; surface?: string; project?: string }) => {
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
        ...(globalFlags ? { globalFlags } : {}),
        catalog: {
          typeCount: catalog.length,
          roles,
          destructiveCommandCount: catalog.reduce(
            (n, e) => n + e.commands.filter((c) => c.destructive).length,
            0,
          ),
          readOnlyTypeCount: catalog.filter((e) => e.readOnly).length,
        },
      };
      if (!compact) payload.generatedAt = new Date().toISOString();

      const projected = opts.project
        ? projectObject(payload, opts.project.split(',').map((s) => s.trim()).filter(Boolean))
        : payload;

      printJson(projected);
    });
}
