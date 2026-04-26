import { describe, it, expect, vi } from 'vitest';

const healthMock = vi.hoisted(() => {
  const okReport = {
    generatedAt: '2026-04-25T00:00:00.000Z',
    overall: 'ok' as const,
    process: { pid: 1234, uptimeSeconds: 60, platform: 'linux', nodeVersion: 'v18.0.0', memoryMb: 50 },
    quota: { used: 100, limit: 10000, percentUsed: 1, remaining: 9900, status: 'ok' as const },
    audit: { present: false, recentErrors: 0, recentTotal: 0, errorRatePercent: 0, status: 'ok' as const },
    circuit: { name: 'switchbot-api', state: 'closed' as const, failures: 0, status: 'ok' as const },
  };
  return {
    getHealthReport: vi.fn(() => okReport),
    toPrometheusText: vi.fn(() => 'switchbot_quota_used_total 100\nswitchbot_circuit_open 0\n'),
    okReport,
  };
});

vi.mock('../../src/utils/health.js', () => ({
  getHealthReport: healthMock.getHealthReport,
  toPrometheusText: healthMock.toPrometheusText,
}));

import { registerHealthCommand } from '../../src/commands/health.js';
import { runCli } from '../helpers/cli.js';

describe('health check CLI', () => {
  it('--json emits a structured health report with all components', async () => {
    const res = await runCli(registerHealthCommand, ['--json', 'health', 'check']);
    expect(res.exitCode).toBeNull();
    const body = JSON.parse(res.stdout.join('')) as {
      data: { overall: string; quota: unknown; audit: unknown; circuit: unknown; process: unknown };
    };
    expect(['ok', 'degraded', 'down']).toContain(body.data.overall);
    expect(body.data.quota).toBeDefined();
    expect(body.data.audit).toBeDefined();
    expect(body.data.circuit).toBeDefined();
    expect(body.data.process).toBeDefined();
  });

  it('exits 0 in human mode when overall is ok', async () => {
    healthMock.getHealthReport.mockReturnValueOnce({ ...healthMock.okReport, overall: 'ok' });
    const res = await runCli(registerHealthCommand, ['health', 'check']);
    expect(res.exitCode).toBeNull();
  });

  it('exits 1 in human mode when overall is degraded', async () => {
    healthMock.getHealthReport.mockReturnValueOnce({ ...healthMock.okReport, overall: 'degraded' });
    const res = await runCli(registerHealthCommand, ['health', 'check']);
    expect(res.exitCode).toBe(1);
  });

  it('exits 1 in human mode when overall is down', async () => {
    healthMock.getHealthReport.mockReturnValueOnce({ ...healthMock.okReport, overall: 'down' });
    const res = await runCli(registerHealthCommand, ['health', 'check']);
    expect(res.exitCode).toBe(1);
  });

  it('--prometheus writes Prometheus text to process.stdout', async () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    const res = await runCli(registerHealthCommand, ['health', 'check', '--prometheus']);
    spy.mockRestore();
    expect(res.exitCode).toBeNull();
    expect(written.join('')).toContain('switchbot_quota_used_total');
    expect(written.join('')).toContain('switchbot_circuit_open');
  });

  it('human mode output lists quota and circuit component rows', async () => {
    const res = await runCli(registerHealthCommand, ['health', 'check']);
    const out = res.stdout.join('\n');
    expect(out).toMatch(/quota/i);
    expect(out).toMatch(/circuit/i);
  });
});
