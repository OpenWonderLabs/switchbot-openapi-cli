import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { registerWebhookCommand } from '../../src/commands/webhook.js';
import { runCli } from '../helpers/cli.js';

const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';

describe('webhook command', () => {
  beforeEach(() => {
    apiMock.__instance.get.mockReset();
    apiMock.__instance.post.mockReset();
    apiMock.createClient.mockReset();
    apiMock.createClient.mockImplementation(() => apiMock.__instance);
  });

  describe('setup', () => {
    it('POSTs setupWebhook with deviceList=ALL and prints success', async () => {
      apiMock.__instance.post.mockResolvedValue({ data: {} });
      const res = await runCli(registerWebhookCommand, ['webhook', 'setup', URL_A]);
      expect(apiMock.__instance.post).toHaveBeenCalledWith('/v1.1/webhook/setupWebhook', {
        action: 'setupWebhook',
        url: URL_A,
        deviceList: 'ALL',
      });
      expect(res.stdout.join('\n')).toContain(`Webhook configured: ${URL_A}`);
    });

    it('exits 1 when setup fails', async () => {
      apiMock.__instance.post.mockRejectedValue(new Error('boom'));
      const res = await runCli(registerWebhookCommand, ['webhook', 'setup', URL_A]);
      expect(res.exitCode).toBe(1);
    });

    it('fails when url is missing (commander error)', async () => {
      const res = await runCli(registerWebhookCommand, ['webhook', 'setup']);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      expect(res.stderr.join('\n').toLowerCase()).toContain('missing required');
    });

    it('rejects invalid URL format', async () => {
      const res = await runCli(registerWebhookCommand, ['webhook', 'setup', 'garbage']);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      expect(res.stderr.join('\n')).toMatch(/invalid URL/i);
      expect(res.exitCode).toBe(2);
    });
  });

  describe('query (list URLs)', () => {
    it('lists configured webhook URLs in default mode', async () => {
      apiMock.__instance.post.mockResolvedValue({ data: { body: { urls: [URL_A, URL_B] } } });
      const res = await runCli(registerWebhookCommand, ['webhook', 'query']);
      expect(apiMock.__instance.post).toHaveBeenCalledWith('/v1.1/webhook/queryWebhook', {
        action: 'queryUrl',
      });
      const out = res.stdout.join('\n');
      expect(out).toContain('Configured Webhook URLs:');
      expect(out).toContain(URL_A);
      expect(out).toContain(URL_B);
    });

    it('prints "No webhooks configured" when urls array is empty', async () => {
      apiMock.__instance.post.mockResolvedValue({ data: { body: { urls: [] } } });
      const res = await runCli(registerWebhookCommand, ['webhook', 'query']);
      expect(res.stdout.join('\n')).toContain('No webhooks configured');
    });

    it('handles missing urls field (undefined) without throwing', async () => {
      apiMock.__instance.post.mockResolvedValue({ data: { body: {} } });
      const res = await runCli(registerWebhookCommand, ['webhook', 'query']);
      expect(res.stdout.join('\n')).toContain('No webhooks configured');
    });

    it('in --json mode, outputs raw body', async () => {
      apiMock.__instance.post.mockResolvedValue({ data: { body: { urls: [URL_A] } } });
      const res = await runCli(registerWebhookCommand, ['webhook', 'query', '--json']);
      expect(res.stdout.join('\n')).toContain('"urls"');
    });

    it('exits 1 when the API throws', async () => {
      apiMock.__instance.post.mockRejectedValue(new Error('nope'));
      const res = await runCli(registerWebhookCommand, ['webhook', 'query']);
      expect(res.exitCode).toBe(1);
    });
  });

  describe('query --details', () => {
    it('POSTs queryDetails with the URL and prints key-value rows', async () => {
      apiMock.__instance.post.mockResolvedValue({
        data: {
          body: [
            {
              url: URL_A,
              enable: true,
              deviceList: 'ALL',
              createTime: 1700000000000,
              lastUpdateTime: 1700000123000,
            },
          ],
        },
      });
      const res = await runCli(registerWebhookCommand, ['webhook', 'query', '--details', URL_A]);
      expect(apiMock.__instance.post).toHaveBeenCalledWith('/v1.1/webhook/queryWebhook', {
        action: 'queryDetails',
        urls: [URL_A],
      });
      const out = res.stdout.join('\n');
      expect(out).toContain(URL_A);
      expect(out).toContain('deviceList');
      expect(out).toContain('ALL');
      // timestamps formatted via toLocaleString — don't assert exact format, only that they're not raw ms
      expect(out).not.toContain('1700000000000');
    });

    it('prints "No webhook configuration found" when the API returns an empty array', async () => {
      apiMock.__instance.post.mockResolvedValue({ data: { body: [] } });
      const res = await runCli(registerWebhookCommand, ['webhook', 'query', '--details', URL_A]);
      expect(res.stdout.join('\n')).toContain('No webhook configuration found');
    });

    it('in --json mode, outputs raw array', async () => {
      apiMock.__instance.post.mockResolvedValue({
        data: { body: [{ url: URL_A, enable: true, deviceList: 'ALL', createTime: 1, lastUpdateTime: 2 }] },
      });
      const res = await runCli(registerWebhookCommand, ['webhook', 'query', '--json', '--details', URL_A]);
      expect(res.stdout.join('\n')).toContain(`"url": "${URL_A}"`);
    });
  });

  describe('update', () => {
    it('with --enable, sends enable=true in config and prints "enabled"', async () => {
      apiMock.__instance.post.mockResolvedValue({ data: {} });
      const res = await runCli(registerWebhookCommand, ['webhook', 'update', URL_A, '--enable']);
      expect(apiMock.__instance.post).toHaveBeenCalledWith('/v1.1/webhook/updateWebhook', {
        action: 'updateWebhook',
        config: { url: URL_A, enable: true },
      });
      expect(res.stdout.join('\n')).toContain(`Webhook enabled: ${URL_A}`);
    });

    it('with --disable, sends enable=false and prints "disabled"', async () => {
      apiMock.__instance.post.mockResolvedValue({ data: {} });
      const res = await runCli(registerWebhookCommand, ['webhook', 'update', URL_A, '--disable']);
      expect(apiMock.__instance.post).toHaveBeenCalledWith('/v1.1/webhook/updateWebhook', {
        action: 'updateWebhook',
        config: { url: URL_A, enable: false },
      });
      expect(res.stdout.join('\n')).toContain(`Webhook disabled: ${URL_A}`);
    });

    it('with neither flag, omits enable from config and prints "updated"', async () => {
      apiMock.__instance.post.mockResolvedValue({ data: {} });
      const res = await runCli(registerWebhookCommand, ['webhook', 'update', URL_A]);
      expect(apiMock.__instance.post).toHaveBeenCalledWith('/v1.1/webhook/updateWebhook', {
        action: 'updateWebhook',
        config: { url: URL_A },
      });
      expect(res.stdout.join('\n')).toContain(`Webhook updated: ${URL_A}`);
    });

    it('exits 1 when update fails', async () => {
      apiMock.__instance.post.mockRejectedValue(new Error('update failed'));
      const res = await runCli(registerWebhookCommand, ['webhook', 'update', URL_A, '--enable']);
      expect(res.exitCode).toBe(1);
    });

    it('rejects --enable and --disable together (mutually exclusive)', async () => {
      const res = await runCli(registerWebhookCommand, [
        'webhook', 'update', URL_A, '--enable', '--disable',
      ]);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      expect(res.stderr.join('\n')).toContain('mutually exclusive');
      expect(res.exitCode).toBe(2);
    });

    it('rejects invalid URL format', async () => {
      const res = await runCli(registerWebhookCommand, ['webhook', 'update', 'not-a-url']);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      expect(res.stderr.join('\n')).toMatch(/invalid URL/i);
      expect(res.exitCode).toBe(2);
    });

    it('rejects non-http(s) URL scheme', async () => {
      const res = await runCli(registerWebhookCommand, ['webhook', 'update', 'ftp://example.com/hook']);
      expect(apiMock.__instance.post).not.toHaveBeenCalled();
      expect(res.stderr.join('\n')).toMatch(/http:\/\/ or https:\/\//);
      expect(res.exitCode).toBe(2);
    });
  });

  describe('delete', () => {
    it('POSTs deleteWebhook and prints success', async () => {
      apiMock.__instance.post.mockResolvedValue({ data: {} });
      const res = await runCli(registerWebhookCommand, ['webhook', 'delete', URL_A]);
      expect(apiMock.__instance.post).toHaveBeenCalledWith('/v1.1/webhook/deleteWebhook', {
        action: 'deleteWebhook',
        url: URL_A,
      });
      expect(res.stdout.join('\n')).toContain(`Webhook deleted: ${URL_A}`);
    });

    it('exits 1 when deletion fails', async () => {
      apiMock.__instance.post.mockRejectedValue(new Error('missing'));
      const res = await runCli(registerWebhookCommand, ['webhook', 'delete', URL_A]);
      expect(res.exitCode).toBe(1);
    });
  });
});
