import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function getStateDir(): string {
  return path.join(os.homedir(), '.switchbot');
}

function getDaemonPidFile(): string {
  return path.join(getStateDir(), 'daemon.pid');
}

function getDaemonLogFile(): string {
  return path.join(getStateDir(), 'daemon.log');
}

function getDaemonStateFile(): string {
  return path.join(getStateDir(), 'daemon.state.json');
}

function getHealthzPidFile(): string {
  return path.join(getStateDir(), 'healthz.pid');
}

export const DAEMON_PID_FILE = getDaemonPidFile();
export const DAEMON_LOG_FILE = getDaemonLogFile();
export const DAEMON_STATE_FILE = getDaemonStateFile();
export const HEALTHZ_PID_FILE = getHealthzPidFile();

export interface DaemonState {
  status: 'starting' | 'running' | 'stopped' | 'failed';
  pid: number | null;
  startedAt?: string;
  stoppedAt?: string;
  failedAt?: string;
  failureReason?: string;
  logFile: string;
  pidFile: string;
  stateFile: string;
  healthzPid?: number | null;
  healthzPort?: number | null;
  healthzPidFile?: string;
  lastReloadAt?: string;
  lastReloadStatus?: 'ok' | 'failed';
  lastReloadMessage?: string;
}

function ensureStateDir(): void {
  fs.mkdirSync(getStateDir(), { recursive: true, mode: 0o700 });
}

export function writeDaemonState(state: DaemonState): void {
  ensureStateDir();
  fs.writeFileSync(getDaemonStateFile(), JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function readDaemonState(): DaemonState | null {
  try {
    const raw = fs.readFileSync(getDaemonStateFile(), 'utf-8');
    return JSON.parse(raw) as DaemonState;
  } catch {
    return null;
  }
}

export function removeDaemonState(): void {
  try {
    fs.unlinkSync(getDaemonStateFile());
  } catch {
    // best effort
  }
}
