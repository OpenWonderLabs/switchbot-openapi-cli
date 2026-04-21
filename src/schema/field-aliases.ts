import { UsageError } from '../utils/output.js';

export const FIELD_ALIASES: Record<string, readonly string[]> = {
  deviceId: ['id'],
  deviceName: ['name'],
  deviceType: ['type'],
  controlType: ['control', 'category'],
  roomName: ['room'],
  roomID: ['roomid'],
  familyName: ['family'],
  hubDeviceId: ['hub'],
  enableCloudService: ['cloud'],
  category: ['category'],
  alias: ['alias'],
};

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
    const aliases = FIELD_ALIASES[canonical] ?? [];
    if (aliases.some((a) => a.toLowerCase() === normalized)) return canonical;
  }
  throw new UsageError(
    `Unknown field "${input}". Supported: ${listSupportedFieldInputs(allowedCanonical).join(', ')}`,
  );
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

