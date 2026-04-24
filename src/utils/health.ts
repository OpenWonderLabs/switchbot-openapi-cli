/**
 * Health report utilities — collects process, quota, audit, and circuit
 * breaker state into a single snapshot suitable for /health-style checks
 * and Prometheus-compatible metrics export.
 *
 * No side effects: reading is safe to call from any context.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { todayUsage, DAILY_QUOTA } from './quota.js';
import { readAudit } from './audit.js';
import { apiCircuitBreaker } from '../api/client.js';

const DEFAULT_AUDIT_PATH = path.join(os.homedir(), '.switchbot', 'audit.log');
const AUDIT_ERROR_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

export interface QuotaHealth {
  used: number;
  limit: number;
  percentUsed: number;
  remaining: number;
  status: 'ok' | 'warn' | 'critical';
}

export interface AuditHealth {
  present: boolean;
  recentErrors: number;
  recentTotal: number;
  errorRatePercent: number;
  status: 'ok' | 'warn';
}

export interface CircuitHealth {
  name: string;
  state: 'closed' | 'open' | 'half-open';
  failures: number;
  status: 'ok' | 'open';
}

export interface ProcessHealth {
  pid: number;
  uptimeSeconds: number;
  platform: string;
  nodeVersion: string;
  memoryMb: number;
}

export interface HealthReport {
  generatedAt: string;
  overall: 'ok' | 'degraded' | 'down';
  process: ProcessHealth;
  quota: QuotaHealth;
  audit: AuditHealth;
  circuit: CircuitHealth;
}

export function getHealthReport(auditPath = DEFAULT_AUDIT_PATH): HealthReport {
  const now = new Date();

  // Process info
  const procHealth: ProcessHealth = {
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    platform: process.platform,
    nodeVersion: process.version,
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };

  // Quota
  const { total: used } = todayUsage(now);
  const pct = Math.round((used / DAILY_QUOTA) * 100);
  const quotaHealth: QuotaHealth = {
    used,
    limit: DAILY_QUOTA,
    percentUsed: pct,
    remaining: Math.max(0, DAILY_QUOTA - used),
    status: pct >= 90 ? 'critical' : pct >= 70 ? 'warn' : 'ok',
  };

  // Audit error rate (last 24h)
  let auditHealth: AuditHealth;
  if (!fs.existsSync(auditPath)) {
    auditHealth = { present: false, recentErrors: 0, recentTotal: 0, errorRatePercent: 0, status: 'ok' };
  } else {
    const entries = readAudit(auditPath);
    const windowStart = now.getTime() - AUDIT_ERROR_WINDOW_MS;
    const recent = entries.filter((e) => new Date(e.t).getTime() >= windowStart);
    const errors = recent.filter((e) => e.result === 'error').length;
    const total = recent.length;
    const errorRate = total > 0 ? Math.round((errors / total) * 100) : 0;
    auditHealth = {
      present: true,
      recentErrors: errors,
      recentTotal: total,
      errorRatePercent: errorRate,
      status: errorRate >= 30 ? 'warn' : 'ok',
    };
  }

  // Circuit breaker
  const cbStats = apiCircuitBreaker.getStats();
  const circuitHealth: CircuitHealth = {
    name: apiCircuitBreaker.name,
    state: cbStats.state,
    failures: cbStats.failures,
    status: cbStats.state === 'open' ? 'open' : 'ok',
  };

  // Overall
  const degraded =
    quotaHealth.status !== 'ok' ||
    auditHealth.status !== 'ok' ||
    circuitHealth.status !== 'ok';
  const down = circuitHealth.status === 'open';
  const overall: HealthReport['overall'] = down ? 'down' : degraded ? 'degraded' : 'ok';

  return {
    generatedAt: now.toISOString(),
    overall,
    process: procHealth,
    quota: quotaHealth,
    audit: auditHealth,
    circuit: circuitHealth,
  };
}

/**
 * Render a minimal Prometheus-compatible text metrics export.
 * Only includes the most actionable gauges.
 */
export function toPrometheusText(report: HealthReport): string {
  const lines: string[] = [];
  const push = (name: string, value: number, help?: string) => {
    if (help) lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${value}`);
  };

  push('switchbot_quota_used_total', report.quota.used, 'SwitchBot API requests used today');
  push('switchbot_quota_remaining', report.quota.remaining, 'SwitchBot API quota remaining today');
  push('switchbot_quota_percent_used', report.quota.percentUsed, 'SwitchBot API quota percent used today');
  push('switchbot_audit_recent_errors', report.audit.recentErrors, 'Audit log errors in the last 24h');
  push('switchbot_audit_error_rate_percent', report.audit.errorRatePercent, 'Audit error rate percent (last 24h)');
  push('switchbot_circuit_open', report.circuit.state === 'open' ? 1 : 0, 'API circuit breaker open (1=open, 0=closed/half-open)');
  push('switchbot_circuit_failures', report.circuit.failures, 'Consecutive API failures recorded by circuit breaker');
  push('switchbot_process_uptime_seconds', report.process.uptimeSeconds, 'Process uptime in seconds');
  push('switchbot_process_memory_mb', report.process.memoryMb, 'Process RSS memory usage in MB');

  return lines.join('\n') + '\n';
}
