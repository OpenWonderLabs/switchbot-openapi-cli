import { isMap, isScalar, parseDocument, LineCounter, type Document } from 'yaml';
import { validateLoadedPolicy, type PolicyValidationResult } from './validate.js';
import type { LoadedPolicy } from './load.js';
import type { PolicySchemaVersion } from './schema.js';

export interface MigrationPlan {
  fromVersion: PolicySchemaVersion;
  toVersion: PolicySchemaVersion;
  migrate: (doc: Document.Parsed) => void;
}

export class PolicyMigrationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'PolicyMigrationError';
  }
}

const MIGRATION_CHAIN: MigrationPlan[] = [
  {
    fromVersion: '0.1',
    toVersion: '0.2',
    migrate: (doc) => bumpVersionScalar(doc, '0.2'),
  },
];

function bumpVersionScalar(doc: Document.Parsed, target: string): void {
  if (!isMap(doc.contents)) {
    throw new PolicyMigrationError(
      'policy root must be a YAML mapping (got null or an array)',
      'invalid-shape',
    );
  }
  const pair = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === 'version');
  if (!pair || !isScalar(pair.value)) {
    throw new PolicyMigrationError(
      'policy has no `version` scalar to migrate; add `version: "0.1"` and retry',
      'no-version-field',
    );
  }
  pair.value.value = target;
}

function findPlan(from: PolicySchemaVersion, to: PolicySchemaVersion): MigrationPlan[] {
  const chain: MigrationPlan[] = [];
  let cur = from;
  while (cur !== to) {
    const step = MIGRATION_CHAIN.find((p) => p.fromVersion === cur);
    if (!step) {
      throw new PolicyMigrationError(
        `no migration path from v${from} to v${to} (missing step at v${cur})`,
        'no-path',
      );
    }
    chain.push(step);
    cur = step.toVersion;
  }
  return chain;
}

export interface MigrationDryRun {
  changed: boolean;
  fromVersion: PolicySchemaVersion;
  toVersion: PolicySchemaVersion;
  nextSource: string;
  precheck: PolicyValidationResult;
}

export function planMigration(
  loaded: LoadedPolicy,
  from: PolicySchemaVersion,
  to: PolicySchemaVersion,
): MigrationDryRun {
  if (from === to) {
    const precheck = validateLoadedPolicy(loaded);
    return { changed: false, fromVersion: from, toVersion: to, nextSource: loaded.source, precheck };
  }

  const plan = findPlan(from, to);
  // Round-trip through source instead of Document.clone(): keeps comments +
  // anchors intact, works across yaml library versions, and leaves the
  // caller's `loaded.doc` untouched.
  const nextLineCounter = new LineCounter();
  const clone = parseDocument(loaded.source, {
    lineCounter: nextLineCounter,
    keepSourceTokens: true,
  }) as Document.Parsed;
  for (const step of plan) step.migrate(clone);

  const nextSource = String(clone);
  // Re-parse after serialization so `doc` and `source` stay in sync for the
  // validator's line/col mapping.
  const reLineCounter = new LineCounter();
  const reDoc = parseDocument(nextSource, {
    lineCounter: reLineCounter,
    keepSourceTokens: true,
  }) as Document.Parsed;

  const precheck = validateLoadedPolicy({
    path: loaded.path,
    source: nextSource,
    doc: reDoc,
    lineCounter: reLineCounter,
    data: reDoc.toJS({ maxAliasCount: 100 }),
  });

  return { changed: true, fromVersion: from, toVersion: to, nextSource, precheck };
}
