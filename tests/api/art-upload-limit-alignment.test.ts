import { afterEach, describe, expect, it, vi } from 'vitest';
import axios, { type AxiosAdapter } from 'axios';
import { ApiError, createClient } from '../../src/api/client.js';
import { executeCommand } from '../../src/lib/devices.js';

const originalArgv = process.argv;
const originalAdapter = axios.defaults.adapter;

afterEach(() => {
  process.argv = originalArgv;
  axios.defaults.adapter = originalAdapter;
  vi.unstubAllEnvs();
});

function createTestClient(adapter: AxiosAdapter) {
  vi.stubEnv('SWITCHBOT_TOKEN', 'test-only-token');
  vi.stubEnv('SWITCHBOT_SECRET', 'test-only-secret');
  process.argv = ['node', 'switchbot', '--no-quota', '--no-retry'];
  axios.defaults.adapter = adapter;
  return createClient();
}

async function captureApiError(action: () => Promise<unknown>): Promise<ApiError> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error('Expected the request to reject with an ApiError');
}

describe('AI Art Frame upload limit alignment', () => {
  it('preserves the provider message for an uploadImage quota error', async () => {
    const providerMessage = 'Artwork allowance exhausted for this billing period';
    let requestBody: unknown;
    const client = createTestClient(async (config) => {
      requestBody = JSON.parse(String(config.data));
      return {
        status: 200, statusText: 'OK', headers: {}, config,
        data: { statusCode: 402, message: providerMessage },
      };
    });

    const error = await captureApiError(() => executeCommand(
      'ART-LUMA-1', 'uploadImage', { imageUrl: 'https://example.test/art.jpg' }, 'command', client,
    ));

    expect(requestBody).toEqual({
      command: 'uploadImage',
      parameter: { imageUrl: 'https://example.test/art.jpg' },
      commandType: 'command',
    });
    expect(error.code).toBe(402);
    expect(error.message).toContain(providerMessage);
    expect(error.message).toMatch(/image upload.*(?:quota|limit)/i);
    expect(error.retryable).toBe(false);
  });

  it('preserves the 402 code and non-retryable quota semantics for an uploadImage HTTP 200 envelope without a provider message', async () => {
    const client = createTestClient(async (config) => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
      data: { statusCode: 402 },
    }));

    const error = await captureApiError(() => client.post(
      '/v1.1/devices/ART-LUMA-1/commands',
      {
        command: 'uploadImage',
        parameter: { imageUrl: 'https://example.test/art.jpg' },
        commandType: 'command',
      },
    ));

    expect(error.code).toBe(402);
    expect(error.message).toBe('Image upload quota reached');
    expect(error.retryable).toBe(false);
    expect(error.transient).toBe(false);
  });

  it('does not relabel another endpoint HTTP 200 envelope 402 as an image-upload quota error', async () => {
    const providerMessage = 'Subscription payment required';
    const client = createTestClient(async (config) => ({
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
      data: { statusCode: 402, message: providerMessage },
    }));

    const error = await captureApiError(() => client.get('/v1.1/devices'));

    expect(error.code).toBe(402);
    expect(error.message).toBe(providerMessage);
    expect(error.message).not.toMatch(/image upload quota/i);
  });

  it('does not relabel a genuine HTTP 402 from the uploadImage endpoint as image-upload quota', async () => {
    const client = createTestClient(async (config) => {
      throw new axios.AxiosError(
        'Payment Required',
        'ERR_BAD_REQUEST',
        config,
        undefined,
        {
          status: 402,
          statusText: 'Payment Required',
          headers: {},
          config,
          data: {},
        },
      );
    });

    const error = await captureApiError(() => client.post(
      '/v1.1/devices/ART-LUMA-1/commands',
      {
        command: 'uploadImage',
        parameter: { imageUrl: 'https://example.test/art.jpg' },
        commandType: 'command',
      },
    ));

    expect(error.code).toBe(402);
    expect(error.message).toBe('HTTP 402: Payment Required');
    expect(error.message).not.toMatch(/image upload quota/i);
  });
});
