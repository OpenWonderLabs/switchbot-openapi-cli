export type DiffKind = 'added' | 'removed' | 'changed';

export interface PolicyDiffChange {
  path: string;
  kind: DiffKind;
  before?: unknown;
  after?: unknown;
}

export interface PolicyDiffResult {
  equal: boolean;
  changeCount: number;
  truncated: boolean;
  stats: {
    added: number;
    removed: number;
    changed: number;
  };
  changes: PolicyDiffChange[];
  diff: string;
}

export const MAX_POLICY_DIFF_CHANGES = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function collectPolicyDiff(
  left: unknown,
  right: unknown,
  at: string,
  out: PolicyDiffChange[],
  limit: number,
): void {
  if (out.length >= limit) return;

  if (Array.isArray(left) && Array.isArray(right)) {
    const maxLen = Math.max(left.length, right.length);
    for (let i = 0; i < maxLen; i++) {
      if (out.length >= limit) return;
      const path = `${at}[${i}]`;
      if (i >= left.length) {
        out.push({ path, kind: 'added', after: right[i] });
      } else if (i >= right.length) {
        out.push({ path, kind: 'removed', before: left[i] });
      } else {
        collectPolicyDiff(left[i], right[i], path, out, limit);
      }
    }
    return;
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set<string>([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      if (out.length >= limit) return;
      const path = at === '$' ? `$.${key}` : `${at}.${key}`;
      const leftHas = Object.prototype.hasOwnProperty.call(left, key);
      const rightHas = Object.prototype.hasOwnProperty.call(right, key);
      if (!leftHas && rightHas) {
        out.push({ path, kind: 'added', after: right[key] });
      } else if (leftHas && !rightHas) {
        out.push({ path, kind: 'removed', before: left[key] });
      } else {
        collectPolicyDiff(left[key], right[key], path, out, limit);
      }
    }
    return;
  }

  if (!Object.is(left, right)) {
    out.push({ path: at, kind: 'changed', before: left, after: right });
  }
}

function buildLineDiff(before: string, after: string): string {
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

export function diffPolicyValues(
  leftDoc: unknown,
  rightDoc: unknown,
  leftSource: string,
  rightSource: string,
  maxChanges = MAX_POLICY_DIFF_CHANGES,
): PolicyDiffResult {
  const changes: PolicyDiffChange[] = [];
  collectPolicyDiff(leftDoc, rightDoc, '$', changes, maxChanges);
  const equal = changes.length === 0;
  return {
    equal,
    changeCount: changes.length,
    truncated: changes.length >= maxChanges,
    stats: {
      added: changes.filter((c) => c.kind === 'added').length,
      removed: changes.filter((c) => c.kind === 'removed').length,
      changed: changes.filter((c) => c.kind === 'changed').length,
    },
    changes,
    diff: buildLineDiff(leftSource, rightSource),
  };
}