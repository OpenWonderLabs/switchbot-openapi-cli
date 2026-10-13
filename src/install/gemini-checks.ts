import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { TOOL_PROFILES } from '../mcp/tool-profiles.js';

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

const GEMINI_EXTENSIONS_PATH = path.join(os.homedir(), '.gemini', 'extensions');
const EXTENSION_ENABLEMENT_PATH = path.join(GEMINI_EXTENSIONS_PATH, 'extension-enablement.json');

function normalizeDirectory(value: string): string {
  const forwardSlashes = value.split(String.fromCharCode(92)).join('/');
  const withLeadingSlash = forwardSlashes.startsWith('/') ? forwardSlashes : '/' + forwardSlashes;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : withLeadingSlash + '/';
}

function isExtensionEnabled(): boolean {
  if (!fs.existsSync(EXTENSION_ENABLEMENT_PATH)) return true;
  try {
    const config: unknown = JSON.parse(fs.readFileSync(EXTENSION_ENABLEMENT_PATH, 'utf-8'));
    if (!config || typeof config !== 'object' || !(MCP_SERVER_NAME in config)) return true;
    const entry = config[MCP_SERVER_NAME];
    if (!entry || typeof entry !== 'object' || !('overrides' in entry)) return true;
    const { overrides } = entry;
    if (!Array.isArray(overrides) || !overrides.every((rule) => typeof rule === 'string')) return true;

    const currentDirectory = normalizeDirectory(process.cwd());
    let enabled = true;
    for (const rule of overrides) {
      const disabled = rule.startsWith('!');
      const pattern = disabled ? rule.slice(1) : rule;
      const includesSubdirectories = pattern.endsWith('*');
      const baseDirectory = normalizeDirectory(includesSubdirectories ? pattern.slice(0, -1) : pattern);
      if ((includesSubdirectories && currentDirectory.startsWith(baseDirectory)) || currentDirectory === baseDirectory) {
        enabled = !disabled;
      }
    }
    return enabled;
  } catch {
    return true;
  }
}

function extensionMcpState(): 'active' | 'disabled' | 'absent' {
  const manifestPath = path.join(GEMINI_EXTENSIONS_PATH, MCP_SERVER_NAME, 'gemini-extension.json');
  if (!fs.existsSync(manifestPath)) return 'absent';
  try {
    const extension: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    if (!extension || typeof extension !== 'object' || !('mcpServers' in extension)) return 'absent';
    const { mcpServers } = extension;
    if (!mcpServers || typeof mcpServers !== 'object' || !(MCP_SERVER_NAME in mcpServers)) return 'absent';
    return isExtensionEnabled() ? 'active' : 'disabled';
  } catch {
    return 'absent';
  }
}

export function checkMcpRegistered(): Check {
  if (!fs.existsSync(GEMINI_SETTINGS_PATH)) {
    const extensionState = extensionMcpState();
    if (extensionState === 'active') {
      return { name: 'check-mcp-registered', status: 'ok', detail: MCP_SERVER_NAME + ' MCP server provided by installed Gemini extension' };
    }
    if (extensionState === 'disabled') {
      return { name: 'check-mcp-registered', status: 'fail', detail: MCP_SERVER_NAME + ' Gemini extension is disabled for the current workspace' };
    }
    return {
      name: 'check-mcp-registered',
      status: 'fail',
      detail: '~/.gemini/settings.json not found — run: switchbot gemini setup',
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
    const extensionState = extensionMcpState();
    if (extensionState === 'active') {
      return { name: 'check-mcp-registered', status: 'ok', detail: MCP_SERVER_NAME + ' MCP server provided by installed Gemini extension' };
    }
    if (extensionState === 'disabled') {
      return { name: 'check-mcp-registered', status: 'fail', detail: MCP_SERVER_NAME + ' Gemini extension is disabled for the current workspace' };
    }
    return {
      name: 'check-mcp-registered',
      status: 'fail',
      detail: `"${MCP_SERVER_NAME}" not found in ~/.gemini/settings.json mcpServers`,
    };
  }
  if (extensionMcpState() === 'active') {
    return { name: 'check-mcp-registered', status: 'warn', detail: MCP_SERVER_NAME + ' user MCP settings take precedence over the active Gemini extension' };
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
  if (mcpServers[MCP_SERVER_NAME] || extensionMcpState() === 'active') {
    return { ok: true, alreadyRegistered: true };
  }
  settings.mcpServers = {
    ...mcpServers,
    [MCP_SERVER_NAME]: {
      command: 'switchbot',
      args: ['mcp', 'serve'],
      description: `SwitchBot smart-home MCP server (default: ${TOOL_PROFILES.default.size} tools; \`--tools all\` for ${TOOL_PROFILES.all.size})`,
    },
  };
  fs.mkdirSync(path.dirname(GEMINI_SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return { ok: true };
}
