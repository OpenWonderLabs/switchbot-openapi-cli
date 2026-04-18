/**
 * Static catalog of SwitchBot device types, control commands and status fields.
 * Sourced from https://github.com/OpenWonderLabs/SwitchBotAPI — keep in sync
 * when the upstream API adds new device types.
 *
 * Field conventions:
 *   - CommandSpec.idempotent: repeat-safe — calling it N times ends in the
 *     same state as calling it once (turnOn, setBrightness 50). Agents can
 *     retry these freely. Counter-examples: toggle, press, volumeAdd.
 *   - CommandSpec.destructive: causes a real-world effect that is hard or
 *     unsafe to reverse (unlock, garage open, deleteKey). UIs and agents
 *     should require explicit confirmation before issuing these.
 *   - DeviceCatalogEntry.role: functional grouping for filter/search
 *     ("all lighting", "all security"). Does not affect API behavior.
 *   - DeviceCatalogEntry.readOnly: the device has no control commands; it
 *     can only be queried via 'devices status'.
 */

export interface CommandSpec {
  command: string;
  parameter: string;
  description: string;
  commandType?: 'command' | 'customize';
  idempotent?: boolean;
  destructive?: boolean;
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
  aliases?: string[];
  commands: CommandSpec[];
  statusFields?: string[];
  role?: DeviceRole;
  readOnly?: boolean;
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
    role: 'security',
    aliases: ['Smart Lock Pro'],
    commands: [
      { command: 'lock', parameter: '—', description: 'Lock the door', idempotent: true },
      { command: 'unlock', parameter: '—', description: 'Unlock the door', idempotent: true, destructive: true },
      { command: 'deadbolt', parameter: '—', description: 'Pro only: engage deadbolt', idempotent: true },
    ],
    statusFields: ['battery', 'version', 'lockState', 'doorState', 'calibrate'],
  },
  {
    type: 'Smart Lock Lite',
    category: 'physical',
    role: 'security',
    commands: [
      { command: 'lock', parameter: '—', description: 'Lock the door', idempotent: true },
      { command: 'unlock', parameter: '—', description: 'Unlock the door', idempotent: true, destructive: true },
    ],
    statusFields: ['battery', 'version', 'lockState', 'doorState', 'calibrate'],
  },
  {
    type: 'Smart Lock Ultra',
    category: 'physical',
    role: 'security',
    commands: [
      { command: 'lock', parameter: '—', description: 'Lock the door', idempotent: true },
      { command: 'unlock', parameter: '—', description: 'Unlock the door', idempotent: true, destructive: true },
      { command: 'deadbolt', parameter: '—', description: 'Engage deadbolt', idempotent: true },
    ],
    statusFields: ['battery', 'version', 'lockState', 'doorState', 'calibrate'],
  },
  {
    type: 'Plug',
    category: 'physical',
    role: 'power',
    commands: onOffToggle,
    statusFields: ['power', 'version'],
  },
  {
    type: 'Plug Mini (US)',
    category: 'physical',
    role: 'power',
    aliases: ['Plug Mini (JP)'],
    commands: onOffToggle,
    statusFields: ['voltage', 'weight', 'electricityOfDay', 'electricCurrent', 'power', 'version'],
  },
  {
    type: 'Relay Switch 1',
    category: 'physical',
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
    role: 'lighting',
    commands: [...onOffToggle, ...lightControls],
    statusFields: ['power', 'brightness', 'color', 'colorTemperature', 'version'],
  },
  {
    type: 'Strip Light',
    category: 'physical',
    role: 'lighting',
    aliases: ['Strip Light 3'],
    commands: [...onOffToggle, ...lightControls],
    statusFields: ['power', 'brightness', 'color', 'colorTemperature', 'version'],
  },
  {
    type: 'Ceiling Light',
    category: 'physical',
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
    role: 'cleaning',
    aliases: ['Robot Vacuum Cleaner S1 Plus', 'K10+'],
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
    role: 'security',
    commands: [
      { command: 'turnOn', parameter: '—', description: 'Open the garage door', idempotent: true, destructive: true },
      { command: 'turnOff', parameter: '—', description: 'Close the garage door', idempotent: true, destructive: true },
    ],
    statusFields: ['switchStatus', 'version', 'online'],
  },
  {
    type: 'Video Doorbell',
    category: 'physical',
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
    role: 'security',
    aliases: ['Keypad Touch'],
    commands: [
      { command: 'createKey', parameter: '\'{"name":"...","type":"permanent|timeLimit|disposable|urgent","password":"6-12 digits","startTime":<s>,"endTime":<s>}\'', description: 'Create a passcode (async; result via webhook)', idempotent: false, destructive: true },
      { command: 'deleteKey', parameter: '\'{"id":<passcode_id>}\'', description: 'Delete a passcode (async; result via webhook)', idempotent: true, destructive: true },
    ],
    statusFields: ['version'],
  },
  {
    type: 'Candle Warmer Lamp',
    category: 'physical',
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
    role: 'sensor',
    readOnly: true,
    aliases: ['Meter Plus', 'MeterPro', 'MeterPro(CO2)', 'WoIOSensor', 'Hub 2'],
    commands: [],
    statusFields: ['temperature', 'humidity', 'CO2', 'battery', 'version'],
  },
  {
    type: 'Motion Sensor',
    category: 'physical',
    role: 'sensor',
    readOnly: true,
    commands: [],
    statusFields: ['battery', 'version', 'moveDetected', 'brightness', 'openState'],
  },
  {
    type: 'Contact Sensor',
    category: 'physical',
    role: 'sensor',
    readOnly: true,
    commands: [],
    statusFields: ['battery', 'version', 'moveDetected', 'openState', 'brightness'],
  },
  {
    type: 'Water Leak Detector',
    category: 'physical',
    role: 'sensor',
    readOnly: true,
    commands: [],
    statusFields: ['battery', 'version', 'status'],
  },
  // Status-only hub-class devices (no control commands)
  {
    type: 'Hub Mini',
    category: 'physical',
    role: 'hub',
    readOnly: true,
    aliases: ['Hub Mini2'],
    commands: [],
    statusFields: ['version'],
  },
  {
    type: 'Hub 3',
    category: 'physical',
    role: 'hub',
    readOnly: true,
    commands: [],
    statusFields: ['version', 'temperature', 'humidity', 'lightLevel'],
  },
  {
    type: 'AI Hub',
    category: 'physical',
    role: 'hub',
    readOnly: true,
    commands: [],
    statusFields: ['version'],
  },
  {
    type: 'Home Climate Panel',
    category: 'physical',
    role: 'climate',
    readOnly: true,
    commands: [],
    statusFields: ['temperature', 'humidity', 'version'],
  },
  {
    type: 'Wallet Finder Card',
    category: 'physical',
    role: 'sensor',
    readOnly: true,
    commands: [],
    statusFields: ['battery', 'version'],
  },
  {
    type: 'Outdoor Spotlight Cam',
    category: 'physical',
    role: 'security',
    readOnly: true,
    commands: [],
    statusFields: ['battery', 'version'],
  },

  // ---------- Virtual IR remotes ----------
  {
    type: 'Air Conditioner',
    category: 'ir',
    role: 'climate',
    commands: [
      ...onOff,
      { command: 'setAll', parameter: '"<temp>,<mode>,<fan>,<on|off>"', description: 'mode: 1=auto 2=cool 3=dry 4=fan 5=heat; fan: 1=auto 2=low 3=mid 4=high', idempotent: true, exampleParams: ['26,2,3,on', '22,5,2,on'] },
    ],
  },
  {
    type: 'TV',
    category: 'ir',
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

  const exact = DEVICE_CATALOG.find((e) =>
    names(e).some((n) => n.toLowerCase() === q)
  );
  if (exact) return exact;

  const matches = DEVICE_CATALOG.filter((e) =>
    names(e).some((n) => n.toLowerCase().includes(q))
  );
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  return matches;
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
    (c) => c.idempotent === true && !c.destructive && c.commandType !== 'customize'
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
