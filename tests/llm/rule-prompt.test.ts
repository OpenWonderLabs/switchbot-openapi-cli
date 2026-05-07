import { describe, it, expect } from 'vitest';
import { buildRuleSuggestSystemPrompt } from '../../src/llm/rule-prompt.js';

function extractSchemaSnippet(prompt: string): Record<string, unknown> {
  // The schema snippet is a JSON object embedded between the
  // "conforming to this JSON Schema:\n" header and the "Rules:" line.
  const start = prompt.indexOf('JSON Schema:\n');
  expect(start).toBeGreaterThan(-1);
  const after = prompt.slice(start + 'JSON Schema:\n'.length);
  const rulesIdx = after.indexOf('\n\nRules:');
  expect(rulesIdx).toBeGreaterThan(-1);
  const json = after.slice(0, rulesIdx);
  return JSON.parse(json) as Record<string, unknown>;
}

describe('buildRuleSuggestSystemPrompt — schema snippet completeness', () => {
  const prompt = buildRuleSuggestSystemPrompt([], {});

  it('includes the trigger oneOf wrapper and all three trigger variants', () => {
    const snippet = extractSchemaSnippet(prompt);
    expect(snippet).toHaveProperty('rule');
    expect(snippet).toHaveProperty('trigger');
    expect(snippet).toHaveProperty('triggerMqtt');
    expect(snippet).toHaveProperty('triggerCron');
    expect(snippet).toHaveProperty('triggerWebhook');
  });

  it('rule.when $ref points to a def that exists in the snippet (no dangling reference)', () => {
    const snippet = extractSchemaSnippet(prompt);
    const rule = snippet.rule as { properties?: { when?: { $ref?: string } } };
    const ref = rule.properties?.when?.$ref;
    expect(ref).toBe('#/$defs/trigger');
    // The $ref targets `#/$defs/trigger`; the snippet keys should include it.
    expect(snippet).toHaveProperty('trigger');
  });

  it('triggerWebhook def carries the path constraint for the model to obey', () => {
    const snippet = extractSchemaSnippet(prompt);
    const tw = snippet.triggerWebhook as {
      properties?: { path?: { pattern?: string } };
      required?: string[];
    };
    expect(tw.required).toContain('source');
    expect(tw.required).toContain('path');
    expect(tw.properties?.path?.pattern).toBe('^/[a-z0-9/_-]+$');
  });

  it('rules section instructs the model on webhook trigger structure', () => {
    expect(prompt).toMatch(/source:\s*webhook/);
    expect(prompt).toMatch(/path:/);
  });
});
