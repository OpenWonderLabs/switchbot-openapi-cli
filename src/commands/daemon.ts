import { Command } from 'commander';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isJsonMode, printJson, exitWithError } from '../utils/output.js';
import { readPidFile, writePidFile, isPidAlive } from '../rules/pid-file.js';
import { stringArg } from '../utils/arg-parsers.js';
import chalk from 'chalk';

const DAEMON_PID_FILE = path.join(os.homedir(), '.switchbot', 'daemon.pid');
const DAEMON_LOG_FILE = path.join(os.homedir(), '.switchbot', 'daemon.log');
const HEALTHZ_PID_FILE = path.join(os.homedir(), '.switchbot', 'healthz.pid');

function readDaemonPid(): number | null {
  return readPidFile(DAEMON_PID_FILE);
}

function isDaemonAlive(pid: number): boolean {
  return isPidAlive(pid);
}

function getDaemonStatus(): { running: boolean; pid: number | null } {
  const pid = readDaemonPid();
  if (pid === null) return { running: false, pid: null };
  const running = isDaemonAlive(pid);
  return { running, pid: running ? pid : null };
}

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Manage the background rules-engine daemon (MVP: runs `rules run` in background).')
    .addHelpText('after', `
The daemon wraps \`switchbot rules run\` as a detached background process,
writing its PID to ~/.switchbot/daemon.pid and stdout/stderr to
~/.switchbot/daemon.log.

Subcommands:
  start [--policy <path>]   Start the daemon (no-op if already running).
  stop                      Send SIGTERM to the daemon process.
  status                    Report whether the daemon is running.

The daemon reads the same policy file as \`switchbot rules run\`.
Use \`switchbot rules reload\` to hot-reload the policy without restarting.
`);

  daemon
    .command('start')
    .description('Start the rules-engine daemon in the background.')
    .option('--policy <path>', 'Policy file path (default: auto-detected)', stringArg('--policy'))
    .option('--force', 'Restart even if the daemon appears to be running.')
    .option('--healthz-port <n>', 'Also start a health HTTP server on this port (default: disabled).')
    .action((opts: { policy?: string; force?: boolean; healthzPort?: string }) => {
      const { running, pid } = getDaemonStatus();
      if (running && !opts.force) {
        if (isJsonMode()) {
          printJson({ status: 'already-running', pid });
        } else {
          console.log(`Daemon is already running (pid ${pid}). Use --force to restart.`);
        }
        return;
      }

      if (running && opts.force && pid !== null) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // best effort — process may have died between check and kill
        }
      }

      // Resolve the CLI entry point: dist/index.js relative to this file.
      const thisFile = fileURLToPath(import.meta.url);
      const cliEntry = path.resolve(path.dirname(thisFile), 'index.js');

      const args = ['rules', 'run'];
      if (opts.policy) args.push(opts.policy);

      const dir = path.dirname(DAEMON_PID_FILE);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

      const logFd = fs.openSync(DAEMON_LOG_FILE, 'a');
      const child = spawn(process.execPath, [cliEntry, ...args], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env },
      });
      child.unref();
      fs.closeSync(logFd);

      const newPid = child.pid;
      if (!newPid) {
        exitWithError({ code: 1, kind: 'runtime', message: 'Failed to spawn daemon process.' });
      }
      writePidFile(DAEMON_PID_FILE, newPid);

      // Optionally also start a health server alongside the daemon.
      let healthzPid: number | null = null;
      if (opts.healthzPort) {
        const healthArgs = ['health', 'serve', '--port', opts.healthzPort];
        const healthLogFd = fs.openSync(DAEMON_LOG_FILE, 'a');
        const healthChild = spawn(process.execPath, [cliEntry, ...healthArgs], {
          detached: true,
          stdio: ['ignore', healthLogFd, healthLogFd],
          env: { ...process.env },
        });
        healthChild.unref();
        fs.closeSync(healthLogFd);
        if (healthChild.pid) {
          healthzPid = healthChild.pid;
          writePidFile(HEALTHZ_PID_FILE, healthzPid);
        }
      }

      if (isJsonMode()) {
        printJson({
          status: 'started', pid: newPid, logFile: DAEMON_LOG_FILE, pidFile: DAEMON_PID_FILE,
          ...(healthzPid !== null ? { healthzPid, healthzPort: opts.healthzPort, healthzPidFile: HEALTHZ_PID_FILE } : {}),
        });
      } else {
        console.log(`${chalk.green('✓')} Daemon started (pid ${newPid})`);
        console.log(`  Log:     ${DAEMON_LOG_FILE}`);
        console.log(`  PID:     ${DAEMON_PID_FILE}`);
        console.log(`  Reload:  switchbot rules reload`);
        if (healthzPid !== null) {
          console.log(`${chalk.green('✓')} Health server started (pid ${healthzPid}) on port ${opts.healthzPort}`);
          console.log(`  http://127.0.0.1:${opts.healthzPort}/healthz`);
        }
      }
    });

  daemon
    .command('stop')
    .description('Stop the background daemon by sending SIGTERM.')
    .action(() => {
      const { running, pid } = getDaemonStatus();
      if (!running || pid === null) {
        if (isJsonMode()) {
          printJson({ status: 'not-running', pidFile: DAEMON_PID_FILE });
        } else {
          console.log(`No running daemon found (pid file: ${DAEMON_PID_FILE}).`);
        }
        return;
      }
      try {
        process.kill(pid, 'SIGTERM');
      } catch (err) {
        exitWithError({
          code: 1,
          kind: 'runtime',
          message: `Failed to stop daemon (pid ${pid}): ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      // Remove stale PID file so subsequent `status` reflects reality.
      try { fs.unlinkSync(DAEMON_PID_FILE); } catch { /* best effort */ }

      if (isJsonMode()) {
        printJson({ status: 'stopped', pid });
      } else {
        console.log(`${chalk.green('✓')} Daemon stopped (pid ${pid}).`);
      }
    });

  daemon
    .command('status')
    .description('Report whether the daemon is currently running.')
    .action(() => {
      const { running, pid } = getDaemonStatus();
      const status = running ? 'running' : 'stopped';
      if (isJsonMode()) {
        printJson({ status, pid: pid ?? null, pidFile: DAEMON_PID_FILE, logFile: DAEMON_LOG_FILE });
        return;
      }
      if (running) {
        console.log(`${chalk.green('●')} Daemon is running (pid ${pid}).`);
        console.log(`  Log: ${DAEMON_LOG_FILE}`);
      } else {
        console.log(`${chalk.grey('○')} Daemon is not running.`);
      }
    });
}
