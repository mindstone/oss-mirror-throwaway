#!/usr/bin/env bash
# Test stub for the `timeout` command (not present on stock macOS). Strips the
# leading duration argument and execs the remaining command, preserving stdin
# so cursor-agent's prompt pipe still works.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "timeout-stub: usage: timeout DURATION CMD [ARGS...]" >&2
  exit 64
fi

# Discard the duration argument; tests do not exercise the timer.
shift

exec "$@"
