import { Command } from 'commander';
import { printJson, isJsonMode, printTable } from '../utils/output.js';
import { getHealthReport, toPrometheusText } from '../utils/health.js';

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Report process health: quota, audit error rate, circuit breaker state.')
    .option('--prometheus', 'Emit Prometheus text format (suitable for scraping by Prometheus / Grafana Agent).')
    .option('--audit-log <path>', 'Audit log path to inspect for error rate (default: ~/.switchbot/audit.log).')
    .action((opts: { prometheus?: boolean; auditLog?: string }) => {
      const report = getHealthReport(opts.auditLog);
      if (opts.prometheus) {
        process.stdout.write(toPrometheusText(report));
        return;
      }
      if (isJsonMode()) {
        printJson(report);
        return;
      }
      // Human-readable
      const statusEmoji = report.overall === 'ok' ? '✓' : report.overall === 'degraded' ? '⚠' : '✗';
      console.log(`${statusEmoji} overall: ${report.overall}  (${report.generatedAt})`);
      console.log('');
      printTable(
        ['Component', 'Status', 'Detail'],
        [
          ['quota', report.quota.status,
            `${report.quota.used}/${report.quota.limit} (${report.quota.percentUsed}% used, ${report.quota.remaining} remaining)`],
          ['audit', report.audit.status,
            report.audit.present
              ? `${report.audit.recentErrors}/${report.audit.recentTotal} errors in 24h (${report.audit.errorRatePercent}%)`
              : 'log not present'],
          ['circuit', report.circuit.status,
            `${report.circuit.name}: ${report.circuit.state} (failures: ${report.circuit.failures})`],
          ['process', 'ok',
            `pid ${report.process.pid} · uptime ${report.process.uptimeSeconds}s · mem ${report.process.memoryMb}MB`],
        ],
      );
      if (report.overall !== 'ok') process.exit(1);
    });
}
