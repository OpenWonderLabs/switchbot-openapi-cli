import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  listRecordings,
  getRecording,
  getSummary,
  listTodos,
  getDailyRecall,
  getWeeklySummary,
  getUrgentTodos,
} from '../../src/lib/mindclip.js';

const apiMock = vi.hoisted(() => {
  const instance = { get: vi.fn() };
  return { createClient: vi.fn(() => instance), __instance: instance };
});

vi.mock('../../src/api/client.js', () => ({
  createClient: apiMock.createClient,
}));

beforeEach(() => {
  apiMock.__instance.get.mockReset();
});

// ---------------------------------------------------------------------------
// listRecordings
// ---------------------------------------------------------------------------
describe('listRecordings', () => {
  it('calls GET /v1.1/mindclip/recordings and returns body', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: { list: [] } } });
    const result = await listRecordings({});
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/recordings', { params: {} });
    expect(result).toEqual({ list: [] });
  });

  it('passes deviceID, page, and size params', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await listRecordings({ deviceID: 'DEV1', pageNum: 2, pageSize: 10 });
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/recordings', {
      params: { deviceID: 'DEV1', pageNum: 2, pageSize: 10 },
    });
  });

  it('passes startTime, endTime, and folderID params', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await listRecordings({ startTime: 1000, endTime: 2000, folderID: 3 });
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/recordings', {
      params: { startTime: 1000, endTime: 2000, folderID: 3 },
    });
  });

  it('omits undefined params from the request', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await listRecordings({ pageNum: 1 });
    const params = apiMock.__instance.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('deviceID');
    expect(params).not.toHaveProperty('startTime');
    expect(params).not.toHaveProperty('folderID');
  });
});

// ---------------------------------------------------------------------------
// getRecording
// ---------------------------------------------------------------------------
describe('getRecording', () => {
  it('calls GET /v1.1/mindclip/recordings/{id}', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: { id: 'r1' } } });
    const result = await getRecording('r1');
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/recordings/r1', { params: {} });
    expect(result).toEqual({ id: 'r1' });
  });

  it('includes language param when provided', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getRecording('r1', 'zh');
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/recordings/r1', {
      params: { language: 'zh' },
    });
  });

  it('omits language param when undefined', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getRecording('r1');
    const params = apiMock.__instance.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('language');
  });
});

// ---------------------------------------------------------------------------
// getSummary
// ---------------------------------------------------------------------------
describe('getSummary', () => {
  it('calls GET /v1.1/mindclip/summaries/{id}', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: { summary: 'ok' } } });
    const result = await getSummary('s1');
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/summaries/s1', { params: {} });
    expect(result).toEqual({ summary: 'ok' });
  });
});

// ---------------------------------------------------------------------------
// listTodos
// ---------------------------------------------------------------------------
describe('listTodos', () => {
  it('calls GET /v1.1/mindclip/todos and returns body', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: { items: [] } } });
    const result = await listTodos({});
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/todos', { params: {} });
    expect(result).toEqual({ items: [] });
  });

  it('passes completedNum and category filters', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await listTodos({ completedNum: 1, category: 2, pageNum: 1, pageSize: 20 });
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/todos', {
      params: { completedNum: 1, category: 2, pageNum: 1, pageSize: 20 },
    });
  });

  it('passes device and file filters', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await listTodos({ deviceID: 'D1', fileID: 'F1', startTime: 100, endTime: 200 });
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/todos', {
      params: { deviceID: 'D1', fileID: 'F1', startTime: 100, endTime: 200 },
    });
  });

  it('omits undefined params', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await listTodos({ completedNum: 0 });
    const params = apiMock.__instance.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('deviceID');
    expect(params).not.toHaveProperty('fileID');
    expect(params).not.toHaveProperty('startTime');
  });
});

// ---------------------------------------------------------------------------
// getDailyRecall
// ---------------------------------------------------------------------------
describe('getDailyRecall', () => {
  it('calls GET /v1.1/mindclip/assistant/daily with date param', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getDailyRecall('2026-06-13');
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/assistant/daily', {
      params: { date: '2026-06-13' },
    });
  });

  it('omits date param when undefined (server uses its own default)', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getDailyRecall();
    const params = apiMock.__instance.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('date');
  });
});

// ---------------------------------------------------------------------------
// getWeeklySummary
// ---------------------------------------------------------------------------
describe('getWeeklySummary', () => {
  it('calls GET /v1.1/mindclip/assistant/weekly with week param', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getWeeklySummary('2026-W23');
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/assistant/weekly', {
      params: { week: '2026-W23' },
    });
  });

  it('omits week param when undefined', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getWeeklySummary();
    const params = apiMock.__instance.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('week');
  });
});

// ---------------------------------------------------------------------------
// getUrgentTodos
// ---------------------------------------------------------------------------
describe('getUrgentTodos', () => {
  it('calls GET /v1.1/mindclip/assistant/urgent-todos with date param', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getUrgentTodos('2026-06-12');
    expect(apiMock.__instance.get).toHaveBeenCalledWith('/v1.1/mindclip/assistant/urgent-todos', {
      params: { date: '2026-06-12' },
    });
  });

  it('omits date param when undefined (server defaults to yesterday)', async () => {
    apiMock.__instance.get.mockResolvedValueOnce({ data: { body: {} } });
    await getUrgentTodos();
    const params = apiMock.__instance.get.mock.calls[0][1].params;
    expect(params).not.toHaveProperty('date');
  });
});
