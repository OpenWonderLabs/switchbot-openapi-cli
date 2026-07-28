# Test Fixes Design — 2026-05-28

## Background

A code review of the `feat/claude-code-plugin` branch identified 8 issues, all in test files.
No production code changes are required. All fixes follow Approach A (surgical, minimal diff).

---

## Fix #1 — `import.meta.dirname` crash on Node < 21.2

**File:** `packages/codex-plugin/tests/skill-sync.test.js` line 6

**Problem:** `import.meta.dirname` was introduced in Node 21.2. The package declares
`"engines": { "node": ">=18" }`, so Node 18/19/20/21.0-21.1 throw `TypeError` at startup,
aborting the entire test file.

**Fix:** Replace `import.meta.dirname` with `dirname(fileURLToPath(import.meta.url))`.
Add `dirname` to the `node:path` import and `fileURLToPath` from `node:url`.

---

## Fix #2 — `args.length` TypeError on undefined

**File:** `packages/claude-code-plugin/tests/hooks.test.js` lines 50-51

**Problem:** `hooks?.onInstall?.args` can be `undefined`; calling `.length` on it throws
`TypeError` instead of producing the custom `AssertionError` message.

**Fix:** Add `assert.ok(Array.isArray(args), 'onInstall.args must be an array in ...')` before
the `assert.equal(args.length, 1, ...)` call.

---

## Fix #3 — `indexOf` only checks first occurrence of `marketplace.json`

**File:** `tests/readme-route-b.test.ts` lines 20-29

**Problem:** `readmeContent.indexOf('marketplace.json')` returns the first occurrence only. If
`marketplace.json` appears earlier in an unrelated context, the ±300-char window never overlaps
the Route B explanation.

**Fix:** Collect all occurrence offsets with a `matchAll` loop (or `while indexOf`), then use
`Array.prototype.some()`: pass if any occurrence has `codex` or `route` within ±300 chars.

---

## Fix #4 — `'not for'` guard too broad

**File:** `tests/readme-route-b.test.ts` lines 34-37

**Problem:** `content.includes('not for')` matches any two-word phrase, making the assertion
trivially satisfiable regardless of whether the actual disclaimer exists.

**Fix:** Replace the OR logic with a single, specific check: find the `marketplace.json`
occurrence in context and assert that the same ±300-char window also contains `claude code`.

---

## Fix #5 — `Object.keys` ordering relies on V8 implementation detail

**File:** `packages/codex-plugin/tests/marketplace-schema.test.js` lines 41-43

**Problem:** `Object.keys(JSON.parse(rawContent))[0]` relies on V8's key-insertion-order
preservation, which is not guaranteed by the JSON specification.

**Fix:** Replace the parsed-object check with a raw-string position comparison:
`rawContent.indexOf('"$schema"') < rawContent.indexOf('"name"')`.

---

## Fix #6 — Regex flag missing for multiline MAINTENANCE comments

**File:** `packages/codex-plugin/tests/skill-sync.test.js` line 35

**Problem:** `/\n<!-- MAINTENANCE:.*-->\s*$/` — `.` does not match `\n` by default. A
multi-line comment body is not stripped, leaving different comment texts in the comparison and
causing false failures.

**Fix:** Change the regex to `/\n<!-- MAINTENANCE:[\s\S]*?-->\s*$/` so `[\s\S]*?` matches
across newlines. Anchor remains `$`.

---

## Fix #7 — Sync test misses third SKILL.md copy

**File:** `packages/codex-plugin/tests/skill-sync.test.js` lines 6-7

**Problem:** `SKILL_1` and `SKILL_2` both live inside `packages/codex-plugin/`. The third copy
at `packages/claude-code-plugin/plugins/switchbot/skills/switchbot/SKILL.md` has no MAINTENANCE
comment and is not covered by any sync guard.

**Fix (two parts):**
1. Add `SKILL_3` constant pointing to the `claude-code-plugin` copy.
2. Extend the test to assert all three files have identical content (after stripping MAINTENANCE
   comments) and each contains a MAINTENANCE comment.
3. Add a MAINTENANCE comment to `SKILL_3` (the claude-code-plugin copy) so the comment-existence
   assertion passes.

---

## Fix #8 — ENOENT cascade when hooks file is missing

**File:** `packages/claude-code-plugin/tests/hooks.test.js`

**Problem:** If a hooks.json file does not exist, all `it()` blocks after `'exists on disk'`
throw raw `ENOENT` system errors, obscuring the single root cause.

**Fix:** At the top of each inner `describe(label, ...)` callback, after the HOOKS_FILES loop
variable is bound, add a guard: `if (!existsSync(hooksPath)) { /* remaining its will skip */ }`.
In `node:test`, skipping is done with `it.skip()` or by returning early inside the `describe`
callback so the `it` declarations are never registered.

Concretely: wrap the four `it` blocks (lines 29-54) inside `if (existsSync(hooksPath))`.
The `'exists on disk'` assertion still runs unconditionally and provides the clear failure
message.

---

## Scope

All 8 changes are in test files only:
- `packages/codex-plugin/tests/skill-sync.test.js` (fixes #1, #6, #7)
- `packages/claude-code-plugin/tests/hooks.test.js` (fixes #2, #8)
- `tests/readme-route-b.test.ts` (fixes #3, #4)
- `packages/codex-plugin/tests/marketplace-schema.test.js` (fix #5)
- `packages/claude-code-plugin/plugins/switchbot/skills/switchbot/SKILL.md` (companion to #7)

No production code, no `package.json` engines field changes (fix #1 removes the offending API
call rather than raising the minimum version).
