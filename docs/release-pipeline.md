# Release pipeline

This document describes how `@switchbot/openapi-cli` goes from commit to npm
registry, and the invariants that keep the published artifact safe.

## Single publish source

There is exactly one way to produce the release artifact:

```
npm run build          →  node scripts/build.mjs
```

Every script on the release path — `prepublishOnly`, `verify:pre-commit`,
`verify:pre-push`, `publish.yml`, `ci.yml/bundle-smoke`, `ci.yml/pack-install-smoke` —
calls `npm run build` by name. No job re-implements any of the steps, and no
other script writes to `dist/`.

### The five stages of `scripts/build.mjs`

| # | Stage | Script | Responsibility |
|---|---|---|---|
| 1 | clean          | inline                       | remove `dist/` so nothing stale leaks into the tarball |
| 2 | typecheck      | `tsc --noEmit`               | all types must compile before we bundle |
| 3 | bundle         | `scripts/bundle.mjs`         | esbuild produces the single-file `dist/index.js` (shebang via `banner.js`) |
| 4 | copy-assets    | `scripts/copy-assets.mjs`    | copy `src/policy/{schema,examples}` → `dist/policy/...` |
| 5 | ensure-binary  | `scripts/ensure-binary.mjs`  | assert the shebang is present and `chmod 0755` on `dist/index.js` |

Each stage does exactly one thing. First non-zero exit aborts the build.

### Why `ensure-binary.mjs` is a guard, not a repair

The shebang (`#!/usr/bin/env node`) is injected at bundle time by
`scripts/bundle.mjs` via the esbuild `banner.js` option. `ensure-binary.mjs`
re-reads `dist/index.js` and **verifies** that the first bytes are the
expected shebang — if not, it exits non-zero with a pointer to the banner
config.

Previously, `copy-assets.mjs` silently **repaired** a missing shebang by
prepending it at the end of the build. That masked the root cause (a
change to the banner config would not surface at build time). The current
split is:

- `bundle.mjs` — *produces* the shebang via banner.
- `ensure-binary.mjs` — *asserts* the shebang exists. Never patches.

If anything ever drops the banner line, `npm run build` fails loudly at
stage 5 with a message pointing to `scripts/bundle.mjs`.

`npm pack` follows `"files": ["dist", "README.md", "LICENSE"]` in
`package.json`, so whatever ends up in `dist/` after stage 5 is what ships.

## Gates before `npm publish`

```
git commit ──▶ pre-commit hook ─── verify:pre-commit
                                   (npm run build + tests/version.test.ts)

git push   ──▶ pre-push hook  ──── verify:pre-push
                                   (npm run build + version test +
                                    smoke:pack-install)

open PR    ──▶ ci.yml ──────────── docs-lint
                                   test matrix (Node 18/20/22)
                                   bundle-smoke (Node 18/20/22)
                                   offline-smoke (size budgets)
                                   pack-install-smoke (matches publish)
                                   policy-schema-sync

merge PR   ──▶ main

release    ──▶ publish.yml ─────── 1. npm ci
                                   2. npm run build
                                   3. npm test
                                   4. tag == package.json version
                                   5. npm run smoke:pack-install  ◀── last gate
                                   6. npm publish --tag next
                                      └── prepublishOnly: test + build + smoke
                                          (same commands as steps 2-5 — no drift)
```

Because step 2 and `prepublishOnly` both call `npm run build`, the tarball
validated by `smoke:pack-install` in step 5 is byte-identical to the
tarball `npm publish` uploads in step 6. No artifact swap happens in between.

The critical pre-publish gate is step 5. It runs
`scripts/smoke-pack-install.mjs`, which:

- Runs `npm pack` on the freshly-built tarball.
- Installs the tarball into a throwaway temp project.
- Executes `node_modules/.bin/switchbot --version` and compares the output to
  `package.json.version`.

If the shebang is missing, the bin entry is not marked executable, the version
drifts, or any deps are missing — the CLI fails to run and the smoke test exits
non-zero. `npm publish` does not run.

## Post-publish defense-in-depth

```
npm-published-smoke.yml (triggered by publish.yml completion):
  1. wait_package       — wait for @next to appear on the registry
  2. install_package    — install in a clean temp project
  3. offline_smoke      — --version, --help, schema export, capabilities
  4. live_smoke         — doctor, devices list (uses real credentials)
  5. promote to @latest ◀── only if all four above pass
     OR
     npm deprecate      ◀── only on install_package / offline_smoke failure
                              (never on live_smoke — API flakes should not
                               auto-deprecate a package)
```

This workflow runs *after* `npm publish`. It is defense-in-depth only; the
pre-publish gates are what keep bad artifacts off the registry in the first
place.

## Invariants

Changes to the release pipeline must preserve these invariants:

1. **One command produces the release artifact.** `npm run build` is the
   only path that writes `dist/` for publish. `publish.yml`, `prepublishOnly`,
   `verify:pre-push`, and both `bundle-smoke` + `pack-install-smoke` jobs must
   all call it by name — never re-implement steps.

2. **One artifact is smoked.** `smoke:pack-install` always runs against the
   `dist/` that `npm run build` just produced. No other script writes to
   `dist/` between the build and the smoke.

3. **One failure mode per script.** `copy-assets.mjs` can fail because an
   asset is missing. `ensure-binary.mjs` can fail because the shebang is
   missing or the output is absent. No script silently repairs the output of
   another.

4. **`prepublishOnly` and `publish.yml` do not drift.** Both run
   `npm test && npm run build && npm run smoke:pack-install`. Any edit that
   changes one must change the other in the same commit.

5. **`publish.yml` must run `smoke:pack-install` before `npm publish`.** If
   this gate is removed or skipped, a broken tarball can reach the registry.

6. **Auto-deprecate must never fire on `live_smoke` failure.** Live smoke
   depends on real SwitchBot API availability and valid credentials; a
   transient outage should not deprecate a working package. Only
   `install_package` and `offline_smoke` failures justify an automatic
   deprecation.

7. **`bundle-smoke` must stay blocking and matrixed.** Because the bundle is
   the publish source, it has to start cleanly on every Node version the
   package supports (`engines.node >= 18`). The job runs `npm run build +
   shebang count + node --check + --version + bundle size test` on Node
   18/20/22. Adding a new supported Node version means adding it to the
   matrix; making the job advisory again means end-users on some supported
   Node version can install a broken CLI without CI catching it.

## Related tests

- `tests/version.test.ts` — asserts shebang presence and `--version` parity
  with `package.json`.
- `tests/build/` — esbuild bundle guards (shebang count, `node --check`,
  size budget).
- `scripts/smoke-pack-install.mjs` — the end-to-end install smoke used by
  both the `pre-push` hook and the CI / publish workflows.
