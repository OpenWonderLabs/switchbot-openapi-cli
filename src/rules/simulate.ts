import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { evaluateConditions } from './matcher.js';
import { ThrottleGate, parseMaxPerMs } from './throttle.js';
import { ruleVersion } from './trace.js';
import { filterTraceRecords } from './trace.js';
import { matchesMqttTrigger } from './matcher.js';
import type { Rule, EngineEvent } from './types.js';
import type { RuleEvaluateRecord } from './trace.js';

export interface SimulateOptions {
  rule: Rule;
  aliases?: Record<string, string>;
  since?: string;
  against?: string;
  auditLog?: string;
  liveLlm?: boolean;
}

export interface SimulateFireEvent {
  t: string;
  fireId: string;
  deviceId?: string;
  decision: 'would-fire' | 'blocked-by-condition' | 'throttled' | 'error' | 'skipped-llm';
  reason?: string;
}

export interface SimulateReport {
  ruleName: string;
  ruleVersion: string;
  windowStart: Date;
  windowEnd: Date;
  sourceEventCount: number;
  wouldFire: number;
  blockedByCondition: number;
  throttled: number;
  errored: number;
  skippedLlm: number;
  topBlockReason?: string;
  topBlockCount?: number;
  sampleFires: SimulateFireEvent[];
  traces: RuleEvaluateRecord[];
}

const HOUR_MS = 60 * 60 * 1000;
const DEVICE_HISTORY_DIR = path.join(os.homedir(), '.switchbot', 'device-history');

export async function simulateRule(opts: SimulateOptions): Promise<SimulateReport> {
  const { rule, aliases = {}, liveLlm = false } = opts;
  const rv = ruleVersion(rule);

  // --- Source events ---
  const events: EngineEvent[] = loadSourceEvents(opts);
  const windowStart = events.length > 0
    ? new Date(Math.min(...events.map(e => e.t.getTime())))
    : new Date(Date.now() - 24 * HOUR_MS);
  const windowEnd = events.length > 0
    ? new Date(Math.max(...events.map(e => e.t.getTime())))
    : new Date();

  // --- Counters ---
  const counts = { wouldFire: 0, blocked: 0, throttled: 0, errored: 0, skippedLlm: 0 };
  const blockReasons = new Map<string, number>();
  const sampleFires: SimulateFireEvent[] = [];
  const traces: RuleEvaluateRecord[] = [];

  // --- Throttle simulation ---
  const throttle = new ThrottleGate();
  const cooldownMs = rule.cooldown ? parseMaxPerMs(rule.cooldown) : null;
  const throttleMs = rule.throttle ? parseMaxPerMs(rule.throttle.max_per) : null;
  const effectiveWindowMs = cooldownMs ?? throttleMs;

  // --- Replay ---
  for (const event of events) {
    const fireId = randomUUID();
    const nowMs = event.t.getTime();

    // Trigger match
    if (rule.when.source === 'mqtt') {
      const resolvedDevice = rule.when.device
        ? (aliases[rule.when.device] ?? rule.when.device)
        : undefined;
      if (!matchesMqttTrigger(rule.when, event, resolvedDevice)) continue;
    }

    // LLM check without live-llm: mark as skipped
    const hasLlm = (rule.conditions ?? []).some(c => (c as unknown as Record<string, unknown>)['llm'] !== undefined);
    if (hasLlm && !liveLlm) {
      counts.skippedLlm++;
      const fireEvent: SimulateFireEvent = {
        t: event.t.toISOString(),
        fireId,
        deviceId: event.deviceId,
        decision: 'skipped-llm',
      };
      sampleFires.push(fireEvent);
      continue;
    }

    // Throttle check
    if (effectiveWindowMs !== null) {
      const check = throttle.check(rule.name, effectiveWindowMs, nowMs, event.deviceId);
      if (!check.allowed) {
        counts.throttled++;
        const fireEvent: SimulateFireEvent = {
          t: event.t.toISOString(), fireId, deviceId: event.deviceId,
          decision: 'throttled',
        };
        sampleFires.push(fireEvent);
        continue;
      }
    }

    // Condition evaluation
    const statusFetcher = buildStatusFetcher(event.t);
    let condResult: Awaited<ReturnType<typeof evaluateConditions>>;
    try {
      condResult = await evaluateConditions(rule.conditions, event.t, {
        aliases,
        fetchStatus: statusFetcher,
        event,
        ruleVersion: rv,
      });
    } catch (err) {
      counts.errored++;
      sampleFires.push({ t: event.t.toISOString(), fireId, deviceId: event.deviceId, decision: 'error', reason: String(err) });
      continue;
    }

    if (!condResult.matched) {
      counts.blocked++;
      const reason = condResult.failures[0] ?? 'unknown';
      blockReasons.set(reason, (blockReasons.get(reason) ?? 0) + 1);
      sampleFires.push({ t: event.t.toISOString(), fireId, deviceId: event.deviceId, decision: 'blocked-by-condition', reason });
    } else {
      counts.wouldFire++;
      throttle.record(rule.name, nowMs, event.deviceId);
      sampleFires.push({ t: event.t.toISOString(), fireId, deviceId: event.deviceId, decision: 'would-fire' });
    }
  }

  // Top block reason
  let topBlockReason: string | undefined;
  let topBlockCount: number | undefined;
  if (blockReasons.size > 0) {
    let max = 0;
    for (const [reason, count] of blockReasons) {
      if (count > max) { max = count; topBlockReason = reason; topBlockCount = count; }
    }
  }

  return {
    ruleName: rule.name,
    ruleVersion: rv,
    windowStart,
    windowEnd,
    sourceEventCount: events.length,
    wouldFire: counts.wouldFire,
    blockedByCondition: counts.blocked,
    throttled: counts.throttled,
    errored: counts.errored,
    skippedLlm: counts.skippedLlm,
    topBlockReason,
    topBlockCount,
    sampleFires: sampleFires.slice(0, 20),
    traces,
  };
}

function loadSourceEvents(opts: SimulateOptions): EngineEvent[] {
  // 1. From explicit against file (JSONL of EngineEvent)
  if (opts.against) {
    if (!fs.existsSync(opts.against)) return [];
    const lines = fs.readFileSync(opts.against, 'utf-8').split(/\r?\n/);
    const events: EngineEvent[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as Record<string, unknown>;
        events.push({
          source: (raw['source'] as EngineEvent['source']) ?? 'mqtt',
          event: String(raw['event'] ?? 'device.shadow'),
          t: new Date(String(raw['t'] ?? new Date().toISOString())),
          deviceId: raw['deviceId'] as string | undefined,
          payload: raw['payload'],
        });
      } catch { /* skip */ }
    }
    return events;
  }

  // 2. From audit log trace records
  const auditLog = opts.auditLog;
  if (!auditLog || !fs.existsSync(auditLog)) return [];

  const sinceMs = opts.since ? parseSince(opts.since) : Date.now() - 24 * HOUR_MS;
  const sinceIso = new Date(sinceMs).toISOString();

  const lines = fs.readFileSync(auditLog, 'utf-8').split(/\r?\n/);
  const traceRecords = filterTraceRecords(lines, {
    ruleName: opts.rule.name,
    since: sinceIso,
  });

  return traceRecords.map(r => ({
    source: r.trigger.source,
    event: r.trigger.event,
    t: new Date(r.t),
    deviceId: r.trigger.deviceId,
  }));
}

function parseSince(since: string): number {
  // ISO date
  if (since.includes('T') || since.includes('-')) {
    const d = new Date(since);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  // Duration: 7d, 24h, 30m
  const m = /^(\d+)([smhd])$/.exec(since.trim());
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const unitMs = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
    return Date.now() - n * unitMs;
  }
  return Date.now() - 24 * HOUR_MS;
}

function buildStatusFetcher(asOf: Date): (deviceId: string) => Promise<Record<string, unknown>> {
  return async (deviceId: string) => {
    const histFile = path.join(DEVICE_HISTORY_DIR, `${deviceId}.jsonl`);
    if (!fs.existsSync(histFile)) return {};
    const lines = fs.readFileSync(histFile, 'utf-8').split(/\r?\n/);
    const asOfMs = asOf.getTime();
    let best: Record<string, unknown> | undefined;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as Record<string, unknown>;
        const entryT = new Date(String(entry['t'] ?? 0)).getTime();
        if (entryT <= asOfMs) best = entry;
        else break; // history files are ordered ascending
      } catch { /* skip */ }
    }
    return best ?? {};
  };
}
