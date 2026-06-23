---
description: "AI-driven refactoring workflow — discovery-first audits, subagent roles, refactoring logs, checkpoints, validation"
last_updated: "2026-05-14"
---

# AI-Driven Refactoring Workflow

Instructions for conducting periodic, AI-driven code refactoring to maintain codebase quality and AI-agent workability.

---

## Overview

This workflow enables systematic, periodic refactoring of the codebase to ensure it remains maintainable and easy for AI agents to work with effectively. It uses a discovery-first approach with human checkpoints.

### Goals
- Keep codebase aligned with coding standards (`docs/project/CODING_PRINCIPLES.md`)
- Reduce complexity and improve code organization
- Remove dead code, duplication, and technical debt
- Ensure architectural boundaries are respected
- Document decisions for future refactoring efforts

### Key Principles
- **Discovery first** - Audit before planning, plan before implementing
- **Behavior preservation by default** - Changes should not alter functionality unless explicitly approved
- **Human checkpoints** - User approves scope and each area's plan before implementation
- **Parallel execution allowed** - Multiple areas can be refactored simultaneously with proper coordination
- **Living documentation** - Refactoring log captures all decisions for future reference

---

## Subagent Roles

| Role | Responsibility |
|------|----------------|
| **Main Agent (You)** | Coordinates workflow, synthesizes feedback, passes cross-area context to subagents |
| **Mapper** | Analyzes codebase structure, breaks it into discrete areas (runs once at start) |
| **Auditor** | Scans one area against standards, identifies refactoring candidates (fresh instance per area) |
| **Planner** | Creates staged refactoring plan per area (fresh instance) |
| **Implementer** | Executes one stage at a time (fresh instance per stage) |
| **Reviewer(s)** | Reviews plans and implementations (single or triple-review) |
| **Documenter** | Checks and updates affected documentation at completion |

**Important:** Each subagent is a fresh instance that cannot be called back. The refactoring log serves as shared memory, and you (the main agent) are the only persistent context holder. Include relevant cross-area learnings in each subagent prompt.

**File Writing:** Subagents have read-only tools. They output paste-ready markdown sections; **you (main agent) apply their output to the refactoring log**. Subagents should never claim to have "updated" a file—they provide content for you to apply.

**Confidence Thresholds** (from CHIEF_ENGINEER):
- **>= 80%**: Proceed automatically
- **70-79%**: Proceed with logged caution
- **< 70%**: Pause and ask user before proceeding

---

## The Refactoring Log

The refactoring log (`docs/refactoring-logs/YYMMDD_<scope-summary>.md`) is the central artifact that captures the entire refactoring effort. The `<scope-summary>` should be a brief kebab-case descriptor (e.g., `251224_ipc-handlers-cleanup.md`, `251224_renderer-hooks-extraction.md`).

### Purpose
- Document what was audited and found
- Record prioritization decisions and rationale
- Track which areas were refactored and how
- Capture learnings for future refactoring efforts
- Enable any agent to understand what happened and why

### Template

```markdown
# Refactoring Log: YYYY-MM-DD

Status: in-progress | complete | abandoned
Started: YYYY-MM-DD HH:MM
Completed: YYYY-MM-DD HH:MM (if applicable)

## Trigger
<what prompted this refactoring effort>

## Area Map
<populated by mapper - see Area Map section below>

### Areas Overview
| # | Area ID | Area Name | Files | Size | Depends On |
|---|---------|-----------|-------|------|------------|
| 1 | <id> | <name> | N | S/M/L | <area-ids> |

### Suggested Audit Order
1. <area> - <rationale>

## Audit Summary (Per Area)
<high-level findings from the audit phase>

### Candidates Identified
| Area | Issue Type | Severity | Selected |
|------|------------|----------|----------|
| ... | ... | ... | yes/no |

### Candidates Not Selected (and why)
- <area>: <reason for deferring>

## Refactoring Decisions

### Area: <area name>
**Issue:** <what was wrong>
**Approach:** <how we're fixing it>
**Rationale:** <why this approach>
**Behavior Changes:** none | <description if any, with user approval note>

#### Implementation Notes
- Stage 1: <what happened, decisions made>
- Stage 2: ...

#### Learnings
- <things discovered during implementation>
- <patterns that should be applied elsewhere>

## Validation Results
- Lint: pass/fail
- Type-check: pass/fail
- Unit tests: pass/fail
- E2E tests: pass/fail

## Summary of Changes
<brief description of all changes made>

## Follow-ups for Future Refactoring
- <issues discovered but not addressed>
- <patterns that need broader application>
```

---

## Workflow Phases

### Phase 0: Initiation

**You do this:**

1. Create the refactoring log at `docs/refactoring-logs/YYMMDD_<scope-summary>.md` (e.g., `251224_state-management-cleanup.md`)
2. Log: `[REFACTOR] Refactoring initiated`

3. **Staff Engineer Challenge** - Before spinning up the full workflow, briefly assess:
   > "Is a full refactoring workflow warranted here?
   > - Would targeted fixes suffice instead?
   > - Is the codebase stable enough (no conflicting branches)?
   > - Is there sufficient time for a systematic effort?"
   
   If concerns arise, discuss with user before proceeding.

4. Ask user for any specific focus areas or constraints
5. Determine review mode:
   - **Single-review** (default): `reviewer-gpt5.5-high`
   - **Triple-review** (for high-risk changes): All three reviewers
6. Proceed to Phase 1

---

### Phase 1: Mapping (Delegate to Mapper)

**Delegate to mapper subagent.** The mapper runs ONCE to break the codebase into discrete, auditable areas.

**Prompt to mapper:**

> "Analyze the codebase structure and create an area map for this refactoring effort.
> 
> **Refactoring Log:** `docs/refactoring-logs/YYMMDD_<scope-summary>.md`
> 
> **Focus areas (if specified by user):**
> <any user-specified focus or constraints>
> 
> **Your task:**
> 1. Read `docs/project/ARCHITECTURE_OVERVIEW.md` to understand architectural boundaries
> 2. Walk the directory structure (`src/core/`, `src/main/`, `src/renderer/`, `src/shared/`, `src/preload/`, `cloud-service/src/`)
> 3. Define discrete audit areas (target 10-40 files each)
> 4. Identify cross-cutting concerns that span multiple areas
> 5. Map dependencies between areas
> 6. Suggest audit ordering (foundational areas first)
> 
> **Grouping rules:**
> - Keep feature directories together (`src/renderer/features/<name>/`)
>   - Exception: If a feature >50 files, split by subfolders (`components/`, `hooks/`, `store/`, `utils/`)
> - Large files (>30KB) become standalone areas or get flagged for special attention
> - Respect process boundaries (main vs renderer never in same area)
> - Target 10-40 files per area; if an area exceeds 50 files, split it
> 
> **Output:**
> - Update the refactoring log with the Area Map section
> - Include Areas Overview table with sizes and dependencies
> - Include Suggested Audit Order with rationale
> - Report confidence level (0-100%)
> 
> Ask the user if you need clarification."

**After receiving area map:**
1. Log: `[REFACTOR] Area map received (X areas identified, confidence: Y%)`
2. **Apply the mapper's output** to the refactoring log (Area Map section)
3. **If confidence < 70%**, pause and discuss with user before proceeding
4. **Validate the area map** (quick sanity checks):
   - Are any areas >50 files? (should be split)
   - Do any areas mix main/renderer? (boundary violation)
   - Are dependencies logical? (foundational areas identified?)
5. **Optionally delegate to reviewer** for complex codebases:
   > "Review this area map for the refactoring effort.
   > Verify: area sizes are reasonable, boundaries respect architecture, 
   > suggested order makes sense, no obvious areas missed."
6. If issues found, ask mapper to regenerate with specific guidance (max 2 attempts)
7. Proceed to Phase 2

---

### Phase 2: Audit (Per Area - Delegate to Auditor)

**For each area (following the suggested audit order), delegate to auditor subagent.** Each auditor gets fresh context focused on one area.

**Prompt to auditor (per area):**

> "Conduct an audit of the following area to identify refactoring candidates.
> 
> **Refactoring Log:** `docs/refactoring-logs/YYMMDD_<scope-summary>.md`
> (Read the Area Map section first for context on this area's boundaries and dependencies)
> 
> **Area to audit:** <area-id> - <area-name>
> **Files in scope:** <file list or glob pattern from area map>
> 
> **Cross-area context from previous audits:**
> <include relevant findings from already-audited areas that affect this one>
> 
> **Standards to check against:**
> - `docs/project/CODING_PRINCIPLES.md` - Core coding standards
> - `docs/project/AGENTS.md` - AI agent guidance and patterns
> - `docs/project/ARCHITECTURE_IPC.md` - IPC patterns
> - `docs/project/ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md` - State management patterns
> - `docs/project/HOOK_CONVENTIONS.md` - Hook patterns
> - `docs/project/UI_OVERVIEW.md` - UI patterns
> 
> **What to look for:**
> 1. Files violating size/complexity guidelines
> 2. Code not following established patterns
> 3. Dead code or unused exports
> 4. Duplication that should be extracted
> 5. Inconsistent naming or structure
> 6. Architectural boundary violations
> 7. Deprecated patterns still in use
> 
> **Output:**
> - Update the refactoring log with audit findings for this area
> - Categorize candidates by type and severity
> - Note dependencies on other areas
> - Report confidence level (0-100%)
> 
> Ask the user if you need clarification about standards."

**After receiving each area's audit:**
1. Log: `[REFACTOR] Audit complete for <area> (X candidates identified)`
2. Review the findings
3. **Extract cross-area learnings** to include in prompts for subsequent area audits
4. Continue to next area, or proceed to Phase 3 when all areas audited

---

### Phase 3: Triage (You + User)

**You facilitate prioritization with the user.**

**Actions:**

1. Present audit summary to user:

> "The audit identified X refactoring candidates:
> 
> **High Priority:**
> - <area>: <issue summary>
> 
> **Medium Priority:**
> - <area>: <issue summary>
> 
> **Low Priority:**
> - <area>: <issue summary>
> 
> **Dependencies noted:**
> - <any order constraints>
> 
> **Recommended scope for this effort:** <your recommendation>
> 
> Which areas would you like to proceed with?"

2. Record user's selection in the refactoring log
3. Document why deferred candidates were not selected
4. Log: `[REFACTOR] Scope approved: <areas>`
5. Proceed to Phase 4

---

### Phase 4: Planning (Per Area)

**For each selected area, delegate to planner subagent.**

**Prompt to planner:**

> "Create a refactoring plan for the following area.
> 
> **Refactoring Log:** `docs/refactoring-logs/YYMMDD_<scope-summary>.md`
> (Read this first for context on the overall effort and audit findings)
> 
> **Area:** <area name>
> **Issue:** <issue from audit>
> 
> **Standards References:**
> - `docs/project/CODING_PRINCIPLES.md`
> - <other relevant docs>
> 
> **Constraints:**
> - Preserve existing behavior unless user has approved changes
> - Keep changes minimal and focused
> - Each stage must leave tests passing
> 
> **Output:**
> - Create planning doc at `docs/plans/YYMMDD_refactor_<area>.md`
> - Reference the refactoring log
> - Include staged breakdown with rationale
> - Note any behavior changes that would significantly improve quality
> - Report confidence level (0-100%)
> 
> Ask the user if you need clarification."

**After receiving plan:**
1. Log: `[REFACTOR] Plan created for <area>`
2. Delegate to reviewer(s) for plan review
3. Synthesize feedback and refine plan
4. Update refactoring log with key decisions
5. Proceed to Phase 5

---

### Phase 5: User Approval (Per Area)

**Present plan to user for approval.**

> "The refactoring plan for **<area>** is ready.
> 
> **Planning Doc:** `docs/plans/YYMMDD_refactor_<area>.md`
> 
> **Summary:**
> <brief description of stages>
> 
> **Behavior Changes:** none | <list any proposed behavior changes>
> 
> **Confidence:** X%
> **Reviewer Confidence:** X%
> 
> **Proceed with implementation?** (yes/no/modify)"

**User options:**
- **yes** → Proceed to Phase 6
- **no** → Skip this area, proceed to next
- **modify** → Return to Phase 4 with modifications

---

### Phase 6: Implementation (Per Stage)

**For each stage, delegate to implementer subagent.**

This follows the same pattern as [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md):

1. **Implementer** executes stage, updates planning doc with learnings
2. **Reviewer** reviews implementation
3. **You** synthesize feedback and make targeted fixes (max 2 iterations)
4. Tests must pass before proceeding
5. Update refactoring log with implementation notes

**Key addition for refactoring:**

After each stage, update the refactoring log's "Implementation Notes" section with:
- What was actually done
- Decisions made during implementation
- Anything that differed from the plan

---

### Phase 7: Completion

**After all areas are complete:**

1. Run full validation suite:
   ```bash
   npm run lint
   npm run validate:ipc
   npm run test
   npm run test:e2e
   ```

2. **Documentation check** - Delegate to `documenter`:
   > "Review refactoring for **<areas>**. Check `docs/project/` for docs needing updates or propose new docs if needed. Update or report findings."

3. Update refactoring log with:
   - Validation results
   - Summary of all changes
   - Follow-ups for future refactoring
   - Learnings discovered

4. Generate summary for user:

```
[REFACTOR] === Refactoring Complete ===

Refactoring Log: docs/refactoring-logs/YYMMDD_<scope-summary>.md

Areas Refactored: X
- <area 1>: <summary>
- <area 2>: <summary>

Files Modified: X
- <list>

Validation:
- Lint: pass
- Type-check: pass
- Unit tests: pass (X/X)
- E2E tests: pass (X/X)

Follow-ups Identified:
- <items for future refactoring>

Key Learnings:
- <learnings for future efforts>
```

5. Ask user: *"Would you like me to commit these changes?"*

---

## Parallel Execution

Multiple areas can be refactored in parallel when:
- They have no file overlap
- They don't have dependency ordering requirements

**Coordination requirements:**
- Each area has its own planning doc
- All updates to the refactoring log must be coordinated
- Validation runs against all changes together before completion

---

## Rollback Protocol

If refactoring goes wrong:

1. **Stop immediately** when issues are detected
2. Log: `[REFACTOR] Issue detected: <description>`
3. **Options:**
   - Fix forward: Address the issue and continue
   - Partial rollback: `git checkout -- <files>` for specific files
   - Full rollback: `git checkout -- .` to discard all changes
4. Document in refactoring log what happened and why
5. Ask user how to proceed

---

## Quality Gates

### After Each Stage
- `npm run lint` must pass
- Tests must pass

### Before Completion
- `npm run lint` - TypeScript type-check
- `npm run validate:ipc` - IPC contracts valid
- `npm run test` - Unit tests pass
- `npm run test:e2e` - E2E tests pass

---

## When to Trigger Refactoring

This workflow is **on-demand** (user-initiated). Consider triggering when:
- Before starting a major new feature
- After a large feature is complete
- When agents report difficulty working in certain areas
- Periodically (e.g., monthly) for maintenance

---

## Quick Reference

| Phase | Who | Action |
|-------|-----|--------|
| 0 | You | Create refactoring log, confirm scope/mode |
| 1 | Mapper subagent | Break codebase into discrete areas |
| 2 | Auditor subagent (per area) | Scan each area, identify candidates |
| 3 | You + User | Prioritize and select scope |
| 4 | Planner subagent | Create refactoring plan per area |
| 5 | User | Approve plan per area |
| 6 | Implementer + Reviewer | Execute and validate stages |
| 7 | You + Documenter | Complete, doc check, summarize, offer to commit |

---

## Related Documents

- [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) - General task coordination workflow (this builds on it)
- [CODING_PRINCIPLES.md](CODING_PRINCIPLES.md) - Standards to enforce
- [sub_agents/mapper.md](sub_agents/mapper.md) - Mapper subagent instructions (project-specific)
- [sub_agents/auditor.md](sub_agents/auditor.md) - Auditor subagent instructions (project-specific)
- [sub_agents/documenter.md](sub_agents/documenter.md) - Documenter subagent instructions (project-specific)
- Generic subagent instructions live in `coding-agent-instructions/sub_agents/` and `coding-agent-instructions/droids/`

### Existing Refactoring Examples
- `docs/plans/obsolete/251206_large_file_refactoring_plan.md` - Large file splitting
- `docs/plans/finished/251130_modular_architecture_refactor_plan.md` - Modular architecture

---

## Checklist

- [ ] Refactoring log created
- [ ] Area map complete (mapper)
- [ ] All areas audited (auditor per area)
- [ ] User approved scope
- [ ] For each selected area:
  - [ ] Plan created and reviewed
  - [ ] User approved plan
  - [ ] Stages implemented and reviewed
  - [ ] Refactoring log updated with notes
- [ ] Full validation passed
- [ ] Refactoring log completed
- [ ] User notified
