#!/usr/bin/env bash
# Test stub for cursor-agent. Records its invocation and writes a synthetic
# outcome.json so session-supervisor.sh can complete a happy-path run without
# the real binary installed. Driven by env vars:
#   AUTOPILOT_TEST_RECORD_FILE   path where invocation metadata is appended
#   AUTOPILOT_TEST_ARTIFACT_DIR  directory where outcome.json should be written
#   AUTOPILOT_TEST_EXIT_CODE     exit code to return (default 0)
#   AUTOPILOT_TEST_WRITE_OUTCOME if "1", write a successful outcome.json
set -euo pipefail

RECORD_FILE="${AUTOPILOT_TEST_RECORD_FILE:-/dev/null}"
ARTIFACT_DIR="${AUTOPILOT_TEST_ARTIFACT_DIR:-/tmp/autopilot-test}"
EXIT_CODE="${AUTOPILOT_TEST_EXIT_CODE:-0}"
WRITE_OUTCOME="${AUTOPILOT_TEST_WRITE_OUTCOME:-1}"

{
  echo "binary=cursor-agent"
  echo "argv=$*"
  echo "CURSOR_API_KEY=${CURSOR_API_KEY:-<unset>}"
  echo "AUTOPILOT_CLI=${AUTOPILOT_CLI:-<unset>}"
  echo "AUTOPILOT_CURSOR_MODEL=${AUTOPILOT_CURSOR_MODEL:-<unset>}"
  echo "stdin_first_line=$(head -n 1 || true)"
  echo "---"
} >> "$RECORD_FILE"

if [ "$WRITE_OUTCOME" = "1" ]; then
  mkdir -p "$ARTIFACT_DIR"
  cat > "$ARTIFACT_DIR/outcome.json" <<'JSON'
{"outcome":"fixed","failure_kind":null,"original_outcome":"fixed","exit_code":0}
JSON
fi

exit "$EXIT_CODE"
