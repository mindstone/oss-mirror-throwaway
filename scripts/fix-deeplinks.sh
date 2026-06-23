#!/usr/bin/env bash
#
# Fix deep link registration for dev mode when using multiple worktrees.
#
# macOS Launch Services can point mindstone:// and rebel:// deep links at the
# wrong worktree's Electron binary. This script:
#   1. Finds other worktrees that have an Electron binary
#   2. Removes their Electron dist (the source of the conflict)
#   3. Resets Launch Services to clear stale registrations
#   4. Tells you to restart `npm run dev` so the correct binary re-registers
#
# Usage:  scripts/fix-deeplinks.sh [--dry-run]
#
# See also: docs/project/GIT_WORKTREES.md — "OAuth deep links route to the
# wrong worktree (or do nothing) after switching worktrees" troubleshooting
# section for the full symptom/root-cause write-up.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      echo "Usage: scripts/fix-deeplinks.sh [--dry-run]"
      echo ""
      echo "Fixes deep link registration when multiple worktrees compete"
      echo "for mindstone:// and rebel:// protocol handlers."
      echo ""
      echo "Options:"
      echo "  --dry-run   Show what would be done without making changes"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 1
      ;;
  esac
done

echo "Current worktree: $REPO_ROOT"
echo ""

# Discover sibling worktrees by looking for Electron binaries in parent dir
PARENT_DIR="$(dirname "$REPO_ROOT")"
CURRENT_BASENAME="$(basename "$REPO_ROOT")"
CONFLICTING=()

for dir in "$PARENT_DIR"/*/; do
  dir="${dir%/}"
  basename="$(basename "$dir")"

  # Skip self
  [ "$basename" = "$CURRENT_BASENAME" ] && continue

  electron_dist="$dir/node_modules/electron/dist"
  if [ -d "$electron_dist" ]; then
    CONFLICTING+=("$electron_dist")
  fi
done

if [ ${#CONFLICTING[@]} -eq 0 ]; then
  echo "No conflicting Electron binaries found in sibling directories."
  echo "Deep links should be pointing at the correct worktree."
  echo ""
  echo "If deep links are still broken, try restarting 'npm run dev'."
  exit 0
fi

echo "Found ${#CONFLICTING[@]} conflicting Electron binary location(s):"
for path in "${CONFLICTING[@]}"; do
  echo "  - $path"
done
echo ""

if $DRY_RUN; then
  echo "[dry-run] Would remove the above directories."
  echo "[dry-run] Would reset Launch Services cache."
  echo "[dry-run] No changes made."
  exit 0
fi

# Remove conflicting Electron binaries
for path in "${CONFLICTING[@]}"; do
  echo "Removing: $path"
  rm -rf "$path"
done
echo ""

# Reset Launch Services to clear stale registrations
echo "Resetting Launch Services cache..."
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister \
  -kill -r -domain local -domain system -domain user 2>/dev/null || true
echo "Done."
echo ""

echo "Next steps:"
echo "  1. Restart 'npm run dev' in this worktree to re-register deep links"
echo "  2. If you need Electron in the other worktree later, run 'npm ci' there"
