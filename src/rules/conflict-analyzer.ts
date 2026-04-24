/**
 * Static conflict analysis for automation rules.
 *
 * Detects patterns that are technically valid but likely to cause
 * operational problems:
 *
 *   1. Opposing-action pairs — same device, opposite commands (e.g.
 *      turnOn / turnOff), triggered by the same source within a short
 *      window and with no throttle on either rule.
 *
 *   2. High-frequency MQTT rules without throttle — rules that listen
 *      on `device.shadow` (catch-all) with no throttle can fire on
 *      every shadow push (up to once per second) and exhaust the daily
 *      API quota quickly.
 *
 *   3. Potentially-destructive action without quiet-hours protection —
 *      a rule that targets a destructive verb is technically blocked by
 *      the engine, but we can still flag it early so users don't get a
 *      surprise at runtime.
 *
 * Results are designed to be consumed by `rules doctor --json` and
 * by CI pipelines. Each finding carries a `severity` so callers can
 * decide how to gate on them.
 */

import type { Rule } from './types.js';
import { parseMaxPerMs } from './throttle.js';
import { isDestructiveCommand } from './destructive.js';

export type ConflictSeverity = 'error' | 'warning' | 'info';

export interface ConflictFinding {
  severity: ConflictSeverity;
  code: string;
  message: string;
  /** Rule names involved in this finding. */
  rules: string[];
  hint?: string;
}

export interface ConflictReport {
  findings: ConflictFinding[];
  /** Count per severity level. */
  counts: Record<ConflictSeverity, number>;
  /** True when there are no error-severity findings. */
  clean: boolean;
}

/** Known opposing command pairs (order-independent). */
const OPPOSING_PAIRS: Array<[string, string]> = [
  ['turnOn', 'turnOff'],
  ['lock', 'unlock'],
  ['open', 'close'],
  ['openDoor', 'closeDoor'],
  ['openCurtain', 'closeCurtain'],
  ['turnOn', 'standby'],
  ['brightnessUp', 'brightnessDown'],
  ['volumeUp', 'volumeDown'],
  ['fanSpeedUp', 'fanSpeedDown'],
];

function commandsAreOpposing(a: string, b: string): boolean {
  for (const [x, y] of OPPOSING_PAIRS) {
    if ((a === x && b === y) || (a === y && b === x)) return true;
  }
  return false;
}

function extractDeviceFromAction(action: { command: string; device?: string }): string | null {
  return action.device ?? null;
}

function extractCommandVerb(command: string): string {
  // command strings are like "devices command <id> turnOn" — extract last token
  const parts = command.trim().split(/\s+/);
  return parts[parts.length - 1] ?? command;
}

function effectiveCooldownMs(rule: Rule): number | null {
  if (rule.cooldown) {
    try { return parseMaxPerMs(rule.cooldown); } catch { return null; }
  }
  if (rule.throttle?.max_per) {
    try { return parseMaxPerMs(rule.throttle.max_per); } catch { return null; }
  }
  return null;
}

export function analyzeConflicts(rules: Rule[]): ConflictReport {
  const findings: ConflictFinding[] = [];
  const active = rules.filter((r) => r.enabled !== false);

  // 1. Opposing-action pairs on the same device
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      // Only flag when they share the same trigger source (otherwise they
      // can't race each other in normal operation).
      if (a.when.source !== b.when.source) continue;

      const cooldownA = effectiveCooldownMs(a);
      const cooldownB = effectiveCooldownMs(b);
      // If both rules have meaningful cooldowns (≥ 5 minutes), the risk is
      // low — skip.
      const bothThrottled =
        cooldownA !== null && cooldownA >= 5 * 60_000 &&
        cooldownB !== null && cooldownB >= 5 * 60_000;
      if (bothThrottled) continue;

      for (const actionA of a.then) {
        for (const actionB of b.then) {
          const deviceA = extractDeviceFromAction(actionA);
          const deviceB = extractDeviceFromAction(actionB);
          // Skip if devices can't be compared.
          if (!deviceA || !deviceB || deviceA !== deviceB) continue;
          const verbA = extractCommandVerb(actionA.command);
          const verbB = extractCommandVerb(actionB.command);
          if (commandsAreOpposing(verbA, verbB)) {
            const noThrottle = cooldownA === null || cooldownB === null;
            findings.push({
              severity: noThrottle ? 'warning' : 'info',
              code: 'opposing-actions',
              message: `Rules "${a.name}" and "${b.name}" issue opposing commands (${verbA} / ${verbB}) on device "${deviceA}" via the same trigger source.`,
              rules: [a.name, b.name],
              hint: noThrottle
                ? 'Add a "cooldown" or "throttle.max_per" to both rules to prevent rapid state oscillation.'
                : undefined,
            });
          }
        }
      }
    }
  }

  // 2. High-frequency MQTT catch-all rules without throttle
  for (const rule of active) {
    if (rule.when.source !== 'mqtt') continue;
    const event = (rule.when as { event: string }).event;
    const isHighFreq = event === 'device.shadow' || event === '*';
    if (!isHighFreq) continue;
    const cooldown = effectiveCooldownMs(rule);
    if (cooldown === null) {
      findings.push({
        severity: 'warning',
        code: 'high-frequency-no-throttle',
        message: `Rule "${rule.name}" listens on "${event}" (high-frequency catch-all) with no throttle/cooldown. This can rapidly exhaust the daily API quota.`,
        rules: [rule.name],
        hint: 'Add "cooldown: 1m" or "throttle: { max_per: 1m }" to rate-limit this rule.',
      });
    } else if (cooldown < 30_000) {
      findings.push({
        severity: 'info',
        code: 'high-frequency-low-throttle',
        message: `Rule "${rule.name}" listens on "${event}" with a throttle under 30 s. Consider increasing to at least 1 m to protect API quota.`,
        rules: [rule.name],
      });
    }
  }

  // 3. Destructive actions in rules (engine blocks these at runtime, but
  //    surface early with clear guidance).
  for (const rule of active) {
    for (let i = 0; i < rule.then.length; i++) {
      const verb = extractCommandVerb(rule.then[i].command);
      if (isDestructiveCommand(verb)) {
        findings.push({
          severity: 'error',
          code: 'destructive-action-in-rule',
          message: `Rule "${rule.name}" then[${i}] contains destructive command "${verb}". The engine blocks this at runtime.`,
          rules: [rule.name],
          hint: 'Remove the destructive command or replace it with a non-destructive alternative.',
        });
      }
    }
  }

  const counts: Record<ConflictSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  return {
    findings,
    counts,
    clean: counts.error === 0,
  };
}
