# Example policy files

Four annotated `policy.yaml` shapes for common setups. Every file
validates against the v0.1 schema; every file documents *why* the
particular shape fits its use case, not just *what* the fields mean.
Field-level reference lives in
[`../../docs/policy-reference.md`](../../docs/policy-reference.md).

| File | Use case | Confirm posture |
|---|---|---|
| [`minimal.yaml`](./minimal.yaml) | Trust the defaults; just declare "policy is here" | CLI defaults (destructive always confirms) |
| [`cautious.yaml`](./cautious.yaml) | Shared household; confirm every mutation | Aggressive — turnOn/Off also confirm |
| [`permissive.yaml`](./permissive.yaml) | Solo power user; speed over prompts | Loose — reversible actions pre-approved |
| [`rental.yaml`](./rental.yaml) | Short-term rental / guest environment | Guest-safe — HVAC + scenes all confirm |

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
