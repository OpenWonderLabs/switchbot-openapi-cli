/**
 * Rules engine runtime — orchestrates trigger subscription, matcher
 * pipeline, throttle gate, and action executor.
 *
 * v0.2 PoC scope:
 *   - Loads an `automation` block from a policy file.
 *   - Subscribes to a single MQTT client; routes every shadow message
 *     through `matchesMqttTrigger` → `evaluateConditions` → throttle →
 *     `executeRuleAction`.
 *   - Cron + webhook triggers are **recognised but not wired** — they
 *     surface in the static lint as `unsupported` so users know the
 *     feature is pending (E1/E2 fill it in without a schema change).
 *   - Exposes `start()`, `stop()`, `getStats()` for the rules run
 *     subcommand.
 *
 * Not responsible for: loading the policy file, validating it, talking
 * to the SwitchBot REST API (that's `executeCommand`), or writing
 * audit lines (that's each module's local responsibility).
 */

import { randomUUID } from 'node:crypto';
import type { AxiosInstance } from 'axios';
import type { SwitchBotMqttClient } from '../mqtt/client.js';
import type { MqttCredential } from '../mqtt/credential.js';
import { isDestructiveCommand } from './destructive.js';
import { classifyMqttPayload, evaluateConditions, matchesMqttTrigger } from './matcher.js';
import { ThrottleGate, parseMaxPerMs } from './throttle.js';
import { executeRuleAction } from './action.js';
import { CronScheduler } from './cron-scheduler.js';
import {
  type AutomationBlock,
  type EngineEvent,
  type Rule,
  isCronTrigger,
  isMqttTrigger,
} from './types.js';
import { Cron } from 'croner';
import { writeAudit } from '../utils/audit.js';

export interface LintIssue {
  rule: string;
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface LintResult {
  rules: Array<{
    name: string;
    enabled: boolean;
    status: 'ok' | 'error' | 'unsupported' | 'disabled';
    issues: LintIssue[];
  }>;
  valid: boolean;
  unsupportedCount: number;
}

export function lintRules(automation: AutomationBlock | null | undefined): LintResult {
  const rules = automation?.rules ?? [];
  const entries: LintResult['rules'] = [];
  let unsupportedCount = 0;
  const seenNames = new Set<string>();

  for (const r of rules) {
    const issues: LintIssue[] = [];
    if (seenNames.has(r.name)) {
      issues.push({ rule: r.name, severity: 'error', code: 'duplicate-name', message: `Duplicate rule name "${r.name}".` });
    }
    seenNames.add(r.name);

    // Trigger support
    if (r.when.source === 'webhook') {
      issues.push({
        rule: r.name,
        severity: 'warning',
        code: 'trigger-unsupported',
        message: `Trigger source "${r.when.source}" is not active in this build (E2 pending).`,
      });
      unsupportedCount++;
    }

    // Cron expression validity (cron trigger is now active in E1).
    if (r.when.source === 'cron') {
      try {
        // eslint-disable-next-line no-new
        new Cron(r.when.schedule, { paused: true });
      } catch (err) {
        issues.push({
          rule: r.name,
          severity: 'error',
          code: 'invalid-cron',
          message: `cron schedule "${r.when.schedule}" is not parseable: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Destructive guard
    for (let i = 0; i < r.then.length; i++) {
      if (isDestructiveCommand(r.then[i].command)) {
        issues.push({
          rule: r.name,
          severity: 'error',
          code: 'destructive-action',
          message: `then[${i}] uses a destructive verb — the engine will refuse to run this rule.`,
        });
      }
    }

    // Throttle expression
    if (r.throttle) {
      try {
        parseMaxPerMs(r.throttle.max_per);
      } catch {
        issues.push({
          rule: r.name,
          severity: 'error',
          code: 'invalid-throttle',
          message: `throttle.max_per "${r.throttle.max_per}" is not a valid duration.`,
        });
      }
    }

    const enabled = r.enabled !== false;
    const hasError = issues.some((i) => i.severity === 'error');
    const hasUnsupported = issues.some((i) => i.code === 'trigger-unsupported');
    const status: 'ok' | 'error' | 'unsupported' | 'disabled' = !enabled
      ? 'disabled'
      : hasError
      ? 'error'
      : hasUnsupported
      ? 'unsupported'
      : 'ok';
    entries.push({ name: r.name, enabled, status, issues });
  }

  return {
    rules: entries,
    valid: entries.every((e) => e.status !== 'error'),
    unsupportedCount,
  };
}

export interface RulesEngineOptions {
  automation: AutomationBlock | null | undefined;
  aliases: Record<string, string>;
  /** Pre-connected MQTT client — owned by the caller. */
  mqttClient: SwitchBotMqttClient;
  /** Credential exposed so we know the default shadow topic to subscribe to. */
  mqttCredential: MqttCredential;
  /** Optional HTTP client for executeCommand — omit in tests. */
  httpClient?: AxiosInstance;
  /** When true, treat every rule as dry_run regardless of policy. */
  globalDryRun?: boolean;
  /** Max firings before the engine self-stops — test / demo only. */
  maxFirings?: number;
  /** Suppress live API calls. Used by tests that don't want to mock axios. */
  skipApiCall?: boolean;
  /** Side channel for unit tests — drop every processed event here. */
  onFire?: (entry: EngineFireEntry) => void;
}

export interface EngineFireEntry {
  ruleName: string;
  fireId: string;
  /** Final disposition of the fire. */
  status: 'fired' | 'dry' | 'throttled' | 'conditions-failed' | 'unsupported' | 'blocked';
  deviceId?: string;
  reason?: string;
}

export interface EngineStats {
  started: boolean;
  rulesLoaded: number;
  rulesActive: number;
  eventsProcessed: number;
  fires: number;
  dryFires: number;
  throttled: number;
  conditionsFailed: number;
}

export class RulesEngine {
  private readonly opts: RulesEngineOptions;
  private readonly rules: Rule[];
  private readonly throttle = new ThrottleGate();
  private unsubscribeMessage: (() => void) | null = null;
  private unsubscribeState: (() => void) | null = null;
  private cronScheduler: CronScheduler | null = null;
  private started = false;
  private stopped = false;
  /**
   * Sequential dispatch queue. Two MQTT messages arriving in the same
   * tick would otherwise race inside the throttle check — each sees an
   * empty lastFireAt map because neither has recorded yet. Serialising
   * keeps the semantics of `max_per` honest.
   */
  private pendingChain: Promise<void> = Promise.resolve();
  private stats: EngineStats = {
    started: false,
    rulesLoaded: 0,
    rulesActive: 0,
    eventsProcessed: 0,
    fires: 0,
    dryFires: 0,
    throttled: 0,
    conditionsFailed: 0,
  };

  constructor(opts: RulesEngineOptions) {
    this.opts = opts;
    this.rules = (opts.automation?.rules ?? []).filter((r) => r.enabled !== false);
    this.stats.rulesLoaded = opts.automation?.rules?.length ?? 0;
    this.stats.rulesActive = this.rules.length;
  }

  getStats(): EngineStats {
    return { ...this.stats, started: this.started && !this.stopped };
  }

  getRules(): readonly Rule[] {
    return this.rules;
  }

  /**
   * Subscribes to MQTT and begins the pipeline. Throws if the policy
   * block is missing `enabled: true` or if lint finds errors (e.g.
   * destructive command in a rule action).
   */
  async start(): Promise<void> {
    if (this.opts.automation?.enabled !== true) {
      throw new Error('automation.enabled is not true — engine start refused.');
    }
    const lint = lintRules(this.opts.automation);
    if (!lint.valid) {
      const errors = lint.rules.flatMap((r) => r.issues.filter((i) => i.severity === 'error'));
      throw new Error(
        `Rule lint failed: ${errors.map((e) => `${e.rule}:${e.code}`).join(', ')}`,
      );
    }

    if (this.rules.some((r) => isMqttTrigger(r.when))) {
      const topic = this.opts.mqttCredential.topics.status;
      this.opts.mqttClient.subscribe(topic);
      this.unsubscribeMessage = this.opts.mqttClient.onMessage((_topic, payload) => {
        this.enqueue(() => this.onMqttMessage(payload));
      });
    }

    // Cron triggers. We start the scheduler only when at least one cron
    // rule is active — no need to stand up timers otherwise.
    const cronRules = this.rules.filter((r) => isCronTrigger(r.when));
    if (cronRules.length > 0) {
      this.cronScheduler = new CronScheduler({
        dispatch: (rule, event) =>
          this.enqueue(() => this.onCronFire(rule, event)),
      });
      for (const r of cronRules) this.cronScheduler.register(r);
      this.cronScheduler.start();
    }

    this.unsubscribeState = this.opts.mqttClient.onStateChange((state) => {
      if (state === 'failed' && !this.stopped) {
        // Propagate to caller via stats; the rules run command decides
        // whether to exit. No internal restart — we rely on supervisors.
        this.started = false;
      }
    });

    this.started = true;
    this.stats.started = true;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.unsubscribeMessage?.();
    this.unsubscribeState?.();
    this.unsubscribeMessage = null;
    this.unsubscribeState = null;
    if (this.cronScheduler) {
      this.cronScheduler.stop();
      this.cronScheduler = null;
    }
  }

  /**
   * Expose the MQTT pipeline for direct invocation from tests — feeds a
   * synthetic payload through the same matcher/throttle/action chain.
   */
  async ingestMqttForTest(payload: unknown): Promise<void> {
    await this.enqueue(() => this.onMqttMessage(payload, { preParsed: true }));
  }

  /**
   * Fire a cron rule directly without needing the scheduler/timers.
   * Used by tests that want to exercise the dispatch pipeline without
   * depending on fake timers or croner's internals.
   */
  async ingestCronForTest(rule: Rule, when: Date = new Date()): Promise<void> {
    if (!isCronTrigger(rule.when)) {
      throw new Error(`ingestCronForTest: rule "${rule.name}" is not a cron trigger`);
    }
    const event: EngineEvent = {
      source: 'cron',
      event: rule.when.schedule,
      t: when,
      payload: { schedule: rule.when.schedule },
    };
    await this.enqueue(() => this.onCronFire(rule, event));
  }

  /** Read-only peek at cron schedule state — for `rules list` extras. */
  getCronSchedule(ruleName: string): { schedule: string; nextAt: Date | null } | null {
    return this.cronScheduler?.getScheduledFor(ruleName) ?? null;
  }

  /** Test helper — resolves after all queued dispatches complete. */
  async drainForTest(): Promise<void> {
    await this.pendingChain;
  }

  /**
   * Append a task to the dispatch queue; callers get back a promise that
   * resolves when their task finishes (errors are swallowed — we never
   * want the queue itself to die because one rule threw). Returning a
   * promise lets awaited callsites (ingestMqttForTest) observe completion.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.pendingChain.then(() => task().catch(() => undefined));
    this.pendingChain = next;
    return next;
  }

  private async onMqttMessage(payload: Buffer | unknown, opts: { preParsed?: boolean } = {}): Promise<void> {
    if (this.stopped || !this.started) return;
    let parsed: unknown;
    if (opts.preParsed) {
      parsed = payload;
    } else {
      try {
        parsed = JSON.parse((payload as Buffer).toString('utf-8'));
      } catch {
        return;
      }
    }
    this.stats.eventsProcessed++;
    const classified = classifyMqttPayload(parsed);
    const now = new Date();
    const event: EngineEvent = {
      source: 'mqtt',
      event: classified.event,
      deviceId: classified.deviceId,
      t: now,
      payload: parsed,
    };

    for (const rule of this.rules) {
      if (!isMqttTrigger(rule.when)) continue;
      const resolvedFilter = rule.when.device
        ? this.opts.aliases[rule.when.device] ?? rule.when.device
        : undefined;
      if (!matchesMqttTrigger(rule.when, event, resolvedFilter)) continue;
      await this.dispatchRule(rule, event);
      if (this.opts.maxFirings !== undefined && this.stats.eventsProcessed >= 0 && this.firesTotal() >= this.opts.maxFirings) {
        await this.stop();
        return;
      }
    }
  }

  private async onCronFire(rule: Rule, event: EngineEvent): Promise<void> {
    if (this.stopped || !this.started) return;
    this.stats.eventsProcessed++;
    await this.dispatchRule(rule, event);
    if (this.opts.maxFirings !== undefined && this.firesTotal() >= this.opts.maxFirings) {
      await this.stop();
    }
  }

  private firesTotal(): number {
    return this.stats.fires + this.stats.dryFires;
  }

  private async dispatchRule(rule: Rule, event: EngineEvent): Promise<void> {
    const fireId = randomUUID();
    const cond = evaluateConditions(rule.conditions, event.t);
    if (!cond.matched) {
      if (cond.unsupported.length > 0) {
        writeAudit({
          t: event.t.toISOString(),
          kind: 'rule-fire',
          deviceId: event.deviceId ?? 'unknown',
          command: rule.then[0]?.command ?? '',
          parameter: null,
          commandType: 'command',
          dryRun: true,
          result: 'error',
          error: `condition-unsupported:${cond.unsupported.map((u) => u.keyword).join(',')}`,
          rule: {
            name: rule.name,
            triggerSource: rule.when.source,
            matchedDevice: event.deviceId,
            fireId,
            reason: cond.unsupported.map((u) => u.hint).join(' | '),
          },
        });
        this.opts.onFire?.({ ruleName: rule.name, fireId, status: 'unsupported', deviceId: event.deviceId, reason: cond.unsupported.map((u) => u.keyword).join(',') });
        return;
      }
      this.stats.conditionsFailed++;
      this.opts.onFire?.({ ruleName: rule.name, fireId, status: 'conditions-failed', deviceId: event.deviceId, reason: cond.failures.join('; ') });
      return;
    }

    const windowMs = rule.throttle ? parseMaxPerMs(rule.throttle.max_per) : null;
    const throttleKey = event.deviceId;
    const check = this.throttle.check(rule.name, windowMs, event.t.getTime(), throttleKey);
    if (!check.allowed) {
      this.stats.throttled++;
      writeAudit({
        t: event.t.toISOString(),
        kind: 'rule-throttled',
        deviceId: event.deviceId ?? 'unknown',
        command: rule.then[0]?.command ?? '',
        parameter: null,
        commandType: 'command',
        dryRun: true,
        result: 'ok',
        rule: {
          name: rule.name,
          triggerSource: rule.when.source,
          matchedDevice: event.deviceId,
          fireId,
          reason: check.nextAllowedAt
            ? `throttled — next allowed at ${new Date(check.nextAllowedAt).toISOString()}`
            : 'throttled',
        },
      });
      this.opts.onFire?.({ ruleName: rule.name, fireId, status: 'throttled', deviceId: event.deviceId });
      return;
    }

    let fired = false;
    let allDry = true;
    for (const action of rule.then) {
      const result = await executeRuleAction(action, {
        rule,
        fireId,
        aliases: this.opts.aliases,
        httpClient: this.opts.httpClient,
        globalDryRun: this.opts.globalDryRun,
        skipApiCall: this.opts.skipApiCall,
      });
      if (result.blocked) {
        this.opts.onFire?.({ ruleName: rule.name, fireId, status: 'blocked', deviceId: result.deviceId, reason: result.error });
        if ((action.on_error ?? 'continue') === 'stop') break;
        continue;
      }
      if (!result.dryRun) allDry = false;
      if (result.ok) fired = true;
      if (!result.ok && (action.on_error ?? 'continue') === 'stop') break;
    }

    if (fired) {
      if (allDry) this.stats.dryFires++; else this.stats.fires++;
      this.throttle.record(rule.name, event.t.getTime(), throttleKey);
      this.opts.onFire?.({ ruleName: rule.name, fireId, status: allDry ? 'dry' : 'fired', deviceId: event.deviceId });
    }
  }
}
