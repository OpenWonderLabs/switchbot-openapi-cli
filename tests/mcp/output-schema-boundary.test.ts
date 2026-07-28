/**
 * MCP outputSchema boundary tests — verify that Zod validation in list_devices
 * accepts all realistic API data shapes, including nullable/optional fields.
 *
 * If the outputSchema ever tightens a field that the API returns as null,
 * these tests catch it before it ships.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  clearCache: vi.fn(),
  isListCacheFresh: vi.fn(() => false),
  listCacheAgeMs: vi.fn(() => null),
  getCachedStatus: vi.fn(() => null),
  setCachedStatus: vi.fn(),
  clearStatusCache: vi.fn(),
  loadStatusCache: vi.fn(() => ({ entries: {} })),
  describeCache: vi.fn(() => ({
    list: { path: '', exists: false },
    status: { path: '', exists: false, entryCount: 0 },
  })),
  getCachedStatusEntry: vi.fn(() => null),
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSwitchBotMcpServer } from '../../src/commands/mcp.js';

async function pair() {
  const server = createSwitchBotMcpServer({ toolProfile: 'all' });
  const client = new Client({ name: 'boundary-test', version: '0.0.0' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client };
}

function makeApiResponse(deviceList: unknown[], infraredRemoteList: unknown[] = []) {
  return {
    data: {
      statusCode: 100,
      body: { deviceList, infraredRemoteList },
    },
  };
}

describe('list_devices outputSchema — nullable/optional field boundaries', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
  });

  it('accepts a physical device with roomID: null and roomName: null', async () => {
    const { client } = await pair();
    apiMock.__instance.get.mockResolvedValueOnce(makeApiResponse([
      {
        deviceId: 'OUTDOOR1',
        deviceName: 'Outdoor Meter',
        deviceType: 'MeterOutdoor',
        enableCloudService: true,
        hubDeviceId: 'HUB001',
        roomID: null,
        roomName: null,
      },
    ]));

    const result = await client.callTool({ name: 'list_devices', arguments: {} });
    expect(result.isError, 'roomID: null should not fail Zod validation').toBeFalsy();
    const sc = (result as { structuredContent: { deviceList: unknown[] } }).structuredContent;
    expect(sc.deviceList).toHaveLength(1);
  });

  it('accepts a physical device with all optional fields omitted', async () => {
    const { client } = await pair();
    apiMock.__instance.get.mockResolvedValueOnce(makeApiResponse([
      {
        deviceId: 'MINIMAL1',
        deviceName: 'Minimal Device',
        enableCloudService: false,
        hubDeviceId: '000000000000',
        // deviceType, roomID, roomName, familyName, controlType all omitted
      },
    ]));

    const result = await client.callTool({ name: 'list_devices', arguments: {} });
    expect(result.isError, 'all optional fields omitted should pass Zod validation').toBeFalsy();
    const sc = (result as { structuredContent: { deviceList: unknown[] } }).structuredContent;
    expect(sc.deviceList).toHaveLength(1);
  });

  it('accepts an IR device with controlType: null', async () => {
    const { client } = await pair();
    apiMock.__instance.get.mockResolvedValueOnce(makeApiResponse(
      [],
      [
        {
          deviceId: 'IR001',
          deviceName: 'IR TV',
          remoteType: 'TV',
          hubDeviceId: 'HUB001',
          controlType: null,
        },
      ]
    ));

    const result = await client.callTool({ name: 'list_devices', arguments: {} });
    expect(result.isError, 'IR device controlType: null should pass Zod validation').toBeFalsy();
    const sc = (result as { structuredContent: { infraredRemoteList: unknown[] } }).structuredContent;
    expect(sc.infraredRemoteList).toHaveLength(1);
  });

  it('accepts a mixed payload: one device with nulls + one fully populated', async () => {
    const { client } = await pair();
    apiMock.__instance.get.mockResolvedValueOnce(makeApiResponse([
      {
        deviceId: 'OUTDOOR2',
        deviceName: 'Outdoor Sensor',
        deviceType: 'MeterOutdoor',
        enableCloudService: true,
        hubDeviceId: 'HUB001',
        roomID: null,
        roomName: null,
      },
      {
        deviceId: 'INDOOR1',
        deviceName: 'Living Room Light',
        deviceType: 'Color Bulb',
        enableCloudService: true,
        hubDeviceId: 'HUB001',
        roomID: 'room-123',
        roomName: 'Living Room',
        familyName: 'Home',
        controlType: 'light',
      },
    ]));

    const result = await client.callTool({ name: 'list_devices', arguments: {} });
    expect(result.isError, 'mixed null/populated devices should pass Zod validation').toBeFalsy();
    const sc = (result as { structuredContent: { deviceList: unknown[] } }).structuredContent;
    expect(sc.deviceList).toHaveLength(2);
  });
});
