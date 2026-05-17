# Coverage Annotations

This file documents why certain source files are excluded from the coverage
denominator, and which in-scope sections remain structurally untestable.

## Hard-excluded from coverage denominator

These files are in `vitest.config.ts` `coverage.exclude` because they require
live external infrastructure that cannot be mocked at unit-test level:

| File | Reason |
|------|--------|
| `src/mcp/device-history.ts` | MCP streaming protocol — requires live MCP server |
| `src/mcp/events-subscription.ts` | MCP event subscription — requires live MCP server |
| `src/mqtt/client.ts` | MQTT broker required; class constructor immediately connects |
| `src/llm/providers/anthropic.ts` | Anthropic API key + live HTTPS endpoint required |
| `src/llm/providers/openai.ts` | OpenAI API key + live HTTPS endpoint required |

## In-denominator but structurally untestable sections

These sections remain in the coverage denominator but cannot be covered by
unit tests. They are accepted as permanent gaps.

| File | Lines / Area | Reason |
|------|-------------|--------|
| `src/commands/mcp.ts` | ~2364–2633 | MCP tool-call / resource protocol handlers — live MCP client required |
| `src/commands/rules.ts` | 800–985, 1001–1081 | `simulate` and `trace-explain` subcommands — full rules engine + LLM required |
| `src/status-sync/manager.ts` | WebSocket push path | Live SwitchBot WebSocket connection required |
| `src/policy/migrate.ts` | lines 21–52 | `MIGRATION_CHAIN` is empty; migration step functions exist but are unreachable until v0.3 schema lands |
