import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configMock = vi.hoisted(() => ({
  saveConfig: vi.fn(),
  showConfig: vi.fn(),
  getConfigSummary: vi.fn(() => ({ source: 'none' })),
  listProfiles: vi.fn(() => [] as string[]),
  readProfileMeta: vi.fn(() => null),
}));

vi.mock('../../src/config.js', () => configMock);

import { registerConfigCommand } from '../../src/commands/config.js';
import { runCli } from '../helpers/cli.js';

describe('config command', () => {
  beforeEach(() => {
    configMock.saveConfig.mockReset();
    configMock.showConfig.mockReset();
    configMock.getConfigSummary.mockReset();
    configMock.getConfigSummary.mockReturnValue({ source: 'none' });
    configMock.listProfiles.mockReset();
    configMock.listProfiles.mockReturnValue([]);
  });

  describe('set-token', () => {
    it('calls saveConfig with positional token and secret', async () => {
      const res = await runCli(registerConfigCommand, ['config', 'set-token', 'MY_T', 'MY_S']);
      expect(configMock.saveConfig).toHaveBeenCalledWith('MY_T', 'MY_S', expect.any(Object));
      expect(res.stdout.join('\n')).toContain('Credentials saved');
    });

    it('warns on stderr when positional token/secret are passed', async () => {
      const res = await runCli(registerConfigCommand, ['config', 'set-token', 'MY_T', 'MY_S']);
      expect(res.stderr.join('\n').toLowerCase()).toMatch(/discouraged/);
    });

    it('scrubs token/secret out of process.argv before saveConfig runs', async () => {
      let argvAtCallTime: string[] = [];
      configMock.saveConfig.mockImplementation(() => {
        argvAtCallTime = [...process.argv];
      });
      await runCli(registerConfigCommand, ['config', 'set-token', 'RAW_TOK', 'RAW_SEC']);
      expect(argvAtCallTime).not.toContain('RAW_TOK');
      expect(argvAtCallTime).not.toContain('RAW_SEC');
      expect(argvAtCallTime.filter((a) => a === '***').length).toBeGreaterThanOrEqual(2);
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

    it('emits structured JSON in --json mode', async () => {
      configMock.getConfigSummary.mockReturnValue({
        source: 'file',
        path: '/tmp/config.json',
        token: 'abcd****wxyz',
        secret: 'ab****yz',
      });
      const res = await runCli(registerConfigCommand, ['--json', 'config', 'show']);
      const parsed = JSON.parse(res.stdout.join('\n'));
      expect(parsed.data.source).toBe('file');
      expect(parsed.data.path).toBe('/tmp/config.json');
      expect(parsed.data.token).toBe('abcd****wxyz');
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
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      expect(out.data.profiles).toEqual([{ name: 'home' }]);
    });

    it('C5: surfaces label and dailyCap when present', async () => {
      configMock.listProfiles.mockReturnValue(['home']);
      configMock.readProfileMeta.mockImplementation((p: string) =>
        p === 'home' ? { label: 'Home Account', limits: { dailyCap: 500 }, path: '/x' } : null,
      );
      const res = await runCli(registerConfigCommand, ['config', 'list-profiles']);
      const combined = res.stdout.join('\n');
      expect(combined).toContain('Home Account');
      expect(combined).toContain('dailyCap=500');
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
      expect(configMock.saveConfig).toHaveBeenCalledWith('env_tok_abc', 'env_sec_xyz', expect.any(Object));
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

  describe('agent-profile', () => {
    let tmpHome: string;
    let homedirSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sbagent-'));
      homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    });

    afterEach(() => {
      homedirSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it('emits the template as JSON without --write', async () => {
      const res = await runCli(registerConfigCommand, ['--json', 'config', 'agent-profile']);
      expect(res.exitCode).toBeNull();
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      const tpl = out.data ?? out;
      expect(tpl.label).toBe('agent');
      expect(tpl.limits.dailyCap).toBe(100);
      expect(tpl.defaults.auditLog).toBe(true);
    });

    it('prints JSON to stdout in text mode without --write', async () => {
      const res = await runCli(registerConfigCommand, ['config', 'agent-profile']);
      expect(res.exitCode).toBeNull();
      const combined = res.stdout.join('\n');
      expect(combined).toContain('"label": "agent"');
      expect(combined).toContain('"dailyCap": 100');
    });

    it('--write creates ~/.switchbot/profiles/agent.json with mode 0600', async () => {
      const res = await runCli(registerConfigCommand, ['config', 'agent-profile', '--write']);
      expect(res.exitCode).toBeNull();
      const dest = path.join(tmpHome, '.switchbot', 'profiles', 'agent.json');
      expect(fs.existsSync(dest)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(dest, 'utf-8'));
      expect(parsed.label).toBe('agent');
      expect(parsed.limits.dailyCap).toBe(100);
      expect(res.stdout.join('\n')).toContain('agent.json');
    });

    it('--write refuses to overwrite without --force (exit 2)', async () => {
      const dest = path.join(tmpHome, '.switchbot', 'profiles', 'agent.json');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, '{"original":true}', 'utf-8');

      const res = await runCli(registerConfigCommand, ['config', 'agent-profile', '--write']);
      expect(res.exitCode).toBe(2);
      expect(JSON.parse(fs.readFileSync(dest, 'utf-8'))).toEqual({ original: true });
    });

    it('--write --force overwrites an existing agent.json', async () => {
      const dest = path.join(tmpHome, '.switchbot', 'profiles', 'agent.json');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, '{"original":true}', 'utf-8');

      const res = await runCli(registerConfigCommand, ['config', 'agent-profile', '--write', '--force']);
      expect(res.exitCode).toBeNull();
      const parsed = JSON.parse(fs.readFileSync(dest, 'utf-8'));
      expect(parsed.label).toBe('agent');
    });

    it('--write --json returns ok:true with path and template', async () => {
      const res = await runCli(registerConfigCommand, ['--json', 'config', 'agent-profile', '--write']);
      expect(res.exitCode).toBeNull();
      const out = JSON.parse(res.stdout.filter((l) => l.trim().startsWith('{')).join(''));
      expect(out.data.ok).toBe(true);
      expect(typeof out.data.path).toBe('string');
      expect(out.data.template.label).toBe('agent');
    });
  });
});
