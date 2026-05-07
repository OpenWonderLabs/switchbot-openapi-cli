import { describe, it, expect } from 'vitest';
import { isCommandAction, isNotifyAction } from '../../src/rules/types.js';
import type { Action } from '../../src/rules/types.js';

describe('isCommandAction / isNotifyAction type guards', () => {
  it('identifies a command action (no type field)', () => {
    const action: Action = { command: 'devices command dev-1 turnOn' };
    expect(isCommandAction(action)).toBe(true);
    expect(isNotifyAction(action)).toBe(false);
  });

  it('identifies a command action (explicit type: command)', () => {
    const action: Action = { type: 'command', command: 'devices command dev-1 turnOn' };
    expect(isCommandAction(action)).toBe(true);
    expect(isNotifyAction(action)).toBe(false);
  });

  it('identifies a notify action', () => {
    const action: Action = { type: 'notify', channel: 'webhook', to: 'https://example.com' };
    expect(isNotifyAction(action)).toBe(true);
    expect(isCommandAction(action)).toBe(false);
  });

  it('identifies a notify action with file channel', () => {
    const action: Action = { type: 'notify', channel: 'file', to: '/tmp/events.jsonl' };
    expect(isNotifyAction(action)).toBe(true);
  });
});
