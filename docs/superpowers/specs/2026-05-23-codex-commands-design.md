# Design: `switchbot codex` Command Group

**Date:** 2026-05-23  
**Status:** Approved  
**Scope:** switchbot-cli + openclaw-switchbot-skill (plugin deprecation)

---

## Problem

The current Codex integration requires users to know and run multiple separate commands across two distinct entry points (`switchbot-codex-install` from the plugin package, then various `switchbot` subcommands). There is no single "is my Codex setup healthy?" check, and no guided repair path when things break.

Three gaps:
1. No `switchbot install --agent codex` — users must read plugin docs to find `switchbot-codex-install`
2. No Codex-specific health checks in `switchbot doctor` (plugin registered? Codex CLI on PATH?)
3. No repair command — users must manually sequence `auth logout/login`, `doctor`, `codex plugin remove/add`

---

## Approach: Option C — Extend existing commands + thin `codex` namespace

- `switchbot install --agent codex` — extend existing install step engine (not a new command)
- `switchbot codex doctor` — thin alias over `doctor` CHECK_REGISTRY with Codex-specific section
- `switchbot codex repair` — new command, sequential repair steps without rollback chain
- `switchbot-codex-install` binary — deprecated to a one-line redirect

---

## File Layout

```
src/
  commands/
    codex.ts              # NEW: registers `codex` parent command with doctor/repair subcommands
    install.ts            # MODIFY: add 'codex' to AgentName, route to stepRegisterCodexPlugin
  install/
    default-steps.ts      # MODIFY: add stepRegisterCodexPlugin()
    codex-checks.ts       # NEW: 3 Codex-specific check functions (used only by codex doctor)
                          #      + runCodexPluginRegistration() shared utility
                          #      NOT added to global CHECK_REGISTRY
  commands/doctor.ts      # MODIFY: export Check interface, CHECK_REGISTRY, runDoctorChecks()
                          #         NO new check entries — Codex checks stay out of CHECK_REGISTRY
  program-builder.ts      # MODIFY: registerCodexCommand(program)

tests/
  commands/codex.test.ts          # NEW: codex doctor / repair integration tests
  install/codex-checks.test.ts    # NEW: unit tests for 4 Codex checks
```

---

## Section 1: `switchbot install --agent codex` (register only — not full bootstrap)

> **P0-C constraint:** This command registers an already-installed npm package with the Codex CLI. It is NOT a full one-step installer. All user-facing text (command description, `--help`, `--dry-run` output, error messages) must use "register" semantics, never "install Codex integration". The prerequisite `npm install -g @cly-org/switchbot-codex-plugin` must be stated wherever the command is documented.

### AgentName extension

`src/install/default-steps.ts` (and `install.ts`):

```typescript
export type AgentName = 'claude-code' | 'cursor' | 'copilot' | 'codex' | 'none';
```

### Step routing

`install.ts` replaces the current hardcoded `stepSymlinkSkill` with a conditional:

```typescript
const agentStep = ctx.agent === 'codex'
  ? stepRegisterCodexPlugin()
  : stepSymlinkSkill({ force });

const allSteps: InstallStep<InstallContext>[] = [
  stepPromptCredentials(),
  stepWriteKeychain(),
  stepScaffoldPolicy(),
  agentStep,
];
```

### `stepRegisterCodexPlugin` interface

Step name and description must use "register" language. Prerequisite (npm package installed globally) is enforced by preflight as a **fail** (not warn) — this step only performs plugin registration and will not be reached if the package is absent.

```typescript
// src/install/default-steps.ts
export function stepRegisterCodexPlugin(): InstallStep<InstallContext> {
  return {
    name: 'register-codex-plugin',
    description: 'Register @cly-org/switchbot-codex-plugin with the Codex CLI (marketplace add + plugin add)',
    async execute(ctx) {
      // 1. npm root -g → npmRoot; packageRoot = join(npmRoot, '@cly-org', 'switchbot-codex-plugin')
      // 2. pluginId = resolvePluginId(packageRoot)   ← shared function from codex-checks.ts
      // 3. runCodexPluginRegistration(packageRoot, pluginId)  ← throws if !ok
      // 4. ctx.codexPluginRegistered = true; ctx.codexPluginIdentifier = pluginId
    },
    async undo(ctx) {
      // best-effort: codex plugin remove <ctx.codexPluginIdentifier>
    },
  };
}
```

**`resolvePluginId(packageRoot): string` — single authoritative implementation**

Defined in `src/install/codex-checks.ts` and imported by both `default-steps.ts` (Task 3) and `codex.ts` repair step (Task 7). No duplicate implementations in any file. Logic mirrors `install.js:resolvePluginIdentifier`:

```typescript
// src/install/codex-checks.ts
export function resolvePluginId(packageRoot: string): string {
  const manifestPath = path.join(packageRoot, '.codex-plugin', 'plugin.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { name?: string };
      if (manifest.name) return `${manifest.name}@${path.basename(packageRoot)}`;
    } catch { /* fall through */ }
  }
  return `switchbot@${path.basename(packageRoot)}`;
}
```

`InstallContext` gains two optional fields:
```typescript
codexPluginRegistered?: boolean;
codexPluginIdentifier?: string;   // e.g. 'switchbot@switchbot-codex-plugin'
```

### Preflight additions

`src/install/preflight.ts` adds a codex-specific preflight check when `agent === 'codex'`:
- `codex` binary on PATH (fail if missing — user must install Codex first)
- `@cly-org/switchbot-codex-plugin` npm package installed globally (**fail** if missing — user must `npm install -g @cly-org/switchbot-codex-plugin` first; this is a register-only command)

### `--dry-run` / `--json` / rollback

All inherited from the existing `runInstall` framework — no changes required.

---

## Section 2: Codex-specific Doctor Checks

### New file: `src/install/codex-checks.ts`

Four exported check functions, each returning `Check` (the same interface used throughout `doctor.ts`):

**`checkCodexCli()`**
- Runs `which codex` (POSIX) / `where codex` (Windows)
- `ok` → `{ path, version }` (version from `codex --version` stdout)
- `fail` → hint pointing to Codex install docs

**`checkCodexPluginNpm()`**
- Runs `npm list -g --json @cly-org/switchbot-codex-plugin`
- Parses stdout to extract version and package root
- `ok` → `{ version, packageRoot }`
- `warn` → `{ message: 'not installed — run switchbot install --agent codex' }`

**`checkCodexPluginRegistered()`**
- Runs `codex plugin list --json` (or plain text fallback)
- Checks if any entry matches `switchbot`
- If `codex` not on PATH: returns `warn` with `{ reason: 'codex-cli-missing' }` (not `fail`, to avoid double-failing with checkCodexCli)
- `ok` → `{ pluginName }`
- `warn` → `{ message: 'switchbot not in codex plugin list — run switchbot install --agent codex' }`

**`runCodexPluginRegistration(packageRoot, pluginId)` — shared utility**  
Extracted from `stepRegisterCodexPlugin` and reused verbatim by repair step 4. Runs `codex plugin marketplace add` then `codex plugin add`. Returns `{ ok, exitCode, stderr }`. Neither the install step nor the repair step contain this logic inline — both call this function.

**No `checkCodexMcpStart` check added.**  
`switchbot codex doctor` reuses the existing `'mcp'` entry from CHECK_REGISTRY directly.

### Codex checks are NOT added to global `CHECK_REGISTRY` (P0-A)

> **Hard constraint:** `switchbot doctor` (the global health check) must not include any Codex-specific checks. Non-Codex users must see no Codex-related output, and scripts/CI consuming `switchbot doctor --json` must be unaffected.

The three Codex check functions (`checkCodexCli`, `checkCodexPluginNpm`, `checkCodexPluginRegistered`) are exported from `src/install/codex-checks.ts` and called **only** inside `switchbot codex doctor`. They are never appended to `CHECK_REGISTRY` in `doctor.ts`.

`doctor.ts` changes are limited to: export the `Check` interface, export `CHECK_REGISTRY`, add `runDoctorChecks()` helper. **No new entries are added to CHECK_REGISTRY.**

---

## Section 3: `switchbot codex` Command Group

### `src/commands/codex.ts` structure

```typescript
export function registerCodexCommand(program: Command): void {
  const codex = program.command('codex').description('Codex integration management');
  registerCodexDoctorSubcommand(codex);
  registerCodexRepairSubcommand(codex);
}
```

### `switchbot codex doctor`

Section list (fixed, not user-configurable in this command). The three Codex-specific checks are called directly (not via CHECK_REGISTRY):

```typescript
const CODEX_DOCTOR_SECTIONS = [
  'node', 'path', 'credentials', 'mcp',   // from CHECK_REGISTRY via runDoctorChecks()
] as const;

// Codex-specific checks run separately (not in CHECK_REGISTRY):
//   checkCodexCli(), checkCodexPluginNpm(), checkCodexPluginRegistered()
```

Implementation: extracts the subset from CHECK_REGISTRY, runs them, formats with the existing `printDoctorResult` logic. Supports `--json` and `-q/--quiet` (inherited from shared formatting). Exits 1 on any `fail`.

### `switchbot codex repair`

**Repair steps** (sequential, no rollback, failures continue):

| # | Name | Action | Skippable |
|---|------|--------|-----------|
| 1 | `verify-cli` | `doctor --section node,path` (silent) | No |
| 2 | `re-auth` | **Interactive mode**: spawn auth login via `process.execPath [cliPath, '--profile', profile, 'auth', 'login']` (inherits active `--profile` / `--config` to ensure credentials are written to the correct scope); **`--yes` mode**: check credentials only, return `failed` + `{ reason: 'credentials-missing' }` if absent | Yes |
| 3 | `remove-plugin` | `codex plugin remove <id>` (best-effort, exit ≠ 0 is non-fatal) | Yes |
| 4 | `register-plugin` | `codex plugin marketplace add` + `codex plugin add` (calls `runCodexPluginRegistration` + `resolvePluginId`) | No |
| 5 | `doctor-verify` | Run all 7 Codex doctor checks, print summary | No |

> **Strong constraint (P1-B):** In interactive mode (no `--yes`), the `re-auth` step MUST actually execute `switchbot auth login` when credentials are missing. Returning a hint message is only acceptable in `--yes` / non-interactive mode. "Repair" means repair, not diagnose.

**Repair step interface:**

```typescript
interface RepairContext {
  profile: string;          // active profile (--profile or 'default')
  codexPluginId?: string;   // resolved from npm list, e.g. 'switchbot@switchbot-codex-plugin'
  nonInteractive: boolean;  // true when --yes is passed
}

interface RepairStep {
  name: string;
  description: string;
  run(ctx: RepairContext): Promise<RepairOutcome>;
}

interface RepairOutcome {
  step: string;
  status: 'ok' | 'skipped' | 'failed';
  message?: string;
}
```

**CLI options:**

```
switchbot codex repair
  --skip <names>   Comma-separated step names to skip (e.g. "re-auth,remove-plugin")
  --yes            Non-interactive: skip re-auth (check only, report failed if missing)
  --json           Emit repair report as JSON
  (inherits global --dry-run)
```

**Exit codes:**

| Code | Meaning |
|------|---------|
| 0 | All steps ok or skipped |
| 1 | At least one step failed |
| 2 | `verify-cli` preflight failed; no further steps ran |

**Human-readable output example:**

```
Repairing Codex integration...

✓ verify-cli      node 22.x, switchbot on PATH
✓ re-auth         credentials ok (keychain)
↺ remove-plugin   codex plugin remove returned exit 1 (non-fatal, continuing)
✓ register-plugin marketplace add + plugin add succeeded
✓ doctor-verify   7 ok, 0 warn, 0 fail

Repair complete. Restart Codex and run: switchbot devices list
```

---

## Section 4: Plugin Deprecation (transition phase — P0-B)

> **Hard constraint:** `switchbot-codex-install` must remain functional until `switchbot install --agent codex` covers all 5 responsibilities currently in `install.js` (CLI self-install, marketplace add, plugin add, auth verification, doctor check). In this PR, it becomes a **deprecated wrapper**: prints a warning, then continues to run all existing logic unchanged.

### `packages/codex-plugin/bin/install.js`

Add a deprecation banner at the top of the `install()` function (before any other logic):

```js
process.stderr.write(
  '[switchbot-codex] WARNING: switchbot-codex-install is deprecated.\n' +
  '[switchbot-codex] Preferred: npm install -g @cly-org/switchbot-codex-plugin && switchbot install --agent codex\n' +
  '[switchbot-codex] This binary will continue to work during the transition period.\n'
);
// existing install logic continues below...
```

The binary must exit with the same codes as today. Final no-op redirect happens in a future PR after CLI coverage of all 5 steps is verified.

### `manifest.json`

```json
"codexPlugin": {
  "install": "npm install -g @cly-org/switchbot-codex-plugin && switchbot install --agent codex"
}
```

### `SKILL.md` / `CODEX_INSTALL.md`

Update install instructions to show the new recommended path as primary:
```
Recommended: npm install -g @cly-org/switchbot-codex-plugin && switchbot install --agent codex
Legacy (still works): switchbot-codex-install
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| `codex` not on PATH during install | Preflight `fail` → exit 2, hint: install Codex first |
| `codex plugin add` exits non-zero | Step `failed`, rollback attempts `codex plugin remove`, exits 3 |
| credentials missing during install | `stepPromptCredentials` handles interactively or fails with hint |
| `codex plugin list` exits non-zero in doctor | `codex-plugin-registered` returns `warn`, not `fail` |
| `codex plugin remove` fails in repair | Step outcome = `failed` (non-fatal), repair continues |
| repair `verify-cli` fails | exit 2, remaining steps not run |

---

## Testing

### Unit tests (`tests/install/codex-checks.test.ts`)

- `checkCodexCli`: mock `spawnSync`; test ok/fail/version-parse paths
- `checkCodexPluginNpm`: mock `spawnSync npm list`; test installed/missing/malformed-json paths
- `checkCodexPluginRegistered`: mock `spawnSync codex plugin list`; test found/missing/codex-not-on-PATH paths

### Integration tests (`tests/commands/codex.test.ts`)

- `codex doctor --json`: stub all 7 checks, assert section subset is correct, assert JSON contract
- `codex doctor --quiet`: assert only warn/fail lines printed
- `codex repair --dry-run`: assert step list printed, no mutations
- `codex repair --json`: stub repair steps, assert outcome array shape
- `codex repair --skip re-auth`: assert step 2 has status `skipped`

### install --agent codex

- Extend `tests/commands/install.test.ts` with `agent=codex` path
- Mock `stepRegisterCodexPlugin.execute` and `.rollback`
- Assert rollback is called when `register-plugin` throws

---

## Constraints & Non-goals

- CLI does **not** install the `@cly-org/switchbot-codex-plugin` npm package; it assumes the package is globally installed (preflight warns if not). The user installs the npm package once; CLI manages registration only.
- `switchbot codex` does not handle Cursor / Copilot / Claude Code — those remain under `--agent` flags.
- No changes to `switchbot uninstall` in this phase; Codex-specific uninstall is out of scope.
- **`switchbot doctor` default run is unaffected.** No Codex-specific checks are added to the global CHECK_REGISTRY. Codex health is only visible via `switchbot codex doctor`.
