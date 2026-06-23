---
description: "How Rebel detects context overflow and recovers via summaries, tool limit reduction, and truncation continuation"
last_updated: "2026-05-31"
---

# Context Overflow Detection and Recovery

How Mindstone Rebel detects context overflow (running out of context window) and automatically recovers by generating conversation summaries and retrying with reduced context.

---

## See Also

- [CONTEXT_MANAGEMENT.md](CONTEXT_MANAGEMENT.md) - **Hub doc** for the full context management system (tiered compaction, prompt caching, materialization, cost tracking)
- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) - High-level system architecture and agent session lifecycle
- [COST_TRACKING.md](COST_TRACKING.md) - How costs are tracked, including during compaction
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) - Agent session model and event flows
- [PROMPT_CACHING.md](PROMPT_CACHING.md) - Claude SDK prompt caching behavior (relevant for cache invalidation on compaction)
- [ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK.md](ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK.md) - 1M context window (always-on when enabled; lazy escalation removed Feb 2026)
- [ARCHITECTURE_CONVERSATION_CONTEXT_CONTINUITY.md](ARCHITECTURE_CONVERSATION_CONTEXT_CONTINUITY.md) - Context delivery paths, risky-resume detection (prevents context loss *before* overflow during session resume after sleep/restart)
- `src/main/services/recovery/desktopRecoveryAdapter.ts` - Recovery wrapper around turn execution
- `src/main/services/compactionService.ts` - Summary generation for context compaction
- `src/core/utils/compactionUtils.ts` - Prompt building and depth parsing utilities
- `src/main/services/agentTurnRegistry.ts` - Turn state management including overflow tracking
- `src/main/services/agentMessageHandler.ts` - Where overflow is first detected from agent messages
- `src/main/services/turnErrorRecovery.ts` - Broadened overflow classification (multi-provider error patterns)
- `src/core/rebelCore/contextPolicy.ts` - `decideCompaction()` — pure policy function with `ProviderCapabilities`
- `src/main/tracking.ts` - Tool metrics aggregation including output size tracking for limit suggestions

---

## Overview

When a Rebel Core turn approaches or exceeds its context window, Rebel uses a tiered, **provider-aware** recovery strategy:

1. Server-side context management (Anthropic direct/proxy): requests include a model-aware `context_management` block with `clear_tool_uses_20250919`, `clear_tool_inputs: true`, and `exclude_tools` to prune low-value tool history.
2. Optional server-side compaction: when `experimental.compactEnabled` is on, Anthropic's `compact_20260112` edit is added.
3. Between-turn policy hook: after each loop iteration, Rebel Core evaluates context pressure via `decideCompaction()` using provider-aware capabilities (see "Cross-Provider Support" below).
4. Last-resort overflow recovery: if a turn still overflows, `desktopRecoveryAdapter.ts` generates a summary and retries with an enhanced prompt. Uses the execution model (not planning model) for compaction to avoid Opus cost.
5. Circuit breaker: fail gracefully after `MAX_COMPACTION_DEPTH` (2) attempts.

### Cross-Provider Support

As of April 2026, context overflow detection and recovery works across all supported providers, not just Anthropic:

- **Overflow classification** (`turnErrorRecovery.ts`): matches Anthropic "prompt is too long", 413 `request_too_large`, OpenAI/Google token-count phrasings (`token` + `exceed`/`maximum`), and generic context overflow patterns.
- **Provider-aware between-turn compaction** (`contextPolicy.ts`): `decideCompaction()` accepts `ProviderCapabilities` describing each provider's native features (`hasNativeContextEditing`, `hasNativeCompaction`, `cacheStrategy`, `cacheHeuristicTtlMs`). Anthropic gets server-side `clear_tool_uses`; non-Anthropic providers get `client_prune_tool_pairs` (client-side removal of old tool result pairs).
- **Provider-aware auth gate**: compaction BTS calls route through appropriate authentication based on the active provider.
- **ProxyConfig forwarding**: overflow fallback client receives `proxyConfig` conditionally based on provider, so non-Anthropic proxy configurations work correctly during recovery.
- **Execution model for compaction**: compaction uses the execution model (not planning model) to avoid unnecessary cost (e.g., Opus) in planning-mode sessions.

This is a high-risk, user-visible recovery subsystem. When it works, users see a brief "compacting context" status and the conversation continues. When it fails, users receive a clear error asking them to break tasks into smaller steps.

---

## Event Taxonomy

Context overflow and compaction emit a specific set of `AgentEvent` types for UI feedback:

| Event Type | When Emitted | Key Fields |
|------------|--------------|------------|
| `context_overflow` | Overflow detected | `originalPrompt` |
| `compaction_started` | Beginning recovery | `depth`, `sessionId` |
| `compaction_summary_ready` | Summary generated | `summary`, `depth` |
| `compaction_retrying` | About to retry | `depth` |
| `compaction_completed` | Retry succeeded | *(none)* |
| `compaction_failed` | Recovery failed | `error`, `depth` |

All events include a `timestamp` field.

### Intent & Design Rationale — REBEL-5BM recovery taxonomy

`summary_generation_failed` is reserved for genuine empty-skeleton failures and defensive
unhandled idle/skeleton states only. Do not collapse post-recovery-start agent-loop errors
back into it; those belong to `agent_loop_error_after_recovery`, parallel to
`agent_loop_error_before_recovery`, so Sentry separates compaction failures from provider,
auth, rate-limit, or stream failures after compaction has succeeded.

The adapter boundary is the normalization point: `normalizeRecoveryError` is shared by desktop
and cloud and redacts/truncates string errors, `Error.message`, copied stacks, and `rawError`
before `captureKnownCondition`. A future "simplification" that passes the raw `Error` to
Sentry re-opens the leak this fix closed.

Renderer recovery copy is an allow-list. Only genuine size/capacity reasons
(`summary_generation_failed`, `depth_limit_reached`, `attempt_limit_reached`) get the
"too large / fresh start" message; new reasons must default to neutral copy unless they are
explicitly proven to be capacity failures.

Known limitations and committed follow-ups: the canonical post-retry path currently suppresses
reason-aware overlay copy because `useRecoveryAdapter` rejects `recovery:failed` while
`phase === 'continuing'` and surfaces the turn-error UI instead; making it reachable needs
design sign-off. Backfill `long_context_fallback_failed` event schemas, treat automation
catch-up provider-error throttling (cooldown/concurrency) as the next remediation rather than
optional cleanup, and post-deploy validate A3: real `agent_loop_error_after_recovery` events
must carry useful `errorKind`/`provider` diagnostics when available.

---

## Overflow Detection

Overflow is detected in two places:

### 1. Turn Error Recovery (`turnErrorRecovery.ts`)

When a turn fails, the error recovery handler classifies the error using broad, multi-provider pattern matching:

```typescript
// Anthropic: "prompt is too long/too large"
const isPromptTooLongError = lowerErrorMsg.includes('prompt') &&
  (lowerErrorMsg.includes('too long') || lowerErrorMsg.includes('too large') || lowerErrorMsg.includes('exceed'));

// All providers: 413 request_too_large, token count exceeded, context overflow
const isContextOverflowError =
  lowerErrorMsg.includes('request too large') ||
  lowerErrorMsg.includes('413') ||
  (lowerErrorMsg.includes('context') &&
    (lowerErrorMsg.includes('overflow') || lowerErrorMsg.includes('length') ||
      (lowerErrorMsg.includes('window') && lowerErrorMsg.includes('exceed')))) ||
  (lowerErrorMsg.includes('token') &&
    (lowerErrorMsg.includes('exceed') || lowerErrorMsg.includes('maximum')));
```

This covers Anthropic's "prompt is too long", OpenAI/Google's token-count-based rejections, and generic 413/request_too_large errors from any provider.

The handler uses `agentTurnRegistry.hasContextOverflowDispatched(turnId)` to prevent duplicate dispatch and `markContextOverflowDispatched(turnId)` after dispatching.

### 2. Extended Context Unavailable (`agentTurnExecutor.ts`)

When using the extended 1M context beta and it becomes unavailable (rate limited or API issues), the SDK may return this as an assistant message or result text. The handler checks for this pattern and throws to trigger retry:

```typescript
if (isExtendedContextUnavailableError(text)) {
  throw new Error(text);
}
```

---

## Recovery State Machine

The recovery loop in `desktopRecoveryAdapter.ts` follows this state machine:

```
┌─────────────────┐
│  executeSingleTurn  │
└────────┬────────┘
         │
    ┌────▼────┐
    │ Outcome │
    └────┬────┘
         │
    ┌────┴────────────────────────────────┐
    │             │                        │
┌───▼───┐    ┌───▼───┐              ┌─────▼─────┐
│ result │    │ error │              │ overflow  │
└───┬───┘    └───┬───┘              └─────┬─────┘
    │            │                        │
    ▼            ▼                   ┌────▼────┐
  [done]       [done]                │ recovery │
                                     │ enabled? │
                                     └────┬────┘
                                          │
                              ┌───────────┴───────────┐
                              │ No                     │ Yes
                              ▼                        ▼
                        [pass through]           ┌─────────┐
                                                 │ depth > │
                                                 │   MAX?  │
                                                 └────┬────┘
                                                      │
                                          ┌───────────┴───────────┐
                                          │ Yes (circuit break)   │ No
                                          ▼                        ▼
                                    [emit failure]          [generate summary]
                                                                   │
                                                             ┌─────▼─────┐
                                                             │ build     │
                                                             │ enhanced  │
                                                             │ prompt    │
                                                             └─────┬─────┘
                                                                   │
                                                             ┌─────▼─────┐
                                                             │ retry     │
                                                             │ (loop)    │
                                                             └───────────┘
```

### Circuit Breaker

`MAX_COMPACTION_DEPTH = 2` (defined in `compactionUtils.ts`)

After 2 compaction attempts, the system gives up:

```
Packed twice, still overweight. This task needs to be broken into smaller steps.
```

---

## Summary Generation

The `compactionService.ts` module generates a summary by:

1. **Converting messages to transcript**: Filters to messages with text, maps to `{role, text}` entries
2. **Building a prompt**: Asks Claude to summarize preserving:
   - User's original goal and sub-tasks
   - What was accomplished and what remains
   - Important decisions, constraints, preferences
   - Technical details needed to continue
3. **Executing via BTS Anthropic call**: Uses `callBehindTheScenesWithAuth()` (via `@core/services/compactionService`) with:
   - 30-second timeout
   - category `compaction`
   - the shared `COMPACTION_SYSTEM_PROMPT`
   - direct Anthropic auth from app settings
4. **Truncating result**: Limits to 4000 chars

### Summary System Prompt

```
You are a context preservation assistant. Your job is to summarize conversations so they can continue seamlessly.
Rules:
- Capture the user's original goal and any sub-tasks.
- Note what was accomplished and what remains to be done.
- Preserve any important decisions, constraints, or preferences mentioned.
- Keep technical details that would be needed to continue the work.
- Be concise but complete - aim for 500-1500 words.
- Write in a way that allows the conversation to resume naturally.
- Output only the summary, no preamble or explanation.
```

---

## Retry Prompt Construction

The `buildEnhancedPrompt()` function in `compactionUtils.ts` constructs the retry prompt:

```
[COMPACTION_DEPTH:1]
=== CONVERSATION SUMMARY ===
<summary text>

<tool guidance - see below>

=== CONTINUE WITH REQUEST ===
<original prompt with depth markers removed>
```

### Tool Limit Suggestions

When tools produced large outputs that may have contributed to overflow, the prompt includes specific limits:

**Depth 1** (first retry):
```
IMPORTANT: The previous attempt exceeded context limits.
When calling use_tool for these tools, add max_output_chars:
  - filesystem/read_file: max_output_chars: 50000 (was 100000 chars)
  - super-mcp/use_tool: max_output_chars: 75000 (was 150000 chars)

Example: use_tool({ package_id: "filesystem", tool_id: "read_file", args: {...}, max_output_chars: 50000 })
```

**Depth 2** (second retry - more aggressive):
```
CRITICAL: Context limits exceeded again despite previous attempt. You MUST limit outputs.
When calling use_tool for these tools, add max_output_chars:
  - filesystem/read_file: max_output_chars: 25000 (was 100000 chars)
  ...

If the task still cannot be completed, break it into smaller steps or request only summaries/excerpts instead of full content.
```

### Tool Limit Calculation

`TurnMetricsAggregator.getToolLimitSuggestions(depth)` in `tracking.ts` calculates limits:

- **Depth 1**: Top 2 tools by output size, cut to 50%
- **Depth 2+**: Top 5 tools by output size, cut to 25%
- **Minimum limit**: 10,000 chars (≈2.5k tokens)

### Super-MCP Materialization + Continuation (Complementary Strategy)

In addition to lowering `max_output_chars`, Super-MCP now uses **auto-materialization** as the primary large-output path. When output exceeds `MATERIALIZATION_THRESHOLD_CHARS` (20K chars), Super-MCP first tries to write the full result to `{workspace}/.rebel/tool-outputs/` and returns a compact response with `file_path`, `size_chars`, `estimated_tokens`, and a short preview. If materialization is unavailable, truncation kicks in at `DEFAULT_MAX_OUTPUT_CHARS` (100K chars).

The model can then use `Read` (with `offset`/`limit`) or `Grep` on that file instead of repeatedly fetching huge inline payloads.

If materialization is unavailable (no workspace, write failure, or >20MB output), Super-MCP falls back to the existing truncation + `result_id`/`output_offset` continuation flow. A post-serialization safety net catches any remaining oversized outputs (e.g., non-text content like audio or embedded resources that survive text truncation) and replaces them with a compact placeholder + continuation.

This remains complementary to compaction: compaction summarizes conversation history, while materialization/continuation keeps tool payloads out of context.

For details on thresholds, response fields, and continuation protocol, see [SUPERMCP_OVERVIEW.md § Tool Output Truncation and Continuation](SUPERMCP_OVERVIEW.md#tool-output-truncation-and-continuation).

---

## State Captured Before Retry

When overflow is detected, the following state is captured **before** cleanup:

| State | Source | Purpose |
|-------|--------|---------|
| `accumulatedMessages` | `agentTurnRegistry.getContextAccumulator(turnId)` | Input for summary generation |
| `toolSuggestions` | `getTurnAggregator(turnId).getToolLimitSuggestions()` | Tool limit guidance in retry prompt |
| `originalPrompt` | Attached to `context_overflow` event | Base prompt for retry construction |

After capture, the system clears state:

```typescript
agentTurnRegistry.deleteContextAccumulator(turnId);
agentTurnRegistry.clearContextOverflowDispatched(turnId);
```

### Cost Preservation

Cost is preserved even when `eventsByTurn` is cleared. The cost ledger (`cost-ledger.jsonl`) appends entries on each successful turn completion, so:

- **Preserved**: Total cost spent on the conversation (all turns, including pre-compaction)
- **Lost**: Per-turn token breakdown, model info (from cleared session events)

See [COST_TRACKING.md](COST_TRACKING.md) for details on the ledger design.

---

## Event Flow During Compaction

1. **Overflow detected** → `context_overflow` event dispatched
2. **Recovery starts** → `compaction_started` event with `depth: 1`
3. **Summary generated** → `compaction_summary_ready` with summary text
4. **About to retry** → `compaction_retrying` event
5. **Context cleared** → `agentTurnRegistry` cleanup called
6. **Turn re-executed** → `resetConversation: true` passed to SDK
7. **If successful** → Normal `result` event (no special compaction event needed)
8. **If fails again** → Back to step 1 with `depth: 2`
9. **If max depth exceeded** → `compaction_failed` event

### Renderer Notification

Events are dispatched via `dispatchAgentEvent(win, turnId, event)` which:

1. Sends to renderer via `win.webContents.send('agent:event', { turnId, event })`
2. Accumulates in context accumulator for this turn
3. Notifies any registered event listeners (for automation/headless modes)

---

## User-Visible Experience

### During Compaction

Users see status updates in the conversation view:
- "Compacting context to continue..."
- Brief summary preview (via `compaction_summary_ready`)

### On Success

The conversation continues seamlessly. The summary becomes part of the context, and the original request is re-processed.

### On Failure

Users see a clear error message:

> Context limit exceeded after multiple compaction attempts. Try breaking the task into smaller steps.

---

## Debugging

### Logs

Use `createScopedLogger({ service: 'agentTurnWithRecovery' })` and check logs for:

```
Starting agent turn with recovery
Context overflow recovery failed: ...
Enhanced prompt built, retrying
Max compaction depth exceeded
```

### Key Log Fields

- `turnId` - Identifies the specific turn
- `recoveryAttempts` - Number of retries attempted
- `currentDepth` / `nextDepth` - Compaction depth markers
- `summaryLength`, `enhancedPromptLength` - Size metrics
- `toolSuggestionsCount` - Number of tools with limits

### Common Failure Modes

1. **No messages accumulated**: Summary generation fails if no conversation history is available
2. **Summary generation timeout**: 30-second timeout exceeded
3. **Summary generation API error**: Missing API key or network failure
4. **Infinite loop prevention**: Circuit breaker triggers after 2 attempts

---

## Configuration

| Setting | Value | Location |
|---------|-------|----------|
| `MAX_COMPACTION_DEPTH` | 2 | `src/core/utils/compactionUtils.ts` |
| `SUMMARY_TIMEOUT_MS` | 30000 | `src/main/services/compactionService.ts` |
| `SUMMARY_MAX_CHARS` | 4000 | `src/main/services/compactionService.ts` |

These are compile-time constants, not user-configurable settings.

---

## Related Patterns

### Context Accumulation

`dispatchAgentEvent` always accumulates events in `agentTurnRegistry` for all turns, not just renderer turns. This ensures background services (automations, headless CLI) also have accumulated messages available for compaction summaries.

### Depth Marker in Prompt

The `[COMPACTION_DEPTH:N]` marker is parsed by `parseCompactionDepth()` to track retry attempts:

```typescript
const depthMatch = prompt.match(/\[COMPACTION_DEPTH:(\d+)\]/);
return depthMatch ? parseInt(depthMatch[1], 10) : 0;
```

This allows the system to calculate `nextDepth = currentDepth + recoveryAttempts + 1` correctly even if the original prompt already contained a depth marker.

---

## Future Improvements

1. **Preserve per-turn metrics during compaction**: Roll up token/model info before clearing `eventsByTurn`
2. **Smarter tool selection**: Use tool correlation with overflow rather than just size
3. **User-initiated compaction**: Allow users to manually trigger compaction before overflow
