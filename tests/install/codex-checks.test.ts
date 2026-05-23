import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

const existsSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({
  default: { existsSync: existsSyncMock, readFileSync: readFileSyncMock },
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
}));

import {
  checkCodexCli,
  checkCodexPluginNpm,
  checkCodexPluginRegistered,
  runCodexPluginRegistration,
  resolvePluginId,
} from '../../src/install/codex-checks.js';

function makeSpawnResult(status: number, stdout: string, stderr = ''): ReturnType<typeof spawnSyncMock> {
  return { status, stdout, stderr, error: undefined } as ReturnType<typeof spawnSyncMock>;
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
});

describe('checkCodexCli', () => {
  it('returns ok when codex is on PATH and version parses', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/bin/codex\n'))   // which/where
      .mockReturnValueOnce(makeSpawnResult(0, 'codex 1.2.3\n'));            // codex --version
    const result = checkCodexCli();
    expect(result.status).toBe('ok');
    expect((result.detail as Record<string, unknown>).path).toBe('/usr/local/bin/codex');
    expect((result.detail as Record<string, unknown>).version).toBe('codex 1.2.3');
  });

  it('returns fail when codex is not on PATH', () => {
    spawnSyncMock.mockReturnValueOnce(makeSpawnResult(1, '', 'not found'));
    const result = checkCodexCli();
    expect(result.status).toBe('fail');
    expect((result.detail as Record<string, unknown>).message).toContain('not found on PATH');
  });
});

describe('checkCodexPluginNpm', () => {
  it('returns ok when package is installed globally', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, JSON.stringify({
        dependencies: { '@cly-org/switchbot-codex-plugin': { version: '0.8.2' } }
      })))
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/lib/node_modules\n')); // npm root -g
    const result = checkCodexPluginNpm();
    expect(result.status).toBe('ok');
    expect((result.detail as Record<string, unknown>).version).toBe('0.8.2');
  });

  it('returns warn when package is not in npm list output', () => {
    spawnSyncMock.mockReturnValueOnce(makeSpawnResult(1, '{}', ''));
    const result = checkCodexPluginNpm();
    expect(result.status).toBe('warn');
    expect((result.detail as Record<string, unknown>).message).toContain('switchbot install --agent codex');
  });

  it('returns warn when npm list json is malformed', () => {
    spawnSyncMock.mockReturnValueOnce(makeSpawnResult(0, 'not-json'));
    const result = checkCodexPluginNpm();
    expect(result.status).toBe('warn');
  });
});

describe('checkCodexPluginRegistered', () => {
  it('returns ok when switchbot appears in codex plugin list', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/bin/codex\n'))  // which codex
      .mockReturnValueOnce(makeSpawnResult(0, 'switchbot@switchbot-codex-plugin\n')); // codex plugin list
    const result = checkCodexPluginRegistered();
    expect(result.status).toBe('ok');
    expect((result.detail as Record<string, unknown>).pluginName).toContain('switchbot');
  });

  it('returns warn when switchbot is not in list', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/bin/codex\n'))
      .mockReturnValueOnce(makeSpawnResult(0, 'some-other-plugin\n'));
    const result = checkCodexPluginRegistered();
    expect(result.status).toBe('warn');
    expect((result.detail as Record<string, unknown>).message).toContain('switchbot install --agent codex');
  });

  it('returns warn with reason codex-cli-missing when codex is not on PATH', () => {
    spawnSyncMock.mockReturnValueOnce(makeSpawnResult(1, '', 'not found')); // which codex fails
    const result = checkCodexPluginRegistered();
    expect(result.status).toBe('warn');
    expect((result.detail as Record<string, unknown>).reason).toBe('codex-cli-missing');
  });

  it('returns warn when codex plugin list fails', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/bin/codex\n'))
      .mockReturnValueOnce(makeSpawnResult(1, '', 'error'));
    const result = checkCodexPluginRegistered();
    expect(result.status).toBe('warn');
  });
});

describe('runCodexPluginRegistration', () => {
  it('returns ok when both marketplace add and plugin add succeed', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // marketplace add
      .mockReturnValueOnce(makeSpawnResult(0, '')); // plugin add
    const result = runCodexPluginRegistration('/some/path', 'switchbot@pkg');
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('returns failure when marketplace add exits non-zero', () => {
    spawnSyncMock.mockReturnValueOnce(makeSpawnResult(1, '', 'marketplace error'));
    const result = runCodexPluginRegistration('/some/path', 'switchbot@pkg');
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('marketplace error');
  });

  it('returns failure when plugin add exits non-zero', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, ''))
      .mockReturnValueOnce(makeSpawnResult(1, '', 'plugin add error'));
    const result = runCodexPluginRegistration('/some/path', 'switchbot@pkg');
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('plugin add error');
  });
});

describe('resolvePluginId', () => {
  it('returns default id when .codex-plugin/plugin.json does not exist', () => {
    existsSyncMock.mockReturnValue(false);
    expect(resolvePluginId('/some/path/switchbot-codex-plugin')).toBe('switchbot@switchbot-codex-plugin');
  });

  it('uses plugin.json name when available', () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue('{"name":"myplugin"}');
    expect(resolvePluginId('/some/path/switchbot-codex-plugin')).toBe('myplugin@switchbot-codex-plugin');
  });

  it('falls back to default when plugin.json has no name', () => {
    existsSyncMock.mockReturnValue(true);
    readFileSyncMock.mockReturnValue('{}');
    expect(resolvePluginId('/some/path/switchbot-codex-plugin')).toBe('switchbot@switchbot-codex-plugin');
  });
});
