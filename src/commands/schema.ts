import { Command } from 'commander';
import { printJson, isJsonMode } from '../utils/output.js';
import { getEffectiveCatalog, type CommandSpec, type DeviceCatalogEntry } from '../devices/catalog.js';

interface SchemaEntry {
  type: string;
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
  const schema = program
    .command('schema')
    .description('Dump the device catalog as machine-readable JSON Schema (for agent prompt / docs)');

  schema
    .command('export')
    .description('Print the full catalog as JSON (one object per type)')
    .option('--type <type>', 'Restrict to a single type (e.g. "Strip Light")')
    .addHelpText('after', `
Output is always JSON (this command ignores --format). Use 'schema export' to
pre-bake a prompt for an LLM, or to regenerate docs when the catalog bumps.

Examples:
  $ switchbot schema export > catalog.json
  $ switchbot schema export --type Bot | jq '.types[0].commands'
`)
    .action((options: { type?: string }) => {
      const catalog = getEffectiveCatalog();
      const filtered = options.type
        ? catalog.filter((e) =>
            e.type.toLowerCase() === options.type!.toLowerCase() ||
            (e.aliases ?? []).some((a) => a.toLowerCase() === options.type!.toLowerCase()),
          )
        : catalog;
      const payload = {
        version: '1.0',
        generatedAt: new Date().toISOString(),
        types: filtered.map(toSchemaEntry),
      };
      // Always JSON — schema export without JSON would be a category error.
      if (isJsonMode()) {
        printJson(payload);
      } else {
        console.log(JSON.stringify(payload, null, 2));
      }
    });
}
