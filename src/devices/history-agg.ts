import type { QueryOptions } from './history-query.js';

export type AggFn = 'count' | 'min' | 'max' | 'avg' | 'sum' | 'p50' | 'p95';

export const ALL_AGG_FNS: readonly AggFn[] = ['count', 'min', 'max', 'avg', 'sum', 'p50', 'p95'];
export const DEFAULT_AGGS: readonly AggFn[] = ['count', 'avg'];
export const DEFAULT_SAMPLE_CAP = 10_000;
export const MAX_SAMPLE_CAP = 100_000;

export interface AggOptions extends QueryOptions {
  metrics: string[];
  aggs?: AggFn[];
  bucket?: string;
  maxBucketSamples?: number;
}

export interface BucketMetricResult {
  count?: number;
  min?: number;
  max?: number;
  avg?: number;
  sum?: number;
  p50?: number;
  p95?: number;
}

export interface AggBucket {
  t: string;
  metrics: Record<string, BucketMetricResult>;
}

export interface AggResult {
  deviceId: string;
  bucket?: string;
  from: string;
  to: string;
  metrics: string[];
  aggs: AggFn[];
  buckets: AggBucket[];
  partial: boolean;
  notes: string[];
}

export async function aggregateDeviceHistory(
  _deviceId: string,
  _opts: AggOptions,
): Promise<AggResult> {
  throw new Error('aggregateDeviceHistory: not implemented');
}
