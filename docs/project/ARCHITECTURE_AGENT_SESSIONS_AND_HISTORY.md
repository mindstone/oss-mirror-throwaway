---
description: "Canonical reference for Rebel agent sessions, persisted history, and context continuity behavior."
last_updated: "2026-06-18"
---

### Introduction

Mindstone Rebel models user conversations as durable **agent sessions** that can be resumed from history.
This document is the canonical reference for how sessions, turns, events, and persisted history work together. Rebel Core maintains context via local history injection (since April 2026).


## See Also

- [SYSTEM_ARCHITECTURE](ARCHITECTURE_OVERVIEW.md) - High-level system architecture, component responsibilities, and session lifecycle
- [ARCHITECTURE_CONVERSATION_CONTEXT_CONTINUITY](ARCHITECTURE_CONVERSATION_CONTEXT_CONTINUITY.md) - How context is preserved or lost across turns, restarts, edits, fallbacks, and compaction (resetConversation flag, history injection, interaction matrix)
- [ARCHITECTURE_MESSAGE_QUEUE](ARCHITECTURE_MESSAGE_QUEUE.md) - Message queue and interrupt-mode design layered on top of sessions
- [ARCHITECTURE_RENDERER_STATE_MANAGEMENT](ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md) - Renderer state architecture and session engine internals
- [LIBRARY_AND_FILE_ACCESS](LIBRARY_AND_FILE_ACCESS.md) - Workspace configuration and how it relates to session execution context
- [UI_OVERVIEW](UI_OVERVIEW.md) - High-level UI layout and interaction patterns
- [UI_SIDEBAR_SESSION_HISTORY](UI_SIDEBAR_SESSION_HISTORY.md) - Session sidebar UI: list display, search, filtering, pinning, and session actions
- [IPC_ARCHITECTURE](ARCHITECTURE_IPC.md) - IPC contract system for session operations and history persistence
- [LOGGING](LOGGING.md) - Structured logging architecture for debugging session restore issues
- [DIAGNOSTICS](DIAGNOSTICS.md) - System health checks, diagnostic bundle export, and session context for troubleshooting
- [CONVERSATION_MENTIONS](CONVERSATION_MENTIONS.md) - @-mention syntax for referencing previous conversations
- [URL_PROTOCOL](URL_PROTOCOL.md) - Custom URL protocols (`rebel://`, `rebel://library/`, plus legacy `library://` / `workspace://`)
- [THE_SPARK](THE_SPARK.md) - Dashboard with coaching insights; evaluates completed sessions for missed opportunities


### Implementation references

- `../plans/finished/251114_context_loss_analysis.md` - Root-cause analysis of the original "history resume loses context" bug and the design constraints it revealed.
- `../plans/finished/251114_context_loss_fix.md` - Implementation details of the session persistence and restore flow described here.
- `../../src/shared/types.ts` - Source of `AgentSession`, `AgentEvent`, `AgentTurnMessage`, and `AgentTurnRequest` types referenced throughout this document.
- `../../src/main/index.ts` - Main-process startup, session history persistence (`loadAgentSessions`, `saveAgentSessions`).
- `../../src/main/services/agentTurnExecutor.ts` - Agent turn orchestration (`executeAgentTurn`).
- `../../src/main/services/agentMessageHandler.ts` - Agent message routing (`handleAgentMessage`).
- `../../src/main/services/agentEventDispatcher.ts` - Event dispatch to renderer (`dispatchAgentEvent`).
- `../../src/core/services/agentTurnRegistry.ts` - Turn/session mapping registry (`rendererSessionByTurn`).
- `../../src/renderer/App.tsx` - Renderer implementation of conversation state, history UI, message queue, and history-resume logic.

#### Function-level references (quick signposts)

- Agent turn executor (`src/main/services/agentTurnExecutor.ts`)
  - `executeAgentTurn(win, turnId, prompt, options)` - Orchestrates each turn; binds `rendererSessionByTurn`, calls `queryWithRuntime()` -> `rebelCoreQuery()`, iterates agent messages and calls `handleAgentMessage`.
- Agent message handler (`src/main/services/agentMessageHandler.ts`)
  - `handleAgentMessage(win, turnId, message)` - Processes agent messages from Rebel Core; forwards `status`/`assistant`/`result`/`tool` events via `dispatchAgentEvent`.
- Agent event dispatcher (`src/main/services/agentEventDispatcher.ts`)
  - `dispatchAgentEvent(win, turnId, event)` - Sends `{ turnId, event }` over `agent:event` to the renderer and any automation listeners.
- Main process (`src/main/index.ts`)
  - `loadAgentSessions()` / `saveAgentSessions()` - Read/write incremental file-per-session store (`userData/sessions/`), apply migrations, check version marker for read-only mode, and call `markSessionTurnsAsCompleted` on load. Eviction (oldest Done first; Active sessions never evicted) is handled by the session store when the cap is exceeded.
- IPC handlers
  - `src/main/ipc/agentHandlers.ts::registerAgentHandlers()` - Maps `agent:turn`, `agent:stop-turn`, `agent:generate-summary` to main-process execution (`executeAgentTurn`, etc.).
  - `src/main/ipc/sessionsHandlers.ts::registerSessionsHandlers()` - Implements `sessions:load`, `sessions:save`, and session lifecycle handlers.
- Preload bridge (`src/preload/index.ts`)
  - `startAgentTurn(request)` and `stopTurn(turnId)` - Invoke the agent IPC for starting/stopping turns.
- Renderer session engine
  - `src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts`
    - `processMessage()` -> `initiateAgentTurn()` - Adds user message, decides `resetConversation`, and calls `window.api.startAgentTurn`.
    - `snapshotCurrentConversation()` - Wraps `store.getState().snapshotCurrentSession()` for persistence.
    - `openHistorySession(sessionId)` - Restores state from history. Rebel Core uses disk-based history injection for context continuity.
  - `src/renderer/features/agent-session/hooks/useMessageQueue.ts`
    - `handleUserMessage()` - Entry point for queue/interrupt behavior.
    - `processNextInQueue()` - Sends the next queued message; subsequent turns reuse the same renderer session ID.
- Renderer state/store
  - `src/renderer/features/agent-session/store/sessionStore.ts`
    - `addUserMessage()`, `assignTurnToMessage()`, `processEvent()` - Pure reducers for conversation state.
    - `snapshotCurrentSession()` - Creates the persisted `AgentSession` snapshot.
    - `openHistorySession()` - Loads a historical session into current UI state (clones messages/events).
- Shared IPC contracts
  - `src/shared/ipc/contracts.ts` - Typed `sessionsChannels` (`sessions:load`, `sessions:save`, `sessions:list`, `sessions:get`, etc.) and other agent/session channels.
- Services
  - `src/main/services/inboxStore.ts::markSessionTurnsAsCompleted(session)` - Normalizes any in-flight turns to a terminal status on app restart.


### Principles, key decisions

- **Single canonical session model**: There is one shared `AgentSession` structure used across main, preload, and renderer. Docs and code should treat this document as the single source of truth for what a "session" means.
- **Renderer session IDs**: Each conversation has a stable **renderer session ID** (UI-level conversation identity) that persists across turns and app restarts.
- **Durable but bounded history**: Sessions are persisted to disk with schema versioning and a maximum number of stored sessions. Snapshots capture enough data to reconstruct the UI and resume context, but are not an exhaustive log of every low-level agent event. For full-fidelity event capture (un-truncated tool I/O, per-API-call usage, subagent events), see the transcript JSONL files at `{userData}/transcripts/{sessionId}.jsonl` — a separate diagnostic artifact with 14-day retention. See `src/core/services/transcriptService.ts`.
- **Best-effort context continuity**: History loads restore conversation context via Rebel Core's local history injection.
- **Renderer-owned queuing**: All queuing and interrupt behavior lives in the renderer, layered on top of the session model. The main process only sees a sequence of turns for a given renderer session.
- **Signposting over duplication**: Detailed reasoning and change history live in the analysis/fix docs; this reference focuses on the current conceptual model and flow, and links out for deep dives.


### Conceptual model: sessions and turns

At a high level, there are two related concepts:

- **Renderer session**
  - Identified by `sessionId` (e.g. `currentSessionId` in `App.tsx`).
  - Represents a logical conversation as seen in the UI and history sidebar.
  - Stable across multiple agent turns and app restarts as long as the session remains in history.

- **Turn (run)**
  - Identified by `turnId` on the main side and in conversation state (`eventsByTurn`, `messages`).
  - Represents a single call to Rebel Core's `rebelCoreQuery()` (potentially streaming many events).
  - Multiple turns can belong to the same renderer session (e.g. multiple follow-up questions).

The core challenge is mapping **renderer sessions** (what the user sees and selects from history) onto **agent turns** (what Claude uses for context), across multiple turns and app restarts, without corrupting state. Rebel Core maintains context via local disk-based history injection.


### Core data structures

#### Shared types (`../../src/shared/types.ts`)

- **`AgentSession`**
  - `id`: Renderer session ID (primary key for a conversation).
  - `title`: Short, user-visible label derived from early conversation messages.
  - `createdAt` / `updatedAt`: Timestamps for lifecycle management and age-based decisions.
  - `messages: AgentTurnMessage[]`: Flattened, user-visible conversation messages (user, assistant, result).
  - `eventsByTurn: Record<string, AgentEvent[]>`: Full event streams grouped by `turnId`.
  - `activeTurnId: string | null`, `isBusy: boolean`, `lastError: string | null`: Persisted execution-status scalars.
    > **Note (v0.4.44): these scalars are a DERIVED CACHE, not the source of truth.** As of the turn-liveness rework, liveness is a **pure projection of the synced event log** via the single `@core` function `deriveTurnLiveness` (`src/core/services/conversationState/turnLiveness.ts`). The persisted `isBusy`/`activeTurnId` scalars are **demoted to a recomputed cache stamped at one persistence choke point** (`src/core/services/conversationState/toPersistedBusyScalars.ts`); they are never authoritative and must not be hand-written. Treat any description below of these scalars as the "execution status source" as legacy framing. The SSOT for this territory is **UI_CONVERSATIONS.md → "Turn-liveness projection"**.
  - `doneAt?: number | null`: Timestamp when marked done (Done section); `null` means Active. (Renamed from the legacy `pinnedAt` with inverted polarity — non-null now means the affirmative "done" action happened, matching `starredAt`/`deletedAt`. Derived bool is `isActive = doneAt == null`. Shared predicates: `isSessionDone`/`isSessionActive` in `packages/shared/src/sessionLifecycle.ts`.)
  - `starredAt?: number | null`: Timestamp when starred (Starred section).
  - `deletedAt?: number | null`: Timestamp when soft-deleted (Trash section); sessions with this set are hidden from main sections until restored or permanently deleted.
  - `draft?: { text: string; updatedAt: number }`: Persisted draft text for crash resilience. See [Draft persistence](#draft-persistence) below.

- **`AgentTurnMessage`**
  - Represents a single visible row in the transcript (user input, assistant output, or final result summary).
  - Carries `turnId`, `role`, `text`, and `createdAt` so the transcript can be reconstructed from history.

- **`AgentEvent`**
  - Lower-level event representation used while a turn is running and for detailed history.
  - Variants: `status`, `assistant`, `result`, `tool`, `error`.
  - Used to drive both the transcript (`messages`) and richer diagnostic displays (tool usage, compaction, errors).

- **`AgentTurnRequest`**
  - Payload sent from renderer to main to start a turn: `{ prompt, sessionId, resetConversation? }`.
  - `sessionId` links the new turn to the current renderer session; `resetConversation` decides whether to skip history injection.

#### Turn registry maps (`../../src/core/services/agentTurnRegistry.ts`)

- `rendererSessionByTurn: Map<string, string>` - which renderer session owns each `turnId`.

This map is in-memory only.

#### Renderer references (`../../src/renderer/App.tsx`)

- `currentSessionIdRef` / `currentSessionId` - current renderer session being viewed/edited.
- `conversationRef` - mirror of `{ messages, eventsByTurn, activeTurnId, isBusy, lastError }` used for snapshotting.
- `agentSessions` / `agentSessionsRef` - list of known sessions shown in the history sidebar.


### Lifecycle: from new conversation to persisted history

#### New conversation and first run

1. When the app starts, the renderer initializes a fresh `currentSessionId` (e.g. via `createId()`), and `messages` / `eventsByTurn` are empty.
2. When the user sends a prompt (via voice or text), the renderer calls the preload bridge to start a new agent turn with:
   - `sessionId = currentSessionId`
   - `resetConversation = true` for the first turn in a new conversation, or when the user explicitly starts over.
3. In the main process, the agent handler (`src/main/ipc/agentHandlers.ts`) delegates to `startAgentTurn` which calls `executeAgentTurn` (`src/main/services/agentTurnExecutor.ts`).
4. Inside `executeAgentTurn`:
   - Generates a `turnId` and binds it to the renderer session via `agentTurnRegistry.setRendererSession(turnId, rendererSessionId)`.
   - Emits a `turn_started` event immediately after the registry mapping is set, before any model/MCP work. This lets the renderer map the turn and show a spinner before the first content events arrive. See `docs/plans/260409_turn_started_event_broadcast.md`. (Note: AskUserQuestion continuations are renderer-started via `sendMessageToSession`, not server-started — see `docs/plans/260414_user_question_renderer_started_continuation.md`.)
   - Calls `queryWithRuntime()` -> `rebelCoreQuery()`, which streams agent messages back to `handleAgentMessage`.
   - Rebel Core does not bind or resume a server-side session. Continuity comes from persisted conversation history and compaction metadata.

#### Snapshotting and persistence

1. The renderer periodically (and on key transitions) calls `snapshotCurrentConversation` to create an `AgentSession` object from:
   - Current `messages`, `eventsByTurn`, `activeTurnId`, `isBusy`, `lastError`.
   - The current `currentSessionId` as `id`.
   - Derived `title` via `createSessionTitle`.
   - `createdAt` / `updatedAt` timestamps.
2. The updated list of sessions is sent to the main process via `sessions:save`.
3. The main process writes them to the incremental file-per-session store (`userData/sessions/`) via `IncrementalSessionStore`. Upsert-only semantics ensure saves never delete existing session files. When the index exceeds `MAX_PERSISTED_SESSIONS` (25,000), oldest Done sessions are evicted via soft-delete (Active sessions are never evicted).
4. **Index-write serialization**: Global session `index.lock` writes are serialized in-process (`runWithGlobalIndexSerialized()` in `src/core/services/lockedSessionPersistence.ts`) so concurrent async writers cannot drop each other's index updates; quit-time sync saves defer behind in-flight async writers (see [RESILIENCE_TO_CONNECTIVITY_AND_CRASHES.md §6](RESILIENCE_TO_CONNECTIVITY_AND_CRASHES.md#6-session-safety-hardening-implemented)).
5. **Hydration boundary**: Session files are parsed only through `hydrateSession()` in `src/core/services/incrementalSessionStore.ts` (compile-time gate: `scripts/check-session-hydration-boundary.ts`). Hydration runs `normalizeSessionTurnState()` — including collapse of double-materialized duplicate `result` messages (`dedupeDoubledResultMessages`) — before sessions reach the renderer.

**Active-tab filtering (session kind):** Lifecycle `doneAt` alone does not define Active membership. Background/app-initiated kinds are excluded from Active (and pinned-tabs/unread surfaces) via `EXCLUDED_FROM_ACTIVE_KINDS` / `isBackgroundConversationSession()` in `src/shared/sessionKind.ts`; see [SESSION_KINDS.md](SESSION_KINDS.md). Consumers include `filterSessionList.ts` and `useSessionHistoryView.ts`.

On app restart, `loadAgentSessions`:

- Checks the version marker (`version-marker.json`) and enters read-only mode if a newer version previously wrote to this userData.
- Loads sessions from the incremental store (index + individual session files).
- Applies `markSessionTurnsAsCompleted` so any in-flight turns are marked as cleanly interrupted (in-memory only when read-only).
- Returns the normalized `AgentSession[]` to the renderer via `sessions:load`.

Code pointers:
- Renderer: `useAgentSessionEngine.ts::snapshotCurrentConversation()` and `sessionStore.ts::snapshotCurrentSession()`.
- Main: `src/main/index.ts::loadAgentSessions()` / `saveAgentSessions()`.
- Service: `src/main/services/inboxStore.ts::markSessionTurnsAsCompleted()`.
- IPC: `src/main/ipc/sessionsHandlers.ts::registerSessionsHandlers()` for `sessions:load`/`sessions:save`.

#### Opening a historical session

When the user selects a session from the history sidebar:

1. The renderer locates the selected `AgentSession` in `agentSessionsRef`.
2. It clones `messages` and `eventsByTurn` (to avoid mutating the stored snapshot) and replaces the current conversation state with those clones.
3. It updates `currentSessionId` to the selected session's `id`, and updates local UI state (active history selection, timestamps, etc.).

**Hydration/rendering fixes on load:** Staged-tool failure notices are delivered as hidden `system-continuation` user messages (via `usePendingApprovals.ts` → `resolveSendMessageOptions`), not editable "you" bubbles. Duplicate whole-`result` messages materialized under a doubled `turn_started` are collapsed at hydration time in `incrementalSessionStore.ts` (`dedupeDoubledResultMessages` inside `normalizeSessionTurnState`).

Under Rebel Core (sole runtime), continuity comes from disk-based history injection in `agentTurnExecutor`, not server-side session resume.

#### Sending a message after loading history

When the user sends another message in a resumed history session:

1. The renderer enqueues or immediately starts a new turn (depending on the message queue state) with:
   - `sessionId = currentSessionId` (the selected history session's ID).
   - `resetConversation = false` (unless the user has explicitly chosen to start fresh).
2. The main process calls `queryWithRuntime()` -> `rebelCoreQuery()`. Rebel Core assembles context from persisted conversation history -- there is no server-side session to resume.
3. The history snapshot continues to record the resulting messages and events as usual.


### Interaction with the message queue and interrupt behavior

The message queue is implemented entirely in the renderer (`App.tsx`) and layered on top of the session model:

- **Queue entries** store `{ id, text, timestamp, mode: 'queue' | 'interrupt', targetSessionId? }`.
- **`handleUserMessage`** decides whether to send immediately, queue, or interrupt based on `isBusy` and the chosen mode. Accepts optional `targetSessionId` for session-targeted messages (e.g., voice transcripts bound to a specific conversation).
- **`processMessage`** and `processNextInQueue` send agent turns with:
  - `sessionId` = `targetSessionId` if specified (session-targeted), otherwise `currentSessionId`.
  - `resetConversation = false` for follow-up messages in the same conversation.
  - Session validation via `resolveTargetSession()` which falls back to `currentSessionId` if the target was deleted.

Key implications:

- The main process sees a sequence of independent turns for a given `sessionId`, regardless of queuing or interrupts.
- As long as `resetConversation` is `false`, history injection provides context for all queued/interrupting messages.
- Interrupting a turn stops the iterator for that `turnId` but **does not** break the session; the next queued message still belongs to the same renderer session.

Queue state itself is **not persisted** to disk. History snapshots reflect the completed turns and their events, not any pending messages that have not yet resulted in a turn.


### Storage model, limits, and schema evolution

- **Store**: File-per-session architecture via `IncrementalSessionStore` (`src/main/services/incrementalSessionStore.ts`):
  - `sessions/index.json` - Lightweight index with `AgentSessionSummary` entries. Uses **UNION merge semantics** -- saving a subset of sessions never removes other entries from the index.
  - `sessions/<sessionId>.json` - Individual session files with full `AgentSession` data.
  - `sessions-deleted/` - Soft-deleted session files (timestamped, retained for manual recovery).
- **Limit**: `MAX_PERSISTED_SESSIONS` (25,000) caps how many sessions are stored. When exceeded, oldest Done sessions (`isSessionDone`) are evicted (soft-deleted) during index writes. Active sessions (`isSessionActive`, i.e. `doneAt == null`) are never evicted.
- **Upsert-only saves**: Bulk saves (`save()`/`saveSync()`) only write changed sessions -- they structurally cannot delete session files. Deletions only happen through explicit `sessions:delete` IPC calls, which use soft-delete (move to `sessions-deleted/`).
- **Incremental saves**: Only changed sessions are written, based on fingerprint comparison. The fingerprint cache is **additive** -- it never clears entries for sessions not in the current batch. This enables efficient saves even with 25,000+ sessions.
- **Lazy loading**: `listSessions()` returns summaries from the in-memory index without file I/O; `getSession(id)` loads individual sessions on demand.
- **Forward-version protection**: If the index was written by a newer app version, the store enters read-only mode. A `version-marker.json` in `userData` provides an additional pre-load check. See `src/main/services/versionMarker.ts`.
- **Schema evolution**:
  - `INDEX_VERSION` tracks the index schema.
  - If the index version is outdated, the index is rebuilt from session files with enriched summaries.
  - If the index version is *newer* than the running app, the store enters read-only mode.
- **Migration from legacy format**: On first load, if the legacy `agent-session-history.json` exists, sessions are migrated to the `sessions/` directory and the legacy file is renamed to `.backup.json`.
- **Turn completion normalization**:
  - `markSessionTurnsAsCompleted` ensures that any session containing an in-flight turn when the app exited is brought into a consistent state on next load.
  - It appends a synthetic status message ("Agent turn interrupted when Mindstone Rebel closed.") to non-terminal turn event lists. (v0.4.44: the interrupted state is now *derived* from this event by `deriveTurnLiveness`; the `activeTurnId`/`isBusy` scalars are recomputed as a cache via the stamp choke point — see the DERIVED CACHE note above and UI_CONVERSATIONS.md → "Turn-liveness projection" — rather than being authoritatively hand-cleared here.)
  - In read-only mode, corrections are applied in-memory only (no disk writes).

Taken together, this means:

- History is durable across restarts but bounded in size (25,000 sessions).
- Bulk saves can never cause data loss -- they only add or update, never delete.
- Session deletions are always soft (recoverable) and explicit (user-initiated).
- The UI never shows "forever-busy" sessions after an unclean shutdown.
- Large session histories (25,000+ sessions) are handled efficiently via incremental saves and lazy loading.
- Running an older app version against a newer data directory is safe (read-only mode).

**Session JSON vs transcript JSONL:** Session JSON files (`sessions/{id}.json`) are the durable snapshot optimized for UI reconstruction — tool content is truncated for renderer consumption. Transcript JSONL files (`transcripts/{id}.jsonl`) are a separate, full-fidelity diagnostic complement capturing pre-sanitization events (complete tool I/O, per-API-call usage, subagent activity with depth/namespace). These are different artifacts with different fidelity levels for different consumers: session JSON for the app, transcripts for diagnostics. Transcripts have a 14-day TTL and are not required for session functionality.

For full details on the safety hardening, see `docs/plans/finished/260215_session_safety_hardening.md` and [RESILIENCE_TO_CONNECTIVITY_AND_CRASHES.md](RESILIENCE_TO_CONNECTIVITY_AND_CRASHES.md#6-session-safety-hardening-implemented).



### Draft persistence

Each session can store a draft (unsent message text) for crash resilience and multi-conversation workflows.

**Data model:**
- `AgentSession.draft?: { text: string; updatedAt: number }` -- Optional draft field storing the composer text and when it was last updated.

**Persistence behavior:**
- Drafts are saved with throttled sync (not on every keystroke) to balance responsiveness with I/O efficiency.
- Drafts persist across app restarts -- if the app crashes or closes unexpectedly, the draft text is restored when the session is reopened.
- When a message is sent, the draft is cleared.

**Multi-conversation drafts:**
- Each session maintains its own independent draft, enabling users to work on multiple conversations simultaneously.
- Switching sessions via Ctrl/Cmd+Tab preserves drafts in each session.
- The sidebar shows draft previews for sessions that have unsent text.

**Draft-only sessions:**
- A session with only a draft (no messages) is considered a "draft-only session."
- Draft-only sessions are auto-cleaned up after a configurable period (`MAX_DRAFT_ONLY_SESSIONS`) to prevent clutter.

**Implementation pointers:**
- `src/renderer/features/composer/hooks/useDraftPersistence.ts` -- Draft save/load logic
- `src/renderer/features/agent-session/store/sessionStore.ts` -- Draft field in session snapshots
- `src/shared/types.ts` -- `AgentSession.draft` type definition


### Trash and soft delete

Sessions can be soft-deleted, which moves them to a Trash section in the sidebar. Soft-deleted sessions remain in the `agentSessions` array but are filtered out of main sections (Starred, Active, Done) and displayed in a separate Trash section.

**Key behaviors:**

- **Soft delete**: Sets `deletedAt` timestamp on the session. The session is hidden from main sections but not removed from storage.
- **Restore**: Clears `deletedAt`, moving the session back to its original section (based on `doneAt`/`starredAt`).
- **Empty Trash**: Permanently removes all sessions where `deletedAt != null`.

**Guards and invariants:**

- Deleted sessions **cannot be opened** via `openHistorySession()`. Users must restore first. This prevents accidental "un-trashing" through normal click interactions.
- Deleted sessions are **excluded from unresolved pills** and other secondary surfaces that might allow opening sessions.
- When soft-deleting the **current session**, the store snapshots it with `deletedAt` set and resets to a new session (without re-snapshotting, which would overwrite `deletedAt`).

**Implementation pointers:**

- Store actions: `sessionStore.ts` -- `softDeleteSession()`, `restoreSession()`, `emptyTrash()`
- Reducers: `historyReducer.ts` -- `softDeleteSession()`, `restoreSession()`, `permanentlyDeleteSessions()`
- View layer: `useSessionHistoryView.ts` -- `deletedSessions` section, `isDeleted` field filtering

#### Tombstone ledger (resurrection guard)

A late async summary (e.g. a `generate-summary` result that lands after the user deleted or emptied a conversation) used to be able to **resurrect** a cleared/deleted session back into the sidebar, because the summary-acceptance paths would re-create or un-delete the session by id. An id-based **tombstone ledger** now backstops every session-removal path (commit `4e909ad3c`):

- `sessionStore.ts` maintains a `sessionTombstones` set of removed session ids. Every removal path — `delete`, soft-delete, empty-Trash, and the E2E clear — records the id as a tombstone.
- `restoreSession()` clears the tombstone (an explicit user restore is the only sanctioned un-delete).
- The summary-acceptance chokepoints — `updateSessionSummary`, `addOrUpdateHistorySession`, `setSessionSummaries`, `ingestExternalSessions` — refuse to create or un-delete a tombstoned id. A stale async summary can no longer re-add a session the user cleared.
- **Companion fix (F1/F2):** a soft-delete of an active session that had content but no prior summary now **synthesizes a Trash summary** at delete time. Without it, the tombstone filter would drop a legitimately-trashed-but-summary-less session entirely (data loss in Trash).

These fixes close the **renderer-side** resurrection vectors. The **main-process/disk-side** vector (a stale `sessions:upsert` re-materializing a deleted session on disk) is closed separately by the hard-delete ledger below.

#### Hard-delete ledger (disk write-guard)

A second, disk-level guard in `IncrementalSessionStore` (`src/core/services/incrementalSessionStore.ts`) ensures that once a session is hard-deleted with genuine user intent, **no stale write can re-create it on disk — cross-process and across restarts**. Shipped via `docs/plans/260612_recs-round5/PLAN.md` Stages 2-3 (the planning folder `docs/plans/260612_recs-round5/` is the full record: rulings, caller classification, failure-mode matrix).

- **Ledger**: `sessions/session-delete-ledger.json` (`SESSION_DELETE_LEDGER_FILENAME`). Records **hard deletes only** — soft-delete/Trash (`deletedAt`) never reaches it.
- **Intent-discriminated deletes**: `deleteSession(id, { intent })` requires a declared `SessionDeleteIntent` — `'user-delete'` writes the ledger; `'hygiene'` (leaked-session cleanup, ghost-prune, continuity GC) prunes file+index as before and **never tombstones** (so transiently-missing data can re-sync). A caller-enumeration test harness pins every caller's classification; new callers cannot ship unclassified.
- **Write-drop enforcement**: every store write path (save/flush/upsert, index writes, load/rebuild/orphan recovery, migration) drops writes to tombstoned ids via `isHardDeletedSessionId()` / `filterWritableSessions`, plus a read-chokepoint quarantine for stray files. A dropped upsert is observable (`'dropped-tombstoned'` result), not a silent success.
- **Fail-open on a corrupt/unreadable ledger**: empty set + loud log/counter — **no degraded mode**, no "index-absent ⇒ deleted" inference, no ledger `.bak`. That restraint is deliberate; see `docs/plans/260605_session-resurrection-mainside/DEFERRAL.md` for why the degraded-mode design was rejected.
- A ledger-persist failure never fails the delete itself (protection degrades loudly to in-memory-only for that id).

**Three tombstone mechanisms, three jobs** — do not conflate them:

1. **Renderer ledger** (`sessionStore.ts` `sessionTombstones`, above) — UI read-back refusal: summary-acceptance paths refuse to re-create a deleted session in renderer state.
2. **Disk write-guard ledger** (this section) — local disk write-drop protection in the main-process store.
3. **`getSessionTombstoneStore()`** (`src/core/services/continuity/sessionTombstoneStore.ts`) — **cloud sync** tombstone semantics: cross-device delete propagation and catch-up responses.

**Stage-2 safety nets** (universal, independent of the ledger): a **mass-loss circuit breaker** bounds every bulk session-removal path (`computeBulkRemovalBound()`; bound `max(25, ceil(total*0.01))`) with a per-path policy — recovery-class paths abort to protective read-only via `guardRecoveryClassBulkRemoval()` / `enterProtectiveReadOnlyMode()`, while startup hygiene caps-and-continues and eviction is exempt (the remover taxonomy is documented at the constants in `incrementalSessionStore.ts`). The index gets a **validate-first rolling backup** (`sessions/index.json.bak`, refreshed by `writeIndexFileAtomic[Sync]` only after `parseAndValidateIndex()` clears it — version mismatch is never conflated with corruption), and **legacy migration renames** the old store to a timestamped backup instead of deleting it (`migrateFromLegacy`).


### Known limitations and gotchas

- **Cross-session concurrency**: Rapidly switching between sessions while turns are running can generate non-obvious timing behavior. UI expectations should remain conservative: a session is "active" only when it is the current session and has a running turn.
- **Queue vs history**: Queued messages and interrupts are runtime concerns; only executed turns end up in history. It is expected that the history transcript may not contain messages the user typed but then cleared or never sent.
- **Context compaction**: Rebel Core may compact context as conversations grow. Status events ("Context compacted to manage token limits.") are preserved in `eventsByTurn`, but downstream behavior may still reflect truncated context.


### Troubleshooting

- **History session responds as if there is no prior context**
  - Under Rebel Core, context comes from disk-based history injection. If a session has no context, check that the conversation history file exists and is non-empty. See `docs/plans/260406_fix_sdk_conversation_amnesia.md` for historical context.
- **Agent appears stuck or busy in a historical session**
  - After a restart, `markSessionTurnsAsCompleted` should clear busy flags; if the UI still shows a stuck state, verify that history is loading correctly and that snapshots are being refreshed.
  - Starting a new message in that session should create a fresh turn and clear the perceived stuck state.

- **Unexpectedly fresh conversations after interrupts or queue usage**
  - Confirm that queued messages are being sent with `resetConversation = false`.
  - Ensure that the renderer is not accidentally generating a new `currentSessionId` between queued turns (for example, by starting a brand-new conversation instead of continuing the current one).

For deeper debugging, refer to the analysis and implementation docs linked in **See also**, and inspect main-process logs for session events.


### Conversation references (@-mentions)

Users can reference previous conversations in prompts using `@-mention` syntax. This allows users to provide context from past sessions when asking the agent for help.

**See [CONVERSATION_MENTIONS.md](CONVERSATION_MENTIONS.md)** for full documentation including:
- Autocomplete behavior and current session exclusion
- Token format and title sanitization
- Context resolution and transcript formatting
- URL rendering and click handling

**Related docs:**
- [URL_PROTOCOL.md](URL_PROTOCOL.md) -- The `rebel://` URL scheme
- `../plans/finished/251219_conversation_references.md` -- Original planning doc with implementation history


### Future work

- **Richer history metadata**: Additional summary fields (e.g. last tool used, total tokens) could make the session list more informative without changing the core model.
- **Conversation references (v2)**: Full-text search within conversation content (not just titles), message-level deep linking, and agent-initiated conversation search. See `../plans/finished/251219_conversation_references.md` for roadmap.


### Appendix: Example end-to-end flows

#### 1. New conversation, single session

1. User opens the app and sends a prompt.
2. Renderer starts a turn with a new `sessionId`, `resetConversation = true`.
3. Rebel Core starts a fresh conversation with no prior context.
4. Renderer receives events, updates `messages` / `eventsByTurn`, and snapshots an `AgentSession`.
5. History sidebar shows the new session.

#### 2. Resume from history and continue

1. User restarts the app and selects an existing session from history.
2. Renderer restores `messages` / `eventsByTurn`, sets `currentSessionId` to that session's `id`.
3. User sends a new message; renderer starts a turn with `sessionId = currentSessionId`, `resetConversation = false`.
4. Main calls Rebel Core with the conversation history injected from disk, and the agent continues the conversation with preserved context (subject to context limits and compaction).

#### 3. Interrupting a turn and sending a new message

1. User sends a message; a turn starts for the current session.
2. Before the turn completes, the user clicks "Send Now" on a new message.
3. Renderer aborts the active turn via `agent:stop-turn`, enqueues the new message at the front of the queue, and then processes it.
4. Both turns share the same `sessionId`; the second turn gets conversation context via history injection.
5. History snapshots capture the interrupted turn with a terminal status plus the new turn's events, all under the same `AgentSession`.
