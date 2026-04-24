import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';

const FAKE_HOME = '/fake/home';
const CONFIG_DIR = path.join(FAKE_HOME, '.switchbot');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => [] as string[]),
}));
const osMock = vi.hoisted(() => ({
  homedir: vi.fn(() => '/fake/home'),
}));

vi.mock('node:fs', () => ({ default: fsMock, ...fsMock }));
vi.mock('node:os', () => ({ default: osMock, ...osMock }));

import { loadConfig, saveConfig, showConfig, listProfiles, tryLoadConfig } from '../src/config.js';
import { __resetPrimedCredentials, primeCredentials } from '../src/credentials/prime.js';

const selectMock = vi.fn();
vi.mock('../src/credentials/keychain.js', async () => {
  const actual = await vi.importActual<typeof import('../src/credentials/keychain.js')>(
    '../src/credentials/keychain.js',
  );
  return {
    ...actual,
    selectCredentialStore: (...args: unknown[]) => selectMock(...args),
  };
});

describe('config', () => {
  beforeEach(() => {
    delete process.env.SWITCHBOT_TOKEN;
    delete process.env.SWITCHBOT_SECRET;
    fsMock.existsSync.mockReset();
    fsMock.readFileSync.mockReset();
    fsMock.writeFileSync.mockReset();
    fsMock.mkdirSync.mockReset();
    fsMock.readdirSync.mockReset();
    fsMock.readdirSync.mockReturnValue([]);
    selectMock.mockReset();
    __resetPrimedCredentials();
  });

  describe('loadConfig', () => {
    it('prefers env vars when both SWITCHBOT_TOKEN and SWITCHBOT_SECRET are set', () => {
      process.env.SWITCHBOT_TOKEN = 'env-token';
      process.env.SWITCHBOT_SECRET = 'env-secret';
      const cfg = loadConfig();
      expect(cfg).toEqual({ token: 'env-token', secret: 'env-secret' });
      expect(fsMock.existsSync).not.toHaveBeenCalled();
      expect(fsMock.readFileSync).not.toHaveBeenCalled();
    });

    it('falls through to file when only SWITCHBOT_TOKEN is set (partial env)', () => {
      process.env.SWITCHBOT_TOKEN = 'env-token';
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 'file-t', secret: 'file-s' }));
      expect(loadConfig()).toEqual({ token: 'file-t', secret: 'file-s' });
    });

    it('falls through to file when only SWITCHBOT_SECRET is set', () => {
      process.env.SWITCHBOT_SECRET = 'env-secret';
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 'file-t', secret: 'file-s' }));
      expect(loadConfig()).toEqual({ token: 'file-t', secret: 'file-s' });
    });

    it('returns file contents when valid JSON with token + secret is present', () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 't1', secret: 's1' }));
      expect(loadConfig()).toEqual({ token: 't1', secret: 's1' });
      expect(fsMock.readFileSync).toHaveBeenCalledWith(CONFIG_FILE, 'utf-8');
    });

    it('exits(1) with guidance when neither env nor file is configured', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('__exit');
      });
      fsMock.existsSync.mockReturnValue(false);

      expect(() => loadConfig()).toThrow('__exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('switchbot config set-token')
      );
      expect(errSpy.mock.calls[0][0]).toContain('SWITCHBOT_TOKEN');
    });

    it('exits(1) when config file has invalid JSON', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('__exit');
      });
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('{ not valid json');

      expect(() => loadConfig()).toThrow('__exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to read config file'));
    });

    it('exits(1) when JSON parses but token is missing', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('__exit');
      });
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ secret: 'only-secret' }));

      expect(() => loadConfig()).toThrow('__exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid config format'));
    });

    it('exits(1) when JSON parses but secret is missing', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('__exit');
      });
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 'only-token' }));

      expect(() => loadConfig()).toThrow('__exit');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid config format'));
    });
  });

  describe('saveConfig', () => {
    it('creates the config directory when missing (recursive mkdir)', () => {
      fsMock.existsSync.mockReturnValue(false);
      saveConfig('t', 's');
      expect(fsMock.mkdirSync).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
    });

    it('does NOT mkdir when the directory already exists', () => {
      fsMock.existsSync.mockReturnValue(true);
      saveConfig('t', 's');
      expect(fsMock.mkdirSync).not.toHaveBeenCalled();
    });

    it('writes JSON with 0o600 permissions', () => {
      fsMock.existsSync.mockReturnValue(true);
      saveConfig('my-token', 'my-secret');
      expect(fsMock.writeFileSync).toHaveBeenCalledWith(
        CONFIG_FILE,
        JSON.stringify({ token: 'my-token', secret: 'my-secret' }, null, 2),
        { mode: 0o600 }
      );
    });
  });

  describe('showConfig', () => {
    it('reports env source and masks the secret when env vars are set', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      process.env.SWITCHBOT_TOKEN = 'env-token';
      process.env.SWITCHBOT_SECRET = 'abcdefgh';

      showConfig();
      const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('Credential source: environment variables');
      expect(output).toMatch(/token : env-\*+oken/);
      expect(output).not.toContain('env-token');
      expect(output).toContain('ab****gh');
      expect(output).not.toContain('abcdefgh');
    });

    it('reports file source when only the file is configured', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 'file-token', secret: 'longsecretvalue' }));

      showConfig();
      const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain(`Credential source: ${CONFIG_FILE}`);
      expect(output).toMatch(/token : file\*+oken/);
      expect(output).not.toContain('file-token');
      expect(output).toMatch(/secret: lo\*+ue/);
    });

    it('says "No credentials configured" when nothing is set', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fsMock.existsSync.mockReturnValue(false);

      showConfig();
      expect(logSpy).toHaveBeenCalledWith('No credentials configured');
    });

    it('prints read error without throwing when file content is unreadable', () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });

      expect(() => showConfig()).not.toThrow();
      expect(errSpy).toHaveBeenCalledWith('Failed to read config file');
    });

    it('masks short secrets as **** (length <= 4)', () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      process.env.SWITCHBOT_TOKEN = 't';
      process.env.SWITCHBOT_SECRET = 'abcd';

      showConfig();
      const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain('secret: ****');
      expect(output).not.toContain('abcd');
    });
  });

  describe('--config <path> override', () => {
    const originalArgv = process.argv;

    afterEach(() => {
      process.argv = originalArgv;
    });

    it('loadConfig reads from the overridden path (absolute)', () => {
      process.argv = ['node', 'cli', '--config', '/custom/path.json'];
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 'x', secret: 'y' }));

      const cfg = loadConfig();

      expect(cfg).toEqual({ token: 'x', secret: 'y' });
      const readPath = fsMock.readFileSync.mock.calls[0][0] as string;
      expect(path.resolve(readPath)).toBe(path.resolve('/custom/path.json'));
    });

    it('saveConfig writes to the overridden path and creates its directory', () => {
      process.argv = ['node', 'cli', '--config', '/custom/nested/cfg.json'];
      fsMock.existsSync.mockReturnValue(false);

      saveConfig('tok', 'sec');

      expect(fsMock.mkdirSync).toHaveBeenCalledWith(
        path.resolve('/custom/nested'),
        { recursive: true }
      );
      const writePath = fsMock.writeFileSync.mock.calls[0][0] as string;
      expect(path.resolve(writePath)).toBe(path.resolve('/custom/nested/cfg.json'));
    });

    it('showConfig reports the overridden path as the credential source', () => {
      process.argv = ['node', 'cli', '--config', '/custom/cfg.json'];
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 'T', secret: 'abcdef' }));

      showConfig();

      const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(output).toContain(path.resolve('/custom/cfg.json'));
    });
  });

  describe('--profile <name>', () => {
    const originalArgv = process.argv;
    afterEach(() => {
      process.argv = originalArgv;
    });

    it('loadConfig reads ~/.switchbot/profiles/<name>.json', () => {
      process.argv = ['node', 'cli', '--profile', 'work'];
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 'work-t', secret: 'work-s' }));

      const cfg = loadConfig();

      expect(cfg).toEqual({ token: 'work-t', secret: 'work-s' });
      const readPath = fsMock.readFileSync.mock.calls[0][0] as string;
      expect(readPath).toBe(path.join(FAKE_HOME, '.switchbot', 'profiles', 'work.json'));
    });

    it('saveConfig writes the profile file and creates profiles/ directory', () => {
      process.argv = ['node', 'cli', '--profile', 'home'];
      fsMock.existsSync.mockReturnValue(false);

      saveConfig('t', 's');

      expect(fsMock.mkdirSync).toHaveBeenCalledWith(
        path.join(FAKE_HOME, '.switchbot', 'profiles'),
        { recursive: true },
      );
      const writePath = fsMock.writeFileSync.mock.calls[0][0] as string;
      expect(writePath).toBe(path.join(FAKE_HOME, '.switchbot', 'profiles', 'home.json'));
    });

    it('loadConfig emits a profile-specific hint when the file is missing', () => {
      process.argv = ['node', 'cli', '--profile', 'work'];
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('__exit');
      });
      fsMock.existsSync.mockReturnValue(false);

      expect(() => loadConfig()).toThrow('__exit');
      const msg = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
      expect(msg).toContain('profile "work"');
      expect(msg).toContain('--profile work');
    });

    it('--config beats --profile when both are passed', () => {
      process.argv = ['node', 'cli', '--config', '/override.json', '--profile', 'work'];
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 't', secret: 's' }));

      loadConfig();
      const readPath = fsMock.readFileSync.mock.calls[0][0] as string;
      expect(path.resolve(readPath)).toBe(path.resolve('/override.json'));
    });
  });

  describe('listProfiles', () => {
    it('returns [] when the profiles directory does not exist', () => {
      fsMock.existsSync.mockReturnValue(false);
      expect(listProfiles()).toEqual([]);
    });

    it('returns each .json file without extension, sorted', () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readdirSync.mockReturnValue(['work.json', 'home.json', 'README', 'lab.json']);
      expect(listProfiles()).toEqual(['home', 'lab', 'work']);
    });
  });

  describe('keychain bridge', () => {
    async function primeWith(profile: string, creds: { token: string; secret: string } | null) {
      const get = vi.fn().mockResolvedValue(creds);
      selectMock.mockResolvedValue({ name: 'keychain', get } as unknown);
      await primeCredentials(profile);
    }

    it('loadConfig prefers keychain-primed creds over a present config file', async () => {
      await primeWith('default', { token: 'kc-token', secret: 'kc-secret' });
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 'file-t', secret: 'file-s' }));

      expect(loadConfig()).toEqual({ token: 'kc-token', secret: 'kc-secret' });
      expect(fsMock.readFileSync).not.toHaveBeenCalled();
    });

    it('tryLoadConfig prefers keychain-primed creds over a present config file', async () => {
      await primeWith('default', { token: 'kc-token', secret: 'kc-secret' });
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 'file-t', secret: 'file-s' }));

      expect(tryLoadConfig()).toEqual({ token: 'kc-token', secret: 'kc-secret' });
    });

    it('loadConfig falls back to file when keychain-primed result is null', async () => {
      await primeWith('default', null);
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 'file-t', secret: 'file-s' }));

      expect(loadConfig()).toEqual({ token: 'file-t', secret: 'file-s' });
    });

    it('env vars still beat keychain-primed creds', async () => {
      process.env.SWITCHBOT_TOKEN = 'env-t';
      process.env.SWITCHBOT_SECRET = 'env-s';
      await primeWith('default', { token: 'kc-t', secret: 'kc-s' });

      expect(loadConfig()).toEqual({ token: 'env-t', secret: 'env-s' });
    });

    it('--config <path> override disables the keychain bridge so the file is authoritative', async () => {
      const originalArgv = process.argv;
      try {
        process.argv = ['node', 'cli', '--config', '/override.json'];
        await primeWith('default', { token: 'kc-t', secret: 'kc-s' });
        fsMock.existsSync.mockReturnValue(true);
        fsMock.readFileSync.mockReturnValue(JSON.stringify({ token: 'ov-t', secret: 'ov-s' }));

        expect(loadConfig()).toEqual({ token: 'ov-t', secret: 'ov-s' });
      } finally {
        process.argv = originalArgv;
      }
    });

    it('tryLoadConfig returns null when neither env, keychain, nor file have creds', () => {
      fsMock.existsSync.mockReturnValue(false);
      expect(tryLoadConfig()).toBeNull();
    });
  });
});
