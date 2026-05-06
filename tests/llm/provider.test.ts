import { describe, it, expect } from 'vitest';
import { createLLMProvider, LLM_AUTO_THRESHOLD } from '../../src/llm/index.js';

describe('createLLMProvider', () => {
  it('throws when backend=openai and no API key set', () => {
    const saved = process.env.OPENAI_API_KEY;
    const saved2 = process.env.LLM_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_API_KEY;
    try {
      expect(() => createLLMProvider('openai')).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      if (saved2 !== undefined) process.env.LLM_API_KEY = saved2;
    }
  });

  it('throws when backend=anthropic and no API key set', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    const saved2 = process.env.LLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LLM_API_KEY;
    try {
      expect(() => createLLMProvider('anthropic')).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      if (saved2 !== undefined) process.env.LLM_API_KEY = saved2;
    }
  });

  it('creates an OpenAI provider when OPENAI_API_KEY is set', () => {
    const saved = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';
    try {
      const p = createLLMProvider('openai');
      expect(p.name).toBe('openai');
      expect(p.model).toBeDefined();
    } finally {
      if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
      else delete process.env.OPENAI_API_KEY;
    }
  });

  it('creates an Anthropic provider when ANTHROPIC_API_KEY is set', () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const p = createLLMProvider('anthropic');
      expect(p.name).toBe('anthropic');
      expect(p.model).toBeDefined();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('LLM_AUTO_THRESHOLD is 4', () => {
    expect(LLM_AUTO_THRESHOLD).toBe(4);
  });
});
