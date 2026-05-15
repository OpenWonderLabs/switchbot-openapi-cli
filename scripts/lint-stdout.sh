#!/usr/bin/env bash
# scripts/lint-stdout.sh
# Prevents diagnostic/debug messages from leaking into stdout.
# Legitimate table-mode output (human-readable results) is allowed.
# This catches the class of bugs where dry-run, debug, or warning text
# goes to console.log instead of console.error.
set -euo pipefail

cd "$(dirname "$0")/.."

errors=0

# 1. No dry-run messages on stdout (must use console.error)
hits=$(grep -rn 'console\.log.*dry.run\|console\.log.*◦' src/commands/ 2>/dev/null || true)
if [ -n "$hits" ]; then
  echo "ERROR: dry-run messages must use console.error, not console.log:"
  echo "$hits"
  errors=$((errors + 1))
fi

# 2. No bare Number() in param-validator validate* functions (must use parseStrictInt)
#    Excludes: parseStrictInt itself, build* functions (pre-validated), Number.isX checks
bare_number=$(grep -n 'Number(' src/devices/param-validator.ts | grep -v 'parseStrictInt\|Number.isInteger\|Number.isNaN\|Number.isFinite\|// number-ok\|function parseStrictInt' || true)
if [ -n "$bare_number" ]; then
  echo "WARNING: bare Number() in param-validator.ts — consider using parseStrictInt():"
  echo "$bare_number"
  echo "(add '// number-ok' comment to suppress if pre-validated)"
  echo ""
fi

# 3. Every registerXxxCommand in src/commands/ must have a test file
missing_tests=""
for cmd in $(grep -roh 'export function register\w\+Command' src/commands/ | sed 's/export function //' | sort -u); do
  if ! grep -rl "$cmd" tests/commands/ >/dev/null 2>&1; then
    missing_tests="$missing_tests  $cmd\n"
  fi
done
if [ -n "$missing_tests" ]; then
  echo "WARNING: commands without test coverage:"
  printf "$missing_tests"
  echo "(not blocking — add tests before next release)"
  echo ""
fi

if [ "$errors" -gt 0 ]; then
  echo ""
  echo "FAILED: $errors check(s) failed"
  exit 1
fi

echo "OK: all stdout/quality checks passed"
