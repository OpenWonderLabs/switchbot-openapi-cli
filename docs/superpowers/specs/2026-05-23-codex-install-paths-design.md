# Codex Install Paths Design

**Date:** 2026-05-23
**Status:** Approved
**Scope:** switchbot-cli (feat+codex-commands branch) + openclaw-switchbot-skill (packages/codex-plugin)

---

## Problem

Two install paths need to work end-to-end for the Codex plugin:

- **Path A** — Codex native marketplace install (user clicks "Add Plugin" in Codex UI)
- **Path B** — In-Codex conversation bootstrap (user copy-pastes from docs, or types natural language)

Path A already has an `onInstall` hook but it only runs auth and lacks CLI presence checks. Path B has no supported mechanism today: bare Codex has no SwitchBot context, and there is no authoritative single command to run after initial CLI install.

---

## Solution Overview

Introduce `switchbot codex setup` as the single authoritative post-CLI-install command, update the plugin's `AGENTS.md` to serve as both the loaded skill context and the paste-able bootstrap prompt, update `README.md` for the copy-paste path, and harden the `onInstall` hook to call setup non-interactively.

---

## Component 1: `switchbot codex setup` subcommand

**File:** `src/commands/codex.ts` (new subcommand registered in `registerCodexCommand`)

### Purpose

Full install from a known-CLI-present state: detect missing switchbot CLI → install if needed → detect missing Codex plugin package → install if needed → register plugin → auth → verify. Serves as the single entry point for both new users (via `npx @switchbot/openapi-cli codex setup`) and existing users (re-setup / repair).

Differs from `repair` in that it skips `remove-plugin` and adds package installation steps.

### Steps

| Name | skippable | Description |
|---|---|---|
| `check-codex-cli` | no | Verify `codex` is on PATH. Always written to outcomes. |
| `install-switchbot-cli` | yes | `npm list -g --json --depth=0 @switchbot/openapi-cli` → install if absent |
| `install-codex-plugin` | yes | `npm list -g --json --depth=0 @switchbot/codex-plugin` → install if absent |
| `register-plugin` | no | `resolveCodexPackageRoot` + `runCodexPluginRegistration` (marketplace add + plugin add) |
| `auth` | yes | Check credentials; spawn CLI auth login if missing (non-interactive under `--yes`) |
| `doctor-verify` | no | `runDoctorChecks(['node','path','credentials','mcp'])` + `checkCodexCli()` + `checkCodexPluginNpm()` + `checkCodexPluginRegistered()` (4 base + 3 Codex = 7 checks) |

### `--skip` contract

Allowed values: `install-switchbot-cli`, `install-codex-plugin`, `auth` only.

Any other name passed to `--skip` → exit 2 with message:
```
invalid --skip: '<name>' is not skippable
```

### `check-codex-cli` preflight

- Always writes outcome to `outcomes[]` before stopping
- On failure: exit 2 (preflight failure)
- `--json` output still includes the outcome entry

### `install-switchbot-cli` detection

```sh
npm list -g --json --depth=0 @switchbot/openapi-cli
```

- Parse JSON; absent `dependencies['@switchbot/openapi-cli']` → treat as not installed
- JSON parse failure → treat as not installed (npm itself may be broken, but attempt install anyway)
- On install: `npm install -g @switchbot/openapi-cli@latest`
- Install failure → record `failed`, continue (non-preflight)

### `install-codex-plugin` detection

```sh
npm list -g --json --depth=0 @switchbot/codex-plugin
```

- Parse JSON; absent `dependencies['@switchbot/codex-plugin']` → treat as not installed
- JSON parse failure → treat as not installed
- On install: `npm install -g @switchbot/codex-plugin@latest`
- Install failure → record `failed`, continue (non-preflight)
- This step must run before `register-plugin`; otherwise a brand-new `npx @switchbot/openapi-cli codex setup` flow cannot resolve the package root that registration needs.

### `auth` step — exact failure shape

| Condition | Status | Output |
|---|---|---|
| Credentials present | `ok` | `credentials present` |
| Missing + `--yes` + `--json` | `failed` | `outcome.error = { reason: 'credentials-missing', hint: 'run: switchbot auth login' }` |
| Missing + `--yes` + text | `failed` | `✗ auth  credentials missing — run: switchbot auth login` |
| Missing + interactive | spawn `process.execPath [cliPath, ...(profile !== 'default' ? ['--profile', profile] : []), ...(configPath ? ['--config', configPath] : []), 'auth', 'login']`; non-zero → `failed` |

`profile` 与 `configPath` 都来自当前命令上下文（全局 `--profile` / `--config`）；与 `codex repair re-auth` 复用同一个 `buildAuthLoginArgv` 助手，A1 / B4 修订只需改一处。

Auth always spawns via `process.execPath` + known `cliPath` to inherit the correct binary and `--profile` / `--config`. Never via bare `switchbot` on PATH.

### `doctor-verify` scope

Runs (matches `codex repair doctor-verify` — same semantics across both commands):

- `runDoctorChecks(['node', 'path', 'credentials', 'mcp'])` → 4 base checks
- `checkCodexCli()` + `checkCodexPluginNpm()` + `checkCodexPluginRegistered()` → 3 Codex checks

**Total: 7 checks.** Codex integration health depends on CLI base health (PATH, credentials, MCP supervisor); a green `register-plugin` step is meaningless if any base check is red, so both `codex setup` and `codex repair` confirm the full picture before declaring success.

### Exit codes

| Condition | Code |
|---|---|
| `check-codex-cli` failed | 2 |
| Invalid `--skip` value | 2 |
| Any other step failed | 1 |
| All steps ok or skipped | 0 |

### Options

- `--yes` — Non-interactive: auth missing → `failed` with hint (no spawn)
- `--skip <names>` — Comma-separated; only skippable steps allowed
- `--dry-run` (global) — Print step list with skip annotations, no execution
- `--json` (global) — Emit `{ ok, preflightFailed, outcomes }` to stdout

### 与 `switchbot install --agent codex` 的关系

`install --agent codex` 与 `codex setup` 是同一栈的两层，通过同一个共享 helper 协作：

| 命令 | 定位 | 前置条件 | 行为 |
|---|---|---|---|
| `switchbot install --agent codex` | 底层 register-only | 用户已自行 `npm install -g @switchbot/codex-plugin` | 仅做 marketplace add + plugin add；npm 包缺失则 preflight `fail`。 |
| `switchbot codex setup` | 一键 bootstrap | 仅需 Codex CLI 已安装 | 自动 `npm install -g @switchbot/openapi-cli` / `@switchbot/codex-plugin`（若缺）+ 调用相同的注册 helper + auth + Codex 专属 doctor。 |

**实现共享：** 三处注册步骤（`install --agent codex` 的 `stepRegisterCodexPlugin`、`codex repair` 的 `repairStepRegisterPlugin`、`codex setup` 的 `register-plugin`）都**必须**调用 `src/install/codex-checks.ts` 导出的 `registerCodexPlugin()` helper，禁止各自再内联 `npm root -g` 解析、pluginId 拼接或 marketplace/plugin add 调用顺序。

---

## Component 2: AGENTS.md bootstrap section

**File:** `packages/codex-plugin/AGENTS.md`

### Purpose

Serves two roles:
1. When loaded by Codex (after marketplace install): gives Codex context to respond to natural language "install/set up SwitchBot"
2. As paste-able inline context for bare Codex sessions (copied from README bootstrap prompt)

### Content — `## Setup` section

```markdown
## Setup

When asked to install, set up, or repair the SwitchBot integration, run the
following steps in order. Stop and report the error if any step fails.

1. Bootstrap the SwitchBot CLI and Codex plugin packages:
   ```sh
   npx @switchbot/openapi-cli codex setup
   ```

2. Restart Codex so the plugin is loaded, then verify:
   ```sh
   switchbot codex doctor
   switchbot devices list
   ```
```

### Design decisions

- Step 1 covers new users (zero SwitchBot prerequisites); existing CLI users can run `switchbot codex setup` directly
- `switchbot codex setup` is the single authoritative command; AGENTS.md does not duplicate step logic
- "Restart Codex" is explicit to prevent confusion when plugin loads but skill is not yet in context
- Section name `## Setup` is intentionally broad — covers first install and repair alike

---

## Component 3: README bootstrap prompt

**File:** `packages/codex-plugin/README.md`

### New section (after Quick Start / Installation)

```markdown
## Bootstrap from a Codex conversation

If you don't have the SwitchBot CLI installed yet, paste the following block
into any Codex conversation, then say **"set up SwitchBot"**:

---

> **SwitchBot setup instructions**
>
> When asked to set up SwitchBot, run in order:
>
> 1. `npx @switchbot/openapi-cli codex setup`
> 2. Restart Codex, then confirm with `switchbot codex doctor`

---

If the SwitchBot CLI is already installed, skip the paste and run directly:

```sh
switchbot codex setup
```
```

### Design decisions

- Two clear paths: new user (paste block) vs existing user (one command)
- Paste block is a compressed version of `AGENTS.md ## Setup` — same commands, shorter prose
- Auth and policy steps are not mentioned; `switchbot codex setup` handles them internally
- No credentials or secrets appear in README

---

## Component 4: `onInstall` hook hardening

**File:** `packages/codex-plugin/bin/auth.js`

> Verified against `packages/codex-plugin/.codex-plugin/hooks.json` — `onInstall.args = ["../bin/auth.js", "--hook"]`. Pinned to this path; no fallback to `install.js`.

### Current behavior

Runs interactive auth only.

### New behavior

```
1. Check whether `switchbot` is on PATH
   → Found: run `switchbot codex setup --yes`
             exit 0 regardless of setup outcome (see rationale below)
   → Not found: print hint to stdout:
       "SwitchBot CLI not found. Run: npx @switchbot/openapi-cli codex setup"
       exit 0
```

### Rationale for always exit 0

A non-zero exit from `onInstall` causes Codex to roll back the entire plugin install. If setup fails (e.g., credentials not yet configured), the user loses the plugin and must re-add it from marketplace. It is better to complete the plugin install and let the user run `switchbot codex setup` manually. The hook's job is best-effort configuration, not a hard gate.

### Constraints

- No `npm install -g` in hook — silently installing global packages in a hook context is unsafe
- Uses `--yes` flag — hook runs without a TTY; no interactive prompts
- Spawn via `process.execPath` + known CLI path, not bare `switchbot` on PATH

---

## Invariants

1. `check-codex-cli` is the only preflight; all other failures are non-blocking to the step chain
2. `--skip` rejects non-skippable step names at parse time (exit 2), not silently
3. `doctor-verify` in `setup` only checks Codex integration, never general CLI health
4. Auth spawns via `process.execPath` to ensure consistent binary and profile inheritance
5. `onInstall` hook always exits 0 to protect the marketplace install from partial state rollback
6. AGENTS.md `## Setup` section and README bootstrap prompt reference the same commands; AGENTS.md is canonical

---

## Affected files

| Repo | File | Change |
|---|---|---|
| switchbot-cli | `src/commands/codex.ts` | Add `registerCodexSetupSubcommand` + register in `registerCodexCommand` |
| openclaw-switchbot-skill | `packages/codex-plugin/AGENTS.md` | Add `## Setup` section |
| openclaw-switchbot-skill | `packages/codex-plugin/README.md` | Add bootstrap prompt section |
| openclaw-switchbot-skill | `packages/codex-plugin/bin/auth.js` | Harden onInstall hook |

---

## Out of scope

- `switchbot codex setup` does not install `codex` CLI itself (user must install Codex before running any `switchbot codex` command)
- No `npx`-based bootstrap entry point (Approach C was evaluated and deferred)
- No changes to `switchbot codex doctor` or `switchbot codex repair` beyond the hint added in commit `c066238`
