import { Command } from 'commander';
import { enumArg, stringArg } from '../utils/arg-parsers.js';
import { printJson } from '../utils/output.js';
import { getEffectiveCatalog, type CommandSpec, type DeviceCatalogEntry } from '../devices/catalog.js';

interface SchemaEntry {
  type: string;
  description: string;
  category: 'physical' | 'ir';
  aliases: string[];
  role: string | null;
  readOnly: boolean;
  commands: Array<{
    command: string;
    parameter: string;
    description: string;
    commandType: 'command' | 'customize';
    idempotent: boolean;
    destructive: boolean;
    exampleParams?: string[];
  }>;
  statusFields: string[];
}

function toSchemaEntry(e: DeviceCatalogEntry): SchemaEntry {
  return {
    type: e.type,
    description: e.description ?? '',
    category: e.category,
    aliases: e.aliases ?? [],
    role: e.role ?? null,
    readOnly: e.readOnly ?? false,
    commands: e.commands.map(toSchemaCommand),
    statusFields: e.statusFields ?? [],
  };
}

function toSchemaCommand(c: CommandSpec) {
  return {
    command: c.command,
    parameter: c.parameter,
    description: c.description,
    commandType: (c.commandType ?? 'command') as 'command' | 'customize',
    idempotent: Boolean(c.idempotent),
    destructive: Boolean(c.destructive),
    ...(c.exampleParams ? { exampleParams: c.exampleParams } : {}),
  };
}

export function registerSchemaCommand(program: Command): void {
  const ROLES = ['lighting', 'security', 'sensor', 'climate', 'media', 'cleaning', 'curtain', 'fan', 'power', 'hub', 'other'] as const;
  const CATEGORIES = ['physical', 'ir'] as const;
  const schema = program
    .command('schema')
    .description('Export the device catalog as structured JSON (for agent prompts / tooling)');

  schema
    .command('export')
    .description('Print the full catalog as structured JSON (one object per type)')
    .option('--type <type>', 'Restrict to a single device type (e.g. "Strip Light")', stringArg('--type'))
    .option('--role <role>', 'Restrict to a functional role: lighting, security, sensor, climate, media, cleaning, curtain, fan, power, hub, other', enumArg('--role', ROLES))
    .option('--category <cat>', 'Restrict to "physical" or "ir"', enumArg('--category', CATEGORIES))
    .addHelpText('after', `
Output is always JSON (this command ignores --format). The output is a
catalog export — not a formal JSON Schema standard document — suitable for
pre-baking LLM prompts or regenerating docs when the catalog changes.

Examples:
  $ switchbot schema export > catalog.json
  $ switchbot schema export --type Bot | jq '.types[0].commands'
  $ switchbot schema export --role lighting | jq '[.types[].type]'
  $ switchbot schema export --role security --category physical
`)
    .action((options: { type?: string; role?: string; category?: string }) => {
      const catalog = getEffectiveCatalog();
      let filtered = catalog;
      if (options.type) {
        const q = options.type.toLowerCase();
        filtered = filtered.filter((e) =>
          e.type.toLowerCase() === q ||
          (e.aliases ?? []).some((a) => a.toLowerCase() === q),
        );
      }
      if (options.role) {
        const q = options.role.toLowerCase();
        filtered = filtered.filter((e) => (e.role ?? 'other') === q);
      }
      if (options.category) {
        const q = options.category.toLowerCase();
        filtered = filtered.filter((e) => e.category === q);
      }
      const payload = {
        version: '1.0',
        generatedAt: new Date().toISOString(),
        types: filtered.map(toSchemaEntry),
      };
      printJson(payload);
    });
}
