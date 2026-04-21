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
