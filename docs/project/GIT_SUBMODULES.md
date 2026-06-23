---
description: "How Mindstone Rebel uses Git submodules: the canonical git-safe-sync workflow, manual push ordering, and the by-construction submodule-pin-ancestry push gate."
last_updated: "2026-06-04"
---

# Git Submodules

This document covers how Mindstone Rebel uses Git submodules and how to work with them.

> **Want to understand submodules deeply?** See the [Git Submodules Tutorial](../tutorials/251212a_git_submodules_explainer.html) for mental models, detailed explanations, and a comprehensive cookbook.

## Overview

Mindstone Rebel uses three Git submodules:

| Submodule | Purpose | Repo |
|-----------|---------|------|
| `rebel-system/` | Instruction files, skills, and help documentation for the AI agent | `mindstone/rebel-system` |
| `super-mcp/` | MCP router for aggregating multiple MCP servers | `mindstone/Super-MCP` |
| `coding-agent-instructions/` | Shared AI coding instructions (generic principles, workflows, role definitions) | `mindstone/coding-agent-instructions` |

`rebel-system/` and `super-mcp/` are bundled with production builds. `coding-agent-instructions/` is for developer/agent use only (not shipped to users).

## Quick Reference

### Initial setup (after cloning)

```bash
git submodule update --init --recursive
```

### Sync everything (canonical workflow)

```bash
npx tsx scripts/git-safe-sync.ts
```

This is the **single canonical command** for all git sync operations. It:
- Fetches superproject + all submodules
- Merges remote changes with integrity verification
- Creates backup branches before merge
- Advances submodules to their remote HEAD (creates a separate pointer commit)
- Pushes submodules + superproject with `--recurse-submodules=on-demand`

Common flags:
- `--no-push` — merge and advance but don't push
- `--dry-run` — preview without executing
- `--no-advance-submodules` — only sync to merged pointers, don't advance to remote HEAD

#### Submodule-pin-ancestry push gate (Step 13a)

Before pushing the superproject, git-safe-sync runs a by-construction guard
(`enforceSubmodulePinsOnTrackedBranch` in `scripts/git-safe-sync.ts`, Step 13a,
backed by the SSOT in `scripts/lib/submodulePinAncestry.ts` — `checkSubmodulePins`).
It **blocks the push with exit code 19 (`SUBMODULE_PIN_ORPHAN`)** when a submodule's
recorded pin has **diverged** from — or is merely **ahead** of — its `.gitmodules`
tracked branch (`origin/<branch>`, default `main`). Both shapes are the kind of pin
that gets silently dropped on the next routine pointer re-align; an "ahead" pin (a
commit built on the branch but not yet landed on it) is exactly how `bulk_export`
was orphaned.

The gate is **online and strict**: it fetches each tracked branch first, then
hard-fails on a verified divergence/ahead pin. It is **fail-open only when the pin
genuinely can't be verified** (clone absent, transient fetch failure) — that case
SKIPs with a warning, so re-running once connectivity is restored re-verifies.
It runs *after* auto-push + advancement, so a legitimate in-flight submodule commit
has already reached its tracked branch and verifies OK.

This prevents the orphan regression class documented in the
[260603 bulk_export submodule-pin-orphan postmortem](../postmortems/260603_supermcp_bulk_export_submodule_pin_orphan_postmortem.md).
The AHEAD / DIVERGED / SKIP recovery paths (what to do when the gate fires) are
documented in [`.factory/commands/git-safe-sync-and-push.md`](../../.factory/commands/git-safe-sync-and-push.md).

### Push submodule changes manually

After committing inside a submodule, git-safe-sync handles push ordering automatically. But if you need manual control:

```bash
# 1. Commit your changes in the submodule
cd rebel-system
git add -A
git commit -m "Your change description"
git push origin HEAD:main
cd ..

# 2. Commit pointer update in superproject
git add rebel-system
git commit -m "chore(rebel-system): describe what changed"

# 3. Push superproject
git push --recurse-submodules=on-demand
```

## Previous Helper Scripts (Removed)

The earlier per-submodule helpers `scripts/push-submodule.sh` and `scripts/pull-submodule.sh` were removed — their functionality is fully covered by `npx tsx scripts/git-safe-sync.ts` (push ordering, pointer commits, detached-HEAD handling, advancement). If you find any stale reference, it should point at `git-safe-sync.ts`.

## Updating coding-agent-instructions

The `coding-agent-instructions/` submodule contains shared AI coding instructions used across repos. The simplest way to update all submodules including this one:

```bash
npx tsx scripts/git-safe-sync.ts
```

This automatically advances all submodules to their remote HEAD. To update only this specific submodule manually:

```bash
cd coding-agent-instructions
git fetch origin && git checkout main && git pull origin main
cd ..
git add coding-agent-instructions
git commit -m "chore(coding-agent-instructions): pull latest shared agent instructions"
```

**Recommended cadence:** Weekly, or when notified of significant shared content changes.

See [AI_INSTRUCTIONS_ARCHITECTURE.md](AI_INSTRUCTIONS_ARCHITECTURE.md) for details on the layered instruction pattern.

## See Also

### Project Documentation

- [GIT_SUBMODULE_HEALTH_CHECK](../../coding-agent-instructions/docs/GIT_SUBMODULE_HEALTH_CHECK.md) — **Diagnostic workflow for AI agents** to assess submodule state and recommend correct actions
- [Git Submodules Tutorial](../tutorials/251212a_git_submodules_explainer.html) — Comprehensive guide with mental models, detailed explanations, and full cookbook of tasks
- [REBEL_SYSTEM_SYNC](./REBEL_SYSTEM_SYNC.md) — How rebel-system is bundled and distributed with app releases
- [BUILD_AND_RELEASE_OVERVIEW](./BUILD_AND_RELEASE_OVERVIEW.md) — Hub for build/release docs
- [CI_PIPELINE](./CI_PIPELINE.md) — Release pipeline (submodule pointer determines what ships)

### External Resources

- [Pro Git Book: Submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules) — Official Git documentation
- [GitHub Blog: Working with Submodules](https://github.blog/open-source/git/working-with-submodules/) — Practical guidance

