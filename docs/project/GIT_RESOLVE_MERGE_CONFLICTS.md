---
description: "Canonical merge-conflict resolution guide for git-safe-sync aborts — assessment, hunk handling, submodule pointers, verification, and recovery"
last_updated: "2026-05-01"
---

# Resolve Merge Conflicts

This is the canonical reference for resolving merge conflicts in the Mindstone Rebel checkout. It is invoked when `npx tsx scripts/git-safe-sync.ts` aborts with exit code 20 (merge conflict).


## Step 1: Assess the Situation

Review (in parallel):
- `git status` — see all conflicted files
- `git diff --name-only --diff-filter=U` — list ONLY conflicted files
- Recent git history (`git log --oneline -10`)
- Planning docs for any relevant pieces of work
- The merge conflict details themselves


## Step 2: Resolve Each Conflict (Hunk-by-Hunk)

For EACH conflicted file:

1. **Show the conflict hunks** — use `git diff <file>` to see specific conflict markers. Never look at the full file when only hunks matter.
2. **Never do full-file replacements.** Don't blindly accept "ours" or "theirs" for an entire file. Inspect each hunk individually.
3. **Preserve the best of both worlds.** Identify what each side contributes (ours = local work, theirs = incoming from remote). The goal is to keep both contributions where possible.
4. **Never auto-resolve by picking one side blindly.** If a hunk is ambiguous — both sides made meaningful changes to the same lines — ask the user how to resolve it.
5. **Think about what you're losing.** Before accepting "theirs" for any hunk, check: did "ours" add something important that "theirs" doesn't have? This is the pattern that caused Incident #3 (local tracking methods dropped by "take remote" resolution).
6. **Big multi-concern files get extra care.** For files over ~500 LOC carrying more than one cross-cutting concern, list every fix that touched the file in the past 30 days (`git log --oneline -30 -- <file>`), verify the merged result preserves each of those contracts, and record the findings in the merge-commit body.

Make a proposal. Don't make changes yet. Wait for confirmation on any ambiguous resolutions.


## Step 3: Submodule Pointer Conflicts

If a submodule pointer conflicts (both sides updated the pointer):

1. Check which submodule commit is newer: `cd <submodule> && git log --oneline <ours-sha>..<theirs-sha>`
2. Usually the newer commit contains the older one's changes (fast-forward relationship)
3. If one is an ancestor of the other, take the newer commit
4. If they've diverged (neither is an ancestor), this requires manual investigation inside the submodule
5. After choosing, update the pointer: `git add <submodule-path>`


## Step 4: Verify Before Committing

Before committing the merge, verify incoming changes are preserved:

1. Run `git diff --cached --stat` — check that the number of changed files is reasonable (not suspiciously low compared to what was incoming)
2. Run `git diff --stat MERGE_HEAD` — if this shows zero differences, your result may match theirs exactly (unusual); if it shows massive changes, your result may have dropped their changes
3. Verify key files from the incoming branch are present in the staged changes
4. **NEVER use `git reset HEAD -- .`** during resolution — this drops ALL incoming changes. See `docs-private/postmortems/260330_merge_drop_concurrent_session_race_postmortem.md`.
5. Run `npm run validate:fast` to catch type errors or broken imports from the resolution
6. Scan merged files for newly arrived contract violations: when the merge brings in new uses of an API that was refactored on your side, grep for the deprecated patterns (e.g. raw `store.set` on keys now owned by a cache helper) before completing the merge
7. When satisfied, commit: `git commit --no-edit`


## Step 5: After Resolution

After committing the resolved merge:

```bash
npx tsx scripts/git-safe-sync.ts
```

This will pick up where it left off: verify merge integrity, advance submodules, validate, and push.


## Recovery Paths

- **If unsure about the resolution:** `git merge --abort` returns to pre-merge state. Then rerun `npx tsx scripts/git-safe-sync.ts`.
- **If the merge was committed but looks wrong:** `git reset --hard backup/<branch>/<timestamp-sha>` restores to the backup branch created by git-safe-sync before the merge.
- **For very complex merges:** Consider running `npm test` (full test suite) after resolution, not just `validate:fast`.
