import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { RulesEngine, lintRules, type EngineFireEntry } from '../../src/rules/engine.js';
import type { AutomationBlock, Rule } from '../../src/rules/types.js';
import { readAudit } from '../../src/utils/audit.js';
import type { SwitchBotMqttClient } from '../../src/mqtt/client.js';
import type { MqttCredential } from '../../src/mqtt/credential.js';

const fakeCredential: MqttCredential = {
  brokerUrl: 'ssl://broker.example.com:8883',
  region: 'us-east-1',
  clientId: 'test',
  topics: { status: 'test/topic' },
  qos: 1,
  tls: { enabled: true, caBase64: '', certBase64: '', keyBase64: '' },
};

class FakeMqttClient extends EventEmitter {
  private messageHandlers = new Set<(t: string, p: Buffer) => void>();
  private stateHandlers = new Set<(s: string) => void>();
  subscribed: string[] = [];

  subscribe(topic: string): void {
    this.subscribed.push(topic);
  }
  onMessage(h: (t: string, p: Buffer) => void): () => void {
    this.messageHandlers.add(h);
    return () => this.messageHandlers.delete(h);
  }
  onStateChange(h: (s: string) => void): () => void {
    this.stateHandlers.add(h);
    return () => this.stateHandlers.delete(h);
  }
  emitMessage(payload: unknown): void {
    const buf = Buffer.from(JSON.stringify(payload));
    for (const h of this.messageHandlers) h('test/topic', buf);
  }
}

function mqttRule(extra: Partial<Rule> = {}): Rule {
  return {
    name: 'hallway motion',
    when: { source: 'mqtt', event: 'motion.detected' },
    then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
    dry_run: true,
    ...extra,
  };
}

function automation(rules: Rule[], enabled = true): AutomationBlock {
  return { enabled, rules };
}

describe('lintRules', () => {
  it('accepts a minimal MQTT rule', () => {
    const r = lintRules(automation([mqttRule()]));
    expect(r.valid).toBe(true);
    expect(r.rules[0].status).toBe('ok');
  });

  it('warns (not errors) when a rule uses an unsupported trigger', () => {
    const r = lintRules(
      automation([
        { ...mqttRule({ name: 'webhook one' }), when: { source: 'webhook', path: '/motion' } },
      ]),
    );
    expect(r.valid).toBe(true);
    expect(r.rules[0].status).toBe('unsupported');
    expect(r.unsupportedCount).toBe(1);
  });

  it('accepts a valid cron rule as ok (cron is wired in E1)', () => {
    const r = lintRules(
      automation([
        { ...mqttRule({ name: 'nightly lights' }), when: { source: 'cron', schedule: '0 22 * * *' } },
      ]),
    );
    expect(r.valid).toBe(true);
    expect(r.rules[0].status).toBe('ok');
    expect(r.unsupportedCount).toBe(0);
  });

  it('rejects a cron rule with an unparseable schedule', () => {
    const r = lintRules(
      automation([
        { ...mqttRule({ name: 'bad cron' }), when: { source: 'cron', schedule: 'not a cron' } },
      ]),
    );
    expect(r.valid).toBe(false);
    expect(r.rules[0].issues.find((i) => i.code === 'invalid-cron')).toBeDefined();
  });

  it('flags destructive actions as errors', () => {
    const r = lintRules(
      automation([
        mqttRule({ then: [{ command: 'devices command LOCK-1 unlock' }] }),
      ]),
    );
    expect(r.valid).toBe(false);
    expect(r.rules[0].issues.find((i) => i.code === 'destructive-action')).toBeDefined();
  });

  it('rejects invalid throttle expressions', () => {
    const r = lintRules(
      automation([
        mqttRule({ throttle: { max_per: '1.5m' } }),
      ]),
    );
    expect(r.valid).toBe(false);
    expect(r.rules[0].issues.find((i) => i.code === 'invalid-throttle')).toBeDefined();
  });

  it('flags duplicate rule names', () => {
    const r = lintRules(
      automation([mqttRule(), mqttRule()]),
    );
    expect(r.valid).toBe(false);
    expect(r.rules[1].issues.find((i) => i.code === 'duplicate-name')).toBeDefined();
  });

  it('reports disabled rules with status=disabled (no issues)', () => {
    const r = lintRules(
      automation([mqttRule({ enabled: false })]),
    );
    expect(r.valid).toBe(true);
    expect(r.rules[0].status).toBe('disabled');
  });
});

describe('RulesEngine', () => {
  const originalArgv = process.argv;
  let tmp: string;
  let auditFile: string;
  let mqtt: FakeMqttClient;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbengine-'));
    auditFile = path.join(tmp, 'audit.log');
    process.argv = ['node', 'cli', '--audit-log', '--audit-log-path', auditFile];
    mqtt = new FakeMqttClient();
  });
  afterEach(() => {
    process.argv = originalArgv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses to start when automation.enabled !== true', async () => {
    const engine = new RulesEngine({
      automation: automation([mqttRule()], false),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
    });
    await expect(engine.start()).rejects.toThrow(/automation.enabled/);
  });

  it('refuses to start when any rule has a destructive action', async () => {
    const engine = new RulesEngine({
      automation: automation([
        mqttRule({ then: [{ command: 'devices command LOCK-1 unlock' }] }),
      ]),
      aliases: {},
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
    });
    await expect(engine.start()).rejects.toThrow(/destructive-action/);
  });

  it('dry-fires a rule end-to-end and writes rule-fire-dry audit', async () => {
    const fires: EngineFireEntry[] = [];
    const engine = new RulesEngine({
      automation: automation([mqttRule()]),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      onFire: (e) => fires.push(e),
    });
    await engine.start();
    expect(mqtt.subscribed).toContain('test/topic');

    mqtt.emitMessage({
      context: { deviceMac: 'EVENT-DEV', deviceType: 'Motion Sensor', detectionState: 'DETECTED' },
    });
    await engine.drainForTest();

    const stats = engine.getStats();
    expect(stats.eventsProcessed).toBe(1);
    expect(stats.dryFires).toBe(1);
    expect(fires[0].status).toBe('dry');
    const audit = readAudit(auditFile);
    expect(audit).toHaveLength(1);
    expect(audit[0].kind).toBe('rule-fire-dry');
    expect(audit[0].deviceId).toBe('AA-BB-CC');
  });

  it('filters by trigger.device (alias-resolved) so only matching deviceIds fire', async () => {
    const fires: EngineFireEntry[] = [];
    const engine = new RulesEngine({
      automation: automation([
        mqttRule({
          name: 'front door only',
          when: { source: 'mqtt', event: 'contact.opened', device: 'front door' },
        }),
      ]),
      aliases: { 'front door': 'FRONT-DOOR-ID', 'hallway lamp': 'LAMP-ID' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      onFire: (e) => fires.push(e),
    });
    await engine.start();

    mqtt.emitMessage({ context: { deviceMac: 'SOME-OTHER-DEV', openState: 'OPEN' } });
    mqtt.emitMessage({ context: { deviceMac: 'FRONT-DOOR-ID', openState: 'OPEN' } });
    await engine.drainForTest();

    expect(fires).toHaveLength(1);
    expect(fires[0].deviceId).toBe('FRONT-DOOR-ID');
  });

  it('time_between condition blocks events outside the window', async () => {
    vi.useFakeTimers();
    // Local-time constructor (year, monthIdx, day, hour, min) so the result is
    // always "12:00 local" regardless of the runner's timezone — the matcher
    // reads local hours, not UTC.
    vi.setSystemTime(new Date(2026, 3, 22, 12, 0, 0));
    try {
      const fires: EngineFireEntry[] = [];
      const engine = new RulesEngine({
        automation: automation([
          mqttRule({ conditions: [{ time_between: ['22:00', '07:00'] }] }),
        ]),
        aliases: { 'hallway lamp': 'AA-BB-CC' },
        mqttClient: mqtt as unknown as SwitchBotMqttClient,
        mqttCredential: fakeCredential,
        skipApiCall: true,
        onFire: (e) => fires.push(e),
      });
      await engine.start();
      mqtt.emitMessage({ context: { deviceMac: 'X', detectionState: 'DETECTED' } });
      await engine.drainForTest();
      expect(fires.map((f) => f.status)).toEqual(['conditions-failed']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throttle suppresses the second fire inside the window', async () => {
    const fires: EngineFireEntry[] = [];
    const engine = new RulesEngine({
      automation: automation([
        mqttRule({ throttle: { max_per: '1h' } }),
      ]),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      onFire: (e) => fires.push(e),
    });
    await engine.start();

    mqtt.emitMessage({ context: { deviceMac: 'X', detectionState: 'DETECTED' } });
    mqtt.emitMessage({ context: { deviceMac: 'X', detectionState: 'DETECTED' } });
    await engine.drainForTest();

    expect(fires.map((f) => f.status)).toEqual(['dry', 'throttled']);
    const stats = engine.getStats();
    expect(stats.throttled).toBe(1);
    const audit = readAudit(auditFile);
    expect(audit.find((a) => a.kind === 'rule-throttled')).toBeDefined();
  });

  it('stop() removes subscribers so later messages do nothing', async () => {
    const fires: EngineFireEntry[] = [];
    const engine = new RulesEngine({
      automation: automation([mqttRule()]),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      onFire: (e) => fires.push(e),
    });
    await engine.start();
    await engine.stop();
    mqtt.emitMessage({ context: { deviceMac: 'X', detectionState: 'DETECTED' } });
    await engine.drainForTest();
    expect(fires).toEqual([]);
    expect(engine.getStats().eventsProcessed).toBe(0);
  });

  it('cron-triggered rule fires via ingestCronForTest and writes rule-fire-dry audit', async () => {
    const fires: EngineFireEntry[] = [];
    const rule: Rule = {
      name: 'nightly lights off',
      when: { source: 'cron', schedule: '0 22 * * *' },
      then: [{ command: 'devices command <id> turnOff', device: 'hallway lamp' }],
      dry_run: true,
    };
    const engine = new RulesEngine({
      automation: automation([rule]),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      onFire: (e) => fires.push(e),
    });
    await engine.start();
    // Cron rules don't need MQTT subscription.
    await engine.ingestCronForTest(rule, new Date(2026, 3, 22, 22, 0, 0));
    await engine.drainForTest();
    await engine.stop();

    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe('dry');
    expect(engine.getStats().dryFires).toBe(1);
    const audit = readAudit(auditFile);
    expect(audit).toHaveLength(1);
    expect(audit[0].kind).toBe('rule-fire-dry');
    expect((audit[0] as { rule?: { triggerSource?: string } }).rule?.triggerSource).toBe('cron');
  });

  it('getCronSchedule exposes the next planned run for a cron rule', async () => {
    const rule: Rule = {
      name: 'hourly',
      when: { source: 'cron', schedule: '0 * * * *' },
      then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
      dry_run: true,
    };
    const engine = new RulesEngine({
      automation: automation([rule]),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
    });
    await engine.start();
    const info = engine.getCronSchedule('hourly');
    expect(info).not.toBeNull();
    expect(info!.schedule).toBe('0 * * * *');
    expect(info!.nextAt).toBeInstanceOf(Date);
    await engine.stop();
  });

  it('cron throttle suppresses a rapid second fire', async () => {
    const fires: EngineFireEntry[] = [];
    const rule: Rule = {
      name: 'rapid cron',
      when: { source: 'cron', schedule: '* * * * *' },
      then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
      dry_run: true,
      throttle: { max_per: '1h' },
    };
    const engine = new RulesEngine({
      automation: automation([rule]),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      onFire: (e) => fires.push(e),
    });
    await engine.start();
    const base = new Date(2026, 3, 22, 10, 0, 0);
    await engine.ingestCronForTest(rule, base);
    await engine.ingestCronForTest(rule, new Date(base.getTime() + 60_000)); // +1 minute
    await engine.drainForTest();
    await engine.stop();
    expect(fires.map((f) => f.status)).toEqual(['dry', 'throttled']);
  });

  it('cron rule with invalid schedule causes engine.start() to throw', async () => {
    const rule: Rule = {
      name: 'broken',
      when: { source: 'cron', schedule: 'not a cron' },
      then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
      dry_run: true,
    };
    const engine = new RulesEngine({
      automation: automation([rule]),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
    });
    await expect(engine.start()).rejects.toThrow(/invalid-cron/);
  });
});
