import { describe, it, expect } from 'vitest';
import { extractShadowEvent } from '../../src/commands/events.js';
import { matchShadowEventFilter, parseEventStreamFilter } from '../../src/utils/filter.js';

describe('extractShadowEvent', () => {
  it('returns null for non-object messages', () => {
    expect(extractShadowEvent(null)).toBeNull();
    expect(extractShadowEvent(undefined)).toBeNull();
    expect(extractShadowEvent('x')).toBeNull();
    expect(extractShadowEvent(42)).toBeNull();
  });

  it('returns null when state is missing', () => {
    expect(extractShadowEvent({ clientId: 'ABC' })).toBeNull();
  });

  it('returns null when deviceId cannot be resolved', () => {
    expect(extractShadowEvent({ state: { battery: 90 } })).toBeNull();
  });

  it('uses top-level clientId for deviceId when present', () => {
    const ev = extractShadowEvent({
      clientId: 'ABC123',
      state: { deviceType: 'Motion Sensor', moveDetected: true },
    });
    expect(ev).not.toBeNull();
    expect(ev?.deviceId).toBe('ABC123');
    expect(ev?.deviceType).toBe('Motion Sensor');
    expect(ev?.payload).toEqual({ deviceType: 'Motion Sensor', moveDetected: true });
  });

  it('falls back to state.deviceId when clientId is missing', () => {
    const ev = extractShadowEvent({
      state: { deviceId: 'DEF456', deviceType: 'Contact Sensor', openState: 'open' },
    });
    expect(ev?.deviceId).toBe('DEF456');
    expect(ev?.deviceType).toBe('Contact Sensor');
  });

  it('defaults deviceType to "Unknown" when not provided', () => {
    const ev = extractShadowEvent({ clientId: 'X', state: { battery: 50 } });
    expect(ev?.deviceType).toBe('Unknown');
  });

  it('stamps an ISO timestamp', () => {
    const before = Date.now();
    const ev = extractShadowEvent({ clientId: 'X', state: { deviceType: 'Bot' } });
    const after = Date.now();
    expect(ev).not.toBeNull();
    const ts = new Date(ev!.ts).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe('events stream filter end-to-end', () => {
  // Reproduces the real pipeline: parse user flag → extract shadow event →
  // match filter. This is the path that silently broke before the #4 fix
  // because matchEventStreamFilter looked for ctx.deviceMac on the payload.
  const message = {
    clientId: 'ABC123',
    state: { deviceType: 'Motion Sensor', moveDetected: true, battery: 92 },
  };

  it('deviceId filter matches top-level deviceId on the shadow event', () => {
    const ev = extractShadowEvent(message)!;
    const filter = parseEventStreamFilter('deviceId=ABC123');
    expect(matchShadowEventFilter(ev, filter)).toBe(true);
  });

  it('deviceId filter rejects other devices', () => {
    const ev = extractShadowEvent(message)!;
    const filter = parseEventStreamFilter('deviceId=OTHER');
    expect(matchShadowEventFilter(ev, filter)).toBe(false);
  });

  it('type filter matches on deviceType from state', () => {
    const ev = extractShadowEvent(message)!;
    const filter = parseEventStreamFilter('type=Motion Sensor');
    expect(matchShadowEventFilter(ev, filter)).toBe(true);
  });

  it('type filter rejects other types', () => {
    const ev = extractShadowEvent(message)!;
    const filter = parseEventStreamFilter('type=Bot');
    expect(matchShadowEventFilter(ev, filter)).toBe(false);
  });

  it('null filter passes everything through', () => {
    const ev = extractShadowEvent(message)!;
    expect(matchShadowEventFilter(ev, null)).toBe(true);
  });
});
