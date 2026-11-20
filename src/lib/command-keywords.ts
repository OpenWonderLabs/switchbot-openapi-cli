// A whole action clause, not a keyword inside a question, trigger or condition.
// Device IDs are supplied separately. Ask for clarification on unfamiliar prose.
const TARGET = /^(?:(?:all(?: the)?|the|my) )?(?:(?:front|back|kitchen|bedroom|living room|porch|hallway|desk) )?(?:lights?|lamps?|fans?|bots?|devices?|buttons?|locks?|doors?(?: lock)?|deadbolts?|curtains?|blinds?|(?:robot )?vacuums?|heaters?|ac|coffee makers?|switch(?:es)?|everything)$/;

const ACTION: Record<string, string> = {
  turnon: 'turnOn', 'turn on': 'turnOn', start: 'turnOn',
  turnoff: 'turnOff', 'turn off': 'turnOff', stop: 'turnOff',
  press: 'press', click: 'press', tap: 'press', lock: 'lock', unlock: 'unlock',
  open: 'open', raise: 'open', close: 'close', lower: 'close', pause: 'pause',
};

export function inferCommandFromIntent(intent: string): string | undefined {
  const text = intent.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^please /, '').replace(/[.!]$/, '');
  const power = /^turn (.+) (on|off)$/.exec(text);
  if (power && TARGET.test(power[1])) return power[2] === 'on' ? 'turnOn' : 'turnOff';
  const match = /^(turn on|turn off|[a-z]+)(?: (.+))?$/.exec(text);
  if (!match || !Object.hasOwn(ACTION, match[1]) || (match[2] && !TARGET.test(match[2]))) return undefined;
  if (/\blocks?$/.test(match[2] ?? '')) {
    if (match[1] === 'open') return 'unlock';
    if (match[1] === 'close') return 'lock';
  }
  return ACTION[match[1]];
}
