#!/usr/bin/env bash
#
# Post-init hook for new git worktrees. Invoked by
# coding-agent-instructions/scripts/init-worktree.sh after `git worktree add`
# (and the optional fetch+merge-at-init) completes.
#
# Runs inside the new worktree's directory.
#
# All steps are synchronous so init-worktree.sh only exits when the worktree
# is fully ready. CE2's Phase 0 next steps (`scripts/init.ts`, Static
# Analysis specialist setup) need `node_modules` populated — backgrounding
# npm ci was a footgun, so it's been eliminated.

set -euo pipefail

# Belt-and-braces: ensure we run from the worktree root regardless of
# where the caller invoked us from. init-worktree.sh already cd's via a
# subshell, but a user running this directly from a subdir would
# otherwise pick up the wrong package.json.
cd "$(git rev-parse --show-toplevel)"

# net_retry — timeout + bounded-retry wrapper for network ops.
#
# WHY: a bare `git submodule update` has NO transfer timeout, so a single
# stalled SSH clone (GitHub throttling concurrent clones, a transient blip)
# hangs this init INDEFINITELY and silently — an incident cost a ~3-hour wedge
# (0% CPU) that should have been a fast retry. Time the stalled attempt out,
# kill its process group (child git/ssh die too — no orphans), retry.
#
# Inlined (not sourced from coding-agent-instructions/scripts/lib/net-retry.sh)
# ON PURPOSE: this runs BEFORE that submodule is checked out — it IS the script
# that checks it out. Keep behaviourally in sync with that file. bash 3.2-safe.
# Select a GNU-style timeout binary, but only if it supports `-k` (so an
# arbitrary non-GNU `timeout` on PATH isn't chosen). Empty => bash fallback.
_NET_RETRY_TIMEOUT_BIN=""
for _cand in timeout gtimeout; do
  if command -v "$_cand" >/dev/null 2>&1 && "$_cand" -k 1 1 true >/dev/null 2>&1; then
    _NET_RETRY_TIMEOUT_BIN="$_cand"; break
  fi
done
unset _cand

net_retry() {
  local timeout_secs="$1" max_attempts="$2" label="$3"; shift 3
  [ "${1:-}" = "--" ] && shift
  local attempt=1 rc=0
  while [ "$attempt" -le "$max_attempts" ]; do
    echo "[net_retry] $label: attempt $attempt/$max_attempts (timeout ${timeout_secs}s)" >&2
    # rc capture is `if cmd; then rc=0; else rc=$?; fi` (not `cmd; rc=$?`) so the
    # surrounding `set -e` does not abort on a failed attempt before we retry.
    if [ -n "$_NET_RETRY_TIMEOUT_BIN" ]; then
      if "$_NET_RETRY_TIMEOUT_BIN" -k 10 "$timeout_secs" "$@"; then rc=0; else rc=$?; fi
    else
      # Fallback: own process group + poll the leader, then escalate
      # TERM -> grace -> KILL on the GROUP from the main path (not a racing
      # background watchdog) so the KILL phase always runs even if the leader
      # exits on TERM but a child ignores it. Restore the caller's monitor mode.
      local had_m=0; case "$-" in *m*) had_m=1 ;; esac
      set -m 2>/dev/null || true
      "$@" &
      local cmd_pid=$! waited=0
      while [ "$waited" -lt "$timeout_secs" ] && kill -0 "$cmd_pid" 2>/dev/null; do
        sleep 1; waited=$((waited + 1))
      done
      if kill -0 "$cmd_pid" 2>/dev/null; then
        kill -TERM "-$cmd_pid" 2>/dev/null || kill -TERM "$cmd_pid" 2>/dev/null
        local k=0
        while [ "$k" -lt 10 ] && kill -0 "$cmd_pid" 2>/dev/null; do sleep 1; k=$((k + 1)); done
        kill -KILL "-$cmd_pid" 2>/dev/null || kill -KILL "$cmd_pid" 2>/dev/null
        wait "$cmd_pid" 2>/dev/null || true
        rc=124
      else
        if wait "$cmd_pid"; then rc=0; else rc=$?; fi
      fi
      [ "$had_m" -eq 1 ] || set +m 2>/dev/null || true
    fi
    if [ "$rc" -eq 0 ]; then return 0; fi
    echo "[net_retry] $label: attempt $attempt failed (rc=$rc)" >&2
    if [ "$attempt" -lt "$max_attempts" ]; then sleep $((attempt * 3)); fi
    attempt=$((attempt + 1))
  done
  echo "[net_retry] $label: all $max_attempts attempts failed (rc=$rc)" >&2
  if [ -z "$_NET_RETRY_TIMEOUT_BIN" ]; then
    echo "[net_retry] (no timeout/gtimeout with -k found — install coreutils for the most robust child-process kill)" >&2
  fi
  return "$rc"
}

echo "[worktree-postinit] Initialising submodules..."
# SHARE submodule objects with the primary checkout via git alternates (--reference).
#
# WHY: git does NOT share submodule object stores across worktrees. Each worktree
# otherwise re-fetches every submodule over the network (~390MB for
# coding-agent-instructions alone) AND keeps its own full on-disk copy (N worktrees ×
# ~390MB — this was the bulk of a 30GB .git). Pointing each worktree's submodule clone
# at the primary checkout's existing store (.git/modules/<name>) borrows those objects
# locally: no bulk network transfer (measured: finishes in seconds even on a degraded
# connection) and ~4–32KB per worktree instead of ~390MB.
#
# ALTERNATE SAFETY: a --reference borrower only breaks if the alternate prunes an
# object the borrower still needs. git gc prunes ONLY UNREACHABLE objects; submodule
# SHAs are pinned to commits on the submodule's main and stay reachable from
# origin/main, so they are not pruned in normal operation. The sole break case is a
# submodule history-rewrite that orphans a pinned SHA followed by a prune in the
# primary store — rare for these append-only repos, fails LOUD (missing-object error),
# and recovers with `git -C <submodule> fetch`. For full independence on copy-on-write
# filesystems there is a validated reflink-dissociate option — see
# docs/project/GIT_WORKTREES.md ("Submodule object sharing"). Escape hatch: set
# REBEL_WORKTREE_NO_SUBMODULE_REFERENCE=1 to force plain network clones.
#
# The loop is serial (vs the old --jobs 4): the referenced path is local + fast, so
# parallelism only mattered when four full network clones raced — which the reference
# eliminates. Only the rare cold-machine fallback (no primary store yet) clones over
# the network.
primary_common=""
if [[ "${REBEL_WORKTREE_NO_SUBMODULE_REFERENCE:-}" != "1" ]]; then
  # From inside a worktree this resolves to the ABSOLUTE primary .git (where the
  # shared .git/modules/<name> stores live). Empty -> fall back to plain clones.
  primary_common="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
fi

while IFS= read -r _sm_line; do
  [[ -n "$_sm_line" ]] || continue
  # Each line is: "submodule.<name>.path <path>". The alternate lives at
  # .git/modules/<name>, keyed by submodule NAME (== path here, but derived properly).
  _sm_key="${_sm_line%% *}"; _sm_path="${_sm_line#* }"
  _sm_name="${_sm_key#submodule.}"; _sm_name="${_sm_name%.path}"
  _sm_store="$primary_common/modules/$_sm_name"
  if [[ -n "$primary_common" && -d "$_sm_store/objects" ]]; then
    echo "[worktree-postinit]   $_sm_name: borrowing objects from primary store (--reference)."
    net_retry 300 3 "submodule update $_sm_name" -- \
      git submodule update --init --reference "$_sm_store" -- "$_sm_path"
  else
    echo "[worktree-postinit]   $_sm_name: no primary store — cloning over the network."
    net_retry 300 3 "submodule update $_sm_name" -- \
      git submodule update --init -- "$_sm_path"
  fi
done < <(git config -f .gitmodules --get-regexp '^submodule\..*\.path$' 2>/dev/null || true)

# Final pass: initialise any NESTED submodules (none today; clones normally if added)
# and verify every top-level submodule is at its pinned SHA — a no-op for the ones
# initialised above (objects already present via the alternate, so no network).
net_retry 300 3 "git submodule update --init --recursive" -- \
  git submodule update --init --recursive

# Dependency install — root AND subprojects. The root install does NOT install
# subproject deps (no workspaces), and ALL subprojects are populated by default
# because the pre-push `validate:ts-ratchet` type-checks every one of them: a
# worktree missing any subproject's node_modules fails the push with thousands of
# phantom `TS2307: Cannot find module` errors (e.g. ~1899 in mobile), even for a
# core/main-only change. Skipping them was a recurring footgun, so the default is
# install-all. Set REBEL_WORKTREE_SKIP_SUBPROJECTS=1 to skip the optional
# subprojects (root + browser-extension always install).
#
# FAST PATH — fingerprint-keyed copy-on-write (CoW) template cache.
# `npm ci` writes ~2.8 GB of FRESH blocks per worktree (measured: it does NOT
# reflink from the npm cache), so N worktrees cost N×2.8 GB and the disk fills up.
# Instead we `npm ci` ONCE per unique install fingerprint, publish that verified
# tree into a shared cache, and CoW-clone it into every later worktree (~26 MB
# real disk + seconds, vs ~2.8 GB + ~25 s).
#
# Correctness (this is what got the 260611 attempt reverted — see
# PLAN_HARRY_REVERT_260611.md): we do NOT clone from the mutable primary checkout,
# whose installed tree routinely lags its own lockfile. Each cache entry is a copy
# of a VERIFIED in-worktree `npm ci` (so repo-context postinstall patches are baked
# in), keyed by a full install fingerprint (scripts/dependency-install-fingerprint.mjs:
# lockfile + install lifecycle scripts + node/npm/platform/arch). ANY uncertainty —
# no fingerprint, cache miss, non-reflink FS, clone error, failed smoke — falls back
# to a plain in-worktree `npm ci`, today's authoritative behaviour. The cache only
# ever makes things faster/cheaper, never less correct. Opt out: set
# REBEL_WORKTREE_NO_NM_CACHE=1 (forces npm ci); relocate: REBEL_WORKTREE_NM_CACHE=<dir>.
NM_CACHE_DIR="${REBEL_WORKTREE_NM_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/rebel-worktree-nm}"

# clone_tree SRC DEST — CoW-clone a directory, or return non-zero if the filesystem
# cannot share blocks (so the caller falls back to npm ci). APFS clonefile (`cp -c`)
# / Linux reflink=ALWAYS — never `=auto`, which silently does a full copy on an
# unsupported FS, defeating the disk win (review F5). A non-zero exit IS the
# "blocks not shared on this FS/volume" probe result.
clone_tree() {
  local src="$1" dest="$2"
  case "$(uname -s)" in
    Darwin)
      # clonefile(2) needs src + dest on the SAME APFS volume. `cp -c` does NOT error
      # cross-device — per `man cp` it silently falls back to a full copyfile(2), which
      # would defeat the disk win while logging success (review S1). So probe same-device
      # first (dest doesn't exist yet → check its parent); mismatch → fall back to npm ci.
      [[ "$(stat -f %d "$src" 2>/dev/null)" == "$(stat -f %d "$(dirname "$dest")" 2>/dev/null)" ]] || return 1
      cp -c -R "$src" "$dest" ;;
    Linux)  cp -a --reflink=always "$src" "$dest" ;;  # errors (no silent full copy) if unsupported
    *) return 1 ;;
  esac
}

# nm_fingerprint DIR — echo the install fingerprint, or empty string on any failure.
nm_fingerprint() {
  node scripts/dependency-install-fingerprint.mjs "$1" 2>/dev/null || true
}

# nm_write_sentinel DIR FP — record the fingerprint inside node_modules so Stage 1's
# scripts/ensure-deps-fresh.mjs sees a fresh install (no spurious first-launch ci).
nm_write_sentinel() {
  local dir="$1" fp="$2"
  [[ -n "$fp" && -d "$dir/node_modules" ]] || return 0
  printf '%s\n' "$fp" > "$dir/node_modules/.rebel-deps-fingerprint" 2>/dev/null || true
  return 0
}

# nm_smoke DIR — cheap structural check that a (cloned) node_modules is intact.
# NOT a full `require()`: native modules here are built for Electron's ABI and won't
# load under plain `node`. cp's exit code already rules out a partial copy; this
# guards against an empty/garbled tree slipping into a worktree.
nm_smoke() {
  local dir="$1" shim
  [[ -d "$dir/node_modules" ]] || return 1
  [[ -f "$dir/node_modules/.package-lock.json" ]] || return 1
  if [[ -d "$dir/node_modules/.bin" ]]; then
    for shim in "$dir/node_modules/.bin"/*; do
      [[ -e "$shim" ]] && return 0   # -e follows the symlink: target file exists
    done
    return 1   # .bin present but every shim dangles → broken clone
  fi
  return 0   # no .bin (some subprojects) is fine
}

# nm_cache_try_hit DIR LABEL FP — restore node_modules from the cache via CoW clone.
# Returns 0 on a verified hit, 1 on miss/failure (caller then npm ci's).
nm_cache_try_hit() {
  local dir="$1" label="$2" fp="$3" entry
  [[ -n "$fp" ]] || return 1
  entry="$NM_CACHE_DIR/$fp"
  [[ -f "$entry/COMPLETE" && -d "$entry/node_modules" ]] || return 1
  rm -rf "$dir/node_modules" 2>/dev/null || true
  if clone_tree "$entry/node_modules" "$dir/node_modules" 2>/dev/null && nm_smoke "$dir"; then
    touch "$entry" 2>/dev/null || true   # keep hot entries alive against TTL prune
    nm_write_sentinel "$dir" "$fp"
    echo "[worktree-postinit] $label: restored from CoW cache (fingerprint ${fp:0:12}) ✓"
    return 0
  fi
  rm -rf "$dir/node_modules" 2>/dev/null || true   # discard partial; fall back to npm ci
  echo "[worktree-postinit] $label: cache clone unavailable — falling back to npm ci." >&2
  return 1
}

# nm_cache_ensure_dir — create the cache dir and (macOS) exclude it from Time Machine.
# Cache entries are the same multi-GB-apparent trees init-worktree.sh already excludes
# for worktrees; backups can't see CoW sharing, so an unexcluded cache bloats them
# (review S4). Sticky exclusion on the parent survives entry churn.
nm_cache_ensure_dir() {
  mkdir -p "$NM_CACHE_DIR" 2>/dev/null || return 1
  if [[ "$(uname -s)" == "Darwin" ]] && command -v tmutil >/dev/null 2>&1; then
    case "$(tmutil isexcluded "$NM_CACHE_DIR" 2>/dev/null)" in
      *'[Excluded]'*) : ;;                                   # already excluded
      *) tmutil addexclusion "$NM_CACHE_DIR" 2>/dev/null || true ;;
    esac
  fi
  return 0
}

# nm_cache_publish DIR LABEL FP — publish a verified install into the cache. Best-effort
# and non-blocking: never delays worktree init, never fails the run.
nm_cache_publish() {
  local dir="$1" label="$2" fp="$3" entry lock staging
  [[ -n "$fp" && -d "$dir/node_modules" ]] || return 0
  entry="$NM_CACHE_DIR/$fp"
  [[ -f "$entry/COMPLETE" ]] && return 0           # already cached
  nm_cache_ensure_dir || return 0
  lock="$NM_CACHE_DIR/.lock-$fp"
  # Non-blocking lock (mkdir is atomic): if another worktree is publishing this fp,
  # skip — never block init on cache population.
  if ! mkdir "$lock" 2>/dev/null; then
    [[ -f "$entry/COMPLETE" ]] && return 0   # someone already finished — done
    # Stale-lock recovery: a killed publisher leaves .lock-$fp behind forever, which
    # would permanently prevent this fingerprint from ever being cached. If the lock is
    # older than the TTL, steal it (best-effort, non-blocking).
    local lock_ttl_min="${REBEL_WORKTREE_NM_CACHE_LOCK_TTL_MIN:-30}"
    # Steal ATOMICALLY: rename the stale lock away. Only one racer's `mv` can succeed
    # (the loser's source is already gone), so two processes can't both think they stole
    # it (review N1). Winner discards the stale dir and recreates a lock it owns; if a
    # fresh publisher grabbed it in between, our mkdir fails → we back off.
    if [[ -n "$(find "$lock" -maxdepth 0 -mmin +"$lock_ttl_min" 2>/dev/null)" ]] \
       && mv "$lock" "$lock.stale-$$" 2>/dev/null; then
      rm -rf "$lock.stale-$$" 2>/dev/null || true
      mkdir "$lock" 2>/dev/null || return 0
    else
      return 0
    fi
  fi
  if [[ -f "$entry/COMPLETE" ]]; then rmdir "$lock" 2>/dev/null || true; return 0; fi
  staging="$NM_CACHE_DIR/.staging-$fp-$$"
  rm -rf "$staging" 2>/dev/null || true
  # touch is guarded into the chain: publish is best-effort, so a failed touch must NOT
  # abort post-init under `set -euo pipefail` (GPT review F3).
  if mkdir -p "$staging" 2>/dev/null \
     && clone_tree "$dir/node_modules" "$staging/node_modules" 2>/dev/null \
     && touch "$staging/COMPLETE" 2>/dev/null; then
    # Atomic publish via rename (within one FS). If the entry appeared meanwhile, drop ours.
    if [[ ! -e "$entry" ]] && mv "$staging" "$entry" 2>/dev/null; then
      echo "[worktree-postinit] $label: published to CoW cache (fingerprint ${fp:0:12})."
    else
      rm -rf "$staging" 2>/dev/null || true
    fi
  else
    rm -rf "$staging" 2>/dev/null || true
  fi
  rmdir "$lock" 2>/dev/null || true
  return 0
}

# nm_cache_prune — bound cache growth. Remove entries untouched for >TTL days. Safe by
# construction: APFS/reflink CoW clones keep their own blocks after the source entry is
# deleted, so pruning NEVER breaks an existing worktree. Conservative + best-effort (F4).
nm_cache_prune() {
  [[ -d "$NM_CACHE_DIR" ]] || return 0
  local ttl="${REBEL_WORKTREE_NM_CACHE_TTL_DAYS:-21}" e fp trash
  while IFS= read -r e; do
    [[ -n "$e" ]] || continue
    fp="$(basename "$e")"
    [[ -d "$NM_CACHE_DIR/.lock-$fp" ]] && continue   # don't prune an entry being built
    # De-publish ATOMICALLY before deleting: an interrupted in-place `rm -rf` of a
    # ~100k-file tree could leave a COMPLETE marker over a gutted node_modules that a
    # later hit would clone as silently-broken deps (review S2). Rename the whole entry
    # out of the hit namespace first (atomic, same FS), THEN delete the inert leftover.
    trash="$NM_CACHE_DIR/.trash-$fp-$$"
    if mv "$e" "$trash" 2>/dev/null; then
      rm -rf "$trash" 2>/dev/null || true
    fi
  done < <(find "$NM_CACHE_DIR" -maxdepth 1 -type d -name '[0-9a-f][0-9a-f]*' -mtime +"$ttl" 2>/dev/null)
  # Sweep orphaned dot-dirs (a publisher killed mid-clone leaks .staging-*; a never-
  # re-published fingerprint leaks .lock-*; interrupted prune leaves .trash-*). One day
  # comfortably exceeds any legitimate publish (lock TTL is 30 min) (review S3).
  while IFS= read -r e; do
    [[ -n "$e" ]] && rm -rf "$e" 2>/dev/null || true
  done < <(find "$NM_CACHE_DIR" -maxdepth 1 -type d \
             \( -name '.staging-*' -o -name '.trash-*' -o -name '.lock-*' \) \
             -mmin +$((60*24)) 2>/dev/null)
  return 0
}

ensure_node_modules() {
  local dir="$1" label="$1"
  [[ "$dir" == "." ]] && label="(root)"
  if [[ ! -f "$dir/package.json" || ! -f "$dir/package-lock.json" ]]; then
    # The root is mandatory: a missing lockfile is a broken checkout and must
    # fail loud. Optional subprojects with no lockfile are nothing-to-install.
    if [[ "$dir" == "." ]]; then
      echo "[worktree-postinit] FATAL: root package.json/package-lock.json missing — cannot install root dependencies." >&2
      exit 1
    fi
    return 0
  fi

  local fp; fp="$(nm_fingerprint "$dir")"
  local use_cache=1; [[ "${REBEL_WORKTREE_NO_NM_CACHE:-}" == "1" ]] && use_cache=0

  if [[ "$use_cache" == "1" && -n "$fp" ]]; then
    if nm_cache_try_hit "$dir" "$label" "$fp"; then
      # A cache hit skipped npm's lifecycle scripts. `npm ci` would have run the root
      # `prepare` (husky → .husky/_ hook shims, which live OUTSIDE node_modules and a
      # clone doesn't carry); without it this worktree silently loses its pre-commit
      # (TruffleHog/leak) and pre-push gate hooks (review M1). Re-run prepare explicitly.
      # Unguarded for parity: npm ci would also have failed init if prepare failed.
      # --if-present makes it a no-op for subprojects (none define prepare).
      npm --prefix "$dir" run prepare --if-present
      return 0
    fi
  fi

  echo "[worktree-postinit] $label: npm ci..."
  # Generous 20min timeout: only kills a truly-wedged registry fetch, not a slow
  # (but progressing) install; net_retry's 2 attempts ride out a transient blip.
  # Without it a stalled registry/SSH transfer could hang init indefinitely.
  net_retry 1200 2 "$label npm ci" -- npm --prefix "$dir" ci --prefer-offline --no-audit --no-fund

  # Memoize the fingerprint sentinel (for Stage 1) and publish this verified install
  # into the cache for future worktrees. Both best-effort, never fatal.
  if [[ -n "$fp" ]]; then
    nm_write_sentinel "$dir" "$fp"
    if [[ "$use_cache" == "1" ]]; then
      nm_cache_publish "$dir" "$label" "$fp"
    fi
  fi
  return 0
}

echo "[worktree-postinit] Installing root dependencies..."
ensure_node_modules "."

# Mandatory (validate:fast builds it):
ensure_node_modules "packages/browser-extension"

# All other subprojects: default-ON (cheap via CoW cache after the first build),
# opt-out for the rare worktree that genuinely won't push / won't run the ratchet.
if [[ "${REBEL_WORKTREE_SKIP_SUBPROJECTS:-}" == "1" ]]; then
  echo "[worktree-postinit] REBEL_WORKTREE_SKIP_SUBPROJECTS=1 — skipping cloud-client, cloud-service, mobile, web-companion."
  echo "[worktree-postinit]   Their node_modules will be ABSENT; validate:ts-ratchet (pre-push) will phantom-fail until you install them."
else
  ensure_node_modules "cloud-client"
  ensure_node_modules "cloud-service"
  ensure_node_modules "mobile"
  ensure_node_modules "web-companion"
fi

# Bound CoW-cache growth (best-effort; safe even while worktrees reference entries).
nm_cache_prune

# super-mcp is built on demand by the pre-push gate's validate:super-mcp-build.

# .env.local reminder. Multiple worktrees running `npm run dev` collide on
# ELECTRON_RENDERER_PORT — each worktree needs its own ≥5184. We don't
# auto-scaffold because picking a safe port requires scanning sibling
# worktrees' .env.local files and we'd rather not silently pick something
# that surprises the user. Just remind.
if [[ ! -f .env.local ]]; then
  cat <<'EOF'

[worktree-postinit] REMINDER: no .env.local in this worktree.

If you'll run `npm run dev` here (or another dev server), create
.env.local with a unique port:

    ELECTRON_RENDERER_PORT=5184    # >=5184; increment to avoid sibling collisions

See docs/project/GIT_WORKTREES.md "Running multiple dev servers" for the
port-allocation policy.

EOF
fi

echo "[worktree-postinit] Done."
