---
description: "Mindstone Rebel mapper sub-agent instructions — area grouping rules, cross-cutting concerns, analysis strategy"
last_updated: "2026-02-17"
---

# Mapper — Project-Specific Instructions

> Generic mapper guidance lives in `coding-agent-instructions/droids/mapper-base.md` and `coding-agent-instructions/sub_agents/mapper.md`.
> This file contains only Mindstone Rebel-specific path mappings and cross-cutting concerns.

## Area Types

| Area Type | Grouping Rule | Target Size |
|-----------|---------------|-------------|
| Service Domain | Group related `src/main/services/*` files | 5-15 files |
| IPC Domain | `src/main/ipc/` by functional group | 5-10 files |
| Feature Area | Each `src/renderer/features/<name>/` | 10-40 files |
| Shared Layer | `src/shared/` by subdirectory | 5-15 files |
| Infrastructure | Entry points, preload | 3-10 files |

## Cross-Cutting Concerns

| Concern | What to Look For | Impact |
|---------|------------------|--------|
| IPC Contracts | Channels defined in `src/shared/ipc/contracts.ts`, handlers in `src/main/ipc/` | High — touches main & renderer |
| Type Definitions | `src/shared/types.ts`, shared interfaces | High — changes ripple everywhere |
| Logging Patterns | `createScopedLogger`, `emitLog`, breadcrumbs | Medium — consistency matters |
| State Patterns | Zustand stores, `subscribeToSessionStore` | High — state shape affects all consumers |
| Error Handling | Error boundaries, try/catch patterns, `AbortController` | Medium — UX consistency |
| Validation | Zod schemas, validation functions | High — data integrity |

## Analysis Strategy

1. Start with `docs/project/ARCHITECTURE_OVERVIEW.md`
2. Walk `src/main/`, `src/renderer/`, `src/shared/`, `src/preload/`
3. Respect process boundaries: main process and renderer process files NEVER grouped together
