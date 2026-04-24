import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tryLoadConfig } from '../config.js';
import { getActiveProfile } from '../lib/request-context.js';
import { UsageError } from '../utils/output.js';
import { getConfigPath } from '../utils/flags.js';

const DEFAULT_OPENCLAW_URL = 'http://localhost:18789';

export interface StatusSyncPaths {
  stateDir: string;
  stateFile: string;
  stdoutLog: string;
  stderrLog: string;
}

interface StatusSyncStateFile {
  pid: number;
  startedAt: string;
  command: string[];
  openclawUrl: string;
  openclawModel: string;
  topic: string | null;
  configPath: string | null;
  profile: string | null;
  stdoutLog: string;
  stderrLog: string;
}

export interface StatusSyncStatus {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  stateDir: string;
  stateFile: string;
  stdoutLog: string;
  stderrLog: string;
  command: string[] | null;
  openclawUrl: string | null;
  openclawModel: string | null;
  topic: string | null;
  configPath: string | null;
  profile: string | null;
}

export interface StopStatusSyncResult {
  stopped: boolean;
  stale: boolean;
  pid: number | null;
  status: StatusSyncStatus;
}

export interface StartStatusSyncOptions {
  openclawUrl?: string;
  openclawToken?: string;
  openclawModel?: string;
  topic?: string;
  stateDir?: string;
  force?: boolean;
}

export interface StatusSyncStatusOptions {
  stateDir?: string;
}

function resolveStatusSyncRuntime(options: {
  openclawUrl?: string;
  openclawToken?: string;
  openclawModel?: string;
  topic?: string;
}): { openclawUrl: string; openclawToken: string; openclawModel: string; topic?: string } {
  if (!tryLoadConfig()) {
    throw new UsageError(
      'No credentials found. Run \'switchbot config set-token\' or set SWITCHBOT_TOKEN and SWITCHBOT_SECRET.',
    );
  }

  const openclawToken = options.openclawToken ?? process.env.OPENCLAW_TOKEN;
  if (!openclawToken) {
    throw new UsageError('--openclaw-token is required or set OPENCLAW_TOKEN in the environment.');
  }

  const openclawModel = options.openclawModel ?? process.env.OPENCLAW_MODEL;
  if (!openclawModel) {
    throw new UsageError('--openclaw-model is required or set OPENCLAW_MODEL in the environment.');
  }

  return {
    openclawUrl: options.openclawUrl ?? process.env.OPENCLAW_URL ?? DEFAULT_OPENCLAW_URL,
    openclawToken,
    openclawModel,
    ...(options.topic ? { topic: options.topic } : {}),
  };
}

export function resolveStatusSyncPaths(explicitStateDir?: string): StatusSyncPaths {
  const stateDir = path.resolve(
    explicitStateDir
      ?? process.env.SWITCHBOT_STATUS_SYNC_HOME
      ?? path.join(os.homedir(), '.switchbot', 'status-sync'),
  );
  return {
    stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    stdoutLog: path.join(stateDir, 'stdout.log'),
    stderrLog: path.join(stateDir, 'stderr.log'),
  };
}

export function buildStatusSyncChildArgs(options: {
  openclawUrl: string;
  openclawModel: string;
  topic?: string;
}): string[] {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error('Cannot determine the current CLI entrypoint path.');
  }

  const args = [path.resolve(scriptPath)];
  const configPath = getConfigPath();
  const profile = getActiveProfile();

  if (configPath) {
    args.push('--config', path.resolve(configPath));
  } else if (profile) {
    args.push('--profile', profile);
  }

  args.push(
    'events',
    'mqtt-tail',
    '--sink',
    'openclaw',
    '--openclaw-url',
    options.openclawUrl,
    '--openclaw-model',
    options.openclawModel,
  );

  if (options.topic) {
    args.push('--topic', options.topic);
  }

  return args;
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // best-effort cleanup
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

function readStateFile(paths: StatusSyncPaths): StatusSyncStateFile | null {
  if (!fs.existsSync(paths.stateFile)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(paths.stateFile, 'utf-8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      safeUnlink(paths.stateFile);
      return null;
    }
    const parsed = raw as Partial<StatusSyncStateFile>;
    if (
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid < 1 ||
      typeof parsed.startedAt !== 'string' ||
      !Array.isArray(parsed.command) ||
      typeof parsed.stdoutLog !== 'string' ||
      typeof parsed.stderrLog !== 'string'
    ) {
      safeUnlink(paths.stateFile);
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      command: parsed.command.map(String),
      openclawUrl: typeof parsed.openclawUrl === 'string' ? parsed.openclawUrl : DEFAULT_OPENCLAW_URL,
      openclawModel: typeof parsed.openclawModel === 'string' ? parsed.openclawModel : '',
      topic: typeof parsed.topic === 'string' ? parsed.topic : null,
      configPath: typeof parsed.configPath === 'string' ? parsed.configPath : null,
      profile: typeof parsed.profile === 'string' ? parsed.profile : null,
      stdoutLog: parsed.stdoutLog,
      stderrLog: parsed.stderrLog,
    };
  } catch {
    safeUnlink(paths.stateFile);
    return null;
  }
}

function toStatus(paths: StatusSyncPaths, state: StatusSyncStateFile | null, running: boolean): StatusSyncStatus {
  return {
    running,
    pid: running && state ? state.pid : null,
    startedAt: running && state ? state.startedAt : null,
    stateDir: paths.stateDir,
    stateFile: paths.stateFile,
    stdoutLog: state?.stdoutLog ?? paths.stdoutLog,
    stderrLog: state?.stderrLog ?? paths.stderrLog,
    command: running && state ? state.command : null,
    openclawUrl: running && state ? state.openclawUrl : null,
    openclawModel: running && state ? state.openclawModel : null,
    topic: running && state ? state.topic : null,
    configPath: running && state ? state.configPath : null,
    profile: running && state ? state.profile : null,
  };
}

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    if (result.error) throw result.error;
    if (result.status !== 0 && isProcessRunning(pid)) {
      throw new Error(`Failed to stop status-sync process tree (PID ${pid}).`);
    }
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return;
    }
    process.kill(pid, 'SIGTERM');
  }
}

export function getStatusSyncStatus(options: StatusSyncStatusOptions = {}): StatusSyncStatus {
  const paths = resolveStatusSyncPaths(options.stateDir);
  const state = readStateFile(paths);
  if (!state) {
    return toStatus(paths, null, false);
  }

  if (!isProcessRunning(state.pid)) {
    safeUnlink(paths.stateFile);
    return toStatus(paths, null, false);
  }

  return toStatus(paths, state, true);
}

export function stopStatusSync(options: StatusSyncStatusOptions = {}): StopStatusSyncResult {
  const paths = resolveStatusSyncPaths(options.stateDir);
  const state = readStateFile(paths);
  if (!state) {
    return {
      stopped: false,
      stale: false,
      pid: null,
      status: toStatus(paths, null, false),
    };
  }

  if (!isProcessRunning(state.pid)) {
    safeUnlink(paths.stateFile);
    return {
      stopped: false,
      stale: true,
      pid: state.pid,
      status: toStatus(paths, null, false),
    };
  }

  killProcessTree(state.pid);
  if (isProcessRunning(state.pid)) {
    throw new Error(`Failed to stop status-sync process (PID ${state.pid}); process is still running.`);
  }
  safeUnlink(paths.stateFile);
  return {
    stopped: true,
    stale: false,
    pid: state.pid,
    status: toStatus(paths, null, false),
  };
}

export function startStatusSync(options: StartStatusSyncOptions = {}): StatusSyncStatus {
  const runtime = resolveStatusSyncRuntime(options);
  const paths = resolveStatusSyncPaths(options.stateDir);
  const existing = getStatusSyncStatus({ stateDir: paths.stateDir });

  if (existing.running) {
    if (!options.force) {
      throw new UsageError(
        `status-sync is already running (PID ${existing.pid}). Run 'switchbot status-sync stop' first or re-run with --force.`,
      );
    }
    stopStatusSync({ stateDir: paths.stateDir });
  }

  fs.mkdirSync(paths.stateDir, { recursive: true });
  const configPath = getConfigPath();
  const command = buildStatusSyncChildArgs(runtime);

  let stdoutFd: number | null = null;
  let stderrFd: number | null = null;
  try {
    stdoutFd = fs.openSync(paths.stdoutLog, 'a');
    stderrFd = fs.openSync(paths.stderrLog, 'a');

    const child = spawn(process.execPath, command, {
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
      windowsHide: true,
      env: { ...process.env, OPENCLAW_TOKEN: runtime.openclawToken },
    });

    if (!child.pid) {
      throw new Error('Failed to start status-sync child process.');
    }
    child.unref();

    const state: StatusSyncStateFile = {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      command: [process.execPath, ...command],
      openclawUrl: runtime.openclawUrl,
      openclawModel: runtime.openclawModel,
      topic: runtime.topic ?? null,
      configPath: configPath ? path.resolve(configPath) : null,
      profile: configPath ? null : (getActiveProfile() ?? null),
      stdoutLog: paths.stdoutLog,
      stderrLog: paths.stderrLog,
    };
    fs.writeFileSync(paths.stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    return toStatus(paths, state, true);
  } finally {
    if (stdoutFd !== null) fs.closeSync(stdoutFd);
    if (stderrFd !== null) fs.closeSync(stderrFd);
  }
}

export async function runStatusSyncForeground(options: Omit<StartStatusSyncOptions, 'stateDir' | 'force'> = {}): Promise<number> {
  const runtime = resolveStatusSyncRuntime(options);
  const command = buildStatusSyncChildArgs(runtime);

  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, command, {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, OPENCLAW_TOKEN: runtime.openclawToken },
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}
