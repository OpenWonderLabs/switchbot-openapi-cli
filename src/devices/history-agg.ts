import fs from 'node:fs';
import readline from 'node:readline';
import type { QueryOptions, HistoryRecord } from './history-query.js';
import { jsonlFilesForDevice, parseDurationToMs, resolveRange } from './history-query.js';

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

interface Acc {
  min: number;
  max: number;
  sum: number;
  count: number;
  samples: number[] | null;
  sampleCapHit: boolean;
}

export async function aggregateDeviceHistory(
  deviceId: string,
  opts: AggOptions,
): Promise<AggResult> {
  const { fromMs, toMs } = resolveRange(opts);
  const aggs: AggFn[] = (opts.aggs && opts.aggs.length > 0) ? opts.aggs : [...DEFAULT_AGGS];
  const needQuantile = aggs.includes('p50') || aggs.includes('p95');

  let bucketMs: number | null = null;
  if (opts.bucket !== undefined) {
    bucketMs = parseDurationToMs(opts.bucket);
    if (bucketMs === null) {
      throw new Error(`Invalid --bucket "${opts.bucket}". Expected e.g. "15m", "1h", "1d".`);
    }
  }

  const sampleCap = Math.max(
    1,
    Math.min(opts.maxBucketSamples ?? DEFAULT_SAMPLE_CAP, MAX_SAMPLE_CAP),
  );
  let partial = false;
  const notes: string[] = [];

  // bucketKey (epoch ms; 0 when no --bucket) → metric name → Acc
  const buckets = new Map<number, Map<string, Acc>>();

  for (const file of jsonlFilesForDevice(deviceId)) {
    const stream = fs.createReadStream(file, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let rec: HistoryRecord;
      try { rec = JSON.parse(line) as HistoryRecord; } catch { continue; }
      const tMs = Date.parse(rec.t);
      if (!Number.isFinite(tMs) || tMs < fromMs || tMs > toMs) continue;

      const key = bucketMs !== null ? Math.floor(tMs / bucketMs) * bucketMs : 0;
      let bkt = buckets.get(key);
      if (!bkt) { bkt = new Map(); buckets.set(key, bkt); }

      for (const metric of opts.metrics) {
        const v = (rec.payload as Record<string, unknown> | null | undefined)?.[metric];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        let acc = bkt.get(metric);
        if (!acc) {
          acc = {
            min: v,
            max: v,
            sum: 0,
            count: 0,
            samples: needQuantile ? [] : null,
            sampleCapHit: false,
          };
          bkt.set(metric, acc);
        }
        acc.min = Math.min(acc.min, v);
        acc.max = Math.max(acc.max, v);
        acc.sum += v;
        acc.count += 1;
        if (acc.samples) {
          if (acc.samples.length < sampleCap) {
            acc.samples.push(v);
          } else if (!acc.sampleCapHit) {
            acc.sampleCapHit = true;
            partial = true;
            notes.push(
              `bucket ${new Date(key).toISOString()} metric ${metric}: sample cap ${sampleCap} reached, quantiles approximate`,
            );
          }
        }
      }
    }
  }

  return finalize(deviceId, opts, aggs, buckets, partial, notes, fromMs, toMs);
}

function finalize(
  deviceId: string,
  opts: AggOptions,
  aggs: AggFn[],
  buckets: Map<number, Map<string, Acc>>,
  partial: boolean,
  notes: string[],
  fromMs: number,
  toMs: number,
): AggResult {
  const fromIso = Number.isFinite(fromMs) ? new Date(fromMs).toISOString() : new Date(0).toISOString();
  const toIso = Number.isFinite(toMs) ? new Date(toMs).toISOString() : new Date(Date.now()).toISOString();

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const outBuckets: AggBucket[] = [];
  for (const key of keys) {
    const perMetric = buckets.get(key)!;
    const metricsOut: Record<string, BucketMetricResult> = {};
    for (const [metric, acc] of perMetric.entries()) {
      if (acc.count === 0) continue;
      const r: BucketMetricResult = {};
      if (aggs.includes('count')) r.count = acc.count;
      if (aggs.includes('min')) r.min = acc.min;
      if (aggs.includes('max')) r.max = acc.max;
      if (aggs.includes('avg')) r.avg = acc.sum / acc.count;
      if (aggs.includes('sum')) r.sum = acc.sum;
      if ((aggs.includes('p50') || aggs.includes('p95')) && acc.samples) {
        const sorted = [...acc.samples].sort((a, b) => a - b);
        if (aggs.includes('p50')) r.p50 = sorted[Math.floor(0.5 * (sorted.length - 1))];
        if (aggs.includes('p95')) r.p95 = sorted[Math.floor(0.95 * (sorted.length - 1))];
      }
      metricsOut[metric] = r;
    }
    if (Object.keys(metricsOut).length === 0) continue;
    outBuckets.push({
      t: new Date(key).toISOString(),
      metrics: metricsOut,
    });
  }

  return {
    deviceId,
    bucket: opts.bucket,
    from: fromIso,
    to: toIso,
    metrics: [...opts.metrics],
    aggs: [...aggs],
    buckets: outBuckets,
    partial,
    notes,
  };
}
