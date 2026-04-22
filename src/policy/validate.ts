import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';
import { isMap, isSeq, isScalar, type Node, type LineCounter, type Document } from 'yaml';
import { loadPolicyFile, type LoadedPolicy } from './load.js';
import { loadPolicySchema, CURRENT_POLICY_SCHEMA_VERSION, type PolicySchemaVersion } from './schema.js';

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
  valid: boolean;
  errors: PolicyValidationError[];
}

let cachedAjv: Ajv2020Type | null = null;
let cachedValidator: ValidateFn | null = null;

function getValidator() {
  if (cachedValidator) return { ajv: cachedAjv!, validate: cachedValidator };
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  addFormats(ajv);
  const schema = loadPolicySchema(CURRENT_POLICY_SCHEMA_VERSION);
  const validate = ajv.compile(schema);
  cachedAjv = ajv;
  cachedValidator = validate;
  return { ajv, validate };
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

function locateError(doc: Document.Parsed, lineCounter: LineCounter, err: ErrorObject): { line?: number; col?: number } {
  const segments = instancePathToSegments(err.instancePath);
  let node = getNodeAt(doc, segments);
  if (!node && err.keyword === 'required' && typeof err.params === 'object' && err.params) {
    const missingProp = (err.params as { missingProperty?: string }).missingProperty;
    if (missingProp) {
      node = getNodeAt(doc, segments);
    }
  }
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
    return `this CLI supports policy schema version "${CURRENT_POLICY_SCHEMA_VERSION}" only; run \`switchbot policy migrate\` once newer versions are released`;
  }
  if (err.keyword === 'required' && err.instancePath === '') {
    const missing = (err.params as { missingProperty: string }).missingProperty;
    if (missing === 'version') return `add \`version: "${CURRENT_POLICY_SCHEMA_VERSION}"\` at the top of the file`;
  }
  return undefined;
}

export function validateLoadedPolicy(loaded: LoadedPolicy): PolicyValidationResult {
  const { validate } = getValidator();
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

  return {
    policyPath: loaded.path,
    schemaVersion: CURRENT_POLICY_SCHEMA_VERSION,
    valid: ok === true,
    errors,
  };
}

export function validatePolicyFile(policyPath: string): PolicyValidationResult {
  const loaded = loadPolicyFile(policyPath);
  return validateLoadedPolicy(loaded);
}
