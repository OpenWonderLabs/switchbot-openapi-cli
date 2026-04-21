import { UsageError } from '../utils/output.js';

/**
 * User-facing aliases for canonical field names.
 *
 * Keys are canonical names (matching API response keys and CLI/schema output);
 * values are lowercase alternatives a user may type for `--fields` or `--filter`.
 *
 * Conflict rules (do not add an alias that violates these — tests will fail):
 * - `temp` is exclusive to `temperature` (NOT `colorTemperature`, `targetTemperature`).
 * - `motion` is exclusive to `moveDetected`; `moving` uses `active` instead.
 * - `mode` is exclusive to top-level `mode` (preset); device-specific modes go through `deviceMode`.
 * - Reserved / too-generic words never appear as aliases: `auto`, `status`, `state`,
 *   `switch`, `type`, `on`, `off`.
 * - Device-type words are never aliases: `lock`, `fan`.
 */
export const FIELD_ALIASES: Record<string, readonly string[]> = {
  // Identification (shared with list/filter)
  deviceId: ['id'],
  deviceName: ['name'],
  deviceType: ['type'],
  controlType: ['control'],
  roomName: ['room'],
  roomID: ['roomid'],
  familyName: ['family'],
  hubDeviceId: ['hub'],
  enableCloudService: ['cloud'],
  alias: ['alias'],

  // Phase 1 — common status fields
  battery: ['batt', 'bat'],
  temperature: ['temp', 'ambient'],
  colorTemperature: ['kelvin', 'colortemp'],
  humidity: ['humid', 'rh'],
  brightness: ['bright', 'bri'],
  fanSpeed: ['speed'],
  position: ['pos'],
  moveDetected: ['motion'],
  openState: ['open'],
  doorState: ['door'],
  CO2: ['co2'],
  power: ['enabled'],
  mode: ['preset'],

  // Phase 2 — niche device fields
  childLock: ['safe', 'childlock'],
  targetTemperature: ['setpoint', 'target'],
  electricCurrent: ['current', 'amps'],
  voltage: ['volts'],
  usedElectricity: ['energy', 'kwh'],
  electricityOfDay: ['daily', 'today'],
  weight: ['load'],
  version: ['firmware', 'fw'],
  lightLevel: ['light', 'lux'],
  oscillation: ['swing', 'osc'],
  verticalOscillation: ['vswing'],
  nightStatus: ['night'],
  chargingStatus: ['charging', 'charge'],
  switch1Status: ['ch1', 'channel1'],
  switch2Status: ['ch2', 'channel2'],
  taskType: ['task'],
  moving: ['active'],
  onlineStatus: ['online_status'],
  workingStatus: ['working'],

  // Phase 3 — catalog statusFields coverage
  group: ['cluster'],
  calibrate: ['calibration', 'calib'],
  direction: ['tilt'],
  deviceMode: ['devmode'],
  nebulizationEfficiency: ['mist', 'spray'],
  sound: ['audio'],
  lackWater: ['tank', 'water-low'],
  filterElement: ['filter'],
  color: ['rgb', 'hex'],
  useTime: ['runtime', 'uptime'],
  switchStatus: ['relay'],
  lockState: ['locked'],
  slidePosition: ['slide'],
};

/**
 * Resolve a user-typed field name to its canonical form against an allowed list.
 *
 * Matching is case-insensitive and trims surrounding whitespace. Direct matches
 * win over alias matches. Throws UsageError if the input is empty or does not
 * match any canonical / alias in the allowed list.
 */
export function resolveField(
  input: string,
  allowedCanonical: readonly string[],
): string {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    throw new UsageError('Field name cannot be empty.');
  }

  for (const canonical of allowedCanonical) {
    if (canonical.toLowerCase() === normalized) return canonical;
  }
  for (const canonical of allowedCanonical) {
    const aliases = FIELD_ALIASES[canonical] ?? [];
    if (aliases.some((a) => a.toLowerCase() === normalized)) return canonical;
  }
  throw new UsageError(
    `Unknown field "${input}". Supported: ${listSupportedFieldInputs(allowedCanonical).join(', ')}`,
  );
}

/**
 * Resolve every field in a list. Preserves order and the original UsageError
 * from resolveField() on the first unknown input.
 */
export function resolveFieldList(
  inputs: readonly string[],
  allowedCanonical: readonly string[],
): string[] {
  return inputs.map((f) => resolveField(f, allowedCanonical));
}

export function listSupportedFieldInputs(
  allowedCanonical: readonly string[],
): string[] {
  const out = new Set<string>();
  for (const canonical of allowedCanonical) {
    out.add(canonical);
    for (const alias of FIELD_ALIASES[canonical] ?? []) out.add(alias);
  }
  return [...out];
}

/**
 * All canonical keys known to the alias registry. Use when no dynamic
 * canonical list is available (e.g. `watch` before the first poll response).
 */
export function listAllCanonical(): string[] {
  return Object.keys(FIELD_ALIASES);
}
