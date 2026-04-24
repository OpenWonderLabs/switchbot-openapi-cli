import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseDocument, LineCounter, type Document } from 'yaml';

export const DEFAULT_POLICY_PATH = join(homedir(), '.config', 'openclaw', 'switchbot', 'policy.yaml');

export interface ResolvePolicyPathOptions {
  flag?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolvePolicyPath(options: ResolvePolicyPathOptions = {}): string {
  const { flag, env = process.env } = options;
  if (flag && flag.trim().length > 0) return resolve(flag);
  const fromEnv = env.SWITCHBOT_POLICY_PATH;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv);
  return DEFAULT_POLICY_PATH;
}

export interface LoadedPolicy {
  path: string;
  source: string;
  doc: Document.Parsed;
  lineCounter: LineCounter;
  data: unknown;
}

export class PolicyFileNotFoundError extends Error {
  constructor(public readonly policyPath: string) {
    super(`policy file not found: ${policyPath}`);
    this.name = 'PolicyFileNotFoundError';
  }
}

export class PolicyYamlParseError extends Error {
  constructor(
    message: string,
    public readonly policyPath: string,
    public readonly yamlErrors: ReadonlyArray<{ line?: number; col?: number; message: string }>,
  ) {
    super(message);
    this.name = 'PolicyYamlParseError';
  }
}

export function loadPolicyFile(policyPath: string): LoadedPolicy {
  let source: string;
  try {
    source = readFileSync(policyPath, 'utf-8');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') throw new PolicyFileNotFoundError(policyPath);
    throw err;
  }

  const lineCounter = new LineCounter();
  const doc = parseDocument(source, { lineCounter, keepSourceTokens: true });

  if (doc.errors.length > 0) {
    const yamlErrors = doc.errors.map((e) => {
      const pos = e.pos?.[0];
      const loc = pos !== undefined ? lineCounter.linePos(pos) : undefined;
      return { line: loc?.line, col: loc?.col, message: e.message };
    });
    throw new PolicyYamlParseError(doc.errors[0].message, policyPath, yamlErrors);
  }

  return {
    path: policyPath,
    source,
    doc,
    lineCounter,
    data: doc.toJS({ maxAliasCount: 100 }),
  };
}
