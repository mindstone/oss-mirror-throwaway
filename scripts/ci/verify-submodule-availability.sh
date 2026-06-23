#!/usr/bin/env bash
# verify-submodule-availability.sh
#
# Verifies that all submodule commits referenced by the superproject are
# reachable on their respective remotes. Exits non-zero if any commit is
# missing — this prevents pushing a superproject that references unpushed
# submodule commits.
#
# Usage:
#   ./scripts/ci/verify-submodule-availability.sh
#
# In CI, configure git credentials (e.g. REBEL_TOKEN) BEFORE calling this
# script. Locally, it uses whatever git credentials are already configured.
#
# Reuses the verification pattern from .github/workflows/release.yml.

set -euo pipefail

echo "Checking submodule references..."
failed=0

# Get submodule info: path, URL, and expected SHA
while read -r line; do
  # Format: " <sha> <path> (<desc>)" or "-<sha> <path>" (uninitialized)
  sha=$(echo "$line" | awk '{print $1}' | sed 's/^[-+U]//')
  sm_path=$(echo "$line" | awk '{print $2}')

  # Get the remote URL for this submodule
  url=$(git config --file .gitmodules --get "submodule.${sm_path}.url" || echo "")

  if [ -z "$url" ]; then
    echo "WARNING: Could not find URL for submodule '$sm_path', skipping"
    continue
  fi

  echo "Checking $sm_path ($sha)..."

  # Quick check: is the SHA at a ref tip? (fast, no clone needed)
  if git ls-remote "$url" 2>/dev/null | grep -q "^${sha}"; then
    echo "  OK: $sm_path (ref tip match)"
    continue
  fi

  # SHA is not at a ref tip — it may be an ancestor commit.
  # Use the local submodule directory if initialized (has full remote-tracking data).
  verified=0

  # Clear GIT_DIR/GIT_WORK_TREE that git hooks may set — these override -C behavior
  unset GIT_DIR GIT_WORK_TREE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES 2>/dev/null || true

  if [ -d "$sm_path/.git" ] || [ -f "$sm_path/.git" ]; then
    # Fetch latest remote refs so we have current remote-tracking branches
    if git -C "$sm_path" fetch origin --quiet 2>/dev/null; then
      # Check if the SHA is an ancestor of any remote branch
      if git -C "$sm_path" merge-base --is-ancestor "$sha" origin/main 2>/dev/null || \
         git -C "$sm_path" branch -r --contains "$sha" 2>/dev/null | grep -q .; then
        verified=1
      fi
    fi
  fi

  # Fallback for CI: submodule dir not initialized (no .git).
  # Try fetching the specific commit directly from the remote URL.
  if [ "$verified" -eq 0 ]; then
    tmpdir=$(mktemp -d)
    if git init --bare "$tmpdir" >/dev/null 2>&1 && \
       git -C "$tmpdir" fetch --depth=1 "$url" "$sha" >/dev/null 2>&1; then
      verified=1
    fi
    rm -rf "$tmpdir"
  fi

  if [ "$verified" -eq 0 ]; then
    echo ""
    echo "ERROR: Submodule '$sm_path' references commit $sha which is not available on the remote."
    echo "This usually means you need to push the submodule first."
    echo ""
    echo "To fix:"
    echo "  1. cd $sm_path && git push origin HEAD"
    echo "  2. Then retry your push"
    echo ""
    echo "To prevent this in future, run: git config push.recurseSubmodules on-demand"
    echo ""
    failed=1
    continue
  fi

  echo "  OK: $sm_path"
done < <(git submodule status)

if [ "$failed" -eq 1 ]; then
  exit 1
fi

echo ""
echo "All submodule references are valid."

# --- Submodule pointer linearity check (warn-only) ---
# Detects non-linear submodule pointer advancement that may indicate
# a concurrent session overwrote the pointer. Warns but does not block.

upstream=$(git rev-parse --abbrev-ref @{upstream} 2>/dev/null || echo "")
if [ -n "$upstream" ]; then
  while read -r line; do
    sha=$(echo "$line" | awk '{print $1}' | sed 's/^[-+U]//')
    sm_path=$(echo "$line" | awk '{print $2}')

    # Get the remote's current pointer for this submodule
    remote_sha=$(git ls-tree "$upstream" -- "$sm_path" 2>/dev/null | awk '{print $3}')
    if [ -z "$remote_sha" ] || [ "$sha" = "$remote_sha" ]; then
      continue
    fi

    # Check if remote pointer is ancestor of local pointer (linear advancement)
    if ! git -C "$sm_path" merge-base --is-ancestor "$remote_sha" "$sha" 2>/dev/null; then
      echo ""
      echo -e "\033[33m⚠️  WARNING: Non-linear submodule pointer advancement for '$sm_path'\033[0m"
      echo "   Remote pointer: $remote_sha"
      echo "   Local pointer:  $sha"
      echo "   The local pointer is NOT a descendant of the remote pointer."
      echo "   This may indicate a concurrent session overwrote the pointer."
      echo "   If this is intentional (e.g., reverting), proceed safely."
      echo ""
    fi
  done < <(git submodule status)
fi
