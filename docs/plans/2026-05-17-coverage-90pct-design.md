# Design: Push Test Coverage to ~90%

**Date:** 2026-05-17  
**Branch context:** `fix/v3.6.2-bugs`  
**Current coverage:** 79.49% lines / 79.97% branches (global)  
**Target:** ≥88% lines / ≥87% branches after HC exclusions  

---

## 1. Strategy

Approach B — **exclude hard-ceiling infrastructure files + targeted test backfill** for the 10–11 highest-leverage in-scope files.

The gap from ~79% to ~90% cannot be closed by test-writing alone because several files require live external infrastructure (MQTT broker, MCP server, LLM APIs). The honest solution is:

1. Remove those files from the coverage denominator via vitest `exclude`.
2. Write unit tests for every remaining file that is realistically improvable.
3. Lock the new thresholds to the achieved actuals.
4. Document in `docs/coverage-annotations.md` what is excluded and why, and which in-denominator sections remain structurally untestable.

---

## 2. vitest.config.ts — Exclusion List Changes

Add 5 files to the existing `coverage.exclude` array:

```typescript
// Hard-ceiling: require live infrastructure, not unit-testable
'src/mcp/device-history.ts',       // MCP streaming protocol (live server required)
'src/mcp/events-subscription.ts',  // MCP event subscription (live server required)
'src/mqtt/client.ts',              // MQTT broker required
'src/llm/providers/anthropic.ts',  // Anthropic API key + live endpoint required
'src/llm/providers/openai.ts',     // OpenAI API key + live endpoint required
```

**Verified impact:** exclusion alone moves the baseline from 79.49% → 81.47%.

---

## 3. Test Backfill Targets

Priority order by `line_count × potential_gain`. Each file's uncoverable sections are noted so tests are not written for them.

### P1 — Highest impact

| File | Current | Target | Key test surface |
|------|---------|--------|-----------------|
| `src/commands/doctor.ts` | 72.7% | ~87% | lines 1311–1323: `--check` failure path, `--json` error envelope |
| `src/commands/plan.ts` | 74.2% | ~88% | `approve` / `reject` / `execute` command wiring, `--json` output shape |
| `src/status-sync/manager.ts` | 73.3% | ~87% | `start` / `stop` / `status` state transitions, event emission |

### P2 — Medium impact

| File | Current | Target | Key test surface |
|------|---------|--------|-----------------|
| `src/commands/events.ts` | 73.0% | ~85% | `--device`, `--type` filter flags, clean exit path |
| `src/commands/auth.ts` | 68.0% | ~84% | lines 316–325: token-expired path, `--json` error response |
| `src/install/preflight.ts` | 66.3% | ~83% | OS-check branches stubbed for win32 / linux / macos |
| `src/commands/config.ts` | 69.1% | ~85% | lines 233–267: `--from-keychain`, error paths |

### P3 — Supplemental

| File | Current | Target | Key test surface |
|------|---------|--------|-----------------|
| `src/commands/mcp.ts` | 68.0% | ~76% | `--list`, `--json` flag parsing; protocol body NOT tested |
| `src/daemon/socket-path.ts` | 52.5% | ~87% | win32 named-pipe path, `USERNAME` env fallback, `whoami` fallback |
| `src/commands/rules.ts` | 56.7% | ~70% | non-simulate subcommand flag/output paths |
| `src/lib/daemon-state.ts` | 73.2% | ~92% | lock/unlock/read state transitions |

---

## 4. In-Denominator Structurally Untestable Sections

These sections remain in the coverage denominator but cannot be covered by unit tests. They are documented in `docs/coverage-annotations.md`.

| File | Lines / Area | Reason |
|------|-------------|--------|
| `src/commands/mcp.ts` | 2364–2633 | MCP tool-call / resource protocol handlers — live MCP client required |
| `src/commands/rules.ts` | 800–985, 1001–1081 | `simulate` / `trace-explain` subcommands — full rules engine + LLM required |
| `src/status-sync/manager.ts` | WebSocket push path | Live SwitchBot WebSocket connection required |
| `src/policy/migrate.ts` | lines 21–52 | `MIGRATION_CHAIN` is empty; migration step functions exist but are unreachable |

---

## 5. Threshold Targets (post-backfill)

Set conservatively (2% below expected actuals) to avoid flakiness from minor coverage drift:

```typescript
thresholds: {
  lines: 88,
  branches: 87,
  'src/commands/**': {
    lines: 80,
    branches: 78,
  },
},
```

After backfill is complete, run `npm run test -- --coverage` and lock thresholds to actual numbers.

---

## 6. Deliverables

1. `vitest.config.ts` — 5 HC files added to exclude list
2. `tests/commands/doctor.test.ts` — P1 additions
3. `tests/commands/plan.test.ts` — P1 additions (new file or additions)
4. `tests/lib/status-sync-manager.test.ts` — P1 new file
5. `tests/commands/events.test.ts` — P2 additions
6. `tests/commands/auth.test.ts` — P2 additions
7. `tests/install/preflight.test.ts` — P2 new file
8. `tests/commands/config.test.ts` — P2 additions
9. `tests/commands/mcp.test.ts` — P3 additions (flag parsing only)
10. `tests/lib/daemon-socket-path.test.ts` — P3 new file
11. `tests/commands/rules.test.ts` — P3 additions
12. `tests/lib/daemon-state.test.ts` — P3 additions
13. `vitest.config.ts` — thresholds locked to post-backfill actuals
14. `docs/coverage-annotations.md` — exclusion + untestable-section register
