import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const VALID_RULE_YAML = `name: ac-on-when-hot
when:
  source: mqtt
  event: meter.temperature_changed
  device: METER_001
then:
  - command: devices command AC_001 turnOn
dry_run: true`;

vi.mock('../../src/llm/providers/openai.js', () => ({
  OpenAIProvider: vi.fn(),
}));

vi.mock('../../src/llm/providers/anthropic.js', () => ({
  AnthropicProvider: vi.fn(),
}));

import { suggestRule } from '../../src/rules/suggest.js';

describe('suggestRule — LLM backend', () => {
  beforeEach(async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-key';

    const { OpenAIProvider } = await import('../../src/llm/providers/openai.js');
    const { AnthropicProvider } = await import('../../src/llm/providers/anthropic.js');
    (OpenAIProvider as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      name: 'openai',
      model: 'gpt-4o-mini',
      generateYaml: () => Promise.resolve(VALID_RULE_YAML),
    }));
    (AnthropicProvider as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      name: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      generateYaml: () => Promise.resolve(VALID_RULE_YAML),
    }));
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('returns LLM-generated rule when llm=openai', async () => {
    const result = await suggestRule({
      intent: 'when temperature above 28 and humidity over 70 turn on AC',
      devices: [{ id: 'METER_001', name: 'Meter', type: 'MeterPro' }, { id: 'AC_001', name: 'AC' }],
      llm: 'openai',
    });
    expect(result.rule.name).toBe('ac-on-when-hot');
    expect(result.warnings).toHaveLength(0);
  });

  it('auto mode routes complex intent to LLM', async () => {
    // Force openai backend by unsetting anthropic key
    const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    let result;
    try {
      result = await suggestRule({
        intent: 'on weekdays if someone opens the door and room temp is below 20 turn on AC but skip if already on',
        devices: [{ id: 'AC_001' }],
        llm: 'auto',
      });
    } finally {
      if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    }
    expect(result!.rule.name).toBe('ac-on-when-hot');
  });

  it('auto mode uses heuristic for simple intents', async () => {
    const result = await suggestRule({
      intent: 'turn off lights at 10pm',
      devices: [{ id: 'LIGHT_001' }],
      llm: 'auto',
    });
    // heuristic path — no LLM called, rule uses the intent as name
    expect(result.rule.when.source).toBe('cron');
    expect(result.rule.name).toBe('turn off lights at 10pm');
  });

  it('auto mode falls back to heuristic when LLM throws', async () => {
    const { OpenAIProvider } = await import('../../src/llm/providers/openai.js');
    (OpenAIProvider as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      name: 'openai',
      model: 'gpt-4o-mini',
      generateYaml: () => Promise.reject(new Error('connection refused')),
    }));

    // Unset ANTHROPIC_API_KEY so detectLlmBackend picks openai (where we have the reject mock)
    const savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    let result;
    try {
      result = await suggestRule({
        intent: 'on weekdays between 9am and 6pm if someone opens the door and temp is below 20 turn on AC but skip if already on',
        devices: [{ id: 'AC_001' }],
        llm: 'auto',
      });
    } finally {
      if (savedAnthropicKey !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
    }

    expect(result!.warnings.some(w => w.includes('fell back to heuristic'))).toBe(true);
  });
});
