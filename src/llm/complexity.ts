/**
 * Scores how "complex" a natural-language automation intent is, 0–10.
 * Simple intents (< 4) are handled by the keyword heuristic;
 * complex ones (>= 4) benefit from an LLM.
 */

const SIGNALS: Array<{ pattern: RegExp; weight: number }> = [
  { pattern: /\band\b/i, weight: 1 },
  { pattern: /\bbut\b|\bexcept\b|\bunless\b/i, weight: 1.5 },
  { pattern: /\bif\b/i, weight: 1 },
  { pattern: /\balready\b|\bskip\b/i, weight: 1.5 },
  { pattern: /\bbetween\s+\d/i, weight: 2 },
  { pattern: /\bfor\s+\d+\s*(min|hour|second)/i, weight: 1.5 },
  { pattern: /\bpast\s+\d+\s*(min|hour)/i, weight: 2 },
  { pattern: /\bweekday|monday|tuesday|wednesday|thursday|friday/i, weight: 1 },
  { pattern: /\btemperature\b.*\bhumidity\b|\bhumidity\b.*\btemperature\b/i, weight: 2 },
  { pattern: /\b(above|below|greater|less)\s+\d/i, weight: 1 },
];

export function scoreIntentComplexity(intent: string): number {
  let score = 0;
  for (const { pattern, weight } of SIGNALS) {
    if (pattern.test(intent)) score += weight;
  }
  return Math.min(10, score);
}
