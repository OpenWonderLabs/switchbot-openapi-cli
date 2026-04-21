#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from common import utc_ts


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="smoke-v3 full orchestrator")
    p.add_argument("--cli-bin", default="node dist/index.js")
    p.add_argument("--seed", type=int, default=20260421)
    p.add_argument("--target-cases", type=int, default=1200)
    p.add_argument("--results-dir", default="")
    p.add_argument("--mutate-allowlist", default="")
    p.add_argument("--auto-mutate-count", type=int, default=0, help="auto-generate safe mutate allowlist with up to N devices")
    return p.parse_args()


def count_lines(path: Path) -> int:
    if not path.exists():
        return 0
    return sum(1 for _ in path.open("r", encoding="utf-8"))


def run(cmd: list[str]) -> int:
    print(">", " ".join(cmd))
    p = subprocess.run(cmd)
    return p.returncode


def main() -> int:
    args = parse_args()
    base = Path(__file__).resolve().parent
    results_dir = Path(args.results_dir) if args.results_dir else (base / "results")
    results_dir.mkdir(parents=True, exist_ok=True)

    ts = utc_ts()
    seed = args.seed
    baseline_jsonl = results_dir / f"baseline-{ts}-seed{seed}.jsonl"
    fuzz_jsonl = results_dir / f"fuzz-{ts}-seed{seed}.jsonl"
    state_json = results_dir / f"state-{ts}-seed{seed}.json"
    merged_jsonl = results_dir / f"results-{ts}-seed{seed}.jsonl"
    summary_json = results_dir / f"summary-{ts}-seed{seed}.json"
    report_md = results_dir / f"report-{ts}-seed{seed}.md"
    feedback_md = results_dir / f"feedback-{ts}-seed{seed}.md"
    latest_txt = results_dir / "latest.txt"

    py = sys.executable

    effective_allowlist = args.mutate_allowlist
    if not effective_allowlist and args.auto_mutate_count > 0:
        auto_allowlist = results_dir / f"mutate-allowlist-{ts}-seed{seed}.json"
        rc = run(
            [
                py,
                str(base / "gen_allowlist.py"),
                "--cli-bin",
                args.cli_bin,
                "--out",
                str(auto_allowlist),
                "--seed",
                str(seed),
                "--count",
                str(args.auto_mutate_count),
            ]
        )
        if rc != 0:
            print("auto allowlist generation failed")
            return rc
        effective_allowlist = str(auto_allowlist)

    rc = run(
        [
            py,
            str(base / "runner.py"),
            "--cli-bin",
            args.cli_bin,
            "--out",
            str(baseline_jsonl),
            "--seed",
            str(seed),
            "--state-out",
            str(state_json),
            "--mutate-allowlist",
            effective_allowlist,
        ]
    )
    if rc != 0:
        print("baseline failed")
        return rc

    baseline_count = count_lines(baseline_jsonl)
    fuzz_target = max(args.target_cases - baseline_count, 0)
    if fuzz_target > 0:
        rc = run(
            [
                py,
                str(base / "fuzz.py"),
                "--cli-bin",
                args.cli_bin,
                "--out",
                str(fuzz_jsonl),
                "--seed",
                str(seed),
                "--target-cases",
                str(fuzz_target),
                "--state-in",
                str(state_json),
                "--mutate-allowlist",
                effective_allowlist,
            ]
        )
        if rc != 0:
            print("fuzz failed")
            return rc

    # merge
    with merged_jsonl.open("w", encoding="utf-8") as out:
        for src in [baseline_jsonl, fuzz_jsonl]:
            if not src.exists():
                continue
            out.write(src.read_text(encoding="utf-8"))

    rc = run(
        [
            py,
            str(base / "analyze.py"),
            "--inputs",
            str(baseline_jsonl),
            *( [str(fuzz_jsonl)] if fuzz_jsonl.exists() else [] ),
            "--summary-out",
            str(summary_json),
            "--report-out",
            str(report_md),
            "--feedback-out",
            str(feedback_md),
        ]
    )
    if rc != 0:
        print("analyze failed")
        return rc

    latest_txt.write_text(str(merged_jsonl), encoding="utf-8")
    print(f"done: {merged_jsonl}")
    print(f"report: {report_md}")
    print(f"feedback: {feedback_md}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
