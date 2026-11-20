import { Command } from 'commander';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AxiosInstance } from 'axios';
import { printJson, printKeyValue, isJsonMode, handleError, exitWithError, UsageError } from '../utils/output.js';
import { ApiError, createClient } from '../api/client.js';
import { executeCommand } from '../lib/devices.js';
import { executeScene } from '../lib/scenes.js';
import { getCachedDevice } from '../devices/cache.js';
import { inferCommandFromIntent } from '../lib/command-keywords.js';
import {
  savePlanRecord,
  loadPlanRecord,
  updatePlanRecord,
  listPlanRecords,
  PLANS_DIR,
  isCurrentPlanCredentialScope,
  PlanAccount,
  PlanResourceError,
  PlanStepJournal,
  withPlanWriteClaim,
  type PlanRecord,
} from '../lib/plan-store.js';
import { allowsDirectDestructiveExecution, destructiveExecutionHint } from '../lib/destructive-mode.js';
import { isDryRun } from '../utils/flags.js';
import { preparePlanTargets, type PreparedPlanCommand } from '../lib/plan-preflight.js';
import { maskValue } from '../utils/redact.js';

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


function loadBoundPlan(planId: string): PlanRecord {
  const record = loadPlanRecord(planId);
  if (!record) throw new PlanResourceError(`Plan ${planId} not found in ${PLANS_DIR}`, 'usage');
  const context = { planId, requiredWorkflow: 're-save-review-approve' };
  if (!record.credentialScope) {
    throw new PlanResourceError(`Plan ${planId} has no credential binding.`, 'guard',
      'Review the legacy plan and save it again under the intended credential selector before approval.', context);
  }
  if (!isCurrentPlanCredentialScope(record.credentialScope)) {
    throw new PlanResourceError(`Plan ${planId} belongs to a different credential profile or config selector.`, 'guard',
      'Use the selector that saved this plan, or save and approve a new plan under the active selector.', context);
  }
  return record;
}

function reportPlanError(error: unknown): never {
  if (error instanceof PlanResourceError) {
    exitWithError({ code: 2, kind: error.kind, message: error.message, hint: error.hint, context: error.context });
  }
  return handleError(error);
}

function reviewScope(scope: PlanRecord['credentialScope']): string {
  if (!scope) return 'unbound legacy plan (save again before approval)';
  const value = scope.kind === 'config' ? scope.path : scope.profile;
  const fingerprint = createHash('sha256').update(value).digest('hex').slice(0, 10);
  return `${scope.kind} ${maskValue(scope.kind === 'config' ? path.basename(value) : value)} (#${fingerprint})`;
}

function reviewParameter(key: string, value: unknown): unknown {
  if (/pass(word|code)|credential|secret|token|authorization|cookie|api.?key|private.?key|^pin(?:code)?$|^(?:key|code|sign|nonce)$|url|uri|base64|^image(?:data|bytes)?$/i.test(key)) {
    return '[redacted]';
  }
  if (typeof value !== 'string') return value;
  if (/^\s*[[{]/.test(value)) {
    // Legacy records may contain JSON-encoded wire parameters.
    try { return JSON.parse(value); } catch { return '[redacted]'; }
  }
  if (/(?:[a-z]+:\/\/|data:image\/|bearer\s+\S)/i.test(value) || /^[A-Za-z0-9+/=_-]{64,}$/.test(value)) return '[redacted]';
  return value;
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

const planSchemaValidator = new Ajv2020({ allErrors: true, strict: false }).compile(PLAN_JSON_SCHEMA);

function formatPlanErrorPath(instancePath: string, keyword: string, params: unknown): string {
  const base = instancePath
    ? instancePath.slice(1).split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((path, segment) => {
      const index = Number.parseInt(segment, 10);
      return String(index) === segment ? `${path}[${segment}]` : path ? `${path}.${segment}` : segment;
    }, '')
    : '$';
  if (keyword === 'additionalProperties' && params && typeof params === 'object' && 'additionalProperty' in params) {
    const additionalProperty = params.additionalProperty;
    if (typeof additionalProperty === 'string') return base === '$' ? additionalProperty : `${base}.${additionalProperty}`;
  }
  if (keyword === 'required' && params && typeof params === 'object' && 'missingProperty' in params) {
    const missingProperty = params.missingProperty;
    if (typeof missingProperty === 'string') return base === '$' ? missingProperty : `${base}.${missingProperty}`;
  }
  return base;
}

export function validatePlan(raw: unknown): { ok: true; plan: Plan } | { ok: false; issues: PlanValidationIssue[] } {
  if (!planSchemaValidator(raw)) {
    return {
      ok: false,
      issues: (planSchemaValidator.errors ?? []).map((error: ErrorObject) => ({
        path: formatPlanErrorPath(error.instancePath, error.keyword, error.params),
        message: error.message ?? 'is invalid',
      })),
    };
  }
  const plan: Plan = raw as Plan;
  return { ok: true, plan };
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
  const command = inferCommandFromIntent(opts.intent);
  if (!command) {
    throw new UsageError(
      'Cannot safely infer a single explicit action. For a read, use switchbot devices status; otherwise specify one action (e.g. "turn off") and its target device IDs.',
    );
  }
  const steps: PlanStep[] = opts.devices.map((d): PlanCommandStep => ({
    type: 'command',
    deviceId: d.id,
    command,
  }));
  return { plan: { version: '1.0', description: opts.intent, steps }, warnings: [] };
}

async function readPlanSource(file: string | undefined): Promise<unknown> {
  let text: string;
  if (file === undefined || file === '-') {
    text = await readStdin();
  } else {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      throw new UsageError(`Unable to read plan file: ${file}`);
    }
    if (!stat.isFile()) {
      throw new UsageError(`Plan input must be a regular file: ${file}`);
    }
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      throw new UsageError(`Unable to read plan file: ${file}`);
    }
  }
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

async function promptApproval(stepIdx: number, command: string, deviceId: string, parameter: unknown): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<boolean>((resolve) => {
    rl.question(`  Approve step ${stepIdx} — ${command} on ${deviceId} parameter=${JSON.stringify(parameter ?? 'default', reviewParameter)}? [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

interface PlanRunResult {
  plan: Plan;
  results: Array<
    | { step: number; type: 'command'; deviceId: string; command: string; status: 'ok' | 'error' | 'skipped' | 'dry-run'; result?: unknown; error?: string; decision?: 'approved' | 'rejected' }
    | { step: number; type: 'scene'; sceneId: string; status: 'ok' | 'error' | 'skipped' | 'dry-run'; error?: string }
    | { step: number; type: 'wait'; ms: number; status: 'ok' | 'skipped' | 'dry-run' }
  >;
  summary: { total: number; ok: number; error: number; skipped: number; dryRun: number };
}

// Explicit provider refusals only. A timeout, network error, internal error or
// undocumented status cannot prove that a non-idempotent action did not happen.
function definitelyRejected(error: unknown): boolean {
  return error instanceof ApiError && [151, 152, 160, 161, 171, 401, 403, 429].includes(error.code);
}

/** Shared plan-execution core used by both `plan run` and `plan execute`. */
async function executePlanSteps(
  plan: Plan,
  planId: string,
  options: { yes?: boolean; requireApproval?: boolean; continueOnError?: boolean },
  preparedCommands: readonly PreparedPlanCommand[],
  journal?: PlanStepJournal,
  client?: AxiosInstance,
): Promise<PlanRunResult> {
  const out: PlanRunResult = {
    plan,
    results: [],
    summary: { total: plan.steps.length, ok: 0, error: 0, skipped: 0, dryRun: 0 },
  };
  const commandsByStep = new Map(preparedCommands.map((command) => [command.stepIndex, command]));
  const dispatch = <T>(step: number, operation: () => Promise<T>): Promise<T> =>
    journal ? journal.dispatch(step, operation, definitelyRejected) : operation();
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const idx = i + 1;
    if (step.type === 'wait') {
      if (isDryRun()) {
        out.results.push({ step: idx, type: 'wait', ms: step.ms, status: 'dry-run' });
        out.summary.dryRun++;
        if (!isJsonMode()) console.error(`  ${idx}. ◦ dry-run wait ${step.ms}ms`);
        continue;
      }
      await dispatch(idx, () => new Promise<void>((resolve) => setTimeout(resolve, step.ms)));
      out.results.push({ step: idx, type: 'wait', ms: step.ms, status: 'ok' });
      out.summary.ok++;
      if (!isJsonMode()) console.log(`  ${idx}. wait ${step.ms}ms`);
      continue;
    }
    if (step.type === 'scene') {
      if (isDryRun()) {
        out.results.push({ step: idx, type: 'scene', sceneId: step.sceneId, status: 'dry-run' });
        out.summary.dryRun++;
        if (!isJsonMode()) console.error(`  ${idx}. ◦ dry-run scene ${step.sceneId}`);
        continue;
      }
      try {
        await dispatch(idx, () => executeScene(step.sceneId, client));
        out.results.push({ step: idx, type: 'scene', sceneId: step.sceneId, status: 'ok' });
        out.summary.ok++;
        if (!isJsonMode()) console.log(`  ${idx}. ✓ scene ${step.sceneId}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out.results.push({ step: idx, type: 'scene', sceneId: step.sceneId, status: 'error', error: msg });
        out.summary.error++;
        if (!isJsonMode()) console.log(`  ${idx}. ✗ scene ${step.sceneId}: ${msg}`);
        if (!options.continueOnError || journal?.uncertain) break;
      }
      continue;
    }
    const prepared = commandsByStep.get(i);
    if (!prepared) throw new Error(`Missing preflight result for command step ${idx}`);
    const resolvedDeviceId = prepared.deviceId;
    const commandType = prepared.commandType;
    const destructive = prepared.destructive;
    let approvalDecision: 'approved' | undefined;
    if (destructive && !options.yes) {
      if (options.requireApproval) {
        const approved = await promptApproval(idx, prepared.command, resolvedDeviceId, prepared.parameter);
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
    if (isDryRun()) {
      out.results.push({ step: idx, type: 'command', deviceId: resolvedDeviceId, command: prepared.command, status: 'dry-run' });
      out.summary.dryRun++;
      if (!isJsonMode()) console.error(`  ${idx}. ◦ dry-run ${prepared.command} on ${resolvedDeviceId}`);
      continue;
    }
    try {
      const result = await dispatch(idx, () => executeCommand(resolvedDeviceId, prepared.command, prepared.parameter, commandType, client, { planId }));
      out.results.push({ step: idx, type: 'command', deviceId: resolvedDeviceId, command: prepared.command, status: 'ok', result, ...(approvalDecision ? { decision: approvalDecision } : {}) });
      out.summary.ok++;
      if (!isJsonMode()) {
        console.log(`  ${idx}. ✓ ${prepared.command} on ${resolvedDeviceId}`);
        if (result && typeof result === 'object' && Object.keys(result).length > 0) {
          printKeyValue(result as Record<string, unknown>);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'DryRunSignal') {
        out.results.push({ step: idx, type: 'command', deviceId: resolvedDeviceId, command: step.command, status: 'dry-run' });
        out.summary.dryRun++;
        if (!isJsonMode()) console.error(`  ${idx}. ◦ dry-run ${step.command} on ${resolvedDeviceId}`);
        continue;
      }
      const msg = err instanceof Error ? err.message : String(err);
      out.results.push({ step: idx, type: 'command', deviceId: resolvedDeviceId, command: step.command, status: 'error', error: msg });
      out.summary.error++;
      if (!isJsonMode()) console.log(`  ${idx}. ✗ ${step.command} on ${resolvedDeviceId}: ${msg}`);
      if (!options.continueOnError || journal?.uncertain) break;
    }
  }
  return out;
}

async function executeSavedPlan(planId: string, options: { continueOnError?: boolean; requireApproval?: boolean }) {
  const record = loadBoundPlan(planId);
  if (record.status !== 'approved') {
    throw new PlanResourceError(
      `Plan ${planId.slice(0, 8)}… cannot be executed: status is "${record.status}", expected "approved".`, 'guard',
      record.status === 'pending' || record.status === 'failed' ? `Run: switchbot plan approve ${planId}` : undefined,
      { planId, status: record.status });
  }
  const account = PlanAccount.forRecord(record, isDryRun() ? 'preview' : 'execute');
  const journal = isDryRun() ? undefined : new PlanStepJournal(record, 'execute');
  const preparation = await preparePlanTargets(record.plan.steps);
  if (!preparation.ok) {
    throw new PlanResourceError(preparation.message, preparation.safetyCritical ? 'guard' : 'usage', preparation.hint, {
      planId, step: preparation.stepIndex + 1, deviceId: preparation.deviceId, validationKind: preparation.kind,
    });
  }
  const client = journal && record.plan.steps.some(step => step.type !== 'wait')
    ? createClient(account.assertSigningCredentials) : undefined;
  const out = await executePlanSteps(record.plan, planId, { ...options, yes: isDryRun() || !options.requireApproval }, preparation.commands, journal, client);
  const { error, skipped } = out.summary;
  const succeeded = error === 0 && skipped === 0;
  const failureReason = succeeded ? undefined : [
    error > 0 ? `${error} error${error > 1 ? 's' : ''}` : null,
    skipped > 0 ? `${skipped} skipped` : null,
    journal?.uncertain ? 'step outcome unknown; inspect the target before preparing a new plan' : null,
  ].filter(Boolean).join(', ');
  if (journal) {
    updatePlanRecord(planId, succeeded
      ? { status: 'executed', executedAt: new Date().toISOString() }
      : { status: 'failed', failedAt: new Date().toISOString(), failureReason });
  }
  return { out, succeeded, failureReason };
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
    .option(
      '--devices <id>',
      'Alias for --device (repeatable)',
      (v: string, prev: string[]) => [...prev, v],
      [] as string[],
    )
    .option('--out <file>', 'Write plan JSON to file instead of stdout')
    .action((opts: { intent: string; device: string[]; devices: string[]; out?: string }) => {
      // Preserve argv order across --device / --devices: Commander stores each spelling in its
      // own array, so [...device, ...devices] would reorder mixed input like
      // "--device A --devices B --device C" → A, C, B.  Scan process.argv instead.
      // (command.parseOptions() returns tokens but does not split across option-name variants,
      // so it cannot restore cross-variant insertion order either.)
      const allDevices: string[] = [];
      const raw = process.argv;
      for (let i = 0; i < raw.length; i++) {
        const eqMatch = raw[i].match(/^--devices?=(.+)/);
        if (eqMatch) { allDevices.push(eqMatch[1]); continue; }
        if ((raw[i] === '--device' || raw[i] === '--devices') && i + 1 < raw.length) {
          allDevices.push(raw[i + 1]);
        }
      }
      if (allDevices.length === 0) allDevices.push(...opts.device, ...opts.devices);
      if (allDevices.length === 0) {
        console.error('error: at least one --device is required');
        process.exit(2);
      }
      try {
        const devices = allDevices.map((ref) => {
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
    .option('--yes', 'Confirm destructive steps in an explicit dev profile. Otherwise use plan save → review → approve → execute.')
    .option('--require-approval', 'Prompt for confirmation before each destructive step (TTY only; mutually exclusive with --json)')
    .option('--continue-on-error', 'Keep running after a failed step (default: stop at first error)')
    .option('--plan <json>', 'Inline plan JSON (alternative to file argument or stdin)')
    .action(
      async (
        file: string | undefined,
        options: { yes?: boolean; requireApproval?: boolean; continueOnError?: boolean; plan?: string },
      ) => {
        if (options.requireApproval && isJsonMode()) {
          console.error('error: --require-approval cannot be used with --json (no TTY available for prompts)');
          process.exit(1);
        }
        if (options.plan !== undefined && file !== undefined) {
          console.error('error: --plan and a file argument are mutually exclusive.');
          process.exit(2);
        }
        let raw: unknown;
        try {
          if (options.plan !== undefined) {
            try {
              raw = JSON.parse(options.plan);
            } catch (err) {
              throw new UsageError(`--plan is not valid JSON: ${(err as Error).message}`);
            }
          } else {
            raw = await readPlanSource(file);
          }
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
        let preparation;
        try {
          preparation = await preparePlanTargets(v.plan.steps);
        } catch (err) {
          handleError(err);
          return;
        }
        if (!preparation.ok) {
          exitWithError({
            code: 2,
            kind: preparation.safetyCritical ? 'guard' : 'usage',
            message: preparation.message,
            hint: preparation.hint,
            context: {
              planId,
              step: preparation.stepIndex + 1,
              deviceId: preparation.deviceId,
              validationKind: preparation.kind,
              ...(preparation.safetyCritical ? { requiredWorkflow: 'plan-approval' } : {}),
            },
          });
        }
        const destructiveSteps = preparation.commands.filter((step) => step.destructive);
        if (destructiveSteps.length > 0 && !isDryRun() && !options.yes && !options.requireApproval) {
          exitWithError({
            code: 2,
            kind: 'guard',
            message: `Destructive plan execution requires the reviewed plan workflow.`,
            hint: 'Save and approve the plan, then use plan execute.',
            context: {
              planId,
              destructiveSteps: destructiveSteps.map((step) => ({
                step: step.stepIndex + 1,
                deviceId: step.deviceId,
                deviceType: step.deviceType,
                command: step.command,
                commandType: step.commandType,
              })),
              requiredWorkflow: 'plan-approval',
            },
          });
        }
        if (options.yes && destructiveSteps.length > 0 && !allowsDirectDestructiveExecution()) {
          exitWithError({
            code: 2,
            kind: 'guard',
            message: `Direct destructive execution is disabled for plan run (${destructiveSteps.length} destructive step${destructiveSteps.length === 1 ? '' : 's'}).`,
            hint: destructiveExecutionHint(),
            context: {
              planId,
              destructiveSteps: destructiveSteps.map((step) => ({
                step: step.stepIndex + 1,
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
          out = await executePlanSteps(v.plan, planId, { ...options, yes: options.yes || isDryRun() }, preparation.commands);
          if (isJsonMode()) {
            printJson({ ran: !isDryRun(), planId, ...out });
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
      const account = new PlanAccount();
      let preparation;
      try {
        preparation = await preparePlanTargets(v.plan.steps);
      } catch (err) {
        handleError(err);
        return;
      }
      if (!preparation.ok) {
        exitWithError({
          code: 2,
          kind: 'usage',
          message: preparation.message,
          hint: preparation.hint,
          context: {
            step: preparation.stepIndex + 1,
            deviceId: preparation.deviceId,
            validationKind: preparation.kind,
          },
        });
      }
      const preparedByStep = new Map(preparation.commands.map((command) => [command.stepIndex, command]));
      const boundPlan: Plan = {
        ...v.plan,
        steps: v.plan.steps.map((step, stepIndex) => {
          if (step.type !== 'command') return step;
          const prepared = preparedByStep.get(stepIndex);
          if (!prepared) throw new Error(`Missing preflight result for command step ${stepIndex + 1}`);
          return {
            ...step,
            deviceId: prepared.deviceId,
            deviceName: undefined,
            command: prepared.command,
            parameter: prepared.parameter,
            commandType: prepared.commandType,
          };
        }),
      };
      let record: PlanRecord;
      try { record = savePlanRecord(boundPlan, account); } catch (err) { return reportPlanError(err); }
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
      console.log(`scope:      ${reviewScope(record.credentialScope)}`);
      console.log(`createdAt:  ${record.createdAt}`);
      if (record.approvedAt) console.log(`approvedAt: ${record.approvedAt}`);
      if (record.executedAt) console.log(`executedAt: ${record.executedAt}`);
      if (record.plan.description) console.log(`description: ${record.plan.description}`);
      console.log(`steps (${record.plan.steps.length}):`);
      for (let i = 0; i < record.plan.steps.length; i++) {
        const step = record.plan.steps[i];
        if (step.type === 'command') {
          const id = step.deviceId ?? step.deviceName ?? '?';
          const preview = JSON.stringify(step.parameter ?? 'default', reviewParameter);
          console.log(`  ${i + 1}. ${step.commandType ?? 'command'}  ${step.command} on ${id}  parameter=${preview}${step.note ? `  # ${step.note}` : ''}`);
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
    .action(async (planId: string) => {
      const updated = await withPlanWriteClaim(planId, () => {
        const record = loadBoundPlan(planId);
        if (record.status === 'executed') throw new PlanResourceError(`Plan ${planId} has already been executed.`);
        if (record.status === 'rejected') throw new PlanResourceError(`Plan ${planId} was rejected. Save a new plan to start fresh.`);
        // Seal the reviewed content under the same claim as the approval write.
        new PlanStepJournal(record, 'approve');
        PlanAccount.forRecord(record, 'approve');
        return updatePlanRecord(planId, { status: 'approved', approvedAt: new Date().toISOString() });
      }).catch(reportPlanError);
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
      const run = () => executeSavedPlan(planId, options);
      const { out, succeeded, failureReason } = await (isDryRun() ? run() : withPlanWriteClaim(planId, run)).catch(reportPlanError);
      if (isJsonMode()) {
        printJson({ ran: !isDryRun(), planId, succeeded, ...out });
      } else {
        const { ok, error, skipped, total } = out.summary;
        console.log(`\nsummary: ok=${ok} error=${error} skipped=${skipped} total=${total}`);
        if (!succeeded) console.error(`Plan marked as failed (${failureReason}).`);
      }
      if (!succeeded) process.exit(1);
    });
}
