#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="smoke-v3 analyzer")
    p.add_argument("--inputs", nargs="+", required=True, help="jsonl files")
    p.add_argument("--summary-out", required=True)
    p.add_argument("--report-out", required=True)
    p.add_argument("--feedback-out", required=True)
    return p.parse_args()


def read_rows(files: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for f in files:
        p = Path(f)
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj, dict):
                    rows.append(obj)
            except Exception:
                continue
    return rows


def pass_rate(rows: list[dict[str, Any]]) -> float:
    if not rows:
        return 0.0
    ok = sum(1 for r in rows if r.get("pass") is True)
    return ok / len(rows)


def percentile(values: list[int], p: float) -> int:
    if not values:
        return 0
    sorted_vals = sorted(values)
    idx = int((len(sorted_vals) - 1) * p)
    return sorted_vals[idx]


def build_summary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    by_dim: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "pass": 0, "fail": 0})
    failures: list[dict[str, Any]] = []
    durs: list[int] = []
    mutate = {"real": 0, "degraded": 0}
    for r in rows:
        dim = str(r.get("dim", "unknown"))
        by_dim[dim]["total"] += 1
        if r.get("pass") is True:
            by_dim[dim]["pass"] += 1
        else:
            by_dim[dim]["fail"] += 1
            failures.append(
                {
                    "id": r.get("id"),
                    "dim": dim,
                    "label": r.get("label"),
                    "rc": r.get("rc"),
                    "extra_note": r.get("extra_note"),
                    "args": r.get("args"),
                }
            )
        durs.append(int(r.get("dur_ms") or 0))
        meta = r.get("meta")
        if isinstance(meta, dict):
            if meta.get("real_mutate") is True:
                mutate["real"] += 1
            if meta.get("degraded_to_dry_run") is True:
                mutate["degraded"] += 1

    dim_table = [
        {"dim": dim, **stats, "pass_rate": round(stats["pass"] / stats["total"], 4) if stats["total"] else 0.0}
        for dim, stats in sorted(by_dim.items(), key=lambda x: x[0])
    ]
    failures = failures[:200]
    return {
        "total": len(rows),
        "pass": sum(1 for r in rows if r.get("pass") is True),
        "fail": sum(1 for r in rows if r.get("pass") is not True),
        "pass_rate": round(pass_rate(rows), 4),
        "p50_ms": percentile(durs, 0.50),
        "p95_ms": percentile(durs, 0.95),
        "p99_ms": percentile(durs, 0.99),
        "dims": dim_table,
        "mutate": mutate,
        "failures": failures,
    }


def report_md(summary: dict[str, Any]) -> str:
    lines: list[str] = []
    lines.append("# smoke-v3 report")
    lines.append("")
    lines.append(f"- total: **{summary['total']}**")
    lines.append(f"- pass/fail: **{summary['pass']} / {summary['fail']}**")
    lines.append(f"- pass rate: **{summary['pass_rate']*100:.2f}%**")
    lines.append(f"- p50/p95/p99: **{summary['p50_ms']} / {summary['p95_ms']} / {summary['p99_ms']} ms**")
    lines.append(f"- mutate(real/degraded): **{summary['mutate']['real']} / {summary['mutate']['degraded']}**")
    lines.append("")
    lines.append("## By Dimension")
    lines.append("")
    lines.append("| dim | total | pass | fail | pass_rate |")
    lines.append("|---|---:|---:|---:|---:|")
    for d in summary["dims"]:
        lines.append(f"| {d['dim']} | {d['total']} | {d['pass']} | {d['fail']} | {d['pass_rate']*100:.2f}% |")
    lines.append("")
    lines.append("## Top Failures (first 50)")
    lines.append("")
    for f in summary["failures"][:50]:
        lines.append(f"- [{f['dim']}] `{f['label']}` rc={f['rc']} note={f.get('extra_note')}")
    lines.append("")
    return "\n".join(lines)


def feedback_md(summary: dict[str, Any]) -> str:
    by_dim = {d["dim"]: d for d in summary["dims"]}
    critical = []
    for dim in ("consistency.field_naming", "safety.readonly", "safety.validation", "consistency.error_shape", "ai.mcp_lifecycle"):
        d = by_dim.get(dim)
        if d and d["fail"] > 0:
            critical.append((dim, d["fail"], d["total"]))

    lines: list[str] = []
    lines.append("# smoke-v3 feedback")
    lines.append("")
    if critical:
        lines.append("## Critical (P0)")
        for dim, fail, total in critical:
            lines.append(f"- `{dim}` failed **{fail}/{total}**: keep as hard gate in CI.")
    else:
        lines.append("## Critical (P0)")
        lines.append("- Core AI-first dimensions are green in this run.")
    lines.append("")
    lines.append("## Recommendations")
    lines.append("- Keep `field_naming`, `readonly/validation`, `error_shape`, `mcp_lifecycle` as mandatory regression gates.")
    lines.append("- Preserve `--json` contract: all fail paths must emit machine-readable error objects.")
    lines.append("- Continue using canonical API field names across `--fields`, `--filter`, and docs/examples.")
    lines.append("- Use fixed-seed baseline + rotating-seed exploratory run in CI nightly.")
    lines.append("- Keep mutating tests under explicit allowlist and report degraded dry-run ratio.")
    lines.append("")
    lines.append("## Data Snapshot")
    lines.append(f"- total={summary['total']}, pass_rate={summary['pass_rate']*100:.2f}%")
    lines.append(f"- perf p50/p95/p99={summary['p50_ms']}/{summary['p95_ms']}/{summary['p99_ms']} ms")
    lines.append(f"- mutate real/degraded={summary['mutate']['real']}/{summary['mutate']['degraded']}")
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    rows = read_rows(args.inputs)
    summary = build_summary(rows)
    Path(args.summary_out).write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    Path(args.report_out).write_text(report_md(summary), encoding="utf-8")
    Path(args.feedback_out).write_text(feedback_md(summary), encoding="utf-8")
    print(json.dumps({"ok": True, "summary": args.summary_out, "report": args.report_out, "feedback": args.feedback_out}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
