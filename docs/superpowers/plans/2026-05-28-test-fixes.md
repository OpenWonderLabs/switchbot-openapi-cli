# Test Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 8 test-quality issues found in the code review of `feat/claude-code-plugin` — all changes are in test files only, no production code touched.

**Architecture:** Surgical one-file-at-a-time fixes. Each task edits one file, runs its test suite to confirm green, and commits. Order: codex-plugin tests → claude-code-plugin tests → root vitest tests.

**Tech Stack:** Node.js `node:test` (codex-plugin, claude-code-plugin), Vitest (root tests).

---

## File Map

| File | Fixes |
|------|-------|
| `packages/codex-plugin/tests/skill-sync.test.js` | #1 (import.meta.dirname), #6 (regex), #7 (SKILL_3) |
| `packages/claude-code-plugin/plugins/switchbot/skills/switchbot/SKILL.md` | #7 companion (add MAINTENANCE comment) |
| `packages/claude-code-plugin/tests/hooks.test.js` | #2 (args.length), #8 (ENOENT cascade) |
| `tests/readme-route-b.test.ts` | #3 (indexOf), #4 ('not for') |
| `packages/codex-plugin/tests/marketplace-schema.test.js` | #5 (Object.keys) |

---

## Task 1: Fix `skill-sync.test.js` (fixes #1, #6, #7)

**Files:**
- Modify: `packages/codex-plugin/tests/skill-sync.test.js`
- Modify: `packages/claude-code-plugin/plugins/switchbot/skills/switchbot/SKILL.md` (MAINTENANCE comment)

**Context — why SKILL_3 is not added to the identity assertion:**
The `claude-code-plugin` SKILL.md diverges intentionally at line 37 (Claude Code network setup vs Codex network setup). Adding it to the content-equality assertion would cause an immediate false failure. Fix #7 therefore adds SKILL_3 only to the "exists" and "has MAINTENANCE comment" sub-tests.

- [ ] **Step 1: Verify current tests pass**

```
cd packages/codex-plugin && npm test
```

Expected: `# pass 56  # fail 0`

- [ ] **Step 2: Add MAINTENANCE comment to the third SKILL.md**

Append one line to `packages/claude-code-plugin/plugins/switchbot/skills/switchbot/SKILL.md` (currently 203 lines, ends after the Version section):

```markdown

<!-- MAINTENANCE: Claude Code-specific variant of packages/codex-plugin/skills/switchbot/SKILL.md — update alongside the codex copies when shared sections change. -->
```

- [ ] **Step 3: Rewrite `skill-sync.test.js`**

Replace the entire file with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SKILL_1 = path.join(__dirname, '../skills/switchbot/SKILL.md');
const SKILL_2 = path.join(__dirname, '../plugins/switchbot/skills/switchbot/SKILL.md');
// claude-code-plugin copy — intentionally different content at line 37 (plugin-specific network setup),
// but must still exist on disk and carry a MAINTENANCE comment.
const SKILL_3 = path.join(__dirname, '../../claude-code-plugin/plugins/switchbot/skills/switchbot/SKILL.md');

test('SKILL.md files have maintenance comments and identical content', async (t) => {
  await t.test('all SKILL.md files exist', () => {
    assert.ok(fs.existsSync(SKILL_1), `${SKILL_1} should exist`);
    assert.ok(fs.existsSync(SKILL_2), `${SKILL_2} should exist`);
    assert.ok(fs.existsSync(SKILL_3), `${SKILL_3} should exist`);
  });

  await t.test('all SKILL.md files contain MAINTENANCE comment', () => {
    const content1 = fs.readFileSync(SKILL_1, 'utf8');
    const content2 = fs.readFileSync(SKILL_2, 'utf8');
    const content3 = fs.readFileSync(SKILL_3, 'utf8');

    assert.ok(
      content1.includes('<!-- MAINTENANCE:'),
      `${SKILL_1} should contain <!-- MAINTENANCE: comment`
    );
    assert.ok(
      content2.includes('<!-- MAINTENANCE:'),
      `${SKILL_2} should contain <!-- MAINTENANCE: comment`
    );
    assert.ok(
      content3.includes('<!-- MAINTENANCE:'),
      `${SKILL_3} should contain <!-- MAINTENANCE: comment`
    );
  });

  await t.test('codex-plugin SKILL.md files have identical content except maintenance comments', () => {
    const content1 = fs.readFileSync(SKILL_1, 'utf8');
    const content2 = fs.readFileSync(SKILL_2, 'utf8');

    const removeMaintenanceComment = (content) => {
      return content.replace(/\n<!-- MAINTENANCE:[\s\S]*?-->\s*$/, '');
    };

    const normalized1 = removeMaintenanceComment(content1);
    const normalized2 = removeMaintenanceComment(content2);

    assert.equal(
      normalized1,
      normalized2,
      'SKILL.md files (1 and 2) should have identical content except for maintenance comments'
    );
  });
});
```

Key changes vs original:
- Line 5: added `import { fileURLToPath } from 'node:url';`
- Line 7: `path.dirname(fileURLToPath(import.meta.url))` replaces `import.meta.dirname` (fix #1)
- Line 10-11: `path.join(__dirname, ...)` now works correctly
- Line 13-15: added `SKILL_3` constant
- Sub-test "exists": now checks all three files
- Sub-test "MAINTENANCE comment": now checks all three files
- Sub-test "identical content": renamed to "codex-plugin SKILL.md files…", still checks only SKILL_1 vs SKILL_2
- Regex: `/\n<!-- MAINTENANCE:[\s\S]*?-->\s*$/` replaces `/\n<!-- MAINTENANCE:.*-->\s*$/` (fix #6)

- [ ] **Step 4: Run tests**

```
cd packages/codex-plugin && npm test
```

Expected: all tests pass, count increases by 1 (new `SKILL_3` assertions in the exist/MAINTENANCE sub-tests).

- [ ] **Step 5: Commit**

```
git add packages/codex-plugin/tests/skill-sync.test.js
git add packages/claude-code-plugin/plugins/switchbot/skills/switchbot/SKILL.md
git commit -m "fix(tests): replace import.meta.dirname, fix regex, add SKILL_3 guard"
```

---

## Task 2: Fix `hooks.test.js` (fixes #2, #8)

**Files:**
- Modify: `packages/claude-code-plugin/tests/hooks.test.js`

- [ ] **Step 1: Verify current tests pass**

```
cd packages/claude-code-plugin && npm test
```

Expected: all tests pass.

- [ ] **Step 2: Rewrite `hooks.test.js`**

Replace the entire file with:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

const HOOKS_FILES = [
  {
    label: '.claude-plugin/hooks.json (root)',
    path: resolve(pkgRoot, '.claude-plugin', 'hooks.json'),
  },
  {
    label: 'plugins/switchbot/.claude-plugin/hooks.json',
    path: resolve(pkgRoot, 'plugins', 'switchbot', '.claude-plugin', 'hooks.json'),
  },
];

describe('hooks.json files', () => {
  for (const { label, path: hooksPath } of HOOKS_FILES) {
    describe(label, () => {
      it('exists on disk', () => {
        assert.ok(existsSync(hooksPath), `Missing: ${hooksPath}`);
      });

      if (existsSync(hooksPath)) {
        it('is valid JSON', () => {
          const raw = readFileSync(hooksPath, 'utf8');
          assert.doesNotThrow(() => JSON.parse(raw), `Invalid JSON in ${hooksPath}`);
        });

        it('has onInstall.command === "node"', () => {
          const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
          assert.equal(hooks?.onInstall?.command, 'node',
            `Expected onInstall.command to be "node" in ${hooksPath}`);
        });

        it('onInstall.args[0] resolves to an existing file', () => {
          const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
          const relPath = hooks?.onInstall?.args?.[0];
          assert.ok(typeof relPath === 'string', `onInstall.args[0] must be a string in ${hooksPath}`);
          const resolved = resolve(dirname(hooksPath), relPath);
          assert.ok(existsSync(resolved),
            `onInstall.args[0] "${relPath}" resolves to "${resolved}" which does not exist`);
        });

        it('onInstall.args has exactly one element', () => {
          const hooks = JSON.parse(readFileSync(hooksPath, 'utf8'));
          const args = hooks?.onInstall?.args;
          assert.ok(Array.isArray(args), `onInstall.args must be an array in ${hooksPath}`);
          assert.equal(args.length, 1, `onInstall.args should have exactly one element in ${hooksPath}`);
        });
      }
    });
  }
});
```

Key changes vs original:
- Lines 27-54: the four `it` blocks are now wrapped in `if (existsSync(hooksPath))` — if the file is missing, only "exists on disk" runs and fails with a clear message (fix #8). `describe` callbacks are synchronous in `node:test`, so this registration-time guard works correctly.
- Line 51: added `assert.ok(Array.isArray(args), ...)` before `args.length` (fix #2).
- Line 52: updated message to include `hooksPath` for clarity.

- [ ] **Step 3: Run tests**

```
cd packages/claude-code-plugin && npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add packages/claude-code-plugin/tests/hooks.test.js
git commit -m "fix(tests): guard args.length undefined and wrap ENOENT-prone it blocks"
```

---

## Task 3: Fix `readme-route-b.test.ts` (fixes #3, #4)

**Files:**
- Modify: `tests/readme-route-b.test.ts`

- [ ] **Step 1: Verify current tests pass**

```
npm test -- tests/readme-route-b.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 2: Rewrite `readme-route-b.test.ts`**

Replace the entire file with:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const readmeContent = readFileSync(
  path.join(here, '..', 'README.md'),
  'utf-8',
);

describe('README.md — Route B documentation', () => {
  it('mentions "Route B" to explain marketplace.json purpose', () => {
    expect(readmeContent.toLowerCase()).toMatch(/route\s+b/i);
  });

  it('explains marketplace.json in context of Codex or Route B', () => {
    expect(readmeContent).toContain('marketplace.json');

    // Collect all offsets where 'marketplace.json' appears (fix #3: indexOf only finds first)
    const term = 'marketplace.json';
    const offsets: number[] = [];
    let pos = readmeContent.indexOf(term);
    while (pos !== -1) {
      offsets.push(pos);
      pos = readmeContent.indexOf(term, pos + 1);
    }

    const hasContext = offsets.some((offset) => {
      const window = readmeContent
        .slice(Math.max(0, offset - 300), offset + 300)
        .toLowerCase();
      return window.includes('codex') || window.includes('route');
    });
    expect(hasContext).toBe(true);
  });

  it('clarifies that root marketplace.json is not for Claude Code users', () => {
    // fix #4: removed the broad 'not for' fallback; now requires 'claude code' near the term
    const term = 'marketplace.json';
    let pos = readmeContent.indexOf(term);
    let found = false;
    while (pos !== -1) {
      const window = readmeContent
        .slice(Math.max(0, pos - 300), pos + 300)
        .toLowerCase();
      if (window.includes('claude code')) {
        found = true;
        break;
      }
      pos = readmeContent.indexOf(term, pos + 1);
    }
    expect(found).toBe(true);
  });
});
```

Key changes vs original:
- Test 2 (lines 17-30): replaced single `indexOf` + slice with a `while` loop collecting all offsets, then `some()` — passes if any occurrence is near context keywords (fix #3).
- Test 3 (lines 32-38): replaced `includes('claude code') || includes('not for')` with the same multi-occurrence loop requiring `'claude code'` in the window around each `marketplace.json` occurrence (fix #4).

- [ ] **Step 3: Run tests**

```
npm test -- tests/readme-route-b.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```
git add tests/readme-route-b.test.ts
git commit -m "fix(tests): use all-occurrences search and tighten Claude Code guard"
```

---

## Task 4: Fix `marketplace-schema.test.js` (fix #5)

**Files:**
- Modify: `packages/codex-plugin/tests/marketplace-schema.test.js`

- [ ] **Step 1: Verify current tests pass**

```
cd packages/codex-plugin && npm test
```

Expected: all tests pass.

- [ ] **Step 2: Replace the `Object.keys` ordering assertion**

In `packages/codex-plugin/tests/marketplace-schema.test.js`, replace lines 38-43:

```js
  it('$schema is the first field in codex-plugin marketplace.json', () => {
    const rawContent = readFileSync(codexPluginMarketplacePath, 'utf8');
    const parsed = JSON.parse(rawContent);
    const firstKey = Object.keys(parsed)[0];
    assert.equal(firstKey, '$schema', 'first field should be $schema');
  });
```

with:

```js
  it('$schema is the first field in codex-plugin marketplace.json', () => {
    const rawContent = readFileSync(codexPluginMarketplacePath, 'utf8');
    assert.ok(
      rawContent.indexOf('"$schema"') < rawContent.indexOf('"name"'),
      '$schema should appear before "name" in the raw JSON text',
    );
  });
```

This compares raw string positions instead of relying on `Object.keys()` insertion-order preservation (a V8 implementation detail, not a JSON-spec guarantee).

- [ ] **Step 3: Run tests**

```
cd packages/codex-plugin && npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add packages/codex-plugin/tests/marketplace-schema.test.js
git commit -m "fix(tests): replace Object.keys ordering with raw string position check"
```

---

## Verification

After all four tasks, run the full test suite from the repo root to confirm nothing regressed:

```
npm run test:workspaces
```

Expected: all workspace test suites pass with 0 failures.
