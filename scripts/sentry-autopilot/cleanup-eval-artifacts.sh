#!/usr/bin/env bash
# Delete `autopilot/sentry-SYN-*` branches left behind by pre-Stage A.5 eval runs.
#
# Pre-Stage A.5 (Stage 5.6 Stage A.5 added AUTOPILOT_EVAL_MODE), the outcome-shape
# eval harness spawned the runner (`droid exec` / `cursor-agent`) with cwd=process.cwd() (the host repo), and the
# bug-fixer prompt told the agent to `git checkout -B autopilot/sentry-<id>` and
# commit `plan.md`. Each eval invocation thus polluted the host repo with one
# synthetic branch + one planning-doc commit.
#
# Stage A.5 prevents new pollution. This script cleans up the historic damage.
#
# Operator-driven (not invoked by the harness) — gated on explicit `yes` confirmation.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

branches="$(git branch --list 'autopilot/sentry-SYN-*' | sed 's/^[ *]*//')"

if [[ -z "$branches" ]]; then
  echo "No autopilot/sentry-SYN-* branches to clean."
  exit 0
fi

echo "The following synthetic eval-leak branches will be DELETED locally:"
echo "$branches" | sed 's/^/  - /'
echo
echo "These are eval invocations responding to fixture IDs (SYN-10, SYN-22, etc.)"
echo "as if they were real Sentry issues. They contain at most 1 planning-doc commit"
echo "each and add no real code value. They are local-only (never pushed to origin)."
echo
read -r -p "Proceed with deletion? (yes/no): " confirm

if [[ "$confirm" != "yes" ]]; then
  echo "Aborted."
  exit 0
fi

# shellcheck disable=SC2086
echo "$branches" | xargs -n1 git branch -D

echo
echo "Done. Removed $(echo "$branches" | wc -l | tr -d ' ') branch(es)."
