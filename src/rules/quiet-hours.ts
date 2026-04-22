/**
 * Time-window helpers shared by `time_between` conditions and (later)
 * the top-level `quiet_hours` block. Both evaluate a local-clock HH:MM
 * range that may cross midnight.
 */

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface TimeWindow {
  start: string;
  end: string;
}

function toMinutes(hhmm: string): number {
  if (!HHMM.test(hhmm)) {
    throw new Error(`Invalid HH:MM value: "${hhmm}"`);
  }
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesOf(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * `true` when `now` falls inside the window. If `start > end` the window
 * is interpreted as overnight (e.g. 22:00 → 07:00 crosses midnight).
 *
 * Boundary semantics: start is inclusive, end is exclusive. A window of
 * 09:00 → 09:00 therefore matches nothing — callers who want "always"
 * should omit the condition entirely rather than fake it with equal
 * times.
 */
export function isWithin(window: TimeWindow, now: Date): boolean {
  const s = toMinutes(window.start);
  const e = toMinutes(window.end);
  const n = minutesOf(now);
  if (s === e) return false;
  if (s < e) return n >= s && n < e;
  return n >= s || n < e;
}

/** Convenience wrapper that accepts the schema's tuple shape. */
export function isWithinTuple(range: [string, string], now: Date): boolean {
  return isWithin({ start: range[0], end: range[1] }, now);
}

/** Top-level quiet_hours block helper — same math, schema shape differs. */
export function isInQuietHours(
  qh: { start?: string; end?: string } | null | undefined,
  now: Date,
): boolean {
  if (!qh?.start || !qh.end) return false;
  return isWithin({ start: qh.start, end: qh.end }, now);
}
