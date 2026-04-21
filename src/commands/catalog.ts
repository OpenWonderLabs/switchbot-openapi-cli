import { Command } from 'commander';
import { enumArg } from '../utils/arg-parsers.js';
import { printTable, printJson, isJsonMode, handleError, UsageError } from '../utils/output.js';
import { resolveFormat, resolveFields, renderRows } from '../utils/format.js';
import {
  DEVICE_CATALOG,
  findCatalogEntry,
  getCatalogOverlayPath,
  getEffectiveCatalog,
  loadCatalogOverlay,
  resetCatalogOverlayCache,
  deriveSafetyTier,
  type DeviceCatalogEntry,
} from '../devices/catalog.js';

export function registerCatalogCommand(program: Command): void {
  const SOURCES = ['built-in', 'overlay', 'effective'] as const;
  const catalog = program
    .command('catalog')
    .description('Inspect the built-in device catalog and any local overlay')
    .addHelpText('after', `
This CLI ships with a static catalog of known SwitchBot device types and
their commands (see 'switchbot devices types'). You can extend or override
it locally by dropping a JSON array at:

  ~/.switchbot/catalog.json

Overlay rules (applied in order):
  • Entry whose "type" matches a built-in replaces that entry's fields
    (partial merge — overlay keys win, missing keys fall back to built-in).
  • Entry with a new "type" is appended. New entries MUST supply both
    "category" and "commands"; otherwise they are ignored silently.
  • Entry like { "type": "X", "remove": true } deletes the built-in "X".

Subcommands:
  path        Print the overlay file path and whether it exists
  show        Show the effective catalog (or one entry).  Alias: list
  list        Alias of show (matches the muscle-memory spelling)
  search      Fuzzy search types/aliases/roles/commands for a keyword
  diff        Show what the overlay changes vs the built-in catalog
  refresh     Re-read the overlay file (clears in-process cache)

Examples:
  $ switchbot catalog path
  $ switchbot catalog list
  $ switchbot catalog show
  $ switchbot catalog show "Smart Lock"
  $ switchbot catalog search Hub
  $ switchbot catalog show --source built-in
  $ switchbot catalog diff
  $ switchbot catalog refresh
`);

  catalog
    .command('path')
    .description('Print the overlay file path and whether it exists')
    .action(() => {
      const overlay = loadCatalogOverlay();
      if (isJsonMode()) {
        printJson({
          path: overlay.path,
          exists: overlay.exists,
          valid: overlay.error === undefined,
          error: overlay.error,
          entryCount: overlay.entries.length,
        });
        return;
      }
      console.log(`Overlay path: ${overlay.path}`);
      console.log(`Exists:       ${overlay.exists ? 'yes' : 'no'}`);
      if (overlay.exists) {
        if (overlay.error) {
          console.log(`Status:       invalid — ${overlay.error}`);
        } else {
          console.log(`Status:       valid (${overlay.entries.length} entr${overlay.entries.length === 1 ? 'y' : 'ies'})`);
        }
      } else {
        console.log(`(Create the file to extend the built-in catalog — see 'switchbot catalog --help'.)`);
      }
    });

  catalog
    .command('show')
    .alias('list')
    .description("Show the effective catalog (or one entry). Alias: 'list'. Defaults to 'effective' source.")
    .argument('[type...]', 'Optional device type/alias (case-insensitive, partial match)')
    .option('--source <source>', 'Which catalog to show: built-in | overlay | effective (default)', enumArg('--source', SOURCES), 'effective')
    .addHelpText('after', `
Examples:
  $ switchbot catalog show
  $ switchbot catalog show Bot
  $ switchbot catalog show Robot Vacuum
  $ switchbot catalog show --source built-in
  $ switchbot catalog show --json
`)
    .action((typeParts: string[], options: { source: string }) => {
      try {
        const source = options.source;
        if (!['built-in', 'overlay', 'effective'].includes(source)) {
          throw new UsageError(`Unknown --source "${source}". Expected: built-in, overlay, effective.`);
        }

        let entries: DeviceCatalogEntry[];
        if (source === 'built-in') {
          entries = DEVICE_CATALOG;
        } else if (source === 'overlay') {
          const overlay = loadCatalogOverlay();
          if (overlay.error) {
            throw new Error(`Overlay file is invalid: ${overlay.error}`);
          }
          // Only entries that are full catalog entries (have category + commands)
          // or that explicitly remove a built-in are rendered here. Partial
          // overrides are hidden because they're not self-contained entries;
          // use `catalog diff` to inspect them.
          entries = overlay.entries.filter(
            (e): e is DeviceCatalogEntry =>
              e.category !== undefined && e.commands !== undefined && !e.remove
          );
        } else {
          entries = getEffectiveCatalog();
        }

        const typeQuery = typeParts.join(' ').trim();
        if (typeQuery) {
          const match = findCatalogEntry(typeQuery);
          if (!match) {
            throw new UsageError(`No device type matches "${typeQuery}".`);
          }
          if (Array.isArray(match)) {
            const types = match.map((m) => m.type).join(', ');
            throw new UsageError(`"${typeQuery}" matches multiple types: ${types}. Be more specific.`);
          }
          // Restrict the match to the requested source if needed.
          const picked = entries.find((e) => e.type === match.type);
          if (!picked) {
            throw new UsageError(`"${match.type}" exists in the effective catalog but not in source "${source}".`);
          }
          if (isJsonMode()) {
            printJson(picked);
            return;
          }
          renderEntry(picked);
          return;
        }

        if (isJsonMode()) {
          printJson(entries);
          return;
        }
        const fmt = resolveFormat();
        const headers = ['type', 'category', 'commands', 'aliases'];
        const rows = entries.map((e) => [
          e.type,
          e.category,
          String(e.commands.length),
          (e.aliases ?? []).join(', ') || '—',
        ]);
        if (fmt !== 'table') {
          renderRows(headers, rows, fmt, resolveFields());
        } else {
          renderRows(headers, rows, 'table', resolveFields());
          console.log(`\nTotal: ${entries.length} device type(s)  (source: ${source})`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  catalog
    .command('search')
    .description('Fuzzy search the effective catalog by type name, alias, role, or command name')
    .argument('<keyword>', 'Substring to match (case-insensitive) against type, alias, role, or command')
    .action((keyword: string) => {
      try {
        const q = keyword.toLowerCase();
        const entries = getEffectiveCatalog();
        const hits = entries.filter((e) => {
          if (e.type.toLowerCase().includes(q)) return true;
          if ((e.role ?? '').toLowerCase().includes(q)) return true;
          if ((e.aliases ?? []).some((a) => a.toLowerCase().includes(q))) return true;
          if (e.commands.some((c) => c.command.toLowerCase().includes(q))) return true;
          return false;
        });
        if (isJsonMode()) {
          printJson({ query: keyword, matches: hits });
          return;
        }
        if (hits.length === 0) {
          console.log(`No catalog entries match "${keyword}".`);
          return;
        }
        const fmt = resolveFormat();
        const headers = ['type', 'category', 'role', 'matched'];
        const rows = hits.map((e) => {
          const matched: string[] = [];
          if (e.type.toLowerCase().includes(q)) matched.push('type');
          if ((e.aliases ?? []).some((a) => a.toLowerCase().includes(q))) matched.push('alias');
          if ((e.role ?? '').toLowerCase().includes(q)) matched.push('role');
          const cmdMatches = e.commands
            .filter((c) => c.command.toLowerCase().includes(q))
            .map((c) => c.command);
          if (cmdMatches.length > 0) matched.push(`commands[${cmdMatches.join(',')}]`);
          return [e.type, e.category, e.role ?? '—', matched.join(', ') || '—'];
        });
        renderRows(headers, rows, fmt, resolveFields());
        if (fmt === 'table') {
          console.log(`\n${hits.length} match${hits.length === 1 ? '' : 'es'} for "${keyword}"`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  catalog
    .command('diff')
    .description('Show what the overlay replaces, adds, or removes vs the built-in catalog')
    .action(() => {
      const overlay = loadCatalogOverlay();
      const builtInByType = new Map(DEVICE_CATALOG.map((e) => [e.type, e]));

      const replaced: Array<{ type: string; changedKeys: string[] }> = [];
      const added: string[] = [];
      const removed: string[] = [];
      const ignored: Array<{ type: string; reason: string }> = [];

      for (const e of overlay.entries) {
        if (e.remove) {
          if (builtInByType.has(e.type)) removed.push(e.type);
          else ignored.push({ type: e.type, reason: 'remove: type not in built-in catalog' });
          continue;
        }
        const existing = builtInByType.get(e.type);
        if (existing) {
          const changed: string[] = [];
          const overlayRec = e as unknown as Record<string, unknown>;
          const builtinRec = existing as unknown as Record<string, unknown>;
          for (const k of Object.keys(e)) {
            if (k === 'type') continue;
            if (JSON.stringify(overlayRec[k]) !== JSON.stringify(builtinRec[k])) {
              changed.push(k);
            }
          }
          replaced.push({ type: e.type, changedKeys: changed });
        } else if (e.category && e.commands) {
          added.push(e.type);
        } else {
          ignored.push({ type: e.type, reason: 'new entry missing required fields (category and/or commands)' });
        }
      }

      if (isJsonMode()) {
        printJson({
          overlayPath: overlay.path,
          overlayExists: overlay.exists,
          overlayValid: overlay.error === undefined,
          overlayError: overlay.error,
          replaced,
          added,
          removed,
          ignored,
        });
        return;
      }

      if (!overlay.exists) {
        console.log(`No overlay at ${overlay.path} — effective catalog matches built-in.`);
        return;
      }
      if (overlay.error) {
        console.log(`Overlay at ${overlay.path} is invalid: ${overlay.error}`);
        console.log('Effective catalog falls back to built-in.');
        return;
      }

      console.log(`Overlay: ${overlay.path}`);
      if (replaced.length === 0 && added.length === 0 && removed.length === 0 && ignored.length === 0) {
        console.log('(overlay file is empty — effective catalog matches built-in)');
        return;
      }
      if (replaced.length > 0) {
        console.log('\nReplaced:');
        for (const r of replaced) {
          console.log(`  ~ ${r.type}  (keys: ${r.changedKeys.join(', ') || '—'})`);
        }
      }
      if (added.length > 0) {
        console.log('\nAdded:');
        for (const t of added) console.log(`  + ${t}`);
      }
      if (removed.length > 0) {
        console.log('\nRemoved:');
        for (const t of removed) console.log(`  - ${t}`);
      }
      if (ignored.length > 0) {
        console.log('\nIgnored:');
        for (const i of ignored) console.log(`  ! ${i.type}  — ${i.reason}`);
      }
    });

  catalog
    .command('refresh')
    .description('Clear the in-process overlay cache (re-read on next use)')
    .action(() => {
      resetCatalogOverlayCache();
      const overlay = loadCatalogOverlay();
      if (isJsonMode()) {
        printJson({
          refreshed: true,
          path: overlay.path,
          exists: overlay.exists,
          valid: overlay.error === undefined,
          error: overlay.error,
          entryCount: overlay.entries.length,
        });
        return;
      }
      if (!overlay.exists) {
        console.log(`Overlay cache cleared. No overlay file at ${overlay.path} yet.`);
        return;
      }
      if (overlay.error) {
        console.log(`Overlay cache cleared, but the file is invalid: ${overlay.error}`);
        return;
      }
      console.log(`Overlay cache cleared. Loaded ${overlay.entries.length} entr${overlay.entries.length === 1 ? 'y' : 'ies'} from ${overlay.path}.`);
    });

  // Note: getCatalogOverlayPath is imported so future subcommands can surface
  // the path cheaply without a full overlay read; `path` currently uses the
  // richer loadCatalogOverlay() result instead.
  void getCatalogOverlayPath;
}

function renderEntry(entry: DeviceCatalogEntry): void {
  console.log(`Type:     ${entry.type}`);
  console.log(`Category: ${entry.category === 'ir' ? 'IR remote' : 'Physical device'}`);
  if (entry.role) console.log(`Role:     ${entry.role}`);
  if (entry.readOnly) console.log(`ReadOnly: yes (status-only device, no control commands)`);
  if (entry.aliases && entry.aliases.length > 0) {
    console.log(`Aliases:  ${entry.aliases.join(', ')}`);
  }
  if (entry.commands.length === 0) {
    console.log('\nCommands: (none — status-only device)');
  } else {
    console.log('\nCommands:');
    const rows = entry.commands.map((c) => {
      const tier = deriveSafetyTier(c, entry);
      const flags: string[] = [];
      if (c.commandType === 'customize') flags.push('customize');
      if (tier === 'destructive') flags.push('!destructive');
      const label = flags.length > 0 ? `${c.command}  [${flags.join(', ')}]` : c.command;
      return [label, c.parameter, c.description];
    });
    printTable(['command', 'parameter', 'description'], rows);
  }
  if (entry.statusFields && entry.statusFields.length > 0) {
    console.log('\nStatus fields (from "devices status"):');
    console.log('  ' + entry.statusFields.join(', '));
  }
}
