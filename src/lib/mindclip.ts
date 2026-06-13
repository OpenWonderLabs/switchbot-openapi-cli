import { createClient } from '../api/client.js';

export interface ListRecordingsParams {
  deviceID?: string;
  pageNum?: number;
  pageSize?: number;
  startTime?: number;
  endTime?: number;
  folderID?: number;
}

export interface ListTodosParams {
  completedNum?: number;
  pageNum?: number;
  pageSize?: number;
  deviceID?: string;
  fileID?: string;
  startTime?: number;
  endTime?: number;
  category?: number;
}

function compact(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

export async function listRecordings(params: ListRecordingsParams): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/recordings', {
    params: compact(params as Record<string, unknown>),
  });
  return res.data.body;
}

export async function getRecording(id: string, language?: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>(`/v1.1/mindclip/recordings/${id}`, {
    params: compact({ language }),
  });
  return res.data.body;
}

export async function getSummary(id: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>(`/v1.1/mindclip/summaries/${id}`, {
    params: {},
  });
  return res.data.body;
}

export async function listTodos(params: ListTodosParams): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/todos', {
    params: compact(params as Record<string, unknown>),
  });
  return res.data.body;
}

export async function getDailyRecall(date?: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/assistant/daily', {
    params: compact({ date }),
  });
  return res.data.body;
}

export async function getWeeklySummary(week?: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/assistant/weekly', {
    params: compact({ week }),
  });
  return res.data.body;
}

export async function getUrgentTodos(date?: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/assistant/urgent-todos', {
    params: compact({ date }),
  });
  return res.data.body;
}
