import { Command } from 'commander';
import { createClient } from '../api/client.js';
import { printTable, printKeyValue, printJson, isJsonMode, handleError } from '../utils/output.js';
import { DEVICE_CATALOG, findCatalogEntry, DeviceCatalogEntry } from '../devices/catalog.js';

interface Device {
  deviceId: string;
  deviceName: string;
  deviceType?: string;
  enableCloudService: boolean;
  hubDeviceId: string;
  // Extra fields returned when the request carries the src=OpenClaw header:
  roomID?: string;
  roomName?: string | null;
  familyName?: string;
  controlType?: string;
}

interface InfraredDevice {
  deviceId: string;
  deviceName: string;
  remoteType: string;
  hubDeviceId: string;
  // Extra field returned when the request carries the src=OpenClaw header:
  controlType?: string;
}

interface DeviceListBody {
  deviceList: Device[];
  infraredRemoteList: InfraredDevice[];
}

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
Output columns: deviceId, deviceName, type, controlType, family, roomID, room, hub, cloud

  type         - physical deviceType (e.g. "Bot", "Curtain") or "[IR] <remoteType>"
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
  $ switchbot devices list --json | jq '.deviceList[] | select(.familyName == "家里")'
  $ switchbot devices list --json | jq '[.deviceList[], .infraredRemoteList[]] | group_by(.familyName)'
`)
    .action(async () => {
      try {
        const client = createClient();
        const res = await client.get<{ body: DeviceListBody }>('/v1.1/devices');
        const { deviceList, infraredRemoteList } = res.data.body;

        if (isJsonMode()) {
          printJson(res.data.body);
          return;
        }

        const hubLocation = buildHubLocationMap(deviceList);
        const rows: (string | boolean | null)[][] = [];

        for (const d of deviceList) {
          rows.push([
            d.deviceId,
            d.deviceName,
            d.deviceType || '—',
            d.controlType || '—',
            d.familyName || '—',
            d.roomID || '—',
            d.roomName || '—',
            !d.hubDeviceId || d.hubDeviceId === '000000000000' ? '—' : d.hubDeviceId,
            d.enableCloudService,
          ]);
        }

        for (const d of infraredRemoteList) {
          const inherited = hubLocation.get(d.hubDeviceId);
          rows.push([
            d.deviceId,
            d.deviceName,
            `[IR] ${d.remoteType}`,
            d.controlType || '—',
            inherited?.family || '—',
            inherited?.roomID || '—',
            inherited?.room || '—',
            d.hubDeviceId,
            null,
          ]);
        }

        if (rows.length === 0) {
          console.log('No devices found');
          return;
        }

        printTable(['deviceId', 'deviceName', 'type', 'controlType', 'family', 'roomID', 'room', 'hub', 'cloud'], rows);
        console.log(`\nTotal: ${deviceList.length} physical device(s), ${infraredRemoteList.length} IR remote device(s)`);
        console.log(`Tip: 'switchbot devices describe <deviceId>' shows a device's supported commands.`);
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot devices status <deviceId>
  devices
    .command('status')
    .description('Query the real-time status of a specific device')
    .argument('<deviceId>', 'Device ID from "devices list" (physical devices only; IR remotes have no status)')
    .addHelpText('after', `
Returned fields vary by device type — e.g. Bot returns power/battery, Meter
returns temperature/humidity/battery, Curtain returns slidePosition/moving,
Color Bulb returns brightness/color/colorTemperature, etc.

To see exactly which status fields a given type returns BEFORE calling the
API, use the offline catalog:

  switchbot devices commands <type>       (prints the "Status fields" section)

IR remote devices cannot be queried — the SwitchBot API returns no status
channel for them. Use 'devices list' to confirm a deviceId is a physical
device (not in the 'infraredRemoteList').

Examples:
  $ switchbot devices status ABC123DEF456
  $ switchbot devices status ABC123DEF456 --json
  $ switchbot devices status ABC123DEF456 --json | jq '.battery'
`)
    .action(async (deviceId: string) => {
      try {
        const client = createClient();
        const res = await client.get<{ body: Record<string, unknown> }>(
          `/v1.1/devices/${deviceId}/status`
        );

        if (isJsonMode()) {
          printJson(res.data.body);
          return;
        }

        printKeyValue(res.data.body);
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot devices command <deviceId> <command> [parameter]
  devices
    .command('command')
    .description('Send a control command to a device')
    .argument('<deviceId>', 'Target device ID from "devices list"')
    .argument('<cmd>', 'Command name, e.g. turnOn, turnOff, setColor, setBrightness, setAll, startClean')
    .argument('[parameter]', 'Command parameter. Omit for commands like turnOn/turnOff (defaults to "default"). Format depends on the command (see below).')
    .option('--type <commandType>', 'Command type: "command" for built-in commands (default), "customize" for user-defined IR buttons', 'command')
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

Examples:
  $ switchbot devices command ABC123 turnOn
  $ switchbot devices command ABC123 setColor "255:0:0"
  $ switchbot devices command ABC123 setAll "26,1,3,on"
  $ switchbot devices command ABC123 startClean '{"action":"sweep","param":{"fanLevel":2,"times":1}}'
  $ switchbot devices command ABC123 "MyButton" --type customize
`)
    .action(async (deviceId: string, cmd: string, parameter: string | undefined, options: { type: string }) => {
      try {
        const client = createClient();

        // parameter may be a JSON object string (e.g. S10 startClean) or a plain string
        let parsedParam: unknown = parameter ?? 'default';
        if (parameter) {
          try {
            parsedParam = JSON.parse(parameter);
          } catch {
            // keep as string
          }
        }

        const body = {
          command: cmd,
          parameter: parsedParam,
          commandType: options.type,
        };

        const res = await client.post<{ body: unknown }>(
          `/v1.1/devices/${deviceId}/commands`,
          body
        );

        if (isJsonMode()) {
          printJson(res.data.body);
          return;
        }

        console.log(`✓ Command sent: ${cmd}`);
        if (res.data.body && typeof res.data.body === 'object' && Object.keys(res.data.body).length > 0) {
          printKeyValue(res.data.body as Record<string, unknown>);
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
      if (isJsonMode()) {
        printJson(DEVICE_CATALOG);
        return;
      }
      const rows = DEVICE_CATALOG.map((e) => [
        e.type,
        e.category,
        String(e.commands.length),
        (e.aliases ?? []).join(', ') || '—',
      ]);
      printTable(['type', 'category', 'commands', 'aliases'], rows);
      console.log(`\nTotal: ${DEVICE_CATALOG.length} device type(s)`);
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
      const match = findCatalogEntry(type);
      if (!match) {
        console.error(`No device type matches "${type}".`);
        console.error(`Try 'switchbot devices types' to see the full list.`);
        process.exit(2);
      }
      if (Array.isArray(match)) {
        console.error(`"${type}" matches multiple types. Be more specific:`);
        for (const m of match) console.error(`  • ${m.type}`);
        process.exit(2);
      }
      if (isJsonMode()) {
        printJson(match);
        return;
      }
      renderCatalogEntry(match);
    });

  // switchbot devices describe <deviceId>
  devices
    .command('describe')
    .description('Describe a device by ID: metadata + supported commands + status fields (1 API call)')
    .argument('<deviceId>', 'Target device ID from "devices list"')
    .addHelpText('after', `
Makes a single GET /v1.1/devices call to look up the device's type, then
prints its metadata alongside the matching catalog entry (supported
commands + parameter formats + status field names).

Does NOT fetch live status values. Use 'switchbot devices status <id>' for that.

Examples:
  $ switchbot devices describe ABC123DEF456
  $ switchbot devices describe ABC123DEF456 --json
`)
    .action(async (deviceId: string) => {
      try {
        const client = createClient();
        const res = await client.get<{ body: DeviceListBody }>('/v1.1/devices');
        const { deviceList, infraredRemoteList } = res.data.body;

        const physical = deviceList.find((d) => d.deviceId === deviceId);
        const ir = infraredRemoteList.find((d) => d.deviceId === deviceId);

        if (!physical && !ir) {
          console.error(`No device with id "${deviceId}" found on this account.`);
          console.error(`Try 'switchbot devices list' to see the full list.`);
          process.exit(1);
        }

        const typeName = physical ? (physical.deviceType ?? '') : ir!.remoteType;
        const match = typeName ? findCatalogEntry(typeName) : null;
        const catalogEntry = !match || Array.isArray(match) ? null : match;

        if (isJsonMode()) {
          printJson({
            device: physical ?? ir,
            controlType: (physical?.controlType ?? ir?.controlType) ?? null,
            catalog: catalogEntry,
          });
          return;
        }

        if (physical) {
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
        } else if (ir) {
          const inherited = buildHubLocationMap(deviceList).get(ir.hubDeviceId);
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

        console.log('');
        if (!catalogEntry) {
          console.log(`(Type "${typeName}" is not in the built-in catalog — no command reference available.)`);
          console.log(`Send custom IR buttons with: switchbot devices command ${deviceId} "<buttonName>" --type customize`);
          return;
        }
        renderCatalogEntry(catalogEntry);
      } catch (error) {
        handleError(error);
      }
    });
}

function buildHubLocationMap(
  deviceList: Device[]
): Map<string, { family?: string; room?: string; roomID?: string }> {
  const map = new Map<string, { family?: string; room?: string; roomID?: string }>();
  for (const d of deviceList) {
    if (!d.deviceId) continue;
    map.set(d.deviceId, {
      family: d.familyName ?? undefined,
      room: d.roomName ?? undefined,
      roomID: d.roomID ?? undefined,
    });
  }
  return map;
}

function renderCatalogEntry(entry: DeviceCatalogEntry): void {
  console.log(`Type:     ${entry.type}`);
  console.log(`Category: ${entry.category === 'ir' ? 'IR remote' : 'Physical device'}`);
  if (entry.aliases && entry.aliases.length > 0) {
    console.log(`Aliases:  ${entry.aliases.join(', ')}`);
  }

  if (entry.commands.length === 0) {
    console.log('\nCommands: (none — status-only device)');
  } else {
    console.log('\nCommands:');
    const rows = entry.commands.map((c) => [
      c.commandType === 'customize' ? `${c.command}  [customize]` : c.command,
      c.parameter,
      c.description,
    ]);
    printTable(['command', 'parameter', 'description'], rows);
  }

  if (entry.statusFields && entry.statusFields.length > 0) {
    console.log('\nStatus fields (from "devices status"):');
    console.log('  ' + entry.statusFields.join(', '));
  }
}
