# Contributing

Conventions for maintainers of `@switchbot/openapi-cli`.

## Publishing a release

When cutting a new version (tag + GitHub Release):

- **Release title**: the version number only (e.g. `v2.5.1`). No tagline,
  no descriptor like "Bug fixes and improvements".
- **Release body**: keep it minimal. One or two sentences on what ships,
  a single line calling out any breaking change, and a link to the
  matching section in [`CHANGELOG.md`](./CHANGELOG.md) for the full
  notes. Do not copy the CHANGELOG into the release body — the link is
  the source of truth and keeps the Releases page scannable.
- No emojis, marketing copy, or "thank you" boilerplate.

Example body:

> Round-2 + Round-3 smoke-test response — 24 bugs closed in one patch.
>
> **Breaking**: `--filter` grammar unified across `devices list`,
> `devices batch`, `events tail` / `mqtt-tail`. See CHANGELOG §Changed
> (BREAKING) for migration.
>
> Full notes: [CHANGELOG.md](./CHANGELOG.md#251---2026-04-20)

The CHANGELOG itself follows Keep a Changelog + SemVer, with a
**Changed (BREAKING)** section whenever a release introduces a breaking
change (even in a patch version).

## Plugin setup strategies

The two plugin packages use different setup strategies — this is intentional:

| Package | Setup strategy | Reason |
| --- | --- | --- |
| `packages/claude-code-plugin` | `node ../bin/auth.js` (relative path) | Claude Code installs the full npm package; `bin/` is always adjacent. |
| `packages/codex-plugin` | Explicit `switchbot codex setup` | Codex does not expose an install-time hook event. Its hook config accepts lifecycle hooks under `hooks`, but rejects a top-level `onInstall` field. |

Keep the Claude Code relative hook unless its full-package installation layout
changes. Keep the Codex plugin manifests hook-free until Codex exposes a
supported install-time event; do not add a top-level `onInstall` hook.

When Codex hook support changes, verify both the package-root and nested
`plugins/switchbot/` marketplace layouts, then run
`npm run smoke:codex-pack-install`.
