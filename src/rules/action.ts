/**
 * Rule action executor — the only place that calls into `executeCommand`
 * from the rules pipeline.
 *
 * Responsibilities:
 *   1. Parse the `command` string into a `{ deviceId, verb, parameter }`
 *      tuple, rejecting shapes the PoC doesn't understand.
 *   2. Enforce the destructive-command blocklist as a second line of
 *      defence (the validator should have caught it at load time — this
 *      protects against hand-crafted engine inputs).
 *   3. Resolve `action.device` (alias or deviceId) into the `<id>`
 *      slot.
 *   4. Branch on `dry_run`: dry-run writes audit with kind
 *      `rule-fire-dry` and returns without touching the API.
 *   5. Live run delegates to `executeCommand`, then re-writes audit
 *      with the rule-scoped kind + fireId so `rules tail` / `replay`
 *      can correlate multi-action fires.
 */

import type { AxiosInstance } from 'axios';
import { executeCommand } from '../lib/devices.js';
import { writeAudit } from '../utils/audit.js';
import { isDestructiveCommand } from './destructive.js';
import type { Action, Rule } from './types.js';

export interface RuleActionContext {
  /** Rule the action belongs to — used for audit correlation. */
  rule: Rule;
  /** UUID correlating every audit line of one trigger fire. */
  fireId: string;
  /** Policy-level aliases: friendly name → deviceId. */
  aliases: Record<string, string>;
  /** Optional axios client (prod path); omit in tests. */
  httpClient?: AxiosInstance;
  /** Global dry-run override (from `switchbot rules run --dry-run`). */
  globalDryRun?: boolean;
  /** When true, do not actually call `executeCommand` even if live.
   *  Exposed separately from `globalDryRun` so tests can exercise the
   *  "would call executeCommand" branch without mocking axios. */
  skipApiCall?: boolean;
}

export interface RuleActionResult {
  ok: boolean;
  deviceId?: string;
  verb?: string;
  error?: string;
  /** True when the action was refused for safety (destructive verb). */
  blocked?: boolean;
  /** True when the action wrote a dry-run audit instead of calling the API. */
  dryRun?: boolean;
}

interface ParsedCommand {
  deviceIdSlot: string | null; // literal deviceId or "<id>" placeholder
  verb: string;
  parameterTokens: string[];
}

const DEVICES_COMMAND_RE = /^devices\s+command\s+(\S+)\s+(\S+)(?:\s+(.*))?$/;

export function parseRuleCommand(cmd: string): ParsedCommand | null {
  const m = DEVICES_COMMAND_RE.exec(cmd.trim());
  if (!m) return null;
  const deviceIdSlot = m[1];
  const verb = m[2];
  const rest = (m[3] ?? '').trim();
  return {
    deviceIdSlot,
    verb,
    parameterTokens: rest.length === 0 ? [] : rest.split(/\s+/),
  };
}

/** Alias-first resolver — falls back to the raw value (assumed deviceId). */
export function resolveActionDevice(
  explicit: string | undefined,
  slot: string | null,
  aliases: Record<string, string>,
): string | null {
  // Explicit device field on the action wins.
  const candidate = explicit ?? (slot && slot !== '<id>' ? slot : null);
  if (!candidate) return null;
  if (aliases[candidate]) return aliases[candidate];
  return candidate;
}

/**
 * Render a parameter for SwitchBot's command API. For the PoC we pass
 * the raw token string for single-token args, join with `:` for
 * multi-token args (matches the CLI's `devices command` convention),
 * and `undefined` when no tokens were supplied (the SDK substitutes
 * `'default'`).
 */
function renderParameter(tokens: string[]): unknown {
  if (tokens.length === 0) return undefined;
  if (tokens.length === 1) return tokens[0];
  return tokens.join(':');
}

export async function executeRuleAction(
  action: Action,
  ctx: RuleActionContext,
): Promise<RuleActionResult> {
  const parsed = parseRuleCommand(action.command);
  if (!parsed) {
    writeAudit({
      t: new Date().toISOString(),
      kind: 'rule-fire',
      deviceId: 'unknown',
      command: action.command,
      parameter: null,
      commandType: 'command',
      dryRun: true,
      result: 'error',
      error: 'unparseable-command',
      rule: {
        name: ctx.rule.name,
        triggerSource: ctx.rule.when.source,
        fireId: ctx.fireId,
        reason: 'unparseable-command',
      },
    });
    return { ok: false, error: 'unparseable-command', blocked: true };
  }

  if (isDestructiveCommand(action.command)) {
    writeAudit({
      t: new Date().toISOString(),
      kind: 'rule-fire',
      deviceId: resolveActionDevice(action.device, parsed.deviceIdSlot, ctx.aliases) ?? 'unknown',
      command: action.command,
      parameter: null,
      commandType: 'command',
      dryRun: true,
      result: 'error',
      error: `destructive-verb:${parsed.verb}`,
      rule: {
        name: ctx.rule.name,
        triggerSource: ctx.rule.when.source,
        fireId: ctx.fireId,
        reason: `destructive verb "${parsed.verb}" refused at runtime`,
      },
    });
    return { ok: false, error: `destructive-verb:${parsed.verb}`, blocked: true, verb: parsed.verb };
  }

  const deviceId = resolveActionDevice(action.device, parsed.deviceIdSlot, ctx.aliases);
  if (!deviceId || deviceId === '<id>') {
    writeAudit({
      t: new Date().toISOString(),
      kind: 'rule-fire',
      deviceId: 'unknown',
      command: action.command,
      parameter: null,
      commandType: 'command',
      dryRun: true,
      result: 'error',
      error: 'missing-device',
      rule: {
        name: ctx.rule.name,
        triggerSource: ctx.rule.when.source,
        fireId: ctx.fireId,
        reason: 'action omitted `device` and command used `<id>` placeholder',
      },
    });
    return { ok: false, error: 'missing-device', verb: parsed.verb };
  }

  const dryRun = ctx.globalDryRun === true || ctx.rule.dry_run === true;
  const parameter = renderParameter(parsed.parameterTokens);

  if (dryRun) {
    writeAudit({
      t: new Date().toISOString(),
      kind: 'rule-fire-dry',
      deviceId,
      command: parsed.verb,
      parameter: parameter ?? 'default',
      commandType: 'command',
      dryRun: true,
      result: 'ok',
      rule: {
        name: ctx.rule.name,
        triggerSource: ctx.rule.when.source,
        matchedDevice: deviceId,
        fireId: ctx.fireId,
      },
    });
    return { ok: true, dryRun: true, deviceId, verb: parsed.verb };
  }

  if (ctx.skipApiCall) {
    writeAudit({
      t: new Date().toISOString(),
      kind: 'rule-fire',
      deviceId,
      command: parsed.verb,
      parameter: parameter ?? 'default',
      commandType: 'command',
      dryRun: false,
      result: 'ok',
      rule: {
        name: ctx.rule.name,
        triggerSource: ctx.rule.when.source,
        matchedDevice: deviceId,
        fireId: ctx.fireId,
        reason: 'api-skipped',
      },
    });
    return { ok: true, deviceId, verb: parsed.verb };
  }

  try {
    await executeCommand(deviceId, parsed.verb, parameter, 'command', ctx.httpClient);
    writeAudit({
      t: new Date().toISOString(),
      kind: 'rule-fire',
      deviceId,
      command: parsed.verb,
      parameter: parameter ?? 'default',
      commandType: 'command',
      dryRun: false,
      result: 'ok',
      rule: {
        name: ctx.rule.name,
        triggerSource: ctx.rule.when.source,
        matchedDevice: deviceId,
        fireId: ctx.fireId,
      },
    });
    return { ok: true, deviceId, verb: parsed.verb };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeAudit({
      t: new Date().toISOString(),
      kind: 'rule-fire',
      deviceId,
      command: parsed.verb,
      parameter: parameter ?? 'default',
      commandType: 'command',
      dryRun: false,
      result: 'error',
      error: msg,
      rule: {
        name: ctx.rule.name,
        triggerSource: ctx.rule.when.source,
        matchedDevice: deviceId,
        fireId: ctx.fireId,
      },
    });
    return { ok: false, error: msg, deviceId, verb: parsed.verb };
  }
}

/**
 * Extract the raw deviceId from an action object without alias resolution.
 * Prefers `action.device` over the deviceId embedded in the command string.
 * Use resolveActionDevice() when alias resolution is needed.
 */
export function extractDeviceIdFromAction(action: { command: string; device?: string }): string | null {
  if (action.device) return action.device;
  const m = /\bdevices\s+command\s+(\S+)/.exec(action.command ?? '');
  return m ? m[1] : null;
}
