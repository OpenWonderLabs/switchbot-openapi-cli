import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const METER_ID = '28372F4C9C4A';
const AC_ID = '11AABB223344';
const LIGHT_ID = '55EEFF667788';

const VALID_RULE_YAML = `name: ac-on-when-hot
when:
  source: mqtt
  event: meter.temperature_changed
  device: ${METER_ID}
then:
  - command: devices command ${AC_ID} turnOn
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
      devices: [{ id: METER_ID, name: 'Meter', type: 'MeterPro' }, { id: AC_ID, name: 'AC' }],
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
        devices: [{ id: AC_ID }],
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
    expect(result.warnings.some(w => w.includes('intent complexity below LLM threshold'))).toBe(true);
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

  it('forces dry_run:true when LLM proposes dry_run:false', async () => {
    const RULE_NO_DRY_RUN = `name: forced-dry-run
when:
  source: mqtt
  event: meter.temperature_changed
then:
  - command: devices command ${AC_ID} turnOn
dry_run: false`;
    const { OpenAIProvider } = await import('../../src/llm/providers/openai.js');
    (OpenAIProvider as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      name: 'openai',
      model: 'gpt-4o-mini',
      generateYaml: () => Promise.resolve(RULE_NO_DRY_RUN),
    }));

    const result = await suggestRule({
      intent: 'force dry run',
      devices: [{ id: AC_ID }],
      llm: 'openai',
    });

    expect(result.rule.dry_run).toBe(true);
    expect(result.warnings.some(w => w.includes('forced to dry_run:true'))).toBe(true);
  });

  it('throws when LLM ignores --trigger constraint', async () => {
    // Default mock returns mqtt rule; ask for cron
    await expect(
      suggestRule({
        intent: 'turn on at 8am',
        devices: [{ id: LIGHT_ID }],
        trigger: 'cron',
        schedule: '0 8 * * *',
        llm: 'openai',
      }),
    ).rejects.toThrow(/ignored --trigger cron/);
  });

  it('overrides LLM cron schedule with caller --schedule and emits warning', async () => {
    const RULE_WRONG_SCHEDULE = `name: wrong-schedule
when:
  source: cron
  schedule: '0 8 * * *'
then:
  - command: devices command ${LIGHT_ID} turnOff
dry_run: true`;
    const { OpenAIProvider } = await import('../../src/llm/providers/openai.js');
    (OpenAIProvider as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      name: 'openai',
      model: 'gpt-4o-mini',
      generateYaml: () => Promise.resolve(RULE_WRONG_SCHEDULE),
    }));

    const result = await suggestRule({
      intent: 'turn off at 10pm',
      devices: [{ id: LIGHT_ID }],
      trigger: 'cron',
      schedule: '0 22 * * *',
      llm: 'openai',
    });

    expect(result.rule.when.source).toBe('cron');
    expect((result.rule.when as { schedule: string }).schedule).toBe('0 22 * * *');
    expect(result.warnings.some(w => w.includes('--schedule "0 22 * * *"') && w.includes('overriding'))).toBe(true);
  });

  it('overrides LLM mqtt event with caller --event and emits warning', async () => {
    const RULE_WRONG_EVENT = `name: wrong-event
when:
  source: mqtt
  event: device.shadow
then:
  - command: devices command ${LIGHT_ID} turnOn
dry_run: true`;
    const { OpenAIProvider } = await import('../../src/llm/providers/openai.js');
    (OpenAIProvider as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      name: 'openai',
      model: 'gpt-4o-mini',
      generateYaml: () => Promise.resolve(RULE_WRONG_EVENT),
    }));

    const result = await suggestRule({
      intent: 'on motion turn on light',
      devices: [{ id: LIGHT_ID }],
      trigger: 'mqtt',
      event: 'motion.detected',
      llm: 'openai',
    });

    expect((result.rule.when as { event: string }).event).toBe('motion.detected');
    expect(result.warnings.some(w => w.includes('--event "motion.detected"'))).toBe(true);
  });

  it('rejects LLM rule that violates the policy schema', async () => {
    const RULE_INVALID_SCHEMA = `name: missing-action-fields
when:
  source: mqtt
  event: motion.detected
then:
  - { not_a_command: true }
dry_run: true`;
    const { OpenAIProvider } = await import('../../src/llm/providers/openai.js');
    (OpenAIProvider as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      name: 'openai',
      model: 'gpt-4o-mini',
      generateYaml: () => Promise.resolve(RULE_INVALID_SCHEMA),
    }));

    await expect(
      suggestRule({
        intent: 'bad rule',
        devices: [{ id: 'AC_001' }],
        llm: 'openai',
      }),
    ).rejects.toThrow(/policy schema|failed lint/i);
  });

  it('records audit with result=error and the error message when LLM provider rejects', async () => {
    const auditMod = await import('../../src/utils/audit.js');
    const auditSpy = vi.spyOn(auditMod, 'writeAudit').mockImplementation(() => {});

    const { OpenAIProvider } = await import('../../src/llm/providers/openai.js');
    (OpenAIProvider as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      name: 'openai',
      model: 'gpt-4o-mini',
      generateYaml: () => Promise.reject(new Error('boom from provider')),
    }));

    try {
      await expect(
        suggestRule({
          intent: 'audit error path',
          devices: [{ id: 'AC_001' }],
          llm: 'openai',
        }),
      ).rejects.toThrow(/boom from provider/);

      const errorEntries = auditSpy.mock.calls
        .map(c => c[0] as Record<string, unknown>)
        .filter(e => e.kind === 'llm-suggest');
      expect(errorEntries).toHaveLength(1);
      expect(errorEntries[0].result).toBe('error');
      expect(errorEntries[0].error).toContain('boom from provider');
    } finally {
      auditSpy.mockRestore();
    }
  });
});
