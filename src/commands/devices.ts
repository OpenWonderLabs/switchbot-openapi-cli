import { Command } from 'commander';
import { printTable, printKeyValue, printJson, isJsonMode, handleError, UsageError } from '../utils/output.js';
import { resolveFormat, resolveFields, renderRows } from '../utils/format.js';
import { findCatalogEntry, getEffectiveCatalog, DeviceCatalogEntry } from '../devices/catalog.js';
import { getCachedDevice } from '../devices/cache.js';
import { loadDeviceMeta } from '../devices/device-meta.js';
import { resolveDeviceId } from '../utils/name-resolver.js';
import {
  fetchDeviceList,
  fetchDeviceStatus,
  executeCommand,
  describeDevice,
  validateCommand,
  isDestructiveCommand,
  getDestructiveReason,
  buildHubLocationMap,
  DeviceNotFoundError,
  type Device,
} from '../lib/devices.js';
import { registerBatchCommand } from './batch.js';
import { registerWatchCommand } from './watch.js';
import { registerExplainCommand } from './explain.js';
import { registerExpandCommand } from './expand.js';
import { registerDevicesMetaCommand } from './device-meta.js';
import { isDryRun } from '../utils/flags.js';
import { writeRefusalAudit } from '../utils/audit.js';

export function registerDevicesCommand(program: Command): void {
  const devices = program
    .command('devices')
    .description('Manage and control SwitchBot devices')
    .addHelpText('after', `
Typical workflow:
  1. Discover your devices           → switchbot devices list
  2. Describe a specific device      → switchbot devices describe <id>
  3. Or look up a type offline       → switchbot devices types
                                       switchbot devices commands <type>
  4. Send a command                  → switchbot devices command <id> <cmd> [param]

Online subcommands (hit the SwitchBot API):
  list        List all physical + IR remote devices on your account
  status      Query a device's real-time status values
  command     Send a control command (turnOn, setColor, setAll, startClean, …)
  describe    Show one device's metadata + its supported commands + status fields

Offline subcommands (built-in catalog, no API call):
  types       List every device type this CLI knows about
  commands    Show commands + parameter formats + status fields for a type

Run any subcommand with --help for its own flags and examples.
`);

  // switchbot devices list
  devices
    .command('list')
    .description('List all physical devices and IR remote devices on the account')
    .addHelpText('after', `
Default columns: deviceId, deviceName, type, category
Pass --wide for the full operator view: + controlType, family, roomID, room, hub, cloud
--fields accepts any subset of all column names (exit 2 on unknown names).

  type         - physical deviceType (e.g. "Bot", "Curtain") or IR remoteType (e.g. "TV")
  category     - "physical" or "ir"
  controlType  - functional classification from the API (e.g. "Bot", "Switch",
                 "TV") — may differ from 'type' and groups devices by behavior
  family       - home/family name (IR remotes inherit this from their bound Hub)
  roomID       - internal room identifier (IR remotes inherit from their
                 bound Hub; — when unassigned/unknown)
  room         - room name this device is assigned to (IR remotes inherit from
                 Hub; — when unassigned/unknown)
  hub          - "—" when the device is its own hub or hubDeviceId is empty
  cloud        - ✓/✗: whether cloud service is enabled (— for IR remotes)

controlType, family/room, and roomID require the 'src: OpenClaw' header, which
this CLI always sends. (IR family/room inheritance is computed client-side for
the table; --json returns the raw API body unchanged.)

Examples:
  $ switchbot devices list
  $ switchbot devices list --wide
  $ switchbot devices list --format tsv --fields deviceId,deviceName,type,category
  $ switchbot devices list --json | jq '.deviceList[] | select(.familyName == "家里")'
  $ switchbot devices list --json | jq '[.deviceList[], .infraredRemoteList[]] | group_by(.familyName)'
`)
    .option('--wide', 'Show all columns (controlType, family, roomID, room, hub, cloud)')
    .option('--show-hidden', 'Include devices hidden via "devices meta set --hide"')
    .action(async (options: { wide?: boolean; showHidden?: boolean }) => {
      try {
        const body = await fetchDeviceList();
        const { deviceList, infraredRemoteList } = body;
        const fmt = resolveFormat();
        const deviceMeta = loadDeviceMeta();

        if (fmt === 'json' && process.argv.includes('--json')) {
          printJson(body);
          return;
        }

        const hubLocation = buildHubLocationMap(deviceList);

        const narrowHeaders = ['deviceId', 'deviceName', 'type', 'category'];
        const wideHeaders = ['deviceId', 'deviceName', 'type', 'category', 'controlType', 'family', 'roomID', 'room', 'hub', 'cloud', 'alias'];
        const userFields = resolveFields();
        const headers = userFields ? wideHeaders : (options.wide ? wideHeaders : narrowHeaders);
        const rows: (string | boolean | null)[][] = [];

        for (const d of deviceList) {
          if (!options.showHidden && deviceMeta.devices[d.deviceId]?.hidden) continue;
          rows.push([
            d.deviceId,
            d.deviceName,
            d.deviceType || '—',
            'physical',
            d.controlType || '—',
            d.familyName || '—',
            d.roomID || '—',
            d.roomName || '—',
            !d.hubDeviceId || d.hubDeviceId === '000000000000' ? '—' : d.hubDeviceId,
            d.enableCloudService,
            deviceMeta.devices[d.deviceId]?.alias ?? '—',
          ]);
        }

        for (const d of infraredRemoteList) {
          if (!options.showHidden && deviceMeta.devices[d.deviceId]?.hidden) continue;
          const inherited = hubLocation.get(d.hubDeviceId);
          rows.push([
            d.deviceId,
            d.deviceName,
            d.remoteType,
            'ir',
            d.controlType || '—',
            inherited?.family || '—',
            inherited?.roomID || '—',
            inherited?.room || '—',
            d.hubDeviceId,
            null,
            deviceMeta.devices[d.deviceId]?.alias ?? '—',
          ]);
        }

        if (rows.length === 0 && fmt === 'table') {
          console.log('No devices found');
          return;
        }

        const defaultFields = options.wide ? undefined : narrowHeaders;
        renderRows(wideHeaders, rows, fmt, userFields ?? defaultFields);
        if (fmt === 'table') {
          console.log(`\nTotal: ${deviceList.length} physical device(s), ${infraredRemoteList.length} IR remote device(s)`);
          console.log(`Tip: 'switchbot devices describe <deviceId>' shows a device's supported commands.`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot devices status <deviceId>
  devices
    .command('status')
    .description('Query the real-time status of a specific device')
    .argument('[deviceId]', 'Device ID from "devices list" (or use --name)')
    .option('--name <query>', 'Resolve device by fuzzy name instead of deviceId')
    .addHelpText('after', `
Status fields vary by device type. To discover them without a live call:

  switchbot devices commands <type>    (prints the "Status fields" section)

For --fields: run the command once with --format yaml (no --fields) to see
all field names returned by your specific device, then narrow with --fields.

Examples:
  $ switchbot devices status ABC123DEF456
  $ switchbot devices status --name "客厅空调"
  $ switchbot devices status ABC123DEF456 --json
  $ switchbot devices status ABC123DEF456 --format yaml
  $ switchbot devices status ABC123DEF456 --format tsv --fields power,battery
  $ switchbot devices status ABC123DEF456 --json | jq '.battery'
`)
    .action(async (deviceIdArg: string | undefined, options: { name?: string }) => {
      try {
        const deviceId = resolveDeviceId(deviceIdArg, options.name);
        const body = await fetchDeviceStatus(deviceId);
        const fmt = resolveFormat();

        if (fmt === 'json' && process.argv.includes('--json')) {
          printJson(body);
          return;
        }

        if (fmt !== 'table') {
          const allHeaders = Object.keys(body);
          const allRows = [Object.values(body) as unknown[]];
          const fields = resolveFields();
          renderRows(allHeaders, allRows, fmt, fields);
          return;
        }

        printKeyValue(body);
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot devices command <deviceId> <command> [parameter]
  devices
    .command('command')
    .description('Send a control command to a device')
    .argument('[deviceId]', 'Target device ID (or use --name)')
    .argument('<cmd>', 'Command name, e.g. turnOn, turnOff, setColor, setBrightness, setAll, startClean')
    .argument('[parameter]', 'Command parameter. Omit for commands like turnOn/turnOff (defaults to "default"). Format depends on the command (see below).')
    .option('--name <query>', 'Resolve device by fuzzy name instead of deviceId')
    .option('--type <commandType>', 'Command type: "command" for built-in commands (default), "customize" for user-defined IR buttons', 'command')
    .option('--yes', 'Confirm a destructive command (Smart Lock unlock, Garage open, …). --dry-run is always allowed without --yes.')
    .addHelpText('after', `
────────────────────────────────────────────────────────────────────────
For the full list of commands a specific device supports — and their
exact parameter formats — run:

  switchbot devices commands <type>      (e.g. Bot, Curtain, "Smart Lock")

The catalog is the authoritative per-device reference. This page only
covers the generic mechanics that apply to every device.
────────────────────────────────────────────────────────────────────────

Rules:
  • Command names are CASE-SENSITIVE (e.g. SetChannel, FastForward, volumeAdd).
  • Quote any parameter containing ':' ',' ';' or '{ }' to protect it from the shell.
  • The parameter is parsed as JSON when possible; otherwise passed through as a string.
  • Omit the parameter for no-arg commands — it auto-defaults to "default".
  • Use --type customize to trigger a user-defined IR button by name.

Generic parameter shapes (see 'devices commands <type>' for which one applies):

  (none)                   turnOn, turnOff, toggle, press, play, pause, …
  <integer>                setBrightness 75, setColorTemperature 4000, SetChannel 15
  <R:G:B>                  setColor "255:0:0"
  <direction;angle>        setPosition "up;60"            (Blind Tilt)
  <a,b,c,…>                setAll "26,1,3,on"             (IR AC)
  <json object>            startClean '{"action":"sweep","param":{"fanLevel":2,"times":1}}'

Common errors:
  160  command not supported by this device
  161  device offline (BLE devices need a Hub bridge)
  171  hub offline

Safety:
  Destructive commands (Smart Lock unlock, Garage Door Opener turnOn/turnOff,
  Keypad createKey/deleteKey, …) are blocked by default. Pass --yes to confirm,
  or --dry-run to preview without sending.

Examples:
  $ switchbot devices command ABC123 turnOn
  $ switchbot devices command ABC123 setColor "255:0:0"
  $ switchbot devices command ABC123 setAll "26,1,3,on"
  $ switchbot devices command ABC123 startClean '{"action":"sweep","param":{"fanLevel":2,"times":1}}'
  $ switchbot devices command ABC123 "MyButton" --type customize
  $ switchbot devices command <lockId> unlock --yes
`)
    .action(async (deviceIdArg: string | undefined, cmd: string, parameter: string | undefined, options: { name?: string; type: string; yes?: boolean }) => {
      const deviceId = resolveDeviceId(deviceIdArg, options.name);
      const validation = validateCommand(deviceId, cmd, parameter, options.type);
      if (!validation.ok) {
        const err = validation.error;
        if (isJsonMode()) {
          const obj: Record<string, unknown> = { code: 2, kind: 'usage', message: err.message };
          if (err.hint) obj.hint = err.hint;
          obj.context = { validationKind: err.kind };
          console.error(JSON.stringify({ error: obj }));
        } else {
          console.error(`Error: ${err.message}`);
          if (err.hint) console.error(err.hint);
          if (err.kind === 'unknown-command') {
            const cached = getCachedDevice(deviceId);
            if (cached) {
              console.error(
                `Run 'switchbot devices commands ${JSON.stringify(cached.type)}' for parameter formats and descriptions.`
              );
              console.error(
                `(If the catalog is out of date, run 'switchbot devices list' to refresh the local cache, or pass --type customize for custom IR buttons.)`
              );
            }
          }
        }
        process.exit(2);
      }

      const cachedForGuard = getCachedDevice(deviceId);
      if (
        !options.yes &&
        !isDryRun() &&
        isDestructiveCommand(cachedForGuard?.type, cmd, options.type)
      ) {
        const typeLabel = cachedForGuard?.type ?? 'unknown';
        const reason = getDestructiveReason(cachedForGuard?.type, cmd, options.type);
        writeRefusalAudit({
          deviceId,
          command: cmd,
          parameter,
          commandType: (options.type === 'customize' ? 'customize' : 'command'),
          caller: 'cli',
          reason: reason ?? `destructive command "${cmd}" on ${typeLabel} requires --yes`,
        });
        if (isJsonMode()) {
          console.error(JSON.stringify({
            error: {
              code: 2,
              kind: 'guard',
              message: `"${cmd}" on ${typeLabel} is destructive and requires --yes.`,
              hint: reason
                ? `Re-run with --yes to confirm. Reason: ${reason}`
                : 'Re-run with --yes to confirm, or --dry-run to preview without sending.',
              context: { command: cmd, deviceType: typeLabel, deviceId, ...(reason ? { destructiveReason: reason } : {}) },
            },
          }));
        } else {
          console.error(
            `Refusing to run destructive command "${cmd}" on ${typeLabel} without --yes.`
          );
          if (reason) console.error(`Reason: ${reason}`);
          console.error(
            `Re-run with --yes to confirm, or --dry-run to preview without sending.`
          );
        }
        process.exit(2);
      }

      try {
        // parameter may be a JSON object string (e.g. S10 startClean) or a plain string
        let parsedParam: unknown = parameter ?? 'default';
        if (parameter) {
          try {
            parsedParam = JSON.parse(parameter);
          } catch {
            // keep as string
          }
        }

        const body = await executeCommand(
          deviceId,
          cmd,
          parsedParam,
          options.type as 'command' | 'customize'
        );

        const isIr = getCachedDevice(deviceId)?.category === 'ir';

        if (isJsonMode()) {
          const result: Record<string, unknown> = { ok: true, command: cmd, deviceId };
          if (isIr) result.subKind = 'ir-no-feedback';
          if (body && typeof body === 'object' && Object.keys(body as object).length > 0) {
            Object.assign(result, body);
          }
          printJson(result);
          return;
        }

        console.log(`✓ Command sent: ${cmd}`);
        if (isIr) console.log('  Note: IR command sent — no device confirmation (fire-and-forget).');
        if (body && typeof body === 'object' && Object.keys(body as object).length > 0) {
          printKeyValue(body as Record<string, unknown>);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot devices types
  devices
    .command('types')
    .description('List all device types known to this CLI (offline reference, no API call)')
    .addHelpText('after', `
Output columns: type, category (physical | ir), commands, aliases
Use 'switchbot devices commands <type>' to see what a given type supports.

Examples:
  $ switchbot devices types
  $ switchbot devices types --json
`)
    .action(() => {
      try {
        const catalog = getEffectiveCatalog();
        const fmt = resolveFormat();
        if (fmt === 'json') {
          printJson(catalog);
          return;
        }
        const headers = ['type', 'category', 'commands', 'aliases'];
        const rows = catalog.map((e) => [
          e.type,
          e.category,
          String(e.commands.length),
          (e.aliases ?? []).join(', ') || '—',
        ]);
        renderRows(headers, rows, fmt, resolveFields());
        if (fmt === 'table') {
          console.log(`\nTotal: ${catalog.length} device type(s)`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot devices commands <type>
  devices
    .command('commands')
    .description('Show supported commands, parameter formats, and status fields for a device type')
    .argument('<type...>', 'Device type name or alias (case-insensitive, partial matches supported; multi-word types do not need quoting)')
    .addHelpText('after', `
This is the authoritative per-device reference — every command the CLI
can send to a given type, its parameter format, and the status fields
'devices status' will return. Runs fully offline (no API call).

Multi-word types can be passed either quoted or unquoted — both work:
  $ switchbot devices commands "Air Conditioner"
  $ switchbot devices commands Air Conditioner
  $ switchbot devices commands "Smart Lock"

Examples:
  $ switchbot devices commands Bot
  $ switchbot devices commands curtain
  $ switchbot devices commands Robot --json
`)
    .action((typeParts: string[]) => {
      const type = typeParts.join(' ');
      try {
        const match = findCatalogEntry(type);
        if (!match) {
          throw new UsageError(
            `No device type matches "${type}". Try 'switchbot devices types' to see the full list.`
          );
        }
        if (Array.isArray(match)) {
          const types = match.map((m) => m.type).join(', ');
          throw new UsageError(`"${type}" matches multiple types: ${types}. Be more specific.`);
        }
        if (isJsonMode()) {
          printJson(match);
          return;
        }
        renderCatalogEntry(match);
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot devices describe <deviceId>
  devices
    .command('describe')
    .description('Describe a device by ID: metadata + supported commands + status fields (1 API call)')
    .argument('[deviceId]', 'Target device ID (or use --name)')
    .option('--name <query>', 'Resolve device by fuzzy name instead of deviceId')
    .option('--live', 'Also fetch live status values and merge them into capabilities (costs 1 extra API call)')
    .addHelpText('after', `
Makes a GET /v1.1/devices call to look up the device's type, then prints its
metadata alongside the matching catalog entry (supported commands + parameter
formats + status field names). With --live, makes a second call to fetch the
current status values and merges them into the output.

JSON output shape (--json):
  {
    device: <raw API fields>,
    controlType: <string|null>,
    catalog: <catalog entry, or null>,
    capabilities: {
      role: <functional role>,
      readOnly: <boolean>,
      commands: [{command, parameter, description, idempotent?, destructive?, exampleParams?}],
      statusFields: [<name>],
      liveStatus: <status payload when --live was passed>
    },
    source: "catalog" | "live" | "catalog+live" | "none",
    suggestedActions: [{command, parameter?, description}]
  }

Examples:
  $ switchbot devices describe ABC123DEF456
  $ switchbot devices describe ABC123DEF456 --live
  $ switchbot devices describe ABC123DEF456 --json
  $ switchbot devices describe <lockId> --json | jq '.capabilities.commands[] | select(.destructive)'
`)
    .action(async (deviceIdArg: string | undefined, options: { name?: string; live?: boolean }) => {
      try {
        const deviceId = resolveDeviceId(deviceIdArg, options.name);
        const result = await describeDevice(deviceId, options);
        const { device, isPhysical, typeName, controlType, catalog, capabilities, source, suggestedActions: picks } = result;

        if (isJsonMode()) {
          printJson({
            device,
            controlType,
            catalog,
            capabilities,
            source,
            suggestedActions: picks,
          });
          return;
        }

        if (isPhysical) {
          const physical = device as Device;
          printKeyValue({
            deviceId: physical.deviceId,
            deviceName: physical.deviceName,
            deviceType: physical.deviceType || '—',
            controlType: physical.controlType || '—',
            family: physical.familyName || '—',
            roomID: physical.roomID || '—',
            room: physical.roomName || '—',
            hub: !physical.hubDeviceId || physical.hubDeviceId === '000000000000' ? '—' : physical.hubDeviceId,
            cloudService: physical.enableCloudService,
          });
        } else {
          const ir = device as { deviceId: string; deviceName: string; remoteType: string; controlType?: string; hubDeviceId: string };
          const inherited = result.inheritedLocation;
          printKeyValue({
            deviceId: ir.deviceId,
            deviceName: ir.deviceName,
            remoteType: ir.remoteType,
            controlType: ir.controlType || '—',
            family: inherited?.family || '—',
            roomID: inherited?.roomID || '—',
            room: inherited?.room || '—',
            hub: ir.hubDeviceId || '—',
          });
        }

        const liveStatus =
          capabilities && 'liveStatus' in capabilities ? capabilities.liveStatus : undefined;

        console.log('');
        if (!catalog) {
          console.log(`(Type "${typeName}" is not in the built-in catalog — no command reference available.)`);
          if (isPhysical) {
            console.log(`Try 'switchbot devices status ${deviceId}' to see what this device reports.`);
          } else {
            console.log(`Send custom IR buttons with: switchbot devices command ${deviceId} "<buttonName>" --type customize`);
          }
          if (liveStatus) {
            console.log('\nLive status:');
            printKeyValue(liveStatus);
          }
          return;
        }
        renderCatalogEntry(catalog);

        if (liveStatus) {
          console.log('\nLive status:');
          printKeyValue(liveStatus);
        }
      } catch (error) {
        if (error instanceof DeviceNotFoundError) {
          console.error(error.message);
          console.error(`Try 'switchbot devices list' to see the full list.`);
          process.exit(1);
        }
        handleError(error);
      }
    });

  // switchbot devices batch <command> ...
  registerBatchCommand(devices);

  // switchbot devices watch <id...>
  registerWatchCommand(devices);

  // switchbot devices explain <id>
  registerExplainCommand(devices);

  // switchbot devices expand <id> <cmd> [semantic flags]
  registerExpandCommand(devices);

  // switchbot devices meta set/get/list/clear
  registerDevicesMetaCommand(devices);
}

function renderCatalogEntry(entry: DeviceCatalogEntry): void {
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
    const hasDestructive = entry.commands.some((c) => c.destructive);
    if (hasDestructive) {
      console.log('\n[!destructive] commands have hard-to-reverse real-world effects — confirm before issuing.');
    }
  }

  if (entry.statusFields && entry.statusFields.length > 0) {
    console.log('\nStatus fields (from "devices status"):');
    console.log('  ' + entry.statusFields.join(', '));
  }
}
