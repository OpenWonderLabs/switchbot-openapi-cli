import { Command } from 'commander';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isJsonMode, printJson, exitWithError } from '../utils/output.js';
import { readPidFile, writePidFile, isPidAlive, getDefaultPidFilePaths, writeReloadSentinel, sighupSupported } from '../rules/pid-file.js';
import { stringArg } from '../utils/arg-parsers.js';
import chalk from 'chalk';
import {
  DAEMON_LOG_FILE,
  DAEMON_PID_FILE,
  DAEMON_STATE_FILE,
  HEALTHZ_PID_FILE,
  readDaemonState,
  writeDaemonState,
  type DaemonState,
} from '../lib/daemon-state.js';

interface DaemonRuntimeStatus {
  status: 'running' | 'stopped';
  pid: number | null;
  pidFile: string;
  logFile: string;
  stateFile: string;
  health: {
    configured: boolean;
    pid: number | null;
    pidFile: string;
    port: number | null;
    running: boolean;
    url: string | null;
  };
  lastReloadAt: string | null;
  lastReloadStatus: 'ok' | 'failed' | null;
  lastReloadMessage: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
}

function readDaemonPid(): number | null {
  return readPidFile(DAEMON_PID_FILE);
}

function readHealthPid(): number | null {
  return readPidFile(HEALTHZ_PID_FILE);
}

function killIfAlive(pid: number | null, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!pid) return;
  if (!isPidAlive(pid)) return;
  process.kill(pid, signal);
}

function buildHealthSummary(state: DaemonState | null) {
  const healthPid = readHealthPid();
  const healthRunning = healthPid !== null && isPidAlive(healthPid);
  const port = state?.healthzPort ?? null;
  return {
    configured: port !== null,
    pid: healthRunning ? healthPid : null,
    pidFile: HEALTHZ_PID_FILE,
    port,
    running: healthRunning,
    url: port !== null ? `http://127.0.0.1:${port}/healthz` : null,
  };
}

function getDaemonStatus(): DaemonRuntimeStatus {
  const state = readDaemonState();
  const pid = readDaemonPid();
  const running = pid !== null && isPidAlive(pid);
  return {
    status: running ? 'running' : 'stopped',
    pid: running ? pid : null,
    pidFile: DAEMON_PID_FILE,
    logFile: DAEMON_LOG_FILE,
    stateFile: DAEMON_STATE_FILE,
    health: buildHealthSummary(state),
    lastReloadAt: state?.lastReloadAt ?? null,
    lastReloadStatus: state?.lastReloadStatus ?? null,
    lastReloadMessage: state?.lastReloadMessage ?? null,
    startedAt: state?.startedAt ?? null,
    stoppedAt: state?.stoppedAt ?? null,
  };
}

function persistState(partial: Partial<DaemonState>): DaemonState {
  const previous = readDaemonState();
  const next: DaemonState = {
    ...(previous ?? {}),
    status: partial.status ?? previous?.status ?? 'stopped',
    pid: partial.pid ?? previous?.pid ?? null,
    ...partial,
    logFile: DAEMON_LOG_FILE,
    pidFile: DAEMON_PID_FILE,
    stateFile: DAEMON_STATE_FILE,
  };
  writeDaemonState(next);
  return next;
}

function renderHumanStatus(status: DaemonRuntimeStatus): void {
  if (status.status === 'running' && status.pid !== null) {
    console.log(`${chalk.green('●')} Daemon is running (pid ${status.pid}).`);
  } else {
    console.log(`${chalk.grey('○')} Daemon is not running.`);
  }
  if (status.startedAt) console.log(`  Started: ${status.startedAt}`);
  if (status.stoppedAt) console.log(`  Stopped: ${status.stoppedAt}`);
  console.log(`  Log:     ${status.logFile}`);
  console.log(`  PID:     ${status.pidFile}`);
  console.log(`  State:   ${status.stateFile}`);
  if (status.lastReloadAt) {
    console.log(`  Reload:  ${status.lastReloadAt} (${status.lastReloadStatus ?? 'unknown'})`);
    if (status.lastReloadMessage) console.log(`           ${status.lastReloadMessage}`);
  }
  if (status.health.configured) {
    if (status.health.running) {
      console.log(`${chalk.green('✓')} Health server running (pid ${status.health.pid})`);
    } else {
      console.log(`${chalk.yellow('!')} Health server configured but not running`);
    }
    if (status.health.url) console.log(`  Health:  ${status.health.url}`);
  }
}

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command('daemon')
    .description('Manage the background SwitchBot rules daemon and its health endpoint.')
    .addHelpText('after', `
The daemon runs \`switchbot rules run\` as a detached background process,
tracks runtime metadata in ~/.switchbot/daemon.state.json, and can optionally
co-launch a health endpoint via \`switchbot health serve\`.

Subcommands:
  start [--policy <path>]   Start the daemon (no-op if already running).
  stop                      Stop the daemon and any co-launched health server.
  status                    Report the daemon state, log path, and health summary.
  reload                    Trigger a hot reload for the running rules engine.

The daemon reads the same policy file as \`switchbot rules run\`.
`);

  daemon
    .command('start')
    .description('Start the rules-engine daemon in the background.')
    .option('--policy <path>', 'Policy file path (default: auto-detected)', stringArg('--policy'))
    .option('--force', 'Restart even if the daemon appears to be running.')
    .option('--healthz-port <n>', 'Also start a health HTTP server on this port (default: disabled).')
    .action((opts: { policy?: string; force?: boolean; healthzPort?: string }) => {
      const current = getDaemonStatus();
      if (current.status === 'running' && !opts.force) {
        if (isJsonMode()) {
          printJson({ result: 'already-running', ...current });
        } else {
          console.log(`Daemon is already running (pid ${current.pid}). Use --force to restart.`);
        }
        return;
      }

      if (opts.force) {
        try {
          killIfAlive(current.pid);
          killIfAlive(current.health.pid);
        } catch {
          // best effort
        }
      }

      const thisFile = fileURLToPath(import.meta.url);
      const cliEntry = path.resolve(path.dirname(thisFile), 'index.js');
      const args = ['rules', 'run'];
      if (opts.policy) args.push(opts.policy);

      fs.mkdirSync(path.dirname(DAEMON_PID_FILE), { recursive: true, mode: 0o700 });
      persistState({
        status: 'starting',
        pid: null,
        startedAt: new Date().toISOString(),
        stoppedAt: undefined,
        failedAt: undefined,
        failureReason: undefined,
        healthzPort: opts.healthzPort ? Number.parseInt(opts.healthzPort, 10) : null,
        healthzPid: null,
        healthzPidFile: HEALTHZ_PID_FILE,
      });

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
        persistState({
          status: 'failed',
          pid: null,
          failedAt: new Date().toISOString(),
          failureReason: 'Failed to spawn daemon process.',
        });
        exitWithError({ code: 1, kind: 'runtime', message: 'Failed to spawn daemon process.' });
      }
      writePidFile(DAEMON_PID_FILE, newPid);

      let healthzPid: number | null = null;
      let healthzPort: number | null = opts.healthzPort ? Number.parseInt(opts.healthzPort, 10) : null;
      if (healthzPort !== null) {
        const healthArgs = ['health', 'serve', '--port', String(healthzPort)];
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

      persistState({
        status: 'running',
        pid: newPid,
        startedAt: new Date().toISOString(),
        stoppedAt: undefined,
        failedAt: undefined,
        failureReason: undefined,
        healthzPort,
        healthzPid,
        healthzPidFile: HEALTHZ_PID_FILE,
      });

      const status = getDaemonStatus();
      if (isJsonMode()) {
        printJson({ result: 'started', ...status });
      } else {
        console.log(`${chalk.green('✓')} Daemon started (pid ${newPid})`);
        console.log(`  Log:     ${DAEMON_LOG_FILE}`);
        console.log(`  PID:     ${DAEMON_PID_FILE}`);
        console.log(`  State:   ${DAEMON_STATE_FILE}`);
        console.log(`  Reload:  switchbot daemon reload`);
        if (status.health.running && status.health.url) {
          console.log(`${chalk.green('✓')} Health server started (pid ${status.health.pid})`);
          console.log(`  Health:  ${status.health.url}`);
        }
      }
    });

  daemon
    .command('stop')
    .description('Stop the background daemon by sending SIGTERM.')
    .action(() => {
      const status = getDaemonStatus();
      if (status.status !== 'running' || status.pid === null) {
        persistState({ status: 'stopped', pid: null, stoppedAt: new Date().toISOString() });
        if (isJsonMode()) {
          printJson({ result: 'not-running', ...getDaemonStatus() });
        } else {
          console.log(`No running daemon found (pid file: ${DAEMON_PID_FILE}).`);
        }
        return;
      }
      try {
        killIfAlive(status.pid);
        killIfAlive(status.health.pid);
      } catch (err) {
        persistState({
          status: 'failed',
          pid: status.pid,
          failedAt: new Date().toISOString(),
          failureReason: err instanceof Error ? err.message : String(err),
        });
        exitWithError({
          code: 1,
          kind: 'runtime',
          message: `Failed to stop daemon (pid ${status.pid}): ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      try { fs.unlinkSync(DAEMON_PID_FILE); } catch { /* best effort */ }
      try { fs.unlinkSync(HEALTHZ_PID_FILE); } catch { /* best effort */ }
      persistState({
        status: 'stopped',
        pid: null,
        healthzPid: null,
        stoppedAt: new Date().toISOString(),
      });

      if (isJsonMode()) {
        printJson({ result: 'stopped', ...getDaemonStatus() });
      } else {
        console.log(`${chalk.green('✓')} Daemon stopped (pid ${status.pid}).`);
      }
    });

  daemon
    .command('status')
    .description('Report whether the daemon is currently running.')
    .action(() => {
      const status = getDaemonStatus();
      if (isJsonMode()) {
        printJson(status);
        return;
      }
      renderHumanStatus(status);
    });

  daemon
    .command('reload')
    .description('Trigger a hot reload on the running rules-engine daemon.')
    .action(() => {
      const daemonStatus = getDaemonStatus();
      if (daemonStatus.status !== 'running' || daemonStatus.pid === null) {
        persistState({
          status: 'failed',
          failedAt: new Date().toISOString(),
          failureReason: 'No running daemon to reload.',
          lastReloadAt: new Date().toISOString(),
          lastReloadStatus: 'failed',
          lastReloadMessage: 'No running daemon to reload.',
        });
        exitWithError({
          code: 2,
          kind: 'usage',
          message: `No running daemon found (pid file: ${DAEMON_PID_FILE}).`,
        });
      }

      const pidPaths = getDefaultPidFilePaths();
      const rulesPid = readPidFile(pidPaths.pidFile);
      if (rulesPid === null || !isPidAlive(rulesPid)) {
        persistState({
          status: 'failed',
          failedAt: new Date().toISOString(),
          failureReason: 'Rules engine PID is missing or stale.',
          lastReloadAt: new Date().toISOString(),
          lastReloadStatus: 'failed',
          lastReloadMessage: 'Rules engine PID is missing or stale.',
        });
        exitWithError({
          code: 2,
          kind: 'usage',
          message: `No running rules engine found for daemon reload (pid file: ${pidPaths.pidFile}).`,
        });
      }

      let method: 'SIGHUP' | 'sentinel';
      try {
        if (sighupSupported()) {
          process.kill(rulesPid, 'SIGHUP');
          method = 'SIGHUP';
        } else {
          writeReloadSentinel(pidPaths.reloadFile);
          method = 'sentinel';
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        persistState({
          status: 'failed',
          failedAt: new Date().toISOString(),
          failureReason: message,
          lastReloadAt: new Date().toISOString(),
          lastReloadStatus: 'failed',
          lastReloadMessage: message,
        });
        exitWithError({
          code: 1,
          kind: 'runtime',
          message: `Failed to reload daemon: ${message}`,
        });
      }

      persistState({
        status: 'running',
        lastReloadAt: new Date().toISOString(),
        lastReloadStatus: 'ok',
        lastReloadMessage: method === 'SIGHUP'
          ? `Sent SIGHUP to rules engine pid ${rulesPid}.`
          : `Wrote reload sentinel ${pidPaths.reloadFile}.`,
      });
      const status = getDaemonStatus();
      if (isJsonMode()) {
        printJson({ result: 'reloaded', method, ...status });
      } else {
        console.log(`${chalk.green('✓')} Reload requested via ${method}.`);
        if (status.lastReloadMessage) console.log(`  ${status.lastReloadMessage}`);
      }
    });
}
