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
    ['Solar Pan/Tilt Cam 2K', 'disableMotionDetection', false],
    ['Video Doorbell', 'disableMotionDetection', true],
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

  it.each(['live', 'dry-run', 'error'] as const)('preserves compact JSON as a string in %s rule audit records', async mode => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'FRAME-1', deviceName: 'Frame', deviceType: 'AI Art Frame' }],
      infraredRemoteList: [],
    });
    const parameters: unknown[] = [];
    const client = axios.create({
      adapter: async config => {
        parameters.push(JSON.parse(String(config.data)).parameter);
        if (mode === 'error') throw new Error('device unavailable');
        return { data: { body: {} }, status: 200, statusText: 'OK', headers: {}, config };
      },
    });
    const raw = '{"imageUrl":"https://example.test/a.jpg"}';
    const action = { command: `devices command FRAME-1 uploadImage ${raw}` };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action], dry_run: mode === 'dry-run' },
      fireId: 'compact-json-audit', aliases: {}, httpClient: client,
    });
    expect(result.ok).toBe(mode !== 'error');
    expect(parameters).toEqual(mode === 'dry-run' ? [] : [{ imageUrl: 'https://example.test/a.jpg' }]);
    expect(readAudit(auditFile).at(-1)).toMatchObject({
      auditVersion: 2, kind: mode === 'dry-run' ? 'rule-fire-dry' : 'rule-fire',
      result: mode === 'error' ? 'error' : 'ok', parameter: raw,
    });
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
    expect(readAudit(auditFile).at(-1)).toMatchObject({
      kind: 'rule-fire', result: 'ok', parameter: '{"action": "sweep", "param": {"fanLevel": 2, "times": 1}}',
    });
  });

  it.each([false, true])('preserves JSON and text whitespace in wire and audit data with dryRun=%s', async dryRun => {
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
        rule: { ...baseRule, then: [action], dry_run: dryRun }, fireId: command, aliases: {}, httpClient: client,
      });
      expect(result.ok, command).toBe(true);
    }
    const expected = [{ imageUrl: 'https://example.test/my art.jpg' }, 'hello home'];
    expect(parameters).toEqual(dryRun ? [] : expected);
    const ruleParameters = ['{\n  "imageUrl": "https://example.test/my art.jpg"\n}', 'hello home'];
    expect(readAudit(auditFile).map(({ kind, result, parameter }) => ({ kind, result, parameter })))
      .toEqual(ruleParameters.flatMap((parameter, index) => dryRun
        ? [{ kind: 'rule-fire-dry', result: 'ok', parameter }]
        : [
          { kind: 'command', result: 'ok', parameter: expected[index] },
          { kind: 'rule-fire', result: 'ok', parameter },
        ]));
  });

  it.each([
    ['Color Bulb', 'setColor', false], ['Color Bulb', 'setColor', true],
    ['RGBICWW Ceiling Light', 'setColorLightRGB', false], ['RGBICWW Ceiling Light', 'setColorLightRGB', true],
  ] as const)('preserves both RGB formats for %s %s with dryRun=%s', async (deviceType, verb, dryRun) => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'LAMP-1', deviceName: 'Lamp', deviceType }],
      infraredRemoteList: [],
    });
    const parameters: unknown[] = [];
    const client = axios.create({
      adapter: async config => {
        parameters.push(JSON.parse(config.data as string).parameter);
        return { data: { body: {} }, status: 200, statusText: 'OK', headers: {}, config };
      },
    });
    for (const color of ['255 0 0', '255:0:0', '255   0\t0']) {
      const action = { command: `devices command LAMP-1 ${verb} ${color}` };
      const result = await executeRuleAction(action, {
        rule: { ...baseRule, then: [action], dry_run: dryRun }, fireId: color, aliases: {}, httpClient: client,
      });
      expect(result.ok, color).toBe(true);
      expect(readAudit(auditFile).at(-1)).toMatchObject({
        kind: dryRun ? 'rule-fire-dry' : 'rule-fire', result: 'ok', command: verb, parameter: '255:0:0',
      });
    }
    expect(parameters).toEqual(dryRun ? [] : ['255:0:0', '255:0:0', '255:0:0']);
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
    '{"action": "sweep", "param": {"fanLevel": 999}}',
    '{"action":',
  ])('preserves the original rule parameter in rejected-action audit records: %s', async raw => {
    updateCacheFromDeviceList({
      deviceList: [{ deviceId: 'VAC-1', deviceName: 'Vacuum', deviceType: 'Robot Vacuum Cleaner K11+' }],
      infraredRemoteList: [],
    });
    const action = { command: `devices command VAC-1 startClean ${raw}` };
    const result = await executeRuleAction(action, {
      rule: { ...baseRule, then: [action] }, fireId: 'invalid-audit', aliases: {}, skipApiCall: true,
    });
    expect(result.ok).toBe(false);
    expect(readAudit(auditFile).at(-1)).toMatchObject({ result: 'error', parameter: raw });
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
      kind: 'rule-fire', result: 'error', parameter: '{"action": "sweep", "param": {"fanLevel": 2}}',
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
