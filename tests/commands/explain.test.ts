import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { runCli } from '../helpers/cli.js';

// ---------------------------------------------------------------------------
// Mock the lib/devices layer so no real HTTP calls are made.
// ---------------------------------------------------------------------------
const devicesMock = vi.hoisted(() => {
  class DeviceNotFoundError extends Error {
    constructor(public readonly deviceId: string) {
      super(`No device with id "${deviceId}" found on this account.`);
      this.name = 'DeviceNotFoundError';
    }
  }

  const describeDevice = vi.fn();
  const fetchDeviceList = vi.fn();

  return { describeDevice, fetchDeviceList, DeviceNotFoundError };
});

vi.mock('../../src/lib/devices.js', () => ({
  describeDevice: devicesMock.describeDevice,
  fetchDeviceList: devicesMock.fetchDeviceList,
  DeviceNotFoundError: devicesMock.DeviceNotFoundError,
  buildHubLocationMap: vi.fn(() => new Map()),
  isDestructiveCommand: vi.fn(() => false),
  validateCommand: vi.fn(() => ({ ok: true })),
  executeCommand: vi.fn(),
  fetchDeviceStatus: vi.fn(),
  searchCatalog: vi.fn(() => []),
}));

vi.mock('../../src/devices/cache.js', () => ({
  getCachedDevice: vi.fn(() => null),
  updateCacheFromDeviceList: vi.fn(),
  loadCache: vi.fn(() => null),
  isListCacheFresh: vi.fn(() => false),
  getCachedStatus: vi.fn(() => null),
  setCachedStatus: vi.fn(),
  clearCache: vi.fn(),
  clearStatusCache: vi.fn(),
  loadStatusCache: vi.fn(() => ({ entries: {} })),
  describeCache: vi.fn(() => ({
    list: { path: '', exists: false },
    status: { path: '', exists: false, entryCount: 0 },
  })),
}));

import { registerDevicesCommand } from '../../src/commands/devices.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const DID = 'BOT-001';

const botDescribeResult = {
  device: {
    deviceId: DID,
    deviceName: 'My Bot',
    deviceType: 'Bot',
    enableCloudService: true,
    hubDeviceId: 'HUB-001',
    familyName: 'Home',
    roomName: 'Living Room',
  },
  isPhysical: true,
  typeName: 'Bot',
  controlType: 'command' as const,
  catalog: {
    type: 'Bot',
    category: 'physical' as const,
    commands: [
      { command: 'turnOn', parameter: '—', description: 'Turn on', idempotent: true, destructive: false },
      { command: 'turnOff', parameter: '—', description: 'Turn off', idempotent: true, destructive: false },
    ],
    statusFields: ['power', 'battery'],
    role: 'power' as const,
    readOnly: false,
  },
  capabilities: {
    role: 'power',
    readOnly: false,
    commands: [
      { command: 'turnOn', parameter: '—', description: 'Turn on', idempotent: true, destructive: false },
      { command: 'turnOff', parameter: '—', description: 'Turn off', idempotent: true, destructive: false },
    ],
    statusFields: ['power', 'battery'],
    liveStatus: { power: 'on', battery: 95, deviceId: DID },
  },
  source: 'catalog+live' as const,
  suggestedActions: [
    { command: 'turnOn', description: 'Turn on' },
    { command: 'turnOff', description: 'Turn off' },
  ],
};

async function runExplain(...args: string[]) {
  return runCli(registerDevicesCommand, ['devices', 'explain', ...args]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('devices explain', () => {
  beforeEach(() => {
    devicesMock.describeDevice.mockReset();
    devicesMock.fetchDeviceList.mockReset();
    devicesMock.fetchDeviceList.mockResolvedValue({ deviceList: [], infraredRemoteList: [] });
  });

  it('--json: returns correct ExplainResult shape on success', async () => {
    devicesMock.describeDevice.mockResolvedValue(botDescribeResult);

    const res = await runExplain('--json', DID);

    expect(res.exitCode).toBeNull();
    const parsed = JSON.parse(res.stdout[0]);
    expect(parsed.data.deviceId).toBe(DID);
    expect(parsed.data.type).toBe('Bot');
    expect(parsed.data.category).toBe('physical');
    expect(parsed.data.name).toBe('My Bot');
    expect(parsed.data.role).toBe('power');
    expect(parsed.data.readOnly).toBe(false);
    expect(Array.isArray(parsed.data.commands)).toBe(true);
    expect(parsed.data.commands[0].command).toBe('turnOn');
    expect(parsed.data.commands[0].idempotent).toBe(true);
    expect(Array.isArray(parsed.data.statusFields)).toBe(true);
    expect(parsed.data.liveStatus).toMatchObject({ power: 'on', battery: 95 });
    expect(Array.isArray(parsed.data.suggestedActions)).toBe(true);
    expect(Array.isArray(parsed.data.warnings)).toBe(true);
    expect(parsed.data.warnings).toHaveLength(0);
  });

  it('--json: device not found emits { error: { code:1, kind:"runtime" } } on stdout (bug #SYS-1)', async () => {
    devicesMock.describeDevice.mockRejectedValue(new devicesMock.DeviceNotFoundError('MISSING'));

    const res = await runExplain('--json', 'MISSING');

    expect(res.exitCode).toBe(1);
    // Non-TTY: stderr stays clean so jq consumers aren't polluted.
    expect(res.stderr).toHaveLength(0);
    const parsed = JSON.parse(res.stdout[0]);
    expect(parsed.error.code).toBe(1);
    expect(parsed.error.kind).toBe('runtime');
    expect(parsed.error.message).toContain('MISSING');
  });

  it('human mode: device not found prints plain text to stderr', async () => {
    devicesMock.describeDevice.mockRejectedValue(new devicesMock.DeviceNotFoundError('MISSING'));

    const res = await runExplain('MISSING');

    expect(res.exitCode).toBe(1);
    expect(res.stdout).toHaveLength(0);
    expect(res.stderr[0]).toContain('MISSING');
    expect(res.stderr[0]).not.toContain('"error"');
  });

  it('--no-live: calls describeDevice with live:false', async () => {
    devicesMock.describeDevice.mockResolvedValue(botDescribeResult);

    await runExplain('--json', '--no-live', DID);

    expect(devicesMock.describeDevice).toHaveBeenCalledWith(DID, { live: false });
  });

  it('default: calls describeDevice with live:true', async () => {
    devicesMock.describeDevice.mockResolvedValue(botDescribeResult);

    await runExplain('--json', DID);

    expect(devicesMock.describeDevice).toHaveBeenCalledWith(DID, { live: true });
  });

  it('--json: cloud service disabled emits a warning', async () => {
    const noCloud = {
      ...botDescribeResult,
      device: { ...botDescribeResult.device, enableCloudService: false },
    };
    devicesMock.describeDevice.mockResolvedValue(noCloud);

    const res = await runExplain('--json', DID);

    const parsed = JSON.parse(res.stdout[0]);
    expect(parsed.data.warnings.some((w: string) => w.toLowerCase().includes('cloud'))).toBe(true);
  });

  it('--json: surfaces dangling hubDeviceId warnings from describeDevice', async () => {
    devicesMock.describeDevice.mockResolvedValue({
      ...botDescribeResult,
      warnings: ['hubDeviceId HUB-MISSING is not present in the current inventory'],
    });

    const res = await runExplain('--json', DID);

    const parsed = JSON.parse(res.stdout[0]);
    expect(parsed.data.warnings).toContain(
      'hubDeviceId HUB-MISSING is not present in the current inventory',
    );
  });

  it('--json: exposes catalogNote for uncatalogued devices', async () => {
    devicesMock.describeDevice.mockResolvedValue({
      ...botDescribeResult,
      catalog: null,
      capabilities: null,
      source: 'none',
      catalogNote: 'No built-in catalog entry for type "AI MindClip"; try `switchbot devices status BOT-001 --json` for raw status.',
    });

    const res = await runExplain('--json', DID);

    const parsed = JSON.parse(res.stdout[0]);
    expect(parsed.data.catalogNote).toMatch(/No built-in catalog entry/);
    expect(parsed.data.warnings.some((w: string) => w.includes('No catalog entry'))).toBe(true);
  });

  it('--json: hub role fetches and lists IR children', async () => {
    const hubResult = {
      ...botDescribeResult,
      typeName: 'Hub 2',
      catalog: { ...botDescribeResult.catalog, role: 'hub' as const, type: 'Hub 2' },
    };
    devicesMock.describeDevice.mockResolvedValue(hubResult);
    devicesMock.fetchDeviceList.mockResolvedValue({
      deviceList: [],
      infraredRemoteList: [
        { deviceId: 'IR-1', deviceName: 'TV Remote', remoteType: 'TV', hubDeviceId: DID },
        { deviceId: 'IR-2', deviceName: 'AC Remote', remoteType: 'Air Conditioner', hubDeviceId: 'OTHER' },
      ],
    });

    const res = await runExplain('--json', DID);

    const parsed = JSON.parse(res.stdout[0]);
    expect(parsed.data.children).toHaveLength(1);
    expect(parsed.data.children[0].deviceId).toBe('IR-1');
    expect(parsed.data.children[0].type).toBe('TV');
  });

  it('human mode: prints device header and commands', async () => {
    devicesMock.describeDevice.mockResolvedValue(botDescribeResult);

    const res = await runExplain(DID);

    expect(res.exitCode).toBeNull();
    const output = res.stdout.join('\n');
    expect(output).toContain('My Bot');
    expect(output).toContain(DID);
    expect(output).toContain('turnOn');
  });
});
