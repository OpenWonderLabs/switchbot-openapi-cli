import { parseDocument, isMap, isSeq, isScalar, LineCounter } from 'yaml';
import { parse as yamlParse } from 'yaml';
import { loadPolicyFile, resolvePolicyPath, PolicyFileNotFoundError } from './load.js';
import { validateLoadedPolicy } from './validate.js';
import fs from 'node:fs';

export interface AddRuleOptions {
  ruleYaml: string;
  policyPath: string;
  enableAutomation?: boolean;
  force?: boolean;
}

export interface AddRuleResult {
  ruleName: string;
  diff: string;
  nextSource: string;
}

export class AddRuleError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'AddRuleError';
  }
}

function buildDiff(before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const lines: string[] = ['--- before', '+++ after'];

  let i = 0;
  let j = 0;
  while (i < beforeLines.length || j < afterLines.length) {
    const b = beforeLines[i];
    const a = afterLines[j];
    if (i < beforeLines.length && j < afterLines.length && b === a) {
      lines.push(` ${b}`);
      i++;
      j++;
    } else if (j < afterLines.length && (i >= beforeLines.length || b !== a)) {
      lines.push(`+${a}`);
      j++;
    } else {
      lines.push(`-${b}`);
      i++;
    }
  }
  return lines.join('\n');
}

function isNullNode(node: unknown): boolean {
  return isScalar(node) && node.value === null;
}

export function addRuleToPolicySource(opts: AddRuleOptions): AddRuleResult {
  const loaded = loadPolicyFile(opts.policyPath);
  const beforeSource = loaded.source;

  // Parse the incoming rule
  let ruleObj: unknown;
  try {
    ruleObj = yamlParse(opts.ruleYaml);
  } catch (err) {
    throw new AddRuleError(
      `Could not parse rule YAML: ${(err as Error).message}`,
      'invalid-rule-yaml',
    );
  }

  if (!ruleObj || typeof ruleObj !== 'object' || Array.isArray(ruleObj)) {
    throw new AddRuleError('Rule YAML must be a single mapping object', 'invalid-rule-shape');
  }

  const ruleName = (ruleObj as Record<string, unknown>)['name'];
  if (typeof ruleName !== 'string' || !ruleName) {
    throw new AddRuleError('Rule must have a non-empty "name" field', 'missing-rule-name');
  }

  // Clone the document using source round-trip (preserves comments)
  const clone = parseDocument(beforeSource, { keepSourceTokens: true });

  if (!isMap(clone.contents)) {
    throw new AddRuleError('Policy root must be a YAML mapping', 'invalid-policy-shape');
  }

  // Ensure automation block exists
  let automationNode = clone.contents.get('automation', true);
  if (!automationNode || isNullNode(automationNode)) {
    clone.setIn(['automation'], clone.createNode({ enabled: false, rules: [] }));
    automationNode = clone.contents.get('automation', true);
  }

  // Ensure automation.rules exists and is a sequence
  const rulesNode = clone.getIn(['automation', 'rules'], true);
  if (!rulesNode || isNullNode(rulesNode)) {
    clone.setIn(['automation', 'rules'], clone.createNode([]));
  } else if (!isSeq(rulesNode)) {
    throw new AddRuleError(
      'automation.rules exists but is not a sequence; cannot append',
      'invalid-rules-shape',
    );
  }

  // Duplicate name check — use JS conversion for simplicity
  const policyJs = clone.toJS({ maxAliasCount: 100 }) as Record<string, unknown>;
  const existingRulesJs = (policyJs['automation'] as Record<string, unknown>)?.['rules'];
  const existingRulesArr = Array.isArray(existingRulesJs) ? existingRulesJs as Array<Record<string, unknown>> : [];
  const duplicateIdx = existingRulesArr.findIndex((r) => r?.['name'] === ruleName);

  if (duplicateIdx !== -1 && !opts.force) {
    throw new AddRuleError(
      `Rule named "${ruleName}" already exists. Use --force to overwrite.`,
      'duplicate-rule-name',
    );
  }
  if (duplicateIdx !== -1 && opts.force) {
    const rulesSeq = clone.getIn(['automation', 'rules'], true) as import('yaml').YAMLSeq;
    rulesSeq.items.splice(duplicateIdx, 1);
  }

  // Enable automation if requested
  if (opts.enableAutomation) {
    clone.setIn(['automation', 'enabled'], true);
  }

  // Append the rule
  const ruleNode = clone.createNode(ruleObj);
  const rulesSeq = clone.getIn(['automation', 'rules'], true) as import('yaml').YAMLSeq;
  rulesSeq.items.push(ruleNode);

  const nextSource = String(clone);

  // Validate the resulting policy
  const reLC = new LineCounter();
  const reDoc = parseDocument(nextSource, { lineCounter: reLC, keepSourceTokens: true });
  const validation = validateLoadedPolicy({
    path: opts.policyPath,
    source: nextSource,
    doc: reDoc as import('yaml').Document.Parsed,
    lineCounter: reLC,
    data: reDoc.toJS({ maxAliasCount: 100 }),
  });

  if (!validation.valid) {
    const msgs = validation.errors.map((e) => `  line ${e.line}: ${e.message}`).join('\n');
    throw new AddRuleError(
      `Policy would be invalid after adding the rule:\n${msgs}`,
      'validation-failed',
    );
  }

  const diff = buildDiff(beforeSource, nextSource);
  return { ruleName, diff, nextSource };
}

export function addRuleToPolicyFile(opts: AddRuleOptions & { dryRun?: boolean }): AddRuleResult & { written: boolean } {
  const result = addRuleToPolicySource(opts);
  if (!opts.dryRun) {
    fs.writeFileSync(opts.policyPath, result.nextSource, 'utf8');
    return { ...result, written: true };
  }
  return { ...result, written: false };
}
