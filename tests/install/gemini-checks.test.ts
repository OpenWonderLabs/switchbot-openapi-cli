import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

const existsSyncMock = vi.hoisted(() => vi.fn());
const readFileSyncMock = vi.hoisted(() => vi.fn());
const writeFileSyncMock = vi.hoisted(() => vi.fn());
const mkdirSyncMock = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({
  default: {
    existsSync: existsSyncMock,
    readFileSync: readFileSyncMock,
    writeFileSync: writeFileSyncMock,
    mkdirSync: mkdirSyncMock,
  },
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock,
  mkdirSync: mkdirSyncMock,
}));

import {
  checkGeminiCli,
  checkMcpRegistered,
  registerMcp,
  GEMINI_SETTINGS_PATH,
} from '../../src/install/gemini-checks.js';

beforeEach(() => {
  spawnSyncMock.mockReset();
  existsSyncMock.mockReset();
  readFileSyncMock.mockReset();
  writeFileSyncMock.mockReset();
  mkdirSyncMock.mockReset();
});

// ── checkGeminiCli ────────────────────────────────────────────────────────────

describe('checkGeminiCli', () => {
  it('returns ok with version when gemini exits 0', () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 0, stdout: '0.1.12\n', stderr: '', pid: 1, output: [], signal: null,
    });
    const r = checkGeminiCli();
    expect(r.status).toBe('ok');
    expect((r.detail as Record<string, unknown>).version).toBe('0.1.12');
  });

  it('returns fail when gemini exits non-zero', () => {
    spawnSyncMock.mockReturnValueOnce({
      status: 1, stdout: '', stderr: 'command not found', pid: 1, output: [], signal: null,
    });
    expect(checkGeminiCli().status).toBe('fail');
  });

  it('returns fail when spawnSync returns error (ENOENT)', () => {
    spawnSyncMock.mockReturnValueOnce({
      status: -1, stdout: '', stderr: '', pid: 0, output: [],
      error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }), signal: null,
    });
    const r = checkGeminiCli();
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('not found on PATH');
  });
});

// ── checkMcpRegistered ────────────────────────────────────────────────────────

describe('checkMcpRegistered', () => {
  it('returns fail when settings.json does not exist', () => {
    existsSyncMock.mockReturnValueOnce(false);
    const r = checkMcpRegistered();
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('not found');
  });

  it('returns fail when settings.json has no mcpServers key', () => {
    existsSyncMock.mockReturnValueOnce(true);
    readFileSyncMock.mockReturnValueOnce('{"theme":"dark"}');
    expect(checkMcpRegistered().status).toBe('fail');
  });

  it('returns fail when mcpServers exists but switchbot is absent', () => {
    existsSyncMock.mockReturnValueOnce(true);
    readFileSyncMock.mockReturnValueOnce('{"mcpServers":{"other":{}}}');
    const r = checkMcpRegistered();
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('"switchbot" not found');
  });

  it('returns ok when mcpServers.switchbot is present', () => {
    existsSyncMock.mockReturnValueOnce(true);
    readFileSyncMock.mockReturnValueOnce(
      '{"mcpServers":{"switchbot":{"command":"switchbot","args":["mcp","serve","--tools","all"]}}}',
    );
    expect(checkMcpRegistered().status).toBe('ok');
  });

  it('returns fail when settings.json is malformed JSON', () => {
    existsSyncMock.mockReturnValueOnce(true);
    readFileSyncMock.mockReturnValueOnce('{broken json');
    const r = checkMcpRegistered();
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('not valid JSON');
  });
});

// ── registerMcp ───────────────────────────────────────────────────────────────

describe('registerMcp', () => {
  it('creates settings.json from scratch when file does not exist', () => {
    existsSyncMock.mockReturnValueOnce(false);
    const result = registerMcp();
    expect(result.ok).toBe(true);
    expect(result.alreadyRegistered).toBeUndefined();
    expect(mkdirSyncMock).toHaveBeenCalled();
    const written = writeFileSyncMock.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.mcpServers.switchbot.command).toBe('switchbot');
    expect(parsed.mcpServers.switchbot.args).toEqual(['mcp', 'serve']);
  });

  it('preserves existing top-level keys and other mcpServers entries', () => {
    existsSyncMock.mockReturnValueOnce(true);
    readFileSyncMock.mockReturnValueOnce('{"theme":"dark","mcpServers":{"other":{}}}');
    registerMcp();
    const written = writeFileSyncMock.mock.calls[0]?.[1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.theme).toBe('dark');
    expect(parsed.mcpServers.other).toEqual({});
    expect(parsed.mcpServers.switchbot.command).toBe('switchbot');
  });

  it('returns alreadyRegistered:true and skips write when switchbot already present', () => {
    existsSyncMock.mockReturnValueOnce(true);
    readFileSyncMock.mockReturnValueOnce(
      '{"mcpServers":{"switchbot":{"command":"switchbot","args":["mcp","serve","--tools","all"]}}}',
    );
    const result = registerMcp();
    expect(result.ok).toBe(true);
    expect(result.alreadyRegistered).toBe(true);
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('returns error and does NOT overwrite malformed settings.json', () => {
    existsSyncMock.mockReturnValueOnce(true);
    readFileSyncMock.mockReturnValueOnce('{broken');
    const result = registerMcp();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('invalid JSON');
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('GEMINI_SETTINGS_PATH ends with .gemini/settings.json', () => {
    expect(GEMINI_SETTINGS_PATH).toMatch(/[/\\]\.gemini[/\\]settings\.json$/);
  });
});
