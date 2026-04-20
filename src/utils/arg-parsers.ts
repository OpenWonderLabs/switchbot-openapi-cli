import { InvalidArgumentError } from 'commander';
import { parseDurationToMs } from './flags.js';

/**
 * Commander argParser callbacks that fail fast when a required-value flag
 * swallows the next token (another flag, a subcommand name, etc.) — the
 * default Commander behavior is to take the next argv token verbatim.
 *
 * Use `--flag=<val>` form to pass values that legitimately start with `--`.
 */

export function intArg(
  flagName: string,
  opts?: { min?: number; max?: number },
): (value: string) => string {
  return (value: string) => {
    // Flag-like tokens (`--something`, `-x`) are rejected up-front.
    // Pure negative integers (`-1`, `-42`) fall through to min/max so the
    // error classifies as a range error rather than "requires a numeric value".
    if (value.startsWith('-') && !/^-\d+$/.test(value)) {
      throw new InvalidArgumentError(
        `${flagName} requires a numeric value, got "${value}". ` +
          `Did you forget a value? Use ${flagName}=<n> if the value really starts with "-".`,
      );
    }
    const n = Number(value);
    if (!Number.isInteger(n)) {
      throw new InvalidArgumentError(`${flagName} must be an integer (got "${value}")`);
    }
    if (opts?.min !== undefined && n < opts.min) {
      throw new InvalidArgumentError(`${flagName} must be >= ${opts.min} (got "${value}")`);
    }
    if (opts?.max !== undefined && n > opts.max) {
      throw new InvalidArgumentError(`${flagName} must be <= ${opts.max} (got "${value}")`);
    }
    return String(n);
  };
}

export function durationArg(flagName: string): (value: string) => string {
  return (value: string) => {
    if (value.startsWith('-')) {
      throw new InvalidArgumentError(
        `${flagName} requires a duration value, got "${value}". ` +
          `Use ${flagName}=<dur> if the value really starts with "-".`,
      );
    }
    const ms = parseDurationToMs(value);
    if (ms === null) {
      throw new InvalidArgumentError(
        `${flagName} must look like "30s", "1m", "500ms", "1h" (got "${value}")`,
      );
    }
    return value;
  };
}

export function stringArg(
  flagName: string,
  opts?: { disallow?: readonly string[] },
): (value: string) => string {
  return (value: string) => {
    if (value.startsWith('--')) {
      throw new InvalidArgumentError(
        `${flagName} requires a value. "${value}" looks like another option — ` +
          `did you forget the value? Use ${flagName}=<val> if your value really starts with "--".`,
      );
    }
    if (opts?.disallow?.includes(value)) {
      throw new InvalidArgumentError(
        `${flagName} requires a value but got "${value}", which is a subcommand name. ` +
          `Did you forget the value? Use ${flagName}=<val> or put ${flagName} after the subcommand.`,
      );
    }
    return value;
  };
}

export function enumArg(
  flagName: string,
  allowed: readonly string[],
): (value: string) => string {
  return (value: string) => {
    if (!allowed.includes(value)) {
      throw new InvalidArgumentError(
        `${flagName} must be one of: ${allowed.join(', ')} (got "${value}")`,
      );
    }
    return value;
  };
}
