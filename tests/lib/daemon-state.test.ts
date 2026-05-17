import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeDaemonState,
  readDaemonState,
  removeDaemonState,
  type DaemonState,
} from '../../src/lib/daemon-state.js';

describe('daemon-state', () => {
  let tmp: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-daemon-state-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmp);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const SAMPLE: DaemonState = {
    status: 'running',
    pid: 12345,
    startedAt: '2024-01-01T00:00:00Z',
    logFile: '/tmp/daemon.log',
    pidFile: '/tmp/daemon.pid',
    stateFile: '/tmp/daemon.state.json',
  };

  it('writeDaemonState creates the state file under ~/.switchbot', () => {
    writeDaemonState(SAMPLE);
    const stateFile = path.join(tmp, '.switchbot', 'daemon.state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as DaemonState;
    expect(parsed.status).toBe('running');
    expect(parsed.pid).toBe(12345);
  });

  it('readDaemonState returns the persisted state', () => {
    writeDaemonState(SAMPLE);
    const result = readDaemonState();
    expect(result).not.toBeNull();
    expect(result!.status).toBe('running');
    expect(result!.pid).toBe(12345);
  });

  it('readDaemonState returns null when no state file exists', () => {
    const result = readDaemonState();
    expect(result).toBeNull();
  });

  it('removeDaemonState deletes the state file', () => {
    writeDaemonState(SAMPLE);
    const stateFile = path.join(tmp, '.switchbot', 'daemon.state.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    removeDaemonState();
    expect(fs.existsSync(stateFile)).toBe(false);
  });

  it('removeDaemonState is a no-op when the state file does not exist', () => {
    expect(() => removeDaemonState()).not.toThrow();
  });

  it('writeDaemonState creates the .switchbot directory if absent', () => {
    const switchbotDir = path.join(tmp, '.switchbot');
    expect(fs.existsSync(switchbotDir)).toBe(false);
    writeDaemonState(SAMPLE);
    expect(fs.existsSync(switchbotDir)).toBe(true);
  });
});
