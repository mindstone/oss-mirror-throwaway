---
description: "Catalog of coding subagents — available droids, model roles, fallback chains, selection guidance, specialist coverage"
last_updated: "2026-05-02"
---

# Subagent Reference

Full catalog of available droids, fallback chains, and selection guidance. Droid definitions live in `.factory/droids/*.md`.

For the multi-stage orchestration workflow (planner -> implementer -> reviewers), see [`coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md).

For upgrading subagent models (renaming droids, updating references), see [SUBAGENT_MODEL_UPGRADE_PROCESS.md](SUBAGENT_MODEL_UPGRADE_PROCESS.md).

## Available Droids

| Role | Droid | Model | Use Case |
|------|-------|-------|----------|
| Planner | `planner` | inherit | Planning and research |
| Implementer | `implementer` | inherit | Code implementation |
| Implementer (Codex) | `implementer-gpt5.3-codex` | gpt-5.3-codex | Code implementation, extra high reasoning |
| Implementer (Opus) | `implementer-opus4.7-thinking` | claude-opus-4-7 | Code implementation, extended thinking |
| Implementer (GPT-5.5) | `implementer-gpt5.5-high` | gpt-5.5 | Code implementation, high reasoning |
| Primary Reviewer | `reviewer-gpt5.5-high` | gpt-5.5 | Fast, broad pattern recognition |
| Deep Reviewer (Codex) | `reviewer-gpt5.3-codex` | gpt-5.3-codex | Deep analysis, extra high reasoning |
| Third Reviewer | `reviewer-opus4.7-thinking` | claude-opus-4-7 | Architectural analysis, complex tradeoffs |
| Fourth Reviewer | `reviewer-gemini3.1-pro` | gemini-3-pro-preview | Different perspective (reverted from 3.1 — reviewer regression) |
| Fifth Reviewer | `reviewer-glm5` | glm-5 | Independent verification, correctness |
| Sixth Reviewer | `reviewer-kimi-k2.5` | kimi-k2.5 | Fresh perspective, independent model family |
| Seventh Reviewer | `reviewer-minimax2.7` | minimax-m2.7 | Agentic verification, implementation bugs |
| Debugger (primary) | `debugger-gpt5.5-high` | gpt-5.5 | Evidence-driven diagnosis, high reasoning |
| Debugger (deep, Codex) | `debugger-gpt5.3-codex` | gpt-5.3-codex | Deep reasoning, extra-high effort |
| Debugger (deep, Opus) | `debugger-opus4.7-thinking` | claude-opus-4-7 | Deep analysis, architectural bugs |
| Debugger (second) | `debugger-gemini3.1-pro` | gemini-3.1-pro-preview | Different perspective |
| Debugger (fourth) | `debugger-glm5` | glm-5 | Independent verification |
| Debugger (fifth) | `debugger-kimi-k2.5` | kimi-k2.5 | Fresh perspective, independent model family |
| Researcher | `researcher-gpt5.5-high` / `researcher-opus4.7` / `researcher-gemini3.1-pro` | varies | Problem investigation |
| Chief Designer | `chief-designer` | gpt-5.5 | Delegated senior product-design authority for UI/UX decisions, IA, naming, hierarchy, trust, and shared/app-pattern/local choice |
| Design System Reviewer | `design-system-reviewer` | gpt-5.5 | Design-system migration safety review for shared UI primitives, Storybook, componentisation, size, variant, focus, role/density preservation, and local-vs-shared semantics |
| Documenter | `documenter` | inherit | Doc updates after code changes |
| Auditor | `auditor` | inherit | Codebase standards scanning |
| Mapper | `mapper` | inherit | Codebase structure analysis |
| Documentation Specialist | `specialist-documentation` | gpt-5.5 | Identifies docs to read before planning + docs to update after |
| Testability Specialist | `specialist-testability` | gpt-5.5 | Assesses architectural testability + verification strategy |
| Security Specialist | `specialist-security` | gpt-5.5 | Focused security review: trust boundaries, injection, secrets |
| Performance Specialist | `specialist-performance` | gpt-5.5 | Deep analysis: CPU, memory, bundle size, render performance |
| Operational Specialist | `specialist-operational` | gpt-5.5 | Failure modes, logging, error recovery, rollback, crash consistency |

## Substitution Order (Failure Fallbacks)

| Role | Primary | Substitution order (try in sequence) |
|------|---------|--------------------------------------|
| Planner | `planner` | `researcher-gpt5.5-high` → `researcher-opus4.7` → `researcher-gemini3.1-pro` |
| Implementer | `implementer` | *(no alternates — escalate to user)* |
| Reviewer | any `reviewer-*` | `reviewer-gpt5.5-high` → `reviewer-gpt5.3-codex` → `reviewer-opus4.7-thinking` → `reviewer-gemini3.1-pro` → `reviewer-glm5` → `reviewer-kimi-k2.5` → `reviewer-minimax2.7` |
| Debugger | any `debugger-*` | `debugger-gpt5.5-high` → `debugger-gpt5.3-codex` → `debugger-opus4.7-thinking` → `debugger-gemini3.1-pro` → `debugger-glm5` → `debugger-kimi-k2.5` |
| Researcher | any `researcher-*` | `researcher-gpt5.5-high` → `researcher-opus4.7` → `researcher-gemini3.1-pro` |
| Chief Designer | `chief-designer` | *(no alternates — fall back to a tightly scoped `researcher-*` or `reviewer-*` prompt grounded in `rebel-system/skills/ux/chief-designer/SKILL.md`)* |
| Design System Reviewer | `design-system-reviewer` | *(no alternates — fall back to `reviewer-gpt5.5-high` grounded in `rebel-system/skills/ux/design-system-reviewer/SKILL.md`)* |
| Documenter | `documenter` | *(no alternates — escalate to user)* |

## Subagent Selection Guide

| Task | Subagent | When |
|------|----------|------|
| Research/investigation | `researcher-gpt5.5-high` | Default for codebase exploration. **Policy**: all non-trivial coding tasks must at minimum consult a GPT subagent for cross-model perspective before implementation (see AGENTS.md "How to Work") |
| Planning | `planner` | Complex multi-stage work |
| Code review | `reviewer-gpt5.5-high` | Default reviewer; fast, broad pattern recognition |
| Deep review | `reviewer-gpt5.3-codex` | Deep analysis, extra high reasoning (Codex) |
| Third opinion | `reviewer-opus4.7-thinking` | Architectural/complex tradeoffs |
| Bug fixing | `debugger-gpt5.5-high` | Default debugger (fast); evidence-driven diagnosis |
| Deep debugging | `debugger-opus4.7-thinking` | Architectural/complex bugs |
| Second opinion | `debugger-gemini3.1-pro` | Different perspective on root cause |
| Product-design judgment | `chief-designer` | When a CHIEF_ENGINEER task needs a real design decision before implementation: IA, components, naming, hierarchy, trust, state design, or shared/app-pattern/local choice |
| Design-system migration safety | `design-system-reviewer` | After shared UI primitive, Storybook, or componentisation work: verify before/after role, density, hierarchy, trust, size recipes, variant preservation, focus ownership, and local-vs-shared semantics |
| Doc updates | `documenter` | After code changes |
