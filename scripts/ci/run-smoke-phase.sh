#!/usr/bin/env bash
#
# Run one Daily-UI-Smoke-Test droid phase, retrying ONCE if the first attempt
# produced no usable output (a transient Droid-CLI no-op — the dominant
# false-alarm cause; manual re-runs consistently pass).
#
# Retry-safety: discarding the first attempt is safe because the verdict
# classifier (scripts/ci/assert-ui-smoke-results.ts) guarantees an `inconclusive`
# classification carries ZERO failure signal — so a retry can never drop a real
# FAIL.
#
# Why budget-fraction, not "fast": empirically a Droid-CLI no-op is NOT fast — it
# can spend 4–12 min before emitting `Plan is up-to-date.` (observed: baseline
# ~3.7 min, regression ~11 min). So elapsed time can't distinguish a no-op from a
# real run. Instead we gate on REMAINING budget: retry only if the first attempt
# used less than half the phase's step budget, leaving room for the retry. The
# GitHub step `timeout-minutes` is the hard cap on total wall time either way, so
# a retry can never exceed the phase/job budget — the fraction guard just avoids
# a pointless retry that would be killed immediately with no budget left.
#
# Usage:
#   run-smoke-phase.sh <prompt-file> <log-file> <phase-name> <exit-env-key> <retried-env-key>
#
# Env: SMOKE_PHASE_BUDGET_SECONDS — the phase's step timeout in seconds (keep in
#      sync with the step's timeout-minutes). 0/unset disables the budget guard
#      (retry on any inconclusive — used by local tests).
#
# Writes "<exit-env-key>=<n>" and "<retried-env-key>=true|false" to $GITHUB_ENV.

set -uo pipefail

PROMPT="$1"
LOG="$2"
PHASE="$3"
EXIT_KEY="$4"
RETRIED_KEY="$5"

BUDGET_SECONDS="${SMOKE_PHASE_BUDGET_SECONDS:-0}"

PHASE_EXIT=0
ELAPSED=0

run_once() {
  local start=$SECONDS
  droid exec --auto high -f "$PROMPT" --output-format text 2>&1 | tee "$LOG"
  PHASE_EXIT=${PIPESTATUS[0]}
  ELAPSED=$(( SECONDS - start ))
}

run_once
STATUS="$(npx tsx scripts/ci/assert-ui-smoke-results.ts --classify "$LOG" "$PHASE" "$PHASE_EXIT" 2>/dev/null || echo unknown)"

RETRIED=false
if [ "$STATUS" = "inconclusive" ]; then
  if [ "$BUDGET_SECONDS" -le 0 ] || [ "$ELAPSED" -lt $(( BUDGET_SECONDS / 2 )) ]; then
    echo "::warning::${PHASE} smoke phase produced no usable output in ${ELAPSED}s (likely a Droid-CLI no-op) — retrying once"
    run_once
    RETRIED=true
  else
    echo "::warning::${PHASE} smoke phase inconclusive after ${ELAPSED}s — not retrying (insufficient remaining budget of ${BUDGET_SECONDS}s)"
  fi
fi

echo "${EXIT_KEY}=${PHASE_EXIT}" >> "$GITHUB_ENV"
echo "${RETRIED_KEY}=${RETRIED}" >> "$GITHUB_ENV"
echo "${PHASE} phase complete (exit ${PHASE_EXIT}, retried=${RETRIED})"
