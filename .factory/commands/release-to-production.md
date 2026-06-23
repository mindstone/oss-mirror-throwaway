---
description: Full production release workflow - changelog update, doc sync, submodule push, version bump, merge to main, validation
argument-hint: <optional: --skip-changelog or --skip-docs to skip optional steps>
---

# Release to Production

Orchestrates the complete production release workflow for Mindstone Rebel. This wraps `scripts/release-to-production.ts` with optional pre-release changelog and documentation updates.

> **Production-release policy — read first.** Production is reached by **promoting a beta-certified
> commit** to stable, and **only because the user explicitly requested it**. The normal path is
> [`docs/project/PROMOTE_BETA_TO_PRODUCTION.md`](../../docs/project/PROMOTE_BETA_TO_PRODUCTION.md)
> (`release-to-production.ts --commit <certified-sha>`), governed by
> [`docs/project/RELEASE_TO_PRODUCTION.md`](../../docs/project/RELEASE_TO_PRODUCTION.md). The bare/standard
> (latest-`dev`, non-`--commit`) flow described below is the **emergency direct-cut** path — explicit
> permission + full validation only; prefer promotion whenever viable.

**Must-read before proceeding:**
- `docs/project/RELEASE_TO_PRODUCTION.md` — production-release policy + emergency escape hatch
- `docs/project/PROMOTE_BETA_TO_PRODUCTION.md` — the normal beta→production promotion runbook
- `docs/project/RELEASING.md` — Full release process documentation
- `docs/project/CHANGELOG_UPDATE_PROCESS.md` — Changelog conventions and dual-changelog system
- `coding-agent-instructions/docs/GIT_SUBMODULE_HEALTH_CHECK.md` — Submodule safety

---

## Phase 0: Pre-flight

Before anything, verify the environment is ready:

```bash
# Must be on dev
git rev-parse --abbrev-ref HEAD

# Must be clean (or user must confirm dirty tree is OK)
git status --porcelain

# Pull latest
git fetch origin
git pull --ff-only origin dev

# Check submodule health
git submodule status
```

If not on `dev`, STOP and warn the user. If working tree is dirty, list the changes and ask whether to proceed.

### Confirm the release version

Read the current version from both branches:

```bash
node -p "require('./package.json').version"
git show origin/main:package.json | grep '"version"'
```

The version on `dev` should already be ahead of `main` — the release script's post-release step auto-bumps the patch version on `dev` after every production release. This means `package.json` on `dev` already contains the next release version.

Report both versions to the user:

> "Dev is at v<dev_version>, main is at v<main_version>. This will release v<dev_version> to production."

If dev == main or dev < main, something is wrong (post-release bump may have failed). The release script will handle bumping in that case — just note it and proceed.

---

## Phase 1: Changelog Update (Optional)

**Skip this phase if `$ARGUMENTS` contains `--skip-changelog`.**

Ask the user:

> "Would you like to update the changelog before releasing? This will:
> 1. Scan git history since the last changelog entry
> 2. Update both `CHANGELOG.md` (internal) and `rebel-system/help-for-humans/changelog.md` (user-facing)
> 3. Commit and push the changes to dev
>
> Options: Yes / No / Already done"

### If "Yes":

Execute the full `CHANGELOG_UPDATE_PROCESS.md` workflow:

1. **Read existing changelogs** to find the last processed timestamp:
   ```bash
   head -50 CHANGELOG.md
   head -80 rebel-system/help-for-humans/changelog.md
   ```

2. **Scan git history** since the last changelog entry across the main repo and shipped submodules (`rebel-system/`, `super-mcp/`). Skip `coding-agent-instructions/` per `CHANGELOG_UPDATE_PROCESS.md`.

3. **Group, draft, and update** — follow `CHANGELOG_UPDATE_PROCESS.md` for the detailed process (grouping, audience tags, dual-changelog format). Use the `package.json` version (from Phase 0) for the user-facing changelog section header.

4. **Present changes to user for review** — show a summary of entries added to each file. Wait for explicit approval before committing.

5. **Commit and push changelog changes:**

   First, handle the `rebel-system` submodule if it was modified:
   ```bash
   cd rebel-system
   git add help-for-humans/changelog.md
   git commit -m "docs: update changelog for v<version>"
   git push origin HEAD:main
   cd ..
   ```

   Then commit in the main repo:
   ```bash
   git add CHANGELOG.md rebel-system
   git commit -m "docs: update changelogs for v<version> release"
   git push origin dev
   ```

### If "Already done" or "No":

Skip to Phase 2.

---

## Phase 2: Documentation Update (Optional)

**Skip this phase if `$ARGUMENTS` contains `--skip-docs`.**

Ask the user:

> "Would you like to update developer and user-facing documentation to match recent changes?
> This runs the DEV_DOCUMENTATION_UPDATE_PROCESS and HELP_FOR_HUMANS_UPDATE_PROCESS.
>
> Options: Yes / No / Skip"

### If "Yes":

Run both processes (can be parallelized via subagents):

1. **DEV_DOCUMENTATION_UPDATE_PROCESS** (`docs/project/DEV_DOCUMENTATION_UPDATE_PROCESS.md`):
   - Audit `docs/project/` for accuracy against recent changelog entries
   - Focus on `[Developer-facing]` changes that affect architecture, patterns, or principles
   - Update stale docs, add missing signposts

2. **HELP_FOR_HUMANS_UPDATE_PROCESS** (`docs/project/HELP_FOR_HUMANS_UPDATE_PROCESS.md`):
   - Audit `rebel-system/help-for-humans/` for accuracy against recent changelog entries
   - Focus on user-facing features that need documentation
   - Update existing docs, create new ones for undocumented features

3. **Commit and push doc changes** (same submodule-first pattern as Phase 1):
   ```bash
   # If rebel-system was modified:
   cd rebel-system
   git add help-for-humans/
   git commit -m "docs: update help-for-humans for v<version>"
   git push origin HEAD:main
   cd ..

   # Main repo (selectively stage only changed files):
   git add docs/ rebel-system
   git commit -m "docs: update documentation for v<version> release"
   git push origin dev
   ```

### If "No" or "Skip":

Proceed to Phase 3.

---

## Phase 3: Execute Release Script

This is the core release step. The script handles version bumping (if needed), merge to main, validation, and push.

**Note:** If new commits have landed on `dev` since Phase 1/2, consider whether the changelog needs updating before proceeding.

Run the release script:

```bash
npx tsx scripts/release-to-production.ts
```

The script will detect that dev is already ahead of main (version was bumped by the previous release's post-release step) and skip the bump. If for some reason dev == main, the script will auto-bump patch.

Additional flags (rarely needed):
- `--dry-run` — Preview what would happen without executing
- `--minor` / `--major` — Override the default patch bump (only applies when a bump is needed)
- `--commit <sha>` — Release from a specific commit instead of latest dev
- `--skip-push` — Merge and validate but don't push to main
- `--skip-version-bump` — Use if version was already bumped manually
- `--allow-stale-refs` — Proceed if `git fetch` fails (uses local data)

**IMPORTANT — HUMAN CHECKPOINT:** The release script includes a mandatory human confirmation checkpoint before any modifications. When it pauses, relay the checkpoint to the user and wait for their explicit "y" confirmation. Do NOT auto-confirm.

If the script fails at any stage, follow its recovery instructions. Common failure points:
- **Submodule unsafe**: Push submodule changes first (see Phase 1/2)
- **Merge conflict**: Resolve on dev, push, re-run
- **Validator failure**: Fix errors on main, validate, push manually
- **MCP build failure**: Regenerate lockfiles, rebuild

---

## Phase 4: Post-Release Verification

After the release script completes successfully:

1. **Verify the release was pushed:**
   ```bash
   git fetch origin
   git log origin/main --oneline -3
   ```

2. **Check CI status:**
   Provide the link: https://github.com/mindstone/rebel-app/actions
   The build takes ~15-20 minutes.

3. **Verify post-release version bump** (the script auto-bumps dev after release):
   ```bash
   git checkout dev
   node -p "require('./package.json').version"
   ```

4. **Update the PRODUCTION RELEASES table** in `docs/project/CHANGELOG_UPDATE_PROCESS.md`:
   Add a row with the released version and today's date (UTC). Commit and push:
   ```bash
   git add docs/project/CHANGELOG_UPDATE_PROCESS.md
   git commit -m "docs: record v<version> production release date"
   git push origin dev
   ```

5. **Report to user:**
   > "Release v<version> pushed to main. CI is building at [link].
   > Dev has been bumped to v<next_version> for the next cycle.
   > Build takes ~15-20 minutes. Monitor the Actions page for completion."

---

## Quick Reference

| Flag | Effect |
|------|--------|
| `--skip-changelog` | Skip Phase 1 (changelog update) |
| `--skip-docs` | Skip Phase 2 (documentation update) |
| Both flags | Go straight to release script |
| No flags | Full workflow with all optional steps |

## Error Recovery

| Failure | Recovery |
|---------|----------|
| Dirty working tree | `git stash` or commit changes first |
| Submodule has unpushed commits | `npx tsx scripts/git-safe-sync.ts` (auto-pushes unpushed submodule commits) |
| Phase 1 push fails after submodule push | Rerun `npx tsx scripts/git-safe-sync.ts` — submodule is already safe on remote |
| Merge conflict on main | Resolve, `npm run validate:fast`, push |
| Validator fails on main | Fix on main, validate, push |
| Push to main rejected | `git pull --rebase origin main && git push origin main` |
| Release script crashes | Check which phase failed; resume manually |

## Related Docs

- `scripts/release-to-production.ts` — The release script source
- `scripts/git-safe-sync.ts` — Canonical sync/merge/submodule/push tool (`/git-safe-sync-and-push`)
- `docs/project/RELEASING.md` — Manual release process documentation
- `docs/project/CHANGELOG_UPDATE_PROCESS.md` — Changelog conventions
- `docs/project/CI_PIPELINE.md` — How CI builds are triggered
- `coding-agent-instructions/docs/GIT_SUBMODULE_HEALTH_CHECK.md` — Submodule diagnostics
