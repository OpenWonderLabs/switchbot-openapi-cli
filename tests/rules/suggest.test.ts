import { describe, it, expect } from 'vitest';
import { suggestRule } from '../../src/rules/suggest.js';

describe('suggestRule', () => {
  describe('trigger inference', () => {
    it('infers mqtt motion.detected from "motion" in intent', () => {
      const { rule, warnings } = suggestRule({ intent: 'when motion detected, turn on light' });
      expect(rule.when.source).toBe('mqtt');
      if (rule.when.source === 'mqtt') expect(rule.when.event).toBe('motion.detected');
      expect(warnings).toHaveLength(0);
    });

    it('infers mqtt contact.opened from "door" in intent', () => {
      const { rule } = suggestRule({ intent: 'when door opens, turn on porch light' });
      expect(rule.when.source).toBe('mqtt');
      if (rule.when.source === 'mqtt') expect(rule.when.event).toBe('contact.opened');
    });

    it('infers mqtt button.pressed from "button" in intent', () => {
      const { rule } = suggestRule({ intent: 'when button pressed, turn on lamp' });
      expect(rule.when.source).toBe('mqtt');
      if (rule.when.source === 'mqtt') expect(rule.when.event).toBe('button.pressed');
    });

    it('infers cron from "every morning"', () => {
      const { rule } = suggestRule({ intent: 'every morning turn on coffee maker' });
      expect(rule.when.source).toBe('cron');
    });

    it('infers webhook from "webhook" keyword', () => {
      const { rule } = suggestRule({ intent: 'on webhook call, toggle switch' });
      expect(rule.when.source).toBe('webhook');
    });

    it('defaults to mqtt with warning when intent is unrecognized', () => {
      const { rule, warnings } = suggestRule({ intent: 'do something weird' });
      expect(rule.when.source).toBe('mqtt');
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0]).toContain('defaulted to mqtt/device.shadow');
    });

    it('respects explicit --trigger override over inference', () => {
      const { rule } = suggestRule({ intent: 'motion detected', trigger: 'cron' });
      expect(rule.when.source).toBe('cron');
    });
  });

  describe('schedule inference (cron trigger)', () => {
    it('parses "8am" → "0 8 * * *"', () => {
      const { rule } = suggestRule({ intent: 'every day at 8am', trigger: 'cron' });
      if (rule.when.source === 'cron') expect(rule.when.schedule).toBe('0 8 * * *');
    });

    it('parses "10pm" → "0 22 * * *"', () => {
      const { rule } = suggestRule({ intent: 'turn off at 10pm', trigger: 'cron' });
      if (rule.when.source === 'cron') expect(rule.when.schedule).toBe('0 22 * * *');
    });

    it('parses "every hour" → "0 * * * *"', () => {
      const { rule } = suggestRule({ intent: 'every hour check lights', trigger: 'cron' });
      if (rule.when.source === 'cron') expect(rule.when.schedule).toBe('0 * * * *');
    });

    it('defaults to "0 8 * * *" with warning for unrecognized schedule intent', () => {
      const { rule, warnings } = suggestRule({ intent: 'on a schedule', trigger: 'cron' });
      if (rule.when.source === 'cron') expect(rule.when.schedule).toBe('0 8 * * *');
      expect(warnings.some((w) => w.includes('defaulted'))).toBe(true);
    });

    it('uses --schedule override when provided', () => {
      const { rule } = suggestRule({
        intent: 'run every night',
        trigger: 'cron',
        schedule: '0 23 * * *',
      });
      if (rule.when.source === 'cron') expect(rule.when.schedule).toBe('0 23 * * *');
    });

    it('applies days filter when provided', () => {
      const { rule } = suggestRule({
        intent: 'weekdays at 9am',
        trigger: 'cron',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      });
      if (rule.when.source === 'cron') {
        expect(rule.when.days).toEqual(['mon', 'tue', 'wed', 'thu', 'fri']);
      }
    });
  });

  describe('command inference', () => {
    it.each([
      ['turn off lights', 'turnOff'],
      ['turn on heater', 'turnOn'],
      ['press the button', 'press'],
      ['lock the door', 'lock'],
      ['unlock the deadbolt', 'unlock'],
      ['open the curtains', 'open'],
      ['close the blinds', 'close'],
      ['pause the device', 'pause'],
    ])('"%s" → command "%s"', (intent, expected) => {
      const { rule } = suggestRule({ intent });
      expect(rule.then[0].command).toContain(expected);
    });

    it('defaults to turnOn with warning for unrecognized command intent', () => {
      const { rule, warnings } = suggestRule({ intent: 'do a thing with device', trigger: 'mqtt', event: 'motion.detected' });
      expect(rule.then[0].command).toContain('turnOn');
      expect(warnings.some((w) => w.includes('turnOn'))).toBe(true);
    });
  });

  describe('defaults and structure', () => {
    it('always sets dry_run: true', () => {
      const { rule } = suggestRule({ intent: 'turn on light' });
      expect(rule.dry_run).toBe(true);
    });

    it('sets throttle for mqtt triggers', () => {
      const { rule } = suggestRule({ intent: 'motion detected', trigger: 'mqtt', event: 'motion.detected' });
      expect(rule.throttle?.max_per).toBe('10m');
    });

    it('does not set throttle for cron triggers', () => {
      const { rule } = suggestRule({ intent: 'every morning', trigger: 'cron' });
      expect(rule.throttle).toBeUndefined();
    });

    it('uses first device as sensor (mqtt) and remaining as action targets', () => {
      const { rule } = suggestRule({
        intent: 'motion turns on lamp',
        trigger: 'mqtt',
        event: 'motion.detected',
        devices: [
          { id: 'sensor-1', name: 'motion sensor' },
          { id: 'lamp-1', name: 'hallway lamp' },
        ],
      });
      if (rule.when.source === 'mqtt') expect(rule.when.device).toBe('motion sensor');
      expect(rule.then).toHaveLength(1);
      expect(rule.then[0].device).toBe('hallway lamp');
    });

    it('uses all devices as action targets for cron trigger', () => {
      const { rule } = suggestRule({
        intent: 'turn off at night',
        trigger: 'cron',
        devices: [{ id: 'l1', name: 'light 1' }, { id: 'l2', name: 'light 2' }],
      });
      expect(rule.then).toHaveLength(2);
    });

    it('ruleYaml is a valid YAML string containing key fields', () => {
      const { ruleYaml } = suggestRule({ intent: 'turn on light', trigger: 'cron', schedule: '0 8 * * *' });
      expect(typeof ruleYaml).toBe('string');
      expect(ruleYaml).toContain('dry_run: true');
      expect(ruleYaml).toContain('source: cron');
    });
  });
});
