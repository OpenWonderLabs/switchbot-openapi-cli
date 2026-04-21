import { UsageError } from '../utils/output.js';

export const AC_MODE_MAP: Record<string, number> = { auto: 1, cool: 2, dry: 3, fan: 4, heat: 5 };
export const AC_FAN_MAP: Record<string, number> = { auto: 1, low: 2, mid: 3, high: 4 };
export const CURTAIN_MODE_MAP: Record<string, string> = { default: 'ff', performance: '0', silent: '1' };
export const RELAY_MODE_MAP: Record<string, number> = { toggle: 0, edge: 1, detached: 2, momentary: 3 };
const BLIND_DIRECTION = new Set(['up', 'down']);

// ---- Semantic-flag builders (used by `devices expand`) --------------------

export function buildAcSetAll(opts: {
  temp?: string; mode?: string; fan?: string; power?: string;
}): string {
  if (!opts.temp) throw new UsageError('--temp is required for setAll (e.g. --temp 26)');
  if (!opts.mode) throw new UsageError('--mode is required for setAll (auto|cool|dry|fan|heat)');
  if (!opts.fan) throw new UsageError('--fan is required for setAll (auto|low|mid|high)');
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

export function buildCurtainSetPosition(opts: {
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

export function buildBlindTiltSetPosition(opts: {
  direction?: string; angle?: string;
}): string {
  if (!opts.direction) throw new UsageError('--direction is required (up|down)');
  if (!opts.angle) throw new UsageError('--angle is required (0-100)');
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

export function buildRelaySetMode(opts: {
  channel?: string; mode?: string;
}): string {
  if (!opts.channel) throw new UsageError('--channel is required (1 or 2)');
  if (!opts.mode) throw new UsageError('--mode is required (toggle|edge|detached|momentary)');
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

// ---- Raw-parameter validator (used by `devices command`) ------------------

export type ValidateResult =
  | { ok: true; normalized?: string }
  | { ok: false; error: string };

/**
 * Validate a raw wire-format parameter string for (deviceType, command)
 * combos where the shape is well-defined. Unknown combos pass through so
 * `devices command` remains a usable escape hatch for types/commands the
 * CLI hasn't modelled yet.
 *
 * On passthrough, `normalized` is left undefined so the caller keeps the
 * original parameter value (preserving the `undefined → "default"` default
 * for no-arg commands).
 */
export function validateParameter(
  deviceType: string | undefined,
  command: string,
  raw: string | undefined,
): ValidateResult {
  if (!deviceType) return { ok: true };

  if (deviceType === 'Air Conditioner' && command === 'setAll') {
    return validateAcSetAll(raw);
  }
  if (deviceType.startsWith('Curtain') && command === 'setPosition') {
    return validateCurtainSetPosition(raw);
  }
  if (deviceType.startsWith('Blind Tilt') && command === 'setPosition') {
    return validateBlindTiltSetPosition(raw);
  }
  if (deviceType.startsWith('Relay Switch') && command === 'setMode') {
    return validateRelaySetMode(raw);
  }
  if (command === 'setBrightness' && isBrightnessDevice(deviceType)) {
    return validateSetBrightness(raw);
  }
  if (command === 'setColor' && isColorDevice(deviceType)) {
    return validateSetColor(raw);
  }
  if (command === 'setColorTemperature' && isColorDevice(deviceType)) {
    return validateSetColorTemperature(raw);
  }

  return { ok: true };
}

function isBrightnessDevice(deviceType: string): boolean {
  return (
    deviceType === 'Color Bulb' ||
    deviceType === 'Strip Light' ||
    deviceType === 'Strip Light 3' ||
    deviceType === 'Ceiling Light' ||
    deviceType === 'Ceiling Light Pro' ||
    deviceType === 'Floor Lamp' ||
    deviceType === 'Light Strip' ||
    deviceType === 'Dimmer' ||
    deviceType === 'Fill Light'
  );
}

function isColorDevice(deviceType: string): boolean {
  return (
    deviceType === 'Color Bulb' ||
    deviceType === 'Strip Light' ||
    deviceType === 'Strip Light 3' ||
    deviceType === 'Ceiling Light' ||
    deviceType === 'Ceiling Light Pro' ||
    deviceType === 'Floor Lamp' ||
    deviceType === 'Light Strip' ||
    deviceType === 'Fill Light'
  );
}

function validateSetBrightness(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `setBrightness requires an integer 1-100 (percent). Example: "50".`,
    };
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: `setBrightness must be an integer 1-100, got ${JSON.stringify(raw)}. ${hintBrightnessRetry()}`,
    };
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    return {
      ok: false,
      error: `setBrightness must be an integer 1-100, got "${raw}". ${hintBrightnessRetry()}`,
    };
  }
  return { ok: true, normalized: String(n) };
}

function hintBrightnessRetry(): string {
  return `Ask the user whether they meant a percentage (1-100). Example: "50".`;
}

// B-12: setColor accepts R:G:B, R,G,B, #RRGGBB, #RGB, or a small CSS named color
// palette. All forms are normalized to `R:G:B` (the only wire shape SwitchBot
// accepts) so the caller can POST the result unchanged.
const NAMED_COLORS: Record<string, [number, number, number]> = {
  red: [255, 0, 0],
  green: [0, 128, 0],
  lime: [0, 255, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  white: [255, 255, 255],
  black: [0, 0, 0],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  pink: [255, 192, 203],
  brown: [165, 42, 42],
  grey: [128, 128, 128],
  gray: [128, 128, 128],
  warm: [255, 180, 100],
};

function validateSetColor(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `setColor requires a color. Expected one of: "R:G:B" (e.g. "255:0:0"), "#RRGGBB" (e.g. "#FF0000"), "#RGB", "R,G,B", or a named color (${Object.keys(NAMED_COLORS).slice(0, 8).join(', ')}, ...).`,
    };
  }
  const trimmed = raw.trim();

  // Named color.
  const named = NAMED_COLORS[trimmed.toLowerCase()];
  if (named) {
    return { ok: true, normalized: `${named[0]}:${named[1]}:${named[2]}` };
  }

  // Hex #RRGGBB or #RGB.
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return { ok: true, normalized: `${r}:${g}:${b}` };
    }
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      return { ok: true, normalized: `${r}:${g}:${b}` };
    }
    return {
      ok: false,
      error: `setColor "${raw}" is not valid hex. ${hintColorRetry()}`,
    };
  }

  // R:G:B or R,G,B — pick whichever separator appears.
  const sep = trimmed.includes(':') ? ':' : trimmed.includes(',') ? ',' : null;
  if (!sep) {
    return {
      ok: false,
      error: `setColor "${raw}" is not a recognized format. ${hintColorRetry()}`,
    };
  }
  const parts = trimmed.split(sep).map((s) => s.trim());
  if (parts.length !== 3) {
    return {
      ok: false,
      error: `setColor expects 3 components (R${sep}G${sep}B), got ${parts.length} (${JSON.stringify(raw)}). ${hintColorRetry()}`,
    };
  }
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^-?\d+$/.test(p)) {
      return {
        ok: false,
        error: `setColor component "${p}" is not an integer. ${hintColorRetry()}`,
      };
    }
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return {
        ok: false,
        error: `setColor components must be integers 0-255, got "${p}". ${hintColorRetry()}`,
      };
    }
    nums.push(n);
  }
  return { ok: true, normalized: `${nums[0]}:${nums[1]}:${nums[2]}` };
}

function hintColorRetry(): string {
  return `Expected "R:G:B" (e.g. "255:0:0"), "#RRGGBB", "#RGB", "R,G,B", or a named color.`;
}

function validateSetColorTemperature(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `setColorTemperature requires an integer Kelvin value 2700-6500. Example: "4000".`,
    };
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: `setColorTemperature must be an integer 2700-6500, got ${JSON.stringify(raw)}.`,
    };
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 2700 || n > 6500) {
    return {
      ok: false,
      error: `setColorTemperature must be an integer 2700-6500, got "${raw}".`,
    };
  }
  return { ok: true, normalized: String(n) };
}

function validateAcSetAll(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `setAll requires a parameter "<temp>,<mode>,<fan>,<on|off>". Example: "26,2,2,on".`,
    };
  }
  if (raw.startsWith('{') || raw.startsWith('[')) {
    return {
      ok: false,
      error: `setAll parameter must be a CSV string like "26,2,2,on", not JSON (got ${JSON.stringify(raw)}).`,
    };
  }
  const parts = raw.split(',');
  if (parts.length !== 4) {
    return {
      ok: false,
      error: `setAll expects 4 comma-separated fields "<temp>,<mode>,<fan>,<on|off>", got ${parts.length} (${JSON.stringify(raw)}). Example: "26,2,2,on".`,
    };
  }
  const [tempStr, modeStr, fanStr, powerStr] = parts.map((s) => s.trim());

  const temp = Number(tempStr);
  if (!Number.isInteger(temp) || temp < 16 || temp > 30) {
    return {
      ok: false,
      error: `setAll field 1 (temp) must be an integer 16-30, got "${tempStr}". Example: "26,2,2,on".`,
    };
  }
  const mode = Number(modeStr);
  if (!Number.isInteger(mode) || mode < 1 || mode > 5) {
    return {
      ok: false,
      error: `setAll field 2 (mode) must be 1-5 (1=auto 2=cool 3=dry 4=fan 5=heat), got "${modeStr}". Example: "26,2,2,on".`,
    };
  }
  const fan = Number(fanStr);
  if (!Number.isInteger(fan) || fan < 1 || fan > 4) {
    return {
      ok: false,
      error: `setAll field 3 (fan) must be 1-4 (1=auto 2=low 3=mid 4=high), got "${fanStr}". Example: "26,2,2,on".`,
    };
  }
  const power = powerStr.toLowerCase();
  if (power !== 'on' && power !== 'off') {
    return {
      ok: false,
      error: `setAll field 4 (power) must be "on" or "off", got "${powerStr}". Example: "26,2,2,on".`,
    };
  }
  return { ok: true, normalized: `${temp},${mode},${fan},${power}` };
}

function validateCurtainSetPosition(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `setPosition requires a parameter. Expected: "<0-100>" or "<index>,<ff|0|1>,<0-100>". Example: "50" or "0,ff,50".`,
    };
  }
  if (!raw.includes(',')) {
    const pos = Number(raw);
    if (!Number.isInteger(pos) || pos < 0 || pos > 100) {
      return {
        ok: false,
        error: `setPosition must be an integer 0-100, got "${raw}". Example: "50".`,
      };
    }
    return { ok: true, normalized: String(pos) };
  }
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 3) {
    return {
      ok: false,
      error: `setPosition tuple form expects 3 comma-separated fields "<index>,<ff|0|1>,<0-100>", got ${parts.length} (${JSON.stringify(raw)}).`,
    };
  }
  const [idxStr, modeStr, posStr] = parts;
  const idx = Number(idxStr);
  if (!Number.isInteger(idx) || idx < 0) {
    return {
      ok: false,
      error: `setPosition field 1 (index) must be a non-negative integer, got "${idxStr}".`,
    };
  }
  const modeLower = modeStr.toLowerCase();
  if (!['ff', '0', '1'].includes(modeLower)) {
    return {
      ok: false,
      error: `setPosition field 2 (mode) must be "ff", "0", or "1", got "${modeStr}". (ff=default, 0=performance, 1=silent)`,
    };
  }
  const pos = Number(posStr);
  if (!Number.isInteger(pos) || pos < 0 || pos > 100) {
    return {
      ok: false,
      error: `setPosition field 3 (position) must be an integer 0-100, got "${posStr}".`,
    };
  }
  return { ok: true, normalized: `${idx},${modeLower},${pos}` };
}

function validateBlindTiltSetPosition(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `Blind Tilt setPosition requires a parameter. Expected: "<up|down>;<0-100>". Example: "up;50".`,
    };
  }
  const parts = raw.split(';');
  if (parts.length !== 2) {
    return {
      ok: false,
      error: `Blind Tilt setPosition expects "<up|down>;<angle>", got ${JSON.stringify(raw)}. Example: "up;50".`,
    };
  }
  const dir = parts[0].toLowerCase();
  if (!BLIND_DIRECTION.has(dir)) {
    return {
      ok: false,
      error: `Blind Tilt setPosition direction must be "up" or "down", got "${parts[0]}".`,
    };
  }
  const angle = Number(parts[1]);
  if (!Number.isInteger(angle) || angle < 0 || angle > 100) {
    return {
      ok: false,
      error: `Blind Tilt setPosition angle must be an integer 0-100, got "${parts[1]}".`,
    };
  }
  return { ok: true, normalized: `${dir};${angle}` };
}

function validateRelaySetMode(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `Relay Switch setMode requires a parameter. Expected: "<1|2>;<0|1|2|3>". Example: "1;1" (channel 1, edge mode).`,
    };
  }
  const parts = raw.split(';');
  if (parts.length !== 2) {
    return {
      ok: false,
      error: `Relay Switch setMode expects "<channel>;<mode>", got ${JSON.stringify(raw)}. Example: "1;1".`,
    };
  }
  const ch = Number(parts[0]);
  if (ch !== 1 && ch !== 2) {
    return {
      ok: false,
      error: `Relay Switch setMode channel must be 1 or 2, got "${parts[0]}".`,
    };
  }
  const mode = Number(parts[1]);
  if (!Number.isInteger(mode) || mode < 0 || mode > 3) {
    return {
      ok: false,
      error: `Relay Switch setMode mode must be 0-3 (0=toggle 1=edge 2=detached 3=momentary), got "${parts[1]}".`,
    };
  }
  return { ok: true, normalized: `${ch};${mode}` };
}
