import { Command } from 'commander';
import { intArg, stringArg, enumArg } from '../utils/arg-parsers.js';
import { handleError, isJsonMode, printJson, UsageError, exitWithError } from '../utils/output.js';
import { getCachedDevice } from '../devices/cache.js';
import { executeCommand, isDestructiveCommand, getDestructiveReason } from '../lib/devices.js';
import { findCatalogEntry } from '../devices/catalog.js';
import { isDryRun } from '../utils/flags.js';
import { resolveDeviceId, ALL_STRATEGIES, type NameResolveStrategy } from '../utils/name-resolver.js';
import { DryRunSignal } from '../api/client.js';
import {
  buildAcSetAll,
  buildCurtainSetPosition,
  buildBlindTiltSetPosition,
  buildRelaySetMode,
  buildBrightnessSet,
  buildColorSet,
  buildColorTemperatureSet,
  isLightingCommandSupported,
} from '../devices/param-validator.js';

// ---- Registration ----------------------------------------------------------

export function registerExpandCommand(devices: Command): void {
  devices
    .command('expand')
    .description('Send a command with semantic flags instead of raw positional parameters')
    .argument('[deviceId]', 'Target device ID from "devices list" (or use --name)')
    .argument('[command]', 'Command name: setAll (AC), setPosition (Curtain/Blind Tilt), setMode (Relay Switch 2), setBrightness/setColor/setColorTemperature (lighting)')
    .option('--name <query>', 'Resolve device by fuzzy name instead of deviceId', stringArg('--name'))
    .option('--name-strategy <s>', `Name match strategy: ${ALL_STRATEGIES.join('|')} (default: require-unique)`, stringArg('--name-strategy'))
    .option('--name-type <type>', 'Narrow --name by device type (e.g. "Curtain", "Air Conditioner")', stringArg('--name-type'))
    .option('--name-category <cat>', 'Narrow --name by category: physical|ir', enumArg('--name-category', ['physical', 'ir'] as const))
    .option('--name-room <room>', 'Narrow --name by room name (substring match)', stringArg('--name-room'))
    .option('--temp <celsius>', 'AC setAll: temperature in Celsius (16-30)', intArg('--temp', { min: 16, max: 30 }))
    .option('--mode <mode>', 'AC: auto|cool|dry|fan|heat  Curtain: default|performance|silent  Relay: toggle|edge|detached|momentary', stringArg('--mode'))
    .option('--fan <speed>', 'AC setAll: fan speed auto|low|mid|high', stringArg('--fan'))
    .option('--power <state>', 'AC setAll: on|off', stringArg('--power'))
    .option('--position <percent>', 'Curtain setPosition: 0-100 (0=open, 100=closed)', intArg('--position', { min: 0, max: 100 }))
    .option('--direction <dir>', 'Blind Tilt setPosition: up|down', stringArg('--direction'))
    .option('--angle <percent>', 'Blind Tilt setPosition: 0-100 (0=closed, 100=open)', intArg('--angle', { min: 0, max: 100 }))
    .option('--channel <n>', 'Relay Switch 2 setMode: channel 1 or 2', intArg('--channel', { min: 1, max: 2 }))
    .option('--brightness <percent>', 'setBrightness: 0-100 percent (minimum depends on device)', intArg('--brightness', { min: 0, max: 100 }))
    .option('--color <value>', 'setColor: R:G:B, #RRGGBB, or named color (red, blue, etc.)', stringArg('--color'))
    .option('--color-temp <kelvin>', 'setColorTemperature: 2700-6500 Kelvin', intArg('--color-temp', { min: 2700, max: 6500 }))
    .option('--yes', 'Confirm destructive commands')
    .addHelpText('after', `
Translates semantic flags into the wire parameter format, then sends the command.

Supported expansions:

  Air Conditioner — setAll
    --temp 26 --mode cool --fan low --power on  →  "26,2,2,on"
    --mode values: auto | cool | dry | fan | heat
    --fan values:  auto | low | mid | high

  Curtain / Curtain 3 — setPosition
    --position 50 [--mode silent]  →  "0,1,50"
    --mode values: default (ff) | performance (0) | silent (1)

  Blind Tilt — setPosition
    --direction up --angle 50  →  "up;50"

  Relay Switch 2PM — setMode
    --channel 1 --mode edge  →  "1;1"
    --mode values: toggle (0) | edge (1) | detached (2) | momentary (3)

  Color Bulb / Strip Light / Ceiling Light — setBrightness
    --brightness 80  →  "80"

  Color Bulb / Strip Light / Floor Lamp — setColor
    --color "255:0:0"  →  "255:0:0"
    --color "#FF0000"  →  "255:0:0"
    --color red        →  "255:0:0"

  Color Bulb / Strip Light / Ceiling Light — setColorTemperature
    --color-temp 4000  →  "4000"

Examples:
  $ switchbot devices expand <acId>      setAll               --temp 26 --mode cool --fan low --power on
  $ switchbot devices expand <curtainId> setPosition          --position 50 --mode silent
  $ switchbot devices expand <blindId>   setPosition          --direction up --angle 50
  $ switchbot devices expand <relayId>   setMode              --channel 1 --mode edge
  $ switchbot devices expand <stripId>   setBrightness        --brightness 80
  $ switchbot devices expand <bulbId>    setColor             --color "#FF0000"
  $ switchbot devices expand <bulbId>    setColorTemperature  --color-temp 4000
  $ switchbot devices expand --name "Living Room AC" setAll --temp 26 --mode cool --fan low --power on
`)
    .action(async (
      deviceIdArg: string | undefined,
      commandArg: string | undefined,
      options: {
        name?: string;
        nameStrategy?: string;
        nameType?: string;
        nameCategory?: 'physical' | 'ir';
        nameRoom?: string;
        temp?: string; mode?: string; fan?: string; power?: string;
        position?: string; direction?: string; angle?: string;
        channel?: string; brightness?: string; color?: string;
        colorTemp?: string; yes?: boolean;
      }
    ) => {
      let deviceId = '';
      let command = '';
      try {
        // When --name is provided, Commander assigns the first positional to deviceIdArg
        // and leaves commandArg undefined. Detect and shift.
        let effectiveDeviceIdArg = deviceIdArg;
        let effectiveCommand = commandArg;
        if (options.name && deviceIdArg && !commandArg) {
          effectiveCommand = deviceIdArg;
          effectiveDeviceIdArg = undefined;
        }

        deviceId = resolveDeviceId(effectiveDeviceIdArg, options.name, {
          strategy: (options.nameStrategy as NameResolveStrategy | undefined) ?? 'require-unique',
          type: options.nameType,
          category: options.nameCategory,
          room: options.nameRoom,
        });
        if (!effectiveCommand) throw new UsageError('A command argument is required (setAll, setPosition, setMode, setBrightness, setColor, setColorTemperature).');

        command = effectiveCommand;
        const cached = getCachedDevice(deviceId);
        const deviceType = cached?.type ?? '';

        let parameter: string;

        if (command === 'setAll') {
          if (!cached) {
            throw new UsageError(
              `Device ${deviceId} is not in the local cache — run 'switchbot devices list' first so 'expand' can verify this is an Air Conditioner.`
            );
          }
          if (deviceType !== 'Air Conditioner') {
            throw new UsageError(
              `"setAll" is only supported on Air Conditioner devices, but "${cached.type}" was found.`
            );
          }
          parameter = buildAcSetAll(options);
        } else if (command === 'setPosition') {
          if (!cached) {
            throw new UsageError(
              `Device ${deviceId} is not in the local cache — run 'switchbot devices list' first so 'expand' knows whether this is a Curtain or a Blind Tilt.`
            );
          }
          const positionTypes = ['Curtain', 'Curtain 3', 'Roller Shade', 'Blind Tilt'];
          if (!positionTypes.some(t => deviceType.startsWith(t))) {
            throw new UsageError(
              `"setPosition" is only supported on Curtain, Roller Shade, and Blind Tilt devices, but "${cached.type}" was found.`
            );
          }
          const isBlind = deviceType.startsWith('Blind Tilt');
          const isRollerShade = deviceType.startsWith('Roller Shade');
          if (isBlind) {
            parameter = buildBlindTiltSetPosition(options);
          } else if (isRollerShade) {
            if (!options.position) throw new UsageError('--position is required (0-100)');
            parameter = options.position;
          } else {
            parameter = buildCurtainSetPosition(options);
          }
        } else if (command === 'setMode' && deviceType.startsWith('Relay Switch')) {
          parameter = buildRelaySetMode(options);
        } else if (command === 'setBrightness' || command === 'setColor' || command === 'setColorTemperature') {
          if (!cached) {
            throw new UsageError(
              `Device "${deviceId}" is not in the local cache — run 'switchbot devices list' first so 'expand' can verify this device supports ${command}.`
            );
          }
          const catalogResult = findCatalogEntry(cached.type);
          const catalogEntry = Array.isArray(catalogResult) ? catalogResult[0] : catalogResult;
          const supportedHint = command === 'setColor'
            ? 'Color Bulb, Strip Light, Floor Lamp, and similar RGB lighting devices'
            : 'Color Bulb, Strip Light, Ceiling Light, Floor Lamp, and similar lighting devices';
          if (catalogEntry !== null) {
            // Device is in catalog — catalog is authoritative, no heuristic fallback
            if (!catalogEntry.commands.some((c: { command: string }) => c.command === command)) {
              throw new UsageError(
                `Device type "${cached.type}" does not support ${command}. Supported on: ${supportedHint}.`
              );
            }
          } else {
            // Device not in catalog — fall back to param-validator whitelist
            if (!isLightingCommandSupported(cached.type, command)) {
              throw new UsageError(
                `Device type "${cached.type}" does not support ${command}. Supported on: ${supportedHint}.`
              );
            }
          }
          if (command === 'setBrightness') {
            parameter = buildBrightnessSet(options, cached?.type);
          } else if (command === 'setColor') {
            parameter = buildColorSet(options);
          } else {
            parameter = buildColorTemperatureSet(options);
          }
        } else {
          throw new UsageError(
            `'expand' does not support "${command}" for device type "${deviceType || 'unknown'}". ` +
            `Supported: setAll (AC), setPosition (Curtain/Blind Tilt), setMode (Relay Switch), setBrightness/setColor/setColorTemperature (lighting). ` +
            `Use 'switchbot devices command' to send raw parameters instead.`
          );
        }

        if (!options.yes && !isDryRun() && isDestructiveCommand(deviceType, command, 'command')) {
          const reason = getDestructiveReason(deviceType, command, 'command');
          exitWithError({
            code: 2,
            kind: 'guard',
            message: `"${command}" on ${deviceType || 'device'} is destructive and requires --yes.`,
            hint: reason ? `Re-run with --yes. Reason: ${reason}` : 'Re-run with --yes to confirm.',
          });
        }

        const body = await executeCommand(deviceId, command, parameter, 'command');
        const isIr = cached?.category === 'ir';

        if (isJsonMode()) {
          const result: Record<string, unknown> = { ok: true, command, deviceId, parameter };
          if (isIr) result.subKind = 'ir-no-feedback';
          if (body && typeof body === 'object' && Object.keys(body).length > 0) result.response = body;
          printJson(result);
          return;
        }

        console.log(`✓ Command sent: ${command} (${parameter})`);
        if (isIr) console.log('  Note: IR command sent — no device confirmation (fire-and-forget).');
      } catch (error) {
        if (error instanceof DryRunSignal) {
          if (isJsonMode()) {
            printJson({ ok: true, dryRun: true, command, deviceId });
          } else {
            console.log(`◦ dry-run: ${command} would be sent to ${deviceId}`);
          }
          return;
        }
        handleError(error);
      }
    });
}
