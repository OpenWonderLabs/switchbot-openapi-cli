import type { DeviceShadowEvent } from './types.js';

export function extractShadowEvent(message: unknown): DeviceShadowEvent | null {
  if (!message || typeof message !== 'object') return null;
  const m = message as Record<string, unknown>;

  const state = m.state as Record<string, unknown> | undefined;
  if (!state) return null;

  const deviceId = (m.clientId as string) || (state.deviceId as string);
  const deviceType = (state.deviceType as string) || 'Unknown';

  if (!deviceId) return null;

  return {
    ts: new Date().toISOString(),
    deviceId,
    deviceType,
    payload: state,
  };
}
