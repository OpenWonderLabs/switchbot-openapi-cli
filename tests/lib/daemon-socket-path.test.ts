import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// We import the module statically — platform is read at call time, not load
// time, so we can stub process.platform before each test call.
import {
  getDaemonSocketPath,
  isDaemonSocketAvailable,
} from '../../src/daemon/socket-path.js';

const TEST_HOME = '/home/testuser';

describe('daemon/socket-path', () => {
  let originalPlatformDescriptor: PropertyDescriptor | undefined;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(TEST_HOME);
    // Ensure USERNAME env var is set so the win32 tests use a predictable key.
    process.env.USERNAME = 'testuser';
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    homedirSpy.mockRestore();
    vi.restoreAllMocks();
    delete process.env.USERNAME;
  });

  describe('getDaemonSocketPath()', () => {
    it('returns a named-pipe path on win32', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
        writable: false,
      });

      const result = getDaemonSocketPath();

      // Named pipes start with \\.\
      expect(result).toMatch(/^\\\\\.\\/);
      expect(result).toContain('switchbot-daemon-');
    });

    it('returns a POSIX unix-socket path on linux', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
        writable: false,
      });

      const result = getDaemonSocketPath();

      expect(result).toBe(path.join(TEST_HOME, '.switchbot', 'daemon.sock'));
    });
  });

  describe('isDaemonSocketAvailable()', () => {
    it('always returns true on win32', () => {
      Object.defineProperty(process, 'platform', {
        value: 'win32',
        configurable: true,
        writable: false,
      });

      expect(isDaemonSocketAvailable('\\\\.\\pipe\\switchbot-daemon-testuser')).toBe(true);
    });

    it('returns true on POSIX when the socket file exists', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
        writable: false,
      });

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      const socketPath = path.join(TEST_HOME, '.switchbot', 'daemon.sock');
      expect(isDaemonSocketAvailable(socketPath)).toBe(true);
    });

    it('returns false on POSIX when the socket file does not exist', () => {
      Object.defineProperty(process, 'platform', {
        value: 'linux',
        configurable: true,
        writable: false,
      });

      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const socketPath = path.join(TEST_HOME, '.switchbot', 'daemon.sock');
      expect(isDaemonSocketAvailable(socketPath)).toBe(false);
    });
  });
});
