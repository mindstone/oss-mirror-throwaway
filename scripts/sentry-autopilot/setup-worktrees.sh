#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$HOME/src/rebel-app}"
STATE_DIR="${AUTOPILOT_STATE_DIR:-$HOME/sentry-autopilot}"
SLOT_COUNT="${AUTOPILOT_MAX_CONCURRENT:-3}"
HOOK_SRC="$REPO_ROOT/scripts/sentry-autopilot/hooks/pre-push"
HOOK_DIR="$STATE_DIR/hooks"

echo "Setting up Sentry Autopilot worktree pool..."
echo "  Repo root: $REPO_ROOT"
echo "  State dir: $STATE_DIR"
echo "  Slots: $SLOT_COUNT"

mkdir -p "$STATE_DIR/worktrees"
mkdir -p "$STATE_DIR/artifacts"
mkdir -p "$STATE_DIR/logs"
mkdir -p "$STATE_DIR/backups"
mkdir -p "$HOOK_DIR"

cd "$REPO_ROOT"
git fetch origin

# Enable per-worktree core.hooksPath. Without extensions.worktreeConfig=true the
# per-slot `core.hooksPath` is silently inherited from the superproject config,
# meaning the autopilot pre-push hook would never fire. Idempotent — setting
# the same boolean twice is a no-op.
git config --bool extensions.worktreeConfig true

# Install the autopilot pre-push hook into the shared state-dir hooks folder.
# Each slot points at this single source-of-truth path via core.hooksPath.
ln -sfn "$HOOK_SRC" "$HOOK_DIR/pre-push"
chmod +x "$HOOK_SRC"

for i in $(seq 0 $((SLOT_COUNT - 1))); do
  SLOT_DIR="$STATE_DIR/worktrees/slot-$i"
  if [ -d "$SLOT_DIR" ]; then
    echo "  Slot $i already exists at $SLOT_DIR, skipping worktree create"
  else
    echo "  Creating worktree slot $i at $SLOT_DIR..."
    git worktree add --detach "$SLOT_DIR"
    cd "$SLOT_DIR"
    git checkout --detach origin/dev
    cd "$REPO_ROOT"
    echo "  Slot $i ready"
  fi
  # (Re-)apply per-worktree core.hooksPath. Idempotent. Defense-in-depth:
  # freshenWorktree() in session-manager.ts also re-applies this after npm ci
  # because husky's `prepare` script clobbers core.hooksPath on install.
  git -C "$SLOT_DIR" config --worktree core.hooksPath "$HOOK_DIR"
done

# Validation: prove the hook actually fires from inside a worktree. Without
# this, a misconfigured extensions.worktreeConfig setting could silently
# bypass the hook in production. We feed a fake `refs/heads/main` push line
# into `git hook run pre-push` and require the hook to refuse it.
#
# Note: `git hook run` does NOT inherit shell-piped stdin — refspecs must
# be passed via `--to-stdin=<file>`. Earlier revisions piped via `|` and
# the hook silently received empty stdin, causing the validation to report
# success against any hook (working or not). See git-scm docs for `git hook run`.
VALIDATION_SLOT="$STATE_DIR/worktrees/slot-0"
VALIDATION_ERR="$(mktemp)"
VALIDATION_STDIN="$(mktemp)"
trap 'rm -f "$VALIDATION_ERR" "$VALIDATION_STDIN"' EXIT
printf 'refs/heads/dummy_local %s refs/heads/main %s\n' \
  '0000000000000000000000000000000000000000' \
  '0000000000000000000000000000000000000000' > "$VALIDATION_STDIN"
cd "$VALIDATION_SLOT"
if git hook run --to-stdin="$VALIDATION_STDIN" pre-push -- origin \
    "[external-email]:mindstone/rebel-app.git" 2>"$VALIDATION_ERR"; then
  echo "FAIL: pre-push hook accepted a push to main (validation against slot-0)" >&2
  cat "$VALIDATION_ERR" >&2
  exit 1
fi
if ! grep -q "refused" "$VALIDATION_ERR"; then
  echo "FAIL: pre-push hook did not emit a refusal message" >&2
  cat "$VALIDATION_ERR" >&2
  exit 1
fi
cd "$REPO_ROOT"

echo ""
echo "Worktree pool setup complete. Verify:"
git worktree list
