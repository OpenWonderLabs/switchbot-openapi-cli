#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import random
import shlex
from pathlib import Path
from typing import Any

from common import ResultWriter, is_json_error_output, parse_switchbot_envelope, pick_one, run_cmd


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="smoke-v3 seed-driven fuzz runner")
    p.add_argument("--cli-bin", default="node dist/index.js")
    p.add_argument("--out", required=True, help="JSONL output path")
    p.add_argument("--seed", type=int, default=20260421)
    p.add_argument("--target-cases", type=int, default=1000)
    p.add_argument("--state-in", default="")
    p.add_argument("--mutate-allowlist", default="")
    return p.parse_args()


def load_json_file(path: str) -> dict[str, Any]:
    if not path:
        return {}
    p = Path(path)
    if not p.exists():
        return {}
    try:
        obj = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    return {}


def load_context(cli_base: list[str], state_in: str) -> dict[str, Any]:
    state = load_json_file(state_in)
    if state.get("device_ids"):
        return state
    ls = run_cmd([*cli_base, "devices", "list", "--json"], timeout=30)
    data = parse_switchbot_envelope(ls.stdout) if ls.rc == 0 else {}
    if not isinstance(data, dict):
        data = {}
    device_ids = [d.get("deviceId") for d in data.get("deviceList", []) if d.get("deviceId")]
    by_type: dict[str, list[str]] = {}
    for d in data.get("deviceList", []):
        dt = str(d.get("deviceType", ""))
        did = d.get("deviceId")
        if dt and did:
            by_type.setdefault(dt, []).append(did)
    return {
        "device_ids": device_ids,
        "by_type": by_type,
        "device_count": len(device_ids),
    }


def allowlist_map(path: str) -> dict[str, Any]:
    cfg = load_json_file(path)
    out: dict[str, Any] = {}
    if not cfg.get("enabled"):
        return out
    for x in cfg.get("devices", []):
        if not isinstance(x, dict):
            continue
        did = str(x.get("deviceId", "")).strip()
        cmds = x.get("allowedCommands", [])
        if did and isinstance(cmds, list):
            out[did] = {
                "allowedCommands": [str(c) for c in cmds],
                "maxRuns": int(x.get("maxRuns", 1)),
            }
    return out


def gen_list_case(cli_base: list[str], rng: random.Random) -> tuple[str, list[str], str]:
    formats = ["table", "json", "jsonl", "tsv", "yaml", "markdown", "id"]
    fields_pool = [
        "deviceId",
        "deviceName",
        "type",
        "deviceType",
        "name,room",
        "deviceId,type",
        "deviceId,deviceName,type",
    ]
    filters = [
        "type~Hub",
        "deviceType~Hub",
        "name~room",
        "deviceName~room",
        "category=physical",
        "category=ir",
        "room~Living",
        "roomName~Living",
    ]
    fmt = pick_one(rng, formats)
    args = [*cli_base, "devices", "list", "--format", fmt]
    if rng.random() < 0.8:
        args.extend(["--fields", pick_one(rng, fields_pool)])
    if rng.random() < 0.7:
        args.extend(["--filter", pick_one(rng, filters)])
    expect = "either"
    if fmt == "id":
        # id format requires id-like columns
        args = [*cli_base, "devices", "list", "--format", "id", "--fields", "deviceId"]
    return ("coverage.bulk", args, expect)


def gen_status_case(cli_base: list[str], rng: random.Random, device_ids: list[str]) -> tuple[str, list[str], str]:
    did = pick_one(rng, device_ids)
    args = [*cli_base, "devices", "status", did]
    if rng.random() < 0.5:
        args.extend(["--format", pick_one(rng, ["json", "jsonl", "tsv", "yaml"])])
    if rng.random() < 0.6:
        args.extend(["--fields", pick_one(rng, ["battery", "temperature", "power", "deviceId"])])
    return ("coverage.bulk", args, "either")


def gen_json_error_case(cli_base: list[str], rng: random.Random) -> tuple[str, list[str], str]:
    cases = [
        [*cli_base, "devices", "list", "--format", "qwerty", "--json"],
        [*cli_base, "devices", "list", "--timeout", "0", "--json"],
        [*cli_base, "devices", "list", "--backoff", "moonshot", "--json"],
        [*cli_base, "devices", "list", "--filter", "==", "--json"],
    ]
    return ("consistency.error_shape", pick_one(rng, cases), "fail")


def gen_command_case(
    cli_base: list[str],
    rng: random.Random,
    device_ids: list[str],
    by_type: dict[str, list[str]],
    allow_map: dict[str, Any],
    mutate_counts: dict[str, int],
) -> tuple[str, list[str], str, dict[str, Any] | None]:
    allow_ids = list(allow_map.keys())
    safe_types = [k for k in by_type.keys() if k in {"Strip Light 3", "Curtain", "Color Bulb", "Plug", "Plug Mini (US)"}]
    if allow_ids and rng.random() < 0.75:
        did = pick_one(rng, allow_ids)
    elif safe_types and rng.random() < 0.7:
        did = pick_one(rng, by_type[pick_one(rng, safe_types)])
    else:
        did = pick_one(rng, device_ids)

    known_cmds = [
        ("turnOn", None),
        ("turnOff", None),
        ("toggle", None),
        ("setBrightness", "30"),
        ("setColor", "128:128:128"),
    ]
    cmd, param = pick_one(rng, known_cmds)
    real_mutate = False
    degraded = False

    if did in allow_map and rng.random() < 0.20:
        allowed = allow_map[did]["allowedCommands"]
        max_runs = int(allow_map[did].get("maxRuns", 1))
        already = int(mutate_counts.get(did, 0))
        if already < max_runs:
            # Status-aware command selection for real mutate path.
            st = run_cmd([*cli_base, "devices", "status", did, "--json"], timeout=15)
            payload = parse_switchbot_envelope(st.stdout) if st.rc == 0 else {}
            power = None
            brightness = None
            if isinstance(payload, dict):
                power = payload.get("power")
                brightness = payload.get("brightness")
            if "setBrightness" in allowed and brightness is not None and rng.random() < 0.4:
                cmd, param = "setBrightness", str(rng.randint(20, 80))
                real_mutate = True
            elif "turnOn" in allowed and str(power).lower() in {"off", "false", "0"}:
                cmd, param = "turnOn", None
                real_mutate = True
            elif "turnOff" in allowed and str(power).lower() in {"on", "true", "1"}:
                cmd, param = "turnOff", None
                real_mutate = True
            elif allowed:
                cmd = pick_one(rng, allowed)
                param = str(rng.randint(20, 80)) if cmd == "setBrightness" else None
                real_mutate = True
            if real_mutate:
                mutate_counts[did] = already + 1
    if not real_mutate:
        degraded = True

    args = [*cli_base, "devices", "command", did, cmd]
    if param is not None:
        args.append(param)
    if not real_mutate:
        args.append("--dry-run")
    else:
        args.append("--json")

    meta = {"real_mutate": real_mutate, "degraded_to_dry_run": degraded}
    return ("coverage.commands_random", args, "either", meta)


def check_real_mutate_success(stdout: str, stderr: str, rc: int, timeout: bool) -> tuple[bool, str | None]:
    if timeout:
        return False, "timeout"
    if rc != 0:
        return False, f"rc={rc}"
    payload = parse_switchbot_envelope(stdout)
    if not isinstance(payload, dict):
        return False, "non-json-envelope"
    if payload.get("ok") is not True:
        return False, "data.ok!=true"
    return True, None


def main() -> int:
    args = parse_args()
    rng = random.Random(args.seed)
    cli_base = shlex.split(args.cli_bin)
    if not cli_base:
        print("--cli-bin is empty")
        return 2
    ctx = load_context(cli_base=cli_base, state_in=args.state_in)
    device_ids = [x for x in ctx.get("device_ids", []) if x]
    by_type = {k: v for k, v in (ctx.get("by_type", {}) or {}).items() if isinstance(v, list)}
    allow_map = allowlist_map(args.mutate_allowlist)
    mutate_counts: dict[str, int] = {}
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    writer = ResultWriter(out_path=out_path, seed=args.seed)

    # Fixed sanity seed section
    writer.record(
        cat="bootstrap",
        dim="bootstrap.sanity",
        label="sanity_version",
        expect="ok",
        args=[*cli_base, "--version"],
    )
    writer.record(
        cat="bootstrap",
        dim="bootstrap.sanity",
        label="sanity_devices_list",
        expect="ok",
        args=[*cli_base, "devices", "list", "--json"],
    )

    mix = ["list", "status", "json_error", "command", "catalog", "help", "mcp", "scenes", "doctor", "schema"]
    if not device_ids:
        mix = ["list", "json_error", "catalog", "help", "mcp", "scenes", "doctor", "schema"]
    while writer.count < args.target_cases:
        kind = pick_one(rng, mix)
        if kind == "list":
            dim, cmd, expect = gen_list_case(cli_base=cli_base, rng=rng)
            writer.record(cat="fuzz", dim=dim, label=f"fz_list_{writer.count}", expect=expect, args=cmd)
        elif kind == "status" and device_ids:
            dim, cmd, expect = gen_status_case(cli_base=cli_base, rng=rng, device_ids=device_ids)
            writer.record(cat="fuzz", dim=dim, label=f"fz_status_{writer.count}", expect=expect, args=cmd)
        elif kind == "json_error":
            dim, cmd, expect = gen_json_error_case(cli_base=cli_base, rng=rng)
            writer.record(
                cat="fuzz",
                dim=dim,
                label=f"fz_json_error_{writer.count}",
                expect=expect,
                args=cmd,
                check=lambda so, se, rc, to: is_json_error_output(so, se),
            )
        elif kind == "command" and device_ids:
            dim, cmd, expect, meta = gen_command_case(
                cli_base=cli_base,
                rng=rng,
                device_ids=device_ids,
                by_type=by_type,
                allow_map=allow_map,
                mutate_counts=mutate_counts,
            )
            writer.record(
                cat="fuzz",
                dim=dim,
                label=f"fz_command_{writer.count}",
                expect=expect,
                args=cmd,
                meta=meta,
                check=check_real_mutate_success if (isinstance(meta, dict) and meta.get("real_mutate") is True) else None,
            )
        elif kind == "scenes":
            writer.record(
                cat="fuzz",
                dim="coverage.bulk",
                label=f"fz_scenes_{writer.count}",
                expect="either",
                args=[*cli_base, "scenes", "list", "--format", pick_one(rng, ["json", "yaml", "tsv", "markdown"])],
            )
        elif kind == "doctor":
            writer.record(
                cat="fuzz",
                dim="perf",
                label=f"fz_doctor_{writer.count}",
                expect="either",
                args=[*cli_base, "doctor", "--format", pick_one(rng, ["json", "yaml"])],
            )
        elif kind == "schema":
            writer.record(
                cat="fuzz",
                dim="ai.catalog_coverage",
                label=f"fz_schema_{writer.count}",
                expect="either",
                args=[*cli_base, "schema", "export", "--json"],
            )
        elif kind == "catalog":
            q = pick_one(rng, ["Hub", "Curtain", "Robot Vacuum", "Meter", "Lock", "Bulb"])
            writer.record(
                cat="fuzz",
                dim="ai.catalog_coverage",
                label=f"fz_catalog_{writer.count}",
                expect="either",
                args=[*cli_base, "catalog", "show", q, "--format", pick_one(rng, ["json", "yaml", "tsv"])],
            )
        elif kind == "help":
            command = pick_one(
                rng,
                [
                    [*cli_base, "devices", "command", "--help"],
                    [*cli_base, "devices", "list", "--help"],
                    [*cli_base, "mcp", "serve", "--help"],
                    [*cli_base, "catalog", "show", "--help"],
                ],
            )
            writer.record(
                cat="fuzz",
                dim="ai.instructions",
                label=f"fz_help_{writer.count}",
                expect="ok",
                args=command,
                check=lambda so, se, rc, to: ("Examples:" in (so + se), None),
            )
        else:
            # mcp quick parity ping
            init = {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "smoke-v3", "version": "1"},
                },
            }
            notify = {"jsonrpc": "2.0", "method": "notifications/initialized"}
            call = {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
            stdin = "\n".join(json.dumps(x) for x in [init, notify, call]) + "\n"
            writer.record(
                cat="fuzz",
                dim="ai.mcp_parity",
                label=f"fz_mcp_{writer.count}",
                expect="ok",
                args=[*cli_base, "mcp", "serve"],
                stdin=stdin,
                timeout=12,
                check=lambda so, se, rc, to: (rc == 0 and not to and '"id":2' in so, None),
            )

    writer.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
