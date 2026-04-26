import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import { isMap, isSeq, isScalar, type Node, type LineCounter, type Document } from 'yaml';
import { loadPolicyFile, type LoadedPolicy } from './load.js';
import {
  loadPolicySchema,
  CURRENT_POLICY_SCHEMA_VERSION,
  SUPPORTED_POLICY_SCHEMA_VERSIONS,
  isSupportedPolicySchemaVersion,
  type PolicySchemaVersion,
} from './schema.js';
import { getEffectiveCatalog } from '../devices/catalog.js';
import { parseRuleCommand } from '../rules/action.js';
import { destructiveVerbOf, DESTRUCTIVE_COMMANDS } from '../rules/destructive.js';

const require = createRequire(import.meta.url);
type AddFormatsFn = (ajv: Ajv2020Type) => Ajv2020Type;
const addFormats = require('ajv-formats') as AddFormatsFn;

type Ajv2020Type = InstanceType<typeof Ajv2020>;
type ValidateFn = ReturnType<Ajv2020Type['compile']>;

export interface PolicyValidationError {
  path: string;
  line?: number;
  col?: number;
  keyword: string;
  message: string;
  hint?: string;
  schemaPath: string;
}

export interface PolicyValidationResult {
  policyPath: string;
  schemaVersion: PolicySchemaVersion;
  validationScope: 'schema+offline-semantics';
  limitations: string[];
  valid: boolean;
  errors: PolicyValidationError[];
}

const POLICY_VALIDATION_LIMITATIONS = [
  'Does not resolve aliases against the live device inventory.',
  'Does not verify commands against the real target device, live capabilities, or current firmware.',
] as const;

const HEX_MAC_DEVICE_ID_RE = /^[A-Fa-f0-9]{12}(?:-[A-Za-z0-9]{2,16})?$/;
const HYPHENATED_DEVICE_ID_RE = /^[A-Za-z0-9]{2,32}(?:-[A-Za-z0-9]{2,32}){1,4}$/;

interface CompiledValidator {
  ajv: Ajv2020Type;
  validate: ValidateFn;
}

const validators = new Map<PolicySchemaVersion, CompiledValidator>();

function getValidator(version: PolicySchemaVersion): CompiledValidator {
  const cached = validators.get(version);
  if (cached) return cached;
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  const schema = loadPolicySchema(version);
  const validate = ajv.compile(schema);
  const compiled = { ajv, validate };
  validators.set(version, compiled);
  return compiled;
}

function instancePathToSegments(instancePath: string): string[] {
  if (!instancePath) return [];
  return instancePath
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getNodeAt(doc: Document.Parsed, segments: string[]): Node | null {
  let current: unknown = doc.contents;
  for (const seg of segments) {
    if (isMap(current)) {
      const pair = current.items.find((p) => {
        const k = p.key;
        if (isScalar(k)) return String(k.value) === seg;
        return false;
      });
      if (!pair) return null;
      current = pair.value;
    } else if (isSeq(current)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return null;
      current = current.items[idx];
    } else {
      return null;
    }
  }
  return (current as Node) ?? null;
}

function getKeyNodeAt(doc: Document.Parsed, parentSegments: string[], key: string): Node | null {
  const parent = parentSegments.length === 0 ? doc.contents : getNodeAt(doc, parentSegments);
  if (!parent || !isMap(parent)) return null;
  const pair = parent.items.find((p) => isScalar(p.key) && String((p.key as { value: unknown }).value) === key);
  return (pair?.key as Node | undefined) ?? null;
}

function locateInstancePath(
  doc: Document.Parsed,
  lineCounter: LineCounter,
  instancePath: string,
): { line?: number; col?: number } {
  const node = getNodeAt(doc, instancePathToSegments(instancePath));
  const range = (node as { range?: [number, number, number] } | null)?.range;
  if (!range) return {};
  const pos = lineCounter.linePos(range[0]);
  return { line: pos.line, col: pos.col };
}

function locateError(doc: Document.Parsed, lineCounter: LineCounter, err: ErrorObject): { line?: number; col?: number } {
  const segments = instancePathToSegments(err.instancePath);

  if (err.keyword === 'additionalProperties') {
    const bad = (err.params as { additionalProperty?: string }).additionalProperty;
    if (bad) {
      const keyNode = getKeyNodeAt(doc, segments, bad);
      const range = (keyNode as { range?: [number, number, number] } | null)?.range;
      if (range) {
        const pos = lineCounter.linePos(range[0]);
        return { line: pos.line, col: pos.col };
      }
    }
  }

  if (err.keyword === 'required' || err.keyword === 'dependentRequired') {
    const node = getNodeAt(doc, segments);
    const range = (node as { range?: [number, number, number] } | null)?.range;
    if (range) {
      const pos = lineCounter.linePos(range[0]);
      return { line: pos.line, col: pos.col };
    }
    return { line: 1, col: 1 };
  }

  const node = getNodeAt(doc, segments);
  const range = (node as { range?: [number, number, number] } | null)?.range;
  if (!range) return {};
  const pos = lineCounter.linePos(range[0]);
  return { line: pos.line, col: pos.col };
}

function humanMessage(err: ErrorObject): string {
  const path = err.instancePath || '(root)';
  switch (err.keyword) {
    case 'required':
      return `missing required property "${(err.params as { missingProperty: string }).missingProperty}"`;
    case 'additionalProperties':
      return `unknown property "${(err.params as { additionalProperty: string }).additionalProperty}"`;
    case 'dependentRequired': {
      const { property, missingProperty } = err.params as { property: string; missingProperty: string };
      const parent = path === '(root)' ? '' : `${path}: `;
      return `${parent}when "${property}" is set, "${missingProperty}" is also required`;
    }
    case 'pattern':
      return `${path} does not match pattern ${(err.params as { pattern: string }).pattern}`;
    case 'const':
      return `${path} must be exactly ${JSON.stringify((err.params as { allowedValue: unknown }).allowedValue)}`;
    case 'enum':
      return `${path} must be one of ${JSON.stringify((err.params as { allowedValues: unknown[] }).allowedValues)}`;
    case 'type':
      return `${path} must be ${(err.params as { type: string }).type}`;
    case 'not':
      return `${path} is not allowed here`;
    default:
      return `${path} ${err.message ?? 'is invalid'}`;
  }
}

function hintFor(err: ErrorObject): string | undefined {
  if (err.keyword === 'pattern' && err.instancePath.startsWith('/aliases/')) {
    return 'paste the deviceId from `switchbot devices list --format=tsv`, e.g. 01-202407090924-26354212';
  }
  if (err.keyword === 'not' && err.instancePath.startsWith('/confirmations/never_confirm/')) {
    return 'destructive actions (lock/unlock/delete*/factoryReset) cannot be pre-approved in policy.yaml';
  }
  if (err.keyword === 'const' && err.instancePath === '/version') {
    const supported = SUPPORTED_POLICY_SCHEMA_VERSIONS.map((v) => `"${v}"`).join(' / ');
    return `this CLI supports policy schema versions ${supported}; run \`switchbot policy migrate\` to upgrade an older file`;
  }
  if (err.keyword === 'required' && err.instancePath === '') {
    const missing = (err.params as { missingProperty: string }).missingProperty;
    if (missing === 'version') return `add \`version: "${CURRENT_POLICY_SCHEMA_VERSION}"\` at the top of the file`;
  }
  return undefined;
}

function readDeclaredVersion(data: unknown): string | undefined {
  if (data && typeof data === 'object' && 'version' in data) {
    const v = (data as { version: unknown }).version;
    if (typeof v === 'string') return v;
  }
  return undefined;
}

function unsupportedVersionResult(loaded: LoadedPolicy, declared: string): PolicyValidationResult {
  const supported = SUPPORTED_POLICY_SCHEMA_VERSIONS.map((v) => `"${v}"`).join(' / ');
  const isLegacy = declared === '0.1';
  const hint = isLegacy
    ? `v0.1 policy support was removed in v3.0. Run \`switchbot policy migrate\` with CLI ≤2.15 first, then upgrade.`
    : `supported versions: ${supported}. upgrade the CLI or downgrade the file.`;
  return {
    policyPath: loaded.path,
    schemaVersion: CURRENT_POLICY_SCHEMA_VERSION,
    validationScope: 'schema+offline-semantics',
    limitations: [...POLICY_VALIDATION_LIMITATIONS],
    valid: false,
    errors: [
      {
        path: '/version',
        line: 1,
        col: 1,
        keyword: 'unsupported-version',
        message: `policy schema version "${declared}" is not supported by this CLI`,
        hint,
        schemaPath: '#/properties/version',
      },
    ],
  };
}

function escapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isPlausibleDeviceId(value: string): boolean {
  return HEX_MAC_DEVICE_ID_RE.test(value) || HYPHENATED_DEVICE_ID_RE.test(value);
}

function hasErrorAtPath(errors: PolicyValidationError[], path: string): boolean {
  return errors.some((err) => err.path === path);
}

function resolvePolicyDeviceRef(
  raw: string | undefined,
  aliases: Record<string, string>,
): { ok: boolean; reason?: string } {
  if (!raw) return { ok: false, reason: 'missing-device' };
  if (raw === '<id>') return { ok: false, reason: 'missing-device' };
  if (Object.hasOwn(aliases, raw)) return { ok: true };
  if (isPlausibleDeviceId(raw)) return { ok: true };
  return { ok: false, reason: 'unknown-device-ref' };
}

/**
 * Walk `automation.rules[].then[]` and flag any command string whose verb
 * appears in DESTRUCTIVE_COMMANDS. Uses the YAML doc (not the data tree) to
 * get accurate line/col on the offending node.
 *
 * This is deliberately a post-ajv pass rather than a schema rule because
 * JSON Schema cannot parse a command string and compare the verb slot to a
 * blocklist. Keeping it in JS also lets `src/rules/destructive.ts` be the
 * single source of truth shared with the runtime executor.
 */
function collectDestructiveRuleErrors(loaded: LoadedPolicy): PolicyValidationError[] {
  const data = loaded.data as
    | { automation?: { rules?: Array<{ name?: string; then?: Array<{ command?: string }> }> } }
    | null
    | undefined;
  const rules = data?.automation?.rules;
  if (!Array.isArray(rules)) return [];

  const out: PolicyValidationError[] = [];
  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri];
    const actions = Array.isArray(rule?.then) ? rule.then : [];
    for (let ai = 0; ai < actions.length; ai++) {
      const cmd = actions[ai]?.command;
      if (typeof cmd !== 'string') continue;
      const verb = destructiveVerbOf(cmd);
      if (!verb) continue;

      const instancePath = `/automation/rules/${ri}/then/${ai}/command`;
      const segments = instancePath.slice(1).split('/');
      const node = getNodeAt(loaded.doc, segments);
      const range = (node as { range?: [number, number, number] } | null)?.range;
      let line: number | undefined;
      let col: number | undefined;
      if (range) {
        const pos = loaded.lineCounter.linePos(range[0]);
        line = pos.line;
        col = pos.col;
      }
      const ruleName = typeof rule?.name === 'string' ? rule.name : `#${ri}`;
      out.push({
        path: instancePath,
        line,
        col,
        keyword: 'rule-destructive-action',
        message: `rule "${ruleName}" action #${ai} uses destructive command "${verb}"`,
        hint: `destructive verbs (${DESTRUCTIVE_COMMANDS.join(', ')}) cannot be pre-approved in automation rules; run them via the interactive CLI so the confirmation gate fires`,
        schemaPath: '#/properties/automation/properties/rules/items/properties/then/items/properties/command',
      });
    }
  }
  return out;
}

function collectOfflineSemanticErrors(
  loaded: LoadedPolicy,
  existingErrors: PolicyValidationError[],
): PolicyValidationError[] {
  const data = loaded.data as
    | {
        aliases?: Record<string, string>;
        automation?: {
          rules?: Array<{
            name?: string;
            then?: Array<{ command?: string; device?: string }>;
          }>;
        };
      }
    | null
    | undefined;

  const out: PolicyValidationError[] = [];
  const aliases =
    data?.aliases && typeof data.aliases === 'object'
      ? Object.fromEntries(
          Object.entries(data.aliases).filter(
            (entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string',
          ),
        )
      : {};

  for (const [aliasName, deviceId] of Object.entries(aliases)) {
    const path = `/aliases/${escapeJsonPointerSegment(aliasName)}`;
    if (hasErrorAtPath(existingErrors, path)) continue;
    if (isPlausibleDeviceId(deviceId)) continue;
    const { line, col } = locateInstancePath(loaded.doc, loaded.lineCounter, path);
    out.push({
      path,
      line,
      col,
      keyword: 'alias-device-id',
      message: `alias "${aliasName}" does not point to a plausible SwitchBot deviceId`,
      hint: 'use a deviceId from `switchbot devices list --format=tsv`, e.g. 01-202407090924-26354212 or 28372F4C9C4A',
      schemaPath: '#/properties/aliases',
    });
  }

  const knownDeviceCommands = new Set(
    getEffectiveCatalog()
      .flatMap((entry) => entry.commands)
      .filter((spec) => spec.commandType !== 'customize')
      .map((spec) => spec.command),
  );

  const rules = data?.automation?.rules;
  if (!Array.isArray(rules)) return out;

  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri];
    const actions = Array.isArray(rule?.then) ? rule.then : [];
    for (let ai = 0; ai < actions.length; ai++) {
      const action = actions[ai];
      const cmd = action?.command;
      if (typeof cmd !== 'string') continue;
      const ruleName = typeof rule?.name === 'string' ? rule.name : `#${ri}`;
      const commandPath = `/automation/rules/${ri}/then/${ai}/command`;
      const devicePath = `/automation/rules/${ri}/then/${ai}/device`;

      const parsed = parseRuleCommand(cmd);
      if (!parsed) {
        const { line, col } = locateInstancePath(loaded.doc, loaded.lineCounter, commandPath);
        out.push({
          path: commandPath,
          line,
          col,
          keyword: 'rule-unparseable-command',
          message: `rule "${ruleName}" action #${ai} must use \`devices command <id> <verb> [parameter...]\``,
          hint: 'automation rules currently support only `devices command ...` actions; scenes/webhooks/other subcommands are not executable here',
          schemaPath: '#/properties/automation/properties/rules/items/properties/then/items/properties/command',
        });
        continue;
      }

      if (!knownDeviceCommands.has(parsed.verb)) {
        const { line, col } = locateInstancePath(loaded.doc, loaded.lineCounter, commandPath);
        out.push({
          path: commandPath,
          line,
          col,
          keyword: 'rule-unknown-command',
          message: `rule "${ruleName}" action #${ai} uses unknown device command "${parsed.verb}"`,
          hint: 'check `switchbot devices commands <type>` for valid verbs; this validator only checks offline catalog verbs, not the real target device',
          schemaPath: '#/properties/automation/properties/rules/items/properties/then/items/properties/command',
        });
      }

      if (typeof action?.device === 'string') {
        const resolved = resolvePolicyDeviceRef(action.device, aliases);
        if (!resolved.ok) {
          const { line, col } = locateInstancePath(loaded.doc, loaded.lineCounter, devicePath);
          out.push({
            path: devicePath,
            line,
            col,
            keyword: resolved.reason ?? 'unknown-device-ref',
            message: `rule "${ruleName}" action #${ai} references unknown device "${action.device}"`,
            hint: 'set `device:` to a declared alias or a plausible deviceId',
            schemaPath: '#/properties/automation/properties/rules/items/properties/then/items/properties/device',
          });
        }
        continue;
      }

      const resolved = resolvePolicyDeviceRef(parsed.deviceIdSlot ?? undefined, aliases);
      if (!resolved.ok) {
        const { line, col } = locateInstancePath(loaded.doc, loaded.lineCounter, commandPath);
        out.push({
          path: commandPath,
          line,
          col,
          keyword: resolved.reason ?? 'missing-device',
          message:
            resolved.reason === 'missing-device'
              ? `rule "${ruleName}" action #${ai} uses \`<id>\` but does not provide \`device:\``
              : `rule "${ruleName}" action #${ai} references unknown device "${parsed.deviceIdSlot}"`,
          hint:
            resolved.reason === 'missing-device'
              ? 'either replace `<id>` with a deviceId/alias or add `device: <alias-or-deviceId>` to the action'
              : 'use a declared alias or a plausible deviceId in the command slot',
          schemaPath: '#/properties/automation/properties/rules/items/properties/then/items/properties/command',
        });
      }
    }
  }

  return out;
}

export function validateLoadedPolicy(loaded: LoadedPolicy): PolicyValidationResult {
  const declared = readDeclaredVersion(loaded.data);

  if (declared !== undefined && !isSupportedPolicySchemaVersion(declared)) {
    return unsupportedVersionResult(loaded, declared);
  }

  const version: PolicySchemaVersion = isSupportedPolicySchemaVersion(declared)
    ? declared
    : CURRENT_POLICY_SCHEMA_VERSION;

  const { validate } = getValidator(version);
  const ok = validate(loaded.data);
  const errors: PolicyValidationError[] = [];

  if (!ok && validate.errors) {
    for (const err of validate.errors) {
      const { line, col } = locateError(loaded.doc, loaded.lineCounter, err);
      errors.push({
        path: err.instancePath || '',
        line,
        col,
        keyword: err.keyword,
        message: humanMessage(err),
        hint: hintFor(err),
        schemaPath: err.schemaPath,
      });
    }
  }

  // v0.2-only post-hook: destructive verbs like `unlock` / `factoryReset`
  // cannot be pre-approved via rules, even if ajv considers the command
  // string well-formed. Schema can't express this because `command` is a
  // free-form string; we parse the verb in JS and append errors.
  if (version === '0.2') {
    const ruleErrors = collectDestructiveRuleErrors(loaded);
    errors.push(...ruleErrors);
    errors.push(...collectOfflineSemanticErrors(loaded, errors));
  }

  const valid = ok === true && errors.length === 0;

  return {
    policyPath: loaded.path,
    schemaVersion: version,
    validationScope: 'schema+offline-semantics',
    limitations: [...POLICY_VALIDATION_LIMITATIONS],
    valid,
    errors,
  };
}

export function validatePolicyFile(policyPath: string): PolicyValidationResult {
  const loaded = loadPolicyFile(policyPath);
  return validateLoadedPolicy(loaded);
}
