import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listRecordings, getRecording, getSummary, listTodos, getDailyRecall, getWeeklySummary, getUrgentTodos } from '../../src/lib/mindclip.js';
import { UsageError } from '../../src/utils/output.js';

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn() };
  return { createClient: vi.fn(() => instance), instance };
});
vi.mock('../../src/api/client.js', () => ({ createClient: apiMock.createClient }));
beforeEach(() => apiMock.instance.get.mockReset().mockResolvedValue({ data: { body: { list: [] } } }));

describe('MindClip request boundaries', () => {
  it.each([
    ['recordings', listRecordings, [{ pageNum: 1, pageSize: 20 }]],
    ['todos', listTodos, [{ pageNum: 1, pageSize: 20 }]],
    ['daily', getDailyRecall, []],
    ['weekly', getWeeklySummary, []],
    ['urgent todos', getUrgentTodos, []],
  ])('rejects missing official query values before requesting %s', async (_name, method, args) => {
    await expect(Reflect.apply(method, undefined, args)).rejects.toBeInstanceOf(UsageError);
    expect(apiMock.instance.get).not.toHaveBeenCalled();
  });

  it.each([
    ['recording query delimiters', getRecording, 'a/b?secret=x#frag', '/v1.1/mindclip/recordings/a%2Fb%3Fsecret%3Dx%23frag'],
    ['recording traversal', getRecording, '../summaries/abc', '/v1.1/mindclip/recordings/..%2Fsummaries%2Fabc'],
    ['summary delimiters', getSummary, 'a/b?x=1', '/v1.1/mindclip/summaries/a%2Fb%3Fx%3D1'],
  ])('encodes %s without escaping the selected endpoint', async (_name, method, id, expectedPath) => {
    apiMock.instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await method(id);
    expect(apiMock.instance.get.mock.calls[0][0]).toBe(expectedPath);
  });
});
