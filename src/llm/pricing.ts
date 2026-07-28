/**
 * Per-model USD pricing for input and output tokens.
 *
 * Numbers are USD per 1M tokens, copied from each provider's public pricing
 * page at the time the catalog entry was added. They drift; if a model is
 * missing or stale, `calculateCostUsd()` returns undefined and the cost
 * dimension is treated as "unknown" — calls and tokens budgeting still works,
 * dollar budgeting is skipped for that model.
 */
export interface ModelPricing {
  inUsdPer1M: number;
  outUsdPer1M: number;
}

export const PRICING: Record<string, ModelPricing> = {
  // OpenAI — https://openai.com/api/pricing/
  'gpt-4o-mini': { inUsdPer1M: 0.15, outUsdPer1M: 0.60 },
  'gpt-4o': { inUsdPer1M: 2.50, outUsdPer1M: 10.00 },
  'gpt-4-turbo': { inUsdPer1M: 10.00, outUsdPer1M: 30.00 },

  // Anthropic — https://www.anthropic.com/pricing
  'claude-haiku-4-5-20251001': { inUsdPer1M: 1.00, outUsdPer1M: 5.00 },
  'claude-sonnet-4-6': { inUsdPer1M: 3.00, outUsdPer1M: 15.00 },
  'claude-opus-4-7': { inUsdPer1M: 15.00, outUsdPer1M: 75.00 },
};

export function getModelPricing(model: string): ModelPricing | undefined {
  return PRICING[model];
}

/**
 * Calculate USD cost for a single LLM call given input/output token counts.
 * Returns undefined for unknown models — caller treats this as "skip cost
 * dimension for this call but keep counting calls and tokens".
 */
export function calculateCostUsd(
  model: string,
  tokensIn: number,
  tokensOut: number,
): number | undefined {
  const pricing = PRICING[model];
  if (!pricing) return undefined;
  const inputCost = (tokensIn / 1_000_000) * pricing.inUsdPer1M;
  const outputCost = (tokensOut / 1_000_000) * pricing.outUsdPer1M;
  return inputCost + outputCost;
}

export function isPricedModel(model: string): boolean {
  return model in PRICING;
}
