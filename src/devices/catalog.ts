/**
 * Static catalog of SwitchBot device types, control commands and status fields.
 * Sourced from https://github.com/OpenWonderLabs/SwitchBotAPI — keep in sync
 * when the upstream API adds new device types.
 */

export interface CommandSpec {
  command: string;
  parameter: string;
  description: string;
  commandType?: 'command' | 'customize';
}

export interface DeviceCatalogEntry {
  type: string;
  category: 'physical' | 'ir';
  aliases?: string[];
  commands: CommandSpec[];
  statusFields?: string[];
}

const onOff: CommandSpec[] = [
  { command: 'turnOn', parameter: '—', description: 'Power on' },
  { command: 'turnOff', parameter: '—', description: 'Power off' },
];
const onOffToggle: CommandSpec[] = [
  ...onOff,
  { command: 'toggle', parameter: '—', description: 'Toggle power' },
];
const lightControls: CommandSpec[] = [
  { command: 'setBrightness', parameter: '1-100', description: 'Set brightness percentage' },
  { command: 'setColor', parameter: 'R:G:B (0-255 each)', description: 'Set RGB color, e.g. "255:0:0"' },
  { command: 'setColorTemperature', parameter: '2700-6500', description: 'Set color temperature (Kelvin)' },
];

export const DEVICE_CATALOG: DeviceCatalogEntry[] = [
  // ---------- Physical devices ----------
  {
    type: 'Bot',
    category: 'physical',
    commands: [
      ...onOff,
      { command: 'press', parameter: '—', description: 'Press the button (momentary)' },
    ],
    statusFields: ['power', 'battery', 'deviceMode', 'version'],
  },
  {
    type: 'Curtain',
    category: 'physical',
    aliases: ['Curtain3', 'Curtain 3'],
    commands: [
      ...onOff,
      { command: 'pause', parameter: '—', description: 'Stop movement' },
      { command: 'setPosition', parameter: '0-100 (0=open, 100=closed)', description: 'Move to a position' },
      { command: 'setPosition', parameter: 'index,mode,position  (e.g. "0,ff,80")', description: 'Multi-arg form: mode=0 Performance | 1 Silent | ff default' },
    ],
    statusFields: ['calibrate', 'group', 'moving', 'slidePosition', 'battery', 'version'],
  },
  {
    type: 'Smart Lock',
    category: 'physical',
    aliases: ['Smart Lock Pro'],
    commands: [
      { command: 'lock', parameter: '—', description: 'Lock the door' },
      { command: 'unlock', parameter: '—', description: 'Unlock the door' },
      { command: 'deadbolt', parameter: '—', description: 'Pro only: engage deadbolt' },
    ],
    statusFields: ['battery', 'version', 'lockState', 'doorState', 'calibrate'],
  },
  {
    type: 'Smart Lock Lite',
    category: 'physical',
    commands: [
      { command: 'lock', parameter: '—', description: 'Lock the door' },
      { command: 'unlock', parameter: '—', description: 'Unlock the door' },
    ],
    statusFields: ['battery', 'version', 'lockState', 'doorState', 'calibrate'],
  },
  {
    type: 'Smart Lock Ultra',
    category: 'physical',
    commands: [
      { command: 'lock', parameter: '—', description: 'Lock the door' },
      { command: 'unlock', parameter: '—', description: 'Unlock the door' },
      { command: 'deadbolt', parameter: '—', description: 'Engage deadbolt' },
    ],
    statusFields: ['battery', 'version', 'lockState', 'doorState', 'calibrate'],
  },
  {
    type: 'Plug',
    category: 'physical',
    commands: onOffToggle,
    statusFields: ['power', 'version'],
  },
  {
    type: 'Plug Mini (US)',
    category: 'physical',
    aliases: ['Plug Mini (JP)'],
    commands: onOffToggle,
    statusFields: ['voltage', 'weight', 'electricityOfDay', 'electricCurrent', 'power', 'version'],
  },
  {
    type: 'Relay Switch 1',
    category: 'physical',
    aliases: ['Relay Switch 1PM'],
    commands: [
      ...onOffToggle,
      { command: 'setMode', parameter: '0=toggle | 1=edge | 2=detached | 3=momentary', description: 'Switch operating mode' },
    ],
    statusFields: ['switchStatus', 'voltage', 'version', 'useTime', 'electricCurrent', 'power', 'usedElectricity'],
  },
  {
    type: 'Relay Switch 2PM',
    category: 'physical',
    commands: [
      { command: 'turnOn', parameter: '1 | 2 (channel)', description: 'Turn on channel 1 or 2' },
      { command: 'turnOff', parameter: '1 | 2 (channel)', description: 'Turn off channel 1 or 2' },
      { command: 'toggle', parameter: '1 | 2 (channel)', description: 'Toggle channel 1 or 2' },
      { command: 'setMode', parameter: '"<channel>;<mode>" e.g. "1;0"', description: 'Per-channel mode (see Relay Switch 1 modes)' },
      { command: 'setPosition', parameter: '0-100 (roller percentage)', description: 'Roller-shade-pair mode only' },
    ],
    statusFields: ['switch1Status', 'switch2Status', 'voltage', 'electricCurrent', 'power', 'usedElectricity'],
  },
  {
    type: 'Humidifier',
    category: 'physical',
    commands: [
      ...onOff,
      { command: 'setMode', parameter: 'auto | 101 (34%) | 102 (67%) | 103 (100%) | 0-100', description: 'Set preset or target humidity' },
    ],
    statusFields: ['power', 'humidity', 'temperature', 'nebulizationEfficiency', 'auto', 'childLock', 'sound', 'lackWater'],
  },
  {
    type: 'Humidifier2',
    category: 'physical',
    aliases: ['Evaporative Humidifier'],
    commands: [
      ...onOff,
      { command: 'setMode', parameter: '\'{"mode":1-8,"targetHumidify":0-100}\'', description: 'mode: 1=lv4 2=lv3 3=lv2 4=lv1 5=humidity 6=sleep 7=auto 8=drying' },
      { command: 'setChildLock', parameter: 'true | false', description: 'Enable or disable child lock' },
    ],
    statusFields: ['power', 'humidity', 'temperature', 'mode', 'childLock', 'filterElement'],
  },
  {
    type: 'Air Purifier VOC',
    category: 'physical',
    aliases: ['Air Purifier PM2.5', 'Air Purifier Table VOC', 'Air Purifier Table PM2.5'],
    commands: [
      ...onOff,
      { command: 'setMode', parameter: '\'{"mode":1-4,"fanGear":1-3}\'', description: 'mode: 1=normal 2=auto 3=sleep 4=pet; fanGear only when mode=1' },
      { command: 'setChildLock', parameter: '0 | 1', description: 'Disable / enable child lock' },
    ],
    statusFields: ['power', 'mode', 'childLock', 'filterElement'],
  },
  {
    type: 'Color Bulb',
    category: 'physical',
    commands: [...onOffToggle, ...lightControls],
    statusFields: ['power', 'brightness', 'color', 'colorTemperature', 'version'],
  },
  {
    type: 'Strip Light',
    category: 'physical',
    commands: [...onOffToggle, ...lightControls.slice(0, 2)],
    statusFields: ['power', 'brightness', 'color', 'version'],
  },
  {
    type: 'Ceiling Light',
    category: 'physical',
    aliases: ['Ceiling Light Pro'],
    commands: [
      ...onOffToggle,
      { command: 'setBrightness', parameter: '1-100', description: 'Set brightness percentage' },
      { command: 'setColorTemperature', parameter: '2700-6500', description: 'Set color temperature (Kelvin)' },
    ],
    statusFields: ['power', 'brightness', 'colorTemperature', 'version'],
  },
  {
    type: 'Smart Radiator Thermostat',
    category: 'physical',
    commands: [
      ...onOff,
      { command: 'setMode', parameter: '0=schedule 1=manual 2=off 3=eco 4=comfort 5=quickHeat', description: 'Operating mode' },
      { command: 'setManualModeTemperature', parameter: '5-30 (°C)', description: 'Target temperature in manual mode' },
    ],
    statusFields: ['power', 'temperature', 'humidity', 'battery', 'version', 'mode', 'targetTemperature'],
  },
  {
    type: 'Robot Vacuum Cleaner S1',
    category: 'physical',
    aliases: ['Robot Vacuum Cleaner S1 Plus', 'K10+'],
    commands: [
      { command: 'start', parameter: '—', description: 'Start cleaning' },
      { command: 'stop', parameter: '—', description: 'Stop cleaning' },
      { command: 'dock', parameter: '—', description: 'Return to dock' },
      { command: 'PowLevel', parameter: '0-3', description: '0=Quiet 1=Standard 2=Strong 3=Max' },
    ],
    statusFields: ['workingStatus', 'onlineStatus', 'battery', 'version'],
  },
  {
    type: 'K10+ Pro Combo',
    category: 'physical',
    aliases: ['K20+ Pro'],
    commands: [
      { command: 'startClean', parameter: '\'{"action":"sweep"|"mop","param":{"fanLevel":1-4,"times":1-2639999}}\'', description: 'Begin a cleaning session' },
      { command: 'pause', parameter: '—', description: 'Pause cleaning' },
      { command: 'dock', parameter: '—', description: 'Return to dock' },
      { command: 'setVolume', parameter: '0-100', description: 'Set voice volume' },
      { command: 'changeParam', parameter: '\'{"fanLevel":1-4,"waterLevel":1-2,"times":1-2639999}\'', description: 'Change parameters mid-run' },
    ],
    statusFields: ['workingStatus', 'onlineStatus', 'battery', 'taskType'],
  },
  {
    type: 'Floor Cleaning Robot S10',
    category: 'physical',
    aliases: ['Robot Vacuum Cleaner S10', 'Robot Vacuum Cleaner S20'],
    commands: [
      { command: 'startClean', parameter: '\'{"action":"sweep"|"sweep_mop","param":{"fanLevel":1-4,"waterLevel":1-2,"times":1-2639999}}\'', description: 'Begin a cleaning session' },
      { command: 'pause', parameter: '—', description: 'Pause cleaning' },
      { command: 'dock', parameter: '—', description: 'Return to dock' },
      { command: 'addWaterForHumi', parameter: '—', description: 'Refill the humidifier water tank' },
      { command: 'selfClean', parameter: '1 | 2 | 3', description: '1=wash mop | 2=dry | 3=terminate self-clean' },
      { command: 'setVolume', parameter: '0-100', description: 'Set voice volume' },
      { command: 'changeParam', parameter: '\'{"fanLevel":1-4,"waterLevel":1-2,"times":1-2639999}\'', description: 'Change parameters mid-run' },
    ],
    statusFields: ['workingStatus', 'onlineStatus', 'battery', 'taskType'],
  },
  {
    type: 'Battery Circulator Fan',
    category: 'physical',
    aliases: ['Circulator Fan'],
    commands: [
      ...onOffToggle,
      { command: 'setNightLightMode', parameter: 'off | 1 | 2', description: 'Night-light mode' },
      { command: 'setWindMode', parameter: 'direct | natural | sleep | baby', description: 'Wind mode' },
      { command: 'setWindSpeed', parameter: '1-100', description: 'Fan speed' },
      { command: 'closeDelay', parameter: 'seconds', description: 'Auto-off timer in seconds' },
    ],
    statusFields: ['mode', 'version', 'battery', 'power', 'nightStatus', 'oscillation', 'verticalOscillation', 'chargingStatus', 'fanSpeed'],
  },
  {
    type: 'Blind Tilt',
    category: 'physical',
    commands: [
      ...onOff,
      { command: 'setPosition', parameter: '"<direction>;<angle>" (up|down; 0,2,...,100)', description: 'Tilt direction + angle (0=closed, 100=open)' },
      { command: 'fullyOpen', parameter: '—', description: 'Open fully' },
      { command: 'closeUp', parameter: '—', description: 'Close up' },
      { command: 'closeDown', parameter: '—', description: 'Close down' },
    ],
    statusFields: ['version', 'calibrate', 'group', 'moving', 'direction', 'slidePosition', 'battery'],
  },
  {
    type: 'Roller Shade',
    category: 'physical',
    commands: [
      ...onOff,
      { command: 'setPosition', parameter: '0-100 (0=open, 100=closed)', description: 'Move to a position' },
    ],
    statusFields: ['slidePosition', 'battery', 'version', 'moving'],
  },
  {
    type: 'Garage Door Opener',
    category: 'physical',
    commands: onOff,
    statusFields: ['switchStatus', 'version', 'online'],
  },
  {
    type: 'Video Doorbell',
    category: 'physical',
    commands: [
      { command: 'enableMotionDetection', parameter: '—', description: 'Enable motion detection' },
      { command: 'disableMotionDetection', parameter: '—', description: 'Disable motion detection' },
    ],
    statusFields: ['battery', 'version'],
  },
  {
    type: 'Keypad',
    category: 'physical',
    aliases: ['Keypad Touch'],
    commands: [
      { command: 'createKey', parameter: '\'{"name":"...","type":"permanent|timeLimit|disposable|urgent","password":"6-12 digits","startTime":<s>,"endTime":<s>}\'', description: 'Create a passcode (async; result via webhook)' },
      { command: 'deleteKey', parameter: '\'{"id":<passcode_id>}\'', description: 'Delete a passcode (async; result via webhook)' },
    ],
    statusFields: ['version'],
  },
  {
    type: 'Candle Warmer Lamp',
    category: 'physical',
    commands: [
      ...onOffToggle,
      { command: 'setBrightness', parameter: '1-100', description: 'Set brightness percentage' },
      { command: 'setColorTemperature', parameter: '2700-6500', description: 'Set color temperature (Kelvin)' },
    ],
    statusFields: ['power', 'brightness', 'colorTemperature', 'version'],
  },
  // Status-only devices (no commands)
  {
    type: 'Meter',
    category: 'physical',
    aliases: ['Meter Plus', 'MeterPro', 'MeterPro(CO2)', 'WoIOSensor', 'Hub 2'],
    commands: [],
    statusFields: ['temperature', 'humidity', 'CO2', 'battery', 'version'],
  },
  {
    type: 'Motion Sensor',
    category: 'physical',
    commands: [],
    statusFields: ['battery', 'version', 'moveDetected', 'brightness', 'openState'],
  },
  {
    type: 'Contact Sensor',
    category: 'physical',
    commands: [],
    statusFields: ['battery', 'version', 'moveDetected', 'openState', 'brightness'],
  },
  {
    type: 'Water Leak Detector',
    category: 'physical',
    commands: [],
    statusFields: ['battery', 'version', 'status'],
  },

  // ---------- Virtual IR remotes ----------
  {
    type: 'Air Conditioner',
    category: 'ir',
    commands: [
      ...onOff,
      { command: 'setAll', parameter: '"<temp>,<mode>,<fan>,<on|off>"', description: 'mode: 1=auto 2=cool 3=dry 4=fan 5=heat; fan: 1=auto 2=low 3=mid 4=high' },
    ],
  },
  {
    type: 'TV',
    category: 'ir',
    aliases: ['IPTV', 'Streamer', 'Set Top Box'],
    commands: [
      ...onOff,
      { command: 'SetChannel', parameter: '1-999 (channel number)', description: 'Switch to a specific channel' },
      { command: 'volumeAdd', parameter: '—', description: 'Volume up' },
      { command: 'volumeSub', parameter: '—', description: 'Volume down' },
      { command: 'channelAdd', parameter: '—', description: 'Channel up' },
      { command: 'channelSub', parameter: '—', description: 'Channel down' },
    ],
  },
  {
    type: 'DVD',
    category: 'ir',
    aliases: ['Speaker'],
    commands: [
      ...onOff,
      { command: 'setMute', parameter: '—', description: 'Toggle mute' },
      { command: 'FastForward', parameter: '—', description: 'Fast forward' },
      { command: 'Rewind', parameter: '—', description: 'Rewind' },
      { command: 'Next', parameter: '—', description: 'Next track' },
      { command: 'Previous', parameter: '—', description: 'Previous track' },
      { command: 'Pause', parameter: '—', description: 'Pause' },
      { command: 'Play', parameter: '—', description: 'Play' },
      { command: 'Stop', parameter: '—', description: 'Stop' },
      { command: 'volumeAdd', parameter: '—', description: 'Volume up' },
      { command: 'volumeSub', parameter: '—', description: 'Volume down' },
    ],
  },
  {
    type: 'Fan',
    category: 'ir',
    commands: [
      ...onOff,
      { command: 'swing', parameter: '—', description: 'Toggle swing' },
      { command: 'timer', parameter: '—', description: 'Toggle timer' },
      { command: 'lowSpeed', parameter: '—', description: 'Low speed' },
      { command: 'middleSpeed', parameter: '—', description: 'Medium speed' },
      { command: 'highSpeed', parameter: '—', description: 'High speed' },
    ],
  },
  {
    type: 'Light',
    category: 'ir',
    commands: [
      ...onOff,
      { command: 'brightnessUp', parameter: '—', description: 'Brightness up' },
      { command: 'brightnessDown', parameter: '—', description: 'Brightness down' },
    ],
  },
  {
    type: 'Others',
    category: 'ir',
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
