import { Command } from 'commander';
import { enumArg, stringArg } from '../utils/arg-parsers.js';
import { printJson } from '../utils/output.js';
import { getEffectiveCatalog, type CommandSpec, type DeviceCatalogEntry } from '../devices/catalog.js';
import { loadCache } from '../devices/cache.js';

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

interface CompactSchemaEntry {
  type: string;
  category: 'physical' | 'ir';
  role: string | null;
  readOnly: boolean;
  commands: Array<{
    command: string;
    parameter: string;
    commandType: 'command' | 'customize';
    idempotent: boolean;
    destructive: boolean;
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

function toCompactEntry(e: DeviceCatalogEntry): CompactSchemaEntry {
  return {
    type: e.type,
    category: e.category,
    role: e.role ?? null,
    readOnly: e.readOnly ?? false,
    commands: e.commands.map((c) => ({
      command: c.command,
      parameter: c.parameter,
      commandType: (c.commandType ?? 'command') as 'command' | 'customize',
      idempotent: Boolean(c.idempotent),
      destructive: Boolean(c.destructive),
    })),
    statusFields: e.statusFields ?? [],
  };
}

function projectFields<T extends Record<string, unknown>>(entry: T, fields: string[]): Partial<T> {
  const out: Partial<T> = {};
  for (const f of fields) {
    if (f in entry) (out as Record<string, unknown>)[f] = entry[f];
  }
  return out;
}

export function registerSchemaCommand(program: Command): void {
  const ROLES = ['lighting', 'security', 'sensor', 'climate', 'media', 'cleaning', 'curtain', 'fan', 'power', 'hub', 'other'] as const;
  const CATEGORIES = ['physical', 'ir'] as const;
  const schema = program
    .command('schema')
    .description('Export the device catalog as structured JSON (for agent prompts / tooling)');

  schema
    .command('export')
    .description('Print the catalog as structured JSON (one object per type)')
    .option('--type <type>', 'Restrict to a single device type (e.g. "Strip Light")', stringArg('--type'))
    .option('--types <csv>', 'Restrict to multiple device types (comma-separated)', stringArg('--types'))
    .option('--role <role>', 'Restrict to a functional role: lighting, security, sensor, climate, media, cleaning, curtain, fan, power, hub, other', enumArg('--role', ROLES))
    .option('--category <cat>', 'Restrict to "physical" or "ir"', enumArg('--category', CATEGORIES))
    .option('--compact', 'Drop descriptions/aliases/example params — emit ~60% smaller payload. Useful for agent prompts.')
    .option('--used', 'Restrict to device types present in the local devices cache (run "devices list" first)')
    .option('--project <csv>', 'Project per-type fields (e.g. --project type,commands,statusFields)', stringArg('--project'))
    .addHelpText('after', `
Output is always JSON (this command ignores --format). The output is a
catalog export — not a formal JSON Schema standard document — suitable for
pre-baking LLM prompts or regenerating docs when the catalog changes.

Size tips:
  --compact --used          Smallest realistic payload for a given account
                            (< 15 KB on most accounts).
  --fields type,commands    Strip statusFields / role / etc. when only
                            commands are needed.
  --type + --compact        Inspect one type with minimum footprint.

Common top-level fields:
  schemaVersion             CLI schema version (stable for agent contracts)
  data.version              Catalog schema version
  data.types                Array of SchemaEntry (or CompactSchemaEntry with --compact)
  data._fetchedAt           CLI-added; present on live-query responses ('devices status'),
                            not on this offline export.

Examples:
  $ switchbot schema export > catalog.json
  $ switchbot schema export --compact --used | wc -c   # small prompt-ready payload
  $ switchbot schema export --type Bot | jq '.data.types[0].commands'
  $ switchbot schema export --types "Bot,Curtain,Color Bulb"
  $ switchbot schema export --role lighting | jq '[.data.types[].type]'
  $ switchbot schema export --role security --category physical
  $ switchbot schema export --project type,commands,statusFields
`)
    .action((options: { type?: string; types?: string; role?: string; category?: string; compact?: boolean; used?: boolean; project?: string }) => {
      const catalog = getEffectiveCatalog();
      let filtered = catalog;

      if (options.type) {
        const q = options.type.toLowerCase();
        filtered = filtered.filter((e) =>
          e.type.toLowerCase() === q ||
          (e.aliases ?? []).some((a) => a.toLowerCase() === q),
        );
      }
      if (options.types) {
        const set = new Set(options.types.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
        filtered = filtered.filter((e) =>
          set.has(e.type.toLowerCase()) ||
          (e.aliases ?? []).some((a) => set.has(a.toLowerCase())),
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
      if (options.used) {
        const cache = loadCache();
        if (cache) {
          const usedTypes = new Set(
            Object.values(cache.devices).map((d) => d.type.toLowerCase()),
          );
          filtered = filtered.filter((e) =>
            usedTypes.has(e.type.toLowerCase()) ||
            (e.aliases ?? []).some((a) => usedTypes.has(a.toLowerCase())),
          );
        } else {
          filtered = [];
        }
      }

      const mapped = options.compact
        ? filtered.map(toCompactEntry)
        : filtered.map(toSchemaEntry);

      const projected = options.project
        ? mapped.map((e) =>
            projectFields(e as unknown as Record<string, unknown>, options.project!.split(',').map((s) => s.trim()).filter(Boolean)),
          )
        : mapped;

      const payload: Record<string, unknown> = {
        version: '1.0',
        types: projected,
      };
      if (!options.compact) {
        payload.generatedAt = new Date().toISOString();
        payload.cliAddedFields = [
          {
            field: '_fetchedAt',
            appliesTo: ['devices status', 'devices describe'],
            type: 'string (ISO-8601)',
            description:
              'CLI-synthesized timestamp indicating when this status response was fetched or served from the cache. Not part of the upstream SwitchBot API.',
          },
          {
            field: 'replayed',
            appliesTo: ['devices command (with --idempotency-key)'],
            type: 'boolean',
            description:
              'CLI-synthesized flag — true when the response was served from the idempotency cache instead of re-executing the command.',
          },
          {
            field: 'verification',
            appliesTo: ['devices command'],
            type: 'object',
            description:
              'CLI-synthesized receipt-acknowledgment metadata. For IR devices, verifiable:false signals that no device-side confirmation is possible.',
          },
        ];
      }
      printJson(payload);
    });
}
