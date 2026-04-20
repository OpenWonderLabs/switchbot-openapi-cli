/**
 * Header/value redaction utilities for verbose traces.
 *
 * C6 contract: any header whose name matches a sensitive pattern is mid-masked
 * (first 2 chars + `*` run + last 2 chars) before it is written to stderr. The
 * `--trace-unsafe` flag turns masking off — with a prominent one-time warning.
 */

import { isTraceUnsafe } from './flags.js';

const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^token$/i,
  /^sign$/i,
  /^nonce$/i,
  /^x-api-key$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /^x-auth-token$/i,
];

// The `t` header (timestamp) is treated as sensitive alongside sign because
// together they reconstruct the HMAC signature — anyone watching the logs
// shouldn't be able to replay the exact timestamp that was used.
const SENSITIVE_EXACT_KEYS = new Set(['t']);

export function isSensitiveHeader(name: string): boolean {
  if (SENSITIVE_EXACT_KEYS.has(name)) return true;
  return SENSITIVE_HEADER_PATTERNS.some((re) => re.test(name));
}

export function maskValue(value: string): string {
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-2)}`;
}

/**
 * Redact the sensitive entries of a headers object. Returns a new object
 * alongside the count of entries that were masked.
 */
export function redactHeaders(
  headers: Record<string, unknown> | undefined,
): { safe: Record<string, string>; redactedCount: number } {
  const safe: Record<string, string> = {};
  let redactedCount = 0;
  if (!headers) return { safe, redactedCount };
  const unsafe = isTraceUnsafe();
  for (const [k, v] of Object.entries(headers)) {
    const strVal = typeof v === 'string' ? v : v == null ? '' : String(v);
    if (!unsafe && isSensitiveHeader(k)) {
      safe[k] = maskValue(strVal);
      redactedCount++;
    } else {
      safe[k] = strVal;
    }
  }
  return { safe, redactedCount };
}

let unsafeBannerShown = false;
/**
 * Print the big "REDACTION DISABLED" banner once per process when
 * --trace-unsafe is on. Callers should invoke this once before any
 * header-spilling output.
 */
export function warnOnceIfUnsafe(): void {
  if (unsafeBannerShown) return;
  if (!isTraceUnsafe()) return;
  unsafeBannerShown = true;
  process.stderr.write(
    '⚠️  --trace-unsafe: sensitive headers will be printed UNMASKED. Do not share this output.\n',
  );
}
