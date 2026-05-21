/**
 * Shared test utilities for MCP tool tests.
 */

/**
 * Extract the structured JSON block from an mcpError content[0].text.
 *
 * mcpError() formats text as:
 *   <kind> error (code N): <message>
 *   [optional hint]
 *   --- structured ---
 *   { "error": { ... } }
 *
 * Falls back to JSON.parse(text) for non-error text (no delimiter present).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseErrorText(text: string): any {
  const marker = '--- structured ---\n';
  const idx = text.indexOf(marker);
  if (idx === -1) return JSON.parse(text);
  return JSON.parse(text.slice(idx + marker.length));
}
