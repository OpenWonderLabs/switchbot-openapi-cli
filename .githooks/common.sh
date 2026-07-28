#!/usr/bin/env sh
# Windows: Git Bash clears COMSPEC, which causes npm's child_process.spawn to
# receive an undefined shell path and fail with ERR_INVALID_ARG_TYPE.
if [ -z "${COMSPEC:-}" ] && [ -f "/c/Windows/System32/cmd.exe" ]; then
  COMSPEC="C:\\Windows\\System32\\cmd.exe"
  export COMSPEC
fi
