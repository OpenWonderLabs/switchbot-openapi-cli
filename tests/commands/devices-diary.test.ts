import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerDevicesCommand } from '../../src/commands/devices.js';
import { runCli } from '../helpers/cli.js';

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn(), post: vi.fn() };
  class DryRunSignal extends Error {}
  return {
    createClient: vi.fn(() => instance),
    __instance: instance,
    ApiError: class ApiError extends Error {},
    DryRunSignal,
  };
});

vi.mock('../../src/api/client.js', () => ({
  createClient: apiMock.createClient,
  ApiError: apiMock.ApiError,
  DryRunSignal: apiMock.DryRunSignal,
}));

beforeEach(() => {
  apiMock.__instance.get.mockReset();
  apiMock.__instance.post.mockReset();
});

describe('devices diary CLI', () => {
  it('requests a 31-day Kata diary window unchanged and rejects a longer one before GET', async () => {
    const diary = {
      diary: [{ detail: '{\"mood\":\"happy\"}' }],
      diaryAI: [{ detail: 'AI reflection' }],
      comicDiaryAI: [{ detail: '{\"panels\":[]}' }],
    };
    const dayMs = 24 * 60 * 60 * 1000;
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: diary } });

    const valid = await runCli(registerDevicesCommand, [
      '--json', 'devices', 'diary', 'kata/1?#', '--start', '0', '--end', String(31 * dayMs),
    ]);

    expect(valid.exitCode).toBeNull();
    expect(apiMock.__instance.get).toHaveBeenCalledWith(
      '/v1.1/devices/kata%2F1%3F%23/diary',
      { params: { startTimestamp: 0, endTimestamp: 31 * dayMs } },
    );
    expect(JSON.parse(valid.stdout.join('\n')).data).toEqual(diary);

    apiMock.__instance.get.mockClear();
    const tooLong = await runCli(registerDevicesCommand, [
      'devices', 'diary', 'kata/1?#', '--start', '0', '--end', String(31 * dayMs + 1),
    ]);

    expect(tooLong.exitCode).toBe(2);
    expect(apiMock.__instance.get).not.toHaveBeenCalled();
  });
});
