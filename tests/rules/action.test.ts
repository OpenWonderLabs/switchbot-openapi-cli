import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import { resetListCache, updateCacheFromDeviceList } from '../../src/devices/cache.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  executeRuleAction,
  resolveActionDevice,
  extractDeviceIdFromAction,
} from '../../src/rules/action.js';
import type { Rule } from '../../src/rules/types.js';
import { readAudit } from '../../src/utils/audit.js';

const baseRule: Rule = {
  name: 'test rule',
  when: { source: 'mqtt', event: 'motion.detected' },
  then: [{ command: 'devices command <id> turnOn' }],
};


describe('resolveActionDevice', () => {
  it('prefers explicit device field over command slot', () => {
    expect(resolveActionDevice('bedroom light', 'FAKE-ID', { 'bedroom light': 'RESOLVED' })).toBe(
      'RESOLVED',
    );
  });
  it('falls back to the command slot when the action has no device field', () => {
    expect(resolveActionDevice(undefined, 'FAKE-ID', {})).toBe('FAKE-ID');
  });
  it('returns null when the command slot is the placeholder and no device is set', () => {
    expect(resolveActionDevice(undefined, '<id>', {})).toBeNull();
  });
  it('raw string that is not an alias passes through unchanged', () => {
    expect(resolveActionDevice('LITERAL-ID', null, { something: 'else' })).toBe('LITERAL-ID');
  });
});

describe('executeRuleAction', () => {
  const originalArgv = process.argv;
  let tmp: string;
  let auditFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sbrules-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tmp);
    auditFile = path.join(tmp, 'audit.log');
    process.argv = ['node', 'cli', '--audit-log', '--audit-log-path', auditFile, '--config', path.join(tmp, 'config.json')];
    resetListCache();
  });
  afterEach(() => {
    process.argv = originalArgv;
    resetListCache();
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each(['unlock', 'nightLatchUnlock', 'createKey', 'deleteKey'])('refuses %s and records the safety rejection', async (verb) => {
    const action = { command: `devices command LOCK-1 ${verb}` };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] },
      fireId: 'fire-1',
      aliases: {},
      skipApiCall: true,
    });
    expect(result.blocked).toBe(true);
    expect(result.error).toBe(`destructive-verb:${verb}`);
    const entries = readAudit(auditFile);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('rule-fire');
    expect(entries[0].result).toBe('error');
    expect(entries[0].rule?.name).toBe('test rule');
  });

  it('rejects a case-normalized lock rule before the device request', async () => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'LOCK-1', deviceName: 'Door', deviceType: 'Smart Lock' }],
      infraredRemoteList: [],
    });
    const adapter = vi.fn(async (config) => ({
      data: { body: {} }, status: 200, statusText: 'OK', headers: {}, config,
    }));
    const action = { command: 'devices command LOCK-1 Lock' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] }, fireId: 'lock-case', aliases: {},
      httpClient: axios.create({ adapter }),
    });

    expect(result.blocked).toBe(true);
    expect(adapter).not.toHaveBeenCalled();
    expect(readAudit(auditFile).at(-1)?.result).toBe('error');
  });

  it('blocks Solar camera motion disabling without changing Video Doorbell rules', async () => {
    updateCacheFromDeviceList({
      deviceList: [
        { deviceId: 'SOLAR', deviceName: 'Solar camera', deviceType: 'Solar Pan/Tilt Cam 2K' },
        { deviceId: 'DOORBELL', deviceName: 'Doorbell', deviceType: 'Video Doorbell' },
      ],
      infraredRemoteList: [],
    });
    const solarAction = { command: 'devices command SOLAR disableMotionDetection' };
    const doorbellAction = { command: 'devices command DOORBELL disableMotionDetection' };
    const solar = await executeRuleAction(solarAction, {
      rule: { ...baseRule, then: [solarAction], dry_run: true }, fireId: 'solar', aliases: {},
    });
    const doorbell = await executeRuleAction(doorbellAction, {
      rule: { ...baseRule, then: [doorbellAction], dry_run: true }, fireId: 'doorbell', aliases: {},
    });

    expect(solar.blocked).toBe(true);
    expect(doorbell).toMatchObject({ ok: true, dryRun: true });
  });

  it.each([
    ['Garage Door Opener', 'turnOn', false],
    ['Garage Door Opener', 'turnOff', false],
    ['Color Bulb', 'turnOn', true],
    [null, 'turnOn', false],
  ])('checks live inventory before automating %s %s', async (deviceType, command, allowed) => {
    const requests: string[] = [];
    const client = axios.create({
      adapter: async (config) => {
        requests.push(`${config.method} ${config.url}`);
        return {
          data: { body: config.method === 'get' ? {
            deviceList: deviceType ? [{ deviceId: 'D1', deviceName: 'Target', deviceType }] : [],
            infraredRemoteList: [],
          } : {} },
          status: 200, statusText: 'OK', headers: {}, config,
        };
      },
    });
    const action = { command: `devices command D1 ${command}` };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] }, fireId: 'catalog-safety', aliases: {}, httpClient: client,
    });
    expect(result.ok).toBe(allowed);
    expect(requests.filter((request) => request.startsWith('post '))).toHaveLength(allowed ? 1 : 0);
    if (!allowed) expect(readAudit(auditFile).at(-1)?.result).toBe('error');
  });

  it('sends spaced JSON rule parameters as an object', async () => {
    let posted: Record<string, unknown> | undefined;
    const client = axios.create({
      adapter: async (config) => {
        if (config.method === 'post') posted = JSON.parse(config.data as string);
        return {
          data: { body: config.method === 'get' ? {
            deviceList: [{ deviceId: 'VAC-1', deviceName: 'Vacuum', deviceType: 'Robot Vacuum Cleaner K11+' }],
            infraredRemoteList: [],
          } : {} },
          status: 200, statusText: 'OK', headers: {}, config,
        };
      },
    });
    const action = {
      command: 'devices command VAC-1 startClean {"action": "sweep", "param": {"fanLevel": 2, "times": 1}}',
    };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] }, fireId: 'json-param', aliases: {}, httpClient: client,
    });

    expect(result.ok).toBe(true);
    expect(posted?.parameter).toEqual({ action: 'sweep', param: { fanLevel: 2, times: 1 } });
  });

  it('preserves spaces in JSON strings and unrelated text parameters', async () => {
    updateCacheFromDeviceList({
      deviceList: [
        { deviceId: 'FRAME-1', deviceName: 'Frame', deviceType: 'AI Art Frame' },
        { deviceId: 'WEATHER-1', deviceName: 'Weather', deviceType: 'WeatherStation' },
      ],
      infraredRemoteList: [],
    });
    const parameters: unknown[] = [];
    const client = axios.create({
      adapter: async (config) => {
        parameters.push(JSON.parse(config.data as string).parameter);
        return { data: { body: {} }, status: 200, statusText: 'OK', headers: {}, config };
      },
    });
    const commands = [
      'devices command FRAME-1 uploadImage {\n  "imageUrl": "https://example.test/my art.jpg"\n}',
      'devices command WEATHER-1 customQuote hello home',
    ];
    for (const command of commands) {
      const action = { command };
      const result = await executeRuleAction(action, {
        rule: { ...baseRule, then: [action] }, fireId: command, aliases: {}, httpClient: client,
      });
      expect(result.ok, command).toBe(true);
    }
    expect(parameters).toEqual([{ imageUrl: 'https://example.test/my art.jpg' }, 'hello home']);
  });

  it('sends legacy space-separated and colon-separated RGB rules identically', async () => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'LAMP-1', deviceName: 'Lamp', deviceType: 'Color Bulb' }],
      infraredRemoteList: [],
    });
    const parameters: unknown[] = [];
    const client = axios.create({
      adapter: async (config) => {
        parameters.push(JSON.parse(config.data as string).parameter);
        return { data: { body: {} }, status: 200, statusText: 'OK', headers: {}, config };
      },
    });

    for (const color of ['255 0 0', '255:0:0', '255   0\t0']) {
      const action = { command: `devices command LAMP-1 setColor ${color}` };
      const result = await executeRuleAction(action, {
        rule: { ...baseRule, then: [action] }, fireId: color, aliases: {}, httpClient: client,
      });
      expect(result.ok, color).toBe(true);
    }
    expect(parameters).toEqual(['255:0:0', '255:0:0', '255:0:0']);
  });

  it('preserves space-separated RGB rules for the ceiling color light', async () => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'CEILING-1', deviceName: 'Ceiling', deviceType: 'RGBICWW Ceiling Light' }],
      infraredRemoteList: [],
    });
    let parameter: unknown;
    const client = axios.create({
      adapter: async (config) => {
        parameter = JSON.parse(config.data as string).parameter;
        return { data: { body: {} }, status: 200, statusText: 'OK', headers: {}, config };
      },
    });
    const action = { command: 'devices command CEILING-1 setColorLightRGB 255 0 0' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] }, fireId: 'ceiling-rgb', aliases: {}, httpClient: client,
    });

    expect(result.ok).toBe(true);
    expect(parameter).toBe('255:0:0');
  });

  it('rejects invalid space-separated RGB rules before sending', async () => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'LAMP-1', deviceName: 'Lamp', deviceType: 'Color Bulb' }],
      infraredRemoteList: [],
    });
    const adapter = vi.fn(async (config) => ({
      data: { body: {} }, status: 200, statusText: 'OK', headers: {}, config,
    }));
    const client = axios.create({ adapter });
    for (const color of ['256 0 0', '-1 0 0', '255 0', '255 0 0 0']) {
      const action = { command: `devices command LAMP-1 setColor ${color}` };
      const result = await executeRuleAction(action, {
        rule: { ...baseRule, then: [action] }, fireId: color, aliases: {}, httpClient: client,
      });
      expect(result.ok, color).toBe(false);
    }
    expect(adapter).not.toHaveBeenCalled();
  });

  it('rejects out-of-range rule parameters before the device request', async () => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'VAC-1', deviceName: 'Vacuum', deviceType: 'Robot Vacuum Cleaner K11+' }],
      infraredRemoteList: [],
    });
    const requests: string[] = [];
    const client = axios.create({
      adapter: async (config) => {
        requests.push(`${config.method} ${config.url}`);
        return { data: { body: {} }, status: 200, statusText: 'OK', headers: {}, config };
      },
    });
    const action = { command: 'devices command VAC-1 startClean {"action":"sweep","param":{"fanLevel":999}}' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] }, fireId: 'invalid-param', aliases: {}, httpClient: client,
    });

    expect(result.ok).toBe(false);
    expect(requests).toEqual([]);
    expect(readAudit(auditFile).at(-1)?.result).toBe('error');
  });

  it.each([
    { raw: '{"action": "sweep", "param": {"fanLevel": 999}}', expected: { action: 'sweep', param: { fanLevel: 999 } } },
    { raw: '{"action":', expected: '{"action":' },
  ])('preserves the original rule parameter in rejected-action audit records', async ({ raw, expected }) => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'VAC-1', deviceName: 'Vacuum', deviceType: 'Robot Vacuum Cleaner K11+' }],
      infraredRemoteList: [],
    });
    const action = { command: `devices command VAC-1 startClean ${raw}` };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] }, fireId: 'invalid-audit', aliases: {}, skipApiCall: true,
    });
    expect(result.ok).toBe(false);
    expect(readAudit(auditFile).at(-1)).toMatchObject({ result: 'error', parameter: expected });
  });

  it('preserves validated JSON in the rule audit when the device request fails', async () => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'VAC-1', deviceName: 'Vacuum', deviceType: 'Robot Vacuum Cleaner K11+' }],
      infraredRemoteList: [],
    });
    const client = axios.create({ adapter: async () => { throw new Error('device unavailable'); } });
    const action = { command: 'devices command VAC-1 startClean {"action": "sweep", "param": {"fanLevel": 2}}' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] }, fireId: 'failed-audit', aliases: {}, httpClient: client,
    });
    expect(result.ok).toBe(false);
    expect(readAudit(auditFile).at(-1)).toMatchObject({
      kind: 'rule-fire', result: 'error', parameter: { action: 'sweep', param: { fanLevel: 2 } },
    });
  });

  it('rejects cold-cache dry-run without any network request', async () => {
    const adapter = vi.fn(async (config) => ({
      data: { body: {} }, status: 200, statusText: 'OK', headers: {}, config,
    }));
    const action = { command: 'devices command MISSING turnOn' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action], dry_run: true },
      fireId: 'cold-cache', aliases: {}, httpClient: axios.create({ adapter }),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cache|inventory/i);
    expect(adapter).not.toHaveBeenCalled();
    expect(readAudit(auditFile).at(-1)?.result).toBe('error');
  });

  it('dry-run records rule-fire-dry and skips the API', async () => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'AA-BB', deviceName: 'Lamp', deviceType: 'Color Bulb' }],
      infraredRemoteList: [],
    });
    const action = { command: 'devices command AA-BB turnOn' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action], dry_run: true },
      fireId: 'fire-2',
      aliases: {},
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    const entries = readAudit(auditFile);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('rule-fire-dry');
    expect(entries[0].deviceId).toBe('AA-BB');
    expect(entries[0].rule?.fireId).toBe('fire-2');
  });

  it('resolves aliases before calling executeCommand', async () => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'AA-BB-CC', deviceName: 'Lamp', deviceType: 'Color Bulb' }],
      infraredRemoteList: [],
    });
    const action = { command: 'devices command <id> turnOn', device: 'bedroom light' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] },
      fireId: 'fire-3',
      aliases: { 'bedroom light': 'AA-BB-CC' },
      skipApiCall: true,
    });
    expect(result.ok).toBe(true);
    expect(result.deviceId).toBe('AA-BB-CC');
    const entries = readAudit(auditFile);
    expect(entries[0].deviceId).toBe('AA-BB-CC');
    expect(entries[0].rule?.reason).toBe('api-skipped');
  });

  it('missing device (command uses <id> and action has no device field) errors cleanly', async () => {
    const action = { command: 'devices command <id> turnOn' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] },
      fireId: 'fire-4',
      aliases: {},
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('missing-device');
  });

  it('unparseable command is audited and reported', async () => {
    const action = { command: 'scenes run welcome-home' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] },
      fireId: 'fire-5',
      aliases: {},
    });
    expect(result.blocked).toBe(true);
    const entries = readAudit(auditFile);
    expect(entries[0].error).toBe('unparseable-command');
  });

  it('globalDryRun forces dry-run even when rule.dry_run is false', async () => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'AA-BB', deviceName: 'Lamp', deviceType: 'Color Bulb' }],
      infraredRemoteList: [],
    });
    const action = { command: 'devices command AA-BB turnOff' };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action], dry_run: false },
      fireId: 'fire-6',
      aliases: {},
      globalDryRun: true,
    });
    expect(result.dryRun).toBe(true);
    const entries = readAudit(auditFile);
    expect(entries[0].kind).toBe('rule-fire-dry');
  });
});

describe('extractDeviceIdFromAction', () => {
  it('returns action.device when present, ignoring the command string', () => {
    expect(extractDeviceIdFromAction({ command: 'devices command OTHER turnOn', device: 'EXPLICIT' }))
      .toBe('EXPLICIT');
  });

  it('extracts deviceId from command string when device field is absent', () => {
    expect(extractDeviceIdFromAction({ command: 'devices command DEVICE123 turnOn' }))
      .toBe('DEVICE123');
  });

  it('returns the <id> placeholder literal when command uses a placeholder', () => {
    expect(extractDeviceIdFromAction({ command: 'devices command <id> turnOn' }))
      .toBe('<id>');
  });

  it('returns null when command does not match the devices command pattern', () => {
    expect(extractDeviceIdFromAction({ command: 'scenes run welcome' })).toBeNull();
    expect(extractDeviceIdFromAction({ command: '' })).toBeNull();
  });
});
