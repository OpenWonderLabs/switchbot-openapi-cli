import { Command } from 'commander';
import fs from 'node:fs';
import { printJson, isJsonMode, handleError } from '../utils/output.js';
import { executeCommand, isDestructiveCommand } from '../lib/devices.js';
import { executeScene } from '../lib/scenes.js';
import { getCachedDevice } from '../devices/cache.js';
import { resolveDeviceId } from '../utils/name-resolver.js';

export interface PlanCommandStep {
  type: 'command';
  deviceId?: string;
  deviceName?: string;
  command: string;
  parameter?: unknown;
  commandType?: 'command' | 'customize';
  note?: string;
}

export interface PlanSceneStep {
  type: 'scene';
  sceneId: string;
  note?: string;
}

export interface PlanWaitStep {
  type: 'wait';
  ms: number;
  note?: string;
}

export type PlanStep = PlanCommandStep | PlanSceneStep | PlanWaitStep;

export interface Plan {
  version: '1.0';
  description?: string;
  steps: PlanStep[];
}

const PLAN_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://switchbot.dev/plan-1.0.json',
  title: 'SwitchBot Plan',
  description:
    'Declarative batch of SwitchBot operations. Agent-authored; CLI validates and executes. No LLM inside the CLI — the schema is the contract.',
  type: 'object',
  required: ['version', 'steps'],
  properties: {
    version: { const: '1.0' },
    description: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        oneOf: [
          {
            type: 'object',
            required: ['type', 'command'],
            oneOf: [
              { required: ['deviceId'], not: { required: ['deviceName'] } },
              { required: ['deviceName'], not: { required: ['deviceId'] } },
            ],
            properties: {
              type: { const: 'command' },
              deviceId: { type: 'string', minLength: 1 },
              deviceName: { type: 'string', minLength: 1 },
              command: { type: 'string', minLength: 1 },
              parameter: {},
              commandType: { enum: ['command', 'customize'] },
              note: { type: 'string' },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'sceneId'],
            properties: {
              type: { const: 'scene' },
              sceneId: { type: 'string', minLength: 1 },
              note: { type: 'string' },
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['type', 'ms'],
            properties: {
              type: { const: 'wait' },
              ms: { type: 'integer', minimum: 0, maximum: 600000 },
              note: { type: 'string' },
            },
            additionalProperties: false,
          },
        ],
      },
    },
  },
  additionalProperties: false,
} as const;

export interface PlanValidationIssue {
  path: string;
  message: string;
}

export function validatePlan(raw: unknown): {
  ok: true;
  plan: Plan;
} | { ok: false; issues: PlanValidationIssue[] } {
  const issues: PlanValidationIssue[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ path: '$', message: 'plan must be a JSON object' }] };
  }
  const p = raw as Record<string, unknown>;
  if (p.version !== '1.0') {
    issues.push({ path: 'version', message: 'must equal "1.0"' });
  }
  if (!Array.isArray(p.steps)) {
    issues.push({ path: 'steps', message: 'must be an array' });
    return { ok: false, issues };
  }
  p.steps.forEach((step, i) => {
    const at = `steps[${i}]`;
    if (!step || typeof step !== 'object') {
      issues.push({ path: at, message: 'must be an object' });
      return;
    }
    const s = step as Record<string, unknown>;
    switch (s.type) {
      case 'command':
        if (s.deviceId !== undefined && (typeof s.deviceId !== 'string' || !s.deviceId)) {
          issues.push({ path: `${at}.deviceId`, message: 'must be a non-empty string when provided' });
        }
        if (s.deviceName !== undefined && (typeof s.deviceName !== 'string' || !s.deviceName)) {
          issues.push({ path: `${at}.deviceName`, message: 'must be a non-empty string when provided' });
        }
        if (!s.deviceId && !s.deviceName) {
          issues.push({ path: `${at}`, message: 'must have either "deviceId" or "deviceName"' });
        }
        if (s.deviceId && s.deviceName) {
          issues.push({ path: `${at}`, message: '"deviceId" and "deviceName" cannot both be set' });
        }
        if (typeof s.command !== 'string' || !s.command) {
          issues.push({ path: `${at}.command`, message: 'must be a non-empty string' });
        }
        if (
          s.commandType !== undefined &&
          s.commandType !== 'command' &&
          s.commandType !== 'customize'
        ) {
          issues.push({
            path: `${at}.commandType`,
            message: 'must be "command" or "customize"',
          });
        }
        break;
      case 'scene':
        if (typeof s.sceneId !== 'string' || !s.sceneId) {
          issues.push({ path: `${at}.sceneId`, message: 'must be a non-empty string' });
        }
        break;
      case 'wait':
        if (typeof s.ms !== 'number' || !Number.isInteger(s.ms) || s.ms < 0 || s.ms > 600_000) {
          issues.push({
            path: `${at}.ms`,
            message: 'must be an integer in [0, 600000]',
          });
        }
        break;
      default:
        issues.push({
          path: `${at}.type`,
          message: 'must be one of "command" | "scene" | "wait"',
        });
    }
  });
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, plan: raw as Plan };
}

async function readPlanSource(file: string | undefined): Promise<unknown> {
  const text = file === undefined || file === '-'
    ? await readStdin()
    : fs.readFileSync(file, 'utf8');
  if (!text.trim()) {
    throw new Error(
      file === undefined || file === '-'
        ? 'no plan received on stdin'
        : `plan file is empty: ${file}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`plan is not valid JSON: ${(err as Error).message}`);
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

export interface PlanRunResult {
  plan: Plan;
  results: Array<
    | { step: number; type: 'command'; deviceId: string; command: string; status: 'ok' | 'error' | 'skipped'; error?: string }
    | { step: number; type: 'scene'; sceneId: string; status: 'ok' | 'error' | 'skipped'; error?: string }
    | { step: number; type: 'wait'; ms: number; status: 'ok' | 'skipped' }
  >;
  summary: { total: number; ok: number; error: number; skipped: number };
}

/**
 * Shared plan executor used by both the CLI `plan run` action and the MCP
 * `plan_run` tool. `onStep` is an optional progress hook for human output;
 * MCP callers leave it unset and consume the returned PlanRunResult instead.
 */
export async function runPlan(
  plan: Plan,
  options: {
    yes?: boolean;
    continueOnError?: boolean;
    onStep?: (line: string) => void;
  } = {},
): Promise<PlanRunResult> {
  const out: PlanRunResult = {
    plan,
    results: [],
    summary: { total: plan.steps.length, ok: 0, error: 0, skipped: 0 },
  };
  const emit = (line: string) => options.onStep?.(line);

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const idx = i + 1;
    if (step.type === 'wait') {
      await new Promise((r) => setTimeout(r, step.ms));
      out.results.push({ step: idx, type: 'wait', ms: step.ms, status: 'ok' });
      out.summary.ok++;
      emit(`  ${idx}. wait ${step.ms}ms`);
      continue;
    }
    if (step.type === 'scene') {
      try {
        await executeScene(step.sceneId);
        out.results.push({ step: idx, type: 'scene', sceneId: step.sceneId, status: 'ok' });
        out.summary.ok++;
        emit(`  ${idx}. ✓ scene ${step.sceneId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out.results.push({ step: idx, type: 'scene', sceneId: step.sceneId, status: 'error', error: msg });
        out.summary.error++;
        emit(`  ${idx}. ✗ scene ${step.sceneId}: ${msg}`);
        if (!options.continueOnError) break;
      }
      continue;
    }
    // command
    const resolvedDeviceId = resolveDeviceId(step.deviceId, step.deviceName);
    const deviceType = getCachedDevice(resolvedDeviceId)?.type;
    const commandType = step.commandType ?? 'command';
    const destructive = isDestructiveCommand(deviceType, step.command, commandType);
    if (destructive && !options.yes) {
      out.results.push({
        step: idx,
        type: 'command',
        deviceId: resolvedDeviceId,
        command: step.command,
        status: 'skipped',
        error: 'destructive — rerun with --yes',
      });
      out.summary.skipped++;
      emit(`  ${idx}. ⚠ skipped ${step.command} on ${resolvedDeviceId} (destructive — pass --yes)`);
      if (!options.continueOnError) break;
      continue;
    }
    try {
      await executeCommand(resolvedDeviceId, step.command, step.parameter, commandType);
      out.results.push({
        step: idx,
        type: 'command',
        deviceId: resolvedDeviceId,
        command: step.command,
        status: 'ok',
      });
      out.summary.ok++;
      emit(`  ${idx}. ✓ ${step.command} on ${resolvedDeviceId}`);
    } catch (err) {
      if (err instanceof Error && err.name === 'DryRunSignal') {
        out.results.push({
          step: idx,
          type: 'command',
          deviceId: resolvedDeviceId,
          command: step.command,
          status: 'ok',
        });
        out.summary.ok++;
        emit(`  ${idx}. ◦ dry-run ${step.command} on ${resolvedDeviceId}`);
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      out.results.push({
        step: idx,
        type: 'command',
        deviceId: resolvedDeviceId,
        command: step.command,
        status: 'error',
        error: msg,
      });
      out.summary.error++;
      emit(`  ${idx}. ✗ ${step.command} on ${resolvedDeviceId}: ${msg}`);
      if (!options.continueOnError) break;
    }
  }

  return out;
}

export function registerPlanCommand(program: Command): void {
  const plan = program
    .command('plan')
    .description('Agent-authored batch plans: schema, validate, run')
    .addHelpText('after', `
A "plan" is a JSON document describing a sequence of commands/scenes/waits.
The schema is fixed — agents emit plans, the CLI executes them. No LLM inside.

  { "version": "1.0", "description": "...", "steps": [
      { "type": "command", "deviceId": "...", "command": "turnOff" },
      { "type": "wait", "ms": 500 },
      { "type": "scene",  "sceneId": "..." }
  ]}

Workflow:
  $ switchbot plan schema > plan.schema.json     # export the contract
  $ switchbot plan validate my-plan.json          # check shape without running
  $ switchbot --dry-run plan run my-plan.json     # preview (mutations skipped)
  $ switchbot plan run my-plan.json --yes         # execute destructive steps
  $ cat plan.json | switchbot plan run -          # or stream via stdin
`);

  plan
    .command('schema')
    .description('Print the JSON Schema for the plan format')
    .action(() => {
      printJson(PLAN_JSON_SCHEMA);
    });

  plan
    .command('validate')
    .description('Validate a plan file (or stdin) against the schema')
    .argument('[file]', 'Path to plan.json, or "-" / omit to read stdin')
    .action(async (file: string | undefined) => {
      let raw: unknown;
      try {
        raw = await readPlanSource(file);
      } catch (err) {
        handleError(err);
      }
      const result = validatePlan(raw);
      if (!result.ok) {
        if (isJsonMode()) {
          printJson({ valid: false, issues: result.issues });
        } else {
          console.error('✗ plan invalid:');
          for (const i of result.issues) {
            console.error(`  ${i.path}: ${i.message}`);
          }
        }
        process.exit(2);
      }
      if (isJsonMode()) {
        printJson({ valid: true, steps: result.plan.steps.length });
      } else {
        console.log(`✓ plan valid (${result.plan.steps.length} step${result.plan.steps.length === 1 ? '' : 's'})`);
      }
    });

  plan
    .command('run')
    .description('Validate + execute a plan. Respects --dry-run; destructive steps require --yes')
    .argument('[file]', 'Path to plan.json, or "-" / omit to read stdin')
    .option('--yes', 'Authorize destructive commands (e.g. Smart Lock unlock, Garage open)')
    .option('--continue-on-error', 'Keep running after a failed step (default: stop at first error)')
    .action(
      async (
        file: string | undefined,
        options: { yes?: boolean; continueOnError?: boolean },
      ) => {
        let raw: unknown;
        try {
          raw = await readPlanSource(file);
        } catch (err) {
          handleError(err);
        }
        const v = validatePlan(raw);
        if (!v.ok) {
          if (isJsonMode()) {
            printJson({ ran: false, issues: v.issues });
          } else {
            console.error('✗ plan invalid, refusing to run:');
            for (const i of v.issues) console.error(`  ${i.path}: ${i.message}`);
          }
          process.exit(2);
        }

        let out: PlanRunResult;
        try {
          out = await runPlan(v.plan, {
            yes: options.yes,
            continueOnError: options.continueOnError,
            onStep: isJsonMode() ? undefined : (line) => console.log(line),
          });
        } catch (err) {
          handleError(err);
        }

        if (isJsonMode()) {
          printJson({ ran: true, ...out! });
        } else {
          const { ok, error, skipped, total } = out!.summary;
          console.log(`\nsummary: ok=${ok} error=${error} skipped=${skipped} total=${total}`);
        }
        if (out!.summary.error > 0) process.exit(1);
      },
    );
}
