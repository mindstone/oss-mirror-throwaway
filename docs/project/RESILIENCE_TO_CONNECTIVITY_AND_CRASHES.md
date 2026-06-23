---
description: "Resilience reference for connectivity loss and crashes — offline behaviour, session durability, recovery limits, planned hardening"
last_updated: "2026-06-18"
---

### Introduction

This document describes how Mindstone Rebel behaves when network connectivity is unavailable or flaky, and what happens if the app quits or crashes mid‑run. It focuses on preserving user data (sessions, messages, workspace edits) and making it easy to resume work, and outlines both the current state and planned improvements.

### See also

- `./ARCHITECTURE_OVERVIEW.md` – High‑level process and component overview; explains where agent runs, MCP, and persistence live across main, preload, and renderer.
- `./ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md` – Canonical reference for `AgentSession`, history persistence, and how session resume/upstream IDs work today.
- `./VOICE_AND_AUDIO.md` – End‑to‑end voice pipeline reference (STT/TTS, permissions, playback) including how provider errors surface.
- `./MCP_ARCHITECTURE.md` – MCP and Super‑MCP configuration and transport modes; relevant for understanding which tools depend on remote HTTP APIs.
- `./SUPERMCP_OVERVIEW.md` – Details of the Super‑MCP HTTP server lifecycle and health‑checks, which affect robustness under concurrent tool usage.
- `../../src/main/index.ts` – Main‑process implementation of agent turns, session history stores, and MCP/voice IPC handlers.
- `../../src/renderer/App.tsx` – Renderer implementation of conversation state, message queue/interrupt behavior, and workspace/editor UX.

### Principles, key decisions

- **User data first**: User‑authored content (typed messages, voice input that has been successfully transcribed, workspace file edits) must be preserved wherever reasonably possible. Losing AI‑generated messages is less critical but still undesirable.
- **Graceful degradation**: When networks, MCP tools, or providers fail, the app should fail a single run/operation with a clear error, not leave the UI stuck or corrupt history.
- **Durable but bounded history**: Conversations are stored as `AgentSession`s in an incremental file-per-session store (`userData/sessions/`) with explicit versioning and a maximum session count (25,000); snapshots should be sufficient to reconstruct the UI and continue work.
- **Defense-in-depth against data loss**: Multiple independent safety layers prevent session data loss from cross-version contamination, race conditions, and bugs. See [Session safety hardening](#6-session-safety-hardening-implemented) below.
- **Best‑effort resilience, explicit limitations**: We treat external systems (Anthropic, MCP servers, STT/TTS providers) as inherently unreliable; behavior on failures should be predictable and called out here, not assumed to be lossless.
- **No surprise blocking**: Connectivity issues, analytics failures, or MCP misconfigurations should not block core offline capabilities (workspace browsing/editing, history viewing, basic UI).

---

## Current state – connectivity and online dependencies

At a high level, Rebel has three classes of behavior with respect to connectivity:

1. **Purely local features** – Work fully offline.
2. **Features that require outbound HTTP APIs** – Fail per‑request when offline or misconfigured.
3. **MCP toolchains** – Behavior depends on how each configured MCP server connects to the outside world.

### 1. Purely local behavior

These functions work entirely offline:

- **App shell and UI** – Electron, React UI, history sidebar, inbox panel, automations panel layout, and settings surfaces.
- **Workspace operations** – File tree, open/edit/save, create/rename/delete/move operations are all IPC calls into `fileTreeService`/filesystem APIs scoped to `AppSettings.coreDirectory`.
  - The workspace editor auto‑saves dirty files after a short debounce (~1.4 s) and on `Ctrl/Cmd+S`, so edits are written to disk even if no network is available.
- **Local settings & flags** – App settings (`app-settings` store) and lightweight UI state stored in `localStorage` (onboarding flags, panel layout, recent files) are independent of connectivity.

### 2. Agent runs (Rebel Core)

- All agent turns are executed via Rebel Core (`rebelCoreQuery()`) in the main process.
- Required inputs:
  - Valid auth credentials (Anthropic API key or Claude Max OAuth token).
  - Network connectivity to the model provider.
- Failure behavior today:
  - If the API key is missing, the main process emits an `AgentEvent` of type `error` with a message like `"Claude API key is missing."`; the renderer marks the run as failed and stops.
  - If the network is unavailable, DNS fails, or Anthropic is unreachable, the Anthropic client throws; `executeAgentTurn` catches this and emits an `AgentEvent.error` with the underlying error message.
  - The renderer records this error in the session (`lastError`) and history; the user can type/speak again once connectivity is restored.
- There is **no dedicated “offline mode”**; offline status is implicit via errors on individual runs.

### 3. Voice (STT/TTS)

- **Speech‑to‑text (STT)**
  - Implemented in `audioService.transcribeAudio` for providers:
    - `openai-whisper` – calls `https://api.openai.com/v1/audio/transcriptions`.
    - `elevenlabs-scribe` – calls `https://api.elevenlabs.io/v1/speech-to-text`.
  - **Pending audio save + retry**: On transcription API failure, the main process saves the audio file before the API call, shows "Recording saved. Will retry when back online," and the renderer auto-retries pending audio when connectivity returns (`useVoiceRecording` handles pending audio retry). Successfully recovered transcripts are auto-submitted for voice-mode recordings.
  - Network errors use normalized, user-friendly messages (e.g. "Unable to reach OpenAI...") via `buildNetworkAwareMessage` in `audioService.ts`.

- **Text‑to‑speech (TTS)**
  - Implemented in `audioService.textToSpeechStream` for:
    - OpenAI TTS (`/v1/audio/speech`).
    - ElevenLabs streaming TTS (`/v1/text-to-speech/{voiceId}/stream`).
  - Failures produce a thrown error; `useAudioPlayback` logs `"Text-to-speech failed"` and sets `playbackError`.
  - `App.tsx` responds by disabling voice mode and surfacing a toast like `"Voice mode disabled: <error>"`.
  - The underlying **agent text responses are still preserved**; only audio playback is lost.

### 4. MCP and Super‑MCP

- **Direct MCP servers**
  - Configured via `mcpConfigFile` and normalized by `mcpService.resolveMcpServers`.
  - Local MCP servers (e.g. filesystem) continue to work offline.
  - MCP servers that themselves talk to remote APIs (Slack, email, etc.) fail with provider‑specific errors which surface as tool events/errors in the agent transcript; these do not crash the app.

- **Super‑MCP HTTP mode**
  - On app startup, main attempts to start a Super‑MCP router in HTTP mode (unless explicitly disabled) via `superMcpHttpManager.start()` and verifies readiness with a TCP health check.
  - **Startup retry loop**: If the router cannot start, `systemHealthService.startSuperMcpWithRetries` attempts multiple retries. On persistent failure, `StartupRecoveryDialog` is shown with options to retry or enter Safe Mode.
  - Once running, the router and any remote MCP tools still depend on their own outbound connectivity; their failures are confined to the affected runs.

### 5. Analytics (RudderStack)

- Main (`@rudderstack/rudder-sdk-node`) and renderer (`@rudderstack/analytics-js`) clients both:
  - Check for configured keys and data plane URL.
  - Silently no‑op if configuration is missing or calls fail.
- Analytics **never block** core app behavior; network failures here only drop telemetry.

---

## Current state – persistence and crash/quit behavior

This section focuses on what is and is not preserved when Rebel quits normally vs crashes or is force‑killed.

### 1. Session history storage

- **Store**: Incremental file-per-session store in `userData/sessions/`:
  - `index.json` - Lightweight index of all sessions (id, title, timestamps, fingerprint). Uses UNION merge semantics — writing a subset of sessions never removes other entries.
  - `{sessionId}.json` - Full session data for each session.
  - `sessions-deleted/` - Soft-deleted session files (timestamped copies, retained indefinitely for recovery).
  - Legacy migration from the old `agent-session-history` electron-store is handled on startup.
- **Capacity**: Up to 25,000 sessions (`MAX_PERSISTED_SESSIONS`). When the cap is exceeded, oldest Done sessions are soft-deleted (evicted) to make room. Active sessions (`doneAt == null`) are never evicted.
- Each `AgentSession` snapshot includes:
  - `id` (renderer session ID), `title`, `createdAt`, `updatedAt`.
  - `messages` (flattened transcript) and `eventsByTurn` (per‑turn event streams).
  - `activeTurnId`, `isBusy`, `lastError`.

  - `draftText` (persisted draft for the session's composer).

On startup, `loadAgentSessions` (via `getIncrementalSessionStore()`):

1. Loads the index and individual session files.
2. Applies `markSessionTurnsAsCompleted(session)` to each session:
   - If a turn has no terminal `result` or `error` event, it appends a synthetic status event:
     > `Agent turn interrupted when Mindstone Rebel closed.`
   - Sets `activeTurnId = null`, `isBusy = false` so no session appears “stuck running” after restart.


The normalized sessions are returned to the renderer and used to populate the history sidebar.

### 2. How and when sessions are persisted

In the renderer, `useAgentSessionEngine` treats conversations as:

- A **current in‑memory conversation** (`messages`, `eventsByTurn`, `currentSessionId`, runtime state), and
- A list of **archived sessions** (`agentSessions`) shown in the sidebar.

Persistence flows:

- **Continuous auto-persistence** (current behavior):
  - A unified persistence subscription (`persistenceManager.saveAllSessions(...)`) triggers on changes to `agentSessions`, `messages.length`, and `draftsBySessionId`.
  - Saves are debounced (~300ms) and idle-scheduled to avoid blocking the UI.
  - Both the current conversation and drafts are included in each save.

- **On clean window close / app quit**:
  - A `beforeunload` handler flushes any pending saves synchronously before the process exits.

As a result:

- All sessions (including the currently active one) are continuously persisted.
- Drafts are preserved per-session.
- The "loss window" on crash is now only ~300ms of state, not an entire unsnapshotted session.

### 3. Behavior on crash / hard kill

If either the renderer or main process crashes, or the OS kills the app without a normal shutdown:

- The `beforeunload` handler does **not** run.
- Any changes within the last ~300ms debounce window may be lost.

Implications:

- Nearly all session state survives due to continuous auto-persistence.
- Only the last few hundred milliseconds of changes are at risk.
- On next startup, `useInterruptedSessionResume` detects sessions with `interruptedTurnId` and can auto-resume or show a toast with a "View" action.

### 4. Other in‑progress state

- **Text composer (`draftText`)**
  - Drafts are now persisted per-session via `useDraftPersistence` and merged into saved sessions.
  - On session load or recovery, the composer is prefilled with any non-empty draft.
  - Migration from older localStorage-based drafts is handled automatically.

- **Queued messages**
  - The message queue / interrupt system (`useMessageQueue`) lives in memory.
  - On interrupt failure, the message is kept queued with "Failed to stop run - message will send when ready" rather than being dropped.
  - Queued but not yet executed messages disappear on restart; only completed turns are visible in history.

- **Workspace editor buffers**
  - The workspace editor maintains `WorkspaceDocumentState` per open file and auto‑saves after a debounce or explicit save.
  - If the app crashes within the debounce window, the last few keystrokes for that file may be lost; otherwise the file is on disk and intact.

- **Voice recordings**
  - Raw microphone audio is saved to disk before transcription API calls.
  - On STT failure, the recording is preserved and can be retried when connectivity returns (see Voice section above).

---

## Failure modes and user experience

### Connectivity issues

- **Agent runs**
  - Missing or invalid API keys produce immediate, descriptive errors rendered in the transcript.
  - Offline or flaky connectivity yields API client or HTTP errors that appear as `AgentEvent.error` messages.
  - **Transient network errors** (ETIMEDOUT, ECONNREFUSED, 502/503/504) trigger auto-retry when connectivity returns, if the turn had no side effects (tool calls) or attachments. See "Network reconnect auto-resume" above for details and limitations.
  - For turns with tool events or attachments, an inline status message is shown: "Connection lost after actions were taken. Please review and retry if needed."
  - **Per-message timeout (180s)**: If no `AgentMessage` arrives within 180s, a `MessageTimeoutError` fires. After the timeout, a diagnostics service (`timeoutDiagnosticsService.ts`) runs two parallel probes within a 2s budget to classify the cause:
    - **Anthropic outage** → status check via `status.anthropic.com` → "Claude seems to be having a moment..."
    - **Internet unreachable** → connectivity probe fails → "I couldn't reach the internet just now..."
    - **Transient stall** → both probes healthy → "The response stalled and timed out. Your message is safe..."
    - Diagnostics run AFTER the timeout fires, not during — they only determine what to tell the user.
    - See [ERROR_CLASSIFICATION_AND_ROUTING.md § Timeout Diagnostics](ERROR_CLASSIFICATION_AND_ROUTING.md#timeout-diagnostics) and `docs/plans/260408_timeout_diagnostics_and_messaging.md`.

- **Voice**
  - STT failures: the current voice interaction is dropped with a toast/error; no message is queued, so there is nothing to “resume”.
  - TTS failures: the underlying text response is preserved, but voice mode is disabled and the user sees a toast; they can re‑enable voice later.

- **MCP / Super‑MCP**
  - HTTP MCP tools that cannot reach their upstream services return tool‑level errors; these are shown as tool events/errors in the transcript without breaking the session.
  - Super-MCP router startup failures trigger retry loop; on persistent failure, StartupRecoveryDialog is shown with options to retry or enter Safe Mode.

### Quit vs crash

- **Normal quit**
  - The active session is snapshotted and archived.
  - On next launch, the user can select that session from history and continue, with interrupted turns clearly marked as such.

- **Crash / hard kill**
  - Nearly all session state survives due to continuous auto-persistence (~300ms debounce).
  - Only the last few hundred milliseconds of changes may be lost.
  - On restart, `useInterruptedSessionResume` detects interrupted sessions and can auto-resume or show a toast with a "View" action.

---

## Implemented improvements

The following enhancements have been implemented:

### 1. Continuous session snapshotting (implemented)

- Sessions are now auto-persisted via `persistenceManager.saveAllSessions(...)` with ~300ms debounce.
- File-per-session storage in `userData/sessions/` with `index.json` index.
- Loss window reduced from "entire session" to "~300ms of state".

### 2. Draft message persistence (implemented)

- `draftText` field stored per-session and merged into saves.
- `useDraftPersistence` hook handles persistence and recovery.
- Migration from older localStorage-based drafts handled automatically.

### 3. Offline UX and retry affordances (implemented)

- `OfflineBanner` component driven by `useOnlineStatus()` (navigator.onLine).
- STT recordings saved to disk before API calls; auto-retry when connectivity returns.
- Network errors use normalized user-friendly messages via `buildNetworkAwareMessage`.

### 4. Interrupted session recovery (implemented)

- `interruptedTurnId` set on startup when unterminated active turns are detected.
- `useInterruptedSessionResume` can auto-resume or show toast with "View" action.

### 5. Network reconnect auto-resume (implemented)

When an agent turn fails due to transient network errors (ETIMEDOUT, ECONNREFUSED, DNS failures, 502/503/504), the app can automatically retry when connectivity returns:

- **Outbound DNS resolver choice**: Outbound HTTP (Undici) uses the OS resolver by default on desktop so VPN split-DNS is honored. `installGlobalUndiciDnsDecouple()` in `src/core/utils/dnsThreadpoolDecouple.ts` keeps c-ares/cacheable lookup available via env opt-in; cloud opts in through deploy env. Lint guards in `eslint.config.mjs` block new Undici dispatchers that bypass the centralized resolver selector. Full outbound networking + SSRF reference: [OUTBOUND_NETWORKING_AND_SSRF.md](./OUTBOUND_NETWORKING_AND_SSRF.md).

- **Detection**: Main process tags error events with `isTransient: true` (computed before humanizing the error message). Renderer detects these and stores pending turn info in memory.
- **Multi-session tracking**: Up to 10 pending turns are tracked across different sessions using FIFO eviction (oldest are dropped when limit reached).
- **Attachment caching**: When a turn with attachments fails, attachments are cached to disk (`userData/attachment-cache/`) with a 7-day expiry. This allows attachment recovery on resume.
- **Resume modal**: When connectivity returns, a modal (`ResumeConversationsModal`) shows all pending conversations and allows the user to:
  - **Resume All**: Sequentially switches to each session, loads cached attachments, and retries the turn
  - **Not Now**: Snoozes the modal until the next offline→online transition
  - **Dismiss All**: Clears all pending turns and deletes cached attachments
- **Safety gates**:
  - Only auto-retries if the turn had NO tool events (no side effects)
  - Attachments are now supported via disk caching
  - Max 3 retry attempts per turn to prevent infinite loops
- **Progress tracking**: The modal shows status for each conversation (pending/loading/switching/done/failed/cancelled)
- **Cancellation**: User can cancel mid-resume; remaining conversations stay pending

**Limitations:**
- **Max 10 pending turns**: Older pending turns are evicted (with cache cleanup) when limit is reached.
- **Memory-only state**: Pending retry state is not persisted. If the app restarts before network returns, `useInterruptedSessionResume` handles recovery instead (but attachment cache files remain on disk).
- **Session switching timeout**: Each session switch has a 5-second timeout; if the switch fails, the turn's retry count is incremented.

**Files:**
- `src/shared/types.ts` - `isTransient` flag on error events
- `src/main/services/attachmentCacheService.ts` - attachment caching to disk
- `src/main/ipc/agentHandlers.ts` - IPC handlers for cache operations
- `src/shared/ipc/channels/agent.ts` - IPC channel definitions for caching
- `src/renderer/features/agent-session/store/sessionStore.ts` - `pendingNetworkRetryTurns` state (multi-session)
- `src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts` - detection and caching logic
- `src/renderer/features/agent-session/hooks/useNetworkReconnectResume.ts` - resume hook with modal integration
- `src/renderer/components/ResumeConversationsModal.tsx` - modal UI component

### 6. Session safety hardening (implemented)

Defense-in-depth with six independent layers to prevent session data loss from cross-version contamination, race conditions, or bugs. Planning doc: `docs/plans/finished/260215_session_safety_hardening.md`.

**Background:** An incident where ~1,270 session files were physically deleted when production and beta apps shared the same `userData` directory revealed several structural vulnerabilities.

**Safety layers:**

1. **Forward-version read-only mode**: If the session index was written by a newer app version (`INDEX_VERSION` higher than ours), the store enters read-only mode — sessions are loaded and displayed but never written back. A `version-marker.json` in `userData` provides an additional check before sessions are even loaded.

2. **Soft-delete**: Session files are never `unlink`-ed. Deletions move files to `userData/sessions-deleted/` with timestamped filenames. Files can be manually recovered.

3. **Upsert-only bulk saves**: The `save()`/`saveSync()` paths only write changed sessions — they structurally cannot delete session files. The old `computeChanges()` (which computed deletions) is replaced by `computeUpserts()`.

4. **UNION index semantics**: `writeIndex()`/`writeIndexSync()` merge incoming sessions into the existing index via a Map-based UNION. Saving a subset of sessions never removes other entries from the index.

5. **Raised cap with smart eviction**: `MAX_PERSISTED_SESSIONS` raised from 1,000 → 10,000 → 25,000. When exceeded, the oldest Done sessions are evicted (soft-deleted). Active sessions (`doneAt == null`) are never evicted. Only successfully soft-deleted sessions are removed from the index.

6. **Anomaly detection**: When the incoming save batch is suspiciously small compared to known sessions (<5% of index), an error-level diagnostic log is emitted. With upsert-only semantics this cannot cause data loss, but flags potential renderer race conditions.

7. **Global `index.lock` in-process serialization**: The shared session `index.lock` FILE lock is also serialized in-process via `runWithGlobalIndexSerialized()` in `src/core/services/lockedSessionPersistence.ts`, closing a same-process cross-session dropped-write race. Slow waits past threshold emit observable telemetry.

8. **Quit-save vs async-writer drain**: Sync quit-time saves defer behind in-flight async locked writers (`hasActiveAsyncLockedWriters()` / `pendingDeferredLockedDrains` in `lockedSessionPersistence.ts`; wired from `src/main/index.ts` and cloud `cloudRouter.ts`) so a deferred quit-save cannot land stale state while another session still holds the lock.

9. **Single `hydrateSession()` boundary**: Session JSON parse + normalization runs through one choke point — `hydrateSession()` in `src/core/services/incrementalSessionStore.ts` (enforced by `scripts/check-session-hydration-boundary.ts`). Raw `JSON.parse` of session files outside that boundary is blocked.

10. **Non-destructive `migrateStore` across callers**: The shared migration framework (`migrateStore`, `shouldPersist`, `shouldEnterReadOnlyMode` in `src/core/utils/storeMigration.ts`) must not wipe real on-disk data when version read fails, future-version is detected, or a migration throws — callers gate writes on `shouldPersist` (12 production call sites across desktop + cloud stores).

11. **`doneAt` backfill after index rebuild**: Index version bump (`INDEX_VERSION` 9) forces a rebuild-from-files that applies `migrateResolvedAutomationToDone()` so resolved automations missing a `doneAt` key do not revert to Active after an index collapse/rebuild.

**Files:** `src/main/services/incrementalSessionStore.ts`, `src/core/services/lockedSessionPersistence.ts`, `src/core/utils/storeMigration.ts`, `src/main/services/versionMarker.ts`, `src/core/constants.ts` (`MAX_PERSISTED_SESSIONS`), `src/main/index.ts`, `src/main/ipc/sessionsHandlers.ts`.

### 7. Background compaction durability gate (implemented)

When a background session hits context overflow, in-place compaction clears `eventsByTurn` to make room for a summary-based retry. Previously, if the pre-compaction state hadn't been persisted (events from completed turns were only in renderer memory), those events were lost permanently.

**Fix:** `performCompaction()` in the session store now fires a best-effort `sessions:upsert` with the pre-compaction session state before clearing events. This is non-blocking — compaction proceeds even if the persist fails (e.g., disk full) to avoid memory overflow. Persist failures are logged via `.then/.catch` for observability.

**Scope:** Background sessions only. Foreground compaction uses the renderer's normal debounce-based persistence cycle.

**Files:** `src/renderer/features/agent-session/store/sessionStore.ts` (`performCompaction`), planning doc `docs/plans/260410_comprehensive_resilience_improvements.md` (Stage 2.2 / SF5).

---

## Future improvements

### 1. Explicit unclean-shutdown detection

**Target state:**

- Maintain a small flag in a dedicated store that tracks whether the last shutdown was clean.
- On startup, if the flag indicates an unclean exit and there is a recent snapshot, show a recovery banner.
- On clean quit, persist the latest snapshot and mark the shutdown as clean.

---

## Limitations and gotchas

- **External providers are not transactional** - Anthropic, MCP servers, STT/TTS APIs, and remote tools can fail in ways we cannot fully control; the goal is to contain and surface these failures, not to guarantee they never occur.
- **Context resume is best-effort** - Rebel Core maintains conversation context locally via history injection.
- **Short windows of potential loss remain** - Even with frequent snapshotting, there will always be a small window (~300ms) between the last snapshot and a crash where new messages or edits can be lost.

---

## Maintenance

- When changing session persistence, history serialization, or crash handling, update this document alongside `ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md` and relevant implementation files.
- When introducing new online dependencies (e.g. additional providers or MCP tools), document:
  - Whether they are required for core app operation.
  - How their failures are surfaced to the user.
  - Any offline fallbacks.
