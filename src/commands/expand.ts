import { Command } from 'commander';
import { handleError, isJsonMode, printJson, UsageError } from '../utils/output.js';
import { getCachedDevice } from '../devices/cache.js';
import { executeCommand, isDestructiveCommand, getDestructiveReason } from '../lib/devices.js';
import { isDryRun } from '../utils/flags.js';
import { resolveDeviceId } from '../utils/name-resolver.js';
import { DryRunSignal } from '../api/client.js';

// ---- Mapping tables --------------------------------------------------------

const AC_MODE_MAP: Record<string, number> = { auto: 1, cool: 2, dry: 3, fan: 4, heat: 5 };
const AC_FAN_MAP: Record<string, number>  = { auto: 1, low: 2, mid: 3, high: 4 };
const CURTAIN_MODE_MAP: Record<string, string> = { default: 'ff', performance: '0', silent: '1' };
const RELAY_MODE_MAP: Record<string, number> = { toggle: 0, edge: 1, detached: 2, momentary: 3 };
const BLIND_DIRECTION = new Set(['up', 'down']);

// ---- Translators -----------------------------------------------------------

function buildAcSetAll(opts: {
  temp?: string; mode?: string; fan?: string; power?: string;
}): string {
  if (!opts.temp) throw new UsageError('--temp is required for setAll (e.g. --temp 26)');
  if (!opts.mode) throw new UsageError('--mode is required for setAll (auto|cool|dry|fan|heat)');
  if (!opts.fan)  throw new UsageError('--fan is required for setAll (auto|low|mid|high)');
  if (!opts.power) throw new UsageError('--power is required for setAll (on|off)');

  const temp = parseInt(opts.temp, 10);
  if (!Number.isFinite(temp) || temp < 16 || temp > 30) {
    throw new UsageError(`--temp must be an integer between 16 and 30 (got "${opts.temp}")`);
  }
  const modeInt = AC_MODE_MAP[opts.mode.toLowerCase()];
  if (modeInt === undefined) {
    throw new UsageError(`--mode must be one of: auto, cool, dry, fan, heat (got "${opts.mode}")`);
  }
  const fanInt = AC_FAN_MAP[opts.fan.toLowerCase()];
  if (fanInt === undefined) {
    throw new UsageError(`--fan must be one of: auto, low, mid, high (got "${opts.fan}")`);
  }
  const power = opts.power.toLowerCase();
  if (power !== 'on' && power !== 'off') {
    throw new UsageError(`--power must be "on" or "off" (got "${opts.power}")`);
  }
  return `${temp},${modeInt},${fanInt},${power}`;
}

function buildCurtainSetPosition(opts: {
  position?: string; mode?: string;
}): string {
  if (!opts.position) throw new UsageError('--position is required (0-100)');
  const pos = parseInt(opts.position, 10);
  if (!Number.isFinite(pos) || pos < 0 || pos > 100) {
    throw new UsageError(`--position must be an integer between 0 and 100 (got "${opts.position}")`);
  }
  const modeStr = opts.mode ? CURTAIN_MODE_MAP[opts.mode.toLowerCase()] : 'ff';
  if (modeStr === undefined) {
    throw new UsageError(`--mode must be one of: default, performance, silent (got "${opts.mode}")`);
  }
  return `0,${modeStr},${pos}`;
}

function buildBlindTiltSetPosition(opts: {
  direction?: string; angle?: string;
}): string {
  if (!opts.direction) throw new UsageError('--direction is required (up|down)');
  if (!opts.angle)     throw new UsageError('--angle is required (0-100)');
  const dir = opts.direction.toLowerCase();
  if (!BLIND_DIRECTION.has(dir)) {
    throw new UsageError(`--direction must be "up" or "down" (got "${opts.direction}")`);
  }
  const angle = parseInt(opts.angle, 10);
  if (!Number.isFinite(angle) || angle < 0 || angle > 100) {
    throw new UsageError(`--angle must be an integer between 0 and 100 (got "${opts.angle}")`);
  }
  return `${dir};${angle}`;
}

function buildRelaySetMode(opts: {
  channel?: string; mode?: string;
}): string {
  if (!opts.channel) throw new UsageError('--channel is required (1 or 2)');
  if (!opts.mode)    throw new UsageError('--mode is required (toggle|edge|detached|momentary)');
  const ch = parseInt(opts.channel, 10);
  if (ch !== 1 && ch !== 2) {
    throw new UsageError(`--channel must be 1 or 2 (got "${opts.channel}")`);
  }
  const modeInt = RELAY_MODE_MAP[opts.mode.toLowerCase()];
  if (modeInt === undefined) {
    throw new UsageError(`--mode must be one of: toggle, edge, detached, momentary (got "${opts.mode}")`);
  }
  return `${ch};${modeInt}`;
}

// ---- Registration ----------------------------------------------------------

export function registerExpandCommand(devices: Command): void {
  devices
    .command('expand')
    .description('Send a command with semantic flags instead of raw positional parameters')
    .argument('[deviceId]', 'Target device ID from "devices list" (or use --name)')
    .argument('[command]', 'Command name: setAll (AC), setPosition (Curtain/Blind Tilt), setMode (Relay Switch 2)')
    .option('--name <query>', 'Resolve device by fuzzy name instead of deviceId')
    .option('--temp <celsius>', 'AC setAll: temperature in Celsius (16-30)')
    .option('--mode <mode>', 'AC: auto|cool|dry|fan|heat  Curtain: default|performance|silent  Relay: toggle|edge|detached|momentary')
    .option('--fan <speed>', 'AC setAll: fan speed auto|low|mid|high')
    .option('--power <state>', 'AC setAll: on|off')
    .option('--position <percent>', 'Curtain setPosition: 0-100 (0=open, 100=closed)')
    .option('--direction <dir>', 'Blind Tilt setPosition: up|down')
    .option('--angle <percent>', 'Blind Tilt setPosition: 0-100 (0=closed, 100=open)')
    .option('--channel <n>', 'Relay Switch 2 setMode: channel 1 or 2')
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

Examples:
  $ switchbot devices expand <acId>      setAll       --temp 26 --mode cool --fan low --power on
  $ switchbot devices expand <curtainId> setPosition  --position 50 --mode silent
  $ switchbot devices expand <blindId>   setPosition  --direction up --angle 50
  $ switchbot devices expand <relayId>   setMode      --channel 1 --mode edge
  $ switchbot devices expand <acId>      setAll       --temp 22 --mode heat --fan auto --power on --dry-run
  $ switchbot devices expand --name "客厅空调" setAll --temp 26 --mode cool --fan low --power on
`)
    .action(async (
      deviceIdArg: string | undefined,
      commandArg: string | undefined,
      options: {
        name?: string;
        temp?: string; mode?: string; fan?: string; power?: string;
        position?: string; direction?: string; angle?: string;
        channel?: string; yes?: boolean;
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

        deviceId = resolveDeviceId(effectiveDeviceIdArg, options.name);
        if (!effectiveCommand) throw new UsageError('A command argument is required (setAll, setPosition, setMode).');

        command = effectiveCommand;
        const cached = getCachedDevice(deviceId);
        const deviceType = cached?.type ?? '';

        let parameter: string;

        if (command === 'setAll') {
          parameter = buildAcSetAll(options);
        } else if (command === 'setPosition') {
          if (!cached) {
            throw new UsageError(
              `Device ${deviceId} is not in the local cache — run 'switchbot devices list' first so 'expand' knows whether this is a Curtain or a Blind Tilt.`
            );
          }
          const isBlind = deviceType.startsWith('Blind Tilt');
          parameter = isBlind
            ? buildBlindTiltSetPosition(options)
            : buildCurtainSetPosition(options);
        } else if (command === 'setMode' && deviceType.startsWith('Relay Switch')) {
          parameter = buildRelaySetMode(options);
        } else {
          throw new UsageError(
            `'expand' does not support "${command}" for device type "${deviceType || 'unknown'}". ` +
            `Use 'switchbot devices command' to send raw parameters instead.`
          );
        }

        if (!options.yes && !isDryRun() && isDestructiveCommand(deviceType, command, 'command')) {
          const reason = getDestructiveReason(deviceType, command, 'command');
          if (isJsonMode()) {
            console.error(JSON.stringify({ error: { code: 2, kind: 'guard',
              message: `"${command}" on ${deviceType || 'device'} is destructive and requires --yes.`,
              hint: reason ? `Re-run with --yes. Reason: ${reason}` : 'Re-run with --yes to confirm.',
            }}));
          } else {
            console.error(`Refusing to run destructive command "${command}" without --yes.`);
            if (reason) console.error(`Reason: ${reason}`);
          }
          process.exit(2);
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
