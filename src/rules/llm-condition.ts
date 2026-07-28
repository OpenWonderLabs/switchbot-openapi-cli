import { createHash } from 'node:crypto';
import { deepSortedJson } from './trace.js';
import { writeAudit } from '../utils/audit.js';
import type { LlmCondition } from './types.js';
import type { EngineEvent } from './types.js';
import type { DecideUsage } from '../llm/provider.js';

export interface LlmConditionContext {
  event: EngineEvent;
  recentEvents?: EngineEvent[];
}

export interface LlmEvaluateResult {
  pass: boolean;
  traceFields: {
    provider: string;
    model: string;
    latencyMs: number;
    cacheHit: boolean;
    reason: string;
    promptDigest: string;
    /** Token and cost figures from the underlying provider call. Absent on
     * cache hits and on errors. */
    usage?: DecideUsage;
  };
}

/** Effective budget caps applied to an LLM condition evaluation. */
export interface LlmBudgetCaps {
  /** Per-rule + global merged: per-rule wins when set, otherwise global applies. */
  maxCallsPerHour?: number;
  maxTokensPerHour?: number;
  maxCostPerDayUsd?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface BudgetCounter {
  /** Calls + tokens use this hourly window. */
  hourlyStart: number;
  calls: number;
  tokens: number;
  /** Cost uses a separate daily window. */
  dailyStart: number;
  costUsd: number;
}

export class LlmConditionEvaluator {
  private cache = new Map<string, { result: boolean; reason: string; expiresAt: number; usage?: DecideUsage }>();
  private budgetCounters = new Map<string, BudgetCounter>();

  async evaluate(
    condition: LlmCondition['llm'],
    context: LlmConditionContext,
    ruleVersion: string,
    budgetCaps?: LlmBudgetCaps | number,
  ): Promise<LlmEvaluateResult> {
    // Backward compatibility: callers in the existing engine pass a single
    // number meaning "global max_calls_per_hour". New callers pass a full
    // LlmBudgetCaps object.
    const caps: LlmBudgetCaps = typeof budgetCaps === 'number'
      ? { maxCallsPerHour: budgetCaps }
      : { ...(budgetCaps ?? {}) };

    // Per-rule budget overrides global on a dimension-by-dimension basis.
    if (condition.budget?.max_calls_per_hour !== undefined) caps.maxCallsPerHour = condition.budget.max_calls_per_hour;
    if (condition.budget?.max_tokens_per_hour !== undefined) caps.maxTokensPerHour = condition.budget.max_tokens_per_hour;
    if (condition.budget?.max_cost_per_day_usd !== undefined) caps.maxCostPerDayUsd = condition.budget.max_cost_per_day_usd;

    const cacheKey = buildCacheKey(ruleVersion, condition.prompt, context);
    const ttlMs = parseCacheTtl(condition.cache_ttl ?? '5m');

    if (ttlMs > 0) {
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        return {
          pass: cached.result,
          traceFields: {
            provider: 'cached',
            model: 'cached',
            latencyMs: 0,
            cacheHit: true,
            reason: cached.reason,
            promptDigest: cacheKey.slice(0, 8),
          },
        };
      }
    }

    const budgetKey = `${ruleVersion}:${condition.prompt.slice(0, 32)}`;
    const counter = this.rollCounter(budgetKey);

    // Pre-call: check call-count budget. Tokens and cost can only be checked
    // after the call returns (we don't know how many tokens a call will use
    // until it has run), but if a previous call already pushed us past the
    // limit we short-circuit now.
    const callViolation = this.checkPreCallBudget(counter, caps);
    if (callViolation) {
      this.emitBudgetExceeded(callViolation, context, condition);
      return onErrorResult(condition.on_error ?? 'fail', `Budget exceeded (${callViolation.dimension})`);
    }

    const backend = resolveProvider(condition.provider ?? 'auto');
    const { createLLMProvider } = await import('../llm/index.js');
    const provider = createLLMProvider(backend, {
      timeoutMs: condition.timeout_ms ?? 5_000,
    });

    const prompt = buildPrompt(condition.prompt, context);
    const start = Date.now();
    try {
      const result = await provider.decide(prompt, { timeoutMs: condition.timeout_ms ?? 5_000 });
      const latencyMs = Date.now() - start;

      // Account for this call's usage AFTER the call completed; subsequent
      // calls in the same window will see the updated counter and may hit
      // the token/cost ceiling.
      counter.calls += 1;
      if (result.usage) {
        counter.tokens += result.usage.tokensIn + result.usage.tokensOut;
        if (result.usage.costUsd !== undefined) {
          counter.costUsd += result.usage.costUsd;
        }
      }

      if (ttlMs > 0) {
        this.cache.set(cacheKey, {
          result: result.pass,
          reason: result.reason,
          expiresAt: Date.now() + ttlMs,
          usage: result.usage,
        });
      }

      return {
        pass: result.pass,
        traceFields: {
          provider: provider.name,
          model: provider.model,
          latencyMs,
          cacheHit: false,
          reason: String(result.reason ?? '').slice(0, 200),
          promptDigest: cacheKey.slice(0, 8),
          usage: result.usage,
        },
      };
    } catch (err) {
      return onErrorResult(condition.on_error ?? 'fail', String(err));
    }
  }

  private rollCounter(key: string): BudgetCounter {
    const now = Date.now();
    const existing = this.budgetCounters.get(key);
    if (!existing) {
      const fresh: BudgetCounter = { hourlyStart: now, calls: 0, tokens: 0, dailyStart: now, costUsd: 0 };
      this.budgetCounters.set(key, fresh);
      return fresh;
    }
    if (now - existing.hourlyStart >= HOUR_MS) {
      existing.hourlyStart = now;
      existing.calls = 0;
      existing.tokens = 0;
    }
    if (now - existing.dailyStart >= DAY_MS) {
      existing.dailyStart = now;
      existing.costUsd = 0;
    }
    return existing;
  }

  private checkPreCallBudget(
    counter: BudgetCounter,
    caps: LlmBudgetCaps,
  ): { dimension: 'calls' | 'tokens' | 'cost'; limit: number; observed: number } | null {
    if (caps.maxCallsPerHour !== undefined && caps.maxCallsPerHour >= 0 && counter.calls >= caps.maxCallsPerHour) {
      return { dimension: 'calls', limit: caps.maxCallsPerHour, observed: counter.calls };
    }
    if (caps.maxTokensPerHour !== undefined && caps.maxTokensPerHour >= 0 && counter.tokens >= caps.maxTokensPerHour) {
      return { dimension: 'tokens', limit: caps.maxTokensPerHour, observed: counter.tokens };
    }
    if (caps.maxCostPerDayUsd !== undefined && caps.maxCostPerDayUsd >= 0 && counter.costUsd >= caps.maxCostPerDayUsd) {
      return { dimension: 'cost', limit: caps.maxCostPerDayUsd, observed: counter.costUsd };
    }
    return null;
  }

  private emitBudgetExceeded(
    violation: { dimension: 'calls' | 'tokens' | 'cost'; limit: number; observed: number },
    context: LlmConditionContext,
    _condition: LlmCondition['llm'],
  ): void {
    writeAudit({
      auditVersion: 2,
      t: new Date().toISOString(),
      kind: 'llm-budget-exceeded',
      deviceId: context.event.deviceId ?? '',
      command: 'llm-condition',
      parameter: null,
      commandType: 'command',
      dryRun: false,
      budgetDimension: violation.dimension,
      budgetLimit: violation.limit,
      budgetObserved: violation.observed,
    });
  }
}

function buildCacheKey(ruleVersion: string, promptTemplate: string, context: LlmConditionContext): string {
  const contextSnapshot = {
    event: { source: context.event.source, event: context.event.event, deviceId: context.event.deviceId },
    recentEvents: (context.recentEvents ?? []).map(e => ({
      source: e.source,
      event: e.event,
      deviceId: e.deviceId,
    })),
  };
  const serialized = JSON.stringify([ruleVersion, promptTemplate, deepSortedJson(contextSnapshot)]);
  return createHash('sha256').update(serialized).digest('hex');
}

function buildPrompt(template: string, context: LlmConditionContext): string {
  const eventDesc = `Event: ${context.event.source} ${context.event.event}${context.event.deviceId ? ` on ${context.event.deviceId}` : ''}`;
  return `${template}\n\n${eventDesc}`;
}

function parseCacheTtl(ttl: string): number {
  if (ttl === 'none') return 0;
  const match = /^(\d+)(s|m|h)$/.exec(ttl);
  if (!match) return 5 * 60 * 1000;
  const n = parseInt(match[1], 10);
  if (match[2] === 's') return n * 1000;
  if (match[2] === 'm') return n * 60 * 1000;
  return n * 60 * 60 * 1000;
}

function resolveProvider(provider: 'auto' | 'openai' | 'anthropic'): 'openai' | 'anthropic' {
  if (provider === 'auto') {
    if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
    if (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY) return 'openai';
    throw new Error('No LLM API key found for llm condition. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
  }
  return provider;
}

function onErrorResult(onError: 'fail' | 'pass' | 'skip', reason: string): LlmEvaluateResult {
  const pass = onError === 'pass';
  return {
    pass,
    traceFields: {
      provider: 'error',
      model: 'error',
      latencyMs: 0,
      cacheHit: false,
      reason: reason.slice(0, 200),
      promptDigest: '',
    },
  };
}
