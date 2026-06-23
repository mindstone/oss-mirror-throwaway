---
description: "Process for upgrading coding subagent models — droid file renames, synced references, smoke tests, validation"
last_updated: "2026-04-26"
---

# Subagent Model Upgrade Process

How to upgrade the AI models used by coding subagents (droids) across Factory, Cursor, and the shared coding-agent-instructions submodule.

## See Also

- [NEW_MODEL_SUPPORT_PROCESS.md](NEW_MODEL_SUPPORT_PROCESS.md) — **companion process** for app-level model support (catalog, defaults, OpenRouter, tests, evals). Do both when upgrading a frontier model.
- [SUBAGENT_REFERENCE.md](SUBAGENT_REFERENCE.md) — full droid catalog, fallback chains, selection guide
- `.factory/droids/` — Factory droid definitions (source of truth for Factory CLI)
- `.cursor/agents/` — Cursor agent definitions (mirror Factory droids for Cursor IDE)
- `coding-agent-instructions/droids/models/` — shared droid templates (submodule, reusable across projects)
- `coding-agent-instructions/droids/models/README.md` — table of all model-specific droids
- `src/shared/data/modelProviderPresets.ts` — canonical model IDs for the app's provider presets
- `src/shared/data/modelCatalog.ts` — model catalog with aliases and pricing

## Principles

- **Three locations, one truth**: Droid definitions exist in three places (`.factory/droids/`, `.cursor/agents/`, `coding-agent-instructions/droids/models/`). All three must stay in sync when upgrading models.
- **Coordinate with app process**: When a droid model upgrade also changes app defaults, follow the companion [NEW_MODEL_SUPPORT_PROCESS](NEW_MODEL_SUPPORT_PROCESS.md) — especially the **Selectability Policy** decision for the old model.
- **Living docs get updated, historical docs don't**: Workflow docs, reference docs, and user-facing help are "living" and must be updated. Planning docs, postmortems, conversations, and changelogs are historical records and should be left as-is.
- **Verify canonical model IDs**: Before renaming, check `src/shared/data/modelCatalog.ts` and `src/shared/data/modelProviderPresets.ts` to confirm the new model ID is valid and canonical (not an alias).
- **Smoke test after rename**: Invoke at least 2 renamed droids via the Task tool to confirm they load, report the correct model, and have the expected reasoning effort.

## Step-by-Step Process

### 1. Identify scope

Search for all droid files and references to the old model name:

```bash
# Find droid definition files
glob **/*<old-model-name>* in .factory/droids/, .cursor/agents/, coding-agent-instructions/droids/models/

# Find all references in living docs
grep '<old-droid-name>' across .factory/, .cursor/, coding-agent-instructions/, docs/project/, factory/, rebel-system/help-for-humans/
```

### 2. Rename droid files (git mv)

Use `git mv` for version-controlled renames. The submodule (`coding-agent-instructions/`) requires running `git mv` from inside the submodule directory.

```bash
# Superproject files
git mv .factory/droids/reviewer-<old>.md .factory/droids/reviewer-<new>.md
git mv .cursor/agents/reviewer-<old>.md .cursor/agents/reviewer-<new>.md

# Submodule files (must cd into submodule)
cd coding-agent-instructions
git mv droids/models/reviewer-<old>.md droids/models/reviewer-<new>.md
```

### 3. Update file contents

In each renamed file, update:
- `name:` frontmatter field
- `model:` frontmatter field (use the canonical model ID)
- `description:` text
- Body text references to old model name
- Cross-references to other renamed droid files (e.g., Cursor agents pointing to Factory droid paths)

### 4. Update living references

Files that typically reference droids by name:

| Location | Files |
|----------|-------|
| `.factory/commands/` | `septuple-implementation-review.md`, `septuple-plan-review.md`, `merge-check.md` |
| `factory/` | `sentry-auto-fix.md`, `e2e-auto-fix.md` |
| `coding-agent-instructions/workflows/` | `CHIEF_ENGINEER2/CHIEF_ENGINEER2.md`, `CHIEF_BUGFIXER.md`, `CHIEF_PATHOLOGIST.md`, `CHIEF_PATHOLOGIST_ANALYSIS.md`, `WORKFLOW_AUDIT.md`, `WRITE_TUTORIAL_FOR_DEVELOPERS.md` |
| `coding-agent-instructions/` | `README.md`, `droids/models/README.md` |
| `docs/project/` | `SUBAGENT_REFERENCE.md`, `PROMPTING_STRATEGIES.md`, `MCP_IMPROVEMENT_WORKFLOW.md`, `GITHUB_CLI_AND_ACTIONS_CHECK.md`, `TESTING_E2E_GAP_ANALYSIS.md` |
| `rebel-system/help-for-humans/` | `AI-models.md`, `multi-model-council-mode.md` |

### 5. Verify no stale references remain

```bash
grep '<old-droid-name>' in .factory/, .cursor/, coding-agent-instructions/, docs/project/, factory/, rebel-system/help-for-humans/
# Should return zero matches
```

### 6. Smoke test

Invoke at least 2 renamed droids via the Task tool:
- Ask each to confirm its model name, read its own droid definition, and verify `reasoningEffort`
- Confirm they can read files and execute basic tasks

### 7. Run validation

```bash
npm run lint          # Ensure no lint regressions
npm run validate:fast # Full fast validation (if time permits)
```

### 8. Commit

Commit superproject and submodule changes separately if needed. The submodule pointer will update in the superproject commit. See the git submodule guidance in `AGENTS.md`.

## Files NOT to update (historical)

These contain old model names as historical records and should be left as-is:
- `docs/plans/` — planning docs
- `docs-private/postmortems/` — incident records
- Google Drive `droid-conversations/` — conversation exports
- `docs-private/investigations/` — investigation records
- `docs-private/reports/` — performance reports
- `docs/research/` — research docs
- `CHANGELOG.md` — release history
- `memory/` — memory captures

## Past Upgrades

| Date | Change | Session |
|------|--------|---------|
| 2026-04-26 | MiniMax M2.5 → M2.7 (coding-agent-only; app catalog unchanged — `minimax/minimax-m2.7` already in `openRouterModels.ts` with legacy remap from m2.5). Renamed 3 droid files (`.factory/droids/reviewer-minimax2.5.md`, `.cursor/agents/reviewer-minimax2.5.md`, `coding-agent-instructions/droids/models/reviewer-minimax2.5.md`) → `reviewer-minimax2.7.md`. Updated `model: minimax-m2.7`, kept `reasoningEffort: high`. Updated 7 living doc references (`.factory/commands/septuple-{plan,implementation}-review.md`, `coding-agent-instructions/workflows/CHIEF_BUGFIXER.md`, `coding-agent-instructions/droids/models/README.md`, `docs/project/PROJECT_OVERRIDES.md`, `docs/project/SUBAGENT_REFERENCE.md`). Added `reviewer-minimax2.7`/`minimax-m2.7` entries to `DROID_MODEL_MAP`, `MODEL_COST_MULTIPLIER`, `MODEL_COLORS`, `MODEL_SHORT` in `coding-agent-instructions/scripts/{analyze_bug_postmortems,analyze_chief_performance,generate_chief_performance_html}.py` while keeping legacy m2.5 mappings for historical chief logs. |
| 2026-04-25 | GPT-5.4 → GPT-5.5 (coding-agent-only; app catalog unchanged). Renamed 11 droid files (5 in `.factory/droids/`, 3 in `.cursor/agents/`, 3 in `coding-agent-instructions/droids/models/`) — `*-gpt5.4-high.md` → `*-gpt5.5-high.md` and `*-gpt5.4.md` → `*-gpt5.5.md`. Updated `model: gpt-5.5`. Kept `reasoningEffort: high` (matches the prior 5.4 setting; GPT-5.5 supports `low/medium/high/xhigh` per OpenAI docs — an initial pass mistakenly bumped to `xhigh` and was reverted). Also updated 8 lens droids' model fields (no rename — filenames don't include version). Updated ~18 living doc references and `DROID_MODEL_MAP` in performance-analysis scripts (kept legacy mappings for historical chief logs). Kept `-high` filename suffix for naming continuity. App catalog not updated — companion [NEW_MODEL_SUPPORT_PROCESS](NEW_MODEL_SUPPORT_PROCESS.md) deferred. |
| 2026-04-16 | Opus 4.6 → Opus 4.7 | Renamed 4 droid files + Cursor mirrors, updated ~20 living doc references. Coordinated with app companion process ([NEW_MODEL_SUPPORT_PROCESS](NEW_MODEL_SUPPORT_PROCESS.md)). |
| 2026-04-05 | Gemini 3 Pro → Gemini 3.1 Pro (`gemini-3-pro-preview` → `gemini-3.1-pro-preview`) | Renamed 10 files, updated 24 living docs |
| 2026-04-06 | **Reviewer-only revert:** Gemini 3.1 Pro → 3 Pro for `reviewer-gemini3.1-pro` only. 3.1 showed +44% overconf, 47% rubber-stamp, 0 criticals vs 3.0's 71% accept, 3 criticals. Other roles (implementer, researcher, debugger) remain at 3.1 — no regression data for those roles. Droid filename kept as `reviewer-gemini3.1-pro` to avoid second rename cascade; only `model:` field changed. | Selective model field revert, DROID_MODEL_MAP update |
