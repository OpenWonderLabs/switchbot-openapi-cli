/**
 * Cross-platform supervisor glue for `switchbot rules run`.
 *
 * The running engine registers a pid file and a reload sentinel under
 * `~/.switchbot/`; the `switchbot rules reload` subcommand reads them
 * to signal the live process:
 *
 *   - Unix (SIGHUP supported): `process.kill(pid, 'SIGHUP')`.
 *   - Windows (no SIGHUP): write `~/.switchbot/rules.reload`. The engine
 *     polls this path and consumes it, so the same `rules reload`
 *     command works on every platform.
 *
 * The files are tiny (<100 bytes) and created with 0o600; cleanup is
 * best-effort on exit so a crash leaves at most a stale pid the user
 * can overwrite with a fresh `rules run`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_DIR = path.join(os.homedir(), '.switchbot');

export interface PidFilePaths {
  dir: string;
  pidFile: string;
  reloadFile: string;
}

export function getDefaultPidFilePaths(): PidFilePaths {
  return {
    dir: DEFAULT_DIR,
    pidFile: path.join(DEFAULT_DIR, 'rules.pid'),
    reloadFile: path.join(DEFAULT_DIR, 'rules.reload'),
  };
}

/** Write the current process pid. Creates parent dir with 0700 if needed. */
export function writePidFile(pidFile: string, pid = process.pid): void {
  const dir = path.dirname(pidFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidFile, `${pid}\n`, { mode: 0o600 });
}

/** Return the pid persisted in the file, or null if absent / unparseable. */
export function readPidFile(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8').trim();
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Remove the pid file only when it still refers to the current process.
 * A stale file from an earlier run is left alone so we don't accidentally
 * clobber a new supervisor that already won the race.
 */
export function clearPidFile(pidFile: string, pid = process.pid): void {
  try {
    const existing = readPidFile(pidFile);
    if (existing === pid) fs.unlinkSync(pidFile);
  } catch {
    // best effort
  }
}

export function writeReloadSentinel(reloadFile: string): void {
  const dir = path.dirname(reloadFile);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(reloadFile, `${Date.now()}\n`, { mode: 0o600 });
}

export function consumeReloadSentinel(reloadFile: string): boolean {
  try {
    if (!fs.existsSync(reloadFile)) return false;
    fs.unlinkSync(reloadFile);
    return true;
  } catch {
    return false;
  }
}

/** Detect whether SIGHUP is usable on the current platform. */
export function sighupSupported(): boolean {
  return process.platform !== 'win32';
}

/**
 * Check whether a pid is alive — used by `rules reload` to avoid
 * signalling dead pids, which would otherwise leave the user wondering
 * why nothing happened. Node's `process.kill(pid, 0)` throws `ESRCH`
 * for dead pids and `EPERM` for pids we cannot signal (still alive).
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}
