---
description: "Session kind classification reference — visibility, deletion, checkpointing axes, predicates, consumers, migration rules"
last_updated: "2026-06-18"
---

# Session Kinds

`src/shared/sessionKind.ts` is the canonical classification layer for session lifecycle behavior.

## Axes

Every `SessionKind` is evaluated on four orthogonal axes:

1. **sidebarVisible** — whether it can appear in the sidebar.
2. **deleteEligible** — whether startup cleanup can safely delete it.
3. **shouldSkipCheckpointing** — whether main-process turn checkpointing should be skipped.
4. **excludedFromActive** — whether the kind is omitted from the Active tab even when lifecycle state says active.

`shouldSkipCheckpointing` currently matches `deleteEligible`.

## Kind Matrix

| SessionKind | sidebarVisible | deleteEligible | shouldSkipCheckpointing | excludedFromActive |
| --- | --- | --- | --- | --- |
| `conversation` | ✅ | ❌ | ❌ | ❌ |
| `meeting-companion` | ✅ | ❌ | ❌ | ❌ |
| `automation` | ✅ | ❌ | ❌ | ✅ |
| `role-checkin` | ✅ | ❌ | ❌ | ❌ |
| `automation-insight` | ✅ | ❌ | ❌ | ❌ |
| `meeting-analysis` | ✅ | ❌ | ❌ | ✅ |
| `use-case-discovery` | ✅ | ❌ | ❌ | ✅ |
| `cli-chat` | ✅ | ❌ | ❌ | ❌ |
| `memory-update` | ❌ | ✅ | ✅ | ❌ |
| `meeting-qa` | ❌ | ✅ | ✅ | ❌ |
| `error-eval` | ❌ | ✅ | ✅ | ❌ |
| `calendar-sync` | ❌ | ✅ | ✅ | ❌ |

## Excluded from Active

`EXCLUDED_FROM_ACTIVE_KINDS` is the Active-only exclusion set. Principle:
Active = conversations the user is personally working on. A kind is excluded
from Active iff the session is created without an explicit user action that
initiates a conversation.

Excluded: `automation`, `meeting-analysis`, `use-case-discovery`.
Kept in Active: `automation-insight` (user clicked Explore), `cli-chat` (user opened the CLI), and ordinary `conversation` / `meeting-companion` sessions.

## Classification Rules

- Use `classifySessionKind(sessionId, hints?)`.
- Meeting companion sessions are classified via `hints.isCompanion` (not a prefix).
- Legacy `error-eval-*` IDs classify as `error-eval` (distinct from `meeting-qa`).

## Predicates

- Kind-level: `isSidebarHiddenKind`, `isBackgroundConversationKind`, `isDeleteEligibleKind`, `shouldSkipCheckpointing`
- ID-level: `isSidebarHiddenSession`, `isBackgroundConversationSession`, `isDeleteEligibleSession`

## Phase 1 Consumers

- `src/main/services/turnPipeline/turnAdmission.ts`
- `src/core/services/agentEventDispatcher.ts`
- `src/core/services/incrementalSessionStore.ts`
- `src/renderer/features/inbox/utils/backgroundTaskLabels.ts`
- `src/renderer/features/agent-session/hooks/useSessionHistoryView.ts`
- `src/renderer/features/agent-session/hooks/useSessionSearch.ts`
- `src/renderer/features/usecases/hooks/useCoachingInsights.ts`
- `src/renderer/features/automations/hooks/useAutomationApprovals.ts`

When adding a new session category, update `sessionKind.ts` first, then migrate consumers via predicates instead of direct prefix checks.
