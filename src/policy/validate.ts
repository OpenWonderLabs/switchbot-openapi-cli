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
  validationScope: 'schema+local-guards';
  limitations: string[];
  valid: boolean;
  errors: PolicyValidationError[];
}

const POLICY_VALIDATION_LIMITATIONS = [
  'Does not resolve aliases against the live device inventory.',
  'Does not verify that rule command strings are valid for a real device type.',
] as const;

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
    validationScope: 'schema+local-guards',
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
  }

  const valid = ok === true && errors.length === 0;

  return {
    policyPath: loaded.path,
    schemaVersion: version,
    validationScope: 'schema+local-guards',
    limitations: [...POLICY_VALIDATION_LIMITATIONS],
    valid,
    errors,
  };
}

export function validatePolicyFile(policyPath: string): PolicyValidationResult {
  const loaded = loadPolicyFile(policyPath);
  return validateLoadedPolicy(loaded);
}
