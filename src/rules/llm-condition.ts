import { createHash } from 'node:crypto';
import { deepSortedJson } from './trace.js';
import { writeAudit } from '../utils/audit.js';
import type { LlmCondition } from './types.js';
import type { EngineEvent } from './types.js';

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
  };
}

const HOUR_MS = 60 * 60 * 1000;

export class LlmConditionEvaluator {
  private cache = new Map<string, { result: boolean; reason: string; expiresAt: number }>();
  private callCounts = new Map<string, { count: number; windowStart: number }>();

  async evaluate(
    condition: LlmCondition['llm'],
    context: LlmConditionContext,
    ruleVersion: string,
    globalMaxCallsPerHour?: number,
  ): Promise<LlmEvaluateResult> {
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

    const perRuleMax = condition.budget?.max_calls_per_hour;
    const effectiveMax = perRuleMax ?? globalMaxCallsPerHour;
    if (effectiveMax !== undefined && effectiveMax > 0) {
      const budgetKey = `${ruleVersion}:${condition.prompt.slice(0, 32)}`;
      const now = Date.now();
      const entry = this.callCounts.get(budgetKey) ?? { count: 0, windowStart: now };
      if (now - entry.windowStart >= HOUR_MS) {
        entry.count = 0;
        entry.windowStart = now;
      }
      if (entry.count >= effectiveMax) {
        writeAudit({
          auditVersion: 2,
          t: new Date().toISOString(),
          kind: 'llm-budget-exceeded',
          deviceId: context.event.deviceId ?? '',
          command: 'llm-condition',
          parameter: null,
          commandType: 'command',
          dryRun: false,
        });
        return onErrorResult(condition.on_error ?? 'fail', 'Budget exceeded');
      }
      entry.count++;
      this.callCounts.set(budgetKey, entry);
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

      if (ttlMs > 0) {
        this.cache.set(cacheKey, { result: result.pass, reason: result.reason, expiresAt: Date.now() + ttlMs });
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
        },
      };
    } catch (err) {
      return onErrorResult(condition.on_error ?? 'fail', String(err));
    }
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
