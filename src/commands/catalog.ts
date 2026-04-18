import { Command } from 'commander';
import { printTable, printJson, isJsonMode } from '../utils/output.js';
import { resolveFormat, resolveFields, renderRows } from '../utils/format.js';
import {
  DEVICE_CATALOG,
  findCatalogEntry,
  getCatalogOverlayPath,
  getEffectiveCatalog,
  loadCatalogOverlay,
  resetCatalogOverlayCache,
  type DeviceCatalogEntry,
} from '../devices/catalog.js';

export function registerCatalogCommand(program: Command): void {
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
  show        Show the effective catalog (or one entry)
  diff        Show what the overlay changes vs the built-in catalog
  refresh     Re-read the overlay file (clears in-process cache)

Examples:
  $ switchbot catalog path
  $ switchbot catalog show
  $ switchbot catalog show "Smart Lock"
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
    .description("Show the effective catalog (or one entry). Defaults to 'effective' source.")
    .argument('[type...]', 'Optional device type/alias (case-insensitive, partial match)')
    .option('--source <source>', 'Which catalog to show: built-in | overlay | effective (default)', 'effective')
    .action((typeParts: string[], options: { source: string }) => {
      const source = options.source;
      if (!['built-in', 'overlay', 'effective'].includes(source)) {
        console.error(`Unknown --source "${source}". Expected: built-in, overlay, effective.`);
        process.exit(2);
      }

      let entries: DeviceCatalogEntry[];
      if (source === 'built-in') {
        entries = DEVICE_CATALOG;
      } else if (source === 'overlay') {
        const overlay = loadCatalogOverlay();
        if (overlay.error) {
          console.error(`Overlay file is invalid: ${overlay.error}`);
          process.exit(1);
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
          console.error(`No device type matches "${typeQuery}".`);
          process.exit(2);
        }
        if (Array.isArray(match)) {
          console.error(`"${typeQuery}" matches multiple types. Be more specific:`);
          for (const m of match) console.error(`  • ${m.type}`);
          process.exit(2);
        }
        // Restrict the match to the requested source if needed.
        const picked = entries.find((e) => e.type === match.type);
        if (!picked) {
          console.error(`"${match.type}" exists in the effective catalog but not in source "${source}".`);
          process.exit(2);
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
      const flags: string[] = [];
      if (c.commandType === 'customize') flags.push('customize');
      if (c.destructive) flags.push('!destructive');
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
