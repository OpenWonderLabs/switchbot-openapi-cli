export interface DeviceContext {
  deviceMac?: string;
  deviceType?: string;
  temperature?: number;
  humidity?: number;
  power?: string;
  battery?: number;
  brightness?: string;
  detectionState?: string;
  openState?: string;
  lockState?: string;
  lightLevel?: number;
  [key: string]: unknown;
}

const ICONS: Record<string, string> = {
  'Bot': '🤖',
  'Curtain': '🪟',
  'Hub': '📡',
  'Hub 2': '📡',
  'Hub 3': '📡',
  'Hub Mini': '📡',
  'Smart Lock': '🔒',
  'Smart Lock Pro': '🔒',
  'Plug': '🔌',
  'Plug Mini (US)': '🔌',
  'Plug Mini (JP)': '🔌',
  'Color Bulb': '💡',
  'Strip Light': '💡',
  'Contact Sensor': '🚪',
  'Motion Sensor': '👁',
  'Meter': '🌡',
  'MeterPro': '🌡',
  'Climate Panel': '🌡',
  'WoMeter': '🌡',
  'WoIOSensor': '🌡',
};

function icon(deviceType: string): string {
  return ICONS[deviceType] ?? '📱';
}

export function formatEventText(context: DeviceContext): string {
  const type = context.deviceType ?? 'Unknown';
  const pfx = `${icon(type)} ${type}`;
  const parts: string[] = [];

  if (context.temperature !== undefined) parts.push(`${context.temperature}°C`);
  if (context.humidity !== undefined) parts.push(`${context.humidity}%`);
  if (parts.length) return `${pfx}: ${parts.join(' / ')}`;

  if (context.power !== undefined) return `${pfx}: ${context.power}`;
  if (context.lockState !== undefined) return `${pfx}: ${context.lockState}`;
  if (context.openState !== undefined) return `${pfx}: ${context.openState}`;
  if (context.detectionState !== undefined) return `${pfx}: ${context.detectionState}`;
  if (context.brightness !== undefined) return `${pfx}: ${context.brightness}`;

  return `${pfx}: state change`;
}

export function parseSinkEvent(payload: unknown): {
  deviceId: string;
  deviceType: string;
  text: string;
} {
  const p = payload as Record<string, unknown> | null | undefined;
  const context = ((p?.context ?? {}) as DeviceContext);
  return {
    deviceId: String(context.deviceMac ?? 'unknown'),
    deviceType: String(context.deviceType ?? 'Unknown'),
    text: formatEventText(context),
  };
}
