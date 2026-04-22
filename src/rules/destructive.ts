/**
 * Destructive command parsing — single source of truth shared between the
 * policy validator post-hook (rejects destructive commands inside
 * `automation.rules[].then[].command`) and the runtime executor (second-
 * line guard that refuses to shell out even if validation was bypassed).
 */

export const DESTRUCTIVE_COMMANDS = [
  'lock',
  'unlock',
  'deleteWebhook',
  'deleteScene',
  'factoryReset',
] as const;

export type DestructiveCommand = (typeof DESTRUCTIVE_COMMANDS)[number];

/**
 * Parse the verb out of a rule action command string. The expected form
 * mirrors what the engine will eventually build: `devices command <id> <verb> [args...]`.
 * We also accept scene shorthands (`scenes run <id>`, `webhooks delete <id>`).
 *
 * Returns null for anything we cannot confidently attribute to a known verb
 * slot — the validator treats null as "probably fine, let the engine's own
 * guard handle it if it's not."
 */
export function extractVerb(cmd: string): string | null {
  const trimmed = cmd.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);

  // `devices command <id> <verb> [args]`
  if (tokens[0] === 'devices' && tokens[1] === 'command' && tokens.length >= 4) {
    return tokens[3];
  }
  // `webhooks delete <id>` → verb is "deleteWebhook"
  if (tokens[0] === 'webhooks' && tokens[1] === 'delete') return 'deleteWebhook';
  // `scenes delete <id>` → verb is "deleteScene"
  if (tokens[0] === 'scenes' && tokens[1] === 'delete') return 'deleteScene';
  return null;
}

export function isDestructiveCommand(cmd: string): boolean {
  const verb = extractVerb(cmd);
  if (!verb) return false;
  return (DESTRUCTIVE_COMMANDS as readonly string[]).includes(verb);
}

export function destructiveVerbOf(cmd: string): DestructiveCommand | null {
  const verb = extractVerb(cmd);
  if (verb && (DESTRUCTIVE_COMMANDS as readonly string[]).includes(verb)) {
    return verb as DestructiveCommand;
  }
  return null;
}
