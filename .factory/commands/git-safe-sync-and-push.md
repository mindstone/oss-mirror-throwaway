---
description: Safely sync local branch with origin — fetches, merges, advances submodules, validates, and pushes everything in the right order
argument-hint: <optional: --dry-run, --no-push, --validate, --validator-command <cmd>, --no-advance-submodules, --autostash, --diagnostics-only>
---

# Safe Sync

> **Pushing to beta?** This command is the push primitive. For the full "push to beta → watch CI to a terminal state → diagnose & fix failures within a risk ceiling → re-push until green" loop, follow [`docs/project/RELEASE_TO_BETA.md`](../../docs/project/RELEASE_TO_BETA.md) — it wraps this command (all the safety rules below still apply unchanged) and adds the `[deploy-beta]` trigger, the confirm-and-fix loop, and the autonomy ceiling.

**Execute this autonomously.** Apply best-of-all-worlds decisions using the patterns in [`coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md`](../../coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md) (the AI-agent dev git-commit guide) and [`docs/project/GIT_RESOLVE_MERGE_CONFLICTS.md`](../../docs/project/GIT_RESOLVE_MERGE_CONFLICTS.md). **Only STOP to ask the user when a listed escalation trigger applies** — these are real tradeoffs, risks, or surprises where you should not decide alone. The overriding principle is **never lose work**: no uncommitted changes, no unpushed commits, no orphaned submodule state. **Discarding uncommitted changes is out of scope** — the default is always to commit them properly before sync.

## Push Authorisation — Already Granted

**The invocation of this command IS the push authorisation for this turn.** This slash command itself is the explicit per-turn push authorisation referenced in `AGENTS.md`. Do not ask the user to re-confirm push intent. Run `git-safe-sync` **without** `--no-push`. Do not ask again.

The only exceptions that require confirmation are:
- You encounter one of the listed escalation triggers (A–J) and need to halt anyway
- User explicitly said "dry run only" or added `--no-push` / `--dry-run` in their message
- You need to force-push (always requires explicit per-turn permission)
- **A [smell test](#smell-tests-when-to-stop) fires** on uncommitted work — see Working-Tree Inspection below

<a id="concurrent-agent-guard"></a>
## Working-Tree Inspection — Commit Unless Problematic

**Before any of the steps below**, run `git status --porcelain` (and `git submodule foreach 'git status --porcelain'`). **The default for any uncommitted change is to commit it properly via [`coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md`](../../coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md) batches before the merge** — discarding work is out of scope, and `--autostash` is race-prone in this multi-agent environment. The user invoking this slash command is their authorisation to deal with the working tree.

Classify each entry, then act:

- **Modified-tracked or substantive-untracked files** (`src/**`, `cloud-service/**`, `cloud-client/**`, `mobile/**`, `evals/**`, `scripts/**`, test files, config files like `*.json` / `*.yml` / `tsconfig*` / `package*.json`) → **read each diff, group by intent, commit via the patterns in [`coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md`](../../coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md)** with proper `feat/fix/chore` messages and AI provenance trailers (typically `AI-Workflow: direct`, `AI-Implementer: <model running this slash command>`, `AI-Review-Mode: none` when work is being preserved without code review). **Process older-mtime batches first** — reduces collision risk with any still-active concurrent agent that may be writing newer files. Step 1a covers the full procedure.

- **Transient untracked artifacts** (`.DS_Store`, editor swap files, `*.tmp`, `*.swp`, `*~`) → **leave them alone**. Untracked files don't block a fast-forward or merge unless the incoming change adds the same path (vanishingly rare for these). No autostash needed.

- **Safe scratch paths** (`docs/plans/**`, `docs/research/**`, `docs-private/postmortems/**`, untracked scratch markdown) → leave alone, same reason.

**STOP and ask the user only when a [smell test](#smell-tests-when-to-stop) fires** — the changes look genuinely problematic (incomplete, broken, secrets-adjacent, mid-write), not just unfamiliar. The user invoked the slash command knowing there are uncommitted changes; presume the changes are theirs to commit unless something is actually wrong with them. **Never** discard the changes when a smell test fires — surface the specific files + reasons and wait.

<a id="smell-tests-when-to-stop"></a>
### Smell tests — when to STOP and ask

Treat any uncommitted change as committable by default unless one of these fires:

- **Secrets-adjacent file**: `.env`, `*.pem`, `secrets/`, `credentials.*`, `id_rsa*`, `*.key`, anything matching `**/secret*` / `**/key*` patterns that isn't an obvious public asset.
- **Mid-write**: file mtime is within the last ~5 seconds — wait 15s and re-check; if still being modified, escalate to the user (a concurrent agent is actively writing).
- **Looks incomplete or broken**: obvious half-edit (unmatched braces, dangling import, syntactically invalid line), aggressive `console.log` / `debugger` litter that suggests in-progress debugging, `// TODO: finish before commit` markers, or a diff that wouldn't pass `lint`/`tsc` on its face.
- **Suspicious submodule pointer change** in the superproject index where you cannot verify the target commit is reachable from the submodule's configured remote branch (or will become reachable via a 1b commit on an attached expected branch). This is the **submodule-pin-orphan** class (a pin to a commit that has *diverged* from the tracked branch gets silently dropped on the next pointer re-align — it cost us `bulk_export`; see `docs/postmortems/260603_supermcp_bulk_export_submodule_pin_orphan_postmortem.md` + the **Submodule Pin Policy** in `docs/project/PROJECT_OVERRIDES2.md`). The `validate:submodule-pin-ancestry` gate enforces this automatically: where it can verify a submodule it is strict (a pin *not reachable from* `origin/<tracked-branch>` — whether *ahead*/unpushed or *diverged* — **fails**), but it is **offline and skips when it can't verify** (a submodule clone or `origin/<branch>` ref not present in this environment). A `FAIL` (push the submodule commit to its tracked branch first — git-safe-sync does this before the superproject push), a `SKIP` line, or any divergent/off-branch pointer you spot is a "keep an eye out" signal — **surface it to the user explicitly** rather than assuming the gate fully covered it.
- **Concurrent-agent signal**: the user has told you in this turn or a prior turn that another agent is active, OR a `.git/index.lock` older than ~30s is present (recent locks are this turn's own git invocations), OR another lock file (e.g. an editor's `.lock`) is present and recently touched.

When a smell test fires, surface the specific files + reasons to the user and ask before proceeding.

<a id="worktree-branch-preflight"></a>
## Worktree-branch preflight (when in a sibling worktree)

If `git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`, you're in a sibling worktree (created by [`coding-agent-instructions/scripts/init-worktree.sh`](../../coding-agent-instructions/scripts/init-worktree.sh)) rather than the primary checkout. The sync engine handles this via the upstream-tracking trick documented in [`docs/plans/260522_worktree_branch_sync.md`](../../docs/plans/260522_worktree_branch_sync.md) (the "fast path") — **but only if the worktree's config is set up correctly**. Verify before proceeding:

- `git rev-parse --abbrev-ref @{upstream}` must report `origin/<integration_branch>` (read `integration_branch` from `docs/project/PROJECT_OVERRIDES2.md` frontmatter `worktree:` block — for rebel-app that's `dev`). If the upstream is missing or points elsewhere, **STOP** (Trigger K) — the worktree was created without the fast-path setup and the sync would either fail or push to the wrong place.
- `git config push.default` must be `upstream` (or the deprecated alias `tracking`). Anything else and `git push` will refuse the name-mismatch push. **STOP** (Trigger K).
- `git submodule foreach 'git symbolic-ref -q --short HEAD || true'` — for each submodule that reports a branch name, verify it matches the submodule's expected branch per `.gitmodules` (`git config -f .gitmodules submodule.<name>.branch`, default `main`). Detached HEAD is fine and is the normal state. **Any submodule on a feature branch: STOP** (Trigger K). The current fast-path implementation does not support submodules on feature branches during a worktree session — switch them back to detached HEAD or the expected branch first.

If all three checks pass, the rest of this command operates exactly as it would from the primary checkout: the script reads upstream, merges from `origin/<integration_branch>`, and pushes `HEAD` to the upstream's name on the remote (i.e. directly to the integration branch). Submodule auto-push and advancement work unchanged.

> **Sub-package deps:** `scripts/worktree-postinit.sh` now populates ALL sub-package `node_modules` (mobile / web-companion / cloud-client / cloud-service / browser-extension) by default at worktree init — cheaply, by copy-on-write-cloning the primary checkout's installs (falling back to `npm ci`) — so the pre-push `validate:ts-ratchet` (which type-checks all of them) won't phantom-fail. The only time you'll hit missing-deps `TS2307` errors at push is if the worktree was created with `REBEL_WORKTREE_SKIP_SUBPROJECTS=1`; then install them first (`npm ci --prefix <pkg>`) rather than weakening the ratchet.

---

## Step 1: Protect All Uncommitted Work (Before Running the Script)

Zero uncommitted changes must remain in the superproject or any submodule before the script runs.

### 1a. Superproject

```bash
git status --porcelain
```

**Handle autonomously** — classify every entry per the [Working-Tree Inspection](#concurrent-agent-guard) section above, then act:

- **Modified-tracked or substantive-untracked files** (whether this conversation edited them or not) → commit via the patterns in [`coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md`](../../coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md): inspect each diff, batch by intent (path + diff signal — e.g., `evals/*` together, `src/main/services/*` together, related logic changes together), atomic `reset`/`add`/`commit` on **explicit paths** (no `-A` / `.`), proper `feat/fix/chore` conventional-commit messages with AI provenance trailers. **Order batches older-mtime first** — reduces collision risk with any still-active concurrent agent writing newer files, and gives a deterministic order so you don't have to re-decide mid-batch.

   For session-attributable changes, claim ownership in the message (`feat(...)`, `fix(...)`) and use the appropriate `AI-Workflow` value (typically `direct` when committing as part of a sync). For pre-existing work whose intent is readable from path + diff, do the same — write a real conventional-commit message reflecting the actual change. Commits leave a visible audit trail and are cheap to reverse via `git reset HEAD~1` if the originating author returns.

   **Reserve the `chore(sync-preserve)` fallback** (template below) for the rare case where intent is genuinely unreadable from path + diff (e.g., a half-touched file you truly can't characterise, or a batch of unrelated scratch you can't summarise honestly).

- **Transient untracked artifacts** (`.DS_Store`, editor swap files, `*.tmp`, `*.swp`, `*~`) → leave them alone. They don't block a merge and don't need stashing. Pass `--autostash` only if a transient artifact is actually conflicting with the merge (rare).

**STOP and ask** (Trigger A) — uncommitted work where a [smell test](#smell-tests-when-to-stop) fires (secrets-adjacent, mid-write, looks broken/incomplete, suspicious submodule pointer, concurrent-agent signal). When you stop, surface the specific files and the specific smell test that fired. **Never** discard the changes.

### Sync-preserve fallback (for unreadable intent only)

The default for any uncommitted work is a **proper conventional-commit message** (`feat`, `fix`, `chore`, etc.) reflecting the actual change inferred from the diff. Use the `chore(sync-preserve)` fallback **only** when intent is genuinely unreadable from path + diff (e.g., a file half-touched in ways you can't characterise, or a batch of unrelated scratch you can't summarise honestly):

```
chore(sync-preserve): Preserve N uncommitted files before merge sync. Files were in the working tree at sync time and intent could not be confidently inferred from the diff.

Batched per coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md
(intent-grouped where visible from paths, older-mtime first to reduce
collision with any still-active agent).

Files preserved:
- <file 1>
- <file 2>
- ...

If the originating author returns and needs the unstaged state back:
  git reset HEAD~1   # superproject commit; handle submodule pointers per
                     # AI-agent dev companion (Submodule Awareness Before Reset)

AI-Workflow: direct
AI-Implementer: <your-model-id>
AI-Review-Mode: none
```

**Batching for sync-preserve specifically**: multiple `chore(sync-preserve): ...` commits are fine when intent is partially clear from paths (e.g., all new `docs/plans/yyMMdd_*.md` → one commit; all `src/main/services/*` WIP → another). When intent is unclear, a single batched commit is acceptable. Always list the files explicitly in the body. **Order older-mtime files first** in commit ordering, regardless of whether the scope is `sync-preserve` or a real `feat/fix/chore`.

**Parallel GPT assistance** is encouraged for any batch where path-based intent is ambiguous (per the companion's "Parallel AI Assistance" section) — delegate to `researcher-gpt5.5-high` to summarise file diffs into an honest description. If the GPT can produce a confident `feat/fix/chore` subject, use it; otherwise fall back to `chore(sync-preserve)`.

### 1b. Submodules — uncommitted changes

```bash
git submodule foreach 'git status --porcelain'
```

**Handle autonomously** (same classifier as 1a, scoped inside the submodule) when ALL of the following hold:
- Submodule HEAD is on its expected branch per `.gitmodules` (typically `main`)
- No merge / rebase / cherry-pick is in progress inside the submodule
- No [smell test](#smell-tests-when-to-stop) fires on the changes (secrets-adjacent, mid-write, looks-broken, concurrent-agent signal)

Then `cd <submodule> && git commit` using the **same patterns as 1a** — proper `feat/fix/chore` conventional-commit messages where intent is readable, `chore(sync-preserve)` only as fallback. **Older-mtime batches first.** The submodule's commit(s) will be auto-pushed by the script in Step 2. `git submodule update` can silently discard uncommitted changes — committing first prevents that.

**STOP and ask** (Trigger B) when:
- Submodule is in detached HEAD (see 1c)
- Submodule is on an unexpected branch, or has an in-progress merge / rebase / cherry-pick
- Any [smell test](#smell-tests-when-to-stop) fires inside the submodule

### 1c. Submodules — unpushed commits and detached HEAD

```bash
git submodule foreach '
  echo "=== $name ==="
  if git symbolic-ref -q --short HEAD > /dev/null 2>&1; then
    echo "Branch: $(git symbolic-ref --short HEAD)"
    git log --oneline @{u}..HEAD 2>/dev/null || echo "(no upstream set)"
  else
    echo "WARNING: DETACHED HEAD at $(git rev-parse --short HEAD)"
    git log --oneline -5
  fi
'
```

**Handle autonomously:** submodule on its expected branch (per `.gitmodules`) with unpushed commits → the script will auto-push them. Proceed.

**STOP and ask** (Trigger C):
- Detached HEAD **with** commits that are not on any branch (they can be orphaned). Recovery: follow the [Submodule Detached HEAD Guard](../../coding-agent-instructions/docs/GIT_COMMIT_CHANGES.md#submodule-detached-head-guard) before proceeding.
- Submodule on an **unexpected branch** (e.g., a feature branch where `main` is configured).

---

## Step 2: Run the Sync Script

```bash
npx tsx scripts/git-safe-sync.ts $ARGUMENTS
```

Use flags only when the situation calls for them:

- `--dry-run` — preview without executing
- `--diagnostics-only` — state inspection only
- `--no-push` — merge but don't push (validator runs locally since the push gate won't)
- `--autostash` — **Plan B only.** Stash transient superproject changes before merge. Prefer the sync-preserve commit pattern (Step 1a) for pre-existing substantive work — autostash is race-prone in this repo's multi-agent environment and has known stash-pop hazards (see Step 3 Plan B).
- `--no-advance-submodules` — pin submodules to the merged pointer, don't advance to remote HEAD
- `--validate` — force in-script validation before push. Default is skip because the pre-push hook already runs `validate:fast`; use this when you want a higher-confidence local preflight before spending a CI run. Pair with `--validator-command "npm run verify:agent"` for the broader agent validation ladder.
- `--no-validator` — explicit opt-out (default already skips; kept for back-compat)
- `--trace-git` — enable git's built-in `GIT_TRACE_PERFORMANCE`; writes a verbose sidecar file next to the timing log (use when investigating a mystery slowdown inside a git subprocess)
- `--no-log` — suppress the timing JSON file (terminal summary still printed)
- `--no-lock` — skip the same-host sync lock (see below; env equivalent `GIT_SAFE_SYNC_NO_LOCK=1`). Escape hatch only — the default queueing is the desired behavior.
- `--no-retry` — disable the automatic single retry on a lost push race (env equivalent `GIT_SAFE_SYNC_NO_RETRY=<any non-empty value>`). Escape hatch only — the default auto-retry is the desired behavior (see exit 40 below).

### What the script does

1. Fetches superproject + all submodules **in parallel** (`--recurse-submodules --jobs=N`).
2. Checks safety (uncommitted changes, unpushed submodule commits). **Pure submodule pointer-lag no longer aborts**: a clean submodule checkout strictly behind its committed, remote-reachable pin (the post-manual-merge signature) is auto-aligned with a loud per-path note before the safety check; anything else still aborts, with classification-aware copy. Details: [`PREPUSH_GATE_AND_RECEIPTS.md` § Follow-ups](../../docs/project/PREPUSH_GATE_AND_RECEIPTS.md#follow-ups-2026-06-11).
3. **Auto-pushes** unpushed submodule commits to their remote branch.
4. Creates a backup branch before merge.
5. Merges remote changes with integrity verification.
6. Syncs submodule URLs, updates to merged pointers.
7. Advances submodules to their remote HEAD (default-on, parallel fetches).
8. Creates a separate pointer commit for advanced submodules.
9. **Skips `npm run validate:fast` by default** — the Husky pre-push hook runs it before the actual push. Falls back to running it if no pre-push hook is detected or `--no-push` is used.
10. Pushes submodules + superproject with `--recurse-submodules=on-demand`.
11. Final verification uses local refs only (no extra network fetch).

### Sync lock (same-host serialization)

Since 2026-06-11 the script takes a **same-host advisory lock** (per machine, per remote) before its first fetch, so concurrent local syncs **queue instead of racing** each other's fetch→validate→push windows. Full behavior, budgets, and residual caveats: [`docs/project/PREPUSH_GATE_AND_RECEIPTS.md` § What shipped](../../docs/project/PREPUSH_GATE_AND_RECEIPTS.md#what-shipped-2026-06-11). What you need operationally:

- **Waiting is normal.** Several minutes of `sync-lock: waiting for pid N (git-safe-sync …), lock age Ns …` (reprinted ~every 15s with the holder's pid/argv and the lock-file path) is the lock **working** — another sync on this machine is inside its push window. Don't treat it as a hang.
- **Agents: budget for the wait.** A queued sync can legitimately take holder-gate-time (~3–5 min) longer. Invoke with a long Bash-tool timeout or run it in the background — the default 120s timeout WILL kill a queued sync. That kill is safe: a killed *waiter* exits 130/143, releases its lock state, and writes a timing log; just re-run when ready.
- **Backgrounding it? Trust the script's summary, not the wrapper's exit.** Real sync runs print `outcome: <success|failure|aborted> (exit N)` in the closing timing summary — read that line. A trailing `echo` after the command changes the shell's final status, so the background wrapper can report "exit 0" even when the sync failed (e.g. a non-fast-forward **exit 40**). Make the script the last statement, or capture `rc=$?; …; exit $rc`, so the reported code is the real one.
- **Manual recovery** (when the printed holder is clearly wrong/dead): `kill <holder pid>`, or delete the printed lock-file path, or re-run with `--no-lock`. Stale locks from dead processes are auto-reclaimed within seconds; the lock fails open after a max-wait budget, so it can never deadlock a machine.
- `--dry-run` / `--diagnostics-only` never wait; `--no-push` waits at most ~90s then proceeds with a warning.

### Pre-push hook: tiered test execution

The actual `git push` triggers `.husky/pre-push`, which chooses a test scope based on branch and commit-message flags:

| Tier | Trigger | Scope |
|---|---|---|
| **1 — Quick** | any push (default) | `vitest related --run` on own commits only (`--first-parent --no-merges`) |
| **2 — Beta** | `[deploy-beta]` in commit message | Tier 1 scope + upstream-merged files |
| **3 — Production** | branch is `main` (hotfixes) | Tier 2 scope + full fast-tier suite (`npm run test:fast`) |
| **Escape hatch** | `[skip-tests]` in commit message | Skip vitest entirely (always-on gates still run) |

Always-on gates — merge integrity, submodule availability, `npm run validate:fast` — run regardless of tier. `[skip-tests]` only bypasses test execution.

---

## Step 3: Handle Script Results

### Success (exit code 0)

Confirm "Sync Complete!" appeared. If `--autostash` was used, confirm "Stashed changes restored". **STOP** (Trigger D) if stash pop failed — recover the stashed work per the Trigger D procedure (it may still be in `git stash list`, or, if a concurrent process mutated the shared stash stack, recoverable from dangling objects).

Every run (success or failure) prints a section-level timing summary, and — when the Mindstone Google Shared Drive is mounted — writes a structured JSON log to `<Shared drives/Product>/git-safe-sync-logs/<repo>/YYYY-MM/`. If the user asks "why was that sync slow?", consult recent logs there — the `spans` array tells you which section (fetch, merge, push-incl-prepush-hook, etc.) dominated.

Log destination:
1. `GIT_SAFE_SYNC_LOG_DIR` env var (explicit override)
2. Auto-detected Mindstone Google Drive via `resolveMindstoneProductDrive()` (same pattern as transcript exports; see `docs/project/GOOGLE_DRIVE_PATH_RESOLUTION.md`)
3. If neither resolves, logging is skipped with a one-line note to the terminal ("log: skipped…") — the sync instrumentation is a nice-to-have, not critical, and non-Mindstone devs simply don't get persistent logs.

Pass `--no-log` to suppress the JSON sidecar entirely (terminal summary still prints).

### Submodule auto-push failed (non-fast-forward)

**Handle autonomously when the relationship is clear:** the submodule's remote has new commits that are strictly ahead of our common base. Merge inside the submodule, then rerun:

```bash
cd <submodule-path>
git fetch origin
git merge origin/<target-branch> --no-edit
git push origin HEAD:<target-branch>
cd ..
```

Then: `npx tsx scripts/git-safe-sync.ts $ARGUMENTS`

**STOP and ask** (Trigger E): the merge produced conflicts, or the target branch is unclear, or local and remote have both modified overlapping work in a way that requires a judgment call about which to keep.

### Superproject push failed — non-fast-forward (exit code 40)

Another tab — or another developer — pushed to the remote between our fetch and our push. The merge succeeded, the integrity check passed, the validator passed; only the push itself failed because the remote moved. Your changes are merged locally but not pushed.

> **Exit 40 = push failed (any cause); this section is the *non-FF* sub-case.** The script prints `Another push landed on the remote between fetch and push.` for a race (re-running fixes it). If exit 40 instead prints `Fix the failure above…`, the push failed for a **non-race** reason (permissions, a hook, a rejected ref) — don't re-loop; fix the named cause and `git push` manually. Since the [same-host sync lock](#sync-lock-same-host-serialization) (2026-06-11), **same-host** races should mostly surface as queued lock waits rather than exit 40; a non-FF exit 40 now usually means a **cross-machine** race (or a peer on an old pre-lock checkout).

> **The script auto-retries a classified race once** (since 2026-06-11): when the rejection has git's non-FF status-line shape AND the remote tip verifiably moved, you'll see a loud `LOST PUSH RACE — RETRYING ONCE IN A FRESH RUN` banner (with old → new remote tips) and the script re-runs itself end-to-end (fresh fetch, merge, validation, push). If the retry wins, there is no exit 40 and nothing to do. A race-shaped exit 40 therefore means the **retry leg also lost**, or retry was disabled (`--no-retry` / `GIT_SAFE_SYNC_NO_RETRY`, or the run created an autostash — never auto-retried). Cross-machine guidance is otherwise unchanged. Mechanics + classification semantics: [`PREPUSH_GATE_AND_RECEIPTS.md` § Follow-ups](../../docs/project/PREPUSH_GATE_AND_RECEIPTS.md#follow-ups-2026-06-11).

**Handle autonomously:** re-run the slash command (you're in the rare double-loss or retry-disabled case). The next pass fetches the new remote tip, re-merges (almost always a clean fast-forward — the only new content is whatever the racing tab pushed), and pushes:

```bash
npx tsx scripts/git-safe-sync.ts $ARGUMENTS
```

A bare `git push` here will fail with the same non-FF — you need the full fetch+merge+push cycle, which only re-running the script provides.

**STOP and ask** (rare): the manual re-run also fails with non-FF — with the auto-retry that's at least three consecutive lost races, i.e. several agents racing at once. Either keep re-running until you win, or coordinate with the other agent(s).

### Merge conflicts (exit code 20)

Follow [`docs/project/GIT_RESOLVE_MERGE_CONFLICTS.md`](../../docs/project/GIT_RESOLVE_MERGE_CONFLICTS.md). Resolve hunk-by-hunk:

- **Handle autonomously:** obvious resolutions — one side added content the other did not touch; **additive conflicts where both sides only inserted distinct new items and neither side modified or deleted any pre-existing lines/items in the conflicted block (typical for changelogs, appendable lists) — combine both sides and note ordering rationale in the merge commit message**; whitespace/comment-only conflicts; identical logic expressed differently where one form is strictly clearer.
- **STOP and ask** (Trigger F): any hunk where either side modified or deleted pre-existing content that the other side also touched, or where either resolution could plausibly be correct, or where the conflict spans interdependent files. For complex resolutions, consult `researcher-gpt5.5-high` AND present the proposed resolution to the user before committing.

Never do full-file replacements. Never blindly pick one side.

After manually committing a conflict resolution, run `git submodule update --init --recursive` **before** re-running the script — a pin-moving merge commit leaves submodule checkouts lagging the newly-committed pins. (If you forget, the script's [auto-align](../../docs/project/PREPUSH_GATE_AND_RECEIPTS.md#follow-ups-2026-06-11) now handles the pure-lag case loudly; aligning up front still keeps the working tree honest for anything you do before the re-run.) Then rerun the script.

### Pre-commit secret scanner blocks a commit (Trigger J)

Droid-Shield or similar commit-time scanners may flag patterns in minified/generated assets (Storybook static bundles, webpack outputs, bundled JS) because replace-strings or entropy look like secrets. You cannot retry or work around inside Droid.

**Verify autonomously first:**
- Is the path a known generated-artifact directory (`storybook-static/`, `dist/`, `build/`, `out/`)?
- Does the flagged "secret" look like a minified regex/replace call rather than a plausible API key or token?

**STOP and ask** (Trigger J) — when the flag is a false positive:
1. Tell the user exactly which files and patterns triggered the scanner.
2. Give them the exact commit command (including any merge-state considerations and AI-provenance trailers) to run in their own terminal with `git commit --no-verify`.
3. Give them the follow-up commands (submodule sanity check if applicable, re-run the sync script).
4. Do NOT attempt `--no-verify` yourself — that trust boundary belongs to the user.

**Never bypass** when the flag could be legitimate (stray `.env` file, plausible API token, hardcoded password, SSH key). Treat as a real security finding and STOP.

### Plan B — autostash-specific failure modes

These only apply when `--autostash` is explicitly in use (user preference, secrets-adjacent files, or transient artifacts only). If you're here via the default commit-preserve path in Step 1a, skip this subsection.

#### Autostash precheck aborted — merge would conflict even with clean working tree

Message: `Merge conflicts detected - autostash aborted for safety`.
The script refuses to stash because the outcome would be stashed changes + a conflicted merge — worst of both worlds.

**Handle autonomously** when the conflict file(s) don't overlap with stashable work:

1. `git stash push -u -m "git-safe-sync manual pre-merge"`
2. `git merge origin/<branch> --no-edit` (conflict expected)
3. Resolve per the Merge-conflicts section above (consult `researcher-gpt5.5-high` and present per Trigger F if complex).
4. Stage resolved files and commit the merge (handle the pre-commit scanner per Trigger J if it fires).
5. **Run the post-pop sanity check below BEFORE `git stash pop`.**
6. `git stash pop`.
7. Re-run the sanity check.
8. Rerun `npx tsx scripts/git-safe-sync.ts --autostash` (it will detect push-only strategy).

**STOP and ask** if the conflict files overlap with the stashed work (pop would produce additional conflicts on already-merged state).

#### Post-stash-pop sanity check

After **any** stash-pop that spans a merge which changed submodule pointers, verify:

```bash
git status --porcelain | grep -E '^ M '
```

If a submodule appears (e.g., ` M rebel-system`, ` M super-mcp`, ` M coding-agent-instructions`), the pop restored the pre-merge submodule pointer on top of the freshly-merged superproject. **Do not commit this** — it would regress the submodule pointer. Recover:

```bash
git submodule update --init <submodule-name>
git status --porcelain | grep <submodule-name>    # should now be empty
```

This applies to agent-driven `--autostash` flows *and* any manual `git stash pop` that spans a merge.

### Integrity check failed (exit codes 15/16)

This is a **critical safety event** — the merge may have silently dropped incoming changes. **STOP** (Trigger G) unconditionally:

1. Do NOT push.
2. Show the user the integrity output.
3. Offer recovery: `git reset --hard backup/<branch>/<timestamp-sha>` then rerun.
4. If it recurs, escalate with full diagnostics.

### Validation failed (exit code 30)

Merged-but-unpushed state. Fix the errors:

- **Handle autonomously:** clear, self-contained fixes in code from this session or in recently-touched files where the diagnostic points directly to a mechanical fix (missing import, obvious type widening, lint auto-fixable). After fixing, commit and push manually.
- **STOP and ask** (Trigger H): unclear root cause, errors in code you don't understand, multi-file logic issues. Delegate to `debugger-gpt5.5-high` if asked, but do not guess at fixes for unfamiliar code.

### Submodule advancement failed (exit code 17)

**Handle autonomously:** diverged submodule where ancestor relationship is clear — merge in the submodule and rerun:

```bash
cd <submodule-path>
git fetch origin
git merge origin/<target-branch> --no-edit
cd ..
```

**STOP and ask** (Trigger I): the merge inside the submodule produces conflicts, or the target branch is ambiguous.

### Submodule pin not on tracked branch (exit code 19)

The by-construction pin-orphan guard (Step 13a) refused to push because a submodule's recorded pin is **not reachable from its `.gitmodules` tracked branch** (`origin/<branch>`) — it has *diverged* from, or is merely *ahead* of (not yet landed on), that branch. Such a pin would be silently dropped on the next routine pointer re-align (this is the class that lost `bulk_export`; see the [Submodule Pin Policy](../../docs/project/PROJECT_OVERRIDES2.md) + `docs/postmortems/260603_supermcp_bulk_export_submodule_pin_orphan_postmortem.md`). The merge/advancement succeeded; only the push was blocked. State is merged-but-unpushed (like a validator failure).

**Handle autonomously:** read the FAIL line(s) — it names the submodule + whether the pin is AHEAD or DIVERGED.
- **AHEAD** (a local submodule commit not yet on its tracked branch): land it on the branch, then rerun the sync. The normal sync auto-pushes submodule commits before this check, so this usually means the commit is on a *feature* branch, not the tracked branch — push/merge it to `origin/<tracked-branch>` first.
  - **Caveat — are the AHEAD commits yours?** In a shared checkout, the ahead commits on the tracked branch may be a **concurrent agent's** committed-but-unpushed work (it surfaces here because the default submodule *advancement* moved the pin onto their local tip). Do **not** push them — that ships someone else's in-progress work. Instead re-run with `--no-advance-submodules` so the submodule pins to the *merged* pointer (already on `origin/<tracked-branch>`), leaving their commits on the local branch ref for the owner to push. Check whose they are with `git -C <submodule> log --oneline origin/<tracked-branch>..HEAD`. (Construction backstop worth considering: have the advancement step refuse to advance onto commits this session didn't author — see the spin-out note in the Submodule Pin Policy.)
- **A `SKIP` that mentions "could not fetch"**: a transient fetch failure left the check unable to verify; just **rerun the sync** once connectivity is back (the guard fail-opens on unverifiable, so this won't have blocked the push by itself).

```bash
# AHEAD example: land the submodule commit on its tracked branch, then rerun
cd <submodule-path>
git push origin HEAD:<tracked-branch>   # or merge it into the tracked branch
cd ..
npx tsx scripts/git-safe-sync.ts $ARGUMENTS
```

**STOP and ask** when the pin is **DIVERGED** (a feature/abandoned lineage that can't simply be pushed to the tracked branch): this is a real "where should this work live" decision — land it on the tracked branch (for `super-mcp`, which is **our own OSS repo**, this is the *lightweight* commit-on-`main` procedure in [`docs/project/SUPER_MCP_EDITING.md`](../../docs/project/SUPER_MCP_EDITING.md), not a heavyweight foreign PR) or move it to a Rebel-owned layer per the [Submodule Pin Policy](../../docs/project/PROJECT_OVERRIDES2.md). Don't force-pin past the guard.

---

## Escalation Triggers — When to STOP and Ask the User

Genuine judgment calls only. Everything else: proceed autonomously using the patterns above.

- **Trigger A** — Uncommitted work where a [smell test](#smell-tests-when-to-stop) fires. Sub-triggers:
  - Secrets-adjacent files (`.env`, `*.pem`, `secrets/`, `credentials.*`, `id_rsa*`, `*.key`)
  - A file's mtime is within the last few seconds (concurrent agent may be mid-write — wait 15s, re-check, escalate if still being modified)
  - Looks incomplete or broken: half-edit, debugger litter, `// TODO: finish` markers, syntactically invalid lines, anything that wouldn't pass `lint`/`tsc` on its face
  - Submodule pointer changes in the superproject index **where you cannot verify the target commit is reachable from the submodule's configured remote branch** (or will become reachable via a 1b commit on an attached expected branch). Pointer changes to a commit that IS (or will be) on a remote branch → include in the superproject commit without asking.
  - Concurrent-agent signal: user told you another agent is active, OR an old `.git/index.lock` / lock file is present.

  For all other uncommitted work, the default is a proper conventional-commit batch (older-mtime first) — not a STOP. **Never** discard the changes.
- **Trigger B** — Submodule uncommitted change where a [smell test](#smell-tests-when-to-stop) fires, OR submodule is in detached HEAD / on an unexpected branch / has an in-progress merge|rebase|cherry-pick. Otherwise the default is to commit per 1b.
- **Trigger C** — Submodule in detached HEAD with orphan-risk commits, or on an unexpected branch.
- **Trigger D** — Stash pop failed after `--autostash` (Plan B only). The stashed work *should* be in `git stash list`; recover it (don't re-run anything that could trigger `git gc`/`git prune` first — unreachable objects are recoverable but not forever):
  - **List non-empty:** `git stash apply` it, resolve any conflict, then `git stash drop`.
  - **List empty** (another process most likely mutated the shared stash stack — a concurrent same-host sync, a manual `git stash`, or an old checkout): the stash ref was dropped but its objects usually survive. `git fsck --no-reflogs --unreachable | grep commit`, find the stash-shaped commit (`git show --stat --summary <sha>`; message like `git-safe-sync autostash` / `WIP on …`), and **`git stash apply <sha>`** — this restores tracked *and* `-u` untracked parts with paths and modes intact. *Last resort* (only loose blobs dangle, no stash commit): match the lost file among `git fsck … | grep blob` by size/content (blobs carry no filename), `git cat-file -p <blob> > <path>`, and verify with `git hash-object <path>` against the blob id.
  - **Prevention:** don't `--autostash` durable records (e.g. triage logs) — commit them. The untracked-only case no longer needs autostash at all (the sync tolerates a non-colliding untracked working tree).
- **Trigger E** — Submodule non-FF with conflicts or unclear target branch.
- **Trigger F** — Merge conflict where both sides meaningfully changed overlapping logic.
- **Trigger G** — Post-merge integrity check failed or warned.
- **Trigger H** — Validation failed in code with unclear root cause.
- **Trigger I** — Submodule advancement failed with conflicts or ambiguous target.
- **Trigger J** — Commit-time secret scanner (Droid-Shield or similar) fires on generated-artifact false positives. User must commit manually with `--no-verify`; do not attempt the bypass yourself.
- **Trigger K** — Worktree-branch state unsupported. Caught by the [Worktree-branch preflight](#worktree-branch-preflight) when the worktree's upstream is missing/wrong, `push.default` isn't `upstream`, or a submodule is on a feature branch. Surface the specific config gap and the file/submodule involved; do not auto-fix (a wrong upstream or `push.default` change can silently retarget pushes). When stopping, give the user the exact recovery commands for whichever sub-case fired:
  - **Wrong/missing upstream:** `git branch --set-upstream-to=origin/<integration_branch> $(git branch --show-current)` (substitute the `integration_branch` value from `PROJECT_OVERRIDES2.md` frontmatter).
  - **Wrong `push.default`:** `git config push.default upstream`.
  - **Submodule on a feature branch:** `cd <submodule> && git checkout <expected-branch-from-.gitmodules>` (or `git submodule update --recursive` to return it to its pinned detached HEAD).
  - **Last resort:** re-create the worktree via `coding-agent-instructions/scripts/init-worktree.sh [--no-pull] <slug>` from the primary checkout.
- **Force-push** — always ask; never without explicit permission.
- **Anything you can't explain** — unexpected file counts, missing changes, state that doesn't match what the script reports.

---

## Safety Rules (Non-Negotiable)

1. **Never lose work.** Every uncommitted change, every unpushed commit, every stash must be accounted for at the end.
2. **Never force-push.** Ask the user explicitly.
3. **Never auto-resolve ambiguous conflicts.** Show the hunks and ask.
4. **Never do full-file replacements** during conflict resolution.
5. **Never update a submodule pointer** without verifying its commits are pushed to the remote.
6. **Never proceed past a failed integrity check.**
7. **Never silently discard submodule changes** — `git submodule update` can destroy uncommitted work.
8. **Never skip escalation** to save time. A 10-second question beats an hour of lost work.

> **Supersedes:** This command replaces the previous `safe-full-rebel-merge-rebase` command. Rebase support was removed — merge-only is safer for this codebase (see `docs/plans/260412_git_safe_sync_consolidation.md`).
