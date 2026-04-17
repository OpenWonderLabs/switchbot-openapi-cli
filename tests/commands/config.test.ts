import { describe, it, expect, vi, beforeEach } from 'vitest';

const configMock = vi.hoisted(() => ({
  saveConfig: vi.fn(),
  showConfig: vi.fn(),
}));

vi.mock('../../src/config.js', () => configMock);

import { registerConfigCommand } from '../../src/commands/config.js';
import { runCli } from '../helpers/cli.js';

describe('config command', () => {
  beforeEach(() => {
    configMock.saveConfig.mockReset();
    configMock.showConfig.mockReset();
  });

  describe('set-token', () => {
    it('calls saveConfig with positional token and secret', async () => {
      const res = await runCli(registerConfigCommand, ['config', 'set-token', 'MY_T', 'MY_S']);
      expect(configMock.saveConfig).toHaveBeenCalledWith('MY_T', 'MY_S');
      expect(res.stdout.join('\n')).toContain('Credentials saved');
    });

    it('fails when token is missing (commander error)', async () => {
      const res = await runCli(registerConfigCommand, ['config', 'set-token']);
      expect(configMock.saveConfig).not.toHaveBeenCalled();
      expect(res.stderr.join('\n').toLowerCase()).toContain('missing required');
    });

    it('fails when secret is missing', async () => {
      const res = await runCli(registerConfigCommand, ['config', 'set-token', 'only-token']);
      expect(configMock.saveConfig).not.toHaveBeenCalled();
      expect(res.stderr.join('\n').toLowerCase()).toContain('missing required');
    });
  });

  describe('show', () => {
    it('delegates to showConfig()', async () => {
      await runCli(registerConfigCommand, ['config', 'show']);
      expect(configMock.showConfig).toHaveBeenCalledTimes(1);
    });
  });
});
