# Design: Monorepo Migration — Absorbing `codex-plugin` and `openclaw-skill`

**Date:** 2026-05-23
**Status:** Draft (pending review)
**Scope:** switchbot-openapi-cli + sibling repo `openclaw-switchbot-skill`

---

## Problem

Two SwitchBot agent integration packages live in a sibling repo today:

- `@cly-org/switchbot-codex-plugin` — Codex CLI plugin (≈ 500 LoC)
- `@cly-org/switchbot-openclaw-skill` — OpenClaw skill (≈ 500 LoC)

Both are thin shells over this CLI's MCP server and `install --agent <x>` routing. Their coupling to the CLI is structural, not philosophical:

- `peerDependencies: { "@switchbot/openapi-cli": ">=3.7.1" }` — version locked
- CLI hardcodes `path.join(npmRoot, '@cly-org', 'switchbot-codex-plugin')` in `src/install/codex-checks.ts`
- The two plugins share `lib/error-messages.js` (de-facto monorepo today)
- `README.md` already documents installing both (`npm install -g @switchbot/openapi-cli @cly-org/switchbot-codex-plugin`)

Three concrete consequences of the current split:

1. **README points at vapor**: `@cly-org/switchbot-codex-plugin` is not published to npm. The installation instructions documented in this PR cannot succeed.
2. **No end-to-end testing**: CLI changes its MCP API → plugin breaks. Cross-repo CI doesn't catch this until manual sync.
3. **Cross-repo PR coordination tax**: every CLI surface change that affects plugins needs paired PRs in two repos.

The sibling repo was a verification-stage experiment. There are no users, governance is unified under OpenWonderLabs (chenliuyun is a member), and there is no migration cost to renaming packages.

---

## Goal

Consolidate all three packages into this repository as an npm workspaces monorepo, rename the `@cly-org/*` packages to `@switchbot/*`, and update the CLI + README to reference the new names.

---

## Non-Goals

- Moving the existing CLI source into `packages/cli/`. The CLI stays at the repo root.
- Preserving the `@cly-org/*` package names as aliases / re-exports. No transition period.
- Lock-step versioning across CLI and plugins. Each package keeps its own version.
- Migrating sibling repo git history beyond what `git subtree`/`git filter-repo` produces in PR #1 (decision deferred — see Prerequisites).

---

## Decision: Hybrid Monorepo (CLI at root, plugins under `packages/`)

```
switchbot-openapi-cli/
├── src/                          ← existing CLI source, unchanged
├── package.json                  ← add "workspaces": ["packages/*"]
├── packages/
│   ├── codex-plugin/             ← PR #1
│   ├── openclaw-skill/           ← PR #2
│   └── shared/                   ← PR #2 (private, internal-only)
├── tests/
├── docs/
└── ... (unchanged)
```

### Why hybrid (not `packages/cli/`)?

A pure monorepo (CLI also under `packages/`) would touch every import path, the esbuild config, `smoke:pack-install`, `verify:release`, and every GitHub Action. The CLI is ≈ 30k LoC; plugins are ≈ 500 LoC each. Risk asymmetry says: leave the dominant package in place, scaffold workspaces around it. Reversible later if the structure grows asymmetric.

npm workspaces handle root + `packages/*` coexistence natively.

---

## Implementation: Three Sequential PRs

### PR #1 — Enable workspaces, import `codex-plugin`

**Branch:** `feat/monorepo-codex-plugin`
**Depends on:** none (assumes `feat/codex-commands` already merged)
**Goal:** Repo runs as a monorepo. `codex-plugin` builds, tests, packs from `packages/codex-plugin/` under the `@switchbot/codex-plugin` name. CLI resolves the new path. README install command works (against a locally-packed tarball).

#### Changes

| Category | File(s) | Operation |
|---|---|---|
| Workspaces | `package.json` (root) | Add `"workspaces": ["packages/*"]`. **Do not change** the existing `test` / `typecheck` / `build` / `smoke:pack-install` / `verify:*` scripts (root CLI is not under `packages/*`, those scripts continue to target the root package only). |
| Workspace-aware aggregates | `package.json` (root, new scripts) | Add four new scripts: `"test:workspaces": "npm test --workspaces --if-present"`, `"test:all": "npm test && npm run test:workspaces"`, `"typecheck:workspaces": "npm run typecheck --workspaces --if-present"`, `"typecheck:all": "npm run typecheck && npm run typecheck:workspaces"`. The existing `npm test` and `npm run typecheck` keep their current scope (root only); CI and the verification matrix call `:all`. |
| Plugin source | `packages/codex-plugin/**` | Import 19 files from sibling repo. Use `git subtree add` if history is preserved (see Prerequisites). |
| Package rename | `packages/codex-plugin/package.json` | `name: "@switchbot/codex-plugin"`, `version: "0.1.0"` (new scope, version reset), `peerDependencies: { "@switchbot/openapi-cli": "workspace:*" }`, `repository`/`homepage` → this repo. Add `scripts.test` and `scripts.typecheck` so the new aggregate scripts find it. |
| CLI hardcoded path | `src/install/codex-checks.ts` | `path.join(npmRoot, '@cly-org', 'switchbot-codex-plugin')` → `path.join(npmRoot, '@switchbot', 'codex-plugin')` (in `resolveCodexPackageRoot()`) |
| Doctor warning text | `src/install/codex-checks.ts` (`checkCodexPluginNpm`, `checkCodexPluginRegistered`) | `npm install -g @cly-org/switchbot-codex-plugin` → `npm install -g @switchbot/codex-plugin` in repair recipes |
| Test expectations | `tests/install/codex-checks.test.ts` | Two `expect(msg).toContain(...)` strings updated. **Plus**: `pluginId` default value changes — `resolvePluginId` derives from dirname, so `switchbot@switchbot-codex-plugin` → `switchbot@codex-plugin`. Update all assertions. |
| Test expectations | `tests/commands/codex.test.ts` | Same plugin-id propagation. |
| Capabilities meta | `src/commands/capabilities.ts` (`COMMAND_META` is unchanged; `codex doctor`/`codex repair`/`codex setup` already registered) | No changes needed. |
| README | `README.md` | Replace every `@cly-org/switchbot-codex-plugin` with `@switchbot/codex-plugin`. |
| CI — test job | `.github/workflows/ci.yml` (the `test` job at line 35) | Replace `npm test` with `npm run test:all`; replace `npm run typecheck` with `npm run typecheck:all` if/when typecheck appears in CI. (No new job, no matrix expansion — same job runs both packages now.) |
| Smoke test | `scripts/smoke-pack-install.mjs` | No change required for PR #1 — it packs and installs the root CLI only. Plugin smoke deferred to PR #3. |

#### Plugin id change

`resolvePluginId(pluginRoot)` (in `src/install/codex-checks.ts`) returns `${name}@${path.basename(pluginRoot)}`. With the directory rename (`switchbot-codex-plugin` → `codex-plugin`), the default plugin id changes:

- Before: `switchbot@switchbot-codex-plugin`
- After: `switchbot@codex-plugin`

Every test asserting the old id needs updating. Since there are no users, no `codex plugin remove` migration is required.

#### Verification (PR #1)

1. `npm install` at root creates `node_modules/@switchbot/codex-plugin` symlinked to `packages/codex-plugin/`.
2. `npm run test:all` passes the existing 2715 CLI tests **and** any plugin tests imported from sibling.
3. `npm run typecheck:all` passes both packages.
4. `npm pack -w packages/codex-plugin` produces a valid tarball.
5. **Hard check — `workspace:*` rewrite at pack time**: extract the plugin tarball produced in step 4 (`tar -xzf` into a temp dir), open the bundled `package.json`, and confirm `peerDependencies["@switchbot/openapi-cli"]` is **not** the literal string `"workspace:*"` but a concrete semver range (npm rewrites it to a version on `npm pack` / `npm publish`). If it is still `"workspace:*"` the consumer install will fail; this is a hard blocker, not a risk.
6. `grep -ri "@cly-org" --include="*.ts" --include="*.md" --include="*.json" --include="*.yml"` returns zero hits (other than CHANGELOG history if any).
7. Manual: on a fresh machine, `npm install -g <root-tarball> <plugin-tarball>` then `switchbot install --agent codex` registers the plugin successfully.

#### Commit granularity (within the PR)

```
feat(monorepo): enable npm workspaces, scaffold packages/ dir
chore(scripts): add workspace-aware test:all and typecheck:all aggregates
feat(codex-plugin): import codex-plugin sources to packages/codex-plugin
refactor(codex-plugin): rename package to @switchbot/codex-plugin
refactor(install): update CLI to resolve @switchbot/codex-plugin path
docs(readme): switch codex install command to @switchbot/codex-plugin
ci: switch test job to npm run test:all to cover packages/*
```

---

### PR #2 — Import `openclaw-skill`, extract shared code

**Branch:** `feat/monorepo-openclaw-skill`
**Depends on:** PR #1 merged
**Goal:** OpenClaw skill lives at `packages/openclaw-skill/` under `@switchbot/openclaw-skill`. Both plugins consume `error-messages` and any other duplicated utilities from `packages/shared/`.

#### Changes

| Category | File(s) | Operation |
|---|---|---|
| Skill source | `packages/openclaw-skill/**` | Import from sibling repo. |
| Package rename | `packages/openclaw-skill/package.json` | `name: "@switchbot/openclaw-skill"`, `version: "0.1.0"`, repository/homepage → this repo. Keep existing peerDependencies (none on CLI today, verify). |
| Shared package | `packages/shared/package.json` | `name: "@switchbot/agent-shared"`, `"private": true`, exports `lib/error-messages.js` and any other duplicated utilities. |
| Shared sources | `packages/shared/lib/error-messages.js` (and friends) | Move from one of the plugins; the other plugin's copy is deleted. |
| Plugin imports | `packages/codex-plugin/lib/error-messages.js` | Delete; consumers `import { ... } from '@switchbot/agent-shared'`. |
| Plugin imports | `packages/openclaw-skill/lib/error-messages.js` | Same. |
| **Cross-repo CI dependency** | `.github/workflows/ci.yml` (the `policy-schema-sync` job at line 149) | The job currently fetches `examples/policy.schema.json` from `OpenWonderLabs/openclaw-switchbot-skill` over raw.githubusercontent.com and diffs it against `src/policy/schema/v0.2.json`. Once openclaw-skill lives in `packages/openclaw-skill/` this becomes meaningless. **Replace** the URL fetch with a local `diff -u packages/openclaw-skill/examples/policy.schema.json src/policy/schema/v0.2.json` (or wherever the skill keeps its mirrored schema after import). If the skill drops the mirrored schema entirely (it can just import the CLI source), **delete** the job. Decision deferred to the PR but the job must not remain in its current form. |
| README | Add a short "OpenClaw skill" subsection with `npm install -g @switchbot/openclaw-skill` (or the link-based flow if that is how the skill installs). |

#### Open question: bundling vs publishing `@switchbot/agent-shared`

`@switchbot/agent-shared` is `private: true`, but two **public** plugins depend on it. At publish time this fails — npm won't publish a package that depends on a private one.

Two options:

- **A. Bundle at pack time** (preferred): plugin build step inlines `@switchbot/agent-shared` via esbuild bundling, so the published tarball has no runtime dependency on it. Shared package stays private.
- **B. Publish `@switchbot/agent-shared` as public**: simpler, but adds a third public package surface that consumers don't need to know about.

**Recommendation: A.** The shared module is small, internal, and not part of the plugin's public API. Bundling avoids leaking implementation details. Add an esbuild step (or tsup) to each plugin's `prepack` script.

#### Verification (PR #2)

1. `npm install` + `npm test` green.
2. Both plugins resolve `@switchbot/agent-shared` via workspaces symlink.
3. `npm pack -w packages/openclaw-skill` and `-w packages/codex-plugin` produce valid tarballs.
4. **Critical**: extract a packed plugin tarball and confirm `node_modules/` is empty / `package.json#dependencies` does not list `@switchbot/agent-shared` — i.e. bundling worked.

#### Commit granularity

```
feat(openclaw-skill): import openclaw-skill sources to packages/
refactor(openclaw-skill): rename package to @switchbot/openclaw-skill
feat(shared): extract error-messages to packages/shared
refactor(plugins): consume shared from @switchbot/agent-shared
build(plugins): bundle @switchbot/agent-shared at pack time
ci: switch policy-schema-sync to local diff (or delete if obsolete)
docs(readme): document openclaw-skill installation
```

---

### PR #3 — Publish matrix + sibling repo deprecation

**Branch:** `chore/monorepo-publish-flow`
**Depends on:** PR #2 merged
**Goal:** A single GitHub Release triggers `publish.yml` to push **all three** packages to npm; `npm-published-smoke.yml` verifies and promotes them; sibling repo carries an archive notice pointing to this repo.

#### Background — actual publish topology

The current publish + smoke flow is implemented entirely in GitHub Actions (no local `release` script):

- `.github/workflows/publish.yml` — fires on `release: [published]`. Runs `npm ci` → `npm run build` → `npm test` → version-tag check → `npm run smoke:pack-install` → `npm publish --tag next --provenance --access public` (line 34). **Publishes the root CLI only.** No per-workspace publish today.
- `.github/workflows/npm-published-smoke.yml` — fires on `workflow_run: ['Publish to npm']: [completed]`. Waits for `@switchbot/openapi-cli@<version>` to appear on dist-tag `next` (line 76, 88), installs it in a temp project, runs offline smoke (`switchbot --version`, `--help`, `schema export`, `capabilities`) and live smoke (`doctor`, `devices list`), then promotes to `latest` via `npm dist-tag add` (line 136) or deprecates on failure (line 152). **Every step is hardcoded to `@switchbot/openapi-cli`.** No matrix, no plugin awareness.

PR #3 must update **both** workflows. The single-package assumption is everywhere.

#### Changes

| Category | File(s) | Operation |
|---|---|---|
| Publish workflow — root CLI step | `.github/workflows/publish.yml` line 34 | **Keep** the existing `npm publish --tag next --provenance --access public` step. The root CLI is **not** under `packages/*`; it is the root package. Do not change this line into `npm publish -w @switchbot/openapi-cli ...` — that form would resolve to nothing. |
| Publish workflow — new plugin steps | `.github/workflows/publish.yml` (after line 34) | Add two steps: `npm publish -w packages/codex-plugin --tag next --provenance --access public` and `npm publish -w packages/openclaw-skill --tag next --provenance --access public`. Both inherit `NODE_AUTH_TOKEN` from the same `env`. |
| Publish workflow — version verification | `.github/workflows/publish.yml` lines 23-30 | The current `Verify tag matches package.json version` step compares `GITHUB_REF_NAME` against the **root** `package.json#version`. Since plugins have independent versions, we cannot use the git tag for plugin version verification. Decision: tag is authoritative for the **root CLI version only**; plugin versions are taken from their own `package.json` at the time of release. Add a new step `Show resolved versions` that prints all three `package.json#version` values into the workflow log so the release notes can quote them. Do **not** add a tag-vs-plugin-version check — there is no shared tag for plugins. |
| Publish workflow — pre-publish smoke | `.github/workflows/publish.yml` line 32 (`npm run smoke:pack-install`) | Keep — root CLI smoke is unchanged. Add **two** new steps after it: `npm pack -w packages/codex-plugin` and `npm pack -w packages/openclaw-skill`, each followed by a tarball-extraction check that confirms `peerDependencies["@switchbot/openapi-cli"]` resolved away from `workspace:*` (same gate as PR #1 hard check, but here in CI). |
| Smoke workflow — package matrix | `.github/workflows/npm-published-smoke.yml` | **Restructure** the `smoke` job into a matrix over the three packages. The matrix entry decides: package name, smoke commands, whether the package gets promoted on success. Concretely: |
| Smoke workflow — root CLI matrix entry | (same file) | `package: @switchbot/openapi-cli`, smoke = current offline + live commands (lines 106-128), promote = yes (line 130 keeps as-is for this entry). |
| Smoke workflow — plugin matrix entries | (same file) | `package: @switchbot/codex-plugin` and `package: @switchbot/openclaw-skill`. Smoke commands per plugin: install in temp project, confirm `package.json#peerDependencies["@switchbot/openapi-cli"]` is a concrete range (not `workspace:*`), confirm bin entries (`switchbot-codex-auth`, `switchbot-codex-install`) are executable. **No live smoke** for plugins — they need a working CLI install + Codex CLI on PATH; the runner has neither and the value-add is low. Promote on success: yes (same `dist-tag add` pattern). Deprecate on failure: yes. |
| Smoke workflow — wait step generalization | `.github/workflows/npm-published-smoke.yml` lines 69-93 | The wait loop is keyed on `@switchbot/openapi-cli`. Refactor to use the matrix `package` variable everywhere; the `next` dist-tag gate works the same for all three. |
| Smoke workflow — gate selection | `.github/workflows/npm-published-smoke.yml` lines 64-67 (`Resolve current latest dist-tag`) | Generalize to `npm view ${{ matrix.package }} dist-tags.latest`. |
| Sibling repo (`openclaw-switchbot-skill`) | `README.md` (sibling) | Add deprecation notice at top: "This repository has been merged into [switchbot-openapi-cli](...). Future development happens there. Existing tags are preserved for history." |
| Sibling repo | GitHub settings | Mark as archived (Settings → Danger Zone → Archive). |
| CHANGELOG | `CHANGELOG.md` (this repo) | Add an entry for the monorepo absorption with the `@cly-org/*` → `@switchbot/*` rename mapping. |

#### Versioning model recap

- Root CLI: version still lives in root `package.json#version`. Git tag (`v3.7.x`) authoritative for this package. `publish.yml`'s tag-check still applies to the root publish step.
- Plugins: independent versions in `packages/*/package.json#version`. **Not** keyed off the git tag. A release that bumps only the CLI version skips re-publishing plugins by virtue of npm refusing to re-publish an unchanged version (`npm publish` fails fast on duplicate); add `if: ` guards if the noise is unwanted.
- Practical operating mode: bump whichever packages changed since the last release in their respective `package.json`, cut a single GitHub Release tagged with the root CLI version, let `publish.yml` push everything that has a new version. npm rejects duplicates harmlessly.

#### Verification (PR #3)

1. Cut a **dry-run** release (e.g. tag `v3.7.99-dryrun` on a throwaway branch, then delete) and confirm:
   - `publish.yml` runs all three publish steps.
   - Each plugin tarball passes the `workspace:*` gate.
   - All three packages appear on dist-tag `next` within the timeout.
   - `npm-published-smoke.yml` runs the matrix; root CLI passes offline + live; plugins pass their tarball-shape checks.
   - `dist-tag add ... latest` is invoked for all three.
2. Delete the dry-run versions immediately after via `npm unpublish` (within npm's 72-hour window) and remove the throwaway tag.
3. Sibling repo README renders the deprecation notice on GitHub.
4. `npm view @cly-org/switchbot-codex-plugin` still 404s (we never published the old name).
5. `npm view @switchbot/codex-plugin` and `npm view @switchbot/openclaw-skill` show the new packages.

#### Commit granularity

```
ci(publish): publish CLI + codex-plugin + openclaw-skill from one workflow
ci(smoke): convert npm-published-smoke to per-package matrix
ci(publish): add post-pack workspace:* rewrite gate for plugin tarballs
docs(changelog): document monorepo absorption and @cly-org→@switchbot rename
```

---

## Prerequisites (Block Before Starting PR #1)

### P1 — Confirm `@switchbot` npm scope ownership

Run `npm view @switchbot/openapi-cli`. If the scope is owned by OpenWonderLabs and the current publisher account has push rights, proceed. If `@switchbot` is taken by an unrelated party, choose a fallback:

- `@switchbot-cli/openapi-cli` + `@switchbot-cli/codex-plugin`
- `@switchbot-openapi/cli` + `@switchbot-openapi/codex-plugin`

Whichever is chosen, the rename is a global search-replace, applied uniformly across all three PRs.

### P2 — Decide git history preservation strategy

Two options for moving plugin sources from sibling repo:

- **A. `git subtree add` / `git filter-repo`**: preserves per-file `git blame` and commit history. Costs ≈ 1 hour of one-time setup, produces a cleaner archaeology trail.
- **B. Plain copy**: drops history. Faster (≈ 5 min), acceptable given the sibling was verification-stage and most recent commits are this week's work.

**Recommendation: A** for `codex-plugin` (some of the recent debugging context is valuable), **B** for `openclaw-skill` (less mature, less diagnostic history worth carrying).

This is reversible — even option B can be supplemented later by importing the sibling repo's history as a separate branch for archaeological lookup.

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `@switchbot` scope unavailable | Low (P1 verifies upfront) | Medium (mass rename) | P1 — verify before any PR |
| Hidden `@cly-org/...` reference missed in code/docs | Medium | Low (test failure or doctor warning shows the wrong recipe) | PR #1 verification step #6: full-tree grep |
| Plugin id change breaks existing user installs | Zero (no users) | N/A | None needed |
| Bundling `@switchbot/agent-shared` regresses | Medium | Medium (runtime require fails) | PR #2 verification step #4: inspect packed tarball |
| Cross-repo PR coordination during the transition | Low (PRs land in 2-3 days end-to-end) | Low | Don't touch sibling repo source until PR #3; freeze sibling repo on day 1 |
| Plugin publish step in `publish.yml` fails for the first release while CLI succeeds | Medium (new CI path) | Medium (npm has CLI but not plugin; users hit warn-state in `doctor`) | Plugin steps run **after** CLI publish in `publish.yml`; if plugin step fails, CLI is already on `next` (not yet promoted to `latest`); fix plugin issue, re-run workflow, then `npm-published-smoke` promotes all three together. The `workspace:*` rewrite gate (added in PR #1 verification + replicated in PR #3 publish workflow) catches the most likely failure mode before it ships. |

---

## Out of Scope

- Moving the CLI itself into `packages/cli/`.
- Adding new agent integrations (Cursor, Continue, etc.) — covered by future plans, not this migration.
- Changing the CLI's public API surface as part of the move — pure mechanical relocation.
- Republishing existing `@cly-org/*` packages with a deprecation notice on npm. Since they are unpublished, no action needed.
- Lock-step versioning. Each package keeps its own version.

---

## Decision Log

- **2026-05-23**: Hybrid monorepo (CLI at root) chosen over pure monorepo (`packages/cli/`) due to risk asymmetry.
- **2026-05-23**: Independent versioning preferred over lock-step. CLI is `3.x`, plugins start at `0.1.0`.
- **2026-05-23**: `@switchbot/agent-shared` will be private + bundled (option A), not published.
- **2026-05-23**: No transition period. `@cly-org/*` names are abandoned outright (sibling repo is verification-stage with no users).
- **2026-05-23 (review pass)**: Root scripts (`test`, `typecheck`) keep root-only scope; new `test:all` / `typecheck:all` aggregates added in PR #1 to cover `packages/*`. Avoids changing pre-commit/pre-push hook timings on day one.
- **2026-05-23 (review pass)**: Publish entry point is `.github/workflows/publish.yml`, not a `scripts/release.*` file (the latter does not exist). Root CLI publish stays as `npm publish` (root package, no `-w`); plugins use `npm publish -w packages/<plugin>`.
- **2026-05-23 (review pass)**: `npm-published-smoke.yml` converts to a per-package matrix. Plugins get tarball-shape smoke (peerDeps resolved, bin entries executable) but **no live smoke** — the runner has no Codex CLI installed. Plugins still go through the `next` → `latest` promote gate.
- **2026-05-23 (review pass)**: `ci.yml`'s `policy-schema-sync` (cross-repo URL fetch) becomes a local `diff` once openclaw-skill moves into `packages/openclaw-skill/` (or is deleted if the skill drops the mirrored schema). Lands in PR #2.
- **2026-05-23 (review pass)**: `workspace:*` peerDep rewrite check promoted from a Risk row to a hard verification step in PR #1 (and re-asserted in PR #3's publish workflow). It is the single highest-leverage failure mode of this migration; demoting it to a risk row was a misjudgment.

---

## Estimated Effort

| PR | Wall-clock estimate | Risk profile |
|---|---|---|
| PR #1 | ~ half day | Medium (path hardcoding, test assertion sweep) |
| PR #2 | ~ half day | Low (pattern established by PR #1) |
| PR #3 | ~ 1-2 hours | Low (scripts + docs) |

End-to-end: ~ 2 days of focused work, 3 PRs, all on top of the merged `feat/codex-commands` branch.
