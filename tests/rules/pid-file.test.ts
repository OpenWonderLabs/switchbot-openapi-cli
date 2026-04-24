import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clearPidFile,
  consumeReloadSentinel,
  getDefaultPidFilePaths,
  isPidAlive,
  readPidFile,
  sighupSupported,
  writePidFile,
  writeReloadSentinel,
} from '../../src/rules/pid-file.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pid-'));
}

describe('pid-file helpers', () => {
  const created: string[] = [];

  afterEach(() => {
    while (created.length > 0) {
      const dir = created.pop()!;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it('getDefaultPidFilePaths anchors under ~/.switchbot', () => {
    const p = getDefaultPidFilePaths();
    expect(p.pidFile).toBe(path.join(os.homedir(), '.switchbot', 'rules.pid'));
    expect(p.reloadFile).toBe(path.join(os.homedir(), '.switchbot', 'rules.reload'));
    expect(p.dir).toBe(path.join(os.homedir(), '.switchbot'));
  });

  it('write → read roundtrip returns the persisted pid', () => {
    const dir = makeTmpDir();
    created.push(dir);
    const pidFile = path.join(dir, 'rules.pid');

    writePidFile(pidFile, 4242);
    expect(readPidFile(pidFile)).toBe(4242);
  });

  it('readPidFile returns null for missing / unparseable files', () => {
    const dir = makeTmpDir();
    created.push(dir);
    const missing = path.join(dir, 'absent.pid');
    expect(readPidFile(missing)).toBeNull();

    const garbage = path.join(dir, 'garbage.pid');
    fs.writeFileSync(garbage, 'not-a-pid\n');
    expect(readPidFile(garbage)).toBeNull();

    const zero = path.join(dir, 'zero.pid');
    fs.writeFileSync(zero, '0\n');
    expect(readPidFile(zero)).toBeNull();
  });

  it('clearPidFile deletes only when the pid matches', () => {
    const dir = makeTmpDir();
    created.push(dir);
    const pidFile = path.join(dir, 'rules.pid');

    writePidFile(pidFile, 1000);
    clearPidFile(pidFile, 2000);
    expect(fs.existsSync(pidFile)).toBe(true);

    clearPidFile(pidFile, 1000);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('clearPidFile is a no-op when the file is absent', () => {
    const dir = makeTmpDir();
    created.push(dir);
    expect(() => clearPidFile(path.join(dir, 'absent.pid'), 1)).not.toThrow();
  });

  it('sentinel write → consume returns true once, then false', () => {
    const dir = makeTmpDir();
    created.push(dir);
    const reloadFile = path.join(dir, 'rules.reload');

    expect(consumeReloadSentinel(reloadFile)).toBe(false);
    writeReloadSentinel(reloadFile);
    expect(fs.existsSync(reloadFile)).toBe(true);
    expect(consumeReloadSentinel(reloadFile)).toBe(true);
    expect(fs.existsSync(reloadFile)).toBe(false);
    expect(consumeReloadSentinel(reloadFile)).toBe(false);
  });

  it('sighupSupported reflects the platform', () => {
    expect(sighupSupported()).toBe(process.platform !== 'win32');
  });

  it('isPidAlive returns true for the current process and false for a dead pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);

    // Spy on process.kill to simulate ESRCH without actually targeting a pid.
    const spy = vi.spyOn(process, 'kill').mockImplementation((_pid, _signal) => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    try {
      expect(isPidAlive(99999999)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('isPidAlive treats EPERM as still-alive (permission-blocked signal)', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation((_pid, _signal) => {
      const err = new Error('not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    try {
      expect(isPidAlive(1)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
