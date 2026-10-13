# Example policy files

Five annotated `policy.yaml` shapes for common setups. All use v0.2,
the schema accepted by the current CLI. The first four leave automation off;
`automation.yaml` demonstrates enabled rules in dry-run mode. Every file
documents *why* the shape fits its use case, not just *what* the fields mean.
Field-level reference lives in
[`../../docs/policy-reference.md`](../../docs/policy-reference.md).

| File | Schema | Use case | Confirm posture |
| --- | --- | --- | --- |
| [`minimal.yaml`](./minimal.yaml) | v0.2 | Trust the defaults; just declare "policy is here" | CLI defaults; native destructive approval still applies |
| [`cautious.yaml`](./cautious.yaml) | v0.2 | Shared household; ask before mutations | Agent preference — turnOn/Off also confirm |
| [`permissive.yaml`](./permissive.yaml) | v0.2 | Solo power user; speed over prompts | Agent preference — reversible actions pre-approved |
| [`rental.yaml`](./rental.yaml) | v0.2 | Short-term rental / guest environment | Agent preference — HVAC + scenes all confirm |
| [`automation.yaml`](./automation.yaml) | v0.2 | Rule engine (`switchbot rules run`) | Defaults; every rule in `dry_run` mode |

## Picking one

Start with the closest match, then edit in your own `aliases` from
`switchbot devices list --format=tsv`. Validate before you rely on it:

```bash
mkdir -p ~/.config/openclaw/switchbot
cp examples/policies/cautious.yaml ~/.config/openclaw/switchbot/policy.yaml
# open in your editor, fill in aliases
switchbot policy validate
```

Exit code 0 means the shape is valid; anything else prints a
line-accurate error. `switchbot doctor --section policy` will report
the same state in one row so an AI agent can notice without running
validate explicitly.

## The destructive shortcut does not exist

Every file leaves destructive actions outside `never_confirm`; schema
preferences cannot disable the native guard. Quiet hours and extra confirmation
preferences are honored by agents, not blanket native CLI/MCP gates.
For destructive work in the default production profile, use the reviewed flow:
`plan save` → `plan review` → `plan approve` → `plan execute`.

## See also

- [`docs/policy-reference.md`](../../docs/policy-reference.md) — field
  reference for every top-level block
- [`docs/agent-guide.md`](../../docs/agent-guide.md) — how an AI agent
  should read and honour `policy.yaml`
- `switchbot policy --help` — CLI command help
