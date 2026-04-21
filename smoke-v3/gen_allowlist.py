#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import random
import shlex
from pathlib import Path
from typing import Any

from common import parse_switchbot_envelope, run_cmd


SAFE_TYPE_COMMANDS: dict[str, list[str]] = {
    "Strip Light 3": ["turnOn", "turnOff", "setBrightness"],
    "Color Bulb": ["turnOn", "turnOff", "setBrightness"],
    "Plug": ["turnOn", "turnOff"],
    "Plug Mini (US)": ["turnOn", "turnOff"],
    "Ceiling Light": ["turnOn", "turnOff", "setBrightness"],
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate safe mutate allowlist from live account devices")
    p.add_argument("--cli-bin", default="node dist/index.js")
    p.add_argument("--out", required=True)
    p.add_argument("--seed", type=int, default=20260421)
    p.add_argument("--count", type=int, default=4, help="max number of devices to include")
    p.add_argument("--max-runs", type=int, default=6)
    p.add_argument("--cooldown-ms", type=int, default=1200)
    return p.parse_args()


def main() -> int:
    args = parse_args()
    rng = random.Random(args.seed)
    cli_base = shlex.split(args.cli_bin)
    if not cli_base:
        print("--cli-bin is empty")
        return 2

    ls = run_cmd([*cli_base, "devices", "list", "--json"], timeout=30)
    if ls.rc != 0:
        print("failed to query devices list; keep mutate disabled")
        cfg = {"enabled": False, "devices": []}
        Path(args.out).write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0

    data = parse_switchbot_envelope(ls.stdout)
    if not isinstance(data, dict):
        cfg = {"enabled": False, "devices": []}
        Path(args.out).write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0

    candidates: list[dict[str, Any]] = []
    for d in data.get("deviceList", []):
        if not isinstance(d, dict):
            continue
        device_type = str(d.get("deviceType", ""))
        if device_type not in SAFE_TYPE_COMMANDS:
            continue
        if d.get("enableCloudService") is False:
            continue
        did = str(d.get("deviceId", "")).strip()
        if not did:
            continue
        candidates.append(
            {
                "deviceId": did,
                "deviceType": device_type,
                "deviceName": d.get("deviceName"),
                "allowedCommands": SAFE_TYPE_COMMANDS[device_type],
            }
        )

    rng.shuffle(candidates)
    selected = candidates[: max(0, args.count)]
    devices = [
        {
            "deviceId": x["deviceId"],
            "allowedCommands": x["allowedCommands"],
            "maxRuns": args.max_runs,
            "cooldownMs": args.cooldown_ms,
            "meta": {"deviceType": x["deviceType"], "deviceName": x.get("deviceName")},
        }
        for x in selected
    ]
    cfg = {"enabled": len(devices) > 0, "devices": devices}
    Path(args.out).write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"enabled": cfg["enabled"], "selected": len(devices), "out": args.out}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

