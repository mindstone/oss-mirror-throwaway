---
description: "Mindstone Rebel worktree guide — setup flow, post-init hooks, dev-server ports, login pitfalls, and worktree-specific gotchas"
last_updated: "2026-05-27"
---

# Git worktrees

Mindstone-Rebel-specific worktree gotchas. The general per-session
worktree setup model (integration branch, init script, post-init hook,
cleanup) lives in
[PROJECT_OVERRIDES2.md § Worktree Setup](./PROJECT_OVERRIDES2.md#worktree-setup);
the cross-repo schema lives in
[PROJECT_OVERRIDES_TEMPLATE.md § Worktree Setup](../../coding-agent-instructions/PROJECT_OVERRIDES_TEMPLATE.md#worktree-setup).


## Working flow

Provision a worktree from the primary checkout with
[`coding-agent-instructions/scripts/init-worktree.sh <slug>`](../../coding-agent-instructions/scripts/init-worktree.sh):
it branches from `origin/dev` by default (use `--include-local` to
preserve unpushed local commits instead), runs
[`scripts/worktree-postinit.sh`](../../scripts/worktree-postinit.sh)
synchronously (submodules and `npm ci`), records durable readiness, and
prints `WORKTREE_PATH=<absolute-path>` on its final stdout line only when
ready. `cd` into that
path, work + commit, and run
[`/git-safe-sync-and-push`](../../.factory/commands/git-safe-sync-and-push.md)
when ready to land — the slash command's worktree-branch preflight
(Trigger K) handles the upstream wiring so the push goes directly to
`dev`.

The authoritative config and policy live in
[PROJECT_OVERRIDES2.md § Worktree Setup](./PROJECT_OVERRIDES2.md#worktree-setup).
Multi-agent awareness recipe and STOP-gate policy live in
[`AGENTS.md` § Working in worktrees](../../AGENTS.md#working-in-worktrees).
The Mindstone-Rebel-specific gotchas below cover what makes running the
*app* from a worktree tricky (port allocation, deep-link registration,
version-epoch mismatch).


## See Also

- [PROJECT_OVERRIDES2.md](./PROJECT_OVERRIDES2.md) — canonical worktree setup config (integration branch, post-init, scripts)
- [ELECTRON_STORAGE_REFERENCE.md](ELECTRON_STORAGE_REFERENCE.md)
- [AUTHENTICATION.md](AUTHENTICATION.md)
- [DEBUGGING.md](DEBUGGING.md)


## Manual worktree setup (bypassing init-worktree.sh)

The supported path is `coding-agent-instructions/scripts/init-worktree.sh <slug>` from the primary checkout — see [PROJECT_OVERRIDES2.md § Worktree Setup](./PROJECT_OVERRIDES2.md#worktree-setup) for the full flow.

If you ran raw `git worktree add` directly and skipped that script, the new worktree won't have submodules or `node_modules`. Run the post-init hook from the worktree root to fix it up:

```bash
bash scripts/worktree-postinit.sh
```

That handles submodule init (borrowing objects from the primary checkout — see [Submodule object sharing](#submodule-object-sharing)), `npm ci`, and the mandatory `packages/browser-extension` install. `super-mcp` builds on demand in the pre-push validation gate. It's idempotent — safe to re-run. See `scripts/worktree-postinit.sh` for the script and `REBEL_WORKTREE_INSTALL_ALL=1` for opt-in heavy subprojects (cloud-client, cloud-service, mobile, web-companion).


## Dependency caching & freshness

Two mechanisms keep per-worktree `node_modules` fast, cheap, and correct. Both fail
safe: any uncertainty falls back to a plain `npm ci` (the authoritative behaviour), so
they only ever make things faster, never less correct.

**CoW template cache (worktree creation).** `npm ci` writes ~2.8 GB of *fresh* blocks
per worktree (it does not reflink from the npm cache), so N worktrees cost N×2.8 GB.
Instead, `worktree-postinit.sh` runs `npm ci` *once per unique install fingerprint*,
publishes that verified tree into a shared copy-on-write cache, and CoW-clones it into
every later worktree — ~tens of MB of real disk and a few seconds instead of ~2.8 GB
and a full install (measured cold→warm: ~212 s → ~39 s across all six trees;
~84 GB recoverable across a typical worktree fleet). The cache key is a full *install
fingerprint* ([`scripts/dependency-install-fingerprint.mjs`](../../scripts/dependency-install-fingerprint.mjs):
lockfile + install lifecycle scripts + `.npmrc` + node/npm/platform/arch), so a clone
is only ever reused for a byte-for-byte-equivalent install. It never clones from the
mutable primary checkout.

**Freshness auto-`npm ci` (dev/package launch).** A checkout's `node_modules` only
changes when you run `npm ci`, so after a sync that bumped the lockfile it silently goes
stale. [`scripts/ensure-deps-fresh.mjs`](../../scripts/ensure-deps-fresh.mjs) — wired
into `predev` and `prepackage` — compares a stored fingerprint sentinel against the
current one and auto-runs `npm ci` when they differ. Happy path is a ~0.1 s no-op.

**Env knobs:**

| Variable | Effect |
| --- | --- |
| `REBEL_WORKTREE_NO_NM_CACHE=1` | Disable the CoW cache (force `npm ci` in postinit) |
| `REBEL_WORKTREE_NM_CACHE=<dir>` | Relocate the cache (default `~/.cache/rebel-worktree-nm`) |
| `REBEL_WORKTREE_NM_CACHE_TTL_DAYS=<n>` | Prune cache entries untouched for >n days (default 21) |
| `REBEL_WORKTREE_NM_CACHE_LOCK_TTL_MIN=<n>` | Steal a publish lock older than n minutes (default 30) |
| `REBEL_SKIP_DEPS_FRESH=1` | Skip the predev/prepackage freshness check |

**Recovery:** the cache is disposable — `rm -rf ~/.cache/rebel-worktree-nm` any time;
the next worktree just rebuilds the entries it needs via `npm ci`. Pruning is safe even
while worktrees reference entries (CoW clones keep their own blocks).


## Submodule object sharing

Git does **not** share submodule object stores across worktrees: by default each
worktree clones every submodule into its own `.git/worktrees/<wt>/modules/<name>`,
re-fetching the objects over the network (~390 MB for `coding-agent-instructions`
alone) and keeping a full on-disk copy. Across a fleet that is the bulk of `.git` (a
75-worktree checkout reached ~30 GB).

`worktree-postinit.sh` instead initialises each submodule with
`git submodule update --reference <primary>/.git/modules/<name>`, so the worktree
**borrows** the objects from the primary checkout's existing store via a git
*alternate* (`objects/info/alternates`). The result: no bulk network transfer (a
referenced init finishes in seconds even on a degraded connection) and ~tens of KB per
worktree instead of ~390 MB (measured: **852 KB vs 391 MB**). It falls back to a normal
network clone when the primary store is absent (a fresh machine that never initialised
submodules in the primary).

**Alternate safety.** A `--reference` borrower only breaks if the alternate (the
primary store) *prunes* an object the borrower still needs. `git gc` prunes only
**unreachable** objects, and submodule SHAs are pinned to commits on the submodule's
`main`, which stay reachable from `origin/main` — so they are not pruned in normal
operation. The one break case is a submodule **history-rewrite** (rebase/force-push of
`main`) that orphans a pinned SHA, followed by a prune in the primary store. It is rare
for these append-only internal submodules, **fails loud** (a missing-object error,
never silent corruption), and recovers with:

```bash
git -C <submodule> fetch                          # re-fetch the orphaned objects
# or rebuild the worktree's submodule from scratch:
git submodule update --init --force -- <submodule>
```

This mirrors how GitLab protects shared object pools (never prune the shared store) and
is the standard git-alternate trade-off.

**Full independence (opt-in).** If you want a worktree whose submodule stores have
*zero* dependency on the primary — e.g. before deleting/moving the primary checkout —
"dissociate" each submodule by giving it its own copy of the objects. On a
copy-on-write filesystem (APFS / Linux reflink) this is ~free on disk:

```bash
# for each submodule <name> at <path>, from the worktree root:
store="$(git rev-parse --path-format=absolute --git-common-dir)/modules/<name>"
wt="$(git -C <path> rev-parse --absolute-git-dir)"
cp -c -R "$store/objects/." "$wt/objects/"     # APFS clonefile (Linux: cp -a --reflink=always)
rm -f "$wt/objects/info/alternates"            # drop the alternate
git -C <path> fsck --connectivity-only         # verify self-contained
```

This was validated (fsck-clean; a 347 MB reflink copy cost ~0 real disk). It is **not**
the default — plain `--reference` is low-risk for our append-only submodules and avoids
the extra machinery. Reach for it only if you hit the history-rewrite break case above
or need to detach a worktree from the primary store.

**Env knob:** `REBEL_WORKTREE_NO_SUBMODULE_REFERENCE=1` forces plain network clones
(disables object borrowing) — an escape hatch, rarely needed.


## Running multiple dev servers

Each worktree can run `npm run dev` simultaneously by using a unique port. Create a `.env.local` file in the worktree root:

```bash
# In <worktree-dir>/.env.local
ELECTRON_RENDERER_PORT=5184
```

Ports 5173-5183 are reserved for Super-MCP OAuth callbacks, so worktree ports must start at **5184**. Pick any free port ≥ 5184; if you have multiple worktrees running concurrently, increment to avoid collisions.


## Troubleshooting

### "Sign in failed. Please try again." after switching worktrees

**Symptom.** You ran `npm run dev` / `npm run dev:local` from worktree A, then later started dev from worktree B. Login from B fails with "Sign in failed. Please try again." even though OAuth completes in the browser.

**Root cause: worktree epoch mismatch triggers global read-only mode.**

All worktrees share the same `userData` directory (`~/Library/Application Support/mindstone-rebel`). At startup, the app compares its own `DATA_SCHEMA_EPOCH` (sum of all store versions in `src/core/constants.ts`) against `dataSchemaEpoch` written to `~/Library/Application Support/mindstone-rebel/version-marker.json`. If the marker's epoch is greater than the current code's epoch, the app enters global read-only mode — **every store write is silently blocked**, including `saveSessionToken()`.

Login then unfolds like this:

1. OAuth succeeds, token is exchanged successfully.
2. `saveSessionToken()` logs "Session token saved with encryption" but the write is gated — `auth-tokens.json` is not updated.
3. `fetchUserInfo()` calls `loadSessionToken()` and reads the **stale** token from before read-only mode.
4. The stale token is rejected by the server; the response has no `user` field.
5. `fetchUserInfo` throws `TypeError: Cannot read properties of null (reading 'user')`.
6. Renderer receives "Sign in failed. Please try again."

The gate itself is working as designed (see [260219_global_store_version_gate.md](../plans/partway/260219_global_store_version_gate.md)) — it protects newer-format data from being clobbered by an older code path. It was not designed to surface gracefully to the user, so the only visible signal is a broken login.

**How to confirm.** Look for this log line in `~/Library/Application Support/mindstone-rebel/logs/mindstone-rebel.*.log`:

```
userData was last used by a newer app version (epoch check) — read-only mode
  markerEpoch=<N+k> currentEpoch=<N> markerAppVersion=<version>
```

Then compare the two worktrees:

```bash
# From each worktree root
cd /path/to/worktree && npx tsx -e "import { DATA_SCHEMA_EPOCH } from './src/core/constants'; console.log(DATA_SCHEMA_EPOCH)"
```

Also check the marker file:

```bash
cat "$HOME/Library/Application Support/mindstone-rebel/version-marker.json"
```

**Fixes (in order of preference).**

1. **Run dev from the newer worktree** (the one whose epoch matches the marker). Cleanest; zero data risk. Quit the older worktree's dev server first.
2. **Cherry-pick / rebase the store-version bump** from the newer branch into the older one so their epochs match. Medium effort; also zero data risk.
3. **Rename the marker to unblock the older worktree** (last resort):
   ```bash
   mv "$HOME/Library/Application Support/mindstone-rebel/version-marker.json" \
      "$HOME/Library/Application Support/mindstone-rebel/version-marker.json.bak-$(date +%s)"
   # Fully quit the running Electron app (Cmd-Q), then npm run dev again.
   ```
   Safe if the store-version differences between the two branches are additive/no-op migrations (e.g. a new optional field). **Not safe** if the newer branch wrote data in a shape the older branch doesn't understand destructively — in that case the newer branch's per-store guards (`storedVersion > currentVersion → refusing to modify`) are your last line of defence, but other stores will still be writable by the older code. If unsure, use option 1 or 2.

   Note: the marker will be rewritten at the older worktree's epoch next startup. If you then switch back to the newer worktree, it will happily bump it up again (newer > older is fine). You'll only hit the lockout going newer → older, and you'll need to rename the marker each time unless you align the epochs.

**Prevention.** Keep all worktrees on branches whose `DATA_SCHEMA_EPOCH` are close. When you bump a `*_STORE_VERSION` constant in `src/core/constants.ts` on one branch, either merge it into the other branches promptly or be prepared for this lockout when switching. The CI check `scripts/check-store-versions.ts` enforces the registry but cannot catch cross-worktree mismatches.

> **This is a data-integrity hazard, not just a broken login.** The dev / worktree app shares the one real `userData` (`~/Library/Application Support/mindstone-rebel`) with your **installed** app — i.e. your real conversations. Running a build whose epoch differs from your installed app (a worktree, a `dev`-branch dev server, or a beta build) can flip the store read-only and, separately, force an index rebuild — and a higher epoch leaves the store unable to self-repair. In the **2026-06-16 session-index-collapse incident** this combination left the sidebar showing nearly-empty folders (the session index couldn't be rebuilt while read-only). So: **don't run a mismatched-epoch build against the `userData` that holds your real conversations.** Prefer an epoch-matching build (fix #1 above) or align epochs first (#2). If you genuinely need to launch a divergent build for testing, do it knowingly and ideally against a throwaway `userData` (point `mindstone-rebel`'s app data elsewhere) rather than your real one. Postmortem: `docs-private/postmortems/260616_session_index_collapse_unguarded_messages_filter_postmortem.md`.

**See also:** [260219_global_store_version_gate.md](../plans/partway/260219_global_store_version_gate.md) (design rationale for the gate), [ELECTRON_STORAGE_REFERENCE.md](ELECTRON_STORAGE_REFERENCE.md), [AUTHENTICATION.md](AUTHENTICATION.md), [DEBUGGING.md](DEBUGGING.md).

### OAuth deep links route to the wrong worktree (or do nothing) after switching worktrees

**Symptom.** You ran `npm run dev` from worktree A, later started dev from worktree B, and now after completing an OAuth flow in the browser the `mindstone://` / `rebel://` deep link either wakes up the wrong worktree's Electron or appears to do nothing.

**Root cause.** macOS Launch Services remembers protocol handlers by binary path. Each worktree has its own `node_modules/electron/dist/Electron.app`, and whichever one registered most recently (or first) wins. When two worktrees both have an Electron binary on disk, Launch Services can point `mindstone://` / `rebel://` at the wrong one.

**Fix.** Run the helper script from the worktree you currently want to own the deep-link handlers:

```bash
scripts/fix-deeplinks.sh           # or --dry-run to preview
```

This removes sibling worktrees' `node_modules/electron/dist` directories (the competing binaries), resets the Launch Services cache via `lsregister -kill -r`, then tells you to restart `npm run dev` so the correct binary re-registers. If you later need the app in another worktree, run `npm ci` there to restore its Electron binary — and re-run this script when you switch back.

See the script itself (`scripts/fix-deeplinks.sh`) for flags and implementation details.
