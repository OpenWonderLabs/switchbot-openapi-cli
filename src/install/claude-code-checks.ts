import { spawnSync } from 'node:child_process';

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

const CLAUDE_CMD = 'claude';
const MCP_SERVER_NAME = 'switchbot';
const MCP_ADD_ARGS = ['switchbot', 'mcp', 'serve', '--tools', 'all'];

function spawnStr(cmd: string, args: string[], timeout = 10_000) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf-8',
    shell: process.platform === 'win32',
    timeout,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

// ── Checks ───────────────────────────────────────────────────────────────────

export function checkClaudeCodeCli(): Check {
  const r = spawnStr(CLAUDE_CMD, ['--version'], 8_000);
  if (r.status !== 0 || r.error) {
    return {
      name: 'check-claude-cli',
      status: 'fail',
      detail: 'claude CLI not found on PATH — install Claude Code first (https://claude.ai/claude-code)',
    };
  }
  const version = r.stdout.trim().split('\n')[0] ?? '';
  return {
    name: 'check-claude-cli',
    status: 'ok',
    detail: { version: version || 'unknown' },
  };
}

export function checkMcpRegistered(): Check {
  const r = spawnStr(CLAUDE_CMD, ['mcp', 'list'], 10_000);
  if (r.status !== 0 || r.error) {
    return {
      name: 'check-mcp-registered',
      status: 'fail',
      detail: `claude mcp list failed — is claude CLI installed? (exit ${r.status})`,
    };
  }
  if (!r.stdout.toLowerCase().includes(MCP_SERVER_NAME)) {
    return {
      name: 'check-mcp-registered',
      status: 'fail',
      detail: `"${MCP_SERVER_NAME}" not found in \`claude mcp list\` output`,
    };
  }
  return { name: 'check-mcp-registered', status: 'ok', detail: `${MCP_SERVER_NAME} MCP server registered` };
}

// ── MCP registration ─────────────────────────────────────────────────────────

export function registerMcp(): RegisterMcpResult {
  // Fast path: already registered
  const listR = spawnStr(CLAUDE_CMD, ['mcp', 'list'], 10_000);
  if (listR.status === 0 && !listR.error && listR.stdout.toLowerCase().includes(MCP_SERVER_NAME)) {
    return { ok: true, alreadyRegistered: true };
  }

  // Register via `claude mcp add --scope user switchbot -- switchbot mcp serve --tools all`
  const addR = spawnStr(
    CLAUDE_CMD,
    ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', ...MCP_ADD_ARGS],
    15_000,
  );
  if (addR.status !== 0 || addR.error) {
    return {
      ok: false,
      error: `claude mcp add failed (exit ${addR.status}): ${addR.stderr.trim() || (addR.error?.message ?? '')}`,
    };
  }
  return { ok: true };
}
