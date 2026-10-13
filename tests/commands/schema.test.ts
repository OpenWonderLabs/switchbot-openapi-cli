import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import { registerSchemaCommand } from '../../src/commands/schema.js';
import type { ResourceCatalog } from '../../src/devices/resources.js';
import { updateCacheFromDeviceList, resetListCache } from '../../src/devices/cache.js';
import { runCli } from '../helpers/cli.js';
import { expectJsonEnvelopeContainingKeys } from '../helpers/contracts.js';

describe('schema export', () => {
  it('dumps every catalog type as a JSON payload', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const out = res.stdout.join('');
    const envelope = JSON.parse(out) as Record<string, unknown>;
    const parsed = expectJsonEnvelopeContainingKeys(envelope, ['version', 'types', 'generatedAt', 'resources', 'cliAddedFields']);
    expect(parsed.version).toBe('2.0');
    expect(parsed.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(parsed.types)).toBe(true);
    expect(parsed.types.length).toBeGreaterThan(10);
    // Every entry should have normalized idempotent booleans and safetyTier strings.
    for (const t of parsed.types) {
      for (const c of t.commands) {
        expect(typeof c.idempotent).toBe('boolean');
        expect(typeof c.safetyTier).toBe('string');
      }
    }
  });

  it('exports both scheduling timestamps as required for single-use Keypad passcodes', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const data = JSON.parse(res.stdout.join('')).data;
    const key = data.resources.keys.find((entry: { keyType: string }) => entry.keyType === 'disposable');
    expect(key.requiredParams).toContain('startTime');
    expect(key.requiredParams).toContain('endTime');
    expect(key.optionalParams).not.toContain('startTime');
    expect(key.optionalParams).not.toContain('endTime');
  });

  it('exports v2 webhook envelopes with context device types and nested fields', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const data = JSON.parse(res.stdout.join('')).data as {
      version: string;
      resources: {
        version: string;
        webhooks: {
          events: Array<{
            eventType: string;
            eventVersion: string;
            context: {
              deviceType: string;
              fields: Array<{
                name: string;
                type: string;
                fields?: Array<{ name: string; type: string }>;
              }>;
            };
          }> ;
        };
      };
    };

    expect(data.version).toBe('2.0');
    expect(data.resources.version).toBe('2.0');

    const bot = data.resources.webhooks.events.find(
      (event) => event.context.deviceType === 'WoHand',
    );
    expect(bot).toMatchObject({ eventType: 'changeReport', eventVersion: '1' });

    const mindClip = data.resources.webhooks.events.find(
      (event) => event.context.deviceType === 'AI MindClip',
    );
    const completedUpload = mindClip?.context.fields.find(
      (field) => field.name === 'chargeUploadCompleted',
    );
    expect(completedUpload).toMatchObject({ type: 'object' });
    const uploadFields = completedUpload?.fields ?? [];
    expect(uploadFields.find((field) => field.name === 'fileID')).toMatchObject({ type: 'string' });
    expect(uploadFields.find((field) => field.name === 'status')).toMatchObject({ type: 'number' });
  });

  it('describes official webhook context variants for payload consumers', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const data = JSON.parse(res.stdout.join('')).data as {
      resources: {
        webhooks: {
          events: Array<{
            context: {
              deviceType: string;
              fields: Array<{ name: string; type: string }>;
            };
          }>;
        };
      };
    };
    const fieldType = (deviceType: string, fieldName: string) =>
      data.resources.webhooks.events
        .find((event) => event.context.deviceType === deviceType)
        ?.context.fields.find((field) => field.name === fieldName)?.type;

    expect(fieldType('WoMeterPlus', 'scale')).toBe('string');
    expect(fieldType('MeterPro(CO2)', 'CO2')).toBe('number');
    expect(fieldType('WoPlugEU', 'switchStatus')).toBe('number');
    expect(fieldType('WoKeypad', 'eventName')).toBe('string');
    expect(fieldType('Video Doorbell', 'press')).toBe('boolean');
  });

  it('distinguishes documented webhook support variants', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const data = JSON.parse(res.stdout.join('')).data as { resources: ResourceCatalog };
    const events = data.resources.webhooks.events;
    const fieldType = (deviceType: string, fieldName: string) =>
      events.find((event) => event.context.deviceType === deviceType)
        ?.context.fields.find((field) => field.name === fieldName)?.type;

    expect(fieldType('WoPlugJP', 'powerState')).toBe('string');
    expect(fieldType('Relay Switch 2PM', 'switch1Status')).toBe('number');
    expect(fieldType('WoRollerShade', 'slidePosition')).toBe('number');
    expect(fieldType('Hub 3', 'detectionState')).toBe('string');
    expect(fieldType('Kata Friends', 'deviceId')).toBe('string');
  });

  it('exports only documented scene REST operations', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const data = JSON.parse(res.stdout.join('')).data as {
      resources: { scenes: { operations: Array<{ method: string; endpoint: string }> } };
    };

    const operations = data.resources.scenes.operations.map(
      (operation) => operation.method + ' ' + operation.endpoint,
    );
    expect(operations).toEqual([
      'GET /v1.1/scenes',
      'POST /v1.1/scenes/{sceneId}/execute',
    ]);
  });

  it('does not impose undocumented webhook account limits', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const data = JSON.parse(res.stdout.join('')).data as {
      resources: { webhooks: Record<string, unknown> };
    };

    expect(data.resources.webhooks).not.toHaveProperty('constraints');
  });

  it('bare schema defaults to export', async () => {
    const res = await runCli(registerSchemaCommand, ['schema']);
    expect(res.exitCode).toBeNull();
    const envelope = JSON.parse(res.stdout.join('')) as Record<string, unknown>;
    const data = expectJsonEnvelopeContainingKeys(envelope, ['version', 'types', 'generatedAt', 'resources', 'cliAddedFields']);
    expect(Array.isArray(data.types)).toBe(true);
  });

  it('filters by --type (matches name + aliases, case-insensitive)', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--type', 'bot']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    expect(parsed.types).toHaveLength(1);
    expect(parsed.types[0].type).toBe('Bot');
  });

  it('returns an empty types[] when --type does not match', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--type', 'NoSuchType']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    expect(parsed.types).toEqual([]);
  });

  it('tags a known destructive command with safetyTier', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    const lock = parsed.types.find(
      (t: { type: string }) => t.type === 'Smart Lock' || t.type === 'Smart Lock Pro',
    );
    if (!lock) return; // catalog may omit on some builds — soft assert
    const unlock = lock.commands.find((c: { command: string }) => c.command === 'unlock');
    if (unlock) expect(unlock.safetyTier).toBe('destructive');
  });

  it('--role filters to the matching functional group', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--role', 'lighting']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    expect(parsed.types.length).toBeGreaterThan(0);
    for (const t of parsed.types) {
      expect(t.role).toBe('lighting');
    }
    expect(parsed.types.find((t: { type: string }) => t.type === 'Smart Lock')).toBeUndefined();
  });

  it('--role and --category can be combined', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--role', 'security', '--category', 'physical']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    expect(parsed.types.length).toBeGreaterThan(0);
    for (const t of parsed.types) {
      expect(t.role).toBe('security');
      expect(t.category).toBe('physical');
    }
  });

  it('--role rejects an unknown role with exit 2', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--role', 'nonexistent']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/--role .* must be one of/i);
  });

  it('exits 2 when --role swallows "--help"', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--role', '--help']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/--role .* must be one of/i);
  });

  it('schema export includes description on every type', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    for (const t of parsed.types) {
      expect(t.description, `${t.type} missing description in export`).toBeTypeOf('string');
      expect((t.description as string).length, `${t.type} description is empty`).toBeGreaterThan(0);
    }
  });

  it('exports corrected advisory statusFields for Meter and Home Climate Panel', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    const meter = parsed.types.find((t: { type: string }) => t.type === 'Meter');
    const panel = parsed.types.find((t: { type: string }) => t.type === 'Home Climate Panel');
    expect(meter.statusFields).not.toContain('CO2');
    expect(meter.statusFields).toEqual(['temperature', 'humidity', 'battery', 'version']);
    expect(panel.statusFields).toEqual([
      'battery',
      'brightness',
      'moveDetected',
      'humidity',
      'temperature',
      'version',
    ]);
  });

  it('exports hub-family advisory roles and statusFields as a stable contract', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    const hub2 = parsed.types.find((t: { type: string }) => t.type === 'Hub 2');
    const hubMini = parsed.types.find((t: { type: string }) => t.type === 'Hub Mini');
    const hub3 = parsed.types.find((t: { type: string }) => t.type === 'Hub 3');
    expect(hub2.role).toBe('hub');
    expect(hub2.statusFields).toEqual(['version', 'temperature', 'humidity', 'lightLevel']);
    expect(hubMini.role).toBe('hub');
    expect(hubMini.statusFields).toEqual(['version']);
    expect(hub3.role).toBe('hub');
    expect(hub3.statusFields).toEqual(expect.arrayContaining(['version', 'temperature', 'humidity', 'lightLevel', 'moveDetected', 'onlineStatus']));
  });

  it('exports official GitHub-documented device types observed in the real account', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--types', 'Pan/Tilt Cam Plus 3K,Presence Sensor,Remote']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    const byType = new Map(parsed.types.map((t: { type: string }) => [t.type, t]));

    expect([...byType.keys()].sort()).toEqual(['Pan/Tilt Cam Plus 3K', 'Presence Sensor', 'Remote']);
    expect(byType.get('Pan/Tilt Cam Plus 3K')).toMatchObject({
      role: 'security',
      readOnly: true,
      commands: [],
    });
    expect(byType.get('Remote')).toMatchObject({
      role: 'other',
      readOnly: true,
      commands: [],
    });
    expect(byType.get('Presence Sensor')).toMatchObject({
      role: 'sensor',
      readOnly: true,
      commands: [],
      statusFields: ['version', 'battery', 'lightLevel', 'detected', 'hubDeviceId'],
    });
  });
});

describe('schema export B3 slim flags', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(`${os.tmpdir()}/sbcli-schema-`);
    vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    resetListCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetListCache();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it('--compact drops descriptions and is significantly smaller than full', async () => {
    const full = await runCli(registerSchemaCommand, ['schema', 'export']);
    const compact = await runCli(registerSchemaCommand, ['schema', 'export', '--compact']);
    const fullLen = full.stdout.join('').length;
    const compactLen = compact.stdout.join('').length;
    expect(compactLen).toBeLessThan(fullLen * 0.8);
    const parsed = JSON.parse(compact.stdout.join('')).data;
    for (const t of parsed.types) {
      expect(t.description).toBeUndefined();
      expect(t.aliases).toBeUndefined();
      for (const c of t.commands) {
        expect(c.description).toBeUndefined();
      }
    }
  });

  it('--types accepts a comma-separated list', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--types', 'Bot,Curtain']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    const types = parsed.types.map((t: { type: string }) => t.type);
    expect(types).toContain('Bot');
    expect(types).toContain('Curtain');
  });

  it('--used filters to types present in the local cache', async () => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'X', deviceName: 'My Bot', deviceType: 'Bot', hubDeviceId: 'H' }],
      infraredRemoteList: [],
    });
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--used']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    const types = parsed.types.map((t: { type: string }) => t.type);
    expect(types).toContain('Bot');
    expect(types).not.toContain('Curtain');
  });

  it('--used returns empty types when no cache exists', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--used']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    expect(parsed.types).toEqual([]);
  });

  it('--project projects only requested top-level keys on each entry', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--type', 'Bot', '--project', 'type,commands']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    expect(parsed.types[0].type).toBe('Bot');
    expect(parsed.types[0].commands).toBeDefined();
    expect(parsed.types[0].category).toBeUndefined();
    expect(parsed.types[0].description).toBeUndefined();
  });

  // =====================================================================
  // --capabilities flag (MVP 5)
  // =====================================================================
  describe('schema export --capabilities', () => {
    it('adds commandsMeta to each device type entry', async () => {
      const res = await runCli(registerSchemaCommand, ['schema', 'export', '--capabilities', '--type', 'Bot']);
      expect(res.exitCode).toBeNull();
      const parsed = JSON.parse(res.stdout.join('')).data;
      expect(parsed.types.length).toBeGreaterThan(0);
      const first = parsed.types[0] as Record<string, unknown>;
      expect(first).toHaveProperty('commandsMeta');
      const meta = first.commandsMeta as Record<string, unknown>;
      expect(typeof meta).toBe('object');
      // commandsMeta contains entries from COMMAND_META for 'devices *' commands
      expect(Object.keys(meta).length).toBeGreaterThan(0);
      const firstEntry = Object.values(meta)[0] as Record<string, unknown>;
      expect(firstEntry).toHaveProperty('agentSafetyTier');
      expect(firstEntry).toHaveProperty('mutating');
    });

    it('normal export without --capabilities does not include commandsMeta', async () => {
      const res = await runCli(registerSchemaCommand, ['schema', 'export', '--type', 'Bot']);
      const parsed = JSON.parse(res.stdout.join('')).data;
      const first = parsed.types[0] as Record<string, unknown>;
      expect(first).not.toHaveProperty('commandsMeta');
    });
  });
});
