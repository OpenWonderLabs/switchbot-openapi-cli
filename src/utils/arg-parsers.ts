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
        `${flagName} must look like "30s", "1m", "500ms", "1h", "7d", "2w" ` +
          `(supported units: ms, s, m, h, d, w — got "${value}")`,
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

export function dateArg(flagName: string): (value: string) => string {
  return (value: string) => {
    if (!DATE_REGEX.test(value)) {
      throw new InvalidArgumentError(
        `${flagName} must be in YYYY-MM-DD format (got "${value}")`,
      );
    }
    if (!isCalendarValidDate(value)) {
      throw new InvalidArgumentError(
        `${flagName} must be in YYYY-MM-DD format (got "${value}")`,
      );
    }
    return value;
  };
}

export function weekArg(flagName: string): (value: string) => string {
  return (value: string) => {
    if (!WEEK_REGEX.test(value)) {
      throw new InvalidArgumentError(
        `${flagName} must be in YYYY-Www format, weeks 01–53 (e.g. 2026-W23 — got "${value}")`,
      );
    }
    if (Number(value.slice(6)) === 53 && !isLongISOYear(Number(value.slice(0, 4)))) {
      throw new InvalidArgumentError(
        `${flagName}: ${value.slice(0, 4)} only has 52 ISO weeks; W53 does not exist for this year`,
      );
    }
    return value;
  };
}

/**
 * Shared ISO date and ISO week regexes — also imported by the mindclip MCP
 * tool zod schemas so CLI and MCP validation accept the exact same surface.
 */
export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
export const WEEK_REGEX = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;

/**
 * Reject impossible calendar dates that match DATE_REGEX (e.g. 2026-13-50,
 * 2026-02-30). Round-trips through Date so leap years stay correct.
 */
export function isCalendarValidDate(value: string): boolean {
  const d = new Date(value);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Returns true for ISO "long years" — years that have 53 ISO weeks.
 * A year is long when Jan 1 falls on Thursday, or it is a leap year
 * whose Jan 1 falls on Wednesday.
 */
export function isLongISOYear(year: number): boolean {
  const jan1Day = new Date(year, 0, 1).getDay(); // 0=Sun … 6=Sat
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return jan1Day === 4 || (isLeap && jan1Day === 3);
}
