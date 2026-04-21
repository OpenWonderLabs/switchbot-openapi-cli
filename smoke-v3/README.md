# smoke-v3

AI-first / Dev-first smoke framework for SwitchBot CLI.

## Goals

- Deterministic, reproducible smoke runs (`--seed`)
- 1000+ mixed baseline + fuzz cases
- Windows-friendly path handling
- Safe mutating mode with explicit allowlist
- Report artifacts consumable by humans and agents

## Files

- `runner.py`: deterministic baseline suites (P0/P1 dimensions)
- `fuzz.py`: seed-driven random case generation
- `analyze.py`: aggregate JSONL results into report + feedback
- `run_full.py`: orchestrates baseline + fuzz + analyze
- `mutate-allowlist.example.json`: explicit real-mutate allowlist

## Quick start

```powershell
python smoke-v3\run_full.py --cli-bin "node dist/index.js" --seed 20260421 --target-cases 1200
```

Enable small real-mutate sampling automatically:

```powershell
python smoke-v3\run_full.py --seed 20260421 --target-cases 1200 --auto-mutate-count 4
```

Outputs are written under `smoke-v3/results/`:

- `results-<timestamp>-seed<seed>.jsonl`
- `summary-<timestamp>-seed<seed>.json`
- `report-<timestamp>-seed<seed>.md`
- `feedback-<timestamp>-seed<seed>.md`

## Mutating safety

Real mutating commands are **disabled by default**.
Enable via:

```powershell
python smoke-v3\run_full.py --mutate-allowlist smoke-v3\mutate-allowlist.json
```

Allowlist rules:

- exact `deviceId`
- explicit `allowedCommands`
- optional `maxRuns` and `cooldownMs`
- non-listed commands auto-degrade to `--dry-run`
