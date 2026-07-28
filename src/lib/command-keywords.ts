export const COMMAND_KEYWORDS: Array<{ pattern: RegExp; command: string }> = [
  // Compound patterns FIRST — disambiguate open+lock before single-word rules fire
  { pattern: /\bopen\b.{0,30}\block\b|\bunlock\b/i, command: 'unlock' },
  { pattern: /\bclose\b.{0,30}\block\b|\block\b.{0,30}\bclose\b/i, command: 'lock' },
  // Single-word rules
  { pattern: /\boff\b|\bturn.?off\b|\bstop\b/i, command: 'turnOff' },
  { pattern: /\bon\b|\bturn.?on\b|\bstart\b/i, command: 'turnOn' },
  { pattern: /\bpress\b|\bclick\b|\btap\b/i, command: 'press' },
  { pattern: /\block\b/i, command: 'lock' },
  { pattern: /\bunlock\b/i, command: 'unlock' },
  { pattern: /\bopen\b|\braise\b|\bup\b/i, command: 'open' },
  { pattern: /\bclose\b|\blower\b|\bdown\b/i, command: 'close' },
  { pattern: /\bpause\b/i, command: 'pause' },
];

export function inferCommandFromIntent(intent: string): string | undefined {
  for (const k of COMMAND_KEYWORDS) {
    if (k.pattern.test(intent)) return k.command;
  }
  return undefined;
}

export function containsCjk(intent: string): boolean {
  return /[\u3400-\u9FFF]/u.test(intent);
}
