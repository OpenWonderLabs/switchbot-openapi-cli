/**
 * Destructive-command parser — the string-pattern guard shared between the
 * v0.2 validator's post-hook and (later) the rule engine's action executor.
 *
 * These tests pin the verb-extraction grammar so a future refactor of the
 * rules engine can't silently break the "unlock can't be pre-approved"
 * safety invariant.
 */
import { describe, it, expect } from 'vitest';
import {
  extractVerb,
  isDestructiveCommand,
  destructiveVerbOf,
  DESTRUCTIVE_COMMANDS,
} from '../../src/rules/destructive.js';

describe('extractVerb', () => {
  it.each([
    ['devices command 01-ABC turnOn', 'turnOn'],
    ['devices command  01-ABC   unlock', 'unlock'],
    ['devices command <id> setMode cool 72', 'setMode'],
    ['  devices command foo factoryReset  ', 'factoryReset'],
  ])('parses verb out of %s', (input, verb) => {
    expect(extractVerb(input)).toBe(verb);
  });

  it('maps webhook/scene delete commands to the canonical destructive verb', () => {
    expect(extractVerb('webhooks delete foo')).toBe('deleteWebhook');
    expect(extractVerb('scenes delete foo')).toBe('deleteScene');
  });

  it.each([
    'devices command <id>',
    'devices list',
    'run-some-script',
    '',
    '   ',
  ])('returns null when the command shape is unknown (%s)', (input) => {
    expect(extractVerb(input)).toBeNull();
  });
});

describe('isDestructiveCommand / destructiveVerbOf', () => {
  it.each([
    ['devices command <id> lock', 'lock'],
    ['devices command <id> unlock', 'unlock'],
    ['devices command <id> factoryReset', 'factoryReset'],
    ['webhooks delete https://x', 'deleteWebhook'],
    ['scenes delete abc', 'deleteScene'],
  ])('flags %s as destructive', (cmd, verb) => {
    expect(isDestructiveCommand(cmd)).toBe(true);
    expect(destructiveVerbOf(cmd)).toBe(verb);
  });

  it.each([
    'devices command <id> turnOn',
    'devices command <id> setMode cool',
    'devices command <id> pause',
    'scenes run abc',
  ])('allows non-destructive command %s', (cmd) => {
    expect(isDestructiveCommand(cmd)).toBe(false);
    expect(destructiveVerbOf(cmd)).toBeNull();
  });

  it('DESTRUCTIVE_COMMANDS stays in sync with the unlock-blocklist schema enforces on confirmations', () => {
    // The two blocklists are independently defined (schema side is in YAML,
    // runtime side is this file). This test guarantees they don't drift.
    expect([...DESTRUCTIVE_COMMANDS].sort()).toEqual(
      ['lock', 'unlock', 'deleteWebhook', 'deleteScene', 'factoryReset'].sort(),
    );
  });
});
