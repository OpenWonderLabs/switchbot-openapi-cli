# Example policy files

Five annotated `policy.yaml` shapes for common setups. The first four
validate against v0.1 (the current default for `switchbot policy new`).
`automation.yaml` is v0.2 — it's the shape you migrate to when you want
the `switchbot rules run` engine (preview). Every file documents *why*
the particular shape fits its use case, not just *what* the fields mean.
Field-level reference lives in
[`../../docs/policy-reference.md`](../../docs/policy-reference.md).

| File | Schema | Use case | Confirm posture |
|---|---|---|---|
| [`minimal.yaml`](./minimal.yaml) | v0.1 | Trust the defaults; just declare "policy is here" | CLI defaults (destructive always confirms) |
| [`cautious.yaml`](./cautious.yaml) | v0.1 | Shared household; confirm every mutation | Aggressive — turnOn/Off also confirm |
| [`permissive.yaml`](./permissive.yaml) | v0.1 | Solo power user; speed over prompts | Loose — reversible actions pre-approved |
| [`rental.yaml`](./rental.yaml) | v0.1 | Short-term rental / guest environment | Guest-safe — HVAC + scenes all confirm |
| [`automation.yaml`](./automation.yaml) | v0.2 | Rule engine preview (`switchbot rules run`) | Defaults; every rule in `dry_run` mode |

## Picking one

Start with the closest match, then edit in your own `aliases` from
`switchbot devices list --format=tsv`. Validate before you rely on it:

```bash
cp examples/policies/cautious.yaml ~/.config/openclaw/switchbot/policy.yaml
# open in your editor, fill in aliases
switchbot policy validate
```

Exit code 0 means the shape is valid; anything else prints a
line-accurate error. `switchbot doctor --section policy` will report
the same state in one row so an AI agent can notice without running
validate explicitly.

## The destructive shortcut does not exist

Every file leaves `lock` / `unlock` / `deleteWebhook` / `deleteScene` /
`factoryReset` under the default confirmation gate. The schema forbids
putting those actions in `never_confirm`, and this isn't a restriction
we intend to lift — no YAML edit should be able to silently disable
the unlock prompt. If you want an agent to unlock the front door
without a prompt, type "yes" at the prompt.

## See also

- [`docs/policy-reference.md`](../../docs/policy-reference.md) — field
  reference for every top-level block
- [`docs/agent-guide.md`](../../docs/agent-guide.md) — how an AI agent
  should read and honour `policy.yaml`
- `switchbot policy --help` — CLI command help
