import { Command } from 'commander';
import { getEffectiveCatalog } from '../devices/catalog.js';

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
];

export function registerCapabilitiesCommand(program: Command): void {
  program
    .command('capabilities')
    .description('Print a machine-readable manifest of CLI capabilities (for agent bootstrap)')
    .action(() => {
      const catalog = getEffectiveCatalog();
      const commands = program.commands
        .filter((c) => c.name() !== 'capabilities')
        .map((c) => ({
          name: c.name(),
          description: c.description(),
          subcommands: c.commands.map((s) => ({
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
          })),
        }));
      const globalFlags = program.options.map((opt) => ({
        flags: opt.flags,
        description: opt.description,
      }));
      const roles = [...new Set(catalog.map((e) => e.role ?? 'other'))].sort();
      console.log(
        JSON.stringify(
          {
            version: program.version(),
            generatedAt: new Date().toISOString(),
            identity: IDENTITY,
            surfaces: {
              mcp: {
                entry: 'mcp serve',
                protocol: 'stdio (default) or --port <n> for HTTP',
                tools: MCP_TOOLS,
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
          },
          null,
          2,
        ),
      );
    });
}
