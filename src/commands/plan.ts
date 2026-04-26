import { Command } from 'commander';
import fs from 'node:fs';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { printJson, isJsonMode, handleError, exitWithError, UsageError } from '../utils/output.js';
import { executeCommand, isDestructiveCommand } from '../lib/devices.js';
import { executeScene } from '../lib/scenes.js';
import { getCachedDevice } from '../devices/cache.js';
import { resolveDeviceId } from '../utils/name-resolver.js';
import { containsCjk, inferCommandFromIntent } from '../lib/command-keywords.js';
import {
  savePlanRecord,
  loadPlanRecord,
  updatePlanRecord,
  listPlanRecords,
  PLANS_DIR,
} from '../lib/plan-store.js';
import { allowsDirectDestructiveExecution, destructiveExecutionHint } from '../lib/destructive-mode.js';

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

function findDestructivePlanSteps(plan: Plan): Array<{ index: number; deviceId: string; command: string; commandType: 'command' | 'customize'; deviceType: string | null }> {
  const destructive: Array<{ index: number; deviceId: string; command: string; commandType: 'command' | 'customize'; deviceType: string | null }> = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (step.type !== 'command') continue;
    const resolvedDeviceId = resolveDeviceId(step.deviceId, step.deviceName);
    const deviceType = getCachedDevice(resolvedDeviceId)?.type;
    const commandType = step.commandType ?? 'command';
    if (isDestructiveCommand(deviceType, step.command, commandType)) {
      destructive.push({ index: i + 1, deviceId: resolvedDeviceId, command: step.command, commandType, deviceType: deviceType ?? null });
    }
  }
  return destructive;
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

// ---------------------------------------------------------------------------
// Plan suggestion (heuristic, no LLM)
// ---------------------------------------------------------------------------

export interface SuggestOptions {
  intent: string;
  devices: Array<{ id: string; name?: string; type?: string }>;
}

export interface SuggestResult {
  plan: Plan;
  warnings: string[];
}

export function suggestPlan(opts: SuggestOptions): SuggestResult {
  const warnings: string[] = [];
  let command = inferCommandFromIntent(opts.intent) ?? '';
  if (!command) {
    if (containsCjk(opts.intent)) {
      throw new UsageError(
        `Intent "${opts.intent}" contains non-English command text that this heuristic cannot safely infer. Use explicit English command words (turnOn/turnOff/open/close/lock/unlock/press/pause) or author the plan manually.`,
      );
    }
    command = 'turnOn';
    warnings.push(
      `Could not infer command from intent "${opts.intent}" — defaulted to "turnOn". Edit the generated plan to set the correct command.`,
    );
  }
  const steps: PlanStep[] = opts.devices.map((d): PlanCommandStep => ({
    type: 'command',
    deviceId: d.id,
    command,
  }));
  return { plan: { version: '1.0', description: opts.intent, steps }, warnings };
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

async function promptApproval(stepIdx: number, command: string, deviceId: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<boolean>((resolve) => {
    rl.question(`  Approve step ${stepIdx} — ${command} on ${deviceId}? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

interface PlanRunResult {
  plan: Plan;
  results: Array<
    | { step: number; type: 'command'; deviceId: string; command: string; status: 'ok' | 'error' | 'skipped' | 'dry-run'; error?: string; decision?: 'approved' | 'rejected' }
    | { step: number; type: 'scene'; sceneId: string; status: 'ok' | 'error' | 'skipped'; error?: string }
    | { step: number; type: 'wait'; ms: number; status: 'ok' | 'skipped' }
  >;
  summary: { total: number; ok: number; error: number; skipped: number; dryRun: number };
}

/** Shared plan-execution core used by both `plan run` and `plan execute`. */
async function executePlanSteps(
  plan: Plan,
  planId: string,
  options: { yes?: boolean; requireApproval?: boolean; continueOnError?: boolean },
): Promise<PlanRunResult> {
  const out: PlanRunResult = {
    plan,
    results: [],
    summary: { total: plan.steps.length, ok: 0, error: 0, skipped: 0, dryRun: 0 },
  };
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const idx = i + 1;
    if (step.type === 'wait') {
      await new Promise((r) => setTimeout(r, step.ms));
      out.results.push({ step: idx, type: 'wait', ms: step.ms, status: 'ok' });
      out.summary.ok++;
      if (!isJsonMode()) console.log(`  ${idx}. wait ${step.ms}ms`);
      continue;
    }
    if (step.type === 'scene') {
      try {
        await executeScene(step.sceneId);
        out.results.push({ step: idx, type: 'scene', sceneId: step.sceneId, status: 'ok' });
        out.summary.ok++;
        if (!isJsonMode()) console.log(`  ${idx}. ✓ scene ${step.sceneId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out.results.push({ step: idx, type: 'scene', sceneId: step.sceneId, status: 'error', error: msg });
        out.summary.error++;
        if (!isJsonMode()) console.log(`  ${idx}. ✗ scene ${step.sceneId}: ${msg}`);
        if (!options.continueOnError) break;
      }
      continue;
    }
    const resolvedDeviceId = resolveDeviceId(step.deviceId, step.deviceName);
    const deviceType = getCachedDevice(resolvedDeviceId)?.type;
    const commandType = step.commandType ?? 'command';
    const destructive = isDestructiveCommand(deviceType, step.command, commandType);
    let approvalDecision: 'approved' | undefined;
    if (destructive && !options.yes) {
      if (options.requireApproval) {
        const approved = await promptApproval(idx, step.command, resolvedDeviceId);
        if (approved) {
          approvalDecision = 'approved';
        } else {
          out.results.push({ step: idx, type: 'command', deviceId: resolvedDeviceId, command: step.command, status: 'skipped', error: 'destructive — rejected at prompt', decision: 'rejected' });
          out.summary.skipped++;
          if (!isJsonMode()) console.log(`  ${idx}. ✗ skipped ${step.command} on ${resolvedDeviceId} (rejected)`);
          if (!options.continueOnError) break;
          continue;
        }
      } else {
        out.results.push({ step: idx, type: 'command', deviceId: resolvedDeviceId, command: step.command, status: 'skipped', error: 'destructive — rerun with --yes' });
        out.summary.skipped++;
        if (!isJsonMode()) console.log(`  ${idx}. ⚠ skipped ${step.command} on ${resolvedDeviceId} (destructive — pass --yes)`);
        if (!options.continueOnError) break;
        continue;
      }
    }
    try {
      await executeCommand(resolvedDeviceId, step.command, step.parameter, commandType, undefined, { planId });
      out.results.push({ step: idx, type: 'command', deviceId: resolvedDeviceId, command: step.command, status: 'ok', ...(approvalDecision ? { decision: approvalDecision } : {}) });
      out.summary.ok++;
      if (!isJsonMode()) console.log(`  ${idx}. ✓ ${step.command} on ${resolvedDeviceId}`);
    } catch (err) {
      if (err instanceof Error && err.name === 'DryRunSignal') {
        out.results.push({ step: idx, type: 'command', deviceId: resolvedDeviceId, command: step.command, status: 'dry-run' });
        out.summary.dryRun++;
        if (!isJsonMode()) console.log(`  ${idx}. ◦ dry-run ${step.command} on ${resolvedDeviceId}`);
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      out.results.push({ step: idx, type: 'command', deviceId: resolvedDeviceId, command: step.command, status: 'error', error: msg });
      out.summary.error++;
      if (!isJsonMode()) console.log(`  ${idx}. ✗ ${step.command} on ${resolvedDeviceId}: ${msg}`);
      if (!options.continueOnError) break;
    }
  }
  return out;
}

export function registerPlanCommand(program: Command): void {
  const plan = program
    .command('plan')
    .description('Author, validate, and run SwitchBot batch plans (JSON schema for AI agents)')
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
  $ switchbot plan save my-plan.json              # store a reviewed plan
  $ switchbot plan review <planId>
  $ switchbot plan approve <planId>
  $ switchbot plan execute <planId>
  $ cat plan.json | switchbot plan run -          # or stream via stdin
`);

  plan
    .command('schema')
    .description('Print the JSON Schema for the plan format')
    .action(() => {
      printJson({
        ...PLAN_JSON_SCHEMA,
        agentNotes: {
          deviceNameStrategy:
            "Plan step `deviceName` fields are resolved with the `require-unique` strategy (same default as `devices command`). Plans that expect a specific device should pin `deviceId` instead.",
        },
      });
    });

  plan
    .command('validate')
    .description('Validate a plan file (or stdin) against the schema (structural only; does not verify device or scene existence)')
    .argument('[file]', 'Path to plan.json, or "-" / omit to read stdin')
    .addHelpText('after', `
To check semantic validity (e.g., that deviceIds and sceneIds actually exist),
use 'plan run --dry-run' which exercises name resolution and device lookup
against the live API without executing any mutations.
`)
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
        const out: Record<string, unknown> = { valid: true, steps: result.plan.steps.length };
        if (result.plan.steps.length === 0) out.warning = 'plan has no steps — nothing will execute';
        printJson(out);
      } else {
        if (result.plan.steps.length === 0) {
          console.log('✓ plan valid — but 0 steps: nothing will execute');
        } else {
          console.log(`✓ plan valid (${result.plan.steps.length} step${result.plan.steps.length === 1 ? '' : 's'})`);
        }
      }
    });

  plan
    .command('suggest')
    .description('Generate a candidate Plan JSON from intent + devices (heuristic, no LLM)')
    .requiredOption('--intent <text>', 'Natural language description (e.g. "turn off all lights")')
    .option(
      '--device <id>',
      'Device ID to include (repeatable)',
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option('--out <file>', 'Write plan JSON to file instead of stdout')
    .action((opts: { intent: string; device: string[]; out?: string }) => {
      try {
        if (opts.device.length === 0) {
          console.error('error: at least one --device is required');
          process.exit(1);
        }
        const devices = opts.device.map((ref) => {
          const cached = getCachedDevice(ref);
          return { id: ref, name: cached?.name, type: cached?.type };
        });
        const { plan: suggested, warnings } = suggestPlan({ intent: opts.intent, devices });
        for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
        const json = JSON.stringify(suggested, null, 2);
        if (opts.out) {
          fs.writeFileSync(opts.out, json + '\n', 'utf8');
          if (!isJsonMode()) console.log(`✓ plan written to ${opts.out}`);
        } else if (isJsonMode()) {
          printJson({ plan: suggested, warnings });
        } else {
          console.log(json);
        }
      } catch (err) {
        handleError(err);
      }
    });

  plan
    .command('run')
    .description('Validate + preview/execute a plan. Respects --dry-run; destructive steps require the reviewed plan flow by default')
    .argument('[file]', 'Path to plan.json, or "-" / omit to read stdin')
    .option('--yes', 'Authorize destructive commands (e.g. Smart Lock unlock, Garage open)')
    .option('--require-approval', 'Prompt for confirmation before each destructive step (TTY only; mutually exclusive with --json)')
    .option('--continue-on-error', 'Keep running after a failed step (default: stop at first error)')
    .action(
      async (
        file: string | undefined,
        options: { yes?: boolean; requireApproval?: boolean; continueOnError?: boolean },
      ) => {
        if (options.requireApproval && isJsonMode()) {
          console.error('error: --require-approval cannot be used with --json (no TTY available for prompts)');
          process.exit(1);
        }
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
        const planId = randomUUID();
        const destructiveSteps = findDestructivePlanSteps(v.plan);
        if (options.yes && destructiveSteps.length > 0 && !allowsDirectDestructiveExecution()) {
          exitWithError({
            code: 2,
            kind: 'guard',
            message: `Direct destructive execution is disabled for plan run (${destructiveSteps.length} destructive step${destructiveSteps.length === 1 ? '' : 's'}).`,
            hint: destructiveExecutionHint(),
            context: {
              planId,
              destructiveSteps: destructiveSteps.map((step) => ({
                step: step.index,
                deviceId: step.deviceId,
                deviceType: step.deviceType,
                command: step.command,
                commandType: step.commandType,
              })),
              requiredWorkflow: 'plan-approval',
            },
          });
        }
        let out: PlanRunResult;
        try {
          out = await executePlanSteps(v.plan, planId, options);
          if (isJsonMode()) {
            printJson({ ran: true, planId, ...out });
          } else {
            const { ok, error, skipped, total } = out.summary;
            console.log(`\nsummary: ok=${ok} error=${error} skipped=${skipped} total=${total}`);
          }
        } catch (err) {
          handleError(err);
          return;
        }
        if (out.summary.error > 0) process.exit(1);
      },
    );

  // ---- Plan resource-model subcommands (P0-3) --------------------------------

  plan
    .command('save')
    .description('Save a plan JSON to ~/.switchbot/plans/ with status=pending (waiting for approval).')
    .argument('[file]', 'Path to plan.json, or "-" / omit to read stdin')
    .action(async (file: string | undefined) => {
      let raw: unknown;
      try {
        raw = await readPlanSource(file);
      } catch (err) {
        handleError(err);
        return;
      }
      const v = validatePlan(raw);
      if (!v.ok) {
        exitWithError({
          code: 2, kind: 'usage',
          message: `Plan is invalid (${v.issues.length} issue${v.issues.length > 1 ? 's' : ''})`,
          context: { issues: v.issues },
        });
      }
      const record = savePlanRecord(v.plan);
      if (isJsonMode()) {
        printJson({ saved: true, planId: record.planId, status: record.status, createdAt: record.createdAt, plansDir: PLANS_DIR });
      } else {
        console.log(`✓ Plan saved — planId: ${record.planId}`);
        console.log(`  Status:  ${record.status}`);
        console.log(`  Path:    ${PLANS_DIR}/${record.planId}.json`);
        console.log(`  Next:    switchbot plan review ${record.planId}`);
        console.log(`           switchbot plan approve ${record.planId}`);
      }
    });

  plan
    .command('list')
    .description('List saved plans in ~/.switchbot/plans/ with their approval status.')
    .action(() => {
      const records = listPlanRecords();
      if (isJsonMode()) {
        printJson({ plans: records.map((r) => ({ planId: r.planId, status: r.status, createdAt: r.createdAt, approvedAt: r.approvedAt ?? null, executedAt: r.executedAt ?? null, description: r.plan.description ?? null })) });
        return;
      }
      if (records.length === 0) {
        console.log('No saved plans. Use: switchbot plan save <file>');
        return;
      }
      for (const r of records) {
        const parts = [`${r.planId.slice(0, 8)}…`, r.status, r.createdAt.slice(0, 16)];
        if (r.plan.description) parts.push(`"${r.plan.description}"`);
        console.log(parts.join('  '));
      }
    });

  plan
    .command('review')
    .description('Show the details of a saved plan (steps, status, approval history).')
    .argument('<planId>', 'Plan UUID from "plan list"')
    .action((planId: string) => {
      const record = loadPlanRecord(planId);
      if (!record) {
        exitWithError({ code: 2, kind: 'usage', message: `Plan ${planId} not found in ${PLANS_DIR}` });
      }
      if (isJsonMode()) {
        printJson(record);
        return;
      }
      console.log(`planId:     ${record.planId}`);
      console.log(`status:     ${record.status}`);
      console.log(`createdAt:  ${record.createdAt}`);
      if (record.approvedAt) console.log(`approvedAt: ${record.approvedAt}`);
      if (record.executedAt) console.log(`executedAt: ${record.executedAt}`);
      if (record.plan.description) console.log(`description: ${record.plan.description}`);
      console.log(`steps (${record.plan.steps.length}):`);
      for (let i = 0; i < record.plan.steps.length; i++) {
        const step = record.plan.steps[i];
        if (step.type === 'command') {
          const id = step.deviceId ?? step.deviceName ?? '?';
          console.log(`  ${i + 1}. command  ${step.command} on ${id}${step.note ? `  # ${step.note}` : ''}`);
        } else if (step.type === 'scene') {
          console.log(`  ${i + 1}. scene    ${step.sceneId}${step.note ? `  # ${step.note}` : ''}`);
        } else {
          console.log(`  ${i + 1}. wait     ${step.ms}ms`);
        }
      }
    });

  plan
    .command('approve')
    .description('Approve a saved plan, allowing `plan execute` to run it.')
    .argument('<planId>', 'Plan UUID from "plan list"')
    .action((planId: string) => {
      const record = loadPlanRecord(planId);
      if (!record) {
        exitWithError({ code: 2, kind: 'usage', message: `Plan ${planId} not found in ${PLANS_DIR}` });
      }
      if (record.status === 'executed') {
        exitWithError({ code: 2, kind: 'guard', message: `Plan ${planId} has already been executed.` });
      }
      if (record.status === 'rejected') {
        exitWithError({ code: 2, kind: 'guard', message: `Plan ${planId} was rejected. Save a new plan to start fresh.` });
      }
      // 'failed' plans may be re-approved and retried — intentionally no block here.
      const updated = updatePlanRecord(planId, { status: 'approved', approvedAt: new Date().toISOString() });
      if (isJsonMode()) {
        printJson({ ok: true, planId: updated.planId, status: updated.status, approvedAt: updated.approvedAt });
      } else {
        console.log(`✓ Plan ${planId.slice(0, 8)}… approved.`);
        console.log(`  Next:  switchbot plan execute ${planId}`);
      }
    });

  plan
    .command('execute')
    .description('Execute a pre-approved plan. Only runs if status=approved; audit entries are tagged with planId.')
    .argument('<planId>', 'Plan UUID from "plan list" (must be in approved status)')
    .option('--yes', 'Deprecated no-op: approved plans already authorize destructive steps')
    .option('--require-approval', 'Prompt for each destructive step (TTY only)')
    .option('--continue-on-error', 'Keep running after a failed step')
    .action(async (planId: string, options: { yes?: boolean; requireApproval?: boolean; continueOnError?: boolean }) => {
      if (options.requireApproval && isJsonMode()) {
        exitWithError({ code: 1, kind: 'usage', message: '--require-approval cannot be used with --json' });
      }
      const record = loadPlanRecord(planId);
      if (!record) {
        exitWithError({ code: 2, kind: 'usage', message: `Plan ${planId} not found in ${PLANS_DIR}` });
      }
      if (record.status !== 'approved') {
        exitWithError({
          code: 2, kind: 'guard',
          message: `Plan ${planId.slice(0, 8)}… cannot be executed: status is "${record.status}", expected "approved".`,
          hint: record.status === 'pending' ? `Run: switchbot plan approve ${planId}` : record.status === 'failed' ? `Re-run: switchbot plan approve ${planId}` : undefined,
          context: { planId, status: record.status },
        });
      }
      let out: PlanRunResult;
      try {
        out = await executePlanSteps(record.plan, planId, { ...options, yes: true });
      } catch (err) {
        handleError(err);
        return;
      }
      const { ok, error, skipped } = out.summary;
      const succeeded = error === 0 && skipped === 0;
      const failureReason = succeeded ? undefined : [error > 0 ? `${error} error${error > 1 ? 's' : ''}` : null, skipped > 0 ? `${skipped} skipped` : null].filter(Boolean).join(', ');
      if (succeeded) {
        updatePlanRecord(planId, { status: 'executed', executedAt: new Date().toISOString() });
      } else {
        updatePlanRecord(planId, { status: 'failed', failedAt: new Date().toISOString(), failureReason });
      }
      if (isJsonMode()) {
        printJson({ ran: true, planId, succeeded, ...out });
      } else {
        console.log(`\nsummary: ok=${ok} error=${error} skipped=${skipped} total=${out.summary.total}`);
        if (!succeeded) console.error(`Plan marked as failed (${failureReason}). Re-run after fixing to retry.`);
      }
      if (!succeeded) process.exit(1);
    });
}
