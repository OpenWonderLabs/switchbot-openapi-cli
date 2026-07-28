# Design: AI MindClip Device Support + Account Switching Cache Fix

**Date:** 2026-06-13  
**Status:** Approved  
**Scope:** switchbot-cli

---

## Problem

1. **AI MindClip missing**: The `AI MindClip` voice recorder device (W1145000/AIPinNote) exists in SwitchBot's OpenAPI v1.1 but the CLI has no catalog entry and no support for its 7 custom `/v1.1/mindclip/*` endpoints (recordings, summaries, to-dos, daily/weekly recall, urgent to-dos).

2. **Account switching data leak**: Switching accounts via `auth login` or `config set-token` leaves three in-memory caches populated with the previous account's data: (a) the 5-second credential priming cache (`prime.ts`), (b) the idempotency replay cache (`lib/idempotency.ts`), and (c) the device/status cache (only cleared by `auth login`, not by `config set-token`).

---

## Approach

Three independent, self-contained parts:

**Part A — Device catalog entry**: Add `AI MindClip` to `src/devices/catalog.ts` as a read-only entry with 5 status fields. No commands — the device doesn't accept any.

**Part B — MindClip command group**: Add `src/lib/mindclip.ts` (7 HTTP helper functions) and `src/commands/mindclip.ts` (7 CLI subcommands). Register in `src/program-builder.ts`. Option validation uses Commander's `InvalidArgumentError` pattern matching the existing `arg-parsers.ts` style. New `dateArg()`/`weekArg()` validators are added to `arg-parsers.ts`.

**Part C — Cache leak fix**: Export `clearPrimedCredentials()` from `prime.ts` for production use (existing `__resetPrimedCredentials()` stays as test-only). Call it plus `idempotencyCache.clear()` in `auth.ts` (post-login) and `config.ts` (post-set-token). `config.ts` also gains the two missing `clearCache()`/`clearStatusCache()` calls.

---

## File Layout

```
src/
  devices/catalog.ts          MODIFY: add AI MindClip entry
  utils/arg-parsers.ts        MODIFY: add dateArg(), weekArg()
  lib/mindclip.ts             NEW: 7 API helper functions
  commands/mindclip.ts        NEW: 7 CLI subcommands + help text
  program-builder.ts          MODIFY: import + register mindclip; add to TOP_LEVEL_COMMANDS
  credentials/prime.ts        MODIFY: export clearPrimedCredentials()
  commands/auth.ts            MODIFY: call clearPrimedCredentials() + idempotencyCache.clear()
  commands/config.ts          MODIFY: call all 4 cache-clear functions after set-token

tests/
  credentials/prime.test.ts       MODIFY: add test for clearPrimedCredentials()
  utils/arg-parsers.test.ts       MODIFY: add describe blocks for dateArg(), weekArg()
  devices/mindclip-catalog.test.ts  NEW: catalog entry correctness
  lib/mindclip.test.ts            NEW: 7 API function unit tests (mocked HTTP client)
  commands/mindclip.test.ts       NEW: command validation + action smoke tests
```

---

## API Endpoints

All 7 endpoints live under `/v1.1/mindclip/` and require the standard HMAC-SHA256 auth headers.

| CLI Subcommand | Method | Endpoint |
|---|---|---|
| `recordings` | GET | `/v1.1/mindclip/recordings` |
| `recording <id>` | GET | `/v1.1/mindclip/recordings/{id}` |
| `summary <id>` | GET | `/v1.1/mindclip/summaries/{id}` |
| `todos` | GET | `/v1.1/mindclip/todos` |
| `daily` | GET | `/v1.1/mindclip/assistant/daily` |
| `weekly` | GET | `/v1.1/mindclip/assistant/weekly` |
| `urgent-todos` | GET | `/v1.1/mindclip/assistant/urgent-todos` |

---

## API Function Signatures

```typescript
// src/lib/mindclip.ts

interface ListRecordingsParams {
  deviceID?: string;
  pageNum?: number;
  pageSize?: number;
  startTime?: number;
  endTime?: number;
  folderID?: number;
}

interface ListTodosParams {
  completedNum?: number;
  pageNum?: number;
  pageSize?: number;
  deviceID?: string;
  fileID?: string;
  startTime?: number;
  endTime?: number;
  category?: number;
}

export async function listRecordings(params: ListRecordingsParams): Promise<unknown>
export async function getRecording(id: string, language?: string): Promise<unknown>
export async function getSummary(id: string): Promise<unknown>
export async function listTodos(params: ListTodosParams): Promise<unknown>
export async function getDailyRecall(date?: string): Promise<unknown>
export async function getWeeklySummary(week?: string): Promise<unknown>
export async function getUrgentTodos(date?: string): Promise<unknown>
```

---

## CLI Subcommand Signatures

```
switchbot mindclip recordings [--device <id>] [--page <n>] [--size <n>] [--start <ms>] [--end <ms>] [--folder <n>]
switchbot mindclip recording <id> [--language <lang>]
switchbot mindclip summary <id>
switchbot mindclip todos [--completed <n>] [--page <n>] [--size <n>] [--device <id>] [--file <id>] [--category <n>]
switchbot mindclip daily [--date <YYYY-MM-DD>]
switchbot mindclip weekly [--week <YYYY-Www>]
switchbot mindclip urgent-todos [--date <YYYY-MM-DD>]
```

---

## Validation Rules

| Option | Validator | Valid values |
|---|---|---|
| `--page` | `intArg('--page', {min:1})` | integer ≥ 1 |
| `--size` | `intArg('--size', {min:1, max:100})` | integer 1–100 |
| `--start`, `--end` | `intArg('--start', {min:0})` | integer ≥ 0 (ms timestamp) |
| `--folder` | `intArg('--folder', {min:0})` | integer ≥ 0 |
| `--file` | `intArg('--file', {min:0})` | integer ≥ 0 |
| `--completed` | `enumArg('--completed', ['0','1','2'])` | "0"=all / "1"=incomplete / "2"=completed |
| `--category` | `intArg('--category', {min:0, max:5})` | 0=any, 1=work, 2=life, 3=hobby, 4=holiday, 5=other |
| `--date` | `dateArg('--date')` | `YYYY-MM-DD` format, real date |
| `--week` | `weekArg('--week')` | `YYYY-Www` format, W01–W53 |
| `--language` | `stringArg('--language')` | any string (e.g. "en", "zh") |

---

## Device Status Fields

| Field | Type | Notes |
|---|---|---|
| `battery` | number | 0–100 |
| `chargingStatus` | number | 0=not charging, 1=charging |
| `recordingStatus` | number | 0=idle, 1=recording |
| `uploadStatus` | number | 0=not uploading, 1=uploading |
| `hasUntransferredFiles` | boolean | — |

---

## Cache Leak Details

| Cache | Module | Cleared by `auth login`? | Cleared by `config set-token`? | Fix |
|---|---|---|---|---|
| Device list/status | `devices/cache.ts` | ✅ yes | ❌ missing | Add `clearCache()` + `clearStatusCache()` to config |
| Credential priming | `credentials/prime.ts` | ❌ missing | ❌ missing | Export `clearPrimedCredentials()`, call in both |
| Idempotency replay | `lib/idempotency.ts` | ❌ missing | ❌ missing | Call `idempotencyCache.clear()` in both |

---

## Default Value Handling

When `--date` or `--week` flags are omitted, the query param is simply **not sent** — the server applies its own default:

- `daily`: most recent record on the server
- `weekly`: most recent record on the server  
- `urgent-todos`: yesterday's date on the server

Client-side default computation is intentionally **not** implemented.
