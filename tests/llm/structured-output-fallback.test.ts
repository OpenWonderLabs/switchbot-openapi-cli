import { describe, it, expect } from 'vitest';
import { tryParseDecision } from '../../src/llm/providers/structured-output-fallback.js';

describe('tryParseDecision', () => {
  it('parses a clean JSON object', () => {
    const r = tryParseDecision('{"pass": true, "reason": "looks good"}');
    expect(r).toEqual({ pass: true, reason: 'looks good' });
  });

  it('parses JSON wrapped in ```json fences', () => {
    const r = tryParseDecision('```json\n{"pass": false, "reason": "no match"}\n```');
    expect(r).toEqual({ pass: false, reason: 'no match' });
  });

  it('parses JSON wrapped in plain ``` fences', () => {
    const r = tryParseDecision('```\n{"pass": true, "reason": "ok"}\n```');
    expect(r).toEqual({ pass: true, reason: 'ok' });
  });

  it('extracts a JSON object embedded in surrounding prose', () => {
    const r = tryParseDecision('Sure! Here is my answer: {"pass": true, "reason": "yes"} Have a nice day.');
    expect(r).toEqual({ pass: true, reason: 'yes' });
  });

  it('handles nested braces correctly when extracting from prose', () => {
    const r = tryParseDecision('Reasoning {step 1} -> {"pass": false, "reason": "blocked"} done');
    expect(r).toEqual({ pass: false, reason: 'blocked' });
  });

  it('truncates reason at 200 chars', () => {
    const longReason = 'x'.repeat(500);
    const r = tryParseDecision(`{"pass": true, "reason": "${longReason}"}`);
    expect(r?.reason.length).toBe(200);
  });

  it('returns null when no JSON object is present', () => {
    expect(tryParseDecision('I cannot answer that question')).toBeNull();
  });

  it('returns null when JSON has no pass field', () => {
    expect(tryParseDecision('{"reason": "no pass"}')).toBeNull();
  });

  it('returns null when pass is not a boolean', () => {
    expect(tryParseDecision('{"pass": "yes", "reason": "stringy"}')).toBeNull();
  });

  it('handles missing reason gracefully', () => {
    const r = tryParseDecision('{"pass": true}');
    expect(r).toEqual({ pass: true, reason: '' });
  });

  it('handles strings containing braces correctly', () => {
    const r = tryParseDecision('{"pass": true, "reason": "the value was {abc}"}');
    expect(r).toEqual({ pass: true, reason: 'the value was {abc}' });
  });

  it('handles escaped quotes inside strings', () => {
    const r = tryParseDecision('{"pass": false, "reason": "he said \\"no\\""}');
    expect(r?.pass).toBe(false);
    expect(r?.reason).toBe('he said "no"');
  });
});
