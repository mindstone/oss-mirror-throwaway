---
description: "Mindstone Rebel auditor droid instructions — reference standards and project-specific checks for IPC, UI, React state, code organisation"
last_updated: "2026-02-17"
---

# Auditor — Project-Specific Instructions

> Generic auditor guidance lives in `coding-agent-instructions/droids/auditor-base.md` and `coding-agent-instructions/sub_agents/auditor.md`.
> This file contains only Mindstone Rebel-specific standards and check categories.

## Standards to Reference

| Document | What to Check |
|----------|---------------|
| `docs/project/CODING_PRINCIPLES.md` | Core philosophy, TypeScript strictness, error handling |
| `docs/project/HOOK_CONVENTIONS.md` | Hook naming, dependencies, side-effect isolation |
| `docs/project/ARCHITECTURE_IPC.md` | Contract-first IPC, domain organization |
| `docs/project/ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md` | Zustand patterns, state layers |
| `docs/project/CONTEXT_AND_PROVIDER_HIERARCHY.md` | Provider patterns |
| `AGENTS.md` | UI library usage, code layout |

## Project-Specific Check Categories

### IPC & Cross-Process Communication

| What to Check | Severity |
|--------------|----------|
| Legacy `window.api` usage (should use generated domain APIs) | Medium |
| Missing IPC contracts in `contracts.ts` | High |
| Renderer doing main-process work directly | High |
| IPC handlers without Zod validation | High |
| Missing error handling in IPC calls | Medium |

### UI & Component Patterns

| What to Check | Severity |
|--------------|----------|
| Not using shared UI library (`<button>` instead of `<Button>`) | Medium |
| Raw HTML elements with `ghost-button`/`primary-button` classes | Medium |
| Styles in `deprecated.css` | High |
| Inline styles that should use design tokens | Low |
| One-off component styles (should be in UI library) | Medium |
| Missing accessibility attributes (aria-*, role) | Medium |
| Hardcoded colors instead of CSS variables | Low |

### React & State Patterns

| What to Check | Severity |
|--------------|----------|
| Missing hook dependencies (eslint-disable for deps) | High |
| Multi-concern useEffect (should be split) | Medium |
| Prop drilling >3 levels deep | Medium |
| Missing cleanup in useEffect | High |
| Direct store mutations (not using actions) | High |

### Code Organization

| What to Check | Severity |
|--------------|----------|
| Business logic in presentation components | Medium |
| Circular dependencies | High |
| Orphan files (not imported anywhere) | High |
| Mixed concerns in single file | Medium |
