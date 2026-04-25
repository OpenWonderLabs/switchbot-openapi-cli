import { stringify as yamlStringify } from 'yaml';
import { COMMAND_KEYWORDS } from '../lib/command-keywords.js';
import type { Rule, MqttTrigger, CronTrigger, WebhookTrigger, Action } from './types.js';

export interface SuggestRuleOptions {
  intent: string;
  trigger?: 'mqtt' | 'cron' | 'webhook';
  devices?: Array<{ id: string; name?: string; type?: string }>;
  event?: string;
  schedule?: string;
  days?: string[];
  webhookPath?: string;
}

export interface SuggestRuleResult {
  rule: Rule;
  ruleYaml: string;
  warnings: string[];
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
  for (const k of COMMAND_KEYWORDS) {
    if (k.pattern.test(intent)) return k.command;
  }
  warnings.push(
    `Could not infer command from intent "${intent}" — defaulted to "turnOn". Edit the generated rule to set the correct command.`,
  );
  return 'turnOn';
}

export function suggestRule(opts: SuggestRuleOptions): SuggestRuleResult {
  const warnings: string[] = [];

  // Resolve trigger
  let triggerSource = opts.trigger;
  let inferredEvent: string | undefined;
  if (!triggerSource) {
    const inferred = inferTrigger(opts.intent);
    triggerSource = inferred.trigger;
    inferredEvent = inferred.event;
    if (inferredEvent === 'device.shadow') {
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
    ? actionDevices.map((d) => ({
        command: `devices command <id> ${command}`,
        device: d.id,
      }))
    : [{ command: `devices command <id> ${command}` }];

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
