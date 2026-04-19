import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configMock = vi.hoisted(() => ({
  saveConfig: vi.fn(),
  showConfig: vi.fn(),
  listProfiles: vi.fn(() => [] as string[]),
}));

vi.mock('../../src/config.js', () => configMock);

import { registerConfigCommand } from '../../src/commands/config.js';
import { runCli, parseEnvelope } from '../helpers/cli.js';

describe('config command', () => {
  beforeEach(() => {
    configMock.saveConfig.mockReset();
    configMock.showConfig.mockReset();
    configMock.listProfiles.mockReset();
    configMock.listProfiles.mockReturnValue([]);
  });

  describe('set-token', () => {
    it('calls saveConfig with positional token and secret', async () => {
      const res = await runCli(registerConfigCommand, ['config', 'set-token', 'MY_T', 'MY_S']);
      expect(configMock.saveConfig).toHaveBeenCalledWith('MY_T', 'MY_S');
      expect(res.stdout.join('\n')).toContain('Credentials saved');
    });

    it('fails when token is missing (no positional, no --from-*)', async () => {
      const res = await runCli(registerConfigCommand, ['config', 'set-token']);
      expect(configMock.saveConfig).not.toHaveBeenCalled();
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n').toLowerCase()).toMatch(/missing token\/secret/);
    });

    it('fails when secret is missing', async () => {
      const res = await runCli(registerConfigCommand, ['config', 'set-token', 'only-token']);
      expect(configMock.saveConfig).not.toHaveBeenCalled();
      expect(res.exitCode).toBe(2);
      expect(res.stderr.join('\n').toLowerCase()).toMatch(/missing token\/secret/);
    });
  });

  describe('show', () => {
    it('delegates to showConfig()', async () => {
      await runCli(registerConfigCommand, ['config', 'show']);
      expect(configMock.showConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe('list-profiles', () => {
    it('prints each profile on its own line', async () => {
      configMock.listProfiles.mockReturnValue(['home', 'work']);
      const res = await runCli(registerConfigCommand, ['config', 'list-profiles']);
      expect(res.stdout.join('\n')).toContain('home');
      expect(res.stdout.join('\n')).toContain('work');
    });

    it('prints a helpful message when no profiles exist', async () => {
      configMock.listProfiles.mockReturnValue([]);
      const res = await runCli(registerConfigCommand, ['config', 'list-profiles']);
      expect(res.stdout.join('\n').toLowerCase()).toContain('no profiles');
    });

    it('emits JSON with --json', async () => {
      configMock.listProfiles.mockReturnValue(['home']);
      const res = await runCli(registerConfigCommand, ['--json', 'config', 'list-profiles']);
      const out = parseEnvelope(res.stdout.filter((l) => l.trim().startsWith('{')).join('')) as any;
      expect(out.profiles).toEqual(['home']);
    });
  });

  describe('set-token --from-env-file', () => {
    it('reads SWITCHBOT_TOKEN / SWITCHBOT_SECRET from a .env file', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbenv-'));
      const envFile = path.join(dir, '.env');
      fs.writeFileSync(
        envFile,
        '# comment\nSWITCHBOT_TOKEN=env_tok_abc\nSWITCHBOT_SECRET="env_sec_xyz"\nUNRELATED=ignored\n',
      );
      const res = await runCli(registerConfigCommand, [
        'config', 'set-token', '--from-env-file', envFile,
      ]);
      expect(configMock.saveConfig).toHaveBeenCalledWith('env_tok_abc', 'env_sec_xyz');
      expect(res.stdout.join('\n')).toContain('Credentials saved');
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('fails with exit 2 when the env file does not exist', async () => {
      const res = await runCli(registerConfigCommand, [
        'config', 'set-token', '--from-env-file', '/nonexistent/path/.env',
      ]);
      expect(res.exitCode).toBe(2);
      expect(configMock.saveConfig).not.toHaveBeenCalled();
    });

    it('fails with exit 2 when env file has neither var', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbenv-'));
      const envFile = path.join(dir, '.env');
      fs.writeFileSync(envFile, 'OTHER=foo\n');
      const res = await runCli(registerConfigCommand, [
        'config', 'set-token', '--from-env-file', envFile,
      ]);
      expect(res.exitCode).toBe(2);
      expect(configMock.saveConfig).not.toHaveBeenCalled();
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
