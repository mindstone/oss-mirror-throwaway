---
description: "How the conversation UI is structured: virtualized transcript, per-turn step rendering, right-side drawers, event-merge contract, and dual turn ID model."
last_updated: "2026-06-18"
---

# UI — Conversations (Transcript, Steps, Drawers)

This document explains how the **conversation UI** is structured: the main transcript (virtualized message list), per-turn step/"work surface" rendering, and the right-side drawers ("Behind the scenes" + Document Preview). It focuses on **component boundaries and state/data flow**, with links to canonical docs for deeper semantics.

## See Also

- [UI_OVERVIEW](UI_OVERVIEW.md) — high-level renderer layout and where the conversation pane fits in the app shell.
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) — session model, persistence, and how history sessions are restored.
- [ARCHITECTURE_RENDERER_STATE_MANAGEMENT](ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md) — renderer state approach and guidance for adding state.
- [UI_COMPOSER_INTERACTION_STRIP](UI_COMPOSER_INTERACTION_STRIP.md) — composer/interaction strip behavior (sending, attachments, mode switching).
- `src/renderer/features/agent-session/components/ConversationModelSelector.tsx` — Quality tier selector (Quick/Balanced/Thorough/Maximum) rendered at the top of new conversations.
- `src/shared/data/qualityTiers.ts` — Tier→model mappings and preset definitions.
- [CONVERSATION_MENTIONS](CONVERSATION_MENTIONS.md) — `@` mentions and `rebel://conversation/{id}` link behavior.
- [URL_PROTOCOL](URL_PROTOCOL.md) — `rebel://` URL scheme and how navigation deep-links are represented.
- [LIBRARY_AND_FILE_ACCESS](LIBRARY_AND_FILE_ACCESS.md) — workspace file operations and path resolution.
- [COST_TRACKING](COST_TRACKING.md) — canonical semantics for the **"Behind the scenes" Drawer** metrics (context %, cost, etc.).
- [TIPS_AND_QUIPS](TIPS_AND_QUIPS.md) — thinking ticker behavior (tips/quips) driven by `useWorkSurfaceView`.
- [CALENDAR_SYNC_FAILURE_DEBOUNCE](CALENDAR_SYNC_FAILURE_DEBOUNCE.md) — consecutive-failure gating before calendar-cache health/toast surfaces.


## Mental Model (Session → Turn → Events → Messages)

- **Session**: a durable conversation container (history sidebar entries).
- **Turn**: one agent "run" within a session, identified by a `turnId`.
- **Events**: the raw event stream for a turn (tool start/end, status, result, error, assistant step chunks, etc.). Stored as `eventsByTurn[turnId]`.
- **Messages**: the user-visible transcript items (`AgentTurnMessage[]`). These are filtered for display (see `selectVisibleMessages()`).

The UI renders **messages** as the primary transcript, but uses **events** to drive:
- per-turn "steps" UI,
- per-turn metrics (duration, context utilization, cost),
- tool/file activity summaries.

## Event-merge contract (main-process checkpointing + renderer replay)

Canonical identity/union helpers live in `src/shared/utils/eventIdentity.ts`. Any replay merge that can see overlap between disk and buffered IPC events must use that contract.

- **Live event path (append):** normal in-memory turn updates (`processEvent` / `updateSessionWithEvent`) still apply events one-by-one.
- **Replay path (union):** terminal replay and buffered flush paths must use identity union (`turnId + seq`, fallback `turnId + type + timestamp`) via `historyReducer.applyTurnEventUnion(...)`:
  - `src/renderer/features/agent-session/store/sessionStore.ts` terminal replay (loaded + fallback + unloaded branches)
  - `src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts` session-switch and late-load buffered flushes
- **Persistence path (atomic RMW):** replay persistence uses `sessions:apply-turn-event-union` (main-process `IncrementalSessionStore.updateSession(...)`), not renderer full-snapshot upserts.
- **Observability/privacy:** dedup activation emits `event-dedup-activated` breadcrumbs with hashed turn IDs (`hashSessionIdForBreadcrumb`), never raw IDs.

This contract prevents the post-checkpoint duplication race: if disk already contains replayed events, union is idempotent; if disk is behind, union preserves missing buffered events.

One companion rule: every persistence path must fold in **both** saved sessions and the active-but-uncommitted session before writing, so unload/boundary snapshots don't drop in-flight conversation state.


### Monotonic-content invariant (cloud pull + active-session ingest)

**Invariant:** A cloud→desktop pull and any external ingest of the active session are **monotonic in conversation content** — they may add cloud-only turns/messages/events and metadata, but must never remove a local message id, drop a terminal/result event, lower a shared turn's non-user message count, or replace a shared turn's local transcript with a shorter one.

**Why it matters (REBEL-6C0 / REBEL-6BZ render-drop class):** A completed turn's final answer could vanish from the transcript — visible as a brief preamble snippet with no way to expand — and stay gone for a long time (re-print fixed it). The on-disk session was *not* merely a transient memory-only window: the main-process **terminal checkpoint** (`mergeTurnIntoSession` via the turn accumulator on the `result`/`error` event) brings disk current with the final answer shortly after the turn completes, independent of the renderer's deferred idle-save. The durable loss came from a **destructive cloud→desktop pull** (`cloudRouter.ts`): its content-blind guards (`skipUpsert` is timestamp-only; the old turn-ID-set check ignored same-turn content) let a cloud snapshot that was *timestamp-newer but content-poorer* — chronologically newer because a same-turn memory/activity push bumped its `updatedAt`, yet holding only the preamble for that turn — **full-replace the already-correct on-disk session**, dropping the final answer on disk. A subsequent cloud-sync loop (`cloud:sessions-synced` → `refreshActiveCloudSession` → `ingestExternalSessions`) then read that now-regressed disk and **wholesale-replaced the live in-memory transcript** with no anti-regression guard, amplifying the disk loss into the visible "collapse to a snippet." The renderer's old count-only guard was blind to it because `mergeResultMessage` promotes an assistant message to `result` in-place (same message count, higher event seq).

**Implementation — two layers:**

1. **Persistence (cloud pull)** — `localHasContentCloudLacks` in `src/main/services/cloud/cloudRouterHelpers.ts` returns true when, for any shared turn, local has more non-user messages **or** a higher per-turn max valid event seq than cloud. This routes the pull through the additive `mergeSessionTurns` instead of a destructive full-replace. The underlying `mergeEventsForDesktopPull` in `src/core/services/sessionMergeUtils.ts` carries a **DELIBERATE ASYMMETRY** (lines ~277-308): for any shared turn that local already completed (has a terminal event), the local event array wins wholesale — cloud events for that turn are dropped. This asymmetry protects the local final answer and must not be symmetrized into a union; doing so re-opens the bug class.

2. **Renderer (defense-in-depth)** — `guardActiveIngestRegression` in `src/core/services/sessionIngestGuard.ts` is called in `ingestExternalSessions` (`sessionStore.ts`) before applying any external snapshot. It refuses a shared turn's replacement when the incoming snapshot has fewer non-user messages or a lower max valid event seq for that turn, keeping the richer live transcript and emitting an observable hashed-id breadcrumb (category `ingest-regression-refused`). The guard is extracted to a pure, Node-free module (no `@core/logger`) so the renderer can import it without a Node-builtins bundle hazard (the `renderer_node_core_import_leak` class). It is re-exported from `sessionMergeUtils.ts` for non-renderer consumers.

**Mobile / web cloud client (same invariant).** The mobile and web companion's cloud client enforces the same monotonic-content invariant in `fetchSession` — at **both** the cache-hydrate site (a stale per-conversation cache replacing the live `currentSession`) and the REST replace site (a reconnect catch-up snapshot replacing it) — via `decideSessionContentRegression` in `cloud-client/src/stores/sessionContentRegressionGuard.ts`, called from `cloud-client/src/stores/sessionStore.ts`. A replacement that would lower a shared turn's non-user message count or max event seq is refused, keeping the richer live transcript and emitting an observable refusal signal (`emitContentRegressionRefused`, tagged with the `site: 'cache' | 'rest'`).

See [`docs/plans/260622_fix-message-render-drop/PLAN.md`](../plans/260622_fix-message-render-drop/PLAN.md) for the full diagnosis and design rationale (`intent_critical: true`).


## Data & State Ownership

### 1) Session Store (conversation state)

The conversation transcript and turn event stream live in a Zustand store:

- `src/renderer/features/agent-session/store/sessionStore.ts`
  - Owns `messages`, `eventsByTurn`, `activeTurnId`, `isBusy`, `isStopping`, `editingMessageId`, `compactionBoundaries`, etc.
  - Implements `processEvent()`, `addUserMessage()`, `truncateToMessage()`, and other session/history actions.
- `src/renderer/features/agent-session/store/selectors.ts`
  - `selectVisibleMessages(messages)` filters transcript messages for display (hides system prompts; only shows the final assistant message per turn if a result exists).

The app wires store state into UI in `src/renderer/App.tsx` via `useSessionStore(...)` and derives `visibleMessages` with `selectVisibleMessages()`.

### 2) Derived Turn View-Models (step context, timelines)

Raw turn events are transformed into UI-friendly structures in:

- `src/renderer/features/agent-session/hooks/useTurnData.ts`
  - Produces `turnStepContextByTurn`, `turnSummaries`, `subAgentTimelineByTurn`, and `visibleTurnId`.
  - Handles fallback/legacy turn assignments (`TURN_ID_FALLBACK`) and caches per-turn computations for performance.

These derived maps are consumed by both the transcript (inline steps) and the "Behind the scenes" drawer.

### 3) Right-Side Drawer State ("Behind the scenes" + Document Preview)

Right-side drawers are **not** owned by the session store. They're owned by the Flow Panels context:

- `src/renderer/features/flow-panels/FlowPanelsProvider.tsx`
  - Owns `insightsDrawerOpen`, `selectedInsightsTurnId`, `documentPreviewOpen`, `documentPreviewPath`, and resizable drawer widths.
  - Enforces "only one right drawer open at a time" (opening preview closes insights, and vice versa).
  - Persists panel state in localStorage (`FLOW_PANELS_STORAGE_KEY`).


## Transcript: `ConversationPane` (virtualized list)

> **Cache-bound rule (REBEL-5D5, June 2026):** any cache keyed by values that never repeat (message UUIDs, timestamps, monotonic counters) is unbounded by construction unless its owning instance has a bounded lifetime or an eviction policy *we* control — never rely on unobservable library eviction. The pane's TanStack virtualizer retained every message element ever rendered until the pane was keyed by `currentSessionId` (remount per session; `SessionSurfaceContent.tsx`, guarded by a lint rule + remount test). Full trail: `docs-private/postmortems/260611_virtualizer_elementscache_unbounded_session_switch_postmortem.md`.

**Primary component:** `src/renderer/features/agent-session/components/ConversationPane.tsx`

**Quality Tier Selector** (`ConversationModelSelector.tsx`):
At the top of new conversations, a segmented control lets the user choose a quality tier: **Quick** ($), **Balanced** ($$), **Thorough** ($$$), or **Maximum** ($$$$). Each tier maps to preset Thinking/Working models and thinking effort (see `qualityTiers.ts`). A **Show details** toggle reveals dropdowns for manual Working/Thinking model and thinking effort overrides. After the first message is sent, the selector locks to a "Using: ..." label. Hidden entirely for existing conversations unless overrides differ from global defaults.

Responsibilities:

- Renders `visibleMessages` as a **virtualized** list (`@tanstack/react-virtual`) to keep long conversations fast.
- Exposes an imperative handle (`ConversationPaneHandle`) used by:
  - `useConversationAutoScroll()` (auto-scroll / "jump to latest"), and
  - `ConversationNav` (jump to top/prev/next user message).
- Handles UX polish around streaming:
  - "On it..." placeholder during the brief IPC gap before the `turn_started` event arrives and sets `activeTurnId`.
  - For any turn (including AskUserQuestion continuations, which are renderer-started via `sendMessageToSession` — see `docs/plans/260414_user_question_renderer_started_continuation.md`), the `turn_started` event emitted by `executeAgentTurn()` sets `isBusy`/`activeTurnId` via the normal conversation reducer — the spinner appears immediately without any IPC callback or safety-net logic.
  - Standalone thinking placeholder if a turn is active but no assistant message has landed yet (renders `TurnStepsInline`).
- Handles visual continuity:
  - entrance animations for genuinely new messages,
  - "turn completed spotlight" for the most recent assistant/result message,
  - compaction boundaries (`CompactionBoundary`) inserted after specific message indices.

Supporting pieces:

- Auto-scroll and "scrolled away" tracking: `src/renderer/features/agent-session/hooks/useConversationAutoScroll.ts`.
- Conversation navigation controls: `src/renderer/features/agent-session/components/ConversationNav.tsx`.


## Message Cards: `MessageItem`

**Primary component:** `src/renderer/features/agent-session/components/MessageItem.tsx`

Each message is rendered as an `article` card with:

- **Header**
  - Role label: `You` (user) and `Rebel` (assistant). Result messages intentionally do not render a visible `Summary` label.
  - Per-turn pills/indicators (assistant/result only):
    - `InsightsPill` (opens "Behind the scenes" for the turn).
    - `MemoryUpdateIndicator`, `TimeSavedSummary` (turn outcomes).

- **Body**
  - User messages: plain text + attachment list (name + workspace-relative path).
  - Assistant/result messages:
    - Optional `TurnStepsInline` (step picker + live thinking state), then
    - `MessageMarkdown` for the message/step content.
    - When a step is selected, a "Show final result" notice lets the user jump back to the final output.

- **Footer**
  - Utility metadata/actions live bottom-left: turn usage tooltip, copy message, timestamp tooltip, retry interrupted turn, and edit last user message where available.
  - Assistant/result messages can show `ConversationFeedbackPrompt` bottom-right with `How was this response?` and the star rating control.


## Markdown Rendering: `MessageMarkdown`

**Primary component:** `src/renderer/components/MessageMarkdown.tsx`

Responsibilities:

- Renders Markdown with `react-markdown` + `remark-gfm`.
- Normalizes file links:
  - `remarkLibraryLinks` rewrites relative file links to canonical `rebel://library/{url-encoded-path}` at the AST level.
  - Click handling supports canonical `rebel://library/` plus legacy `library://` and `workspace://` (reader-only back-compat).
- Handles "rich link" behaviors:
  - `rebel://library/…` (and legacy `library://` / `workspace://`) links call `onOpenFile(filePath)` or `onOpenFolder(folderPath)` (folder links use a trailing `/`).
  - `rebel://conversation/{id}` calls `onOpenConversation(sessionId)`.
  - Other `rebel://` URLs can be passed to `onNavigate(url)` (handled in `App.tsx`).
- Renders local images referenced in Markdown by loading via IPC (and caches dimensions/data URLs to avoid flashing in the virtualized list).
- Auto-embeds supported media URLs (via `MediaEmbed`) only when a paragraph is a single bare URL.

Related:

- `src/renderer/components/remarkLibraryLinks.ts` — the AST transform for file links.
- [REACT_PLAYER_INTEGRATION](REACT_PLAYER_INTEGRATION.md) — canonical details for media embedding.


### Text-Selection Stability Contract (REBEL-4ZV / FOX-3174)

`MessageMarkdown` MUST keep the `components` map passed to `<ReactMarkdown>` referentially stable across re-renders. ReactMarkdown's reconciliation treats each entry (`p`, `a`, `img`, `code`, `pre`, `li`, `ul`, `ol`, `strong`, `em`, `table`) as a **component "type"**. A new function identity for any of these — e.g. an inline arrow `() => …` literal that gets recreated each render — is equivalent to changing the component type and forces React to **remount** every paragraph/anchor/image subtree on every parent re-render. Remounting destroys the underlying DOM text nodes, which collapses any live user selection on `mouseup` or right-click and breaks IME composition / focus.

**Implementation:** the entire `components` object lives inside a single `useMemo([StablePre], () => ({...}))` block. Each component body is a named function that reads dynamic callbacks (`handleLinkClick`, `openImageViewer`, `handleImageContextMenu`, `handleLinkContextMenu`) and state (`coreDirectory`, `documentPath`) from `preCallbacksRef.current`, which is refreshed on every render. The same pattern is applied to the inner `CollapsibleSection`'s nested `<ReactMarkdown>` call.

**Anti-patterns to avoid:**

- ❌ `components={{ p: ({children}) => <p>{children}</p>, a: ({href, children}) => <a href={href} onClick={...}>...</a> }}` — inline arrow per render, remount every render.
- ❌ Closing over `useState` values, props, or `useCallback` results inside the named component bodies — those produce new closures per render. Always read from `preCallbacksRef.current`.
- ❌ Adding `useMemo` deps that change frequently (callbacks, state). The deps should be empty (or only contain other `useMemo([])`-stable references like `StablePre`).

**Tests:** `src/renderer/components/__tests__/MessageMarkdown.componentsStability.test.tsx` pins the contract by asserting paragraph and anchor DOM identity is preserved across two renders that DEFEAT `React.memo` (different `showToast` props between renders). Negatively verified — the test fails when a single component slot is reverted to an inline arrow.

**Related:**

- `src/renderer/components/MessageMarkdown.tsx` — `markdownComponents` block + `preCallbacksRef` ref.
- `src/renderer/features/agent-session/components/MessageItem.tsx` — `handleActivate` mouse-only `getSelection().isCollapsed` guard prevents `onFocusTurn` from firing at the end of a drag-select (the same re-render that would otherwise force MessageMarkdown to remount).
- `src/renderer/features/agent-session/components/ConversationPane.tsx` — the `[...rawEvents]` spread there is **load-bearing** for downstream `useMemo([turnEvents])` consumers because `sessionStore` push-mutates event arrays in place. Removing it would break `MessageItem.usageData` and similar memos. Do not "optimize" it away without re-architecting the store's mutation pattern.
- [`docs-private/postmortems/260427_text_selection_disappears_on_right_click_postmortem.md`](../../docs-private/postmortems/260427_text_selection_disappears_on_right_click_postmortem.md) — full diagnosis of the v1 vs v2 fix and the architectural lesson.
- [`docs-private/investigations/260427_text_selection_unstable_v2.md`](../../docs-private/investigations/260427_text_selection_unstable_v2.md) — investigation doc with hypotheses and evidence.


## "Work Surface" / Turn Steps & Events

There are two step/event surfaces:

1. **Inline steps in the transcript** (`TurnStepsInline`)
   - Lives alongside assistant/result messages in `MessageItem`.
   - Driven by `TurnStepContext` derived in `useTurnData()`.

2. **"Behind the scenes" drawer step accordion** (`InsightsDrawer`)
   - Shows step-by-step thinking, file activity, and tool/status events for a selected turn.
   - Uses the same underlying derived `TurnStepContext` but presents it in a more detailed, right-drawer UI.

Note: There is also a dedicated module at `src/renderer/features/agent-session/work-surface/` (`WorkSurface`, timeline builders, filters). The **timeline builders** are used by the "Behind the scenes" drawer (`InsightsDrawer`), and the `useWorkSurfaceView` hook drives thinking/ticker copy (see [TIPS_AND_QUIPS](TIPS_AND_QUIPS.md)).


## Per-turn activity recap & AI summary

Finished turns surface a calm one-line recap of what Rebel did — the "show a bit more of what it did" surface (so the felt experience is "look at all it did", not "why so long"). Intent & design rationale: [`docs/plans/260618_show-more-activity/PLAN.md`](../plans/260618_show-more-activity/PLAN.md).

- **Deterministic recap** — `deriveTurnActivityRecap()` (`src/renderer/features/agent-session/utils/turnActivityRecap.ts`): a pure util that composes "3 files · 12 tools · 1m 20s" from per-turn counts (leads with files, caps at 3 terms, drops zeros, muted "1 hiccup" only on errors). It is the always-available base **and** the fallback for the AI sentence.
- **AI one-sentence summary** — generated on the `result` event by `maybeGenerateActivitySummaryForTurn()` (`src/core/services/activitySummaryService.ts`), a fire-and-forget cheap-Haiku call modelled on `conversationTitleService.ts`. Idempotent (in-flight set + persisted preflight + apply-time recheck) so the shared dispatcher covering desktop **and** cloud never double-calls. Gated to substantial turns (≥2 tools or ≥1 file). Grounded strictly in the turn's activity log + request + answer snippet (no fabrication; eval `evals/activity-summary.ts`). Hooked in `agentEventDispatcher.ts` beside auto-title.
- **Persistence + sync** — stored on `AgentSession.activitySummaryByTurn` (`src/shared/types/agent.ts`; additive, no store-version bump). Cross-surface sync merges it via `unionPerTurnMap()` (`src/core/services/sessionMergeUtils.ts`) — union-by-key, **not** the primary-authoritative `mergePerTurnMap` (a missing key on an async/sparse artifact means "not generated yet", not "deleted"). Cloud-generated summaries reach desktop via the `session:activity-summary-generated` broadcast, which must stay in `CLOUD_PUSH_ALLOWLIST`.
- **Where it renders** — the label prefers `activitySummaryByTurn[turnId]`, else the deterministic recap. Two hosts: `MessageWorkDisclosure` (primary-MCP-app turns) and **`ContextualProgressCard`'s cleanly-completed collapsed label** (the common path — ordinary completed turns). The renderer plumbs the map through the session store + a turn-scoped `MessageItem` memo comparator so only the affected row repaints; the count→sentence swap is a one-line text change (no layout/auto-scroll fight) and is not announced as a live update.

### Calmer "working" indicator (one thing at a time)

While a turn runs, `ContextualProgressCard`'s live area shows a single primary signal — the concrete current activity (`deriveCurrentActivity().statusLine`, `src/renderer/features/agent-session/utils/activityDerivation.ts`) — plus a quiet elapsed timer. Persona quips (`work-surface/utils/personaQuips.ts`) are demoted to a gated fallback (`shouldShowPersonaQuip`): they fill a genuine activity gap or re-engage after the line is static >25s, never rotating over real progress. Exactly one `aria-live` region is active during a turn.


## End-of-Turn State Classification (Silent Stop Detection)

When a turn ends with incomplete tasks, the `ContextualProgressCard` classifies the stop reason and renders a **differentiated banner** so users understand why the turn ended and what to do next. This avoids showing a generic "stopped" warning for expected stops (user pressed Stop, agent asked a question).

### Classification Categories

The classification logic lives in `src/renderer/features/agent-session/utils/detectSilentStop.ts`. It evaluates (in priority order):

1. **`none`** — Turn still running, no tasks, all tasks completed, or plan-only turn (tasks created but no work started). No banner shown.
2. **`user_stopped`** — User pressed Stop (detected via live `isStopping` flag or persisted `turnEndReason`). Banner: "Stopped by you — N steps remaining" with StopCircle icon.
3. **`awaiting_user`** — Agent asked a question and is waiting for a response (detected via `turnEndReason` or `user_question` event). Banner: "Waiting for you — N steps remaining" with MessageSquare icon.
4. **`error_exit`** — Turn ended due to an error. Defers to existing error handling; no separate banner.
5. **`unexpected_stop`** — Genuine silent stop with no clear reason. Banner: "Stopped — N steps remaining" with AlertTriangle icon (amber warning style).

### Continue Button

A **Continue** action appears in the banner for `user_stopped` and `unexpected_stop` classifications. It is gated by `canOfferContinue()`:
- Only on the **last turn** in the conversation
- Only when **no turn is currently processing**
- **Not** for `awaiting_user` (user should reply instead)

Clicking Continue sends a continuation message via `onContinueIncomplete` (wired in `SessionSurfaceContent.tsx`).

### Visual Styling

- `user_stopped` and `awaiting_user` use **info** styling (muted, non-alarming)
- `unexpected_stop` uses **warning** styling (amber) to signal a genuine issue
- Both collapsed and expanded card states show the classification via a shared `renderSilentStopIcon()` helper

**Key code:**
- `src/renderer/features/agent-session/utils/detectSilentStop.ts` — `StopClassification` type, `detectSilentStop()`, `canOfferContinue()`
- `src/renderer/features/agent-session/components/ContextualProgressCard.tsx` — banner rendering, icon selection, analytics
- `src/renderer/features/agent-session/components/SessionSurfaceContent.tsx` — `onContinueIncomplete` wiring


## Right-Side Drawers

### "Behind the scenes" Drawer

- **UI**: `src/renderer/features/agent-session/components/InsightsDrawer.tsx`
- **State**: `useFlowPanels()` (`FlowPanelsProvider.tsx`)

What it does:

- Selects a turn (`selectedInsightsTurnId`) and displays:
  - headline stats (duration, steps, tool calls, files touched, errors, context %, cost), and
  - a per-step accordion showing thinking, file operations, and tool/status events.

Canonical semantics for the metrics (especially **context utilization** and **cost**) live in:
- [COST_TRACKING](COST_TRACKING.md) → "Behind the scenes" Drawer (Per-Turn).

### Document Preview Drawer

- **UI**: `src/renderer/features/library/components/LibraryDrawer.tsx`
- **State**: `useFlowPanels()` (`FlowPanelsProvider.tsx`)

The **Document Preview Drawer** provides quick, in-context file viewing when users click `rebel://library/` links (or legacy `library://` / `workspace://`) in conversations. Instead of navigating away to the Library tab, the file opens in a right-side panel while the conversation remains visible.

#### Supported File Types

Preview is available for text-based files: `.md`, `.markdown`, `.txt`, `.json`, `.yaml`, `.yml`, `.xml`, `.csv`, `.log`. Other file types fall back to opening in the Library editor.

#### HTML Tutorial Preview

HTML tutorials from `rebel-system/help-for-humans/tutorials/` can also be previewed. These are rendered in a sandboxed iframe via the `rebel-tutorial://` protocol, with strict CSP to prevent script execution. Agents can link to tutorials using `rebel://help/tutorials/{filename}` URLs. See [URL_PROTOCOL](URL_PROTOCOL.md) for details.

#### Features

- **Copy relative path**: Copies the file's workspace-relative path to the clipboard.
- **Open in Library**: Closes the preview and opens the file in the full Library editor.
- **Reveal in Finder**: Opens the containing folder in the system file browser.
- **ESC to close**: Pressing Escape closes the preview and returns focus to the conversation.
- **Privacy indicator**: Shows whether the file is in a private space (Chief-of-Staff) or shared (work/).

#### Skill Folder Auto-Open

When a user clicks a link to a skill folder (e.g., `rebel://library/rebel-system%2Fskills%2Fmemory%2Fsource-capture%2F`) that contains only a `SKILL.md` file, the preview automatically opens that file instead of navigating to the Library. This provides seamless access to skill documentation without extra clicks.

## Per-conversation rating

Assistant/result message footers can include a per-conversation rating prompt that lets users submit a 1–5 star rating with a required note and optional multi-select chips. Desktop and mobile both persist vote history per session and submit feedback to Sentry through the feedback IPC boundary (renderer/mobile clients do not submit directly).

Signposts:

- `src/renderer/features/agent-session/components/ConversationFeedbackPrompt.tsx` — desktop in-transcript prompt, star row, history pill, and dialog open flow.
- `src/renderer/features/agent-session/components/ConversationFeedbackDialog.tsx` — desktop rating dialog (bucketed copy, required comment, optional diagnostics, submit path).
- `src/renderer/features/agent-session/components/ConversationStarRating.tsx` — reusable desktop star radiogroup control.
- `src/renderer/features/agent-session/components/ConversationFeedbackChips.tsx` — desktop interactive chip selector.
- `src/shared/data/conversationFeedbackChips.ts` — shared chip taxonomy, slug helper, and per-session vote cap constant.
- `src/core/services/conversationFeedbackStore.ts` — vote/dismissal persistence, retention, migration, and sentry event write-back.
- `src/core/feedbackReporter.ts` — cross-surface feedback reporter boundary + sentiment helper.
- `src/main/sentryFeedbackReporter.ts` and `cloud-service/src/sentryFeedbackReporter.ts` — desktop/cloud Sentry implementations.
- `src/main/ipc/feedbackHandlers.ts` — feedback IPC handlers (get/rate/dismiss) and reporter submission orchestration.
- `src/shared/ipc/schemas/feedback.ts` and `src/shared/ipc/channels/feedback.ts` — feedback contract schemas and channel request/response shapes.
- `mobile/src/components/ConversationFeedbackPrompt.tsx`, `mobile/src/components/ConversationFeedbackBottomSheet.tsx`, and `mobile/src/components/ConversationFeedbackChips.tsx` — mobile parity prompt, submit sheet, and chip controls.


## Session list: Active, Done, and session kind

Lifecycle `doneAt` drives **Done vs Active** in the sidebar and actions menu (`doneAt` non-null = Done; `doneAt == null` = Active). That is not the only axis: **session kind** can exclude a conversation from Active even when it is not Done.

- **Active-tab exclusion** (`EXCLUDED_FROM_ACTIVE_KINDS` / `isBackgroundConversationSession()` in `src/shared/sessionKind.ts`) — background/app-initiated kinds (`automation`, `meeting-analysis`, `use-case-discovery`) are omitted from Active, pinned-tabs, and unread/home controls, but still appear in **All**. This is kind-based, not origin-based; "excluded-from-Active" is the [SESSION_KINDS.md](SESSION_KINDS.md) matrix concept (not a code field). Consumers include `filterSessionList.ts` and `useSessionHistoryView.ts`.

**Load-path hydration repairs** (applied in `hydrateSession()` / `normalizeSessionTurnState()` in `incrementalSessionStore.ts` before the renderer sees a session):

- **`dedupeDoubledResultMessages()`** — collapses duplicate `result` messages for the same turn when a doubled `turn_started` corroborates double-materialization (prevents twin "Done…" cards on open).
- **Staged-tool failure notices** — execution-failure continuations from the inbox/approval drawer must pass `receiptText` via `resolveSendMessageOptions` (`usePendingApprovals.ts`) so the agent-only notice is hidden and stamped `system-continuation`; without that hide signal it would render as an editable **You** bubble (user already sees the failure via toast/outcome).


## Conversation Actions Menu

**Primary component:** `src/renderer/features/agent-session/components/ConversationActionsMenu.tsx`

The three-dots menu in the top-right of the conversation area provides session-level actions:

- **Rename**: Edit the conversation title
- **Find similar**: Semantic search for related conversations
- **Star/Unstar**: Add to or remove from Starred
- **Mark as done/Reopen**: Move between active and done states (see **Session list: Active, Done, and session kind** above)
- **Reveal in sidebar**: Scroll the sidebar to highlight this conversation
- **Copy link**: Copy `rebel://conversation/{id}` URL to clipboard
- **Copy as Markdown**: Copy the full conversation transcript formatted as Markdown
- **Export to Markdown**: Save the conversation as a `.md` file
- **Diagnose**: Start a diagnostic conversation about issues with this session
- **Delete**: Soft-delete the conversation (moves to Trash)

The same actions are available from the sidebar's session context menu (`SessionActionsMenu`), with minor differences (e.g., "Reveal in sidebar" is only in the main view). Action definitions are centralized in `sessionMenuActions.ts`.


## Key Files (Implementation Map)

| Area | Files |
|------|-------|
| Transcript list | `src/renderer/features/agent-session/components/ConversationPane.tsx`, `ConversationNav.tsx`, `useConversationAutoScroll.ts` |
| Message card | `src/renderer/features/agent-session/components/MessageItem.tsx` |
| Markdown rendering | `src/renderer/components/MessageMarkdown.tsx`, `remarkLibraryLinks.ts` |
| Turn derivations | `src/renderer/features/agent-session/hooks/useTurnData.ts`, `src/renderer/features/agent-session/utils/turnStepContext.ts` |
| Session store | `src/renderer/features/agent-session/store/sessionStore.ts`, `selectors.ts` |
| "Behind the scenes" drawer | `src/renderer/features/agent-session/components/InsightsDrawer.tsx` |
| Document preview drawer | `src/renderer/features/library/components/LibraryDrawer.tsx` |
| Drawer state | `src/renderer/features/flow-panels/FlowPanelsProvider.tsx` |
| Conversation actions menu | `src/renderer/features/agent-session/components/ConversationActionsMenu.tsx`, `sessionMenuActions.ts` |
| Silent stop detection | `src/renderer/features/agent-session/utils/detectSilentStop.ts`, `ContextualProgressCard.tsx` |
| Wiring/orchestration | `src/renderer/App.tsx` |


## Dual Turn ID Model (Post C-lite, 2026-04)

C-lite removed the overloaded `activeTurnId` contract. The shared reducer now
uses `state.activeTurnId` strictly for processing-turn semantics, while UI
focus is isolated in `state.focusedTurnId`. See:
`docs/tutorials/260430_isbusy_dual_id_state_machine_and_c_lite_fix.html`.

| Field | Meaning | Scope / notes |
|---|---|---|
| `state.activeTurnId` | Processing turn | Shared reducer contract; aligns with cloud + persistence. |
| `state.focusedTurnId` | UI focus turn | Renderer-only, ephemeral, stripped on persist. |
| `state.runtime.activeTurnId` | Transitional processing shadow | Mirrors `state.activeTurnId`; retained temporarily for defense-in-depth (I1 follow-up removes). |

**Practical usage:**
- Focus/highlighting/visible-turn selection reads `focusedTurnId`.
- Processing/streaming/terminal-guard logic reads `state.activeTurnId`.
- Existing stop-path safety fallback (`runtime.activeTurnId ?? state.activeTurnId`) remains valid during transition because both converge on the processing turn under C-lite.


## Auto-Scroll Architecture

Auto-scroll is managed by `useConversationAutoScroll()` with three separate effects (see the hook's doc comment for rationale):

1. **Session Switch Effect** -- scrolls to bottom when opening a history session, with progressive reveal.
2. **Message Arrival Effect** -- scrolls when new messages arrive, but only if user was near the bottom.
3. **Content Growth Interval** -- 100ms polling during streaming that scrolls as `scrollHeight` grows.

**Key design decisions:**
- `wasNearBottomRef` tracks whether to auto-scroll. It's set by a scroll event listener and respected by all three effects.
- The scroll listener uses refs (`isScrolledAwayRef`, `visibleMessagesLengthRef`) instead of state in its dependency array to avoid re-registration during streaming (which caused stale `wasNearBottomRef` values).
- The turn-start scroll effect only fires on `null`-to-value transitions of `activeTurnId` (new turns), not value-to-value transitions (user clicking different messages).
- Text selection pauses auto-scroll (FOX-2159). The selection menu open state also pauses via `pauseAutoScroll`.

### Sticky Scroll-Away Latch (FOX-2668, FOX-2596)

During streaming, scrolling up to review earlier messages must be respected -- the view should not yank back to the bottom. This is enforced by a "sticky latch" (`stickyScrollAwayRef`) that works alongside `wasNearBottomRef`:

- **Wheel handler** detects upward scroll (`deltaY < 0`) during streaming and sets the latch **synchronously** (before the browser applies the scroll). This is necessary because the scroll handler fires asynchronously -- Chromium's compositor dispatches scroll events after the 100ms content growth interval has already overridden `scrollTop`.
- **Keyboard handler** detects `PageUp`/`ArrowUp`/`Home` keys and sets the latch synchronously.
- **Scroll handler paths** provide additional protection:
  - Path A: upward movement during streaming sets the latch.
  - Path B (busy): only clears the latch when the user scrolls back to within 75px of the bottom (`STICKY_CLEAR_THRESHOLD`) with >2px downward movement -- prevents stale programmatic scroll events from clearing the latch.
  - Path B (not busy): same STICKY_CLEAR_THRESHOLD logic, also requires `userScrollingRef`. Returns early when latch is active so `wasNearBottomRef` is not updated by measurement corrections.
  - Path C: user scrolling gesture + not near bottom sets the latch immediately.
- **During busy**: `wasNearBottomRef` can only go true-to-false, never false-to-true. Re-enabling auto-scroll requires an explicit action: `scrollToLastMessage()`, user message arrival, or latch re-engagement.
- **Latch persists across turn boundaries** (FOX-2596): The latch is NOT cleared when `isBusy` goes false. It persists through auto-continue turns until the user explicitly clears it by: scrolling back to bottom (within 75px), sending a new message, clicking "Jump to Latest", or switching sessions. This prevents the "between-turns yank" where `wasNearBottomRef` would flip to true during the brief `isBusy=false` gap.
- **Thinking prune protection** (FOX-2596): When tool calls prune "thinking-style" assistant text from `visibleMessages`, the user's original message can become the latest message. The message arrival effect detects `visibleMessages.length` decreasing and suppresses the `isUserMessage` bypass that would otherwise clear the latch.
- **Effect re-registration**: Both the scroll handler and wheel handler effects include `isBusy` in their dependency arrays. This ensures handlers re-register when streaming starts, picking up a container element that may not have been available on the initial mount (e.g., during onboarding when `shouldRenderMainApp=false`). The content growth interval already had `isBusy` in its deps.

See also: `docs/plans/finished/260110_scroll_render_architecture_analysis.md`, `docs/plans/finished/260120_jump_to_latest_scroll_fix.md`, `docs-private/investigations/260324_fox2596_auto_scroll_hijack.md`.


## Common Gotchas

- **Virtualized + images**: message bodies may mount/unmount as you scroll; `MessageMarkdown` caches image dimensions/data URLs to avoid layout shifts and "flash of unloaded image".
- **Auto-scroll**: use `ConversationPaneHandle.scrollToBottom()` rather than manipulating the scroll container directly; virtualization requires "chasing the bottom" in some cases.
- **Focus vs processing turn IDs**: Use `focusedTurnId` for UI focus/highlighting. Use `state.activeTurnId` for processing-turn logic (or `runtime.activeTurnId` as a transitional shadow where that fallback already exists). See "Dual Turn ID Model" section above.
- **Result vs assistant messages**: `selectVisibleMessages()` hides intermediate assistant messages when a result exists for a turn; don't assume all assistant chunks are visible in the transcript.
- **Turn IDs after compaction**: `resolveTurnIdForMessage()` includes fallback logic so per-turn indicators can still work when events are cleared/compacted.
- **Draft sync is debounced**: Composer draft sync to the session store uses a 1-second debounce (not real-time). This prevents sidebar re-renders from blocking typing input. The sidebar draft preview updates ~1s after you stop typing. See `DRAFT_SYNC_DEBOUNCE_MS` in `ComposerWithState.tsx`.
- **AskUserQuestion events carry their origin `sessionId`** (`user_question` / `user_question_answered`). Do **not** derive the answering session from ambient renderer state (`currentSessionId`) or from a client-submitted request field — the renderer's `useDeferredValue(eventsByTurn)` in `useAgentSessionEngine.ts` can lag `currentSessionId` during a session switch, and stamping derived state onto the batch routes the answer (and a system-generated continuation) into the wrong conversation. The extractors in `cloud-client/src/hooks/useUserQuestions.ts` filter (not "prefer") events whose `event.sessionId !== currentSessionId`; the server-side handler (`src/core/services/userQuestionResponseHandler.ts`) validates `request.sessionId` against the authoritative stamp stored on the `user_question` event in the turn's context accumulator and rejects mismatches; the idempotency cache is keyed on `${sessionId}:${turnId}:${batchId}`. When adding any new consumer of these events or any new submission path, keep all four layers intact. See `docs-private/investigations/260424_user_question_cross_session_routing_leak.md` and `docs-private/postmortems/260424_user_question_cross_session_routing_leak_postmortem.md`.

## Intent & Design Rationale (C-lite)

The recurring "isBusy stuck on stale activeTurnId" class had already seen six fixes before this pass; postmortem `docs-private/postmortems/260414_user_question_continuation_stall_recurring_postmortem.md` documents that cycle and why guard-only fixes kept regressing.
C-lite was selected to remove the root cause structurally: `state.activeTurnId` remains processing-only (shared reducer/cloud/persistence contract), while `state.focusedTurnId` carries renderer focus semantics without cross-surface migration.

| Option | Decision | Why |
|---|---|---|
| A (parameter + OR guard) | Rejected | Patches call contract but preserves overloaded field. |
| B (move clearing out of reducer) | Rejected | Duplicates state-machine logic across surfaces. |
| C-lite (split into `activeTurnId` + `focusedTurnId`) | Chosen | Structural fix with renderer-only migration. |
| C-full (rename persisted shape too) | Rejected | Requires store migration / larger rollout for naming-only gain. |
| D (overwrite active ID pre-reducer) | Rejected | Breaks focus semantics directly. |

Explicitly rejected during C-lite: reintroducing the `state.activeTurnId === null` fallback, keeping `runtime.activeTurnId` as a permanent shadow, and persisting `focusedTurnId`.
Top invariants to preserve:
- I-1: late old-turn terminal events never clear newer busy/error state.
- I-8: shared reducer clearing decisions use processing `state.activeTurnId` only.
- I-9: `assignTurnIdToMessage` sets both processing and focus IDs.
- I-10: `focusedTurnId` is never persisted/synced.
- I-12: runtime `activeTurnId` remains convergent with state while the shadow exists.

## Turn-liveness projection (Intent & Design Rationale)

C-lite split the overloaded turn ID but left `isBusy`/`activeTurnId` as a **writable, authoritative scalar**. That scalar was the root of a recurring high-severity bug family — "stuck `isBusy` / stale `activeTurnId`" (7+ postmortems: `260502`, `260414`, `251213`, `260518`, `260402`, `260403`, `260330`). The diagnosis: this was a **denormalization**. Liveness is already fully determined by the event log (a turn is running ⟺ it has a start/activity event, no terminal `result`/`error`, and isn't stale), but that derivation was duplicated across ~6 sites that drifted. **Every postmortem in the family was two derivations disagreeing**, or one writer clobbering the cache while another read it stale. Non-technical users read a stuck spinner as "the agent has been churning for an hour" — a trust bug, recurring despite six prior guard-only fixes.

**Approach chosen (structural — remove the stored fact, derive it):** liveness is now a **pure projection of the synced event log** via one `@core` function `deriveTurnLiveness` returning a 4-state enum (`idle | running | terminal | interrupted`). The persisted `isBusy`/`activeTurnId` scalars stay on disk (no shape change) but are demoted to a **recomputed cache stamped at a single persistence choke point** (inside the store write internals). The renderer **reads the projection** for the open conversation — there are no competing writers; "busy on send" is a renderer-local optimistic *event* fed to the same fold, never a scalar. The one unavoidable denormalized flag (the sidebar/summary tier, where events are absent by design) is **single-owner + advisory + never-resurrect**. Enforced by: a type-branded egress (renderer-local synthetic events cannot reach disk/cloud — `EgressSession`/`stripSessionForEgress`), the single write-stamp choke point, and the repo-wide `no-raw-turn-liveness-scalars` lint. **Staleness is a proxy for process-death**; a live controller signal overrides it (terminal-gated).

**Rejected alternatives:**
- **Prior C-lite field-split (focus vs processing)** — fixed one axis (overloaded ID) but left the scalar writable, so the family recurred.
- **Deferred F14 "atomic-RMW single-writer"** — makes the N writers *agree* instead of removing the denormalization; the next writer added re-opens the class.
- **"Trust a main-process scalar enum"** — desktop-centric; breaks cloud continuity. Projection-over-the-synced-log is the cloud-native shape (a deterministic fold gives the same answer on every surface, so no merge conflict on busy is possible).

**Constraints a future agent MUST preserve:**
- Liveness is **derived, not stored-authoritative**, wherever events exist (open-conversation + summary-with-`lastActivityAt`).
- The **single egress stripper + branded `EgressSession`** — synthetic renderer-local events must never reach disk/cloud.
- The write-stamp **clears busy on terminal only** (staleness clearing is load/read-time, in `normalizeSessionTurnState` + caller `isTurnStale`), not at write time.
- The two intentional interrupted-mapping policies — canonical `toPersistedBusyScalars` (`interrupted → idle`) vs the write-path preserve-busy mapping — are **ONE deliberate decision**, test-pinned; do not "reconcile" them into one.
- **Controller-active overrides staleness** (terminal-gated): a live controller signal keeps a turn running past 5-min event silence unless a terminal event exists.
- `isBusy`/`activeTurnId` are written **only** via the stamp API (`no-raw-turn-liveness-scalars` lint); `DerivedLiveness` is an unforgeable brand minted only by `deriveTurnLiveness`.

Full context (problem, F/G/H/P7 findings, Authority Matrix, invariants #13–#17, rejected alternatives, discovered improvements): `docs/plans/260530_turn_liveness_projection.md`.
