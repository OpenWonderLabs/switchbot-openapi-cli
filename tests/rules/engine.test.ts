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

  it('warns (not errors) when a rule uses an unsupported trigger source', () => {
    const r = lintRules(
      automation([
        // Cast through unknown to construct an unrecognised trigger source
        // shape without TS whining; lint should still warn cleanly.
        { ...mqttRule({ name: 'alien' }), when: { source: 'martian' as unknown as 'mqtt', event: 'landing' } } as Rule,
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

  it('webhook trigger rule dry-fires via ingestWebhookForTest', async () => {
    const fires: EngineFireEntry[] = [];
    const rule: Rule = {
      name: 'doorbell',
      when: { source: 'webhook', path: '/doorbell' },
      then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
      dry_run: true,
    };
    const engine = new RulesEngine({
      automation: automation([rule]),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      webhookToken: 'unit-test-token',
      webhookPort: 0, // avoid port clash in test runs
      onFire: (e) => fires.push(e),
    });
    await engine.start();
    expect(engine.getWebhookPort()).toBeGreaterThan(0);
    await engine.ingestWebhookForTest(rule, '{"hi":true}');
    await engine.drainForTest();
    await engine.stop();

    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe('dry');
    const audit = readAudit(auditFile);
    expect(audit[0].kind).toBe('rule-fire-dry');
    expect((audit[0] as { rule?: { triggerSource?: string } }).rule?.triggerSource).toBe('webhook');
  });

  it('webhook rule without a bearer token refuses to start', async () => {
    const rule: Rule = {
      name: 'doorbell',
      when: { source: 'webhook', path: '/doorbell' },
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
    await expect(engine.start()).rejects.toThrow(/webhookToken/);
  });

  it('device_state condition fires when live status matches expected value', async () => {
    const fires: EngineFireEntry[] = [];
    const fetchStatus = vi.fn(async () => ({ power: 'on', battery: 87 }));
    const engine = new RulesEngine({
      automation: automation([
        mqttRule({
          conditions: [{ device: 'hallway lamp', field: 'power', op: '==', value: 'on' }],
        }),
      ]),
      aliases: { 'hallway lamp': 'LAMP-ID' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      statusFetcher: fetchStatus,
      onFire: (e) => fires.push(e),
    });
    await engine.start();
    mqtt.emitMessage({ context: { deviceMac: 'EVENT-DEV', detectionState: 'DETECTED' } });
    await engine.drainForTest();

    expect(fires.map((f) => f.status)).toEqual(['dry']);
    expect(fetchStatus).toHaveBeenCalledWith('LAMP-ID');
  });

  it('device_state condition blocks the fire when live status mismatches', async () => {
    const fires: EngineFireEntry[] = [];
    const engine = new RulesEngine({
      automation: automation([
        mqttRule({
          conditions: [{ device: 'LAMP-ID', field: 'power', op: '==', value: 'on' }],
        }),
      ]),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      statusFetcher: async () => ({ power: 'off' }),
      onFire: (e) => fires.push(e),
    });
    await engine.start();
    mqtt.emitMessage({ context: { deviceMac: 'EVENT-DEV', detectionState: 'DETECTED' } });
    await engine.drainForTest();

    expect(fires.map((f) => f.status)).toEqual(['conditions-failed']);
    expect(fires[0].reason).toMatch(/device_state LAMP-ID\.power/);
  });

  it('per-tick cache dedupes multiple device_state lookups on the same device', async () => {
    const fetchStatus = vi.fn(async () => ({ power: 'on', battery: 87 }));
    const engine = new RulesEngine({
      automation: automation([
        mqttRule({
          conditions: [
            { device: 'hallway lamp', field: 'power', op: '==', value: 'on' },
            { device: 'hallway lamp', field: 'battery', op: '>=', value: 20 },
          ],
        }),
      ]),
      aliases: { 'hallway lamp': 'LAMP-ID' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      statusFetcher: fetchStatus,
    });
    await engine.start();
    mqtt.emitMessage({ context: { deviceMac: 'EVENT-DEV', detectionState: 'DETECTED' } });
    await engine.drainForTest();

    expect(fetchStatus).toHaveBeenCalledTimes(1);
  });

  it('per-tick cache does not leak across separate pipeline runs', async () => {
    const fetchStatus = vi.fn(async () => ({ power: 'on' }));
    const engine = new RulesEngine({
      automation: automation([
        mqttRule({
          conditions: [{ device: 'hallway lamp', field: 'power', op: '==', value: 'on' }],
        }),
      ]),
      aliases: { 'hallway lamp': 'LAMP-ID' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      statusFetcher: fetchStatus,
    });
    await engine.start();
    mqtt.emitMessage({ context: { deviceMac: 'EVENT-DEV', detectionState: 'DETECTED' } });
    mqtt.emitMessage({ context: { deviceMac: 'EVENT-DEV', detectionState: 'DETECTED' } });
    await engine.drainForTest();

    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it('device_state fetch failure surfaces as conditions-failed with the error message', async () => {
    const fires: EngineFireEntry[] = [];
    const engine = new RulesEngine({
      automation: automation([
        mqttRule({
          conditions: [{ device: 'LAMP-ID', field: 'power', op: '==', value: 'on' }],
        }),
      ]),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      statusFetcher: async () => {
        throw new Error('network down');
      },
      onFire: (e) => fires.push(e),
    });
    await engine.start();
    mqtt.emitMessage({ context: { deviceMac: 'EVENT-DEV', detectionState: 'DETECTED' } });
    await engine.drainForTest();

    expect(fires.map((f) => f.status)).toEqual(['conditions-failed']);
    expect(fires[0].reason).toContain('network down');
  });
});

describe('RulesEngine.reload', () => {
  let mqtt: FakeMqttClient;

  beforeEach(() => {
    mqtt = new FakeMqttClient();
  });

  it('refuses to reload when automation.enabled is false', async () => {
    const engine = new RulesEngine({
      automation: automation([mqttRule()]),
      aliases: {},
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
    });
    await engine.start();

    const result = await engine.reload(automation([mqttRule()], false), {});
    expect(result.changed).toBe(false);
    expect(result.errors.join(' ')).toMatch(/enabled is not true/);
    expect(engine.getStats().rulesActive).toBe(1);
  });

  it('refuses to reload when the new policy fails lint (destructive action)', async () => {
    const engine = new RulesEngine({
      automation: automation([mqttRule()]),
      aliases: {},
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
    });
    await engine.start();

    const bad = automation([
      mqttRule({ then: [{ command: 'devices command LOCK-1 unlock' }] }),
    ]);
    const result = await engine.reload(bad, {});
    expect(result.changed).toBe(false);
    expect(result.errors.some((e) => e.includes('destructive-action'))).toBe(true);
    // Old ruleset still live.
    expect(engine.getStats().rulesActive).toBe(1);
  });

  it('swaps rules atomically by name and updates rulesActive count', async () => {
    const engine = new RulesEngine({
      automation: automation([mqttRule({ name: 'old-one' })]),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
    });
    await engine.start();
    expect(engine.getStats().rulesActive).toBe(1);

    const result = await engine.reload(
      automation([
        mqttRule({ name: 'new-a' }),
        mqttRule({ name: 'new-b' }),
      ]),
      { 'hallway lamp': 'AA-BB-CC' },
    );
    expect(result.changed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(engine.getStats().rulesActive).toBe(2);
  });

  it('preserves throttle state for rules whose name survives the reload', async () => {
    const rule = mqttRule({
      name: 'once-per-hour',
      throttle: { max_per: '1h' },
    });
    const fires: EngineFireEntry[] = [];
    const engine = new RulesEngine({
      automation: automation([rule]),
      aliases: { 'hallway lamp': 'AA-BB-CC' },
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      onFire: (e) => fires.push(e),
    });
    await engine.start();

    mqtt.emitMessage({ context: { deviceMac: 'AA-BB-CC', detectionState: 'DETECTED' } });
    await engine.drainForTest();
    expect(fires.map((f) => f.status)).toEqual(['dry']);

    // Reload with the same rule name — throttle window should still block.
    const result = await engine.reload(automation([rule]), {
      'hallway lamp': 'AA-BB-CC',
    });
    expect(result.changed).toBe(true);

    mqtt.emitMessage({ context: { deviceMac: 'AA-BB-CC', detectionState: 'DETECTED' } });
    await engine.drainForTest();
    expect(fires.map((f) => f.status)).toEqual(['dry', 'throttled']);
  });

  it('warns when webhook rules are added via reload on an engine that never started a listener', async () => {
    const engine = new RulesEngine({
      automation: automation([mqttRule()]),
      aliases: {},
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
    });
    await engine.start();

    const withWebhook = automation([
      mqttRule({ name: 'keep-mqtt' }),
      {
        name: 'new-webhook',
        when: { source: 'webhook', path: '/ring' },
        then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
        dry_run: true,
      },
    ]);
    const result = await engine.reload(withWebhook, {});
    expect(result.changed).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/webhook rules added via reload/);
  });

  it('refuses to reload before start', async () => {
    const engine = new RulesEngine({
      automation: automation([mqttRule()]),
      aliases: {},
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
    });
    const result = await engine.reload(automation([mqttRule()]), {});
    expect(result.changed).toBe(false);
    expect(result.errors.join(' ')).toMatch(/engine not running/);
  });

  // ── hysteresis ─────────────────────────────────────────────────────────
  describe('hysteresis / requires_stable_for', () => {
    it('suppresses the first observation, fires after the window has elapsed', async () => {
      const fires: EngineFireEntry[] = [];
      const rule: Rule = {
        name: 'stable-motion',
        when: { source: 'mqtt', event: 'motion.detected' },
        then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
        dry_run: true,
        hysteresis: '5s',
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

      // first observation — should be throttled (first-seen)
      const t0 = new Date(2026, 3, 22, 10, 0, 0);
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: t0, deviceId: 'SENSOR1' });
      await engine.drainForTest();
      expect(fires.map((f) => f.status)).toContain('throttled');
      expect(fires.at(-1)?.reason).toMatch(/hysteresis/);
      fires.length = 0;

      // second observation within window (3s later) — still throttled
      const t1 = new Date(t0.getTime() + 3_000);
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: t1, deviceId: 'SENSOR1' });
      await engine.drainForTest();
      expect(fires.map((f) => f.status)).toContain('throttled');
      fires.length = 0;

      // third observation after window (6s after start) — should fire
      const t2 = new Date(t0.getTime() + 6_000);
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: t2, deviceId: 'SENSOR1' });
      await engine.drainForTest();
      expect(fires.map((f) => f.status)).toContain('dry');

      await engine.stop();
    });

    it('resets the hysteresis clock when conditions become unmatched', async () => {
      const fires: EngineFireEntry[] = [];
      const rule: Rule = {
        name: 'stable-with-cond',
        when: { source: 'mqtt', event: 'motion.detected' },
        conditions: [{ device: 'hallway lamp', field: 'power', op: '==', value: 'on' }],
        then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
        dry_run: true,
        hysteresis: '5s',
      };

      // Flip the condition on/off via a mutable holder.
      let lampOn = true;
      const engine = new RulesEngine({
        automation: automation([rule]),
        aliases: { 'hallway lamp': 'AA-BB-CC' },
        mqttClient: mqtt as unknown as SwitchBotMqttClient,
        mqttCredential: fakeCredential,
        skipApiCall: true,
        statusFetcher: async () => ({ power: lampOn ? 'on' : 'off' }),
        onFire: (e) => fires.push(e),
      });
      await engine.start();

      const base = new Date(2026, 3, 22, 10, 0, 0);

      // t=0: conditions pass — hysteresis starts
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: base, deviceId: 'SENSOR1' });
      await engine.drainForTest();
      expect(fires.at(-1)?.status).toBe('throttled');
      fires.length = 0;

      // t=3s: conditions fail (lamp turns off) — clock must reset
      lampOn = false;
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: new Date(base.getTime() + 3_000), deviceId: 'SENSOR1' });
      await engine.drainForTest();
      expect(fires.at(-1)?.status).toBe('conditions-failed');
      fires.length = 0;

      // t=8s: conditions pass again — clock starts fresh from t=8s
      lampOn = true;
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: new Date(base.getTime() + 8_000), deviceId: 'SENSOR1' });
      await engine.drainForTest();
      // 8s > 5s from start but only 0s from reset — should be throttled again (first-seen)
      expect(fires.at(-1)?.status).toBe('throttled');
      fires.length = 0;

      // t=14s: 6s after the second start — now stable long enough
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: new Date(base.getTime() + 14_000), deviceId: 'SENSOR1' });
      await engine.drainForTest();
      expect(fires.at(-1)?.status).toBe('dry');

      await engine.stop();
    });
  });

  // ── maxFiringsPerHour ───────────────────────────────────────────────────
  describe('maxFiringsPerHour', () => {
    it('allows fires up to the cap and throttles once the cap is reached', async () => {
      const fires: EngineFireEntry[] = [];
      const rule: Rule = {
        name: 'capped-rule',
        when: { source: 'mqtt', event: 'motion.detected' },
        then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
        dry_run: true,
        maxFiringsPerHour: 2,
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

      // First fire: allowed
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: base, deviceId: 'S1' });
      await engine.drainForTest();
      expect(fires.at(-1)?.status).toBe('dry');
      fires.length = 0;

      // Second fire (5 min later): still allowed
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: new Date(base.getTime() + 5 * 60_000), deviceId: 'S1' });
      await engine.drainForTest();
      expect(fires.at(-1)?.status).toBe('dry');
      fires.length = 0;

      // Third fire (10 min later): throttled — cap reached
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: new Date(base.getTime() + 10 * 60_000), deviceId: 'S1' });
      await engine.drainForTest();
      expect(fires.at(-1)?.status).toBe('throttled');
      expect(fires.at(-1)?.reason).toMatch(/maxFiringsPerHour/);

      await engine.stop();
    });

    it('resets the count after the 1-hour window slides', async () => {
      const fires: EngineFireEntry[] = [];
      const rule: Rule = {
        name: 'hourly-reset',
        when: { source: 'mqtt', event: 'motion.detected' },
        then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
        dry_run: true,
        maxFiringsPerHour: 1,
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

      // Fire once — consumes the cap
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: base, deviceId: 'S1' });
      await engine.drainForTest();
      expect(fires.at(-1)?.status).toBe('dry');
      fires.length = 0;

      // 30 min later — cap still consumed
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: new Date(base.getTime() + 30 * 60_000), deviceId: 'S1' });
      await engine.drainForTest();
      expect(fires.at(-1)?.status).toBe('throttled');
      fires.length = 0;

      // 61 min later — window has slid past; first fire dropped out of count
      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: new Date(base.getTime() + 61 * 60_000), deviceId: 'S1' });
      await engine.drainForTest();
      expect(fires.at(-1)?.status).toBe('dry');

      await engine.stop();
    });
  });

  // ── suppressIfAlreadyDesired ────────────────────────────────────────────
  describe('suppressIfAlreadyDesired', () => {
    it('suppresses turnOn when device is already on', async () => {
      const fires: EngineFireEntry[] = [];
      const rule: Rule = {
        name: 'auto-on',
        when: { source: 'mqtt', event: 'motion.detected' },
        then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
        dry_run: true,
        suppressIfAlreadyDesired: true,
      };
      const engine = new RulesEngine({
        automation: automation([rule]),
        aliases: { 'hallway lamp': 'LAMP-ID' },
        mqttClient: mqtt as unknown as SwitchBotMqttClient,
        mqttCredential: fakeCredential,
        skipApiCall: true,
        statusFetcher: async () => ({ powerState: 'on' }),
        onFire: (e) => fires.push(e),
      });
      await engine.start();

      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: new Date(), deviceId: 'S1' });
      await engine.drainForTest();

      expect(fires.at(-1)?.status).toBe('throttled');
      expect(fires.at(-1)?.reason).toMatch(/already-desired/);

      await engine.stop();
    });

    it('allows turnOn when device is currently off', async () => {
      const fires: EngineFireEntry[] = [];
      const rule: Rule = {
        name: 'auto-on',
        when: { source: 'mqtt', event: 'motion.detected' },
        then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
        dry_run: true,
        suppressIfAlreadyDesired: true,
      };
      const engine = new RulesEngine({
        automation: automation([rule]),
        aliases: { 'hallway lamp': 'LAMP-ID' },
        mqttClient: mqtt as unknown as SwitchBotMqttClient,
        mqttCredential: fakeCredential,
        skipApiCall: true,
        statusFetcher: async () => ({ powerState: 'off' }),
        onFire: (e) => fires.push(e),
      });
      await engine.start();

      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: new Date(), deviceId: 'S1' });
      await engine.drainForTest();

      expect(fires.at(-1)?.status).toBe('dry');

      await engine.stop();
    });

    it('proceeds (best-effort) when statusFetcher rejects', async () => {
      const fires: EngineFireEntry[] = [];
      const rule: Rule = {
        name: 'auto-on',
        when: { source: 'mqtt', event: 'motion.detected' },
        then: [{ command: 'devices command <id> turnOn', device: 'hallway lamp' }],
        dry_run: true,
        suppressIfAlreadyDesired: true,
      };
      const engine = new RulesEngine({
        automation: automation([rule]),
        aliases: { 'hallway lamp': 'LAMP-ID' },
        mqttClient: mqtt as unknown as SwitchBotMqttClient,
        mqttCredential: fakeCredential,
        skipApiCall: true,
        statusFetcher: async () => { throw new Error('network error'); },
        onFire: (e) => fires.push(e),
      });
      await engine.start();

      await engine.ingestEventForTest({ source: 'mqtt', event: 'motion.detected', t: new Date(), deviceId: 'S1' });
      await engine.drainForTest();

      // Status fetch failed — best-effort, so the rule should still fire
      expect(fires.at(-1)?.status).toBe('dry');

      await engine.stop();
    });
  });
});

// ─── M3: notify action support ───────────────────────────────────────────────

describe('lintRules — notify actions', () => {
  it('accepts a rule with a valid file notify action', () => {
    const r = lintRules(automation([
      { name: 'n1', when: { source: 'mqtt', event: 'motion.detected' }, then: [{ type: 'notify', channel: 'file', to: '/tmp/out.jsonl' }] },
    ]));
    expect(r.valid).toBe(true);
    expect(r.rules[0].status).toBe('ok');
  });

  it('accepts a rule with a valid webhook notify action', () => {
    const r = lintRules(automation([
      { name: 'n2', when: { source: 'mqtt', event: 'motion.detected' }, then: [{ type: 'notify', channel: 'webhook', to: 'https://example.com/hook' }] },
    ]));
    expect(r.valid).toBe(true);
  });

  it('errors on notify action missing to field (code: notify-missing-to)', () => {
    const r = lintRules(automation([
      { name: 'n3', when: { source: 'mqtt', event: 'motion.detected' }, then: [{ type: 'notify', channel: 'webhook' } as unknown as import('../../src/rules/types.js').Action] },
    ]));
    expect(r.valid).toBe(false);
    expect(r.rules[0].issues.find(i => i.code === 'notify-missing-to')).toBeDefined();
  });

  it('errors on notify webhook action with invalid URL (code: notify-invalid-url)', () => {
    const r = lintRules(automation([
      { name: 'n4', when: { source: 'mqtt', event: 'motion.detected' }, then: [{ type: 'notify', channel: 'webhook', to: 'not-a-url' }] },
    ]));
    expect(r.valid).toBe(false);
    expect(r.rules[0].issues.find(i => i.code === 'notify-invalid-url')).toBeDefined();
  });

  it('errors on notify webhook action with non-http(s) URL (code: notify-unsupported-protocol)', () => {
    const r = lintRules(automation([
      { name: 'n5', when: { source: 'mqtt', event: 'motion.detected' }, then: [{ type: 'notify', channel: 'webhook', to: 'ftp://example.com/path' }] },
    ]));
    expect(r.valid).toBe(false);
    const issue = r.rules[0].issues.find(i => i.code === 'notify-unsupported-protocol');
    expect(issue).toBeDefined();
    expect(issue?.message).toContain('ftp:');
  });

  it('accepts an http:// notify webhook URL', () => {
    const r = lintRules(automation([
      { name: 'n6', when: { source: 'mqtt', event: 'motion.detected' }, then: [{ type: 'notify', channel: 'webhook', to: 'http://example.com/hook' }] },
    ]));
    expect(r.valid).toBe(true);
  });
});

describe('RulesEngine — notify action dispatch', () => {
  const originalArgv = process.argv;
  let tmp: string;
  let auditFile: string;
  let mqtt: FakeMqttClient;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbengine-notify-'));
    auditFile = path.join(tmp, 'audit.log');
    process.argv = ['node', 'cli', '--audit-log', '--audit-log-path', auditFile];
    mqtt = new FakeMqttClient();
  });
  afterEach(() => {
    process.argv = originalArgv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('dispatches a file notify action and writes JSONL to target', async () => {
    const targetFile = path.join(tmp, 'events.jsonl');
    const fires: EngineFireEntry[] = [];
    const engine = new RulesEngine({
      automation: automation([{
        name: 'notify-file-rule',
        when: { source: 'mqtt', event: 'motion.detected' },
        then: [{ type: 'notify', channel: 'file', to: targetFile }],
      }]),
      aliases: {},
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
      onFire: (e) => fires.push(e),
    });
    await engine.start();

    mqtt.emitMessage({ context: { deviceMac: 'AABBCCDDEEFF', detectionState: 'DETECTED' } });
    await engine.drainForTest();

    expect(fires.at(-1)?.status).toBe('fired');
    expect(fs.existsSync(targetFile)).toBe(true);
    const line = JSON.parse(fs.readFileSync(targetFile, 'utf-8').trim());
    expect(line.rule).toBe('notify-file-rule');

    await engine.stop();
  });

  it('writes rule-notify audit entry when notify action fires', async () => {
    const targetFile = path.join(tmp, 'events.jsonl');
    const engine = new RulesEngine({
      automation: automation([{
        name: 'notify-audit-rule',
        when: { source: 'mqtt', event: 'motion.detected' },
        then: [{ type: 'notify', channel: 'file', to: targetFile }],
      }]),
      aliases: {},
      mqttClient: mqtt as unknown as SwitchBotMqttClient,
      mqttCredential: fakeCredential,
      skipApiCall: true,
    });
    await engine.start();

    mqtt.emitMessage({ context: { deviceMac: 'AABBCCDDEEFF', detectionState: 'DETECTED' } });
    await engine.drainForTest();

    const entries = readAudit(auditFile);
    expect(entries.find(e => e.kind === 'rule-notify')).toBeDefined();

    await engine.stop();
  });
});
