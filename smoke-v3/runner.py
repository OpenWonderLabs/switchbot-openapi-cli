#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import shlex
from pathlib import Path
from typing import Any

from common import ResultWriter, is_json_error_output, parse_switchbot_envelope, run_cmd


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="smoke-v3 deterministic baseline runner")
    p.add_argument("--cli-bin", default="node dist/index.js")
    p.add_argument("--out", required=True, help="JSONL output path")
    p.add_argument("--seed", type=int, default=20260421)
    p.add_argument("--mutate-allowlist", default="", help="allowlist json path")
    p.add_argument("--state-out", default="", help="optional state json output")
    return p.parse_args()


def parse_data(stdout: str) -> Any:
    return parse_switchbot_envelope(stdout)


def load_allowlist(path: str) -> dict[str, Any]:
    if not path:
        return {"enabled": False, "devices": []}
    p = Path(path)
    if not p.exists():
        return {"enabled": False, "devices": []}
    try:
        obj = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass
    return {"enabled": False, "devices": []}


def parse_jsonrpc_lines(text: str) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("id"), int):
            out[obj["id"]] = obj
    return out


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
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    writer = ResultWriter(out_path=out_path, seed=args.seed)
    cli_base = shlex.split(args.cli_bin)
    if not cli_base:
        print("--cli-bin is empty")
        return 2

    def cli_args(*parts: str) -> list[str]:
        return [*cli_base, *list(parts)]

    allowlist = load_allowlist(args.mutate_allowlist)

    # ---- load live context ----
    list_res = run_cmd(cli_args("devices", "list", "--json"), timeout=30)
    if list_res.rc != 0:
        writer.record(
            cat="bootstrap",
            dim="bootstrap.devices",
            label="devices_list_bootstrap",
            expect="ok",
            args=cli_args("devices", "list", "--json"),
            check=lambda so, se, rc, to: (False, "bootstrap-failed"),
        )
        writer.close()
        return 1

    data = parse_data(list_res.stdout) or {}
    device_list = data.get("deviceList", []) if isinstance(data, dict) else []
    ir_list = data.get("infraredRemoteList", []) if isinstance(data, dict) else []
    by_type: dict[str, list[dict[str, Any]]] = {}
    for d in device_list:
        by_type.setdefault(str(d.get("deviceType", "")), []).append(d)

    # ---- S1 field naming consistency ----
    canonical = [
        "deviceId",
        "deviceName",
        "deviceType",
        "controlType",
        "roomName",
        "familyName",
        "roomID",
        "hubDeviceId",
        "enableCloudService",
        "category",
    ]
    aliases = ["id", "name", "type", "room", "family", "hub", "cloud", "alias"]
    for field in canonical + aliases:
        writer.record(
            cat="S1",
            dim="consistency.field_naming",
            label=f"list_filter_{field}",
            expect="either",
            args=cli_args("devices", "list", "--filter", f"{field}=x", "--format", "json"),
            check=lambda so, se, rc, t, _f=field: (f'Unknown filter key "{_f}"' not in (so + se), None),
        )
    for field in canonical + aliases:
        writer.record(
            cat="S1",
            dim="consistency.field_naming",
            label=f"list_fields_{field}",
            expect="either",
            args=cli_args("devices", "list", "--fields", field, "--format", "tsv"),
            check=lambda so, se, rc, t: (rc == 0, None),
        )

    # ---- S2 json error shape under --json ----
    error_cases = [
        ("bad_format", cli_args("devices", "list", "--format", "qwerty", "--json")),
        ("bad_timeout", cli_args("devices", "list", "--timeout", "0", "--json")),
        ("bad_backoff", cli_args("devices", "list", "--backoff", "moonshot", "--json")),
        ("bad_filter", cli_args("devices", "list", "--filter", "==", "--json")),
        ("bad_profile", cli_args("--profile", "__smoke_missing__", "devices", "list", "--json")),
    ]
    for label, cmd in error_cases:
        writer.record(
            cat="S2",
            dim="consistency.error_shape",
            label=f"err_shape_{label}",
            expect="fail",
            args=cmd,
            check=lambda so, se, rc, to: is_json_error_output(so, se),
        )

    # ---- S3 readonly and unknown command validation ----
    ro_types = ["Meter", "MeterPro", "Contact Sensor", "Wallet Finder Card"]
    for ro_t in ro_types:
        devs = by_type.get(ro_t, [])
        if not devs:
            continue
        did = devs[0].get("deviceId")
        if not did:
            continue
        for ro_cmd in ("turnOn", "turnOff", "toggle"):
            writer.record(
                cat="S3",
                dim="safety.readonly",
                label=f"readonly_cli_{ro_t}_{ro_cmd}",
                expect="fail",
                args=cli_args("devices", "command", did, ro_cmd, "--dry-run"),
                check=lambda so, se, rc, to: (
                    rc != 0 and ("read-only" in (so + se).lower() or "no control commands" in (so + se).lower()),
                    None,
                ),
            )

    writable_types = ["Strip Light 3", "Curtain", "Color Bulb", "Plug", "Plug Mini (US)", "Smart Lock"]
    for ht in writable_types:
        devs = by_type.get(ht, [])
        if not devs:
            continue
        did = devs[0].get("deviceId")
        if not did:
            continue
        writer.record(
            cat="S3",
            dim="safety.validation",
            label=f"unknown_cmd_cli_{ht}",
            expect="fail",
            args=cli_args("devices", "command", did, "fakeCmdXYZ", "--dry-run"),
            check=lambda so, se, rc, to: (rc != 0 and "supported command" in (so + se).lower(), None),
        )

    # ---- S4 mcp lifecycle + parity ----
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
    tool_list = {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
    mcp_res = run_cmd([*cli_base, "mcp", "serve"], timeout=12, stdin="\n".join(json.dumps(x, ensure_ascii=False) for x in [init, notify, tool_list]) + "\n")
    parsed = parse_jsonrpc_lines(mcp_res.stdout)
    writer.record(
        cat="S4",
        dim="ai.mcp_lifecycle",
        label="mcp_stdio_eof_exit",
        expect="ok",
        args=[*cli_base, "mcp", "serve", "<stdin:initialize/tools/list>"],
        check=lambda so, se, rc, to: (mcp_res.rc == 0 and not mcp_res.timeout, f"rc={mcp_res.rc} timeout={mcp_res.timeout}"),
        meta={"mcp_stdout_sample": mcp_res.stdout[:400]},
    )
    writer.record(
        cat="S4",
        dim="ai.mcp_schema",
        label="mcp_tools_list_shape",
        expect="ok",
        args=[*cli_base, "mcp", "serve", "<stdin:initialize/tools/list>"],
        check=lambda so, se, rc, to: (
            isinstance(parsed.get(2, {}).get("result", {}).get("tools", []), list),
            "tools-list-parsed",
        ),
    )

    # ---- S5 help quality ----
    help_cases = [
        ([*cli_base, "mcp", "serve", "--help"], "help_mcp_serve_examples"),
        ([*cli_base, "catalog", "show", "--help"], "help_catalog_show_examples"),
    ]
    for cmd, label in help_cases:
        writer.record(
            cat="S5",
            dim="ai.instructions",
            label=label,
            expect="ok",
            args=cmd,
            check=lambda so, se, rc, to: ("Examples:" in (so + se), None),
        )

    # ---- S6 mutate allowlist (limited real writes) ----
    if bool(allowlist.get("enabled")) and isinstance(allowlist.get("devices"), list):
        for entry in allowlist["devices"]:
            if not isinstance(entry, dict):
                continue
            did = str(entry.get("deviceId", "")).strip()
            cmds = entry.get("allowedCommands", [])
            if not did or not isinstance(cmds, list):
                continue
            max_runs = int(entry.get("maxRuns", 1))
            for idx, cmd in enumerate(cmds[:max_runs]):
                real_cmd = [*cli_base, "devices", "command", did, str(cmd), "--json"]
                if str(cmd) == "setBrightness":
                    real_cmd.append("30")
                writer.record(
                    cat="S6",
                    dim="real.mutate",
                    label=f"allowlist_mutate_{did[-6:]}_{cmd}_{idx}",
                    expect="either",
                    args=real_cmd,
                    meta={"real_mutate": True},
                    check=check_real_mutate_success,
                )

    # ---- write run state ----
    if args.state_out:
        state = {
            "cli_bin": args.cli_bin,
            "seed": args.seed,
            "device_count": len(device_list),
            "ir_count": len(ir_list),
            "device_ids": [d.get("deviceId") for d in device_list if d.get("deviceId")],
            "by_type": {k: [x.get("deviceId") for x in v if x.get("deviceId")] for k, v in by_type.items()},
            "allowlist_enabled": bool(allowlist.get("enabled")),
        }
        Path(args.state_out).write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    writer.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
