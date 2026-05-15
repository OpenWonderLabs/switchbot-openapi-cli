import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Returns the IPC endpoint path for the daemon. POSIX gets a Unix domain
 * socket inside `~/.switchbot/`; Windows gets a per-user named pipe whose
 * default ACL only grants the creating user access.
 *
 * The exact form is what `net.createServer(path)` accepts on each platform.
 */
export function getDaemonSocketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\switchbot-daemon-${getCurrentUserKey()}`;
  }
  return path.join(os.homedir(), '.switchbot', 'daemon.sock');
}

/**
 * Returns true when the supplied path exists and is in a state where the
 * daemon could legitimately bind to it. On POSIX this means the socket file
 * exists; on Windows we always return true because named pipe presence is
 * not observable through the filesystem.
 */
export function isDaemonSocketAvailable(socketPath: string): boolean {
  if (process.platform === 'win32') return true;
  try {
    return fs.existsSync(socketPath);
  } catch {
    return false;
  }
}

let cachedUserKey: string | null = null;

function getCurrentUserKey(): string {
  if (cachedUserKey) return cachedUserKey;
  const fromEnv = process.env.USERNAME ?? process.env.USER;
  if (fromEnv) {
    cachedUserKey = sanitize(fromEnv);
    return cachedUserKey;
  }
  try {
    const userInfo = os.userInfo();
    cachedUserKey = sanitize(userInfo.username);
    return cachedUserKey;
  } catch { /* fall through */ }
  try {
    const out = execSync('whoami', { encoding: 'utf-8', timeout: 2_000 }).trim();
    cachedUserKey = sanitize(out.split(/[\\\/]/).pop() ?? 'unknown');
    return cachedUserKey;
  } catch {
    cachedUserKey = 'unknown';
    return cachedUserKey;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';
}
