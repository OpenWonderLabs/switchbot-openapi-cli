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

/**
 * Max 429 retries before surfacing the error. Default 3. `--no-retry`
 * disables retries entirely; `--retry-on-429 <n>` overrides the count.
 */
export function getRetryOn429(): number {
  if (process.argv.includes('--no-retry')) return 0;
  const v = getFlagValue('--retry-on-429');
  if (v === undefined) return 3;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 3;
  return Math.floor(n);
}

/** Backoff strategy for 429 retries. Default 'exponential'. */
export function getBackoffStrategy(): 'linear' | 'exponential' {
  const v = getFlagValue('--backoff');
  if (v === 'linear') return 'linear';
  return 'exponential';
}

/**
 * Whether local quota counting is disabled. Quota counting is best-effort
 * (see src/utils/quota.ts) — this lets scripts opt out entirely when even
 * best-effort file I/O is unwelcome.
 */
export function isQuotaDisabled(): boolean {
  return process.argv.includes('--no-quota');
}
