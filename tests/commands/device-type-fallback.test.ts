/**
 * Tests for AI device deviceType fallback + typeSource signal.
 *
 * AI series devices (e.g. MindClip, PinNote) may report `controlType` but
 * not `deviceType` from the SwitchBot API.  describeDevice() should fall
 * back to `controlType` and expose the source via `typeSource`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the HTTP client so no real network calls are made.
// ---------------------------------------------------------------------------
const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn(), post: vi.fn() };
  return { createClient: vi.fn(() => instance), __instance: instance };
});

vi.mock('../../src/api/client.js', () => ({
  createClient: apiMock.createClient,
  ApiError: class ApiError extends Error {
    constructor(message: string, public readonly code: number) {
      super(message);
      this.name = 'ApiError';
    }
  },
  DryRunSignal: class DryRunSignal extends Error {
    constructor(public readonly method: string, public readonly url: string) {
      super('dry-run');
      this.name = 'DryRunSignal';
    }
  },
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

vi.mock('../../src/utils/flags.js', () => ({
  isDryRun: vi.fn(() => false),
  isVerbose: vi.fn(() => false),
  getCacheMode: vi.fn(() => ({ listTtlMs: 0, statusTtlMs: 0 })),
  getTimeout: vi.fn(() => 30000),
  getConfigPath: vi.fn(() => undefined),
  getProfile: vi.fn(() => undefined),
  getAuditLog: vi.fn(() => null),
}));

vi.mock('../../src/utils/audit.js', () => ({
  writeAudit: vi.fn(),
}));

import { describeDevice } from '../../src/lib/devices.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDeviceList(
  deviceList: object[],
  infraredRemoteList: object[] = []
): void {
  apiMock.__instance.get.mockResolvedValue({
    data: {
      statusCode: 100,
      body: { deviceList, infraredRemoteList },
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('describeDevice — typeSource signal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses deviceType when present and sets typeSource to "deviceType"', async () => {
    mockDeviceList([
      {
        deviceId: 'BOT-001',
        deviceName: 'My Bot',
        deviceType: 'Bot',
        enableCloudService: true,
        hubDeviceId: 'HUB-1',
      },
    ]);

    const result = await describeDevice('BOT-001');

    expect(result.typeName).toBe('Bot');
    expect(result.typeSource).toBe('deviceType');
  });

  it('falls back to controlType when deviceType is empty and sets typeSource to "controlType"', async () => {
    mockDeviceList([
      {
        deviceId: 'AI-001',
        deviceName: 'MindClip',
        deviceType: '',
        controlType: 'MindClip',
        enableCloudService: true,
        hubDeviceId: 'HUB-1',
      },
    ]);

    const result = await describeDevice('AI-001');

    expect(result.typeName).toBe('MindClip');
    expect(result.typeSource).toBe('controlType');
  });

  it('falls back to controlType when deviceType is absent and sets typeSource to "controlType"', async () => {
    mockDeviceList([
      {
        deviceId: 'AI-002',
        deviceName: 'PinNote',
        // deviceType intentionally omitted (undefined)
        controlType: 'PinNote',
        enableCloudService: true,
        hubDeviceId: 'HUB-1',
      },
    ]);

    const result = await describeDevice('AI-002');

    expect(result.typeName).toBe('PinNote');
    expect(result.typeSource).toBe('controlType');
  });

  it('sets typeSource to "deviceType" with empty typeName when neither deviceType nor controlType present', async () => {
    mockDeviceList([
      {
        deviceId: 'UNKNOWN-001',
        deviceName: 'Unknown Device',
        enableCloudService: true,
        hubDeviceId: 'HUB-1',
      },
    ]);

    const result = await describeDevice('UNKNOWN-001');

    expect(result.typeName).toBe('');
    expect(result.typeSource).toBe('deviceType');
  });

  it('uses remoteType for IR devices and sets typeSource to "remoteType"', async () => {
    mockDeviceList(
      [],
      [
        {
          deviceId: 'IR-001',
          deviceName: 'Living AC',
          remoteType: 'Air Conditioner',
          hubDeviceId: 'HUB-1',
        },
      ]
    );

    const result = await describeDevice('IR-001');

    expect(result.typeName).toBe('Air Conditioner');
    expect(result.typeSource).toBe('remoteType');
  });
});
