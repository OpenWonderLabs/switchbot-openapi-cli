import { UsageError } from '../utils/output.js';
import { CSS_COLORS } from './css-colors.js';
import { canonicalizeDeviceType } from './catalog.js';

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
  if (angle % 2 !== 0) {
    throw new UsageError(`--angle must be a multiple of 2 (got "${opts.angle}"). Example: --angle 50`);
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

export function buildBrightnessSet(opts: { brightness?: string }, deviceType?: string): string {
  const [min, max] = (deviceType && brightnessRange(deviceType)) || [1, 100];
  if (!opts.brightness) throw new UsageError(`--brightness is required (${min}-${max})`);
  const b = parseInt(opts.brightness, 10);
  if (!Number.isFinite(b) || b < min || b > max) {
    throw new UsageError(`--brightness must be an integer between ${min} and ${max} (got "${opts.brightness}")`);
  }
  return String(b);
}

export function buildColorSet(opts: { color?: string }): string {
  if (!opts.color) throw new UsageError('--color is required (e.g. "255:0:0", "#FF0000", "red")');
  const result = validateSetColor(opts.color);
  if (!result.ok) throw new UsageError(result.error);
  return result.normalized ?? opts.color;
}

export function buildColorTemperatureSet(opts: { colorTemp?: string }): string {
  if (!opts.colorTemp) throw new UsageError('--color-temp is required (2700-6500)');
  const result = validateSetColorTemperature(opts.colorTemp);
  if (!result.ok) throw new UsageError(result.error);
  return result.normalized ?? opts.colorTemp;
}

// ---- Raw-parameter validator (used by `devices command`) ------------------

export type ValidateResult =
  | { ok: true; normalized?: string }
  | { ok: false; error: string };

export function parseParameterForWire(parameter: string | undefined): unknown {
  if (parameter === undefined) return 'default';
  const trimmed = parameter.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(parameter);
    } catch {
      return parameter;
    }
  }
  return parameter;
}

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
  const dt = canonicalizeDeviceType(deviceType);

  // --- Air Conditioner ---
  if (dt === 'Air Conditioner' && command === 'setAll') {
    return validateAcSetAll(raw);
  }

  // --- Curtain ---
  if (dt.startsWith('Curtain') && command === 'setPosition') {
    return validateCurtainSetPosition(raw);
  }

  // --- Blind Tilt ---
  if (dt.startsWith('Blind Tilt') && command === 'setPosition') {
    return validateBlindTiltSetPosition(raw);
  }

  // --- Relay Switch ---
  if ((dt === 'Relay Switch 1' || dt === 'Relay Switch 1PM') && command === 'setMode') {
    return validateIntRange(raw, 'setMode', 0, 3, 'Relay Switch mode (0=toggle 1=edge 2=detached 3=momentary)');
  }
  if (dt === 'Relay Switch 2PM' && command === 'setMode') {
    return validateRelay2PmSetMode(raw);
  }
  if (dt === 'Relay Switch 2PM' && (command === 'turnOn' || command === 'turnOff' || command === 'toggle')) {
    return validateRelayChannel(raw);
  }
  if (dt === 'Relay Switch 2PM' && command === 'setPosition') {
    return validateIntRange(raw, 'setPosition', 0, 100, 'Relay Switch 2PM roller-shade percentage');
  }

  // --- Lighting ---
  if (command === 'setBrightness' && isBrightnessDevice(dt)) {
    return validateSetBrightness(raw, dt);
  }
  if (command === 'setColor' && isColorDevice(dt)) {
    return validateSetColor(raw);
  }
  if (command === 'setColorTemperature' && isColorTemperatureDevice(dt)) {
    return validateSetColorTemperature(raw);
  }

  // --- Humidifier ---
  if (dt === 'Humidifier' && command === 'setMode') {
    return validateHumidifierSetMode(raw);
  }
  if (dt === 'Humidifier2' && command === 'setMode') {
    return validateHumidifier2SetMode(raw);
  }
  if (dt === 'Humidifier2' && command === 'setChildLock') {
    return validateEnum(raw, 'setChildLock', ['true', 'false']);
  }

  // --- Air Purifier VOC ---
  if (isAirPurifierDevice(dt) && command === 'setMode') {
    return validateAirPurifierSetMode(raw);
  }
  if (isAirPurifierDevice(dt) && command === 'setChildLock') {
    return validateEnum(raw, 'setChildLock', ['0', '1']);
  }

  // --- Robot Vacuums ---
  if (isPowLevelVacuum(dt) && command === 'PowLevel') {
    return validateIntRange(raw, 'PowLevel', 0, 3, 'suction level (0=Quiet 1=Standard 2=Strong 3=Max)');
  }
  if ((isComboVacuum(dt) || isFloorCleaningVacuum(dt)) && command === 'startClean') {
    return validateVacuumStartClean(raw, dt);
  }
  if ((isComboVacuum(dt) || isFloorCleaningVacuum(dt)) && command === 'setVolume') {
    return validateIntRange(raw, 'setVolume', 0, 100, 'volume percentage');
  }
  if ((isComboVacuum(dt) || isFloorCleaningVacuum(dt)) && command === 'changeParam') {
    return validateVacuumChangeParam(raw, dt);
  }
  if (isFloorCleaningVacuum(dt) && command === 'selfClean') {
    return validateEnum(raw, 'selfClean', ['1', '2', '3'], '1=wash mop, 2=dry, 3=terminate');
  }

  // --- Circulator Fan ---
  if (isCirculatorFan(dt) && command === 'setNightLightMode') {
    return validateEnum(raw, 'setNightLightMode', ['off', '1', '2']);
  }
  if (isCirculatorFan(dt) && command === 'setWindMode') {
    return validateEnum(raw, 'setWindMode', ['direct', 'natural', 'sleep', 'baby']);
  }
  if (isCirculatorFan(dt) && command === 'setWindSpeed') {
    return validateIntRange(raw, 'setWindSpeed', 1, 100, 'fan speed percentage');
  }
  if (isCirculatorFan(dt) && command === 'closeDelay') {
    return validateIntRange(raw, 'closeDelay', 1, 36000, 'auto-off delay in seconds');
  }

  // --- Smart Radiator Thermostat ---
  if (dt === 'Smart Radiator Thermostat' && command === 'setMode') {
    return validateIntRange(raw, 'setMode', 0, 5, 'mode (0=schedule 1=manual 2=off 3=eco 4=comfort 5=quickHeat)');
  }
  if (dt === 'Smart Radiator Thermostat' && command === 'setManualModeTemperature') {
    return validateIntRange(raw, 'setManualModeTemperature', 4, 35, 'temperature in °C');
  }

  // --- Keypad ---
  if (dt.startsWith('Keypad') && command === 'createKey') {
    return validateKeypadCreateKey(raw);
  }
  if (dt.startsWith('Keypad') && command === 'deleteKey') {
    return validateKeypadDeleteKey(raw);
  }

  // --- TV (IR) ---
  if (dt === 'TV' && command === 'SetChannel') {
    return validateIntRange(raw, 'SetChannel', 1, 999, 'channel number');
  }

  // --- Roller Shade ---
  if (dt === 'Roller Shade' && command === 'setPosition') {
    return validateIntRange(raw, 'setPosition', 0, 100, 'position percentage (0=open, 100=closed)');
  }

  return { ok: true };
}

function isBrightnessDevice(deviceType: string): boolean {
  return brightnessRange(deviceType) !== null;
}

export function brightnessRange(deviceType: string): [number, number] | null {
  if (
    deviceType === 'Color Bulb' ||
    deviceType === 'Strip Light' ||
    deviceType === 'Ceiling Light' ||
    deviceType === 'Ceiling Light Pro'
  ) {
    return [1, 100];
  }
  if (
    deviceType === 'Floor Lamp' ||
    deviceType === 'Strip Light 3' ||
    deviceType === 'RGBICWW Strip Light' ||
    deviceType === 'RGBICWW Floor Lamp' ||
    deviceType === 'RGBIC Neon Wire Rope Light' ||
    deviceType === 'RGBIC Neon Rope Light' ||
    deviceType === 'Candle Warmer Lamp'
  ) {
    return [0, 100];
  }
  if (
    deviceType === 'Light Strip' ||
    deviceType === 'Dimmer' ||
    deviceType === 'Fill Light'
  ) {
    return [1, 100];
  }
  return null;
}

function isColorDevice(deviceType: string): boolean {
  return (
    deviceType === 'Color Bulb' ||
    deviceType === 'Strip Light' ||
    deviceType === 'Strip Light 3' ||
    deviceType === 'Floor Lamp' ||
    deviceType === 'RGBICWW Strip Light' ||
    deviceType === 'RGBICWW Floor Lamp' ||
    deviceType === 'RGBIC Neon Wire Rope Light' ||
    deviceType === 'RGBIC Neon Rope Light' ||
    deviceType === 'Light Strip' ||
    deviceType === 'Fill Light'
  );
}

function isColorTemperatureDevice(deviceType: string): boolean {
  return (
    deviceType === 'Color Bulb' ||
    deviceType === 'Floor Lamp' ||
    deviceType === 'Strip Light 3' ||
    deviceType === 'Ceiling Light' ||
    deviceType === 'Ceiling Light Pro' ||
    deviceType === 'RGBICWW Strip Light' ||
    deviceType === 'RGBICWW Floor Lamp' ||
    deviceType === 'Light Strip' ||
    deviceType === 'Dimmer' ||
    deviceType === 'Fill Light'
  );
}

function isAirPurifierDevice(deviceType: string): boolean {
  return (
    deviceType === 'Air Purifier VOC' ||
    deviceType === 'Air Purifier Table VOC' ||
    deviceType === 'Air Purifier PM2.5' ||
    deviceType === 'Air Purifier Table PM2.5'
  );
}

function isPowLevelVacuum(deviceType: string): boolean {
  return (
    deviceType === 'Robot Vacuum Cleaner S1' ||
    deviceType === 'Robot Vacuum Cleaner S1 Plus' ||
    deviceType === 'K10+' ||
    deviceType === 'K10+ Pro'
  );
}

function isComboVacuum(deviceType: string): boolean {
  return (
    deviceType === 'K10+ Pro Combo' ||
    deviceType === 'Robot Vacuum Cleaner K10+ Pro Combo' ||
    deviceType === 'K20+ Pro' ||
    deviceType === 'K11+' ||
    deviceType === 'Robot Vacuum Cleaner K11+'
  );
}

function isFloorCleaningVacuum(deviceType: string): boolean {
  return (
    deviceType === 'Floor Cleaning Robot S10' ||
    deviceType === 'S20' ||
    deviceType === 'Robot Vacuum Cleaner S20'
  );
}

function isCirculatorFan(deviceType: string): boolean {
  return (
    deviceType === 'Battery Circulator Fan' ||
    deviceType === 'Circulator Fan' ||
    deviceType === 'Standing Circulator Fan'
  );
}

export function isLightingCommandSupported(deviceType: string, command: string): boolean {
  const dt = canonicalizeDeviceType(deviceType);
  if (command === 'setBrightness') return isBrightnessDevice(dt);
  if (command === 'setColorTemperature') return isColorTemperatureDevice(dt);
  if (command === 'setColor') return isColorDevice(dt);
  return false;
}

function isNumericish(v: unknown): boolean {
  if (typeof v === 'number') return true;
  if (typeof v === 'string' && v.trim() !== '') return true;
  return false;
}

function validateSetBrightness(raw: string | undefined, deviceType: string): ValidateResult {
  const [min, max] = brightnessRange(deviceType) ?? [1, 100];
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `setBrightness requires an integer ${min}-${max} (percent). Example: "50".`,
    };
  }
  const trimmed = stripQuotes(raw.trim());
  if (!/^-?\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: `setBrightness must be an integer ${min}-${max}, got ${JSON.stringify(raw)}. ${hintBrightnessRetry(min, max)}`,
    };
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < min || n > max) {
    return {
      ok: false,
      error: `setBrightness must be an integer ${min}-${max}, got "${raw}". ${hintBrightnessRetry(min, max)}`,
    };
  }
  return { ok: true, normalized: String(n) };
}

function hintBrightnessRetry(min = 1, max = 100): string {
  return `Ask the user whether they meant a percentage (${min}-${max}). Example: "50".`;
}

// B-12: setColor accepts R:G:B, R,G,B, #RRGGBB, #RGB, or a CSS Level 4 named
// color. All forms are normalized to `R:G:B` (the only wire shape SwitchBot
// accepts) so the caller can POST the result unchanged.
const CUSTOM_COLORS: Record<string, [number, number, number]> = {
  warm: [255, 180, 100],
};

const NAMED_COLORS: Record<string, [number, number, number]> = {
  ...CSS_COLORS,
  ...CUSTOM_COLORS,
};

function validateSetColor(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `setColor requires a color. Use a CSS color name (e.g. coral, teal, salmon), hex (#RRGGBB / #RGB), or R:G:B format.`,
    };
  }
  const trimmed = stripQuotes(raw.trim());

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
  const trimmed = stripQuotes(raw.trim());
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
  const stripped = stripQuotes(raw.trim());
  if (stripped.startsWith('{') || stripped.startsWith('[')) {
    return {
      ok: false,
      error: `setAll parameter must be a CSV string like "26,2,2,on", not JSON (got ${JSON.stringify(raw)}).`,
    };
  }
  const parts = stripped.split(',');
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
  const stripped = stripQuotes(raw.trim());
  if (!stripped.includes(',')) {
    const pos = Number(stripped);
    if (!Number.isInteger(pos) || pos < 0 || pos > 100) {
      return {
        ok: false,
        error: `setPosition must be an integer 0-100, got "${raw}". Example: "50".`,
      };
    }
    return { ok: true, normalized: String(pos) };
  }
  const parts = stripped.split(',').map((s) => s.trim());
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
  const stripped = stripQuotes(raw.trim());
  const parts = stripped.split(';');
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
  if (angle % 2 !== 0) {
    return {
      ok: false,
      error: `Blind Tilt setPosition angle must be a multiple of 2, got "${parts[1]}". Example: "up;48".`,
    };
  }
  return { ok: true, normalized: `${dir};${angle}` };
}

function validateRelay2PmSetMode(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `Relay Switch setMode requires a parameter. Expected: "<1|2>;<0|1|2|3>". Example: "1;1" (channel 1, edge mode).`,
    };
  }
  const stripped = stripQuotes(raw.trim());
  const parts = stripped.split(';');
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

// ---- Relay Switch 2PM channel (turnOn/turnOff/toggle) -----------------------

function validateRelayChannel(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `Relay Switch 2PM turnOn/turnOff/toggle requires a channel parameter: "1" or "2". Example: turnOff 1`,
    };
  }
  const n = stripQuotes(raw.trim());
  if (n !== '1' && n !== '2') {
    return {
      ok: false,
      error: `Relay Switch 2PM channel must be "1" or "2", got ${JSON.stringify(raw)}.`,
    };
  }
  return { ok: true, normalized: n };
}

// ---- Generic helpers --------------------------------------------------------

/**
 * Strip surrounding double-quotes from user input so that both `1` and `"1"`
 * are accepted interchangeably. This makes the CLI tolerant of users who
 * wrap numeric values in quotes (e.g. shell escaping `'"1"'`).
 */
function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}

function validateIntRange(
  raw: string | undefined,
  command: string,
  min: number,
  max: number,
  label: string,
): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `${command} requires an integer ${min}-${max} (${label}). Example: "${Math.round((min + max) / 2)}".`,
    };
  }
  const trimmed = stripQuotes(raw.trim());
  if (!/^-?\d+$/.test(trimmed)) {
    return {
      ok: false,
      error: `${command} must be an integer ${min}-${max} (${label}), got ${JSON.stringify(raw)}.`,
    };
  }
  const n = Number(trimmed);
  if (n < min || n > max) {
    return {
      ok: false,
      error: `${command} must be an integer ${min}-${max} (${label}), got ${n}.`,
    };
  }
  return { ok: true, normalized: String(n) };
}

function validateEnum(
  raw: string | undefined,
  command: string,
  allowed: string[],
  hint?: string,
): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `${command} requires a parameter: ${allowed.join(' | ')}${hint ? ` (${hint})` : ''}. Example: "${allowed[0]}".`,
    };
  }
  const trimmed = stripQuotes(raw.trim()).toLowerCase();
  const match = allowed.find((a) => a.toLowerCase() === trimmed);
  if (!match) {
    return {
      ok: false,
      error: `${command} must be one of: ${allowed.join(', ')}. Got ${JSON.stringify(raw)}.`,
    };
  }
  return { ok: true, normalized: match };
}

// ---- Humidifier -------------------------------------------------------------

function validateHumidifierSetMode(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `Humidifier setMode requires a parameter: "auto", "101", "102", "103", or 0-100 (humidity %). Example: "auto".`,
    };
  }
  const trimmed = stripQuotes(raw.trim()).toLowerCase();
  if (trimmed === 'auto') return { ok: true, normalized: 'auto' };
  if (['101', '102', '103'].includes(trimmed)) return { ok: true, normalized: trimmed };
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n >= 0 && n <= 100) return { ok: true, normalized: String(n) };
  }
  return {
    ok: false,
    error: `Humidifier setMode must be "auto", "101" (34%), "102" (67%), "103" (100%), or 0-100. Got ${JSON.stringify(raw)}.`,
  };
}

function validateHumidifier2SetMode(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `Humidifier2 setMode requires a JSON parameter: {"mode":1-8,"targetHumidify":0-100}. Example: '{"mode":7,"targetHumidify":50}'.`,
    };
  }
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch {
    return {
      ok: false,
      error: `Humidifier2 setMode expects JSON: {"mode":1-8,"targetHumidify":0-100}. Got ${JSON.stringify(raw)}.`,
    };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: `Humidifier2 setMode expects a JSON object, got ${typeof obj}.` };
  }
  const o = obj as Record<string, unknown>;
  if (!isNumericish(o.mode)) {
    return { ok: false, error: `Humidifier2 setMode "mode" must be a number or numeric string, got ${JSON.stringify(o.mode)}.` };
  }
  const mode = Number(o.mode);
  if (!Number.isInteger(mode) || mode < 1 || mode > 8) {
    return { ok: false, error: `Humidifier2 setMode "mode" must be 1-8, got ${JSON.stringify(o.mode)}.` };
  }
  if (!isNumericish(o.targetHumidify)) {
    return { ok: false, error: `Humidifier2 setMode "targetHumidify" must be a number or numeric string, got ${JSON.stringify(o.targetHumidify)}.` };
  }
  const hum = Number(o.targetHumidify);
  if (!Number.isInteger(hum) || hum < 0 || hum > 100) {
    return { ok: false, error: `Humidifier2 setMode "targetHumidify" must be 0-100, got ${JSON.stringify(o.targetHumidify)}.` };
  }
  return { ok: true, normalized: JSON.stringify({ mode, targetHumidify: hum }) };
}

// ---- Air Purifier VOC -------------------------------------------------------

function validateAirPurifierSetMode(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `Air Purifier setMode requires a JSON parameter: {"mode":1-4} or {"mode":1,"fanGear":1-3}. Example: '{"mode":2}'.`,
    };
  }
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch {
    return {
      ok: false,
      error: `Air Purifier setMode expects JSON: {"mode":1-4,"fanGear":1-3}. Got ${JSON.stringify(raw)}.`,
    };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: `Air Purifier setMode expects a JSON object, got ${typeof obj}.` };
  }
  const o = obj as Record<string, unknown>;
  if (!isNumericish(o.mode)) {
    return { ok: false, error: `Air Purifier setMode "mode" must be a number or numeric string, got ${JSON.stringify(o.mode)}.` };
  }
  const mode = Number(o.mode);
  if (!Number.isInteger(mode) || mode < 1 || mode > 4) {
    return { ok: false, error: `Air Purifier setMode "mode" must be 1-4 (1=normal 2=auto 3=sleep 4=pet), got ${JSON.stringify(o.mode)}.` };
  }
  const normalized: Record<string, number> = { mode };
  if (o.fanGear !== undefined) {
    if (mode !== 1) {
      return { ok: false, error: `Air Purifier setMode "fanGear" can only be set when "mode" is 1 (normal/fan mode).` };
    }
    if (!isNumericish(o.fanGear)) {
      return { ok: false, error: `Air Purifier setMode "fanGear" must be a number or numeric string, got ${JSON.stringify(o.fanGear)}.` };
    }
    const fg = Number(o.fanGear);
    if (!Number.isInteger(fg) || fg < 1 || fg > 3) {
      return { ok: false, error: `Air Purifier setMode "fanGear" must be 1-3, got ${JSON.stringify(o.fanGear)}.` };
    }
    normalized.fanGear = fg;
  }
  return { ok: true, normalized: JSON.stringify(normalized) };
}

// ---- Robot Vacuums ----------------------------------------------------------

function validateVacuumStartClean(raw: string | undefined, deviceType: string): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    const actions = isFloorCleaningVacuum(deviceType) ? 'sweep | sweep_mop' : 'sweep | mop';
    return {
      ok: false,
      error: `${deviceType} startClean requires a JSON parameter: {"action":"${actions.split(' | ')[0]}","param":{"fanLevel":1-4,"times":1}}. Example: '{"action":"${actions.split(' | ')[0]}","param":{"fanLevel":2,"times":1}}'.`,
    };
  }
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch {
    return {
      ok: false,
      error: `${deviceType} startClean expects JSON. Got ${JSON.stringify(raw)}.`,
    };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: `${deviceType} startClean expects a JSON object.` };
  }
  const o = obj as Record<string, unknown>;
  const validActions = isFloorCleaningVacuum(deviceType)
    ? ['sweep', 'sweep_mop']
    : ['sweep', 'mop'];
  if (typeof o.action !== 'string' || !validActions.includes(o.action)) {
    return { ok: false, error: `${deviceType} startClean "action" must be one of: ${validActions.join(', ')}. Got ${JSON.stringify(o.action)}.` };
  }
  const normalized: Record<string, unknown> = { action: o.action };
  if (o.param !== undefined) {
    if (typeof o.param !== 'object' || o.param === null || Array.isArray(o.param)) {
      return { ok: false, error: `${deviceType} startClean "param" must be an object.` };
    }
    const p = o.param as Record<string, unknown>;
    const normalizedParam: Record<string, number> = {};
    if (p.fanLevel !== undefined) {
      if (!isNumericish(p.fanLevel)) {
        return { ok: false, error: `${deviceType} startClean "param.fanLevel" must be a number or numeric string, got ${JSON.stringify(p.fanLevel)}.` };
      }
      const fl = Number(p.fanLevel);
      if (!Number.isInteger(fl) || fl < 1 || fl > 4) {
        return { ok: false, error: `${deviceType} startClean "param.fanLevel" must be 1-4, got ${JSON.stringify(p.fanLevel)}.` };
      }
      normalizedParam.fanLevel = fl;
    }
    if (p.waterLevel !== undefined) {
      if (!isFloorCleaningVacuum(deviceType)) {
        return { ok: false, error: `${deviceType} startClean "param.waterLevel" is only supported for Floor Cleaning Robot S10/S20.` };
      }
      if (!isNumericish(p.waterLevel)) {
        return { ok: false, error: `${deviceType} startClean "param.waterLevel" must be a number or numeric string, got ${JSON.stringify(p.waterLevel)}.` };
      }
      const wl = Number(p.waterLevel);
      if (!Number.isInteger(wl) || wl < 1 || wl > 2) {
        return { ok: false, error: `${deviceType} startClean "param.waterLevel" must be 1-2, got ${JSON.stringify(p.waterLevel)}.` };
      }
      normalizedParam.waterLevel = wl;
    }
    if (p.times !== undefined) {
      if (!isNumericish(p.times)) {
        return { ok: false, error: `${deviceType} startClean "param.times" must be a number or numeric string, got ${JSON.stringify(p.times)}.` };
      }
      const t = Number(p.times);
      if (!Number.isInteger(t) || t < 1 || t > 2639999) {
        return { ok: false, error: `${deviceType} startClean "param.times" must be an integer 1-2639999, got ${JSON.stringify(p.times)}.` };
      }
      normalizedParam.times = t;
    }
    normalized.param = normalizedParam;
  }
  return { ok: true, normalized: JSON.stringify(normalized) };
}

function validateVacuumChangeParam(raw: string | undefined, deviceType: string): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `changeParam requires a JSON parameter: {"fanLevel":1-4,"waterLevel":1-2,"times":1}. Example: '{"fanLevel":3,"waterLevel":1,"times":1}'.`,
    };
  }
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch {
    return {
      ok: false,
      error: `changeParam expects JSON: {"fanLevel":1-4,"waterLevel":1-2,"times":...}. Got ${JSON.stringify(raw)}.`,
    };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: `changeParam expects a JSON object.` };
  }
  const p = obj as Record<string, unknown>;
  const normalized: Record<string, number> = {};
  if (p.fanLevel !== undefined) {
    if (!isNumericish(p.fanLevel)) {
      return { ok: false, error: `changeParam "fanLevel" must be a number or numeric string, got ${JSON.stringify(p.fanLevel)}.` };
    }
    const fl = Number(p.fanLevel);
    if (!Number.isInteger(fl) || fl < 1 || fl > 4) {
      return { ok: false, error: `changeParam "fanLevel" must be 1-4, got ${JSON.stringify(p.fanLevel)}.` };
    }
    normalized.fanLevel = fl;
  }
  if (p.waterLevel !== undefined) {
    if (isComboVacuum(deviceType)) {
      return { ok: false, error: `${deviceType} changeParam does not support "waterLevel" according to the API docs.` };
    }
    if (!isNumericish(p.waterLevel)) {
      return { ok: false, error: `changeParam "waterLevel" must be a number or numeric string, got ${JSON.stringify(p.waterLevel)}.` };
    }
    const wl = Number(p.waterLevel);
    if (!Number.isInteger(wl) || wl < 1 || wl > 2) {
      return { ok: false, error: `changeParam "waterLevel" must be 1-2, got ${JSON.stringify(p.waterLevel)}.` };
    }
    normalized.waterLevel = wl;
  }
  if (p.times !== undefined) {
    if (!isNumericish(p.times)) {
      return { ok: false, error: `changeParam "times" must be a number or numeric string, got ${JSON.stringify(p.times)}.` };
    }
    const t = Number(p.times);
    if (!Number.isInteger(t) || t < 1 || t > 2639999) {
      return { ok: false, error: `changeParam "times" must be an integer 1-2639999, got ${JSON.stringify(p.times)}.` };
    }
    normalized.times = t;
  }
  return { ok: true, normalized: JSON.stringify(normalized) };
}

// ---- Keypad -----------------------------------------------------------------

function validateKeypadCreateKey(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `createKey requires a JSON parameter: {"name":"...","type":"permanent|timeLimit|disposable|urgent","password":"6-12 digits",...}.`,
    };
  }
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch {
    return { ok: false, error: `createKey expects a JSON object. Got ${JSON.stringify(raw)}.` };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: `createKey expects a JSON object.` };
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.length === 0) {
    return { ok: false, error: `createKey "name" is required and must be a non-empty string.` };
  }
  const validTypes = ['permanent', 'timeLimit', 'disposable', 'urgent'];
  if (typeof o.type !== 'string' || !validTypes.includes(o.type)) {
    return { ok: false, error: `createKey "type" must be one of: ${validTypes.join(', ')}. Got ${JSON.stringify(o.type)}.` };
  }
  if (typeof o.password !== 'string' || !/^\d{6,12}$/.test(o.password)) {
    return { ok: false, error: `createKey "password" must be a 6-12 digit string. Got ${JSON.stringify(o.password)}.` };
  }
  return { ok: true };
}

function validateKeypadDeleteKey(raw: string | undefined): ValidateResult {
  if (raw === undefined || raw === '' || raw === 'default') {
    return {
      ok: false,
      error: `deleteKey requires a JSON parameter: {"id":<passcode_id>}. Example: '{"id":12345}'.`,
    };
  }
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch {
    return { ok: false, error: `deleteKey expects a JSON object: {"id":<passcode_id>}. Got ${JSON.stringify(raw)}.` };
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, error: `deleteKey expects a JSON object.` };
  }
  const o = obj as Record<string, unknown>;
  if (o.id === undefined || (typeof o.id !== 'number' && typeof o.id !== 'string')) {
    return { ok: false, error: `deleteKey "id" is required (passcode ID). Got ${JSON.stringify(o.id)}.` };
  }
  return { ok: true };
}
