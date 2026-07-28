# Testing Conventions

This document defines the three rules that prevent the class of bugs identified
in the v3.6.2 post-mortem. Each rule maps to a specific root cause.

---

## Rule 1 — Every `process.exit` path needs its own test

Every `process.exit(1)` or `process.exit(2)` call in `src/commands/` must have
at least one test case in `tests/commands/` that reaches that path and asserts
`exitCode`. New exit branches must be tested in the same commit.

**Why:** v3.6.2 shipped `plan suggest` with a missing-argument branch that exited
with code 1 instead of 2. The existing test only exercised a different branch in
the same command, leaving the new branch invisible to CI.

---

## Rule 2 — Every new CLI option/alias needs a smoke test

Every new `.option()` declaration (including aliases) must have at least one test
that uses the flag and asserts it is parsed or produces the expected behavior.

**Why:** The `--devices` plural alias for `plan suggest` shipped with zero test
coverage. Any rename or collision would have been silent.

---

## Rule 3 — Non-trivial user-visible messages need keyword assertions

Any `console.log/error` line containing a business-semantic keyword — one whose
removal would confuse the user — must have a corresponding test asserting that
keyword appears in `stdout` or `stderr`.

**Why:** The doctor MCP tool-count message and quota reset-time line were changed
without any test catching the change, because tests only checked numeric structure,
not message content.

---

## PR Checklist

Before merging, verify:

- [ ] New `process.exit` path → corresponding test added
- [ ] New CLI option/alias → smoke test added
- [ ] Changed user-visible message → keyword assertion updated
