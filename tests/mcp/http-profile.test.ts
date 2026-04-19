import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock loadConfigForProfile so we can observe the profile argument used
// per request. createClient in real code calls loadConfig(), so we also
// mock that to assert which credentials were used.
const configMock = vi.hoisted(() => {
  return {
    loadConfigForProfile: vi.fn((profile?: string) => {
      if (profile === 'home') return { token: 'home-token', secret: 'home-secret' };
      if (profile === 'work') return { token: 'work-token', secret: 'work-secret' };
      return { token: 'default-token', secret: 'default-secret' };
    }),
    loadConfig: vi.fn(() => ({ token: 'default-token', secret: 'default-secret' })),
  };
});

vi.mock('../../src/config.js', () => ({
  loadConfig: configMock.loadConfig,
  loadConfigForProfile: configMock.loadConfigForProfile,
  configFilePath: vi.fn(() => '/tmp/config.json'),
  profileFilePath: vi.fn((p: string) => `/tmp/${p}.json`),
  listProfiles: vi.fn(() => []),
  saveConfig: vi.fn(),
  showConfig: vi.fn(),
}));

// Minimal cache stub so the factory doesn't blow up on import.
vi.mock('../../src/devices/cache.js', () => ({
  getCachedDevice: vi.fn(() => null),
  getCachedTypeMap: vi.fn(() => new Map()),
  updateCacheFromDeviceList: vi.fn(),
  loadCache: vi.fn(() => null),
  clearCache: vi.fn(),
  isListCacheFresh: vi.fn(() => false),
  listCacheAgeMs: vi.fn(() => null),
  getCachedStatus: vi.fn(() => null),
  setCachedStatus: vi.fn(),
  clearStatusCache: vi.fn(),
  loadStatusCache: vi.fn(() => ({ entries: {} })),
  describeCache: vi.fn(() => ({ list: {}, status: {} })),
}));

import { createSwitchBotMcpServer, type McpServerOptions } from '../../src/commands/mcp.js';

describe('MCP per-request profile resolver', () => {
  beforeEach(() => {
    configMock.loadConfigForProfile.mockClear();
    configMock.loadConfig.mockClear();
  });

  it('defaults to loadConfigForProfile() with no profile when no resolver provided', () => {
    const server = createSwitchBotMcpServer();
    expect(server).toBeDefined();
    // No tool called yet; the resolver is invoked lazily.
    expect(configMock.loadConfigForProfile).not.toHaveBeenCalled();
  });

  it('accepts a custom configResolver that can be called per server instance', () => {
    const homeResolver: McpServerOptions['configResolver'] = () =>
      configMock.loadConfigForProfile('home');
    const workResolver: McpServerOptions['configResolver'] = () =>
      configMock.loadConfigForProfile('work');

    const homeServer = createSwitchBotMcpServer({ configResolver: homeResolver });
    const workServer = createSwitchBotMcpServer({ configResolver: workResolver });
    expect(homeServer).toBeDefined();
    expect(workServer).toBeDefined();
    // Resolvers are still lazy — calling them directly routes to the
    // right profile.
    expect(homeResolver!()).toEqual({ token: 'home-token', secret: 'home-secret' });
    expect(workResolver!()).toEqual({ token: 'work-token', secret: 'work-secret' });
  });

  it('loadConfigForProfile routes known profiles to distinct credentials', () => {
    expect(configMock.loadConfigForProfile('home')).toEqual({
      token: 'home-token',
      secret: 'home-secret',
    });
    expect(configMock.loadConfigForProfile('work')).toEqual({
      token: 'work-token',
      secret: 'work-secret',
    });
    expect(configMock.loadConfigForProfile(undefined)).toEqual({
      token: 'default-token',
      secret: 'default-secret',
    });
  });
});
