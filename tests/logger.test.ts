import { describe, it, expect, vi, afterEach } from 'vitest';

describe('logger', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('default log level is "warn" when LOG_LEVEL not set', async () => {
    delete process.env.LOG_LEVEL;
    vi.resetModules();
    const { getLogLevel } = await import('../src/logger.js');
    expect(getLogLevel()).toBe('warn');
  });

  it('LOG_LEVEL=warn silences debug (isLevelEnabled returns false)', async () => {
    process.env.LOG_LEVEL = 'warn';
    vi.resetModules();
    const { log } = await import('../src/logger.js');
    expect(log.isLevelEnabled('debug')).toBe(false);
  });

  it('LOG_LEVEL=debug enables debug (isLevelEnabled returns true)', async () => {
    process.env.LOG_LEVEL = 'debug';
    vi.resetModules();
    const { log } = await import('../src/logger.js');
    expect(log.isLevelEnabled('debug')).toBe(true);
  });

  it('LOG_FORMAT=json produces a pino instance (no transport override)', async () => {
    process.env.LOG_LEVEL = 'info';
    process.env.LOG_FORMAT = 'json';
    vi.resetModules();
    const { log } = await import('../src/logger.js');
    // pino instances have a level property and a child() method
    expect(typeof log.level).toBe('string');
    expect(typeof log.child).toBe('function');
  });

  it('setLogLevel changes the active log level', async () => {
    process.env.LOG_LEVEL = 'warn';
    vi.resetModules();
    const { log, setLogLevel, getLogLevel } = await import('../src/logger.js');
    expect(getLogLevel()).toBe('warn');
    setLogLevel('error');
    expect(log.level).toBe('error');
    expect(getLogLevel()).toBe('error');
  });
});
