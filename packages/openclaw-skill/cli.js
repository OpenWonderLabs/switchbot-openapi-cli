// packages/openclaw-skill/cli.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formatError } from './lib/error-messages.js';

const exec = promisify(execFile);

// Read-only tools that should always bypass the CLI cache. The upstream
// @switchbot/openapi-cli 3.3.0 cache can serve stale values for batch /
// long-lived read paths — forcing --no-cache here absorbs the bug so
// agents and users don't have to remember it per-call. Mutation tools
// must NOT use --no-cache: they're write paths that don't hit the cache
// and passing the flag would just be noise.
const READ_TOOLS = new Set([
  'devices_list',
  'devices_status',
  'devices_describe',
  'scenes_list',
]);

export function buildCliArgs({ tool, params = {} }) {
  const flags = READ_TOOLS.has(tool) ? ['--no-cache', '--json'] : ['--json'];
  switch (tool) {
    case 'devices_list':
      return ['devices', 'list', ...flags];
    case 'devices_status':
      return ['devices', 'status', params.deviceId, ...flags];
    case 'devices_describe':
      return ['devices', 'describe', params.deviceId, ...flags];
    case 'devices_command': {
      const args = ['--audit-log', 'devices', 'command', params.deviceId, params.command, ...flags];
      if (params.params) {
        args.push('--params', JSON.stringify(params.params));
      }
      return args;
    }
    case 'scenes_list':
      return ['scenes', 'list', ...flags];
    case 'scenes_run':
      return ['--audit-log', 'scenes', 'run', params.sceneId, ...flags];
    default:
      throw new Error(`unknown tool: ${tool}`);
  }
}

// Substring patterns that indicate the CLI is installed but lacks
// credentials. We match on text (not a fixed envelope) because auth
// failures surface both from the CLI's own pre-flight checks and from
// the upstream SwitchBot API, and neither path conforms to the v0.2
// envelope in every release.
const AUTH_ERROR_PATTERNS = [
  /token\s+not\s+(set|configured|found)/i,
  /credentials?\s+not\s+(set|configured|found)/i,
  /no\s+credentials/i,
  /\b401\b/,
  /unauthorized/i,
  /missing\s+(token|credentials)/i,
  /switchbot\s+config\s+set-token/i,
];

export function looksLikeAuthError(text) {
  if (!text) return false;
  return AUTH_ERROR_PATTERNS.some((re) => re.test(text));
}

function setupRequired(reason, message) {
  return {
    error: {
      kind: 'setup-required',
      reason,
      message,
      nextStep: 'Run `switchbot-openclaw setup` in a terminal to bootstrap the CLI.',
    },
  };
}

export async function runCli(args) {
  try {
    const { stdout } = await exec('switchbot', args, { timeout: 15000 });
    return JSON.parse(stdout);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return setupRequired(
        'cli-missing',
        formatError('cli-not-installed'),
      );
    }
    const raw = (err && (err.stdout ?? err.stderr ?? err.message)) ?? String(err);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* non-JSON failure */ }

    const envelopeKind = parsed?.error?.kind;
    if (envelopeKind === 'auth' || envelopeKind === 'credentials' || envelopeKind === 'unauthorized') {
      return setupRequired(
        'auth-missing',
        formatError('auth-not-configured'),
      );
    }
    if (!parsed && looksLikeAuthError(raw)) {
      return setupRequired(
        'auth-missing',
        formatError('auth-not-configured'),
      );
    }
    if (parsed) return parsed;
    return { error: { kind: 'internal', message: raw } };
  }
}
