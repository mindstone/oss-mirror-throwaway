---
description: "How conversation context is preserved or lost across turns, restarts, edits, fallbacks, and compaction"
last_updated: "2026-04-02"
---

# Conversation Context Continuity

How Rebel preserves conversation context across agent turns, and the interactions between session resume, history injection, message editing, model fallback, compaction, and app restart that can cause context loss if misunderstood.

**This document exists because** six separate bug fixes over five weeks (Feb-Mar 2026) each addressed individual symptoms of context loss without a unified view of the system. The result was a fragile patchwork where fixing one path could break another. This document is the canonical reference for understanding how all these mechanisms interact.


## See Also

- [CONTEXT_MANAGEMENT](CONTEXT_MANAGEMENT.md) -- Hub doc for the full context management system (compaction, caching, materialization, cost tracking)
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) -- Session model, persistence, upstream ID lifecycle, lazy loading
- [ARCHITECTURE_AGENT_TURN_EXECUTION](ARCHITECTURE_AGENT_TURN_EXECUTION.md) -- Turn lifecycle, prompt assembly, model routing, event dispatch
- [ARCHITECTURE_CONTEXT_OVERFLOW_RECOVERY](ARCHITECTURE_CONTEXT_OVERFLOW_RECOVERY.md) -- Compaction summary generation, retry logic, circuit breaker
- [ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK](ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK.md) -- Extended context, OAuth-to-API-key fallback
- `src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts` -- Renderer session engine (resetConversation calculation, edit flow, compaction)
- `src/main/services/agentTurnExecutor.ts` -- Main-process turn execution (history injection, fallback paths)
- `src/main/services/recovery/desktopRecoveryAdapter.ts` -- Context overflow recovery wrapper
- `src/renderer/features/agent-session/store/sessionStore.ts` -- Session state, lazy loading, summaries
- `docs/plans/finished/260312_truncation_continuation_tool_safety.md` -- Truncation detection and stop_reason investigation


## The Core Problem

Rebel maintains conversation context through:

1. **History injection** -- Rebel Core maintains conversation context by reading the conversation from disk and prepending a formatted transcript to the user's prompt.
2. **Context continuity** -- The `resetConversation` flag is the single control point that determines whether prior context is injected. Getting it wrong causes either **context loss** (user's prior conversation is forgotten) or **stale context injection** (old conversation injected when not needed).


## The resetConversation Flag

### Semantics

`resetConversation` is a boolean passed from renderer to main on every `agent:turn` IPC call. It controls:

1. **History injection guard** (main process): When `true`, `loadConversationHistory()` returns empty string, skipping disk-based history injection. When `false`, conversation history is loaded from disk and injected into the prompt.

### When resetConversation is true

| Scenario | Why it must be true |
|----------|-------------------|
| First message in a new conversation | No prior context exists |
| Message edit/rerun | Renderer truncates messages and embeds prior context directly in the prompt via `buildConversationContextForEdit()` |
| Compaction retry | Renderer generates a summary and embeds it in an enhanced prompt |
| Calendar/meeting analysis turns | Standalone turns that don't belong to an existing conversation |
| CLI `--reset` flag | User explicitly requests fresh start |

### When resetConversation is false

| Scenario | Why it must be false |
|----------|-------------------|
| Follow-up message in existing conversation | History injection provides conversation context |
| Queued/interrupted messages | Same session ID, context preserved through history injection |
| Message after loading history session | Conversation context loaded from disk |

### How it's calculated (renderer)

In `useAgentSessionEngine.ts::processMessage()`:

```
For DIFFERENT-session targets (e.g., session-targeted voice):
  resetConversation = targetSummary.messageCount === 0

For CURRENT session:
  effectiveMessageCount = Math.max(messages.length, summaryMessageCount)
  resetConversation = effectiveMessageCount === 1
```

The `Math.max` with `summaryMessageCount` is the FOX-2866 fix. After app restart with lazy loading, the store's `messages` array may be empty (messages load on-demand), but `sessionSummaries` always have accurate `messageCount` from the index. Without this, a continuation turn after restart would get `resetConversation: true`, causing complete context loss.

**Note**: The check is `=== 1` (not `=== 0`) because `addUserMessage()` has already pushed the current user message into the array by the time this runs.


## Context Delivery Paths

There are two distinct ways conversation context reaches Claude:

### Path 1: Disk-Based History Injection (primary)

```
Renderer                Main Process              Rebel Core
   │                        │                        │
   ├─ resetConversation:    │                        │
   │  false                 │                        │
   │                        ├─ loadConversationHistory()
   │                        │  reads from disk       │
   │                        ├─ Prepends <conversation_history>
   │                        │  to prompt             │
   │                        │                        ├─ Context from prompt
   │                        │                        │
```

**When used**: `rendererSessionId && !resetConversation` -- there's a session to continue.
**Context quality**: Good but lossy -- limited to `MAX_CONVERSATION_HISTORY_CHARS`, truncated from front, no tool use details. Compaction-boundary-aware: only includes messages after the last compaction boundary.
**Risk**: Disk state may be slightly stale (persistence is debounced ~300ms). Acceptable because the current user prompt is always included regardless.

**All fallback paths that use disk-based injection:**

| Fallback path | Label in logs | Why fallback is needed |
|---------------|---------------|----------------------|
| Proactive injection | `'proactive injection'` | Standard history injection at turn start |
| API key 1M fallback | `'API key 1M fallback'` | Auth switch (OAuth to API key with 1M context) |
| Thinking model fallback | `'thinking model fallback'` | Model downgrade rebuilds query options |
| Alt-model fallback | `'alt-model fallback'` | Local proxy failed, falling back to Claude directly |
| API key rate-limit fallback | `'API key rate-limit fallback'` | OAuth rate-limited, falling back to API key |

All paths call `loadConversationHistory(rendererSessionId, turnLogger, label, resetConversation)` with the same `resetConversation` guard.

### Path 2: Prompt-Embedded Context (edit/compaction)

```
Renderer                Main Process              Rebel Core
   │                        │                        │
   ├─ resetConversation:    │                        │
   │  true                  │                        │
   ├─ prompt includes       │                        │
   │  [Previous conversation:]                       │
   │  or [COMPACTION_DEPTH:N]                        │
   │                        ├─ loadConversationHistory()
   │                        │  returns '' (guarded)  │
   │                        │                        ├─ Context from prompt
   │                        │                        │  only
```

**When used**: Message edits (via `buildConversationContextForEdit()`) and compaction retries (via `buildEnhancedPrompt()`).
**Context quality**: Varies -- edits include all messages before the edit point; compaction includes a summary generated by Claude.
**Risk**: If `resetConversation` is false when it should be true (or vice versa), context is either doubled or lost.


## Prior-Turns Header Injection

On non-initial turns, Rebel can inject a structured `<prior_turns>` XML header summarizing prior tool calls so the model doesn't redo work. This is layered on top of the existing Path 1 / Path 2 context delivery — it does not replace it.

### When the header is included

Header injection is gated by the `enablePriorTurnsHeader` feature flag (default `false`, opt-in per the v1 rollout plan). The canonical injection logic lives in [`buildContinuationContext.ts`](../../src/core/services/buildContinuationContext.ts) and handles three modes:

| Mode | Trigger | Path in `buildContinuationContext.ts` |
|------|---------|---------------------------------------|
| `proactive-main` | Non-initial turn, `enablePriorTurnsHeader: true`, prior turns exist | `mode: 'proactive-main'` |
| `continuation-accumulator` | `AskUserQuestion` continuation, renderer-started via `sendMessageToSession` | `mode: 'continuation-accumulator'` |
| `recovery` | Null-session / missing transcript / parse error / all filtered by compaction | `mode: 'recovery'` |

### F3: Preventing double injection across AskUserQuestion

`userQuestionResponseHandler.ts` (PRODUCER) carries `continuationContext: { alreadyInjected: true }` through the `agent:turn` IPC contract. `agentTurnExecute.ts` (CONSUMER) checks `turnOptions.continuationContext?.alreadyInjected === true` and skips the canonical `buildContinuationContext` call, logging the carried `meta` for telemetry parity. This prevents `<prior_turns>` from being injected twice when a user's answer starts a new turn.

### Injection pipeline (simplified)

```
Renderer ──[resetConversation: false]──► agentTurnExecute.ts
                                         │
                                         ├── buildContinuationContext()
                                         │      │
                                         │      ├── priorTurnsReader.ts
                                         │      │   (reads transcripts/<sid>.jsonl,
                                         │      │    compaction-aware filter)
                                         │      │
                                         │      ├── buildPriorTurnsHeader.ts
                                         │      │   (renders <prior_turns> XML block,
                                         │      │    1200-token cap, ZWSP escaper)
                                         │      │
                                         │      └── loadConversationHistory()
                                         │          (standard history injection)
                                         │
                                         └── effectivePrompt = header + history + prompt
```

### Sub-agent suppression (F1)

`inspect_prior_turns` and `get_tool_call` are added to `BuiltinToolContext.suppressedBuiltins` so sub-agents (BTS, Coder, Doer) cannot see them. The constant `SUBAGENT_SUPPRESSED_PRIOR_TURN_BUILTINS` propagates through nested sub-agent dispatch. See [`priorTurnsTools.ts`](../../src/core/services/priorTurnsTools.ts) and [`agentTool.ts`](../../src/core/rebelCore/agentTool.ts).

For the full design including failure modes, telemetry events, and Stage 1–5 implementation, see [`docs/plans/260525_cross_turn_awareness_layer1_layer2.md`](../plans/260525_cross_turn_awareness_layer1_layer2.md).


## Interaction Matrix: What Can Go Wrong

| System A | System B | Interaction | Risk |
|----------|----------|-------------|------|
| **Lazy loading** | **resetConversation calc** | After app restart, `messages.length` may be 0 despite having persisted messages | False `resetConversation: true` -- context loss (FOX-2866) |
| **Message edit** | **History injection** | Edit sets `resetConversation: true` and embeds context in prompt | If guard is missing, history injection doubles the context |
| **Compaction** | **History injection** | Compaction sets `resetConversation: true` with summary in prompt | If guard is missing, pre-compaction history is injected over the summary |
| **Model fallback** | **History injection** | Fallback rebuilds query options | Must inject history; if `resetConversation: true`, injection is skipped and context is lost |
| **App restart** | **History injection** | PID change means in-memory registry is empty | Rebel Core relies on disk-based history injection (Path 1) |
| **Compaction** | **History injection** | Compaction boundaries mark where context was summarized | `buildConversationHistoryContext()` must respect boundaries: only post-boundary messages are included |


## Compaction Boundaries

When context overflow triggers compaction, Rebel records a **compaction boundary** in the session:

```typescript
interface CompactionBoundary {
  afterMessageIndex: number;  // Messages AFTER this index are post-compaction
  summary: string;            // The summary generated during compaction
  timestamp: number;          // When compaction occurred
  depth: number;              // Compaction attempt number (1 or 2)
}
```

`buildConversationHistoryContext()` respects these boundaries:
- When boundaries exist, only messages after the last boundary index are included in disk-based injection.
- Pre-boundary messages are redundant because the compaction summary already covers them.
- This prevents disk-based injection from injecting content that was deliberately compacted away.


## Session Resume After App Restart

Under Rebel Core (sole runtime since April 2026), context continuity relies entirely on disk-based history injection:

1. **Startup**: Renderer loads session summaries from the index (lightweight, no message bodies).
2. **Session open**: When user selects a history session, `openHistorySession()` loads full messages from disk.
3. **Next turn**: The executor uses disk-based history injection (Path 1) to provide conversation context. There is no server-side session resume.
**The lazy loading race (FOX-2866)**:

The session store uses lazy loading: summaries load at startup, full message bodies load on-demand when a session is opened. If the user sends a message to the *current* session immediately after restart (without explicitly opening it from history), the messages array may still be empty. The `Math.max(messages.length, summaryMessageCount)` fix uses the always-accurate summary count to prevent false resets.


## Message Editing Flow

When a user edits a previous message (via `rerunEditedMessage()`):

1. `buildConversationContextForEdit()` builds `[Previous conversation:]` from messages before the edit point.
2. The edited message text is appended after the context preamble.
3. `truncateToMessage()` removes all messages/events after the edit point from the store.
4. Turn is sent with `resetConversation: true`.

This means:
- The `loadConversationHistory()` guard prevents stale pre-edit context from being injected.
- The renderer owns all context embedding; the main process just passes through the prompt.
- If any model fallback fires during this turn, it will also skip history injection (correct behavior, since context is already in the prompt).


## Bug History and Lessons Learned

These bugs, fixed over Feb-Mar 2026, all involved incorrect interaction between the mechanisms above:

### 1. Stale history on edit (2e438055c, Feb 15)

**Problem**: When user edited a message, `loadConversationHistory()` in the main process would inject the full pre-edit conversation on top of the renderer's already-embedded context, causing duplicate/contradictory context.
**Fix**: Added the `resetConversation` guard to `loadConversationHistory()`.
**Side effect**: This guard also blocks legitimate history injection when `resetConversation` is erroneously `true` (which happened in FOX-2866).

### 2. Media turns losing history (858af0f76, Mar 2)

**Problem**: The 6 fallback paths in `agentTurnExecutor.ts` only injected history for string prompts. When the turn used an async generator (for image/PDF attachments), history was silently dropped.
**Fix**: Extended `createPromptOrGenerator()` factory to accept a `conversationContext` parameter. All 6 fallback paths now pass history through regardless of prompt type.

### 3. False truncation detection (0ec48c000, Mar 10 -> d7379ad40, Mar 12)

**Problem**: `stop_reason === null` was used to detect truncated responses. In practice, the SDK returns `null` as the default on all result messages, causing 415 false-positive "truncation" events.
**Fix**: Entirely removed `stop_reason`-based branching. The field is now logged at debug level only.
**Lesson**: Don't branch on SDK fields without verifying their actual runtime values across multiple sessions.

### 4. Stale upstream sessions in automation (6cc346fad, Mar 11)

**Problem**: Automation sessions persisted stale upstream IDs. On recovery, these caused repeated `SESSION_NOT_FOUND` errors.
**Fix**: Guard automation sessions from upstream restore; clear persisted IDs on recovery.

### 5. Context overflow continuation removal (Mar 10-12)

**Problem**: A multi-commit attempt to detect and continue truncated responses (using `stop_reason`, continuation prompts, retry logic) was fundamentally flawed because the SDK doesn't reliably signal truncation.
**Fix**: All continuation machinery removed. Context overflow is handled exclusively by the compaction system (`desktopRecoveryAdapter.ts`).

### 6. False resetConversation after app restart (d1850da7c, Mar 20 -- FOX-2866)

**Problem**: `resetConversation = messages.length === 1` in the renderer evaluated to `true` after app restart because lazy loading hadn't hydrated the session's message bodies yet. This caused the main process to delete the upstream session mapping and skip history injection, resulting in complete context loss.
**Fix**: `resetConversation = Math.max(messages.length, summaryMessageCount) === 1`. The summary index always has accurate message counts regardless of lazy loading state.
**Key insight**: The renderer's `messages` array is not a reliable source of truth for "how many messages exist in this session" when lazy loading is active. Summaries are.


## Invariants

These must hold for correct operation. Violating any of them causes context loss or corruption:

1. **resetConversation must be true IFF the turn is starting fresh context.** Message edits, compaction, and first messages set it true. Follow-up messages in existing conversations set it false.

2. **When resetConversation is true, the renderer must embed any needed context in the prompt.** The main process will not inject history.

3. **When resetConversation is false, the main process must inject history from disk.** This is how Rebel Core maintains conversation context across turns.

4. **Model fallback paths must inject history.** All fallback paths call `loadConversationHistory()`, which correctly injects history only when `resetConversation` is false.

5. **Compaction boundaries must be respected in history injection.** `buildConversationHistoryContext()` uses only post-boundary messages when boundaries exist.

6. **Summary messageCount must be used alongside messages.length for resetConversation calculation.** This prevents the lazy-loading race after app restart.


## Testing Checklist

When modifying any code in the conversation context path, verify these scenarios:

- [ ] New conversation: first message gets `resetConversation: true`, no history injection
- [ ] Follow-up message: `resetConversation: false`, history injection works
- [ ] App restart + immediate message: `resetConversation` is `false` (summary prevents false positive)
- [ ] App restart + open history + message: context loaded from disk, history injection works
- [ ] Message edit: context is embedded in prompt, `resetConversation: true`, no double injection
- [ ] Compaction: summary in prompt, `resetConversation: true`, no pre-compaction history injected
- [ ] Model fallback (any path): history injected when `resetConversation: false`
- [ ] Model fallback during edit rerun: history NOT injected (edit context already in prompt)
- [ ] Session with compaction boundaries: history injection uses only post-boundary messages


## Code Pointers

| Concern | File | Function/Section |
|---------|------|-----------------|
| resetConversation calculation | `useAgentSessionEngine.ts` | `processMessage()` ~L1379 |
| Edit context embedding | `useAgentSessionEngine.ts` | `buildConversationContextForEdit()` ~L119 |
| Edit/rerun flow | `useAgentSessionEngine.ts` | `rerunEditedMessage()` ~L1489 |
| Compaction retry | `useAgentSessionEngine.ts` | `handleContextOverflow()` ~L470 |
| History injection guard | `agentTurnExecutor.ts` | `loadConversationHistory()` ~L230 |
| History formatting | `agentTurnExecutor.ts` | `buildConversationHistoryContext()` ~L156 |
| Proactive injection | `agentTurnExecutor.ts` | ~L1616 |
| Model fallback injections | `agentTurnExecutor.ts` | ~L3613, ~L3738, ~L3916, ~L4123, ~L4479 |

| Session summaries | `sessionStore.ts` | `sessionSummaries`, `openHistorySession()` |
| Compaction boundaries | `sessionStore.ts` | `performCompaction()` |
| Overflow recovery | `desktopRecoveryAdapter.ts` | `executeAgentTurnWithRecovery()` |
