import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string | Record<string, unknown>;
}

export interface RegisterMcpResult {
  ok: boolean;
  alreadyRegistered?: boolean;
  error?: string;
}

export const GEMINI_SETTINGS_PATH = path.join(os.homedir(), '.gemini', 'settings.json');
const GEMINI_CMD = 'gemini';
const MCP_SERVER_NAME = 'switchbot';

function spawnStr(cmd: string, args: string[], timeout = 10_000) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

// ── Checks ───────────────────────────────────────────────────────────────────

export function checkGeminiCli(): Check {
  const r = spawnStr(GEMINI_CMD, ['--version'], 8_000);
  if (r.status !== 0 || r.error) {
    return {
      name: 'check-gemini-cli',
      status: 'fail',
      detail: 'gemini CLI not found on PATH — install: https://github.com/google-gemini/gemini-cli',
    };
  }
  const version = r.stdout.trim().split('\n')[0] ?? '';
  return { name: 'check-gemini-cli', status: 'ok', detail: { version: version || 'unknown' } };
}

export function checkMcpRegistered(): Check {
  if (!fs.existsSync(GEMINI_SETTINGS_PATH)) {
    return {
      name: 'check-mcp-registered',
      status: 'fail',
      detail: `~/.gemini/settings.json not found — run: switchbot gemini setup`,
    };
  }
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {
      name: 'check-mcp-registered',
      status: 'fail',
      detail: `~/.gemini/settings.json exists but is not valid JSON`,
    };
  }
  const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
  if (!mcpServers?.[MCP_SERVER_NAME]) {
    return {
      name: 'check-mcp-registered',
      status: 'fail',
      detail: `"${MCP_SERVER_NAME}" not found in ~/.gemini/settings.json mcpServers`,
    };
  }
  return { name: 'check-mcp-registered', status: 'ok', detail: `${MCP_SERVER_NAME} MCP server registered` };
}

// ── MCP registration ─────────────────────────────────────────────────────────

export function registerMcp(): RegisterMcpResult {
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(GEMINI_SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(GEMINI_SETTINGS_PATH, 'utf-8')) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        error: `~/.gemini/settings.json exists but contains invalid JSON — fix or delete it, then re-run`,
      };
    }
  }
  const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;
  if (mcpServers[MCP_SERVER_NAME]) {
    return { ok: true, alreadyRegistered: true };
  }
  settings.mcpServers = {
    ...mcpServers,
    [MCP_SERVER_NAME]: {
      command: 'switchbot',
      args: ['mcp', 'serve', '--tools', 'all'],
      description: 'SwitchBot smart-home MCP server (31 tools)',
    },
  };
  fs.mkdirSync(path.dirname(GEMINI_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return { ok: true };
}
