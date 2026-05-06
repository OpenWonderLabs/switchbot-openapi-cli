import { stringify as yamlStringify, parse as yamlParse } from 'yaml';
import { containsCjk, inferCommandFromIntent } from '../lib/command-keywords.js';
import { UsageError } from '../utils/output.js';
import { writeAudit } from '../utils/audit.js';
import type { Rule, MqttTrigger, CronTrigger, WebhookTrigger, Action } from './types.js';
import type { LLMBackend } from '../llm/index.js';

export interface SuggestRuleOptions {
  intent: string;
  trigger?: 'mqtt' | 'cron' | 'webhook';
  devices?: Array<{ id: string; name?: string; type?: string }>;
  event?: string;
  schedule?: string;
  days?: string[];
  webhookPath?: string;
  llm?: LLMBackend;
  aliases?: Record<string, string>;
}

export interface SuggestRuleResult {
  rule: Rule;
  ruleYaml: string;
  warnings: string[];
}

function buildSuggestedAction(command: string, deviceId?: string): Action {
  if (deviceId) {
    return { command: `devices command ${deviceId} ${command}` };
  }
  return { command: `devices command <id> ${command}` };
}

const TRIGGER_KEYWORDS: Array<{
  pattern: RegExp;
  trigger: 'mqtt' | 'cron' | 'webhook';
  event?: string;
}> = [
  { pattern: /\bmotion\b|\bdetect/i, trigger: 'mqtt', event: 'motion.detected' },
  { pattern: /\bdoor\b|\bcontact\b|\bopen.*sensor/i, trigger: 'mqtt', event: 'contact.opened' },
  { pattern: /\bbutton\b|\bpress/i, trigger: 'mqtt', event: 'button.pressed' },
  { pattern: /\bwebhook\b|\bhttp\b|\bifttt\b/i, trigger: 'webhook' },
  { pattern: /\bevery\b|\bdaily\b|\bmorning\b|\bnight\b|\bevening\b|\b\d{1,2}\s*[ap]m\b/i, trigger: 'cron' },
];

function inferTrigger(intent: string): { trigger: 'mqtt' | 'cron' | 'webhook'; event?: string } {
  for (const t of TRIGGER_KEYWORDS) {
    if (t.pattern.test(intent)) return { trigger: t.trigger, event: t.event };
  }
  return { trigger: 'mqtt', event: 'device.shadow' };
}

function inferSchedule(intent: string, warnings: string[]): string {
  const amMatch = /\b(\d{1,2})\s*am\b/i.exec(intent);
  if (amMatch) return `0 ${parseInt(amMatch[1], 10)} * * *`;

  const pmMatch = /\b(\d{1,2})\s*pm\b/i.exec(intent);
  if (pmMatch) return `0 ${parseInt(pmMatch[1], 10) + 12} * * *`;

  if (/\bevery\s*hour/i.test(intent)) return '0 * * * *';
  if (/\bnight\b|\bevening\b/i.test(intent)) return '0 22 * * *';
  if (/\bmorning\b/i.test(intent)) return '0 8 * * *';

  warnings.push(
    `Could not infer cron schedule from intent "${intent}" — defaulted to "0 8 * * *". Edit the generated rule to set the correct schedule.`,
  );
  return '0 8 * * *';
}

function inferCommand(intent: string, warnings: string[]): string {
  const command = inferCommandFromIntent(intent);
  if (command) return command;
  if (containsCjk(intent)) {
    throw new UsageError(
      `Intent "${intent}" contains non-English command text that this heuristic cannot safely infer. Use explicit English command words (turnOn/turnOff/open/close/lock/unlock/press/pause) or edit the generated rule manually.`,
    );
  }
  warnings.push(
    `Could not infer command from intent "${intent}" — defaulted to "turnOn". Edit the generated rule to set the correct command.`,
  );
  return 'turnOn';
}

export async function suggestRule(opts: SuggestRuleOptions): Promise<SuggestRuleResult> {
  // LLM path
  if (opts.llm && opts.llm !== 'auto') {
    return suggestRuleWithLlm(opts, opts.llm as Exclude<LLMBackend, 'auto'>);
  }
  if (opts.llm === 'auto') {
    const { scoreIntentComplexity, LLM_AUTO_THRESHOLD } = await import('../llm/index.js');
    if (scoreIntentComplexity(opts.intent) >= LLM_AUTO_THRESHOLD) {
      try {
        return await suggestRuleWithLlm(opts, detectLlmBackend());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const heuristic = suggestRuleHeuristic(opts);
        heuristic.warnings.unshift(`LLM backend failed (${msg}), fell back to heuristic`);
        return heuristic;
      }
    }
  }
  return suggestRuleHeuristic(opts);
}

function detectLlmBackend(): Exclude<LLMBackend, 'auto'> {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.LLM_API_KEY) return 'openai';
  throw new UsageError('No LLM API key found. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or LLM_API_KEY to use --llm auto.');
}

async function suggestRuleWithLlm(opts: SuggestRuleOptions, backend: Exclude<LLMBackend, 'auto'>): Promise<SuggestRuleResult> {
  const { createLLMProvider } = await import('../llm/index.js');
  const { buildRuleSuggestSystemPrompt } = await import('../llm/rule-prompt.js');
  const { lintRules } = await import('./engine.js');

  const provider = createLLMProvider(backend);
  const systemPrompt = buildRuleSuggestSystemPrompt(opts.devices ?? [], opts.aliases ?? {});

  let userMessage = opts.intent;
  if (opts.trigger)        userMessage += `\nConstraint — trigger type: ${opts.trigger}`;
  if (opts.event)          userMessage += `\nConstraint — trigger event: ${opts.event}`;
  if (opts.schedule)       userMessage += `\nConstraint — cron schedule: ${opts.schedule}`;
  if (opts.days?.length)   userMessage += `\nConstraint — days filter: ${opts.days.join(', ')}`;
  if (opts.webhookPath)    userMessage += `\nConstraint — webhook path: ${opts.webhookPath}`;

  const start = Date.now();
  const rawYaml = await provider.generateYaml(systemPrompt, userMessage);
  const latencyMs = Date.now() - start;

  writeAudit({
    t: new Date().toISOString(),
    kind: 'llm-suggest',
    deviceId: '',
    command: `llm-suggest:${backend}`,
    parameter: opts.intent.slice(0, 200),
    commandType: 'command',
    dryRun: false,
    result: 'ok',
    llmBackend: backend,
    llmModel: provider.model,
    llmLatencyMs: latencyMs,
  });

  if (rawYaml.trimStart().startsWith('# ERROR:')) {
    throw new UsageError(`LLM could not generate rule: ${rawYaml.replace(/^#\s*ERROR:\s*/i, '').trim()}`);
  }

  const parsed = yamlParse(rawYaml);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    !('when' in parsed) ||
    !('then' in parsed)
  ) {
    throw new UsageError('LLM returned unexpected output structure (expected a rule object with when/then fields)');
  }
  const rule = parsed as Rule;
  const lintResult = lintRules({ enabled: true, rules: [rule] });
  if (!lintResult.valid) {
    const errors = lintResult.rules[0]?.issues.filter(i => i.severity === 'error').map(i => i.message).join('; ');
    throw new UsageError(`LLM-generated rule failed lint: ${errors}`);
  }

  const ruleYaml = yamlStringify(rule, { lineWidth: 0 });
  return { rule, ruleYaml, warnings: [] };
}

function suggestRuleHeuristic(opts: SuggestRuleOptions): SuggestRuleResult {
  const warnings: string[] = [];
  const cjkIntent = containsCjk(opts.intent);

  // Resolve trigger
  let triggerSource = opts.trigger;
  let inferredEvent: string | undefined;
  if (!triggerSource) {
    const inferred = inferTrigger(opts.intent);
    triggerSource = inferred.trigger;
    inferredEvent = inferred.event;
    if (inferredEvent === 'device.shadow') {
      if (cjkIntent) {
        throw new UsageError(
          `Intent "${opts.intent}" contains non-English trigger text that this heuristic cannot safely infer. Re-run with --trigger and, for mqtt rules, --event explicitly.`,
        );
      }
      warnings.push(
        `Could not infer trigger type from intent "${opts.intent}" — defaulted to mqtt/device.shadow. Set --trigger and --event explicitly.`,
      );
    }
  }

  // Build the when block
  let when: MqttTrigger | CronTrigger | WebhookTrigger;
  if (triggerSource === 'mqtt') {
    const event = opts.event ?? inferredEvent ?? 'device.shadow';
    const mqttTrigger: MqttTrigger = { source: 'mqtt', event };
    if (opts.devices && opts.devices.length > 0) {
      const sensorDevice = opts.devices[0];
      mqttTrigger.device = sensorDevice.name ?? sensorDevice.id;
    }
    when = mqttTrigger;
  } else if (triggerSource === 'cron') {
    if (cjkIntent && !opts.schedule) {
      throw new UsageError(
        `Intent "${opts.intent}" contains non-English scheduling text that this heuristic cannot safely infer. Re-run with --schedule "<cron>" explicitly.`,
      );
    }
    const schedule = opts.schedule ?? inferSchedule(opts.intent, warnings);
    const cronTrigger: CronTrigger = { source: 'cron', schedule };
    if (opts.days && opts.days.length > 0) cronTrigger.days = opts.days as never;
    when = cronTrigger;
  } else {
    when = { source: 'webhook', path: opts.webhookPath ?? '/action' };
  }

  // Build then[] — one action per device (skip the sensor device for mqtt)
  const command = inferCommand(opts.intent, warnings);
  const actionDevices =
    triggerSource === 'mqtt' && opts.devices && opts.devices.length > 1
      ? opts.devices.slice(1)
      : (opts.devices ?? []);

  const then: Action[] = actionDevices.length > 0
    ? actionDevices.map((d) => buildSuggestedAction(command, d.id))
    : [buildSuggestedAction(command)];

  const rule: Rule = {
    name: opts.intent,
    when,
    then,
    dry_run: true,
    ...(triggerSource === 'mqtt' ? { throttle: { max_per: '10m' } } : {}),
  };

  const ruleYaml = yamlStringify(rule, { lineWidth: 0 });

  return { rule, ruleYaml, warnings };
}
