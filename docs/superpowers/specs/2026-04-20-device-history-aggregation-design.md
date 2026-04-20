# Device History Aggregation — Design

- **Date:** 2026-04-20
- **Target release:** 2.5.0 (deferred from 2.4.1 scope per `release/2.4.1` plan)
- **Status:** Design approved, implementation pending

## 1. Motivation

`switchbot-cli` 2.4.0 ships JSONL-backed per-device history at
`~/.switchbot/device-history/<deviceId>.jsonl` (50 MB × 3 rotation), with CLI
query surface `history range` / `history stats` and MCP
`query_device_history`. Agents can pull raw records but have no way to ask
"what was the p95 temperature per hour last week?" without fetching every
sample and aggregating locally — which is token-expensive and slow.

The 2.4.1 patch plan explicitly deferred aggregation primitives to 2.5.0
(`Aggregation primitives on history range (avg/min/max/p95/group-by). Still
deferred to 2.5.0`). This design specifies that deferred feature.

## 2. Goals

- **Per-device bucketed statistics** over existing JSONL storage.
- **Zero storage format change** — read-only layer on top of today's files.
- **CLI and MCP parity** — same contract shape in both surfaces.
- **Agent-friendly output** — structured JSON that an agent can feed back into
  a decision without re-parsing.

### Non-goals (explicit)

- Cross-device aggregation. Agents multi-call and merge locally.
- Trend / rate-of-change helpers. Derivable from bucket time-series.
- Real-time streaming / subscriptions.
- Migration to SQLite or a TSDB. JSONL + streaming `readline` is sufficient
  until `recordCount > 1M` per device forces a rethink.
- `--fill-empty` for missing buckets (MVP omits; agent can fill).
- Changes to `events mqtt-tail` write path or the `.json` ring buffer.

## 3. User-facing surface

### 3.1 CLI

New subcommand `history aggregate`:

```bash
# Minimum viable
switchbot history aggregate <deviceId> --since 7d --metric temperature --agg avg,p95

# Multi-metric + time bucket
switchbot history aggregate <deviceId> \
    --from 2026-04-13T00:00:00Z --to 2026-04-20T00:00:00Z \
    --metric temperature --metric humidity \
    --agg count,min,max,avg,p95 \
    --bucket 1h

# Single bucket for the whole window (omit --bucket)
switchbot history aggregate <deviceId> --since 24h --metric battery --agg min,avg
```

| Flag | Meaning | Default |
|---|---|---|
| `--since <dur>` / `--from <iso>` / `--to <iso>` | Reuse `history range` time-window logic (`parseDurationToMs`, `resolveRange`). `--since` and `--from/--to` are mutually exclusive. | — |
| `--metric <name>` (repeatable) | Payload field to aggregate. Non-numeric samples are skipped. | Required, ≥1 |
| `--agg <csv>` | Subset of `count,min,max,avg,sum,p50,p95`. | `count,avg` |
| `--bucket <dur>` | Duration spec (`15m`, `1h`, `1d`). Omit → one bucket for the whole window. | — |
| `--max-bucket-samples <n>` | Safety cap for quantile memory. | 10000 |
| `--json` | Envelope JSON output (already global). | TTY-detect |

Text mode output: three-column aligned table whose columns are `t`,
`<metric>.<agg>` pairs (stable order from the user's `--metric` × `--agg`
product). Non-TTY defaults to ASCII (honors existing `--table-style`).

### 3.2 MCP

New tool `aggregate_device_history` with strict input schema and the
`_meta.agentSafetyTier: "read"` marker (2.4.1 A4 pattern once shipped):

```ts
server.registerTool('aggregate_device_history', {
  title: 'Aggregate device history',
  description: 'Bucketed statistics (count/min/max/avg/sum/p50/p95) over JSONL history.',
  _meta: { agentSafetyTier: 'read' },
  inputSchema: z.object({
    deviceId: z.string(),
    since: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    metrics: z.array(z.string()).min(1),
    aggs: z.array(z.enum(['count','min','max','avg','sum','p50','p95'])).optional(),
    bucket: z.string().optional(),
    maxBucketSamples: z.number().int().positive().max(100_000).optional(),
  }).strict(),
  execution: { taskSupport: 'forbidden' },
});
```

## 4. Output shape (CLI `--json` and MCP share the same envelope)

```json
{
  "deviceId": "01-202407011402-60553518",
  "bucket": "1h",
  "from": "2026-04-19T10:00:00.000Z",
  "to":   "2026-04-20T10:00:00.000Z",
  "metrics": ["temperature", "humidity"],
  "aggs": ["count", "avg", "p95"],
  "buckets": [
    {
      "t": "2026-04-19T10:00:00.000Z",
      "metrics": {
        "temperature": { "count": 120, "avg": 21.2, "p95": 22.1 },
        "humidity":    { "count": 120, "avg": 45.7, "p95": 51.0 }
      }
    }
  ],
  "partial": false,
  "notes": []
}
```

Rules:

- `buckets` is ordered by `t` ascending.
- `buckets[].metrics[M]` is **absent** when all samples in that bucket
  for metric `M` were non-numeric or the bucket was empty for `M`.
  (Agents must not assume every metric appears in every bucket.)
- Empty buckets (no samples for any metric) are **omitted entirely**.
- `partial: true` means at least one bucket exceeded
  `maxBucketSamples` for at least one metric; the `notes[]` array
  enumerates which buckets were downsampled for quantile computation.
  Non-quantile aggs (count/min/max/avg/sum) are always exact.
- All timestamps are ISO-8601 UTC.
- Wrapped in the standard CLI envelope: `{ schemaVersion, data: <above> }`.

## 5. Architecture

```
┌──────────────────────────────────────┐
│  CLI:  switchbot history aggregate   │──┐
└──────────────────────────────────────┘  │
┌──────────────────────────────────────┐  │    ┌─────────────────────────────┐
│  MCP:  aggregate_device_history tool │──┼───▶│ src/devices/history-agg.ts  │
└──────────────────────────────────────┘  │    │  (new — pure async fn)      │
                                          │    └──────────────┬──────────────┘
                                          │                   │ reuses
                                          │                   ▼
                                          │    ┌─────────────────────────────┐
                                          └───▶│ history-query.ts            │
                                               │  parseDurationToMs,         │
                                               │  jsonlFilesForDevice,       │
                                               │  resolveRange (export)      │
                                               └─────────────────────────────┘
```

Units:

- **`src/devices/history-agg.ts`** (new) — pure async function
  `aggregateDeviceHistory(deviceId, opts): Promise<AggResult>`. No
  side effects. No direct commander/MCP dependency.
- **`src/commands/history.ts`** — register `history aggregate` subcommand.
  Parses flags, calls `aggregateDeviceHistory`, prints text or JSON.
- **`src/commands/mcp.ts`** — new `registerTool('aggregate_device_history',
  …)` that delegates to the same `aggregateDeviceHistory` function.
- **`src/commands/capabilities.ts`** — `COMMAND_META` gets
  `'history aggregate': { mutating:false, consumesQuota:false,
  idempotencySupported:false, agentSafetyTier:'read',
  verifiability:'local', typicalLatencyMs: 80 }`.

Interface isolation:

- `aggregateDeviceHistory` does not read `commander` or MCP types.
- CLI and MCP each translate their input schema into the same
  `AggOptions` object and consume the same `AggResult`.
- Tests on the pure function cover correctness; CLI/MCP tests cover
  wiring only.

## 6. Core algorithm

~100 LoC. Stream-read the oldest-first JSONL files; per line, pick a
bucket key and fold each metric into a running accumulator.

```ts
interface Acc {
  min: number;
  max: number;
  sum: number;
  count: number;
  samples: number[] | null; // null → quantiles not requested
  sampleCapHit: boolean;
}

async function aggregateDeviceHistory(deviceId: string, opts: AggOptions): Promise<AggResult> {
  const { fromMs, toMs } = resolveRange(opts);
  const bucketMs = opts.bucket ? parseDurationToMs(opts.bucket) : null;
  if (opts.bucket && bucketMs === null) {
    throw new UsageError(`Invalid --bucket "${opts.bucket}". Expected e.g. "15m", "1h", "1d".`);
  }
  const sampleCap = opts.maxBucketSamples ?? 10_000;
  const aggs: AggFn[] = opts.aggs ?? ['count', 'avg'];
  const needQuantile = aggs.includes('p50') || aggs.includes('p95');

  // bucketKey (epoch ms, 0 when no --bucket) → metric → Acc
  const buckets = new Map<number, Map<string, Acc>>();
  const notes: string[] = [];
  let partial = false;

  for (const file of jsonlFilesForDevice(deviceId)) {
    // mtime prune (reuse history-query convention)
    try {
      const st = fs.statSync(file);
      if (st.mtimeMs < fromMs) continue;
    } catch { continue; }

    const rl = readline.createInterface({
      input: fs.createReadStream(file, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line) continue;
      let rec: HistoryRecord;
      try { rec = JSON.parse(line) as HistoryRecord; } catch { continue; }
      const tMs = Date.parse(rec.t);
      if (!Number.isFinite(tMs) || tMs < fromMs || tMs > toMs) continue;

      const key = bucketMs ? Math.floor(tMs / bucketMs) * bucketMs : 0;
      let bkt = buckets.get(key);
      if (!bkt) { bkt = new Map(); buckets.set(key, bkt); }

      for (const metric of opts.metrics) {
        const v = (rec.payload as Record<string, unknown> | null | undefined)?.[metric];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        let acc = bkt.get(metric);
        if (!acc) {
          acc = { min: v, max: v, sum: 0, count: 0,
                  samples: needQuantile ? [] : null, sampleCapHit: false };
          bkt.set(metric, acc);
        }
        acc.min = Math.min(acc.min, v);
        acc.max = Math.max(acc.max, v);
        acc.sum += v;
        acc.count += 1;
        if (acc.samples && acc.samples.length < sampleCap) {
          acc.samples.push(v);
        } else if (acc.samples && !acc.sampleCapHit) {
          acc.sampleCapHit = true;
          partial = true;
          notes.push(`bucket ${new Date(key).toISOString()} metric ${metric}: sample cap ${sampleCap} reached, quantiles approximate`);
        }
      }
    }
  }

  return finalize(buckets, opts, aggs, partial, notes);
}
```

`finalize` sorts `buckets` by key ascending, computes each metric's
requested aggs, drops empty metrics/buckets per §4 rules, and returns the
envelope.

Quantile implementation: sort `samples` ascending, index via
`samples[Math.floor(p * (n-1))]` (nearest-rank). Good enough for MVP; if
users later need interpolated percentiles we swap the helper.

### Memory bound

Worst case per `(bucket × metric)`: `sampleCap` numbers × 8 bytes = 80 KB.
For a 7-day window with `--bucket 1h` and 3 metrics: 24 × 7 × 3 = 504
`(bucket, metric)` cells → max ~40 MB if every cell hits the cap. In
practice devices emit on change, not at cap density, so typical usage is
orders of magnitude smaller. Hard ceiling via `--max-bucket-samples` is
enforced server-side at 100 000.

## 7. Error handling

| Condition | Exit | Shape |
|---|---|---|
| `--metric` missing | 2 | `UsageError("at least one --metric required")` |
| `--agg` contains unknown function | 2 | `UsageError` lists legal names |
| `--bucket` unparseable | 2 | `UsageError` with example |
| `--since` + `--from`/`--to` | 2 | reuses `resolveRange` check |
| `--from > --to` | 2 | reuses `resolveRange` check |
| JSONL files don't exist for device | 0 | `{ buckets: [], notes: ["no history recorded for <id>"] }` |
| Bucket samples all non-numeric for a metric | 0 | metric absent from that bucket's `metrics` object |
| Bucket overflows `maxBucketSamples` for quantiles | 0 | `partial: true` + per-bucket `notes[]` |
| JSONL line fails to parse | 0 | line silently skipped (same convention as `history range`) |

MCP tool translates `UsageError` → `McpError(InvalidParams, …)` so
JSON-RPC clients see `-32602`.

## 8. Testing strategy

| File | Asserts |
|---|---|
| `tests/devices/history-agg.test.ts` | — single-bucket count/min/max/avg/sum correctness against known fixture<br>— multi-bucket boundary alignment (record at `10:59:59.999Z` falls in `10:00` bucket, `11:00:00.000Z` falls in `11:00`)<br>— p50/p95 against hand-computed values on small fixture<br>— non-numeric samples skipped, numeric `"21.5"` string skipped (strict `typeof v === 'number'`)<br>— empty device returns `buckets: []`<br>— sample cap: synthetic >10 001 samples → `partial: true` and `notes[]` populated<br>— mtime prune skips rotated files older than `fromMs` |
| `tests/commands/history-aggregate.test.ts` | — flag parsing (missing `--metric`, bad `--agg`, bad `--bucket`, both `--since` and `--from`)<br>— `--json` envelope shape round-trip<br>— repeatable `--metric` vs csv `--agg` both work<br>— text mode column layout stable ordering |
| `tests/mcp/aggregate-device-history.test.ts` | — tool listed in `tools/list`<br>— `_meta.agentSafetyTier === 'read'`<br>— `.strict()` rejects unknown input key with JSON-RPC `-32602`<br>— output shape identical to CLI `--json.data`<br>— oversized `maxBucketSamples` rejected |

Fixtures: generated via a small helper that writes synthetic JSONL into
`tmpdir`/`device-history/<id>.jsonl` with controlled timestamps and
payloads (temperature, humidity, battery). No real API.

## 9. Backward compatibility

- **Zero breaking**. No field in any existing shape changes.
- `COMMAND_META` gains a row — additive.
- `tools/list` gains an entry — additive. Existing agents ignoring
  unknown tools are unaffected.
- `schema export`'s `cliAddedFields` is unchanged; the aggregation
  output is a new payload, not a field grafted into an old one.
- `.json` ring buffer, `.jsonl` rotation, `events mqtt-tail`,
  `get_device_history`, `query_device_history` all untouched.

## 10. Open questions (deferred)

- Non-TTY markdown table for aggregation output — defer until
  requested; MVP emits ASCII table or `--json`.
- Filtering by `topic` (e.g., aggregate only `ctl` events, not
  `status`) — out of scope; users can pre-filter with
  `history range --topic` if that flag gets added.
- Daily / rolling jobs that persist aggregations — out of scope; this
  is an on-demand query layer, not a materialized view.

## 11. Implementation checklist (handoff to writing-plans)

1. `src/devices/history-agg.ts` — pure function + types (~150 LoC incl. JSDoc)
2. `src/commands/history.ts` — register `aggregate` subcommand (~60 LoC)
3. `src/commands/mcp.ts` — new `registerTool` (~40 LoC)
4. `src/commands/capabilities.ts` — add `history aggregate` to `COMMAND_META` (1 LoC)
5. `src/commands/capabilities.ts` — add `'aggregate_device_history'` to `MCP_TOOLS` (1 LoC)
6. Tests per §8 (~300 LoC across three files)
7. `CHANGELOG.md` — 2.5.0 entry (new section, new features)
8. `package.json` — version → `2.5.0`

Estimated effort: ~700 LoC total (300 source + 300 test + doc/metadata).
Risk: low — purely additive, reuses existing streaming primitives, no
storage migration.
