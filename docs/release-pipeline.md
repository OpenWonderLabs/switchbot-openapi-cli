# Release pipeline

This document describes how `@switchbot/openapi-cli` goes from commit to npm
registry, and the invariants that keep the published artifact safe.

## Single publish source

There is exactly one way to produce the release artifact:

```text
npm run build          →  node scripts/build.mjs
```

Every script on the release path — `prepublishOnly`, `verify:pre-commit`,
`verify:pre-push`, `publish.yml`, `ci.yml/bundle-smoke`, `ci.yml/pack-install-smoke` —
calls `npm run build` by name. No job re-implements any of the steps, and no
other script writes to `dist/`.

### The five stages of `scripts/build.mjs`

| # | Stage | Script | Responsibility |
| --- | --- | --- | --- |
| 1 | clean | inline | remove `dist/` so nothing stale leaks into the tarball |
| 2 | typecheck | `tsc --noEmit` | all types must compile before we bundle |
| 3 | bundle | `scripts/bundle.mjs` | esbuild produces the single-file `dist/index.js` (shebang via `banner.js`) |
| 4 | copy-assets | `scripts/copy-assets.mjs` | copy `src/policy/{schema,examples}` → `dist/policy/...` |
| 5 | ensure-binary | `scripts/ensure-binary.mjs` | assert the shebang is present and `chmod 0755` on `dist/index.js` |

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

```text
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
                                   2. verify:release-gate (build, tests, pack and host-independent smokes)
                                   3. verify:release (built CLI/runtime documentation invariants)
                                   4. root tag == package.json version
                                   5. resolve and record five exact candidate outcomes
                                   6. publish only new exact versions to @next
                                      └── prepublishOnly runs before each npm publication
```

The pre-publish artifact gate runs
`scripts/smoke-pack-install.mjs`, which:

- Runs `npm pack` on the freshly-built tarball.
- Installs the tarball into a throwaway temp project.
- Executes `node_modules/.bin/switchbot --version` and compares the output to
  `package.json.version`.

If the shebang is missing, the bin entry is not marked executable, the version
drifts, or any deps are missing — the CLI fails to run and the smoke test exits
non-zero. `npm publish` does not run.

Claude metadata is also release-gated: the npm package version, its marketplace,
the embedded plugin manifest, and the root GitHub marketplace must agree.
`verify:release-gate` invokes `verify:release` after the build; the Claude package's
`prepack` guard independently rejects stale packaged metadata.

Codex and Claude pack-install smokes exercise installed manual credential helpers
with isolated dummy credentials. Codex checks both root and nested manifests for
a `hooks` key and rejects either layout's `.codex-plugin/hooks.json`. The Codex
temporary-prefix smoke registers and removes the exact installed package in an
isolated host home when Codex is available; `--require-host` makes absence fatal.

## Candidate publication, verification, and promotion

`publish.yml` is a candidate-producing workflow. It does not advance `latest`.
For a release tag whose root CLI version is `3.9.0`, it independently resolves
all five exact package versions: `@switchbot/openapi-cli@3.9.0` and
`@switchbot/{codex-plugin,openclaw-skill,claude-code-plugin,gemini-extension}@0.2.0`.
Plugin versions are independent of the root tag and are read from each package
manifest.

For every exact package version, the workflow records one authoritative outcome
in the `release-candidate-outcomes` artifact:

- `published` — the version was newly published with `npm publish --tag next`;
- `already-published` — the exact version was already in the registry and was
  deliberately not published again;
- `failed` — authentication, registry probing, or publication failed; or
- `dry-run` — a dispatch dry run recorded no publication.

Unexpected registry responses fail closed; only an npm not-found response may
lead to a new publication. Missing `NPM_TOKEN` is an explicit failure. A
failed or dry-run outcome prevents the publication workflow from succeeding,
so it cannot start promotion.

`npm-published-smoke.yml` consumes that artifact rather than treating registry
existence as evidence of this run. It waits for and installs the **exact
version** for every newly published candidate; an exact version found after
this run is never converted into a smoke skip. Independently
already-published packages remain distinct in the outcome artifact and are
not promoted again.

Recovery limitation: after a partially successful publication, a rerun can
classify a version stranded on `next` as `already-published`, so it will not
automatically advance to `latest`. A GitHub Actions rerun retains the original
release event, but does not change that outcome rule. Inspect the original
outcomes and exact-version evidence before recovery; never relabel outcomes or
bypass host gates merely to advance a tag.

The candidate smoke gates verify the exact installed tarball. CLI candidates
run offline checks; plugins run tarball/peer-dependency checks. Required hosts
then execute a local readonly MCP call. No gate uses real SwitchBot credentials,
calls the cloud API, or sends a device-control command.

After those gates, `required-hosts` uses Node 24 and installs these pinned host
CLIs in an isolated environment:

| Host | Pinned version | Release-gate status |
| --- | ---: | --- |
| Codex | 0.162.1 | required exact-candidate load/readonly MCP invocation gate |
| Claude Code | 2.1.238 | required exact-candidate load/readonly MCP invocation gate |
| Gemini CLI | 0.44.1 | required exact-candidate load/readonly MCP invocation gate |
| OpenClaw | 2026.10.2 | required Claude-bundle load/readonly MCP invocation gate |

The gate installs the exact published CLI and all four exact plugin tarballs,
including a plugin already published before the root CLI candidate. It passes
the isolated candidate to `smoke-host-runtime.mjs`; it does not validate an
unbuilt checkout or an npm `latest` dependency. Host evidence records the
package, CLI, host, OS, and result versions. Unsupported hosts, missing hosts,
missing npm authentication, or unsuccessful installation/load/MCP-tool
results are release-gate failures, not optional skips. Each host must execute
`device_history(mode="raw")` and return the concrete `devices` result shape;
catalog-only evidence cannot create promotion gates. Evidence CLI/plugin
versions must match every exact publication outcome.

Runtime gates always strip user SwitchBot credentials and inject explicitly
dummy values into isolated state. The concrete readonly call is
`device_history(mode="raw")`; it reads local storage, not cloud private data.
This is plugin/protocol evidence, not an account-authentication claim.
The required-host job is Linux/Ubuntu only. A separate native bootstrap CI
matrix covers Ubuntu, Windows and macOS; configuration alone is not proof
those Windows/macOS jobs ran.

A single promotion job runs only after candidate smoke, all required hosts,
and validated host evidence have succeeded. It re-reads the authoritative
outcomes and applies `npm dist-tag add <exact-package-version> latest` only to
entries marked `published`. The job refuses to promote when artifact,
exact-candidate, or required-host readonly evidence is absent or failed.

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

4. **Publication is candidate-first.** Every newly published root or plugin
   package uses `--tag next`; `latest` is only changed by the promotion job
   after its exact candidate has passed every required gate.

5. **Outcomes are authoritative.** The downstream smoke and promotion jobs use
   `release-candidate-outcomes`, never a bare registry-exists check, to
   distinguish a fresh publication from an independently already-published
   package.

6. **Required host evidence is blocking.** A developer may run a local host
   smoke without an installed host, but release promotion must fail on a
   missing host, unsupported host, failed isolated bootstrap, or failed local
   readonly call. Real SwitchBot accounts are not required or forwarded.

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
