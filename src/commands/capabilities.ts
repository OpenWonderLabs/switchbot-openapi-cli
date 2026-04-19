import { Command } from 'commander';
import { getEffectiveCatalog } from '../devices/catalog.js';
import { printJson } from '../utils/output.js';

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
];

export function registerCapabilitiesCommand(program: Command): void {
  program
    .command('capabilities')
    .description('Print a machine-readable manifest of CLI capabilities (for agent bootstrap)')
    .option('--minimal', 'Omit per-subcommand flag details to reduce output size')
    .action((opts: { minimal?: boolean }) => {
      const catalog = getEffectiveCatalog();
      const allCommands = [
        ...program.commands,
        // Commander adds 'help' implicitly; include it explicitly so it appears in the manifest
        { name: () => 'help', description: () => 'Display help for a command', commands: [], options: [], registeredArguments: [] } as unknown as Command,
      ];
      const commands = allCommands.map((c) => {
        const entry: Record<string, unknown> = {
          name: c.name(),
          description: c.description(),
        };
        if (!opts.minimal) {
          entry.subcommands = c.commands.map((s) => ({
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
          }));
        }
        return entry;
      });
      const globalFlags = program.options.map((opt) => ({
        flags: opt.flags,
        description: opt.description,
      }));
      const roles = [...new Set(catalog.map((e) => e.role ?? 'other'))].sort();
      printJson({
        version: program.version(),
        generatedAt: new Date().toISOString(),
        identity: IDENTITY,
        surfaces: {
          mcp: {
            entry: 'mcp serve',
            protocol: 'stdio (default) or --port <n> for HTTP',
            tools: MCP_TOOLS,
            resources: ['switchbot://events'],
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
            helpFlag: '--help',
          },
        },
        commands,
        globalFlags,
        catalog: {
          typeCount: catalog.length,
          roles,
          destructiveCommandCount: catalog.reduce(
            (n, e) => n + e.commands.filter((c) => c.destructive).length,
            0,
          ),
          readOnlyTypeCount: catalog.filter((e) => e.readOnly).length,
        },
      });
    });
}
