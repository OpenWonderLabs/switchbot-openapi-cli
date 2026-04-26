import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HealthReport } from '../../src/utils/health.js';
import { expectJsonEnvelopeShape } from '../helpers/contracts.js';

const healthMock = vi.hoisted(() => ({
  getHealthReport: vi.fn<[], HealthReport>(),
  toPrometheusText: vi.fn(() => 'switchbot_quota_used_total 0\n'),
}));

vi.mock('../../src/utils/health.js', () => healthMock);

import { registerHealthCommand } from '../../src/commands/health.js';
import { runCli } from '../helpers/cli.js';

const OK_REPORT: HealthReport = {
  generatedAt: '2026-04-25T12:00:00.000Z',
  overall: 'ok',
  process: { pid: 1234, uptimeSeconds: 60, platform: 'linux', nodeVersion: 'v18.0.0', memoryMb: 50 },
  quota: { used: 10, limit: 10000, percentUsed: 0, remaining: 9990, status: 'ok' },
  audit: { present: false, recentErrors: 0, recentTotal: 0, errorRatePercent: 0, status: 'ok' },
  circuit: { name: 'switchbot-api', state: 'closed', failures: 0, status: 'ok' },
};

const DEGRADED_REPORT: HealthReport = {
  ...OK_REPORT,
  overall: 'degraded',
  quota: { used: 7500, limit: 10000, percentUsed: 75, remaining: 2500, status: 'warn' },
};

const DOWN_REPORT: HealthReport = {
  ...OK_REPORT,
  overall: 'down',
  circuit: { name: 'switchbot-api', state: 'open', failures: 5, status: 'open' },
};

describe('health check CLI', () => {
  beforeEach(() => {
    healthMock.getHealthReport.mockReset().mockReturnValue(OK_REPORT);
    healthMock.toPrometheusText.mockReset().mockReturnValue('switchbot_quota_used_total 0\n');
  });

  it('--json exits 0 and includes overall, quota, circuit, process', async () => {
    const res = await runCli(registerHealthCommand, ['--json', 'health', 'check']);
    expect(res.exitCode).toBeNull();
    const body = JSON.parse(res.stdout.join('')) as Record<string, unknown>;
    const data = expectJsonEnvelopeShape(body, [
      'generatedAt',
      'overall',
      'process',
      'quota',
      'audit',
      'circuit',
    ]) as HealthReport;
    expect(data.overall).toBe('ok');
    expect(data.quota).toBeDefined();
    expect(data.circuit).toBeDefined();
    expect(data.process).toBeDefined();
  });

  it('--json exits 0 even when overall is degraded (no process.exit in JSON mode)', async () => {
    healthMock.getHealthReport.mockReturnValue(DEGRADED_REPORT);
    const res = await runCli(registerHealthCommand, ['--json', 'health', 'check']);
    expect(res.exitCode).toBeNull();
    const body = JSON.parse(res.stdout.join('')) as { data: HealthReport };
    expect(body.data.overall).toBe('degraded');
  });

  it('human mode exits 0 and prints ✓ overall when healthy', async () => {
    const res = await runCli(registerHealthCommand, ['health', 'check']);
    expect(res.exitCode).toBeNull();
    expect(res.stdout.join(' ')).toMatch(/overall.*ok/i);
  });

  it('bare health defaults to check', async () => {
    const res = await runCli(registerHealthCommand, ['health']);
    expect(res.exitCode).toBeNull();
    expect(res.stdout.join(' ')).toMatch(/overall.*ok/i);
  });

  it('human mode exits 1 when overall is degraded', async () => {
    healthMock.getHealthReport.mockReturnValue(DEGRADED_REPORT);
    const res = await runCli(registerHealthCommand, ['health', 'check']);
    expect(res.exitCode).toBe(1);
    expect(res.stdout.join(' ')).toMatch(/overall.*degraded/i);
  });

  it('human mode exits 1 when circuit is open (overall: down)', async () => {
    healthMock.getHealthReport.mockReturnValue(DOWN_REPORT);
    const res = await runCli(registerHealthCommand, ['health', 'check']);
    expect(res.exitCode).toBe(1);
  });

  it('--prometheus writes Prometheus text to stdout and exits 0', async () => {
    const stdoutLines: string[] = [];
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    try {
      const res = await runCli(registerHealthCommand, ['health', 'check', '--prometheus']);
      expect(res.exitCode).toBeNull();
    } finally {
      writeSpy.mockRestore();
    }
    expect(healthMock.toPrometheusText).toHaveBeenCalledWith(OK_REPORT);
    expect(stdoutLines.join('')).toContain('switchbot_quota_used_total');
  });
});
