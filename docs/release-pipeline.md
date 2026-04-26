# Release pipeline

This document describes how `@switchbot/openapi-cli` goes from commit to npm
registry, and the invariants that keep the published artifact safe.

## Single publish source: esbuild

The published artifact is **always** the esbuild bundle (`npm run build:prod`).
`npm publish` triggers `prepublishOnly`, which unconditionally runs
`npm test && npm run clean && npm run build:prod && node dist/index.js --version`
right before uploading the tarball — so the bundle is the only thing that can
ship.

| Script | Tool | Output shape | Role |
|---|---|---|---|
| `npm run build:prod` | `esbuild` | Single-file `dist/index.js`, deps inlined | **Publish source** — what ships to npm |
| `npm run build` | `tsc` | Per-file `dist/*.js` mirroring `src/` | Local dev only — type check, source maps, fast iteration |

Both builders end by running `scripts/copy-assets.mjs`, which:

1. Copies policy JSON Schema assets into `dist/policy/`.
2. Injects `#!/usr/bin/env node` into `dist/index.js` if missing.
3. Sets `0o755` on `dist/index.js` (best-effort on filesystems that ignore POSIX modes).

Steps 2 and 3 make the file directly executable through the `switchbot` bin
entry. `tests/version.test.ts` contains a regression guard that fails the suite
if the shebang goes missing.

`npm pack` follows `"files": ["dist", "README.md", "LICENSE"]` in `package.json`,
so whatever ends up in `dist/` when `npm pack` runs is what ships.

## Gates before `npm publish`

```
git commit ──▶ pre-commit hook ─── verify:pre-commit
                                   (build:prod + tests/version.test.ts)

git push   ──▶ pre-push hook  ──── verify:pre-push
                                   (build:prod + version test +
                                    smoke:pack-install)

open PR    ──▶ ci.yml ──────────── docs-lint
                                   test matrix (Node 18/20/22)
                                   bundle-smoke (advisory)
                                   offline-smoke (size budgets)
                                   pack-install-smoke  (esbuild, matches publish)
                                   policy-schema-sync

merge PR   ──▶ main

release    ──▶ publish.yml ─────── 1. npm ci
                                   2. npm run build:prod     (esbuild)
                                   3. npm test
                                   4. tag == package.json version
                                   5. npm run smoke:pack-install  ◀── last gate
                                   6. npm publish --tag next
                                      └── prepublishOnly: clean + build:prod + --version
                                          (same builder as step 2 — no artifact swap)
```

Because step 2 and `prepublishOnly` use the same `build:prod` script, the
tarball that `smoke:pack-install` validates in step 5 is byte-identical to the
tarball `npm publish` uploads in step 6. No artifact swap happens in between.

The critical pre-publish gate is step 5 of `publish.yml`. It runs
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

1. **One publish source — always the esbuild bundle.** `publish.yml` step 2
   must run `npm run build:prod`, and `prepublishOnly` must also run
   `build:prod`. If these two ever diverge, the smoke test will validate a
   different artifact than what actually ships.

2. **`publish.yml` must run `smoke:pack-install` before `npm publish`.** If
   this gate is removed or skipped, a broken tarball can reach the registry.

3. **Auto-deprecate must never fire on `live_smoke` failure.** Live smoke
   depends on real SwitchBot API availability and valid credentials; a transient
   outage should not deprecate a working package. Only `install_package` and
   `offline_smoke` failures justify an automatic deprecation.

4. **`copy-assets.mjs` must run on every build path.** Both `build` and
   `build:prod` chain into it. It is the single place where the shebang and
   exec bit are enforced. Moving that logic elsewhere — or adding a third build
   path that skips it — will break npm bin execution.

## Known gaps

- **`bundle-smoke` is advisory (`continue-on-error: true`).** Since the bundle
  is now the publish source, this job should become blocking once the tracked
  Node 22 CJS interop issue is resolved. Until then, the pre-publish smoke and
  the post-publish `npm-published-smoke.yml` workflow provide coverage.

- **The `test` matrix runs `npm run build` (tsc), not `build:prod`.** This
  verifies that the source compiles under Node 18/20/22, but does not exercise
  the esbuild bundle on all three. The `pack-install-smoke` job covers the
  bundle on Node 20 only. If end-user Node 22 runtime behavior with the bundle
  matters, add a bundle-aware matrix job in a follow-up.

## Related tests

- `tests/version.test.ts` — asserts shebang presence and `--version` parity with
  `package.json`.
- `tests/build/` — esbuild bundle guards (shebang count, `node --check`, size
  budget).
- `scripts/smoke-pack-install.mjs` — the end-to-end install smoke used by both
  the `pre-push` hook and the CI / publish workflows.
