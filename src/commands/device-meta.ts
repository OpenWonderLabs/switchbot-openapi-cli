import { Command } from 'commander';
import { stringArg } from '../utils/arg-parsers.js';
import { handleError, isJsonMode, printJson, printTable, UsageError } from '../utils/output.js';
import {
  loadDeviceMeta,
  saveDeviceMeta,
  setDeviceMeta,
  clearDeviceMeta,
  getDeviceMeta,
  getMetaFilePath,
} from '../devices/device-meta.js';

export function registerDevicesMetaCommand(devices: Command): void {
  const meta = devices
    .command('meta')
    .description('Manage local device metadata (alias, hide, notes) stored in ~/.switchbot/device-meta.json');

  // switchbot devices meta set <deviceId>
  meta
    .command('set')
    .description('Set local metadata for a device (alias, hide/show, notes)')
    .argument('<deviceId>', 'Target device ID')
    .option('--alias <name>', 'Local alias for the device (used with --name flag)', stringArg('--alias'))
    .option('--hide', 'Hide this device from "devices list"')
    .option('--show', 'Un-hide this device')
    .option('--notes <text>', 'Freeform notes shown in "devices describe"', stringArg('--notes'))
    .option('--force', 'Reassign alias even if it already belongs to another device')
    .action((deviceId: string, options: { alias?: string; hide?: boolean; show?: boolean; notes?: string; force?: boolean }) => {
      try {
        if (options.hide && options.show) {
          throw new UsageError('--hide and --show cannot be used together.');
        }
        if (!options.alias && !options.hide && !options.show && !options.notes) {
          throw new UsageError('Specify at least one of: --alias, --hide, --show, --notes');
        }

        // Enforce alias uniqueness across devices
        if (options.alias !== undefined) {
          const meta = loadDeviceMeta();
          const holder = Object.entries(meta.devices).find(
            ([id, m]) => m.alias === options.alias && id !== deviceId,
          );
          if (holder) {
            if (!options.force) {
              throw new UsageError(
                `Alias "${options.alias}" is already assigned to device ${holder[0]}. Use --force to reassign.`,
              );
            }
            // --force: clear the alias from the previous holder
            meta.devices[holder[0]] = { ...meta.devices[holder[0]], alias: undefined };
            saveDeviceMeta(meta);
            if (!isJsonMode()) {
              console.log(`(reassigned alias from ${holder[0]})`);
            }
          }
        }

        const patch: Record<string, unknown> = {};
        if (options.alias !== undefined) patch.alias = options.alias;
        if (options.notes !== undefined) patch.notes = options.notes;
        if (options.hide) patch.hidden = true;
        if (options.show) patch.hidden = false;

        setDeviceMeta(deviceId, patch);

        const updated = getDeviceMeta(deviceId);
        if (isJsonMode()) {
          printJson({ ok: true, deviceId, meta: updated });
        } else {
          console.log(`✓ Metadata updated for ${deviceId}`);
          if (updated?.alias)  console.log(`  alias:  ${updated.alias}`);
          if (updated?.hidden) console.log(`  hidden: true`);
          if (updated?.notes)  console.log(`  notes:  ${updated.notes}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot devices meta get <deviceId>
  meta
    .command('get')
    .description('Show local metadata for a device')
    .argument('<deviceId>', 'Target device ID')
    .action((deviceId: string) => {
      try {
        const entry = getDeviceMeta(deviceId);
        if (!entry) {
          if (isJsonMode()) {
            printJson({ deviceId, meta: null });
          } else {
            console.log(`No local metadata for ${deviceId}`);
          }
          return;
        }
        if (isJsonMode()) {
          printJson({ deviceId, meta: entry });
        } else {
          if (entry.alias)   console.log(`alias:  ${entry.alias}`);
          if (entry.hidden !== undefined) console.log(`hidden: ${entry.hidden}`);
          if (entry.notes)   console.log(`notes:  ${entry.notes}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot devices meta list
  meta
    .command('list')
    .description('List all devices with local metadata')
    .option('--hidden-only', 'Show only hidden devices')
    .action((options: { hiddenOnly?: boolean }) => {
      try {
        const file = loadDeviceMeta();
        let entries = Object.entries(file.devices);
        if (options.hiddenOnly) entries = entries.filter(([, m]) => m.hidden);

        if (entries.length === 0) {
          if (isJsonMode()) {
            printJson([]);
          } else {
            console.log('No local metadata entries.');
            console.log(`File: ${getMetaFilePath()}`);
          }
          return;
        }

        if (isJsonMode()) {
          printJson(entries.map(([id, m]) => ({ deviceId: id, ...m })));
          return;
        }

        const rows = entries.map(([id, m]) => [
          id,
          m.alias ?? '—',
          m.hidden ? 'yes' : '—',
          m.notes ?? '—',
        ]);
        printTable(['deviceId', 'alias', 'hidden', 'notes'], rows);
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot devices meta clear <deviceId>
  meta
    .command('clear')
    .description('Remove all local metadata for a device')
    .argument('<deviceId>', 'Target device ID')
    .action((deviceId: string) => {
      try {
        clearDeviceMeta(deviceId);
        if (isJsonMode()) {
          printJson({ ok: true, deviceId });
        } else {
          console.log(`✓ Metadata cleared for ${deviceId}`);
        }
      } catch (error) {
        handleError(error);
      }
    });
}
