#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import random
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


Json = dict[str, Any] | list[Any] | str | int | float | bool | None
CheckFn = Callable[[str, str, int, bool], tuple[bool, str | None]]


def utc_ts() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def safe_json_loads(text: str) -> Json | None:
    text = (text or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except Exception:
        return None


def parse_switchbot_envelope(text: str) -> Json | None:
    obj = safe_json_loads(text)
    if not isinstance(obj, dict):
        return obj
    if "data" in obj:
        return obj.get("data")
    return obj


def is_json_error_output(stdout: str, stderr: str) -> tuple[bool, str | None]:
    for channel_name, channel in (("stdout", stdout), ("stderr", stderr)):
        lines = [x.strip() for x in (channel or "").splitlines() if x.strip()]
        if not lines:
            continue
        parsed = safe_json_loads(lines[-1])
        if isinstance(parsed, dict) and "error" in parsed:
            return True, f"{channel_name}:json-error"
    return False, "no-json-error-object"


@dataclass
class RunResult:
    rc: int
    stdout: str
    stderr: str
    timeout: bool
    dur_ms: int


def run_cmd(args: list[str], timeout: int = 20, stdin: str | None = None) -> RunResult:
    start = time.time()
    try:
        p = subprocess.run(
            args,
            input=stdin,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
        return RunResult(
            rc=p.returncode,
            stdout=p.stdout or "",
            stderr=p.stderr or "",
            timeout=False,
            dur_ms=int((time.time() - start) * 1000),
        )
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, (bytes, bytearray)) else (e.stdout or "")
        err = e.stderr.decode("utf-8", "replace") if isinstance(e.stderr, (bytes, bytearray)) else (e.stderr or "")
        return RunResult(
            rc=124,
            stdout=out,
            stderr=err,
            timeout=True,
            dur_ms=int((time.time() - start) * 1000),
        )
    except Exception as e:
        return RunResult(
            rc=-1,
            stdout="",
            stderr=f"ERR:{e}",
            timeout=False,
            dur_ms=int((time.time() - start) * 1000),
        )


class ResultWriter:
    def __init__(self, out_path: Path, seed: int) -> None:
        self._out_path = out_path
        self._seed = seed
        self._id = 0
        self._fh = out_path.open("w", encoding="utf-8")

    @property
    def path(self) -> Path:
        return self._out_path

    @property
    def count(self) -> int:
        return self._id

    def close(self) -> None:
        self._fh.close()

    def record(
        self,
        *,
        cat: str,
        dim: str,
        label: str,
        expect: str,
        args: list[str],
        timeout: int = 20,
        stdin: str | None = None,
        check: CheckFn | None = None,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self._id += 1
        res = run_cmd(args=args, timeout=timeout, stdin=stdin)
        if expect == "ok":
            rc_pass = res.rc == 0
        elif expect == "fail":
            rc_pass = res.rc != 0
        else:
            rc_pass = True

        extra_pass, note = True, None
        if check is not None:
            try:
                extra_pass, note = check(res.stdout, res.stderr, res.rc, res.timeout)
            except Exception as ex:
                extra_pass, note = False, f"check-error:{ex}"

        passed = rc_pass and extra_pass
        case_hash = hashlib.sha1(
            json.dumps({"label": label, "args": args, "seed": self._seed}, ensure_ascii=False).encode("utf-8")
        ).hexdigest()[:16]
        row = {
            "id": self._id,
            "seed": self._seed,
            "case_hash": case_hash,
            "cat": cat,
            "dim": dim,
            "label": label,
            "expect": expect,
            "pass": passed,
            "rc_pass": rc_pass,
            "extra_pass": extra_pass,
            "extra_note": note,
            "rc": res.rc,
            "dur_ms": res.dur_ms,
            "timeout": res.timeout,
            "args": args,
            "stdin": stdin[:300] if isinstance(stdin, str) else None,
            "out": (res.stdout + res.stderr)[:2000],
        }
        if meta:
            row["meta"] = meta
        self._fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        self._fh.flush()
        return row


def pick_one(rng: random.Random, seq: list[Any]) -> Any:
    return seq[rng.randrange(0, len(seq))]


def clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))
