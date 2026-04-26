import { Command } from 'commander';
import { enumArg, stringArg } from '../utils/arg-parsers.js';
import { printTable, printKeyValue, printJson, isJsonMode, handleError, UsageError, StructuredUsageError, exitWithError } from '../utils/output.js';
import { resolveFormat, resolveFields, renderRows } from '../utils/format.js';
import {
  findCatalogEntry,
  getEffectiveCatalog,
  deriveSafetyTier,
  getCommandSafetyReason,
  DeviceCatalogEntry,
} from '../devices/catalog.js';
import { getCachedDevice, loadCache } from '../devices/cache.js';
import { loadDeviceMeta } from '../devices/device-meta.js';
import { resolveDeviceId, NameResolveStrategy, ALL_STRATEGIES } from '../utils/name-resolver.js';
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
import { parseFilterExpr, matchClause, FilterSyntaxError, type FilterClause } from '../utils/filter.js';
import { validateParameter } from '../devices/param-validator.js';
import { registerBatchCommand } from './batch.js';
import { registerWatchCommand } from './watch.js';
import { registerExplainCommand } from './explain.js';
import { registerExpandCommand } from './expand.js';
import { registerDevicesMetaCommand } from './device-meta.js';
import { isDryRun } from '../utils/flags.js';
import { DryRunSignal } from '../api/client.js';
import { resolveField, resolveFieldList, listSupportedFieldInputs } from '../schema/field-aliases.js';
import { allowsDirectDestructiveExecution, destructiveExecutionHint } from '../lib/destructive-mode.js';

const EXPAND_HINTS: Record<string, { command: string; flags: string }> = {
  'Air Conditioner':  { command: 'setAll',      flags: '--temp 26 --mode cool --fan low --power on' },
  'Curtain':          { command: 'setPosition',  flags: '--position 50 --mode silent' },
  'Curtain 3':        { command: 'setPosition',  flags: '--position 50' },
  'Blind Tilt':       { command: 'setPosition',  flags: '--direction up --angle 50' },
  'Relay Switch 2PM': { command: 'setMode',      flags: '--channel 1 --mode edge' },
};

function annotateStatusPayload(deviceId: string, body: Record<string, unknown>): Record<string, unknown> {
  const annotated = { ...body };
  if (Object.keys(body).length === 0) {
    annotated.supported = false;
    annotated.note = 'this device does not expose cloud status';
    return annotated;
  }

  const cached = getCachedDevice(deviceId);
  const looksLikeMeter = cached?.type?.toLowerCase().includes('meter') ?? false;
  const staleZeroReading =
    looksLikeMeter &&
    !Object.prototype.hasOwnProperty.call(body, 'onlineStatus') &&
    body.battery === 0 &&
    body.temperature === 0 &&
    body.humidity === 0;

  if (staleZeroReading) {
    annotated.hint = 'readings look stale; check batteries or hub connectivity';
  }

  return annotated;
}

export function registerDevicesCommand(program: Command): void {
  const COMMAND_TYPES = ['command', 'customize'] as const;
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
    .alias('ls')
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
  $ switchbot devices list --json | jq '.deviceList[] | select(.familyName == "home")'
  $ switchbot devices list --json | jq '[.deviceList[], .infraredRemoteList[]] | group_by(.familyName)'
  $ switchbot devices list --filter type="Air Conditioner"
  $ switchbot devices list --filter category=ir
  $ switchbot devices list --filter name=living,category=physical
  $ switchbot devices list --filter 'name~living'              # explicit substring
  $ switchbot devices list --filter 'type=/Air.*/'             # regex (case-insensitive)
`)
    .option('--wide', 'Show all columns (controlType, family, roomID, room, hub, cloud)')
    .option('--show-hidden', 'Include devices hidden via "devices meta set --hide"')
    .option('--filter <expr>', 'Filter devices: comma-separated clauses. Each clause is "key=value" (substring; exact for category), "key!=value" (negated substring), "key~value" (explicit substring), or "key=/regex/" (case-insensitive regex). Supported keys: deviceId/id, deviceName/name, deviceType/type, controlType, roomName/room, category, familyName/family, hubDeviceId/hub, roomID/roomid, enableCloudService/cloud, alias.', stringArg('--filter'))
    .action(async (options: { wide?: boolean; showHidden?: boolean; filter?: string }) => {
      try {
        const body = await fetchDeviceList();
        const { deviceList, infraredRemoteList } = body;
        const fmt = resolveFormat();
        const deviceMeta = loadDeviceMeta();

        const hubLocation = buildHubLocationMap(deviceList);

        // Parse --filter into a list of clauses. Shared grammar across
        // `devices list`, `devices batch`, and `events tail` / `mqtt-tail`.
        const LIST_KEYS = ['deviceId', 'type', 'name', 'category', 'room', 'controlType',
          'family', 'hub', 'roomID', 'cloud', 'alias'] as const;
        const LIST_FILTER_CANONICAL = ['deviceId', 'deviceName', 'deviceType', 'controlType',
          'roomName', 'category', 'familyName', 'hubDeviceId', 'roomID',
          'enableCloudService', 'alias'] as const;
        const LIST_FILTER_TO_RUNTIME: Record<string, (typeof LIST_KEYS)[number]> = {
          deviceId: 'deviceId',
          deviceName: 'name',
          deviceType: 'type',
          controlType: 'controlType',
          roomName: 'room',
          category: 'category',
          familyName: 'family',
          hubDeviceId: 'hub',
          roomID: 'roomID',
          enableCloudService: 'cloud',
          alias: 'alias',
        };
        let listClauses: FilterClause[] | null = null;
        if (options.filter) {
          try {
            listClauses = parseFilterExpr(options.filter, LIST_KEYS, {
              resolveKey: (input) => {
                const canonical = resolveField(input, LIST_FILTER_CANONICAL);
                return LIST_FILTER_TO_RUNTIME[canonical];
              },
              supportedKeys: listSupportedFieldInputs(LIST_FILTER_CANONICAL),
            });
          } catch (err) {
            if (err instanceof FilterSyntaxError) throw new UsageError(err.message);
            throw err;
          }
        }

        const matchesFilter = (entry: {
          deviceId: string; type: string; name: string; category: 'physical' | 'ir';
          room: string; controlType: string; family: string; hub: string;
          roomID: string; cloud: string; alias: string;
        }) => {
          if (!listClauses || listClauses.length === 0) return true;
          for (const c of listClauses) {
            const fieldVal = (entry as Record<string, string>)[c.key] ?? '';
            if (!matchClause(fieldVal, c)) return false;
          }
          return true;
        };

        if (fmt === 'json' && process.argv.includes('--json')) {
          if (listClauses) {
            const filteredDeviceList = deviceList.filter((d) =>
              matchesFilter({ deviceId: d.deviceId, type: d.deviceType || '', name: d.deviceName, category: 'physical', room: d.roomName || '', controlType: d.controlType || '', family: d.familyName || '', hub: d.hubDeviceId || '', roomID: d.roomID || '', cloud: String(d.enableCloudService), alias: deviceMeta.devices[d.deviceId]?.alias || '' })
            );
            const filteredIrList = infraredRemoteList.filter((d) => {
              const inherited = hubLocation.get(d.hubDeviceId);
              return matchesFilter({ deviceId: d.deviceId, type: d.remoteType, name: d.deviceName, category: 'ir', room: inherited?.room || '', controlType: d.controlType || '', family: inherited?.family || '', hub: d.hubDeviceId || '', roomID: inherited?.roomID || '', cloud: '', alias: deviceMeta.devices[d.deviceId]?.alias || '' });
            });
            printJson({ ok: true, deviceList: filteredDeviceList, infraredRemoteList: filteredIrList });
          } else {
            printJson({ ok: true, ...(body as object) });
          }
          return;
        }

        const narrowHeaders = ['deviceId', 'deviceName', 'type', 'category'];
        const wideHeaders = ['deviceId', 'deviceName', 'type', 'category', 'controlType', 'family', 'roomID', 'room', 'hub', 'cloud', 'alias'];
        const userFields = resolveFields();
        const headers = userFields ? wideHeaders : (options.wide ? wideHeaders : narrowHeaders);
        const rows: (string | boolean | null)[][] = [];

        for (const d of deviceList) {
          if (!options.showHidden && deviceMeta.devices[d.deviceId]?.hidden) continue;
          if (!matchesFilter({ deviceId: d.deviceId, type: d.deviceType || '', name: d.deviceName, category: 'physical', room: d.roomName || '', controlType: d.controlType || '', family: d.familyName || '', hub: d.hubDeviceId || '', roomID: d.roomID || '', cloud: String(d.enableCloudService), alias: deviceMeta.devices[d.deviceId]?.alias || '' })) continue;
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
          if (!matchesFilter({ deviceId: d.deviceId, type: d.remoteType, name: d.deviceName, category: 'ir', room: inherited?.room || '', controlType: d.controlType || '', family: inherited?.family || '', hub: d.hubDeviceId || '', roomID: inherited?.roomID || '', cloud: '', alias: deviceMeta.devices[d.deviceId]?.alias || '' })) continue;
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
          console.log(listClauses ? 'No devices matched the filter.' : 'No devices found');
          return;
        }

        const defaultFields = options.wide ? undefined : narrowHeaders;
        // Accept API field names and short aliases alongside canonical column names
        const DEVICE_LIST_ALIASES: Record<string, string> = {
          id: 'deviceId',
          name: 'deviceName',
          deviceType: 'type',
          type: 'type',
          roomName: 'room',
          familyName: 'family',
          hubDeviceId: 'hub',
          enableCloudService: 'cloud',
          controlType: 'controlType',
          deviceName: 'deviceName',
          deviceId: 'deviceId',
          category: 'category',
          alias: 'alias',
        };
        renderRows(wideHeaders, rows, fmt, userFields ?? defaultFields, DEVICE_LIST_ALIASES);
        if (fmt === 'table') {
          const totalLabel = listClauses
            ? `${rows.length} match(es) (${deviceList.length} physical + ${infraredRemoteList.length} IR before filter)`
            : `${deviceList.length} physical device(s), ${infraredRemoteList.length} IR remote device(s)`;
          console.log(`\nTotal: ${totalLabel}`);
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
    .argument('[deviceId]', 'Device ID from "devices list" (or use --name or --ids)')
    .option('--name <query>', 'Resolve device by fuzzy name instead of deviceId', stringArg('--name'))
    .option('--name-strategy <s>', `Name match strategy: ${ALL_STRATEGIES.join('|')} (default: fuzzy)`, stringArg('--name-strategy'))
    .option('--name-type <type>', 'Narrow --name by device type (e.g. "Bot", "Color Bulb")', stringArg('--name-type'))
    .option('--name-category <cat>', 'Narrow --name by category: physical|ir', enumArg('--name-category', ['physical', 'ir'] as const))
    .option('--name-room <room>', 'Narrow --name by room name (substring match)', stringArg('--name-room'))
    .option('--ids <list>', 'Comma-separated device IDs for batch status (incompatible with --name)', stringArg('--ids'))
    .addHelpText('after', `
Status fields vary by device type. To discover them without a live call:

  switchbot devices commands <type>    (prints the "Status fields" section)

For --fields: run the command once with --format yaml (no --fields) to see
all field names returned by your specific device, then narrow with --fields.

Examples:
  $ switchbot devices status ABC123DEF456
  $ switchbot devices status --name "Living Room AC"
  $ switchbot devices status ABC123DEF456 --json
  $ switchbot devices status ABC123DEF456 --format yaml
  $ switchbot devices status ABC123DEF456 --format tsv --fields power,battery
  $ switchbot devices status ABC123DEF456 --json | jq '.data.battery'
  $ switchbot devices status --ids ABC123,DEF456,GHI789
  $ switchbot devices status --ids ABC123,DEF456 --fields power,battery
`)
    .action(async (deviceIdArg: string | undefined, options: { name?: string; nameStrategy?: string; nameType?: string; nameCategory?: 'physical' | 'ir'; nameRoom?: string; ids?: string }) => {
      try {
        // Batch mode: --ids id1,id2,id3
        if (options.ids) {
          if (options.name) throw new UsageError('--ids and --name cannot be used together.');
          const ids = options.ids.split(',').map((s) => s.trim()).filter(Boolean);
          if (ids.length === 0) throw new UsageError('--ids requires at least one device ID.');
          const results = await Promise.allSettled(ids.map((id) => fetchDeviceStatus(id)));
          const fetchedAt = new Date().toISOString();
          const batch = results.map((r, i) =>
            r.status === 'fulfilled'
              ? { deviceId: ids[i], ok: true, _fetchedAt: fetchedAt, ...annotateStatusPayload(ids[i], r.value as Record<string, unknown>) }
              : { deviceId: ids[i], ok: false, error: (r.reason as Error)?.message ?? String(r.reason) },
          );
          const batchFmt = resolveFormat();
          if (isJsonMode() || batchFmt === 'json') {
            printJson(batch);
          } else if (batchFmt === 'jsonl') {
            for (const entry of batch) {
              console.log(JSON.stringify(entry));
            }
          } else {
            const rawFields = resolveFields();
            for (const entry of batch) {
              const { deviceId, ok, error, _fetchedAt: ts, ...status } = entry as Record<string, unknown>;
              console.log(`\n─── ${String(deviceId)} ───`);
              if (!ok) {
                console.error(`  error: ${String(error)}`);
              } else {
                const statusMap = status as Record<string, unknown>;
                const fields = rawFields
                  ? resolveFieldList(rawFields, Object.keys(statusMap))
                  : undefined;
                const displayStatus: Record<string, unknown> = fields
                  ? Object.fromEntries(fields.map((f) => [f, statusMap[f] ?? null]))
                  : statusMap;
                printKeyValue(displayStatus);
                console.error(`  fetched at ${String(ts)}`);
              }
            }
          }
          return;
        }

        const deviceId = resolveDeviceId(deviceIdArg, options.name, {
          strategy: (options.nameStrategy as NameResolveStrategy | undefined) ?? 'fuzzy',
          type: options.nameType,
          category: options.nameCategory,
          room: options.nameRoom,
        });
        const body = annotateStatusPayload(deviceId, await fetchDeviceStatus(deviceId));
        const fetchedAt = new Date().toISOString();
        const fmt = resolveFormat();

        if (fmt === 'json' && process.argv.includes('--json')) {
          printJson({ ...(body as object), _fetchedAt: fetchedAt });
          return;
        }

        if (fmt !== 'table') {
          const statusWithTs = { ...(body as Record<string, unknown>), _fetchedAt: fetchedAt };
          const allHeaders = Object.keys(statusWithTs);
          const allRows = [Object.values(statusWithTs) as unknown[]];
          const rawFields = resolveFields();
          const fields = rawFields
            ? resolveFieldList(rawFields, allHeaders)
            : undefined;
          renderRows(allHeaders, allRows, fmt, fields);
          return;
        }

        printKeyValue(body);
        console.error(`\nfetched at ${fetchedAt}`);
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot devices command <deviceId> <command> [parameter]
  devices
    .command('command')
    .description('Send a control command to a device')
    .argument('[deviceId]', 'Target device ID (or use --name)')
    .argument('[cmd]', 'Command name, e.g. turnOn, turnOff, setColor, setBrightness, setAll, startClean')
    .argument('[parameter]', 'Command parameter. Omit for commands like turnOn/turnOff (defaults to "default"). Format depends on the command (see below). Negative numbers like -1 are accepted as-is (use `--` before them only if Commander mis-parses in your shell).')
    .allowUnknownOption()
    .option('--name <query>', 'Resolve device by fuzzy name instead of deviceId', stringArg('--name'))
    .option('--name-strategy <s>', `Name match strategy: ${ALL_STRATEGIES.join('|')} (default for command: require-unique)`, stringArg('--name-strategy'))
    .option('--name-type <type>', 'Narrow --name by device type (e.g. "Bot", "Color Bulb")', stringArg('--name-type'))
    .option('--name-category <cat>', 'Narrow --name by category: physical|ir', enumArg('--name-category', ['physical', 'ir'] as const))
    .option('--name-room <room>', 'Narrow --name by room name (substring match)', stringArg('--name-room'))
    .option('--type <commandType>', 'Command type: "command" for built-in commands (default), "customize" for user-defined IR buttons', enumArg('--type', COMMAND_TYPES), 'command')
    .option('--yes', 'Confirm a destructive command in an explicit dev profile. --dry-run is always allowed without --yes.')
    .option('--explain', 'Print a human-readable summary of what this command would do (risk level, device type, idempotency) then exit without executing.')
    .option('--allow-unknown-device', 'Allow targeting a deviceId that is not in the local cache. By default unknown IDs exit 2 so --dry-run is a reliable pre-flight gate; use this flag for scripted pass-through.')
    .option('--skip-param-validation', 'Skip client-side parameter validation (escape hatch — prefer fixing the argument over using this).')
    .option('--idempotency-key <key>', 'Client-supplied key to dedupe retries. process-local 60s window; cache is per Node process (MCP session, batch run, plan run). Independent CLI invocations do not share cache.', stringArg('--idempotency-key'))
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
  Keypad createKey/deleteKey, …) are blocked by default. Use the reviewed plan
  flow instead, or --dry-run to preview without sending.

Examples:
  $ switchbot devices command ABC123 turnOn
  $ switchbot devices command ABC123 setColor "255:0:0"
  $ switchbot devices command ABC123 setAll "26,1,3,on"
  $ switchbot devices command ABC123 startClean '{"action":"sweep","param":{"fanLevel":2,"times":1}}'
  $ switchbot devices command ABC123 "MyButton" --type customize
  $ switchbot devices command <lockId> unlock --dry-run
`)
    .action(async (deviceIdArg: string | undefined, cmdArg: string | undefined, parameter: string | undefined, options: { name?: string; nameStrategy?: string; nameType?: string; nameCategory?: 'physical' | 'ir'; nameRoom?: string; type: string; yes?: boolean; explain?: boolean; allowUnknownDevice?: boolean; skipParamValidation?: boolean; idempotencyKey?: string }) => {
      // Declared outside try so the DryRunSignal catch branch can reference them.
      let _deviceId: string | undefined;
      let _cmd: string | undefined;
      let _parsedParam: unknown;
      try {
        // BUG-FIX: When --name is provided, Commander fills positionals left-to-right
        // starting at [deviceId]. Shift them back to their semantic slots.
        let cmd: string;
        let effectiveDeviceIdArg: string | undefined;
        if (options.name) {
          // `--name "x" <cmd> [parameter]` → Commander binds deviceIdArg=<cmd>, cmdArg=[parameter].
          if (!deviceIdArg) {
            throw new UsageError('Command name is required (e.g. turnOn, turnOff, setAll).');
          }
          cmd = deviceIdArg;
          if (cmdArg !== undefined) {
            if (parameter !== undefined) {
              throw new UsageError('Too many positional arguments after --name. Expected: --name <query> <cmd> [parameter].');
            }
            parameter = cmdArg;
          }
          effectiveDeviceIdArg = undefined;
        } else {
          if (!cmdArg) {
            throw new UsageError('Command name is required (e.g. turnOn, turnOff, setAll).');
          }
          cmd = cmdArg;
          effectiveDeviceIdArg = deviceIdArg;
        }

        const deviceId = resolveDeviceId(effectiveDeviceIdArg, options.name, {
          // Mutating command → default require-unique (never silently pick between ambiguous matches).
          strategy: (options.nameStrategy as NameResolveStrategy | undefined) ?? 'require-unique',
          type: options.nameType,
          category: options.nameCategory,
          room: options.nameRoom,
        });
        _deviceId = deviceId;
        if (!getCachedDevice(deviceId)) {
          if (options.allowUnknownDevice) {
            console.error(
              `Note: device ${deviceId} is not in the local cache — run 'switchbot devices list' first to enable command validation. (--allow-unknown-device is set, continuing.)`,
            );
          } else {
            const cache = loadCache();
            const allIds = cache ? Object.keys(cache.devices) : [];
            const candidates = allIds
              .filter((id) => id.toLowerCase().includes(deviceId.toLowerCase()) || id.startsWith(deviceId.slice(0, 4)))
              .slice(0, 5)
              .map((id) => {
                const dev = cache!.devices[id];
                return { deviceId: id, name: dev.name, type: dev.type };
              });
            throw new StructuredUsageError(
              `Unknown deviceId "${deviceId}" — not in local cache. Run 'switchbot devices list' first, or pass --allow-unknown-device to bypass this check.`,
              {
                error: 'unknown_device_id',
                deviceId,
                candidates,
                hint: `Pass --allow-unknown-device to skip this check (and rely on the API for validation).`,
              },
            );
          }
        }
        const validation = validateCommand(deviceId, cmd, parameter, options.type);
        if (!validation.ok) {
          const err = validation.error;
          let hint = err.hint;
          if (err.kind === 'unknown-command') {
            const cached = getCachedDevice(deviceId);
            if (cached) {
              const extra =
                `Run 'switchbot devices commands ${JSON.stringify(cached.type)}' for parameter formats and descriptions.\n` +
                `(If the catalog is out of date, run 'switchbot devices list' to refresh the local cache, or pass --type customize for custom IR buttons.)`;
              hint = hint ? `${hint}\n${extra}` : extra;
            }
          }
          exitWithError({
            code: 2,
            kind: 'usage',
            message: err.message,
            hint,
            context: { validationKind: err.kind },
          });
        }

        // Case-only mismatch: emit a warning and continue with the canonical name.
        if (validation.caseNormalizedFrom && validation.normalized) {
          console.error(
            `Note: '${validation.caseNormalizedFrom}' normalized to '${validation.normalized}' (case mismatch). Use exact casing to silence this warning.`
          );
          cmd = validation.normalized;
        } else if (validation.normalized) {
          cmd = validation.normalized;
        }

        // Raw-parameter validation (runs for known (deviceType, command) pairs only).
        const cachedForParam = getCachedDevice(deviceId);
        if (cachedForParam && options.type === 'command' && !options.skipParamValidation) {
          const paramCheck = validateParameter(cachedForParam.type, cmd, parameter);
          if (!paramCheck.ok) {
            exitWithError({
              message: `Error: ${paramCheck.error}`,
              context: { command: cmd, deviceType: cachedForParam.type, deviceId, humanHint: paramCheck.error },
            });
          }
          if (paramCheck.normalized !== undefined) parameter = paramCheck.normalized;
        }

        const cachedForGuard = getCachedDevice(deviceId);

        // --explain: print intent + risk metadata without executing
        if (options.explain) {
          const isDestructive = isDestructiveCommand(cachedForGuard?.type, cmd, options.type);
          const reason = getDestructiveReason(cachedForGuard?.type, cmd, options.type);
          const riskLevel = isDestructive ? 'high' : options.type === 'command' ? 'medium' : 'low';
          const recommendedMode = isDestructive ? 'review-before-execute' : 'direct';
          if (isJsonMode()) {
            printJson({
              intent: `Send command "${cmd}" to device ${deviceId}`,
              deviceType: cachedForGuard?.type ?? 'unknown',
              deviceName: cachedForGuard?.name ?? null,
              command: cmd,
              parameter: parameter ?? null,
              commandType: options.type,
              riskLevel,
              requiresConfirmation: isDestructive,
              safetyReason: reason ?? null,
              recommendedMode,
              note: 'This is a dry explanation only — command was NOT executed.',
            });
          } else {
            console.log(`Command: ${cmd} on device ${deviceId}`);
            console.log(`Device type: ${cachedForGuard?.type ?? 'unknown'}${cachedForGuard?.name ? ` (${cachedForGuard.name})` : ''}`);
            console.log(`Parameter: ${parameter ?? '(none)'}`);
            console.log(`Risk level: ${riskLevel}`);
            if (reason) console.log(`Safety reason: ${reason}`);
            if (isDestructive) console.log(`Requires plan approval by default. ${destructiveExecutionHint()}`);
            console.log('(not executed — remove --explain to run)');
          }
          process.exit(0);
        }

        const destructive = isDestructiveCommand(cachedForGuard?.type, cmd, options.type);
        if (!isDryRun() && destructive && !options.yes && !allowsDirectDestructiveExecution()) {
          const typeLabel = cachedForGuard?.type ?? 'unknown';
          const reason = getDestructiveReason(cachedForGuard?.type, cmd, options.type);
          exitWithError({
            kind: 'guard',
            message: `Direct destructive execution disabled — destructive command "${cmd}" on ${typeLabel}.`,
            hint: reason ? `${destructiveExecutionHint()} Reason: ${reason}` : destructiveExecutionHint(),
            context: {
              command: cmd,
              deviceType: typeLabel,
              deviceId,
              directExecutionAllowed: false,
              requiredWorkflow: 'plan-approval',
              ...(reason ? { safetyReason: reason, destructiveReason: reason } : {}),
            },
          });
        }

        if (!options.yes && !isDryRun() && destructive) {
          const typeLabel = cachedForGuard?.type ?? 'unknown';
          const reason = getDestructiveReason(cachedForGuard?.type, cmd, options.type);
          exitWithError({
            kind: 'guard',
            message: `Refusing to run destructive command "${cmd}" on ${typeLabel} without --yes.`,
            hint: reason
              ? `Re-run with --yes only from an explicit dev profile, or use the reviewed plan flow. Reason: ${reason}`
              : `Re-run with --yes only from an explicit dev profile, use the reviewed plan flow, or --dry-run to preview without sending.`,
            context: { command: cmd, deviceType: typeLabel, deviceId, ...(reason ? { safetyReason: reason, destructiveReason: reason } : {}) },
          });
        }

        // Warn when --yes is given but the command is not destructive (no-op flag)
        if (options.yes && !destructive && !isDryRun()) {
          console.error(`Note: --yes has no effect; "${cmd}" is not a destructive command.`);
        }

        // parameter may be a JSON object string (e.g. S10 startClean) or a plain string
        let parsedParam: unknown = parameter ?? 'default';
        if (parameter) {
          try {
            parsedParam = JSON.parse(parameter);
          } catch {
            // keep as string
          }
        }
        // Capture for DryRunSignal catch branch (which runs after executeCommand throws).
        _cmd = cmd;
        _parsedParam = parsedParam;

        const body = await executeCommand(
          deviceId,
          cmd,
          parsedParam,
          options.type as 'command' | 'customize',
          undefined,
          { idempotencyKey: options.idempotencyKey }
        );

        const isIr = getCachedDevice(deviceId)?.category === 'ir';
        const verification = isIr
          ? {
              verifiable: false,
              reason: 'IR transmission is unidirectional; no receipt acknowledgment is possible.',
              suggestedFollowup: 'Confirm visible change manually or via a paired state sensor.',
            }
          : null;

        if (isJsonMode()) {
          const result: Record<string, unknown> = { ok: true, command: cmd, deviceId };
          if (isIr) {
            result.subKind = 'ir-no-feedback';
            result.verification = verification;
          }
          if (body && typeof body === 'object' && Object.keys(body as object).length > 0) {
            Object.assign(result, body);
          }
          printJson(result);
          return;
        }

        if (isIr) {
          console.log(`→ IR signal sent: ${cmd} (no feedback — fire-and-forget)`);
          console.error('⚠ IR (unverifiable) — no receipt acknowledgment. Confirm state manually.');
        } else {
          console.log(`✓ Command sent: ${cmd}`);
          if (body && typeof body === 'object' && Object.keys(body as object).length > 0) {
            printKeyValue(body as Record<string, unknown>);
          }
        }
      } catch (error) {
        // Re-throw mock process.exit signals (Vitest intercepts process.exit as thrown
        // Error('__exit__')) so they aren't double-handled and the exit code is preserved.
        if (error instanceof Error && error.message === '__exit__') throw error;
        if (error instanceof DryRunSignal) {
          const commandType = (options.type ?? 'command') as string;
          const wouldSend = { deviceId: _deviceId, command: _cmd, parameter: _parsedParam, commandType };
          if (isJsonMode()) {
            printJson({ dryRun: true, wouldSend });
          } else {
            console.log(`◦ dry-run intercepted for ${_cmd} on ${_deviceId}; see stderr preview for the HTTP request.`);
          }
          return;
        }
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
        const headers = ['type', 'role', 'category', 'commands', 'aliases'];
        const rows = catalog.map((e) => [
          e.type,
          e.role ?? '—',
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
      try {
        // First try the joined form so legacy multi-word unquoted input still
        // works (`devices commands Air Conditioner` → "Air Conditioner"). If
        // that doesn't match and every individual token resolves on its own,
        // treat it as variadic and emit a section per type.
        const joined = typeParts.join(' ');
        const joinedMatch = findCatalogEntry(joined);
        if (joinedMatch && !Array.isArray(joinedMatch)) {
          if (isJsonMode()) {
            printJson(normalizeCatalogForJson(joinedMatch));
          } else {
            renderCatalogEntry(joinedMatch);
          }
          return;
        }

        if (typeParts.length > 1) {
          const individualMatches: DeviceCatalogEntry[] = [];
          for (const t of typeParts) {
            const m = findCatalogEntry(t);
            if (!m || Array.isArray(m)) {
              individualMatches.length = 0;
              break;
            }
            individualMatches.push(m);
          }
          if (individualMatches.length === typeParts.length) {
            if (isJsonMode()) {
              printJson(individualMatches.map(normalizeCatalogForJson));
            } else {
              individualMatches.forEach((entry, i) => {
                if (i > 0) console.log('');
                renderCatalogEntry(entry);
              });
            }
            return;
          }
        }

        if (!joinedMatch) {
          throw new UsageError(
            `No device type matches "${joined}". Try 'switchbot devices types' to see the full list.`
          );
        }
        // joinedMatch is an ambiguous-match array here
        const types = (joinedMatch as DeviceCatalogEntry[]).map((m) => m.type).join(', ');
        throw new UsageError(`"${joined}" matches multiple types: ${types}. Be more specific.`);
      } catch (error) {
        handleError(error);
      }
    });

  // switchbot devices describe <deviceId>
  devices
    .command('describe')
    .description('Describe a device by ID: metadata + supported commands + status fields (1 API call)')
    .argument('[deviceId]', 'Target device ID (or use --name)')
    .option('--name <query>', 'Resolve device by fuzzy name instead of deviceId', stringArg('--name'))
    .option('--name-strategy <s>', `Name match strategy: ${ALL_STRATEGIES.join('|')} (default: fuzzy)`, stringArg('--name-strategy'))
    .option('--name-type <type>', 'Narrow --name by device type', stringArg('--name-type'))
    .option('--name-category <cat>', 'Narrow --name by category: physical|ir', enumArg('--name-category', ['physical', 'ir'] as const))
    .option('--name-room <room>', 'Narrow --name by room name (substring match)', stringArg('--name-room'))
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
    suggestedActions: [{command, parameter?, description}],
    expandHint?: {command, flags, example}  // present when the type supports 'devices expand'
  }

Examples:
  $ switchbot devices describe ABC123DEF456
  $ switchbot devices describe ABC123DEF456 --live
  $ switchbot devices describe ABC123DEF456 --json
  $ switchbot devices describe <lockId> --json | jq '.capabilities.commands[] | select(.destructive)'
`)
    .action(async (deviceIdArg: string | undefined, options: { name?: string; nameStrategy?: string; nameType?: string; nameCategory?: 'physical' | 'ir'; nameRoom?: string; live?: boolean }) => {
      try {
        const deviceId = resolveDeviceId(deviceIdArg, options.name, {
          strategy: (options.nameStrategy as NameResolveStrategy | undefined) ?? 'fuzzy',
          type: options.nameType,
          category: options.nameCategory,
          room: options.nameRoom,
        });
        const result = await describeDevice(deviceId, options);
        const { device, isPhysical, typeName, controlType, catalog, capabilities, source, suggestedActions: picks } = result;

        if (isJsonMode()) {
          const expandHint = catalog ? EXPAND_HINTS[catalog.type] : undefined;
          printJson({
            device,
            controlType,
            catalog,
            capabilities,
            source,
            suggestedActions: picks,
            ...(result.catalogNote ? { catalogNote: result.catalogNote } : {}),
            ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
            ...(expandHint ? { expandHint: { command: expandHint.command, flags: expandHint.flags, example: `switchbot devices expand ${deviceId} ${expandHint.command} ${expandHint.flags}` } } : {}),
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
        if (result.warnings && result.warnings.length > 0) {
          for (const warning of result.warnings) {
            console.log(`Warning: ${warning}`);
          }
          console.log('');
        }
        if (!catalog) {
          console.log(`(Type "${typeName}" is not in the built-in catalog — no command reference available.)`);
          if (result.catalogNote) {
            console.log(result.catalogNote);
          }
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
          const message = `${error.message} Try 'switchbot devices list' to see the full list.`;
          exitWithError({
            code: 1,
            kind: 'runtime',
            message,
            extra: { errorClass: 'runtime', transient: false },
          });
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

function normalizeCatalogForJson(entry: DeviceCatalogEntry): object {
  return {
    ...entry,
    commands: entry.commands.map((c) => {
      const tier = deriveSafetyTier(c, entry);
      const reason = getCommandSafetyReason(c);
      return {
        ...c,
        safetyTier: tier,
        ...(reason ? { safetyReason: reason } : {}),
      };
    }),
  };
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
    const hasExamples = entry.commands.some((c) => c.exampleParams && c.exampleParams.length > 0);
    const rows = entry.commands.map((c) => {
      const tier = deriveSafetyTier(c, entry);
      const flags: string[] = [];
      if (c.commandType === 'customize') flags.push('customize');
      if (tier === 'destructive') flags.push('!destructive');
      const label = flags.length > 0 ? `${c.command}  [${flags.join(', ')}]` : c.command;
      const base = [label, c.parameter, c.description];
      return hasExamples ? [...base, (c.exampleParams ?? []).join(' | ') || ''] : base;
    });
    const tableHeaders = hasExamples
      ? ['command', 'parameter', 'description', 'example']
      : ['command', 'parameter', 'description'];
    printTable(tableHeaders, rows);
    const hasDestructive = entry.commands.some(
      (c) => deriveSafetyTier(c, entry) === 'destructive',
    );
    if (hasDestructive) {
      console.log('\n[!destructive] commands have hard-to-reverse real-world effects — confirm before issuing.');
    }
  }

  if (entry.statusFields && entry.statusFields.length > 0) {
    console.log('\nStatus fields (from "devices status"):');
    console.log('  ' + entry.statusFields.join(', '));
    console.log('  Note: statusFields are advisory; actual fields can vary by firmware and device variant.');
  }

  const expandHint = EXPAND_HINTS[entry.type];
  if (expandHint) {
    console.log(`\nTip: Use 'devices expand <id> ${expandHint.command} ${expandHint.flags}' for semantic flags instead of raw parameters.`);
  }
}
