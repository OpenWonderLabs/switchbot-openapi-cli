import { describe, it, expect } from 'vitest';
import { withRequestContext, getActiveProfile, requestContext } from '../../src/lib/request-context.js';

describe('request-context', () => {
  it('returns undefined when no context is active and no CLI flag', () => {
    // No --profile on process.argv in test runner
    expect(getActiveProfile()).toBeUndefined();
  });

  it('returns the profile from the active ALS context', async () => {
    const result = await withRequestContext({ profile: 'alice' }, async () => {
      return getActiveProfile();
    });
    expect(result).toBe('alice');
  });

  it('isolates concurrent contexts (no cross-talk)', async () => {
    const results = await Promise.all([
      withRequestContext({ profile: 'alice' }, async () => {
        // Simulate async I/O between enter and read
        await new Promise((r) => setTimeout(r, 5));
        return getActiveProfile();
      }),
      withRequestContext({ profile: 'bob' }, async () => {
        await new Promise((r) => setTimeout(r, 10));
        return getActiveProfile();
      }),
      withRequestContext({ profile: 'carol' }, async () => {
        return getActiveProfile();
      }),
    ]);
    expect(results).toEqual(['alice', 'bob', 'carol']);
  });

  it('nested contexts: inner wins inside, outer restored after', async () => {
    await withRequestContext({ profile: 'outer' }, async () => {
      expect(getActiveProfile()).toBe('outer');
      await withRequestContext({ profile: 'inner' }, async () => {
        expect(getActiveProfile()).toBe('inner');
      });
      expect(getActiveProfile()).toBe('outer');
    });
  });

  it('context with undefined profile falls back to CLI flag (none in tests)', async () => {
    await withRequestContext({}, async () => {
      expect(getActiveProfile()).toBeUndefined();
    });
  });

  it('exports the underlying AsyncLocalStorage instance for advanced use', () => {
    expect(requestContext).toBeDefined();
    expect(typeof requestContext.run).toBe('function');
    expect(typeof requestContext.getStore).toBe('function');
  });
});
