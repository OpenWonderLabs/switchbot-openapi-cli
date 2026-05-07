import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadSchemaSnippet(): string {
  const schemaPath = join(__dirname, '../policy/schema/v0.2.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as Record<string, unknown>;
  const defs = schema.$defs as Record<string, unknown>;
  return JSON.stringify({
    rule: defs?.rule,
    commandAction: defs?.commandAction,
    notifyAction: defs?.notifyAction,
    condition: defs?.condition,
    trigger: defs?.trigger,
    triggerMqtt: defs?.triggerMqtt,
    triggerCron: defs?.triggerCron,
    triggerWebhook: defs?.triggerWebhook,
  }, null, 2);
}

export interface DeviceSummary {
  id: string;
  name?: string;
  type?: string;
}

export function buildRuleSuggestSystemPrompt(devices: DeviceSummary[], aliases: Record<string, string>): string {
  // NOTE: tests/llm/rule-prompt.test.ts extracts the embedded schema snippet
  // by string-slicing between "JSON Schema:\n" and "\n\nRules:" — keep those
  // two delimiters intact (or update that test) when reformatting this prompt.
  return `You are a SwitchBot automation rule generator.

Output ONLY a valid YAML object for a single rule conforming to this JSON Schema:
${loadSchemaSnippet()}

Rules:
- Output ONLY YAML. No explanation, no markdown fences, no surrounding text.
- Always include dry_run: true.
- MQTT trigger events: device.shadow, motion.detected, motion.cleared, contact.opened, contact.closed, button.pressed.
- For cron use standard 5-field cron in local timezone.
- Webhook trigger uses { source: webhook, path: "/your-path" } where path matches ^/[a-z0-9/_-]+$.
- Device commands: "devices command <deviceId> <verb>". Valid verbs: turnOn, turnOff, open, close, lock, unlock, press, pause.
- Set on_error: continue unless the intent explicitly requires stopping.
- If you cannot generate a valid rule, output: # ERROR: <reason>

Available devices:
${devices.length > 0 ? devices.map(d => `- id: ${d.id}  name: ${d.name ?? '(unnamed)'}  type: ${d.type ?? 'unknown'}`).join('\n') : '(none provided)'}

Aliases:
${Object.keys(aliases).length > 0 ? Object.entries(aliases).map(([k, v]) => `- ${k}: ${v}`).join('\n') : '(none defined)'}`;
}
