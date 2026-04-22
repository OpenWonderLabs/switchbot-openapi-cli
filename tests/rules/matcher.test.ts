import { describe, it, expect } from 'vitest';
import {
  classifyMqttPayload,
  evaluateConditions,
  matchesMqttTrigger,
} from '../../src/rules/matcher.js';
import type { EngineEvent, MqttTrigger } from '../../src/rules/types.js';

function at(hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

const motionEvent: EngineEvent = {
  source: 'mqtt',
  event: 'motion.detected',
  deviceId: 'AA:BB:CC:DD:EE:01',
  t: at('23:00'),
  payload: { context: {} },
};

describe('classifyMqttPayload', () => {
  it('maps detectionState=DETECTED to motion.detected', () => {
    const out = classifyMqttPayload({ context: { deviceMac: 'X', detectionState: 'DETECTED' } });
    expect(out).toEqual({ event: 'motion.detected', deviceId: 'X' });
  });

  it('maps openState=OPEN to contact.opened', () => {
    const out = classifyMqttPayload({ context: { deviceMac: 'Y', openState: 'OPEN' } });
    expect(out).toEqual({ event: 'contact.opened', deviceId: 'Y' });
  });

  it('maps openState=CLOSE to contact.closed', () => {
    const out = classifyMqttPayload({ context: { deviceMac: 'Y', openState: 'CLOSE' } });
    expect(out.event).toBe('contact.closed');
  });

  it('falls back to device.shadow when no classifier matches', () => {
    const out = classifyMqttPayload({ context: { deviceMac: 'Z', temperature: 22 } });
    expect(out).toEqual({ event: 'device.shadow', deviceId: 'Z' });
  });

  it('tolerates missing context gracefully', () => {
    expect(classifyMqttPayload({})).toEqual({ event: 'device.shadow', deviceId: undefined });
    expect(classifyMqttPayload(null)).toEqual({ event: 'device.shadow', deviceId: undefined });
  });
});

describe('matchesMqttTrigger', () => {
  const trigger: MqttTrigger = { source: 'mqtt', event: 'motion.detected' };

  it('matches when event name is equal', () => {
    expect(matchesMqttTrigger(trigger, motionEvent, undefined)).toBe(true);
  });

  it('rejects when event name differs', () => {
    expect(
      matchesMqttTrigger({ ...trigger, event: 'contact.opened' }, motionEvent, undefined),
    ).toBe(false);
  });

  it('device.shadow trigger matches any classified event', () => {
    expect(
      matchesMqttTrigger({ source: 'mqtt', event: 'device.shadow' }, motionEvent, undefined),
    ).toBe(true);
  });

  it('honours the device filter when the trigger specifies one', () => {
    expect(matchesMqttTrigger(trigger, motionEvent, 'AA:BB:CC:DD:EE:01')).toBe(true);
    expect(matchesMqttTrigger(trigger, motionEvent, 'AA:BB:CC:DD:EE:99')).toBe(false);
  });

  it('returns false for non-mqtt event sources', () => {
    expect(
      matchesMqttTrigger(trigger, { ...motionEvent, source: 'cron' } as EngineEvent, undefined),
    ).toBe(false);
  });
});

describe('evaluateConditions', () => {
  it('returns matched=true when conditions list is empty or absent', () => {
    expect(evaluateConditions(undefined, at('12:00')).matched).toBe(true);
    expect(evaluateConditions([], at('12:00')).matched).toBe(true);
  });

  it('accepts time_between when `now` is inside the window', () => {
    const r = evaluateConditions([{ time_between: ['22:00', '07:00'] }], at('23:30'));
    expect(r.matched).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('rejects time_between with a descriptive failure when outside', () => {
    const r = evaluateConditions([{ time_between: ['22:00', '07:00'] }], at('14:00'));
    expect(r.matched).toBe(false);
    expect(r.failures[0]).toMatch(/time_between/);
  });

  it('flags device_state as unsupported without blocking downstream rules', () => {
    const r = evaluateConditions(
      [{ device: 'lamp', field: 'power', op: '==', value: 'on' }],
      at('12:00'),
    );
    expect(r.matched).toBe(false);
    expect(r.unsupported.map((u) => u.keyword)).toContain('device_state');
  });

  it('AND-joins multiple conditions: one failure means not matched', () => {
    const r = evaluateConditions(
      [
        { time_between: ['22:00', '07:00'] },
        { time_between: ['06:00', '10:00'] },
      ],
      at('23:30'),
    );
    expect(r.matched).toBe(false);
    expect(r.failures).toHaveLength(1);
  });
});
