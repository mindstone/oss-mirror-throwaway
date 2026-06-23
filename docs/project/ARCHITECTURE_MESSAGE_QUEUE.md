---
description: "How Rebel queues, interrupts, and routes user messages across agent sessions."
last_updated: "2026-06-10"
---

# Message Queue Architecture

## Overview

Message queuing allows users to send messages while the agent is already running. Supports **queue mode** (wait for completion) and **interrupt mode** (stop current run and prioritize new message).

The headline invariant (since 2026-06-10, plan `260610_queue-drain-cancels-turn`): **a non-interrupt (queue-mode) send never aborts an active turn.** Only explicit interrupts — Send Now, tray send-now, edit/rerun — may supersede a running turn. This is enforced at three points: enqueue, drain, and main-process turn admission.

## Architecture

### Code Locations

| Component | Location |
|-----------|----------|
| Queue hook | `src/renderer/features/agent-session/hooks/useMessageQueue.ts` |
| Session engine | `src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts` |
| Turn service (admission, supersession) | `src/core/services/agentTurnService.ts` |
| Turn registry | `src/core/services/agentTurnRegistry.ts` (re-exported via `src/main/services/agentTurnRegistry.ts`) |
| Admission refusal contract | `src/shared/utils/agentTurnAdmission.ts` |
| IPC handlers | `src/main/ipc/agentHandlers.ts` |

### Key Functions

- **`useMessageQueue`** - Hook managing queue state and processing
- **`submitQueuedMessage()`** - Main entry point from App.tsx
- **`processMessage()`** - Handles individual message processing with session continuity
- **`initiateAgentTurn()`** - Starts agent turn via IPC
- **`startAgentTurn()`** (`agentTurnService.ts`) - Single admission point for IPC, cloud, and headless turns; applies the `supersedePolicy` guard
- **`isSummaryBusyForQueueGate()`** (`useMessageQueue.ts`) - Busy predicate for background-session summaries, with read-time staleness

### Busy Gating and Turn Supersession (two layers)

The queue holds messages with a per-message `targetSessionId`, so busy gating is **per target session**, not per viewed session. Two layers enforce the invariant:

**Layer 1 — renderer per-target gate (the routine path).** At both decision points — enqueue time (`handleUserMessage`'s immediate-send branch) and drain time (`processNextInQueue` + the drain effect) — the queue checks the busy state of the message's *target* session via `targetBusy()`:

- The **current** session uses the projected-liveness `isBusy` prop (fresher than summaries; keeps Send Now drain timing exact).
- Any **other** session uses the `isSessionBusy(sessionId)` probe, which App.tsx wires over `sessionSummaries` through `isSummaryBusyForQueueGate`. The predicate applies **staleness at read time**: a summary stuck `isBusy: true` whose `lastActivityAt` is older than `STALE_TURN_THRESHOLD_MS` is treated as idle (the store's `applySummaryBusyStaleness` never fires spontaneously for local-only users, so without this a queued message could be stranded forever). Fail-open is safe precisely because Layer 2 exists.

History: before 2026-06-10 the drain gate checked only the *viewed* session's `isBusy`, so switching to an idle conversation drained cross-session messages whose target was still mid-turn — and the main process then force-cancelled the target's running turn (incident `f6b3e9b0`, a lost in-flight `Edit`).

**Layer 2 — main-process admission guard (the authoritative race backstop).** `AgentTurnRequest` carries an optional `supersedePolicy: 'supersede' | 'reject'`:

- **Absent / `'supersede'` (default):** legacy server-side dedup — cancel any existing turn for the session and dispatch `turn_superseded`. Preserved for the paths that *should* interrupt or recover: Send Now's stop-failure backstop, stuck-turn recovery, direct `agentApi.turn` continuation callers (approvals, memory), and cloud/mobile sends.
- **`'reject'`:** if the target session has an active turn, `startAgentTurn` refuses admission with a typed `AGENT_TURN_TARGET_BUSY` error (sentinel + matcher in `@shared/utils/agentTurnAdmission`; the code travels in the error *message* so it survives Electron's `"Error invoking remote method"` IPC rejection wrapper). No cancel, no `turn_superseded`, no controller registration. The guard treats any value other than the literal `'reject'` as `'supersede'` — deliberately no exhaustiveness assertion (open union over IPC, version-skewed clients).

The renderer derives the policy from **queue intent at dispatch time** (never from `messageOrigin`, which is scroll/analytics vocabulary): `sendNow` / `sendNow-via-tray` / edit-rerun carry no policy (interrupt is the point); every other dispatch — `'queue'`, system continuations included — carries `'reject'`. Both dispatch sites stamp it: the natural drain and the immediate-send branch.

**Truthful framing** (the previous version of this doc had it backwards): the renderer gate is the routine path; the main `'reject'` guard is the authoritative backstop for races (TOCTOU between the renderer's busy check and admission); the main `'supersede'` default is the dedup/interrupt backstop for non-queue paths. Server-side supersession is NOT a safety mechanism for queue-mode messages — for them it was the failure mode.

**No-loss refusal contract.** A typed refusal never loses the message:

- *Drain path:* the same `QueuedMessage` (attachments, `onCommit`, metadata intact) is re-enqueued at the **front** (preserves per-target FIFO). No error toast; `onCommit` does not fire (it only fires on successful dispatch).
- *Immediate path:* the already-constructed `QueuedMessage` is enqueued at the **back** (it was never in the queue — normal FIFO append). Same no-toast, no-`onCommit` contract.
- *Duplicate-kill:* same-session dispatches persist the user message before IPC, so the refusal is enriched with the persisted message id (`attachRequeueMessageId`, renderer-side only) and the re-drain dedups via `existingMessageId` instead of duplicating.
- *Anti-hot-loop (`deferredTargets`):* a refusal adds the target to a deferred set, treated as busy by `targetBusy()` for non-interrupt entries until the `isSessionBusy` callback identity changes (App wires it on `[sessionSummaries]`; background terminal events always produce a new summaries array). Retry happens when new busy information arrives; as a liveness backstop each deferred target also arms ONE single-shot fallback timer (`DEFERRED_TARGET_RETRY_FALLBACK_MS`, ~15s) so a churn-less app cannot strand the message — a premature retry is safe (worst case: refused again, re-deferred, re-armed).
- *Explicit interrupt escapes deferral:* `sendNow` / `sendNow-via-tray` entries bypass the deferred-set check in `targetBusy()` (they carry no policy, so they can never be refused or hot-loop), and tray promotion (`sendQueuedMessageNow`) or composer `sendNow` clears the target's deferral + fallback timer. Stale deferral state never delays the user's explicit interrupt — it is the zombie-turn escape hatch.
- *No resurrection after purge:* `clearQueueForSession` (session delete / per-session clear) records a per-session tombstone timestamp, and `clearQueue` (global clear-all) records a global one; a refusal for a dispatch that was already in flight when the purge happened is **dropped** (info log) instead of requeued, so a cleared/deleted session's message cannot come back. One shared predicate (`wasTargetPurgedMidFlight`) serves both refusal catches.
- *Defer-the-clear:* `processMessage` normally clears pending network-retry state (and its attachment cache, irreversibly) before dispatch. For `'reject'`-policy dispatches the clear is deferred until the turn is admitted, so a refusal leaves an interrupted turn's auto-resume intact.

### Admission-Window Race (closed)

`startAgentTurn` eagerly records the session→turn mapping (`setRendererSession`) at controller-registration time. Previously the mapping was recorded only inside pipeline admission — behind a queued microtask and the concurrency limiter — so two near-simultaneous same-session starts could both see the session as idle (the 260115 duplicate-turn bug shape). Both the `'reject'` probe and the legacy supersede cancel now read a window-free source. Every existing cleanup path (error catch, `cleanupTurn`, `cleanupForRetry`, `releaseActiveSession`) clears the eager mapping.

## How It Works

### Queue Mode (Default for ENTER key and voice double-press)
1. User types message while the **target** session is busy and presses **Enter** (or double-presses mic button) — a cross-session send to a busy target queues even when the viewed session is idle
2. Message added to queue with `queueMode: 'queue'`
3. UI shows queued messages in a tray (no toast—visual feedback via tray)
4. When the message's **target session** goes idle, it auto-processes (drain wakes up on `sessionSummaries` churn — background terminal events always produce a new summaries array)
5. The dispatch carries `supersedePolicy: 'reject'`, so even on a race it can never cancel a turn that started in the meantime
6. Session continuity maintained (`resetConversation: false`)

Note: while busy, both Enter and Alt/Option+Enter queue. Send-now/interrupt is the **Send Now** button only (the Alt+Enter send-now keyboard shortcut was removed 2026-06-06 — it re-introduced the accidental-supersede footgun).

### Ordering: FIFO per target session, skip-ahead across targets

The drain picks the **first eligible** message, not blindly the head: a message whose target session is busy (or deferred after a refusal) is skipped, and every later message for that same target is skipped with it. Messages for the same target never reorder; a busy-target head never starves other targets. One dispatch per wake-up — the dispatched turn's own summary churn triggers the next drain pass. `sendNow` front-insert semantics are unchanged.

### Interrupt Mode (Send Now button)
1. User types message and clicks the **"Send Now"** button
2. Current run is stopped
3. Message added to **front** of queue (priority)
4. Stop completion event triggers queue processing
5. The dispatch carries **no** `supersedePolicy` — if the stop failed or raced, server-side supersession is the deliberate backstop (the interrupt must win)

### Turn Supersession
When a new turn request arrives while an existing turn is running for the same session, behavior depends on the request's `supersedePolicy` (see "Busy Gating and Turn Supersession" above):

- **Default / `'supersede'`** (Send Now, tray send-now, edit/rerun, direct `agentApi.turn` continuation callers, cloud/mobile, stuck-turn recovery):
  1. Server cancels the existing turn
  2. `turn_superseded` event dispatched to renderer
  3. New turn proceeds normally (no toast needed—this is expected behavior)
- **`'reject'`** (every queue-mode dispatch, system continuations included):
  1. Server refuses admission with the typed `AGENT_TURN_TARGET_BUSY` error; the active turn is untouched
  2. The renderer re-queues the message (no loss, no toast) and retries when the target goes idle

## Session-Targeted Messages

The message queue supports routing messages to a specific session, even if the user has switched to a different conversation. This is primarily used for **voice transcripts** that need to go to the conversation that was active when recording started.

### How It Works

1. **QueuedMessage type** includes optional `targetSessionId`:
   ```typescript
   type QueuedMessage = {
     id: string;
     text: string;
     timestamp: number;
     source: 'text' | 'voice';
     attachments?: AnyAttachmentPayload[];
     targetSessionId?: string;  // Route to specific session
   };
   ```

2. **handleUserMessage** accepts `targetSessionId` in options:
   ```typescript
   handleUserMessage(text, 'voice', attachments, { targetSessionId: 'abc123' });
   ```

3. **Interrupt logic awareness**: When `targetSessionId` differs from `currentSessionId`, the queue does NOT interrupt either session's turn—the message is silently queued and executes when its **target** session is idle (regardless of what the viewed session is doing).

4. **processMessage** in `useAgentSessionEngine` validates the target session via `resolveTargetSession()`:
   - Returns `targetSessionId` if session exists and isn't deleted
   - Falls back to `currentSessionId` with toast notification if session was deleted
   - Handles both hard deletes and soft deletes (`deletedAt` field)

### Usage Example (Voice Recording)

```typescript
// In src/renderer/features/voice/hooks/useVoiceRecording.ts - capture session at recording start
const recordingSessionIdRef = useRef<string | null>(null);

const startRecording = () => {
  recordingSessionIdRef.current = currentSessionId;  // Capture now!
  recorder.start();
};

// When transcription completes
submitVoicePrompt(transcript, recordingSessionIdRef.current!);

// In App.tsx - wire to message queue
submitVoicePrompt: (text, sessionId) => 
  submitQueuedMessage(text, 'voice', undefined, { targetSessionId: sessionId })
```

### Key Implementation Details

- **Session validation happens in `processMessage`**, not in the queue itself
- **Message is created directly** when targeting a different session (not added to current session's store)
- **`initiateAgentTurn`'s `sessionChanged` branch** handles inserting the message into the target session if needed
- **Analytics use the resolved session ID** for accurate tracking

See also: [VOICE_AND_AUDIO.md](VOICE_AND_AUDIO.md) for the voice-specific session binding flow.

## Queue Mode Invariants

Certain operations have **hard semantic requirements** about queue behavior that must be enforced regardless of what the callsite requests. These invariants are centralized in `useMessageQueue.handleUserMessage()`.

### Current Invariants

1. **Edit/Retry operations always use `sendNow` semantics** (added 2026-01-31)
   - When `editTargetMessageId` is set, the user is explicitly rewriting conversation history
   - Queueing makes no sense because `rerunEditedMessage()` truncates the conversation
   - Letting the current run finish would produce output against history the user is invalidating
   - Implementation: `queueMode` is forced to `'sendNow'` when `editTargetMessageId` is present

2. **Queue-mode messages never interrupt — enforced at enqueue, drain, AND admission** (strengthened 2026-06-10)
   - Enqueue: a send to a busy target (current OR cross-session) queues instead of dispatching
   - Drain: a message dispatches only when its *target* session is idle (per-target gate)
   - Admission: the dispatch carries `supersedePolicy: 'reject'`, so even a race cannot cancel the target's active turn — the main process refuses and the renderer re-queues
   - Prevents voice transcripts from session A from interrupting session B's run — and prevents a queued message from cancelling its own target's running turn (incident `f6b3e9b0`)
   - Before 2026-06-10 this was enforced only at enqueue, and only against the *viewed* session

#### Callers covered by construction

Anything that submits via `submitQueuedMessage` / `handleUserMessage` with default (or explicit) `queueMode: 'queue'` gets all three enforcement points for free — no per-caller logic. Verified callers include MCP/plugin conversation-start (`onConversationStartRequested` / `onConversationSendRequested` in App.tsx) and the meeting-companion prep/quick-ask/voice-trigger prompts (`MeetingCompanionManager.tsx`), which previously could dispatch straight into a busy cross-session target. `liveCoachService` self-guards with `hasActiveTurnForSession` skips and bypasses `startAgentTurn` entirely; automations/memory call `executeAgentTurn` directly and never supersede.

### Design Decision: Centralized vs Callsite Enforcement

**Current approach**: Invariants are enforced inside `useMessageQueue` rather than at callsites. This ensures consistency regardless of how the API is called.

**Tradeoff**: Callsites can pass `queueMode` values that get silently overridden (e.g., `{ editTargetMessageId, queueMode: 'queue' }` will use `sendNow` anyway). This is documented in comments but could be confusing.

### Future Architecture Consideration

If more invariants are added (threshold: 3+ invariants), consider refactoring to an **intent-based discriminated union API**:

```typescript
type MessageIntent =
  | { kind: 'send'; queueMode?: QueueMode; text: string; ... }
  | { kind: 'edit'; targetId: string; text: string; ... }  // queueMode not allowed
  | { kind: 'retry'; targetId: string; ... };              // queueMode not allowed
```

This would make invalid states unrepresentable at the type level rather than runtime checks.

**Decision**: Keep current approach for now (2 invariants). Re-evaluate when adding a third invariant.

### Rejected: `isStopping` Queue Priority (Option B)

**Proposal** (rejected 2026-01-31): When `isStopping` is true, force all new messages to front-of-queue regardless of `queueMode`.

**Why rejected**:

1. **Message order inversion**: If user sends "queue" message B, clicks Stop, then sends "queue" message C during stopping, Option B would put C before B—violating the order the user sent them.

2. **`isStopping` is internal state, not user intent**: Users don't see or control the stopping state. Behavior shouldn't change based on invisible internal state.

3. **The "correction" scenario is already solved**: If the user wants their stopping-time message to go first, they can use `sendNow` via the **Send Now** button. The UI supports this explicit choice (as of 2026-06-06 it is button-only — there is no keyboard send-now shortcut).

4. **Current behavior is intuitive**: Messages queue in FIFO order regardless of stop state. Predictable ordering is easier to reason about.

**Current behavior during `isStopping`**:
- Messages follow the same ordering rules as always
- User's `queueMode` choice is respected
- `sendNow` → front of queue; `queue` → back of queue

## Per-message `onCommit` callback

`handleUserMessage` accepts an optional `onCommit?: () => void | Promise<void>` alongside the message metadata. It is stored on the `QueuedMessage` and fires **exactly once**, after the message's dispatch (`processMessage` or `rerunEditedMessage`) has resolved successfully. The closure is garbage-collected with the `QueuedMessage`.

**Fire semantics:**

- **Fires** after `await processMessage(...)` / `await rerunEditedMessage(...)` resolves on the happy path — for both the immediate-send path (`handleUserMessage`) and the queued-flush path (`processNextInQueue`).
- **Does NOT fire** on `processMessage` rejection/throw, `removeFromQueue`, `clearQueueForSession`, session delete, or app restart — the closure is dropped with the `QueuedMessage` and never reached.
- **Fire-and-forget**: the queue does NOT `await` the callback, so drain latency is unaffected by slow clean-up work.
- Synchronous throws AND rejected promises from async callbacks are both caught and logged at `error` level with `{ sessionId, callbackType: 'onCommit', error }`. They are never re-thrown to the caller, so a misbehaving clean-up hook cannot break the queue or the user's send path.

**When to use it:**

- Clean-up hooks whose contract is "the message actually went out" — e.g. clearing staged document annotations only when the send truly commits. See [`docs/plans/260417_centralize_annotations_and_fix_document_send_clear.md`](../plans/260417_centralize_annotations_and_fix_document_send_clear.md) for the motivating use case.

**When NOT to use it:**

- System-continuation messages (`isSystemContinuation: true`), approval retries, automation resumes, or network-reconnect replays — these callers should not attach an `onCommit`. Reruns via `rerunEditedMessage` likewise should typically leave it unset; the callback mechanism exists for per-submission cleanup, not for per-turn lifecycle tracking.

The callback is per-`QueuedMessage`, not per-session. Two sends from the same file on the same session produce two `QueuedMessage`s with two independent closures; each fires on its own dispatch. No module-level state or cross-session leakage is possible.
