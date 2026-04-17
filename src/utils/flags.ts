/**
 * Read global flags directly from process.argv (same pattern as isJsonMode).
 * Kept simple so subcommand actions don't need to thread program.opts() down.
 */

function getFlagValue(...flagNames: string[]): string | undefined {
  for (const flag of flagNames) {
    const idx = process.argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < process.argv.length) {
      return process.argv[idx + 1];
    }
  }
  return undefined;
}

export function isVerbose(): boolean {
  return process.argv.includes('--verbose') || process.argv.includes('-v');
}

export function isDryRun(): boolean {
  return process.argv.includes('--dry-run');
}

/** HTTP request timeout in milliseconds. Default 30s. */
export function getTimeout(): number {
  const v = getFlagValue('--timeout');
  if (!v) return 30_000;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 30_000;
  return n;
}

/** Override for the credentials file path. */
export function getConfigPath(): string | undefined {
  return getFlagValue('--config');
}
