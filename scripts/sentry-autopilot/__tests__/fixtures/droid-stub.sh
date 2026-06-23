#!/usr/bin/env bash
# Test stub for the droid CLI. Records invocation metadata and optionally
# writes a synthetic outcome.json. Mirrors cursor-agent-stub.sh so the same
# test harness can drive both runners.
set -euo pipefail

RECORD_FILE="${AUTOPILOT_TEST_RECORD_FILE:-/dev/null}"
ARTIFACT_DIR="${AUTOPILOT_TEST_ARTIFACT_DIR:-/tmp/autopilot-test}"
EXIT_CODE="${AUTOPILOT_TEST_EXIT_CODE:-0}"
WRITE_OUTCOME="${AUTOPILOT_TEST_WRITE_OUTCOME:-1}"

{
  echo "binary=droid"
  echo "argv=$*"
  echo "AUTOPILOT_CLI=${AUTOPILOT_CLI:-<unset>}"
  echo "---"
} >> "$RECORD_FILE"

if [ "$WRITE_OUTCOME" = "1" ]; then
  mkdir -p "$ARTIFACT_DIR"
  cat > "$ARTIFACT_DIR/outcome.json" <<'JSON'
{"outcome":"fixed","failure_kind":null,"original_outcome":"fixed","exit_code":0}
JSON
fi

exit "$EXIT_CODE"
