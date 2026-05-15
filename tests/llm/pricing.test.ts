import { describe, it, expect } from 'vitest';
import { calculateCostUsd, getModelPricing, isPricedModel, PRICING } from '../../src/llm/pricing.js';

describe('llm/pricing', () => {
  describe('PRICING table', () => {
    it('has at least one OpenAI and one Anthropic entry', () => {
      const keys = Object.keys(PRICING);
      expect(keys).toContain('gpt-4o-mini');
      expect(keys).toContain('claude-haiku-4-5-20251001');
    });

    it('every entry has positive USD-per-1M numbers', () => {
      for (const [model, p] of Object.entries(PRICING)) {
        expect(p.inUsdPer1M, `${model} input price`).toBeGreaterThan(0);
        expect(p.outUsdPer1M, `${model} output price`).toBeGreaterThan(0);
      }
    });

    it('output price is at least input price for every entry', () => {
      // Output tokens are always priced ≥ input on real provider sheets;
      // a row failing this is almost certainly a typo when adding a new model.
      for (const [model, p] of Object.entries(PRICING)) {
        expect(p.outUsdPer1M, `${model} output should be ≥ input`).toBeGreaterThanOrEqual(p.inUsdPer1M);
      }
    });
  });

  describe('calculateCostUsd', () => {
    it('returns the expected USD figure for gpt-4o-mini', () => {
      // 1M input tokens × $0.15 = $0.15; 1M output tokens × $0.60 = $0.60; total $0.75
      const cost = calculateCostUsd('gpt-4o-mini', 1_000_000, 1_000_000);
      expect(cost).toBeCloseTo(0.75, 6);
    });

    it('scales linearly with token count', () => {
      const cost1k = calculateCostUsd('gpt-4o-mini', 1_000, 1_000)!;
      const cost10k = calculateCostUsd('gpt-4o-mini', 10_000, 10_000)!;
      expect(cost10k).toBeCloseTo(cost1k * 10, 8);
    });

    it('returns undefined for an unknown model', () => {
      expect(calculateCostUsd('unknown-model', 100, 100)).toBeUndefined();
    });

    it('returns 0 cost for a known model when token counts are zero', () => {
      expect(calculateCostUsd('claude-haiku-4-5-20251001', 0, 0)).toBe(0);
    });

    it('handles claude-haiku pricing correctly', () => {
      // 1k input × $1 / 1M = $0.001; 1k output × $5 / 1M = $0.005; total $0.006
      const cost = calculateCostUsd('claude-haiku-4-5-20251001', 1_000, 1_000);
      expect(cost).toBeCloseTo(0.006, 6);
    });
  });

  describe('getModelPricing / isPricedModel', () => {
    it('getModelPricing returns the entry for a known model', () => {
      const p = getModelPricing('gpt-4o-mini');
      expect(p).toBeDefined();
      expect(p!.inUsdPer1M).toBe(0.15);
    });

    it('getModelPricing returns undefined for an unknown model', () => {
      expect(getModelPricing('llama3.2')).toBeUndefined();
    });

    it('isPricedModel reports true for a known model and false for an unknown one', () => {
      expect(isPricedModel('claude-haiku-4-5-20251001')).toBe(true);
      expect(isPricedModel('llama3.2')).toBe(false);
    });
  });
});
