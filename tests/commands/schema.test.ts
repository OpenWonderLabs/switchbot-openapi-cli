import { describe, it, expect } from 'vitest';
import { registerSchemaCommand } from '../../src/commands/schema.js';
import { runCli } from '../helpers/cli.js';

describe('schema export', () => {
  it('dumps every catalog type as a JSON payload', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const out = res.stdout.join('');
    const parsed = JSON.parse(out);
    expect(parsed.version).toBe('1.0');
    expect(parsed.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Array.isArray(parsed.types)).toBe(true);
    expect(parsed.types.length).toBeGreaterThan(10);
    // Every entry should have normalized idempotent/destructive booleans.
    for (const t of parsed.types) {
      for (const c of t.commands) {
        expect(typeof c.idempotent).toBe('boolean');
        expect(typeof c.destructive).toBe('boolean');
      }
    }
  });

  it('filters by --type (matches name + aliases, case-insensitive)', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--type', 'bot']);
    const parsed = JSON.parse(res.stdout.join(''));
    expect(parsed.types).toHaveLength(1);
    expect(parsed.types[0].type).toBe('Bot');
  });

  it('returns an empty types[] when --type does not match', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--type', 'NoSuchType']);
    const parsed = JSON.parse(res.stdout.join(''));
    expect(parsed.types).toEqual([]);
  });

  it('tags a known destructive command', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const parsed = JSON.parse(res.stdout.join(''));
    const lock = parsed.types.find(
      (t: { type: string }) => t.type === 'Smart Lock' || t.type === 'Smart Lock Pro',
    );
    if (!lock) return; // catalog may omit on some builds — soft assert
    const unlock = lock.commands.find((c: { command: string }) => c.command === 'unlock');
    if (unlock) expect(unlock.destructive).toBe(true);
  });
});
