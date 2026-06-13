/**
 * Asserts `claude-code-checks.registerMcp` invokes `claude mcp add` with the
 * default-profile args (`mcp serve`, no `--tools all`). The v3.8.0
 * consolidation moved admin tools (policy / audit / rules) behind opt-in;
 * this test guards against accidentally re-adding `--tools all` to the
 * `claude mcp add ...` command line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

import { registerMcp } from '../../src/install/claude-code-checks.js';

beforeEach(() => {
  spawnSyncMock.mockReset();
});

describe('claude-code-checks.registerMcp', () => {
  it('invokes `claude mcp add` with the default profile (no --tools all)', () => {
    // First spawnSync call is `claude mcp list`; return "not registered yet".
    spawnSyncMock.mockReturnValueOnce({
      status: 0, stdout: 'no servers', stderr: '', pid: 1, output: [], signal: null,
    });
    // Second call is `claude mcp add ...`; succeed.
    spawnSyncMock.mockReturnValueOnce({
      status: 0, stdout: '', stderr: '', pid: 1, output: [], signal: null,
    });

    const result = registerMcp();
    expect(result.ok).toBe(true);
    expect(result.alreadyRegistered).toBeUndefined();

    // Inspect the `claude mcp add` invocation (second call).
    const addCall = spawnSyncMock.mock.calls[1];
    expect(addCall, 'expected a second spawnSync call for `claude mcp add`').toBeDefined();
    const [cmd, args] = addCall as [string, string[], unknown];
    expect(cmd).toBe('claude');
    // `claude mcp add --scope user switchbot -- switchbot mcp serve`
    expect(args).toEqual(['mcp', 'add', '--scope', 'user', 'switchbot', '--', 'switchbot', 'mcp', 'serve']);
    expect(args, 'must NOT include --tools all').not.toContain('--tools');
    expect(args, 'must NOT include "all" as a positional token').not.toContain('all');
  });

  it('returns alreadyRegistered:true when `claude mcp list` already lists switchbot', () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0, stdout: 'switchbot: registered', stderr: '', pid: 1, output: [], signal: null,
    });
    const result = registerMcp();
    expect(result.ok).toBe(true);
    expect(result.alreadyRegistered).toBe(true);
    // Only one spawn call: the `claude mcp list` probe; no `claude mcp add`.
    expect(spawnSyncMock.mock.calls).toHaveLength(1);
  });
});
