export const ERRORS = {
  'auth-not-configured': {
    reason: 'SwitchBot credentials are not configured.',
    fix:    'switchbot auth login',
    hint:   'Run the fix command, then restart your MCP client.',
  },
  'auth-login-failed': {
    reason: 'Login failed — the CLI returned a non-zero exit code.',
    fix:    'switchbot auth login',
    hint:   'Check your network connection and try again.',
  },
  'token-expired': {
    reason: 'Credentials exist but doctor check failed — token may be expired.',
    fix:    'switchbot auth logout && switchbot auth login',
    hint:   'After re-login, run `switchbot doctor` to verify.',
  },
  'cli-not-installed': {
    reason: 'switchbot CLI is not installed or not in PATH.',
    fix:    'npm install -g @switchbot/openapi-cli',
    hint:   'After install, run `switchbot doctor` to confirm.',
  },
  'cli-version-too-low': {
    reason: 'switchbot CLI version is below the required minimum (3.7.1).',
    fix:    'npm install -g @switchbot/openapi-cli@latest',
    hint:   'After upgrade, re-run setup.',
  },
};

export function formatError(key) {
  const e = ERRORS[key];
  if (!e) throw new Error(`unknown error key: ${key}`);
  return [
    `Error: ${e.reason}`,
    `  Fix:  ${e.fix}`,
    `  Hint: ${e.hint}`,
  ].join('\n');
}
