import { createClient } from '../api/client.js';
import { UsageError } from '../utils/output.js';

export interface ListRecordingsParams {
  deviceID: string;
  pageNum: number;
  pageSize: number;
  startTime?: number;
  endTime?: number;
  folderID?: number;
}

export interface ListTodosParams {
  completedNum: number;
  pageNum: number;
  pageSize: number;
  deviceID?: string;
  fileID?: string;
  startTime?: number;
  endTime?: number;
  category?: number;
}

function compact(obj: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '' && !Number.isNaN(v)),
  );
}

function requireQueryValue(name: string, value: unknown): void {
  if (value === undefined || value === null ||
      (typeof value === 'string' && value.trim() === '') ||
      (typeof value === 'number' && !Number.isFinite(value))) {
    throw new UsageError(`MindClip query requires ${name}.`);
  }
}

export async function listRecordings(params: ListRecordingsParams): Promise<unknown> {
  requireQueryValue('deviceID', params.deviceID);
  requireQueryValue('pageNum', params.pageNum);
  requireQueryValue('pageSize', params.pageSize);
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/recordings', {
    params: compact(params),
  });
  return res.data.body;
}

export async function getRecording(id: string, language?: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>(
    `/v1.1/mindclip/recordings/${encodeURIComponent(id)}`,
    {
      params: compact({ language }),
    },
  );
  return res.data.body;
}

export async function getTranscript(recordingId: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>(
    `/v1.1/mindclip/recordings/${encodeURIComponent(recordingId)}/transcript`,
    { params: {} },
  );
  return res.data.body;
}

export async function getSummary(id: string): Promise<unknown> {
  const c = createClient();
  const res = await c.get<{ body: unknown }>(
    `/v1.1/mindclip/summaries/${encodeURIComponent(id)}`,
    {
      params: {},
    },
  );
  return res.data.body;
}

export async function listTodos(params: ListTodosParams): Promise<unknown> {
  requireQueryValue('completedNum', params.completedNum);
  requireQueryValue('pageNum', params.pageNum);
  requireQueryValue('pageSize', params.pageSize);
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/todos', {
    params: compact(params),
  });
  return res.data.body;
}

export async function getDailyRecall(date: string): Promise<unknown> {
  requireQueryValue('date', date);
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/assistant/daily', {
    params: compact({ date }),
  });
  return res.data.body;
}

export async function getWeeklySummary(week: string): Promise<unknown> {
  requireQueryValue('week', week);
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/assistant/weekly', {
    params: compact({ week }),
  });
  return res.data.body;
}

export async function getUrgentTodos(date: string): Promise<unknown> {
  requireQueryValue('date', date);
  const c = createClient();
  const res = await c.get<{ body: unknown }>('/v1.1/mindclip/assistant/urgent-todos', {
    params: compact({ date }),
  });
  return res.data.body;
}
