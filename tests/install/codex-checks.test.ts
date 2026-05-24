import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stepRegisterCodexPlugin } from '../../src/install/default-steps.js';
import type { InstallContext } from '../../src/install/default-steps.js';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

const existsSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
const realpathSyncMock = vi.hoisted(() => vi.fn());
const symlinkSyncMock = vi.hoisted(() => vi.fn());
const lstatSyncMock = vi.hoisted(() => vi.fn());
const unlinkSyncMock = vi.hoisted(() => vi.fn());
const mkdirSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({
  default: {
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    realpathSync: realpathSyncMock,
    symlinkSync: symlinkSyncMock,
    lstatSync: lstatSyncMock,
    unlinkSync: unlinkSyncMock,
    mkdirSync: mkdirSyncMock,
  },
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  realpathSync: realpathSyncMock,
  symlinkSync: symlinkSyncMock,
  lstatSync: lstatSyncMock,
  unlinkSync: unlinkSyncMock,
  mkdirSync: mkdirSyncMock,
}));

import {
  checkCodexCli,
  checkCodexPluginNpm,
  checkCodexPluginRegistered,
  runCodexPluginRegistration,
  runCodexPluginRegistrationGit,
  resolveMarketplaceSourceRoot,
  resolvePluginId,
  registerCodexPlugin,
  registerCodexPluginGit,
  registerCodexPluginAuto,
} from '../../src/install/codex-checks.js';

function makeSpawnResult(status: number, stdout: string, stderr = ''): ReturnType<typeof spawnSyncMock> {
  return { status, stdout, stderr, error: undefined } as ReturnType<typeof spawnSyncMock>;
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
  realpathSyncMock.mockReset();
  symlinkSyncMock.mockReset();
  lstatSyncMock.mockReset();
  unlinkSyncMock.mockReset();
  mkdirSyncMock.mockReset();
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
        dependencies: { '@switchbot/codex-plugin': { version: '0.8.2' } }
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
    const msg = String((result.detail as Record<string, unknown>).message);
    expect(msg).toContain('npx @switchbot/openapi-cli codex setup');
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
      .mockReturnValueOnce(makeSpawnResult(0, 'switchbot@codex-plugin  installed, enabled  0.1.0\n')); // codex plugin list
    const result = checkCodexPluginRegistered();
    expect(result.status).toBe('ok');
    expect((result.detail as Record<string, unknown>).pluginName).toContain('switchbot');
  });

  it('returns warn when switchbot is listed but not installed', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/bin/codex\n'))
      .mockReturnValueOnce(makeSpawnResult(0, 'switchbot@codex-plugin  not installed  /tmp/switchbot\n'));
    const result = checkCodexPluginRegistered();
    expect(result.status).toBe('warn');
    expect(String((result.detail as Record<string, unknown>).message)).toContain('not installed');
  });

  it('returns warn when switchbot is not in list', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/bin/codex\n'))
      .mockReturnValueOnce(makeSpawnResult(0, 'some-other-plugin\n'));
    const result = checkCodexPluginRegistered();
    expect(result.status).toBe('warn');
    const msg = String((result.detail as Record<string, unknown>).message);
    expect(msg).toContain('switchbot codex repair');
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
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // plugin remove (current id)
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // plugin remove (legacy id)
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
    expect(result.stage).toBe('marketplace-add');
  });

  it('returns failure when plugin add exits non-zero', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, ''))
      .mockReturnValueOnce(makeSpawnResult(0, ''))                // plugin remove (current id)
      .mockReturnValueOnce(makeSpawnResult(0, ''))                // plugin remove (legacy id)
      .mockReturnValueOnce(makeSpawnResult(1, '', 'plugin add error'));
    const result = runCodexPluginRegistration('/some/path', 'switchbot@pkg');
    expect(result.ok).toBe(false);
    expect(result.stderr).toBe('plugin add error');
    expect(result.stage).toBe('plugin-add');
  });
});

describe('registerCodexPlugin (shared helper)', () => {
  it('returns ok with pluginId and packageRoot when both inner steps succeed', () => {
    existsSyncMock.mockReturnValue(false); // no .codex-plugin/plugin.json
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/lib/node_modules\n')) // npm root -g
      .mockReturnValueOnce(makeSpawnResult(0, ''))                                // marketplace add
      .mockReturnValueOnce(makeSpawnResult(0, ''))                                // plugin remove (current id)
      .mockReturnValueOnce(makeSpawnResult(0, ''))                                // plugin remove (legacy id)
      .mockReturnValueOnce(makeSpawnResult(0, ''));                               // plugin add
    const r = registerCodexPlugin();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pluginId).toBe('switchbot@codex-plugin');
      expect(r.packageRoot).toMatch(/codex-plugin/);
    }
  });

  it('returns failure with normalized error when npm root -g fails', () => {
    spawnSyncMock.mockReturnValueOnce(makeSpawnResult(1, '', 'npm error'));
    const r = registerCodexPlugin();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/npm root -g failed/);
    expect(r.pluginId).toBe('');
    expect(r.packageRoot).toBeNull();
  });

  it('returns failure with normalized error when registration step fails', () => {
    existsSyncMock.mockReturnValue(false);
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/lib/node_modules\n')) // npm root -g
      .mockReturnValueOnce(makeSpawnResult(1, '', 'marketplace add error'));    // marketplace add
    const r = registerCodexPlugin();
    expect(r.ok).toBe(false);
    expect(r.pluginId).toBe('switchbot@codex-plugin');
    expect(r.error).toMatch(/marketplace-add exit 1: marketplace add error/);
    expect(r.exitCode).toBe(1);
  });
});

describe('resolvePluginId', () => {
  it('returns default id when .codex-plugin/plugin.json does not exist', () => {
    existsSyncMock.mockReturnValue(false);
    expect(resolvePluginId('/some/path/codex-plugin')).toBe('switchbot@codex-plugin');
  });

  it('uses plugin.json name when available', () => {
    existsSyncMock.mockImplementation((p: string) => p.endsWith('plugin.json'));
    readFileSyncMock.mockReturnValue('{"name":"myplugin"}');
    expect(resolvePluginId('/some/path/codex-plugin')).toBe('myplugin@codex-plugin');
  });

  it('uses marketplace.json name when available', () => {
    existsSyncMock.mockImplementation((p: string) => p.endsWith('marketplace.json') || p.endsWith('plugin.json'));
    readFileSyncMock.mockImplementation((p: string) => (
      p.endsWith('marketplace.json') ? '{"name":"switchbot-market"}' : '{"name":"myplugin"}'
    ));
    expect(resolvePluginId('/some/path/package-root')).toBe('myplugin@switchbot-market');
  });

  it('falls back to default when plugin.json has no name', () => {
    existsSyncMock.mockImplementation((p: string) => p.endsWith('plugin.json'));
    readFileSyncMock.mockReturnValue('{}');
    expect(resolvePluginId('/some/path/codex-plugin')).toBe('switchbot@codex-plugin');
  });
});

describe('resolveMarketplaceSourceRoot', () => {
  const SCOPED_ROOT = 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@switchbot\\codex-plugin';

  function makeStat(isSymlink: boolean) {
    return { isSymbolicLink: () => isSymlink } as unknown as ReturnType<typeof lstatSyncMock>;
  }

  it('non-Windows or non-scoped paths short-circuit to packageRoot', () => {
    if (process.platform === 'win32') {
      expect(resolveMarketplaceSourceRoot('C:\\plain\\path')).toBe('C:\\plain\\path');
    } else {
      expect(resolveMarketplaceSourceRoot(SCOPED_ROOT)).toBe(SCOPED_ROOT);
    }
    expect(symlinkSyncMock).not.toHaveBeenCalled();
    expect(unlinkSyncMock).not.toHaveBeenCalled();
  });

  it('creates a junction when the alias path is missing', () => {
    if (process.platform !== 'win32') return;
    lstatSyncMock.mockReturnValue(null);
    const resolved = resolveMarketplaceSourceRoot(SCOPED_ROOT);
    expect(mkdirSyncMock).toHaveBeenCalledWith(expect.stringMatching(/switchbot$/), { recursive: true });
    expect(symlinkSyncMock).toHaveBeenCalledWith(SCOPED_ROOT, expect.stringMatching(/codex-plugin-marketplace$/), 'junction');
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    expect(resolved).toMatch(/codex-plugin-marketplace$/);
  });

  it('reuses an existing junction that points at the current packageRoot', () => {
    if (process.platform !== 'win32') return;
    lstatSyncMock.mockReturnValue(makeStat(true));
    realpathSyncMock
      .mockReturnValueOnce(SCOPED_ROOT)  // alias real
      .mockReturnValueOnce(SCOPED_ROOT); // package real
    const resolved = resolveMarketplaceSourceRoot(SCOPED_ROOT);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    expect(symlinkSyncMock).not.toHaveBeenCalled();
    expect(resolved).toMatch(/codex-plugin-marketplace$/);
  });

  it('repairs a stale junction pointing elsewhere', () => {
    if (process.platform !== 'win32') return;
    lstatSyncMock.mockReturnValue(makeStat(true));
    realpathSyncMock
      .mockReturnValueOnce('D:\\old\\node_modules\\@switchbot\\codex-plugin')
      .mockReturnValueOnce(SCOPED_ROOT);
    const resolved = resolveMarketplaceSourceRoot(SCOPED_ROOT);
    expect(unlinkSyncMock).toHaveBeenCalledWith(expect.stringMatching(/codex-plugin-marketplace$/));
    expect(symlinkSyncMock).toHaveBeenCalledWith(SCOPED_ROOT, expect.stringMatching(/codex-plugin-marketplace$/), 'junction');
    expect(resolved).toMatch(/codex-plugin-marketplace$/);
  });

  it('throws when the alias path is a real directory', () => {
    if (process.platform !== 'win32') return;
    lstatSyncMock.mockReturnValue(makeStat(false));
    expect(() => resolveMarketplaceSourceRoot(SCOPED_ROOT)).toThrow(/not a.*junction/i);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    expect(symlinkSyncMock).not.toHaveBeenCalled();
  });
});

// Codex misclassifies local paths containing `@`-scoped npm segments on all
// platforms, not just Windows. The following tests verify that Linux paths like
// `/home/user/.npm-global/lib/node_modules/@switchbot/codex-plugin` also get
// bridged through an alias symlink so the registered path contains no `@`.
describe('resolveMarketplaceSourceRoot — Linux @-scoped path handling', () => {
  const LINUX_SCOPED_ROOT = '/home/user/.npm-global/lib/node_modules/@switchbot/codex-plugin';
  const LINUX_PLAIN_ROOT  = '/home/user/.npm-global/lib/node_modules/switchbot-plugin';

  const savedPlatform = process.platform;
  function makeStat(isSymlink: boolean) {
    return { isSymbolicLink: () => isSymlink } as unknown as ReturnType<typeof lstatSyncMock>;
  }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
  });

  it('returns plain Linux path unchanged (no @-scoped segment)', () => {
    const result = resolveMarketplaceSourceRoot(LINUX_PLAIN_ROOT);
    expect(result).toBe(LINUX_PLAIN_ROOT);
    expect(symlinkSyncMock).not.toHaveBeenCalled();
  });

  it('creates a symlink when alias is missing', () => {
    lstatSyncMock.mockReturnValue(null);
    const result = resolveMarketplaceSourceRoot(LINUX_SCOPED_ROOT);
    expect(mkdirSyncMock).toHaveBeenCalledWith(expect.stringMatching(/switchbot$/), { recursive: true });
    expect(symlinkSyncMock).toHaveBeenCalledWith(
      LINUX_SCOPED_ROOT,
      expect.stringMatching(/codex-plugin-marketplace$/),
      'dir',
    );
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    expect(result).toMatch(/codex-plugin-marketplace$/);
    expect(result).not.toContain('@');
  });

  it('reuses an existing symlink pointing to current packageRoot', () => {
    lstatSyncMock.mockReturnValue(makeStat(true));
    realpathSyncMock
      .mockReturnValueOnce(LINUX_SCOPED_ROOT)
      .mockReturnValueOnce(LINUX_SCOPED_ROOT);
    const result = resolveMarketplaceSourceRoot(LINUX_SCOPED_ROOT);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    expect(symlinkSyncMock).not.toHaveBeenCalled();
    expect(result).toMatch(/codex-plugin-marketplace$/);
  });

  it('repairs a stale symlink pointing elsewhere', () => {
    lstatSyncMock.mockReturnValue(makeStat(true));
    realpathSyncMock
      .mockReturnValueOnce('/old/path/@switchbot/codex-plugin')
      .mockReturnValueOnce(LINUX_SCOPED_ROOT);
    const result = resolveMarketplaceSourceRoot(LINUX_SCOPED_ROOT);
    expect(unlinkSyncMock).toHaveBeenCalledWith(expect.stringMatching(/codex-plugin-marketplace$/));
    expect(symlinkSyncMock).toHaveBeenCalledWith(
      LINUX_SCOPED_ROOT,
      expect.stringMatching(/codex-plugin-marketplace$/),
      'dir',
    );
    expect(result).toMatch(/codex-plugin-marketplace$/);
  });

  it('throws when alias path is a real directory (not a symlink)', () => {
    lstatSyncMock.mockReturnValue(makeStat(false));
    expect(() => resolveMarketplaceSourceRoot(LINUX_SCOPED_ROOT)).toThrow(/not a.*symlink/i);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    expect(symlinkSyncMock).not.toHaveBeenCalled();
  });

  it('aliases a custom-prefix path that has no node_modules segment', () => {
    lstatSyncMock.mockReturnValue(null);
    const customPrefixRoot = '/home/user/.local/lib/@switchbot/codex-plugin';
    const result = resolveMarketplaceSourceRoot(customPrefixRoot);
    expect(symlinkSyncMock).toHaveBeenCalledWith(
      customPrefixRoot,
      expect.stringMatching(/codex-plugin-marketplace$/),
      'dir',
    );
    expect(result).toMatch(/codex-plugin-marketplace$/);
    expect(result).not.toContain('@');
  });
});

describe('runCodexPluginRegistrationGit', () => {
  it('returns ok when marketplace add and plugin add both succeed', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // marketplace add (git)
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // plugin remove (current id)
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // plugin remove (legacy id)
      .mockReturnValueOnce(makeSpawnResult(0, '')); // plugin add
    const r = runCodexPluginRegistrationGit('switchbot@codex-plugin');
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  it('returns failure when marketplace add exits non-zero', () => {
    spawnSyncMock.mockReturnValueOnce(makeSpawnResult(1, '', 'git clone failed'));
    const r = runCodexPluginRegistrationGit('switchbot@codex-plugin');
    expect(r.ok).toBe(false);
    expect(r.stderr).toBe('git clone failed');
    expect(r.stage).toBe('marketplace-add');
  });

  it('returns failure when plugin add exits non-zero', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // marketplace add
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // plugin remove (current id)
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // plugin remove (legacy id)
      .mockReturnValueOnce(makeSpawnResult(1, '', 'plugin add error'));
    const r = runCodexPluginRegistrationGit('switchbot@codex-plugin');
    expect(r.ok).toBe(false);
    expect(r.stderr).toBe('plugin add error');
    expect(r.stage).toBe('plugin-add');
  });

  it('warns to stderr and falls back to 60000 ms when CODEX_MARKETPLACE_ADD_TIMEOUT is "0"', () => {
    const origEnv = process.env['CODEX_MARKETPLACE_ADD_TIMEOUT'];
    process.env['CODEX_MARKETPLACE_ADD_TIMEOUT'] = '0';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSyncMock.mockReturnValueOnce(makeSpawnResult(1, '', 'fail'));
    runCodexPluginRegistrationGit('switchbot@codex-plugin');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('CODEX_MARKETPLACE_ADD_TIMEOUT'));
    spy.mockRestore();
    if (origEnv === undefined) delete process.env['CODEX_MARKETPLACE_ADD_TIMEOUT'];
    else process.env['CODEX_MARKETPLACE_ADD_TIMEOUT'] = origEnv;
  });

  it('does not warn when CODEX_MARKETPLACE_ADD_TIMEOUT is unset', () => {
    const origEnv = process.env['CODEX_MARKETPLACE_ADD_TIMEOUT'];
    delete process.env['CODEX_MARKETPLACE_ADD_TIMEOUT'];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSyncMock.mockReturnValueOnce(makeSpawnResult(1, '', 'fail'));
    runCodexPluginRegistrationGit('switchbot@codex-plugin');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    if (origEnv !== undefined) process.env['CODEX_MARKETPLACE_ADD_TIMEOUT'] = origEnv;
  });

  it('warns to stderr when CODEX_MARKETPLACE_ADD_TIMEOUT is empty string', () => {
    const origEnv = process.env['CODEX_MARKETPLACE_ADD_TIMEOUT'];
    process.env['CODEX_MARKETPLACE_ADD_TIMEOUT'] = '';
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    spawnSyncMock.mockReturnValueOnce(makeSpawnResult(1, '', 'fail'));
    runCodexPluginRegistrationGit('switchbot@codex-plugin');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('CODEX_MARKETPLACE_ADD_TIMEOUT'));
    spy.mockRestore();
    if (origEnv === undefined) delete process.env['CODEX_MARKETPLACE_ADD_TIMEOUT'];
    else process.env['CODEX_MARKETPLACE_ADD_TIMEOUT'] = origEnv;
  });
});

describe('registerCodexPluginAuto', () => {
  it('returns git result when Route B succeeds', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // marketplace add (git)
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // plugin remove (current id)
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // plugin remove (legacy id)
      .mockReturnValueOnce(makeSpawnResult(0, '')); // plugin add
    const r = registerCodexPluginAuto();
    expect(r.ok).toBe(true);
    expect(r.packageRoot).toBeNull();
  });

  it('falls back to local npm path when Route B fails', () => {
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(1, '', 'git clone failed')) // marketplace add (git) — fails
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/lib/node_modules\n', '')) // npm root -g
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // marketplace add (local)
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // plugin remove (current id)
      .mockReturnValueOnce(makeSpawnResult(0, ''))  // plugin remove (legacy id)
      .mockReturnValueOnce(makeSpawnResult(0, '')); // plugin add
    const r = registerCodexPluginAuto();
    expect(r.ok).toBe(true);
    expect(r.packageRoot).toMatch(/codex-plugin/);
  });

  it('installs on demand and retries Route A when Route B and initial Route A both fail', () => {
    existsSyncMock.mockReturnValue(true);
    const installedJson = JSON.stringify({ dependencies: { '@switchbot/codex-plugin': { version: '1.0.0' } } });
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(1, '', 'git clone failed'))               // marketplace add (git) — fails
      .mockReturnValueOnce(makeSpawnResult(1, '', 'npm root error'))                 // npm root -g fails (Route A)
      .mockReturnValueOnce(makeSpawnResult(1, '{}', ''))                             // npm list -g: not installed
      .mockReturnValueOnce(makeSpawnResult(0, '', ''))                               // npm install -g: succeeds
      .mockReturnValueOnce(makeSpawnResult(0, installedJson, ''))                    // post-install npm list: package found
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/lib/node_modules\n', ''))  // npm root -g (retry)
      .mockReturnValueOnce(makeSpawnResult(0, ''))                                   // marketplace add (local)
      .mockReturnValueOnce(makeSpawnResult(0, ''))                                   // plugin remove (current id)
      .mockReturnValueOnce(makeSpawnResult(0, ''))                                   // plugin remove (legacy id)
      .mockReturnValueOnce(makeSpawnResult(0, ''));                                  // plugin add
    const r = registerCodexPluginAuto();
    expect(r.ok).toBe(true);
    expect(r.packageRoot).toMatch(/codex-plugin/);
  });

  it('returns failure when Route B fails, Route A fails, and on-demand install also fails', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(1, '', 'git clone failed')) // marketplace add (git) — fails
      .mockReturnValueOnce(makeSpawnResult(1, '', 'npm root error'))   // npm root -g fails (Route A)
      .mockReturnValueOnce(makeSpawnResult(1, '{}', ''))               // npm list -g: not installed
      .mockReturnValueOnce(makeSpawnResult(1, '', 'EACCES'));          // npm install -g: fails
    const r = registerCodexPluginAuto();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/git clone failed/);
    expect(r.error).toMatch(/npm root error/);
    expect(r.error).toMatch(/EACCES/);
  });

  it('returns failure when on-demand install succeeds but Route A retry still fails', () => {
    const installedJson = JSON.stringify({ dependencies: { '@switchbot/codex-plugin': { version: '1.0.0' } } });
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(1, '', 'git clone failed')) // marketplace add (git) — fails
      .mockReturnValueOnce(makeSpawnResult(1, '', 'npm root error'))   // npm root -g fails (Route A)
      .mockReturnValueOnce(makeSpawnResult(1, '{}', ''))               // npm list -g: not installed
      .mockReturnValueOnce(makeSpawnResult(0, '', ''))                 // npm install -g: succeeds
      .mockReturnValueOnce(makeSpawnResult(0, installedJson, ''))      // post-install npm list: package found
      .mockReturnValueOnce(makeSpawnResult(1, '', 'npm root error 2')); // npm root -g fails (retry)
    const r = registerCodexPluginAuto();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/git clone failed/);
    expect(r.error).toMatch(/npm root error 2/);
  });

  it('skips npm install when npm list output has non-JSON warning prefix (Windows behavior)', () => {
    const npmListWithWarnings =
      'npm warn config optional\nnpm warn config another\n' +
      '{"dependencies":{"@switchbot/codex-plugin":{"version":"1.0.0"}}}';
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(1, '', 'git clone failed'))          // Route B fails
      .mockReturnValueOnce(makeSpawnResult(1, '', 'npm root error'))             // Route A fails
      .mockReturnValueOnce(makeSpawnResult(0, npmListWithWarnings, ''))          // npm list → found
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/lib/node_modules\n'))  // npm root -g retry
      .mockReturnValueOnce(makeSpawnResult(0, ''))                               // marketplace add (local)
      .mockReturnValueOnce(makeSpawnResult(0, ''))                               // plugin remove (current id)
      .mockReturnValueOnce(makeSpawnResult(0, ''))                               // plugin remove (legacy id)
      .mockReturnValueOnce(makeSpawnResult(0, ''));                              // plugin add
    const r = registerCodexPluginAuto();
    // npm install -g must NOT have been called
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    const installCall = calls.find(([cmd, args]) => cmd === 'npm' && args.includes('install'));
    expect(installCall).toBeUndefined();
    expect(r.ok).toBe(true);
  });
  it('skips npm install when npm list exits non-zero but JSON output shows package is installed', () => {
    const installedJson = JSON.stringify({ dependencies: { '@switchbot/codex-plugin': { version: '1.0.0' } } });
    existsSyncMock.mockReturnValue(true);
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(1, '', 'git clone failed'))          // Route B fails
      .mockReturnValueOnce(makeSpawnResult(1, '', 'npm root error'))             // Route A fails
      .mockReturnValueOnce(makeSpawnResult(1, installedJson, 'peer-dep warning')) // npm list exits 1 but JSON shows package
      .mockReturnValueOnce(makeSpawnResult(0, '/usr/local/lib/node_modules\n'))  // npm root -g retry
      .mockReturnValueOnce(makeSpawnResult(0, ''))                               // marketplace add (local)
      .mockReturnValueOnce(makeSpawnResult(0, ''))                               // plugin remove (current id)
      .mockReturnValueOnce(makeSpawnResult(0, ''))                               // plugin remove (legacy id)
      .mockReturnValueOnce(makeSpawnResult(0, ''));                              // plugin add
    const r = registerCodexPluginAuto();
    const calls = spawnSyncMock.mock.calls as [string, string[]][];
    const installCall = calls.find(([cmd, args]) => cmd === 'npm' && args.includes('install'));
    expect(installCall).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it('returns npm-prefix-mismatch error when post-install npm list still shows package absent', () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(1, '', 'git clone failed'))          // Route B fails
      .mockReturnValueOnce(makeSpawnResult(1, '', 'npm root error'))             // Route A fails
      .mockReturnValueOnce(makeSpawnResult(1, '{}', ''))                        // npm list: not installed
      .mockReturnValueOnce(makeSpawnResult(0, '', ''))                          // npm install -g: succeeds
      .mockReturnValueOnce(makeSpawnResult(1, '{}', 'peer-dep-warning'));       // post-install npm list: still absent
    const r = registerCodexPluginAuto();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/npm prefix mismatch/i);
  });
});

describe('stepRegisterCodexPlugin', () => {
  function makeCtx(overrides: Partial<InstallContext> = {}): InstallContext {
    return {
      profile: 'default',
      agent: 'codex',
      policyPath: '/tmp/policy.yaml',
      nonInteractive: true,
      ...overrides,
    };
  }

  it('sets codexPluginRegistered and codexPluginIdentifier on success', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })  // marketplace add (git)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })  // plugin remove (current id)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })  // plugin remove (legacy id)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' }); // plugin add
    const step = stepRegisterCodexPlugin();
    const ctx = makeCtx();
    await step.execute(ctx);
    expect(ctx.codexPluginRegistered).toBe(true);
    expect(ctx.codexPluginIdentifier).toBe('switchbot@codex-plugin');
  });

  it('throws when runCodexPluginRegistration fails', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'marketplace error' }) // marketplace add (git) — Route B fails
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'npm root error' })    // npm root -g — Route A fails
      .mockReturnValueOnce({ status: 1, stdout: '{}', stderr: '' })                // npm list -g: not installed
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'EACCES' });           // npm install -g: fails (on-demand)
    const step = stepRegisterCodexPlugin();
    const ctx = makeCtx();
    await expect(step.execute(ctx)).rejects.toThrow('Codex plugin registration failed');
  });

  it('undo calls codex plugin remove when codexPluginIdentifier is set', async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    const step = stepRegisterCodexPlugin();
    const ctx = makeCtx({ codexPluginIdentifier: 'switchbot@codex-plugin' });
    await step.undo(ctx);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'codex',
      ['plugin', 'remove', 'switchbot@codex-plugin'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('undo is a no-op when codexPluginIdentifier is not set', async () => {
    const step = stepRegisterCodexPlugin();
    const ctx = makeCtx();
    await step.undo(ctx);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
