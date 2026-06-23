---
description: "2025 docs/project audit report — broken links, orphan docs, missing cross-references, stale plan links, and consolidation recommendations"
last_updated: "2026-05-14"
---

# Documentation Audit Report (2025-12-26)

## 1. Broken Links & References
A significant number of internal links are broken due to file movements and restructuring.

### A. Moved Plan Files
Many documentation files link to plans in `docs/plans/` that have been moved to `docs/plans/finished/` or `docs/plans/obsolete/`.

*   **`ARCHITECTURE_OVERVIEW.md` links to:**
    *   `../plans/251114_context_loss_analysis.md` (Moved to `finished/`)
    *   `../plans/251114_context_loss_fix.md` (Moved to `finished/`)
    *   `../plans/251115_distribution_strategy_exploration.md` (Moved to `finished/`)
    *   `../plans/251114_http_health_check_fix.md` (Moved to `finished/` - referenced via `MCP_ARCHITECTURE.md`)
*   **`KEYBOARD_SHORTCUTS.md` links to:**
    *   `../plans/251212_keyboard_shortcuts_feature.md` (Moved to `finished/`)
*   **`TOOL_SAFETY.md` links to:**
    *   `../plans/251208_Tool_Safety_SDK_Hooks_Spec.md` (Moved to `finished/`)
*   **`CONVERSATION_MENTIONS.md` links to:**
    *   `../plans/251219_conversation_references.md` (Moved to `finished/`)
*   **`REFACTORING_WORKFLOW.md` links to:**
    *   `docs/plans/obsolete/251206_large_file_refactoring_plan.md` (Moved to `obsolete/`)

### B. Rebel System Skills Restructuring
`rebel-system` skills have been restructured from flat markdown files to directories containing `SKILL.md`.

*   **`CODING_PRINCIPLES.md` links to:**
    *   `../../rebel-system/skills/coding/Git-commit-changes.md` -> Should be `../../rebel-system/skills/coding/git-commit-changes/SKILL.md`
    *   `../../rebel-system/skills/coding/Git-resolve-merge-conflicts.md` -> Should be `.../git-resolve-merge-conflicts/SKILL.md`
    *   `../../rebel-system/skills/coding/third-party-choosing-products-utilities-libraries.md` -> Should be `.../third-party-choosing-products-utilities-libraries/SKILL.md`
    *   `../../rebel-system/skills/documentation/signposting-to-single-source-of-truth.md` -> Should be `.../documentation/signposting-to-single-source-of-truth/SKILL.md`
    *   (And others in this file)

### C. Relative Path Issues
*   **`URL_PROTOCOL.md`**: Contains broken links like `rebel://conversation/abc123`. These are example URIs, not file links, but should be formatted as code to avoid confusion.
*   **`TESTING_E2E.md`**: Reference to `src/renderer/components/ui/README.md` is relative to the doc (which would be `docs/project/src/...`) but intends to point to the project root `src/`.

## 2. Orphan Docs
These documents are not referenced by `README.md`, `AGENTS.md`, or any other scanned document in `docs/project/`. They risk becoming stale or undiscoverable.

*   `COST_TRACKING.md`
*   `DIAGNOSTICS.md`
*   `DISCARD_WHITESPACE_ONLY_CHANGES.md`
*   `FILE_WATCHING.md`
*   `KLAVIS_TO_BUNDLED_MCP_MIGRATION.md` (Referenced by `MCP_ARCHITECTURE.md` but not central index)
*   `LINUX_SUPPORT.md`
*   `UI_LOADING_SPINNER.md`
*   `MCP_IMPROVEMENT_WORKFLOW.md`
*   `MIGRATIONS_TODO_WE_SHOULD_WRITE.md`
*   `PRIVACY_MODE.md`
*   `PYTHON_RUNTIME.md`
*   `REFACTORING_WORKFLOW.md` (Important process doc, should be linked from `CHIEF_ENGINEER2/CHIEF_ENGINEER2.md` or `AGENTS.md`)
*   `RESET_ONBOARDING.md`
*   `RESILIENCE_TO_CONNECTIVITY_AND_CRASHES.md`
*   `SEARCH.md`
*   `SEMANTIC_SEARCH.md`
*   `SENTRY_TRIAGE.md`
*   `TIME_SAVED.md`
*   `TIPS_AND_QUIPS.md`
*   `TOOLTIPS.md`
*   `TOOL_AWARENESS.md`
*   `WRITE_SECURITY_WHITEPAPER.md` (Found in grep of AGENTS.md, likely false positive in script or recent change)

## 3. Missing Cross-References
*   **`TESTING_E2E.md`**: Should link to `CODING_PRINCIPLES.md` to reinforce testing standards during development.
*   **`CODING_PRINCIPLES.md`**: Should link to `REFACTORING_WORKFLOW.md` as the mechanism for maintaining those principles.
*   **`AGENTS.md`**: Should add `REFACTORING_WORKFLOW.md` to the "Development Workflows" section.

## 4. Content Quality & Overlap
*   **Testing Docs**: `TESTING_E2E.md`, `TESTING_AUTOMATION_OVERVIEW.md`, `TESTING_AUTOMATION_WITH_PLAYWRIGHT.md`, `UI_TESTER.md`. Separation is good (Overview vs Quickstart vs Deep Dive), but ensure `TESTING_AUTOMATION_OVERVIEW.md` remains the single source of truth for the *strategy*.
*   **MCP Docs**: `MCP_ARCHITECTURE.md` is excellent and up-to-date.
*   **Architecture**: `ARCHITECTURE_OVERVIEW.md` is well-connected but relies on "finished" plans for some technical details (Context Loss, HTTP Health Check). Consideration should be given to migrating key implementation details from these "finished plans" into permanent docs (like `RESILIENCE_TO_CONNECTIVITY_AND_CRASHES.md` or `ARCHITECTURE_OVERVIEW.md` itself) so the "plan" link can be removed.

## 5. Contradictions
*   Docs linking to "active" plans that are actually "finished/obsolete" implies the doc believes the work is in progress or the plan is the current spec, whereas the work is done. This can mislead agents looking for the "current" state.

## Recommendations
1.  **Fix Plan Links**: Bulk update all `../plans/xxx` links to `../plans/finished/xxx` (or `obsolete/`) where appropriate.
2.  **Fix Skill Links**: Update `CODING_PRINCIPLES.md` to point to the new `SKILL.md` paths.
3.  **Index Orphans**: Add key orphans (like `REFACTORING_WORKFLOW.md`, `DIAGNOSTICS.md`) to `AGENTS.md` or `README.md`.
4.  **Consolidate Plan Info**: Extract architectural decisions from `finished` plans into the permanent documentation to reduce reliance on historical plan files.
