/**
 * Static catalog of SwitchBot device types, control commands and status fields.
 * Sourced from https://github.com/OpenWonderLabs/SwitchBotAPI — keep in sync
 * when the upstream API adds new device types.
 *
 * Field conventions:
 *   - CommandSpec.idempotent: repeat-safe — calling it N times ends in the
 *     same state as calling it once (turnOn, setBrightness 50). Agents can
 *     retry these freely. Counter-examples: toggle, press, volumeAdd.
 *   - CommandSpec.safetyTier: explicit action safety classification. See
 *     SafetyTier for the 5-tier enum. Built-in entries set this on the
 *     destructive tier; other tiers are derived (see deriveSafetyTier).
 *   - DeviceCatalogEntry.role: functional grouping for filter/search
 *     ("all lighting", "all security"). Does not affect API behavior.
 *   - DeviceCatalogEntry.readOnly: the device has no control commands; it
 *     can only be queried via 'devices status'.
 */

/**
 * Catalog shape version. Bump when any of the exported interfaces
 * (CommandSpec / DeviceCatalogEntry / SafetyTier) gain/lose/rename a
 * load-bearing field. The agent-bootstrap payload's schemaVersion must
 * stay pinned to this value; `doctor` fails the `catalog-schema` check
 * when they drift.
 */
export const CATALOG_SCHEMA_VERSION = '1.0';

/**
 * Safety classification for catalog commands.
 *
 *  - 'read'           —— Read-only query (status fetch). Reserved for v2.8+
 *                        `statusQueries` expansion; no command uses it today.
 *  - 'mutation'       —— Causes a state change but is reversible/idempotent
 *                        (turnOn/Off, setBrightness, setPosition).
 *  - 'ir-fire-forget' —— IR command (no reply/ack) or customize IR button.
 *                        Fire-and-forget; reversibility depends on device.
 *  - 'destructive'    —— Hard or unsafe to reverse; physical-world side effects
 *                        (unlock, garage open, deleteKey). Needs confirmation.
 *  - 'maintenance'    —— Factory reset / firmware update / deep calibrate.
 *                        Reserved; the SwitchBot API exposes no such endpoint
 *                        today, so no command uses it.
 */
export type SafetyTier =
  | 'read'
  | 'mutation'
  | 'ir-fire-forget'
  | 'destructive'
  | 'maintenance';

export interface CommandSpec {
  command: string;
  parameter: string;
  description: string;
  commandType?: 'command' | 'customize';
  idempotent?: boolean;
  /**
   * Explicit safety tier. When omitted, deriveSafetyTier() infers:
   *   commandType: 'customize' or entry.category === 'ir'  → 'ir-fire-forget'
   *   otherwise              → 'mutation'
   */
  safetyTier?: SafetyTier;
  /** One sentence explaining *why* this command needs caution — used in guard errors. */
  safetyReason?: string;
  exampleParams?: string[];
}

/** Coarse functional role — helpful for cross-type selection in agents. */
export type DeviceRole =
  | 'lighting'
  | 'climate'
  | 'security'
  | 'media'
  | 'sensor'
  | 'cleaning'
  | 'curtain'
  | 'fan'
  | 'power'
  | 'hub'
  | 'other';

export interface DeviceCatalogEntry {
  type: string;
  category: 'physical' | 'ir';
  description?: string;
  aliases?: string[];
  commands: CommandSpec[];
  statusFields?: string[];
  /**
   * P11: strongly-typed read-only queries powering the 'read' safety tier.
   * When omitted, deriveStatusQueries() produces equivalent entries from
   * `statusFields`. Use this to override descriptions or attach examples.
   */
  statusQueries?: ReadOnlyQuerySpec[];
  role?: DeviceRole;
  readOnly?: boolean;
}

/**
 * P11: a single read-only query against a device. `endpoint: 'status'` is
 * the normal /devices/{id}/status call; 'keys' reads lock keypad entries;
 * 'webhook' reads the server-side webhook event subscription. All three
 * are safe to call at any time — they never mutate state.
 */
export interface ReadOnlyQuerySpec {
  field: string;
  description: string;
  endpoint: 'status' | 'keys' | 'webhook';
  safetyTier: 'read';
  example?: unknown;
}

/**
 * Human-readable descriptions for common status fields. Populated from
 * the SwitchBot API v1.1 docs. Used by deriveStatusQueries() so every
 * query has a meaningful description even when the entry itself only
 * declares the field name.
 */
const STATUS_FIELD_DESCRIPTIONS: Record<string, string> = {
  power: 'Power state (on/off)',
  battery: 'Battery percentage (0-100)',
  version: 'Firmware version string',
  temperature: 'Ambient temperature (°C)',
  humidity: 'Ambient humidity (% RH)',
  CO2: 'CO2 concentration (ppm)',
  brightness: 'Current brightness (0-100)',
  color: 'Current RGB color (r:g:b)',
  colorTemperature: 'Color temperature in Kelvin',
  mode: 'Operating mode',
  deviceMode: 'Hardware mode (Bot-specific)',
  lockState: 'Lock state (locked/unlocked)',
  doorState: 'Door contact state (open/closed)',
  calibrate: 'Calibration status',
  moving: 'Motion in progress (boolean)',
  slidePosition: 'Slide position (0-100)',
  group: 'Multi-device group membership',
  direction: 'Tilt direction',
  voltage: 'Line voltage',
  electricCurrent: 'Instantaneous current draw',
  electricityOfDay: 'kWh consumed today',
  usedElectricity: 'Cumulative kWh',
  useTime: 'Total runtime (seconds)',
  weight: 'Load / weight reading',
  switchStatus: 'Relay state (integer encoded)',
  switch1Status: 'Channel 1 relay state',
  switch2Status: 'Channel 2 relay state',
  workingStatus: 'Device working status (vacuum/purifier)',
  onlineStatus: 'Online / offline (string)',
  online: 'Online / offline (boolean or int)',
  taskType: 'Current task identifier',
  nightStatus: 'Night-mode status',
  oscillation: 'Horizontal oscillation on/off',
  verticalOscillation: 'Vertical oscillation on/off',
  chargingStatus: 'Charging (boolean)',
  fanSpeed: 'Current fan speed level',
  nebulizationEfficiency: 'Humidifier mist level',
  childLock: 'Child-lock engaged',
  sound: 'Beep / audio feedback enabled',
  lackWater: 'Water tank low (boolean)',
  filterElement: 'Filter life remaining',
  auto: 'Auto mode enabled',
  targetTemperature: 'Thermostat target temperature',
  moveDetected: 'Motion detected (boolean)',
  openState: 'Contact sensor open/closed',
  status: 'Device-specific status word',
  lightLevel: 'Ambient light level',
};

/**
 * P11: derive the read-only query list for an entry. If the entry has
 * explicit `statusQueries`, return them as-is; otherwise synthesize one
 * ReadOnlyQuerySpec per `statusFields` entry, all keyed to the `status`
 * endpoint. IR-category entries have no status channel so return [].
 */
export function deriveStatusQueries(entry: DeviceCatalogEntry): ReadOnlyQuerySpec[] {
  if (entry.statusQueries && entry.statusQueries.length > 0) return entry.statusQueries;
  if (entry.category === 'ir') return [];
  const fields = entry.statusFields ?? [];
  return fields.map((f) => ({
    field: f,
    description: STATUS_FIELD_DESCRIPTIONS[f] ?? `${f} (see API docs)`,
    endpoint: 'status',
    safetyTier: 'read',
  }));
}

// ---- Command fragments (reused across entries) -------------------------

const onOff: CommandSpec[] = [
  { command: 'turnOn', parameter: '—', description: 'Power on', idempotent: true },
  { command: 'turnOff', parameter: '—', description: 'Power off', idempotent: true },
];
const onOffToggle: CommandSpec[] = [
  ...onOff,
  { command: 'toggle', parameter: '—', description: 'Toggle power', idempotent: false },
];
const lightControls: CommandSpec[] = [
  { command: 'setBrightness', parameter: '1-100', description: 'Set brightness percentage', idempotent: true, exampleParams: ['50', '80'] },
  { command: 'setColor', parameter: 'R:G:B (0-255 each)', description: 'Set RGB color, e.g. "255:0:0"', idempotent: true, exampleParams: ['255:0:0', '255:255:255'] },
  { command: 'setColorTemperature', parameter: '2700-6500', description: 'Set color temperature (Kelvin)', idempotent: true, exampleParams: ['2700', '4000', '6500'] },
];

export const DEVICE_CATALOG: DeviceCatalogEntry[] = [
  // ---------- Physical devices ----------
  {
    type: 'Bot',
    category: 'physical',
    description: 'Mechanical arm robot that physically presses a button or toggles a switch on demand.',
    role: 'other',
    commands: [
      ...onOff,
      { command: 'press', parameter: '—', description: 'Press the button (momentary)', idempotent: false },
    ],
    statusFields: ['power', 'battery', 'deviceMode', 'version'],
  },
  {
    type: 'Curtain',
    category: 'physical',
    description: 'Motorized curtain track runner that opens/closes curtains by slide position (0=open, 100=closed).',
    role: 'curtain',
    aliases: ['Curtain3', 'Curtain 3'],
    commands: [
      ...onOff,
      { command: 'pause', parameter: '—', description: 'Stop movement', idempotent: true },
      { command: 'setPosition', parameter: '0-100 (0=open, 100=closed)', description: 'Move to a position', idempotent: true, exampleParams: ['0', '50', '100'] },
      { command: 'setPosition', parameter: 'index,mode,position  (e.g. "0,ff,80")', description: 'Multi-arg form: mode=0 Performance | 1 Silent | ff default', idempotent: true, exampleParams: ['0,ff,50'] },
    ],
    statusFields: ['calibrate', 'group', 'moving', 'slidePosition', 'battery', 'version'],
  },
  {
    type: 'Smart Lock',
    category: 'physical',
    description: 'Bluetooth/Wi-Fi electronic deadbolt that locks and unlocks a door via cloud API.',
    role: 'security',
    aliases: ['Smart Lock Pro'],
    commands: [
      { command: 'lock', parameter: '—', description: 'Lock the door', idempotent: true },
      { command: 'unlock', parameter: '—', description: 'Unlock the door', idempotent: true, safetyTier: 'destructive', safetyReason: 'Physically unlocks the door — anyone nearby can open it.' },
      { command: 'deadbolt', parameter: '—', description: 'Pro only: engage deadbolt', idempotent: true },
    ],
    statusFields: ['battery', 'version', 'lockState', 'doorState', 'calibrate'],
  },
  {
    type: 'Smart Lock Lite',
    category: 'physical',
    description: 'Compact electronic deadbolt with lock and unlock control; no deadbolt mode.',
    role: 'security',
    commands: [
      { command: 'lock', parameter: '—', description: 'Lock the door', idempotent: true },
      { command: 'unlock', parameter: '—', description: 'Unlock the door', idempotent: true, safetyTier: 'destructive', safetyReason: 'Physically unlocks the door — anyone nearby can open it.' },
    ],
    statusFields: ['battery', 'version', 'lockState', 'doorState', 'calibrate'],
  },
  {
    type: 'Smart Lock Ultra',
    category: 'physical',
    description: 'Premium electronic deadbolt with full lock, unlock, and deadbolt control.',
    role: 'security',
    commands: [
      { command: 'lock', parameter: '—', description: 'Lock the door', idempotent: true },
      { command: 'unlock', parameter: '—', description: 'Unlock the door', idempotent: true, safetyTier: 'destructive', safetyReason: 'Physically unlocks the door — anyone nearby can open it.' },
      { command: 'deadbolt', parameter: '—', description: 'Engage deadbolt', idempotent: true },
    ],
    statusFields: ['battery', 'version', 'lockState', 'doorState', 'calibrate'],
  },
  {
    type: 'Plug',
    category: 'physical',
    description: 'Smart wall outlet plug with on/off/toggle control and basic power status.',
    role: 'power',
    commands: onOffToggle,
    statusFields: ['power', 'version'],
  },
  {
    type: 'Plug Mini (US)',
    category: 'physical',
    description: 'Compact smart plug with voltage, current, and daily energy consumption reporting.',
    role: 'power',
    aliases: ['Plug Mini (JP)'],
    commands: onOffToggle,
    statusFields: ['voltage', 'weight', 'electricityOfDay', 'electricCurrent', 'power', 'version'],
  },
  {
    type: 'Relay Switch 1',
    category: 'physical',
    description: 'In-wall relay switch with configurable modes (toggle/edge/detached/momentary) and power metering.',
    role: 'power',
    aliases: ['Relay Switch 1PM'],
    commands: [
      ...onOffToggle,
      { command: 'setMode', parameter: '0=toggle | 1=edge | 2=detached | 3=momentary', description: 'Switch operating mode', idempotent: true, exampleParams: ['0', '1', '2', '3'] },
    ],
    statusFields: ['switchStatus', 'voltage', 'version', 'useTime', 'electricCurrent', 'power', 'usedElectricity'],
  },
  {
    type: 'Relay Switch 2PM',
    category: 'physical',
    description: 'Dual-channel relay switch with per-channel on/off/toggle and optional roller-shade mode.',
    role: 'power',
    commands: [
      { command: 'turnOn', parameter: '1 | 2 (channel)', description: 'Turn on channel 1 or 2', idempotent: true, exampleParams: ['1', '2'] },
      { command: 'turnOff', parameter: '1 | 2 (channel)', description: 'Turn off channel 1 or 2', idempotent: true, exampleParams: ['1', '2'] },
      { command: 'toggle', parameter: '1 | 2 (channel)', description: 'Toggle channel 1 or 2', idempotent: false, exampleParams: ['1', '2'] },
      { command: 'setMode', parameter: '"<channel>;<mode>" e.g. "1;0"', description: 'Per-channel mode (see Relay Switch 1 modes)', idempotent: true, exampleParams: ['1;0', '2;3'] },
      { command: 'setPosition', parameter: '0-100 (roller percentage)', description: 'Roller-shade-pair mode only', idempotent: true, exampleParams: ['0', '50', '100'] },
    ],
    statusFields: ['switch1Status', 'switch2Status', 'voltage', 'electricCurrent', 'power', 'usedElectricity'],
  },
  {
    type: 'Humidifier',
    category: 'physical',
    description: 'Ultrasonic humidifier with auto and preset humidity level control.',
    role: 'climate',
    commands: [
      ...onOff,
      { command: 'setMode', parameter: 'auto | 101 (34%) | 102 (67%) | 103 (100%) | 0-100', description: 'Set preset or target humidity', idempotent: true, exampleParams: ['auto', '101', '50'] },
    ],
    statusFields: ['power', 'humidity', 'temperature', 'nebulizationEfficiency', 'auto', 'childLock', 'sound', 'lackWater'],
  },
  {
    type: 'Humidifier2',
    category: 'physical',
    description: 'Evaporative humidifier with multiple speed/auto/sleep/humidity modes and child lock.',
    role: 'climate',
    aliases: ['Evaporative Humidifier'],
    commands: [
      ...onOff,
      { command: 'setMode', parameter: '\'{"mode":1-8,"targetHumidify":0-100}\'', description: 'mode: 1=lv4 2=lv3 3=lv2 4=lv1 5=humidity 6=sleep 7=auto 8=drying', idempotent: true, exampleParams: ['{"mode":7,"targetHumidify":50}'] },
      { command: 'setChildLock', parameter: 'true | false', description: 'Enable or disable child lock', idempotent: true, exampleParams: ['true', 'false'] },
    ],
    statusFields: ['power', 'humidity', 'temperature', 'mode', 'childLock', 'filterElement'],
  },
  {
    type: 'Air Purifier VOC',
    category: 'physical',
    description: 'HEPA air purifier with VOC or PM2.5 sensing, multiple fan modes, and child lock.',
    role: 'climate',
    aliases: ['Air Purifier PM2.5', 'Air Purifier Table VOC', 'Air Purifier Table PM2.5'],
    commands: [
      ...onOff,
      { command: 'setMode', parameter: '\'{"mode":1-4,"fanGear":1-3}\'', description: 'mode: 1=normal 2=auto 3=sleep 4=pet; fanGear only when mode=1', idempotent: true, exampleParams: ['{"mode":2}', '{"mode":1,"fanGear":2}'] },
      { command: 'setChildLock', parameter: '0 | 1', description: 'Disable / enable child lock', idempotent: true, exampleParams: ['0', '1'] },
    ],
    statusFields: ['power', 'mode', 'childLock', 'filterElement'],
  },
  {
    type: 'Color Bulb',
    category: 'physical',
    description: 'Wi-Fi smart bulb with tunable brightness, RGB color, and color temperature.',
    role: 'lighting',
    commands: [...onOffToggle, ...lightControls],
    statusFields: ['power', 'brightness', 'color', 'colorTemperature', 'version'],
  },
  {
    type: 'Strip Light',
    category: 'physical',
    description: 'Addressable LED strip with on/off, brightness, RGB color, and color temperature control.',
    role: 'lighting',
    aliases: ['Strip Light 3'],
    commands: [...onOffToggle, ...lightControls],
    statusFields: ['power', 'brightness', 'color', 'colorTemperature', 'version'],
  },
  {
    type: 'Ceiling Light',
    category: 'physical',
    description: 'Smart ceiling fixture with brightness and color-temperature adjustment (no RGB).',
    role: 'lighting',
    aliases: ['Ceiling Light Pro'],
    commands: [
      ...onOffToggle,
      { command: 'setBrightness', parameter: '1-100', description: 'Set brightness percentage', idempotent: true, exampleParams: ['50', '80'] },
      { command: 'setColorTemperature', parameter: '2700-6500', description: 'Set color temperature (Kelvin)', idempotent: true, exampleParams: ['2700', '4000', '6500'] },
    ],
    statusFields: ['power', 'brightness', 'colorTemperature', 'version'],
  },
  {
    type: 'Smart Radiator Thermostat',
    category: 'physical',
    description: 'Motorized thermostatic valve for radiators with schedule, manual, eco, and comfort modes.',
    role: 'climate',
    commands: [
      ...onOff,
      { command: 'setMode', parameter: '0=schedule 1=manual 2=off 3=eco 4=comfort 5=quickHeat', description: 'Operating mode', idempotent: true, exampleParams: ['1', '3'] },
      { command: 'setManualModeTemperature', parameter: '5-30 (°C)', description: 'Target temperature in manual mode', idempotent: true, exampleParams: ['20', '22'] },
    ],
    statusFields: ['power', 'temperature', 'humidity', 'battery', 'version', 'mode', 'targetTemperature'],
  },
  {
    type: 'Robot Vacuum Cleaner S1',
    category: 'physical',
    description: 'Entry-level robot vacuum with start/stop/dock and four suction power levels.',
    role: 'cleaning',
    aliases: ['Robot Vacuum', 'Robot Vacuum Cleaner S1 Plus', 'K10+'],
    commands: [
      { command: 'start', parameter: '—', description: 'Start cleaning', idempotent: true },
      { command: 'stop', parameter: '—', description: 'Stop cleaning', idempotent: true },
      { command: 'dock', parameter: '—', description: 'Return to dock', idempotent: true },
      { command: 'PowLevel', parameter: '0-3', description: '0=Quiet 1=Standard 2=Strong 3=Max', idempotent: true, exampleParams: ['0', '1', '2', '3'] },
    ],
    statusFields: ['workingStatus', 'onlineStatus', 'battery', 'version'],
  },
  {
    type: 'K10+ Pro Combo',
    category: 'physical',
    description: 'Compact robot vacuum and mop combo with sweep/mop sessions, fan level, and water level.',
    role: 'cleaning',
    aliases: ['K20+ Pro'],
    commands: [
      { command: 'startClean', parameter: '\'{"action":"sweep"|"mop","param":{"fanLevel":1-4,"times":1-2639999}}\'', description: 'Begin a cleaning session', idempotent: false, exampleParams: ['{"action":"sweep","param":{"fanLevel":2,"times":1}}'] },
      { command: 'pause', parameter: '—', description: 'Pause cleaning', idempotent: true },
      { command: 'dock', parameter: '—', description: 'Return to dock', idempotent: true },
      { command: 'setVolume', parameter: '0-100', description: 'Set voice volume', idempotent: true, exampleParams: ['0', '50', '100'] },
      { command: 'changeParam', parameter: '\'{"fanLevel":1-4,"waterLevel":1-2,"times":1-2639999}\'', description: 'Change parameters mid-run', idempotent: true, exampleParams: ['{"fanLevel":3,"waterLevel":1,"times":1}'] },
    ],
    statusFields: ['workingStatus', 'onlineStatus', 'battery', 'taskType'],
  },
  {
    type: 'Floor Cleaning Robot S10',
    category: 'physical',
    description: 'Advanced floor cleaning robot with sweep/mop modes, self-wash dock, and humidifier refill.',
    role: 'cleaning',
    aliases: ['Robot Vacuum Cleaner S10', 'Robot Vacuum Cleaner S20'],
    commands: [
      { command: 'startClean', parameter: '\'{"action":"sweep"|"sweep_mop","param":{"fanLevel":1-4,"waterLevel":1-2,"times":1-2639999}}\'', description: 'Begin a cleaning session', idempotent: false, exampleParams: ['{"action":"sweep","param":{"fanLevel":2,"waterLevel":1,"times":1}}'] },
      { command: 'pause', parameter: '—', description: 'Pause cleaning', idempotent: true },
      { command: 'dock', parameter: '—', description: 'Return to dock', idempotent: true },
      { command: 'addWaterForHumi', parameter: '—', description: 'Refill the humidifier water tank', idempotent: false },
      { command: 'selfClean', parameter: '1 | 2 | 3', description: '1=wash mop | 2=dry | 3=terminate self-clean', idempotent: false, exampleParams: ['1', '2', '3'] },
      { command: 'setVolume', parameter: '0-100', description: 'Set voice volume', idempotent: true, exampleParams: ['0', '50', '100'] },
      { command: 'changeParam', parameter: '\'{"fanLevel":1-4,"waterLevel":1-2,"times":1-2639999}\'', description: 'Change parameters mid-run', idempotent: true, exampleParams: ['{"fanLevel":3,"waterLevel":1,"times":1}'] },
    ],
    statusFields: ['workingStatus', 'onlineStatus', 'battery', 'taskType'],
  },
  {
    type: 'Battery Circulator Fan',
    category: 'physical',
    description: 'Rechargeable table/floor fan with wind modes, speed control, night-light, and auto-off timer.',
    role: 'fan',
    aliases: ['Circulator Fan'],
    commands: [
      ...onOffToggle,
      { command: 'setNightLightMode', parameter: 'off | 1 | 2', description: 'Night-light mode', idempotent: true, exampleParams: ['off', '1', '2'] },
      { command: 'setWindMode', parameter: 'direct | natural | sleep | baby', description: 'Wind mode', idempotent: true, exampleParams: ['natural', 'sleep'] },
      { command: 'setWindSpeed', parameter: '1-100', description: 'Fan speed', idempotent: true, exampleParams: ['50', '100'] },
      { command: 'closeDelay', parameter: 'seconds', description: 'Auto-off timer in seconds', idempotent: true, exampleParams: ['1800', '3600'] },
    ],
    statusFields: ['mode', 'version', 'battery', 'power', 'nightStatus', 'oscillation', 'verticalOscillation', 'chargingStatus', 'fanSpeed'],
  },
  {
    type: 'Blind Tilt',
    category: 'physical',
    description: 'Motorized tilt rod for horizontal blinds; controls slat angle (0=closed, 100=open).',
    role: 'curtain',
    commands: [
      ...onOff,
      { command: 'setPosition', parameter: '"<direction>;<angle>" (up|down; 0,2,...,100)', description: 'Tilt direction + angle (0=closed, 100=open)', idempotent: true, exampleParams: ['up;50', 'down;80'] },
      { command: 'fullyOpen', parameter: '—', description: 'Open fully', idempotent: true },
      { command: 'closeUp', parameter: '—', description: 'Close up', idempotent: true },
      { command: 'closeDown', parameter: '—', description: 'Close down', idempotent: true },
    ],
    statusFields: ['version', 'calibrate', 'group', 'moving', 'direction', 'slidePosition', 'battery'],
  },
  {
    type: 'Roller Shade',
    category: 'physical',
    description: 'Motorized roller blind that moves to a set position (0=open, 100=closed).',
    role: 'curtain',
    commands: [
      ...onOff,
      { command: 'setPosition', parameter: '0-100 (0=open, 100=closed)', description: 'Move to a position', idempotent: true, exampleParams: ['0', '50', '100'] },
    ],
    statusFields: ['slidePosition', 'battery', 'version', 'moving'],
  },
  {
    type: 'Garage Door Opener',
    category: 'physical',
    description: 'Cloud-connected garage door controller; turnOn opens and turnOff closes the door.',
    role: 'security',
    commands: [
      { command: 'turnOn', parameter: '—', description: 'Open the garage door', idempotent: true, safetyTier: 'destructive', safetyReason: 'Opens the garage door — anyone nearby can enter the space.' },
      { command: 'turnOff', parameter: '—', description: 'Close the garage door', idempotent: true, safetyTier: 'destructive', safetyReason: 'Closes the garage door — verify no person or obstacle is in the way.' },
    ],
    statusFields: ['switchStatus', 'version', 'online'],
  },
  {
    type: 'Video Doorbell',
    category: 'physical',
    description: 'Wi-Fi video doorbell with motion detection enable/disable control.',
    role: 'security',
    commands: [
      { command: 'enableMotionDetection', parameter: '—', description: 'Enable motion detection', idempotent: true },
      { command: 'disableMotionDetection', parameter: '—', description: 'Disable motion detection', idempotent: true },
    ],
    statusFields: ['battery', 'version'],
  },
  {
    type: 'Keypad',
    category: 'physical',
    description: 'PIN-pad access controller that creates and deletes door passcodes for a Smart Lock.',
    role: 'security',
    aliases: ['Keypad Touch'],
    commands: [
      { command: 'createKey', parameter: '\'{"name":"...","type":"permanent|timeLimit|disposable|urgent","password":"6-12 digits","startTime":<s>,"endTime":<s>}\'', description: 'Create a passcode (async; result via webhook)', idempotent: false, safetyTier: 'destructive', safetyReason: 'Provisions a new access credential — anyone with this passcode can unlock the door.' },
      { command: 'deleteKey', parameter: '\'{"id":<passcode_id>}\'', description: 'Delete a passcode (async; result via webhook)', idempotent: true, safetyTier: 'destructive', safetyReason: 'Permanently removes a passcode — the holder immediately loses door access.' },
    ],
    statusFields: ['version'],
  },
  {
    type: 'Candle Warmer Lamp',
    category: 'physical',
    description: 'Decorative candle-warmer lamp with adjustable brightness and color temperature.',
    role: 'lighting',
    commands: [
      ...onOffToggle,
      { command: 'setBrightness', parameter: '1-100', description: 'Set brightness percentage', idempotent: true, exampleParams: ['50', '80'] },
      { command: 'setColorTemperature', parameter: '2700-6500', description: 'Set color temperature (Kelvin)', idempotent: true, exampleParams: ['2700', '4000'] },
    ],
    statusFields: ['power', 'brightness', 'colorTemperature', 'version'],
  },
  // Status-only devices (no commands)
  {
    type: 'Meter',
    category: 'physical',
    description: 'Battery-powered temperature and humidity sensor; read-only, no control commands.',
    role: 'sensor',
    readOnly: true,
    aliases: ['Meter Plus', 'MeterPro', 'MeterPro(CO2)', 'WoIOSensor', 'Hub 2'],
    commands: [],
    statusFields: ['temperature', 'humidity', 'CO2', 'battery', 'version'],
  },
  {
    type: 'Motion Sensor',
    category: 'physical',
    description: 'PIR motion detector that reports movement and ambient brightness; read-only.',
    role: 'sensor',
    readOnly: true,
    commands: [],
    statusFields: ['battery', 'version', 'moveDetected', 'brightness', 'openState'],
  },
  {
    type: 'Contact Sensor',
    category: 'physical',
    description: 'Door or window open/close sensor that also reports movement and brightness; read-only.',
    role: 'sensor',
    readOnly: true,
    commands: [],
    statusFields: ['battery', 'version', 'moveDetected', 'openState', 'brightness'],
  },
  {
    type: 'Water Leak Detector',
    category: 'physical',
    description: 'Water sensor that reports leak status; read-only, no control commands.',
    role: 'sensor',
    readOnly: true,
    commands: [],
    statusFields: ['battery', 'version', 'status'],
  },
  // Status-only hub-class devices (no control commands)
  {
    type: 'Hub Mini',
    category: 'physical',
    description: 'IR hub that bridges BLE devices to the cloud and learns IR remotes; no direct control commands.',
    role: 'hub',
    readOnly: true,
    aliases: ['Hub Mini2'],
    commands: [],
    statusFields: ['version'],
  },
  {
    type: 'Hub 3',
    category: 'physical',
    description: 'Wi-Fi hub with built-in temperature, humidity, and light sensors; manages local BLE devices.',
    role: 'hub',
    readOnly: true,
    commands: [],
    statusFields: ['version', 'temperature', 'humidity', 'lightLevel'],
  },
  {
    type: 'AI Hub',
    category: 'physical',
    description: 'Advanced hub with AI-based automations; bridges BLE devices to the cloud; read-only status.',
    role: 'hub',
    readOnly: true,
    commands: [],
    statusFields: ['version'],
  },
  {
    type: 'Home Climate Panel',
    category: 'physical',
    description: 'Wall-mounted display showing temperature and humidity; sensor-only, no control.',
    role: 'climate',
    readOnly: true,
    commands: [],
    statusFields: ['temperature', 'humidity', 'version'],
  },
  {
    type: 'Wallet Finder Card',
    category: 'physical',
    description: 'Slim Bluetooth tracker card for locating wallets; reports battery status only.',
    role: 'sensor',
    readOnly: true,
    commands: [],
    statusFields: ['battery', 'version'],
  },
  {
    type: 'Outdoor Spotlight Cam',
    category: 'physical',
    description: 'Battery-powered outdoor security camera with spotlight; status-only via cloud API.',
    role: 'security',
    readOnly: true,
    commands: [],
    statusFields: ['battery', 'version'],
  },

  // ---------- Virtual IR remotes ----------
  {
    type: 'Air Conditioner',
    category: 'ir',
    description: 'IR-controlled air conditioner with on/off and full HVAC parameter control (mode, fan, temp).',
    role: 'climate',
    commands: [
      ...onOff,
      { command: 'setAll', parameter: '"<temp>,<mode>,<fan>,<on|off>"', description: 'mode: 1=auto 2=cool 3=dry 4=fan 5=heat; fan: 1=auto 2=low 3=mid 4=high', idempotent: true, exampleParams: ['26,2,3,on', '22,5,2,on'] },
    ],
  },
  {
    type: 'TV',
    category: 'ir',
    description: 'IR-controlled television or streaming device with channel, volume, and power commands.',
    role: 'media',
    aliases: ['IPTV', 'Streamer', 'Set Top Box'],
    commands: [
      ...onOff,
      { command: 'SetChannel', parameter: '1-999 (channel number)', description: 'Switch to a specific channel', idempotent: true, exampleParams: ['1', '15'] },
      { command: 'volumeAdd', parameter: '—', description: 'Volume up', idempotent: false },
      { command: 'volumeSub', parameter: '—', description: 'Volume down', idempotent: false },
      { command: 'channelAdd', parameter: '—', description: 'Channel up', idempotent: false },
      { command: 'channelSub', parameter: '—', description: 'Channel down', idempotent: false },
    ],
  },
  {
    type: 'DVD',
    category: 'ir',
    description: 'IR-controlled disc player or speaker with playback, track navigation, and volume commands.',
    role: 'media',
    aliases: ['Speaker'],
    commands: [
      ...onOff,
      { command: 'setMute', parameter: '—', description: 'Toggle mute', idempotent: false },
      { command: 'FastForward', parameter: '—', description: 'Fast forward', idempotent: false },
      { command: 'Rewind', parameter: '—', description: 'Rewind', idempotent: false },
      { command: 'Next', parameter: '—', description: 'Next track', idempotent: false },
      { command: 'Previous', parameter: '—', description: 'Previous track', idempotent: false },
      { command: 'Pause', parameter: '—', description: 'Pause', idempotent: true },
      { command: 'Play', parameter: '—', description: 'Play', idempotent: true },
      { command: 'Stop', parameter: '—', description: 'Stop', idempotent: true },
      { command: 'volumeAdd', parameter: '—', description: 'Volume up', idempotent: false },
      { command: 'volumeSub', parameter: '—', description: 'Volume down', idempotent: false },
    ],
  },
  {
    type: 'Fan',
    category: 'ir',
    description: 'IR-controlled fan with on/off, swing, timer, and speed preset commands.',
    role: 'fan',
    commands: [
      ...onOff,
      { command: 'swing', parameter: '—', description: 'Toggle swing', idempotent: false },
      { command: 'timer', parameter: '—', description: 'Toggle timer', idempotent: false },
      { command: 'lowSpeed', parameter: '—', description: 'Low speed', idempotent: true },
      { command: 'middleSpeed', parameter: '—', description: 'Medium speed', idempotent: true },
      { command: 'highSpeed', parameter: '—', description: 'High speed', idempotent: true },
    ],
  },
  {
    type: 'Light',
    category: 'ir',
    description: 'IR-controlled light fixture with on/off and relative brightness adjustment commands.',
    role: 'lighting',
    commands: [
      ...onOff,
      { command: 'brightnessUp', parameter: '—', description: 'Brightness up', idempotent: false },
      { command: 'brightnessDown', parameter: '—', description: 'Brightness down', idempotent: false },
    ],
  },
  {
    type: 'Others',
    category: 'ir',
    description: 'Catch-all for custom IR remotes with user-defined button names learned by a Hub.',
    role: 'other',
    commands: [
      { command: '<buttonName>', parameter: '—', description: 'User-defined custom IR button (requires --type customize)', commandType: 'customize' },
    ],
  },
];

/** Find a catalog entry by exact name, alias, or case-insensitive substring. */
export function findCatalogEntry(query: string): DeviceCatalogEntry | DeviceCatalogEntry[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const names = (e: DeviceCatalogEntry) => [e.type, ...(e.aliases ?? [])];
  const catalog = getEffectiveCatalog();

  const exact = catalog.find((e) =>
    names(e).some((n) => n.toLowerCase() === q)
  );
  if (exact) return exact;

  const matches = catalog.filter((e) =>
    names(e).some((n) => n.toLowerCase().includes(q))
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return matches;
}

/**
 * Derive the safety tier for a catalog command, honouring an explicit
 * `safetyTier` when present and falling back to heuristic inference.
 *
 * The inference order is:
 *   1. Explicit `spec.safetyTier`.
 *   2. IR context (customize command OR entry.category === 'ir')
 *      → `'ir-fire-forget'`.
 *   3. Default → `'mutation'`.
 */
export function deriveSafetyTier(
  spec: CommandSpec,
  entry?: Pick<DeviceCatalogEntry, 'category'>,
): SafetyTier {
  if (spec.safetyTier) return spec.safetyTier;
  if (spec.commandType === 'customize') return 'ir-fire-forget';
  if (entry?.category === 'ir') return 'ir-fire-forget';
  return 'mutation';
}

/** Read the safety reason for a command. */
export function getCommandSafetyReason(spec: CommandSpec): string | null {
  return spec.safetyReason ?? null;
}

/**
 * Pick up to 3 non-destructive, idempotent commands an agent can safely invoke
 * to explore or exercise a device. Used by `devices describe --json` to hint
 * at concrete next steps.
 */
export function suggestedActions(entry: DeviceCatalogEntry): Array<{
  command: string;
  parameter?: string;
  description: string;
}> {
  const safe = entry.commands.filter(
    (c) =>
      c.idempotent === true &&
      deriveSafetyTier(c, entry) !== 'destructive' &&
      c.commandType !== 'customize',
  );
  const picks: CommandSpec[] = [];
  const seen = new Set<string>();
  for (const c of safe) {
    if (seen.has(c.command)) continue;
    seen.add(c.command);
    picks.push(c);
    if (picks.length >= 3) break;
  }
  return picks.map((c) => ({
    command: c.command,
    parameter: c.exampleParams?.[0],
    description: c.description,
  }));
}

// ---- Overlay loader ----------------------------------------------------
//
// Users can drop a `~/.switchbot/catalog.json` file to override or extend
// the built-in catalog without waiting on a CLI release. The overlay is a
// list of DeviceCatalogEntry objects; each entry matches on `type`:
//   - Entry with `type` matching a built-in replaces that built-in entry.
//   - Entry with a new `type` is appended.
//   - Entry with `{ type: "X", remove: true }` deletes the built-in.
//
// The overlay is loaded once per process and cached. Malformed JSON or
// files that don't match the expected shape are ignored (with a warning
// to stderr in verbose mode).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface CatalogOverlayEntry extends Partial<DeviceCatalogEntry> {
  type: string;
  remove?: boolean;
}

export interface OverlayLoadResult {
  path: string;
  exists: boolean;
  entries: CatalogOverlayEntry[];
  error?: string;
}

function overlayFilePath(): string {
  return path.join(os.homedir(), '.switchbot', 'catalog.json');
}

export function getCatalogOverlayPath(): string {
  return overlayFilePath();
}

/** Read the overlay file. Never throws — returns `error` on bad files. */
export function loadCatalogOverlay(): OverlayLoadResult {
  const file = overlayFilePath();
  if (!fs.existsSync(file)) {
    return { path: file, exists: false, entries: [] };
  }
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return {
        path: file,
        exists: true,
        entries: [],
        error: 'overlay must be a JSON array of device catalog entries',
      };
    }
    const entries: CatalogOverlayEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || typeof item.type !== 'string') {
        return {
          path: file,
          exists: true,
          entries: [],
          error: 'every overlay entry must be an object with a string `type`',
        };
      }
      entries.push(item as CatalogOverlayEntry);
    }
    return { path: file, exists: true, entries };
  } catch (err) {
    return {
      path: file,
      exists: true,
      entries: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

let overlayCache: OverlayLoadResult | null = null;

function overlayOnce(): OverlayLoadResult {
  if (overlayCache === null) overlayCache = loadCatalogOverlay();
  return overlayCache;
}

/** Clear the overlay cache (test helper; also useful for `catalog refresh`). */
export function resetCatalogOverlayCache(): void {
  overlayCache = null;
}

/** Merge built-in catalog with the on-disk overlay. */
export function getEffectiveCatalog(): DeviceCatalogEntry[] {
  const overlay = overlayOnce();
  if (!overlay.entries.length) return DEVICE_CATALOG;

  const byType = new Map<string, DeviceCatalogEntry>();
  for (const e of DEVICE_CATALOG) byType.set(e.type, e);

  for (const entry of overlay.entries) {
    if (entry.remove) {
      byType.delete(entry.type);
      continue;
    }
    const existing = byType.get(entry.type);
    if (existing) {
      byType.set(entry.type, { ...existing, ...entry } as DeviceCatalogEntry);
    } else if (entry.category && entry.commands) {
      // New entry — require the fields the renderer needs. Missing fields
      // would make the new entry crash later, so skip silently rather than
      // ship half-valid data to the user.
      byType.set(entry.type, entry as DeviceCatalogEntry);
    }
  }

  return Array.from(byType.values());
}

