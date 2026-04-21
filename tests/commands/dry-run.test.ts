/**
 * dryRun tests (bug #4): send_command and run_scene must return
 * { ok:true, dryRun:true, wouldSend:{...} } when dryRun:true is passed,
 * and must NOT call the API mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn(), post: vi.fn() };
  return {
    createClient: vi.fn(() => instance),
    __instance: instance,
  };
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

const cacheMock = vi.hoisted(() => ({
  map: new Map<string, { type: string; name: string; category: 'physical' | 'ir' }>(),
  getCachedDevice: vi.fn((id: string) => cacheMock.map.get(id) ?? null),
  updateCacheFromDeviceList: vi.fn(),
}));

vi.mock('../../src/devices/cache.js', () => ({
  getCachedDevice: cacheMock.getCachedDevice,
  updateCacheFromDeviceList: cacheMock.updateCacheFromDeviceList,
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
}));

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSwitchBotMcpServer } from '../../src/commands/mcp.js';

async function pair() {
  const server = createSwitchBotMcpServer();
  const client = new Client({ name: 'test', version: '0.0.1' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { server, client };
}

describe('dryRun support on mutating tools', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
    cacheMock.map.clear();
  });

  // ---- send_command ---------------------------------------------------------

  it('send_command dryRun:true returns wouldSend without calling the API', async () => {
    cacheMock.map.set('BULB1', { type: 'Color Bulb', name: 'Desk Lamp', category: 'physical' });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: {
        deviceId: 'BULB1',
        command: 'turnOn',
        dryRun: true,
      },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.wouldSend).toMatchObject({
      deviceId: 'BULB1',
      command: 'turnOn',
      commandType: 'command',
    });

    // Must not have hit the API
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
    expect(apiMock.__instance.get).not.toHaveBeenCalled();
  });

  it('send_command dryRun:true with parameter and commandType mirrors the full request shape', async () => {
    cacheMock.map.set('IR1', { type: 'IR TV', name: 'Living Room', category: 'ir' });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: {
        deviceId: 'IR1',
        command: 'SetChannel',
        parameter: '5',
        commandType: 'customize',
        dryRun: true,
      },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.wouldSend).toMatchObject({
      deviceId: 'IR1',
      command: 'SetChannel',
      parameter: '5',
      commandType: 'customize',
    });
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  it('send_command without dryRun still calls the API (regression)', async () => {
    cacheMock.map.set('BULB2', { type: 'Color Bulb', name: 'Ceiling', category: 'physical' });
    apiMock.__instance.post.mockResolvedValueOnce({
      data: { statusCode: 100, body: {} },
    });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'BULB2', command: 'turnOn' },
    });

    expect(res.isError).toBeFalsy();
    expect(apiMock.__instance.post).toHaveBeenCalledTimes(1);
  });

  // ---- send_command command-name validation in dry-run (bug #55) --------------

  it('send_command dryRun:true rejects unknown command name (bug #55)', async () => {
    cacheMock.map.set('BULB3', { type: 'Color Bulb', name: 'Desk Lamp', category: 'physical' });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'BULB3', command: 'fakeCmd', dryRun: true },
    });

    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.error.context?.validationKind).toBe('unknown-command');
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  it('send_command dryRun:true accepts case-normalized command name (bug #55)', async () => {
    cacheMock.map.set('BULB4', { type: 'Color Bulb', name: 'Ceiling', category: 'physical' });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'send_command',
      arguments: { deviceId: 'BULB4', command: 'turnon', dryRun: true },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.dryRun).toBe(true);
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  // ---- run_scene ------------------------------------------------------------

  it('run_scene dryRun:true returns wouldSend without calling the API', async () => {
    const { client } = await pair();

    const res = await client.callTool({
      name: 'run_scene',
      arguments: { sceneId: 'SCENE42', dryRun: true },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.wouldSend).toMatchObject({ sceneId: 'SCENE42' });

    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  it('run_scene without dryRun still calls the API (regression)', async () => {
    apiMock.__instance.post.mockResolvedValueOnce({ data: { statusCode: 100, body: {} } });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'run_scene',
      arguments: { sceneId: 'S123' },
    });

    expect(res.isError).toBeFalsy();
    expect(apiMock.__instance.post).toHaveBeenCalledWith('/v1.1/scenes/S123/execute');
  });

  // ---- run_scene sceneId validation in dry-run (bug #56) --------------------

  it('run_scene dryRun:true rejects unknown sceneId (bug #56)', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({
      data: { body: [{ sceneId: 'S1', sceneName: 'Good Morning' }] },
    });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'run_scene',
      arguments: { sceneId: 'FAKE', dryRun: true },
    });

    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.error.subKind).toBe('scene-not-found');
    expect(parsed.error.message).toContain('FAKE');
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });

  it('run_scene dryRun:true returns sceneName in wouldSend for valid sceneId (bug #56)', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({
      data: { body: [{ sceneId: 'S1', sceneName: 'Good Morning' }] },
    });
    const { client } = await pair();

    const res = await client.callTool({
      name: 'run_scene',
      arguments: { sceneId: 'S1', dryRun: true },
    });

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.wouldSend.sceneId).toBe('S1');
    expect(parsed.wouldSend.sceneName).toBe('Good Morning');
    expect(apiMock.__instance.post).not.toHaveBeenCalled();
  });
});
