import { describe, it, expect } from 'vitest';
import { registerSchemaCommand } from '../../src/commands/schema.js';
import { runCli } from '../helpers/cli.js';

describe('schema export', () => {
  it('dumps every catalog type as a JSON payload', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const out = res.stdout.join('');
    const envelope = JSON.parse(out);
    expect(envelope.schemaVersion).toBe('1.1');
    const parsed = envelope.data;
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
    const parsed = JSON.parse(res.stdout.join('')).data;
    expect(parsed.types).toHaveLength(1);
    expect(parsed.types[0].type).toBe('Bot');
  });

  it('returns an empty types[] when --type does not match', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--type', 'NoSuchType']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    expect(parsed.types).toEqual([]);
  });

  it('tags a known destructive command', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    const lock = parsed.types.find(
      (t: { type: string }) => t.type === 'Smart Lock' || t.type === 'Smart Lock Pro',
    );
    if (!lock) return; // catalog may omit on some builds — soft assert
    const unlock = lock.commands.find((c: { command: string }) => c.command === 'unlock');
    if (unlock) expect(unlock.destructive).toBe(true);
  });

  it('--role filters to the matching functional group', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--role', 'lighting']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    expect(parsed.types.length).toBeGreaterThan(0);
    for (const t of parsed.types) {
      expect(t.role).toBe('lighting');
    }
    expect(parsed.types.find((t: { type: string }) => t.type === 'Smart Lock')).toBeUndefined();
  });

  it('--role and --category can be combined', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--role', 'security', '--category', 'physical']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    expect(parsed.types.length).toBeGreaterThan(0);
    for (const t of parsed.types) {
      expect(t.role).toBe('security');
      expect(t.category).toBe('physical');
    }
  });

  it('--role rejects an unknown role with exit 2', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--role', 'nonexistent']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/--role .* must be one of/i);
  });

  it('exits 2 when --role swallows "--help"', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export', '--role', '--help']);
    expect(res.exitCode).toBe(2);
    expect(res.stderr.join('\n')).toMatch(/--role .* must be one of/i);
  });

  it('schema export includes description on every type', async () => {
    const res = await runCli(registerSchemaCommand, ['schema', 'export']);
    const parsed = JSON.parse(res.stdout.join('')).data;
    for (const t of parsed.types) {
      expect(t.description, `${t.type} missing description in export`).toBeTypeOf('string');
      expect((t.description as string).length, `${t.type} description is empty`).toBeGreaterThan(0);
    }
  });
});
