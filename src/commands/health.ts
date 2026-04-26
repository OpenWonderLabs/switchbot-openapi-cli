import http from 'node:http';
import { Command } from 'commander';
import { printJson, isJsonMode, printTable, handleError } from '../utils/output.js';
import { getHealthReport, toPrometheusText } from '../utils/health.js';
import { intArg } from '../utils/arg-parsers.js';

const HEALTHZ_SCHEMA_VERSION = '1.1';

function runHealthCheck(opts: { prometheus?: boolean; auditLog?: string }): void {
  const report = getHealthReport(opts.auditLog);
  if (opts.prometheus) {
    process.stdout.write(toPrometheusText(report));
    return;
  }
  if (isJsonMode()) {
    printJson(report);
    return;
  }
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
}

/**
 * Create an HTTP request handler for the health endpoints. Exposed separately
 * so integration tests can call it directly without binding a port.
 */
export function createHealthHandler(auditLogPath?: string): http.RequestListener {
  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/healthz') {
      const report = getHealthReport(auditLogPath);
      const statusCode = report.overall === 'down' ? 503 : 200;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ schemaVersion: HEALTHZ_SCHEMA_VERSION, data: report }));
    } else if (url === '/metrics') {
      const report = getHealthReport(auditLogPath);
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(toPrometheusText(report));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', paths: ['/healthz', '/metrics'] }));
    }
  };
}

export function registerHealthCommand(program: Command): void {
  // Check options are declared on the root `health` command only, so that
  // `switchbot health --prometheus` (the documented fallback form) parses
  // the same flags as `switchbot health check --prometheus`. The subcommand
  // picks the values up via `cmd.optsWithGlobals()`. Declaring options on
  // BOTH parent and child causes commander v12 to route parsing to the
  // parent and leave the child's action with empty opts — don't go that
  // route.
  const health = program
    .command('health')
    .description('Report process health: quota, audit error rate, circuit breaker state.')
    .option('--prometheus', 'Emit Prometheus text format.')
    .option('--audit-log <path>', 'Audit log path (default: ~/.switchbot/audit.log).');

  health.action((opts: { prometheus?: boolean; auditLog?: string }) => {
    runHealthCheck(opts);
  });

  health
    .command('check')
    .description('Print a one-shot health report.')
    .action((_opts: Record<string, unknown>, cmd: Command) => {
      runHealthCheck(cmd.optsWithGlobals() as { prometheus?: boolean; auditLog?: string });
    });

  // switchbot health serve [--port <n>]
  health
    .command('serve')
    .description('Start an HTTP server exposing /healthz (JSON) and /metrics (Prometheus).')
    .option('--port <n>', 'Port to listen on.', intArg('--port'), '3100')
    .option('--host <host>', 'Bind address.', '127.0.0.1')
    .addHelpText('after', `
Endpoints:
  GET /healthz   JSON health report (HTTP 200 ok/degraded, 503 when circuit is open).
  GET /metrics   Prometheus text metrics.

Example:
  $ switchbot health serve --port 3100
  $ curl http://127.0.0.1:3100/healthz
`)
    .action((_opts: Record<string, unknown>, cmd: Command) => {
      // --audit-log is inherited from the root `health` command; --port / --host
      // are serve-local. optsWithGlobals() merges both.
      const opts = cmd.optsWithGlobals() as { port: string; host: string; auditLog?: string };
      const port = parseInt(opts.port, 10);
      const handler = createHealthHandler(opts.auditLog);
      const server = http.createServer(handler);

      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          handleError(Object.assign(new Error(`Port ${port} is already in use. Choose a different port with --port.`), { code: err.code }));
        } else {
          handleError(err);
        }
      });

      server.listen(port, opts.host, () => {
        const addr = server.address();
        const boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
        if (isJsonMode()) {
          printJson({ status: 'listening', host: opts.host, port: boundPort, endpoints: ['/healthz', '/metrics'] });
        } else {
          console.log(`health server listening on ${opts.host}:${boundPort}`);
          console.log('  GET /healthz  — JSON health report');
          console.log('  GET /metrics  — Prometheus text metrics');
        }
      });

      function shutdown() {
        server.close(() => process.exit(0));
      }
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    });
}
