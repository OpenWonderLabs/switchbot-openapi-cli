import { describe, it, expect } from 'vitest';
import { suggestPlan } from '../../src/commands/plan.js';

const devices = [
  { id: 'D1', name: 'living room light' },
  { id: 'D2', name: 'kitchen light' },
];

describe('suggestPlan', () => {
  it('infers turnOff from "turn off all lights"', () => {
    const { plan, warnings } = suggestPlan({ intent: 'turn off all lights', devices });
    expect(warnings).toEqual([]);
    expect(plan.version).toBe('1.0');
    expect(plan.description).toBe('turn off all lights');
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({ type: 'command', deviceId: 'D1', command: 'turnOff' });
    expect(plan.steps[1]).toMatchObject({ type: 'command', deviceId: 'D2', command: 'turnOff' });
  });

  it('infers turnOn from "turn on"', () => {
    const { plan, warnings } = suggestPlan({ intent: 'turn on', devices: [{ id: 'D1' }] });
    expect(warnings).toEqual([]);
    expect(plan.steps[0]).toMatchObject({ command: 'turnOn' });
  });

  it('infers turnOn from "start the fan"', () => {
    const { plan } = suggestPlan({ intent: 'start the fan', devices: [{ id: 'D1' }] });
    expect(plan.steps[0]).toMatchObject({ command: 'turnOn' });
  });

  it('infers turnOff from "stop the fan"', () => {
    const { plan } = suggestPlan({ intent: 'stop the fan', devices: [{ id: 'D1' }] });
    expect(plan.steps[0]).toMatchObject({ command: 'turnOff' });
  });

  it('infers press from "click the button"', () => {
    const { plan } = suggestPlan({ intent: 'click the button', devices: [{ id: 'D1' }] });
    expect(plan.steps[0]).toMatchObject({ command: 'press' });
  });

  it('infers lock from "lock the door"', () => {
    const { plan } = suggestPlan({ intent: 'lock the door', devices: [{ id: 'D1' }] });
    expect(plan.steps[0]).toMatchObject({ command: 'lock' });
  });

  it('infers unlock from "unlock"', () => {
    const { plan } = suggestPlan({ intent: 'unlock', devices: [{ id: 'D1' }] });
    expect(plan.steps[0]).toMatchObject({ command: 'unlock' });
  });

  it('infers open from "open the curtains"', () => {
    const { plan } = suggestPlan({ intent: 'open the curtains', devices: [{ id: 'D1' }] });
    expect(plan.steps[0]).toMatchObject({ command: 'open' });
  });

  it('infers close from "lower the blinds"', () => {
    const { plan } = suggestPlan({ intent: 'lower the blinds', devices: [{ id: 'D1' }] });
    expect(plan.steps[0]).toMatchObject({ command: 'close' });
  });

  it('infers pause from "pause the robot vacuum"', () => {
    const { plan } = suggestPlan({ intent: 'pause the robot vacuum', devices: [{ id: 'D1' }] });
    expect(plan.steps[0]).toMatchObject({ command: 'pause' });
  });

  it('defaults to turnOn with a warning when intent is unrecognized', () => {
    const { plan, warnings } = suggestPlan({ intent: 'do something weird', devices: [{ id: 'D1' }] });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('defaulted to "turnOn"');
    expect(plan.steps[0]).toMatchObject({ command: 'turnOn' });
  });

  it('fails fast on unsupported Chinese command intent instead of defaulting silently', () => {
    expect(() => suggestPlan({ intent: '关掉所有灯', devices: [{ id: 'D1' }] }))
      .toThrow(/cannot safely infer/i);
  });

  it('generates one step per device', () => {
    const { plan } = suggestPlan({ intent: 'turn off', devices });
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0]).toMatchObject({ deviceId: 'D1' });
    expect(plan.steps[1]).toMatchObject({ deviceId: 'D2' });
  });

  it('produces a structurally valid plan', () => {
    const { plan } = suggestPlan({ intent: 'press', devices: [{ id: 'D1' }, { id: 'D2' }] });
    expect(plan.version).toBe('1.0');
    expect(Array.isArray(plan.steps)).toBe(true);
    expect(plan.steps.every((s) => s.type === 'command')).toBe(true);
  });

  it('handles single device correctly', () => {
    const { plan, warnings } = suggestPlan({ intent: 'lock', devices: [{ id: 'LOCK-01' }] });
    expect(warnings).toEqual([]);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ deviceId: 'LOCK-01', command: 'lock' });
  });
});
