---
description: "Hub doc for Rebel's context management system — tiered compaction, prompt caching, tool output materialization, cost tracking, and cross-provider support"
last_updated: "2026-04-08"
---

# Context Management

How Mindstone Rebel manages LLM conversation context — keeping conversations within budget, preserving important information during compaction, tracking costs, and optimizing prompt cache hit rates.

---

## See Also

### Architecture & Design Docs

- [ARCHITECTURE_CONTEXT_OVERFLOW_RECOVERY](ARCHITECTURE_CONTEXT_OVERFLOW_RECOVERY.md) — Overflow detection, compaction summary generation, retry logic, circuit breaker. The canonical reference for what happens when context runs out.
- [ARCHITECTURE_CONVERSATION_CONTEXT_CONTINUITY](ARCHITECTURE_CONVERSATION_CONTEXT_CONTINUITY.md) — How context survives across turns, restarts, edits, fallbacks, and compaction. Explains `resetConversation` semantics and risky-resume detection.
- [PROMPT_CACHING](PROMPT_CACHING.md) — Prompt caching mechanics, cache-friendly patterns, TTL heuristics, and metrics.
- [COST_TRACKING](COST_TRACKING.md) — Persistent cost ledger, per-model pricing, UI aggregation, and compaction-aware cost categories.
- [ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK](ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK.md) — Extended context window support and OAuth-to-API-key fallback.
- [ARCHITECTURE_AGENT_TURN_EXECUTION](ARCHITECTURE_AGENT_TURN_EXECUTION.md) — Turn lifecycle, prompt assembly, model routing, event dispatch.
- [SYSTEM_PROMPT](SYSTEM_PROMPT.md) — How the composite system prompt is assembled (platform + user + environment).
- [SUPERMCP_OVERVIEW](SUPERMCP_OVERVIEW.md) — Tool output materialization to files (large outputs written to `.rebel/tool-outputs/` instead of kept inline).

### Planning & Research Docs

- `docs/plans/260405_cache_aware_context_management.md` — Main roadmap for cache-aware context management architecture. Includes research citations and threshold rationale.
- `docs/plans/260401_app_owned_context_management.md` — App-owned context continuity after sleep/restart (post-SDK).
- `docs/plans/260402_context_management_roadmap.md` — Adjacent roadmap for context management evolution.
- `docs/plans/260329_intelligent_context_compaction.md` — Intelligent compaction design (sliding window, BTS summarization).
- `docs/plans/260329_auto_materialization_large_tool_outputs.md` — Auto-materialization of large tool outputs design.
- `docs/plans/260326_rebel_core_prompt_caching.md` — Prompt caching implementation plan.
- `docs/research/260405_cache_aware_memory_management_analysis.md` — Deep analysis of cache-aware pruning economics.

### Postmortems

- `docs-private/postmortems/260331_cross_conversation_compaction_postmortem.md` — Cross-conversation compaction contamination.
- `docs-private/postmortems/260401_user_question_compaction_postmortem.md` — User question dropped during compaction.
- `docs-private/postmortems/260402_conversation_amnesia_sleep_restart_postmortem.md` — Context loss after sleep/restart.
- `docs-private/postmortems/260403_orphaned_tool_calls_openai_postmortem.md` — Orphaned tool calls after compaction on OpenAI-compatible backends.

### Code Entry Points

- `src/core/rebelCore/contextPolicy.ts` — **`decideCompaction()`** — pure policy function. Single source of truth for compaction thresholds and provider-aware decisions.
- `src/core/rebelCore/contextPruning.ts` — **`pruneOldToolPairs()`** — client-side removal of old tool_use/tool_result pairs for non-Anthropic providers.
- `src/core/rebelCore/contextStateUpdate.ts` — **`updateContextStateViaLLM()`** — LLM-based extraction of structured state from pruned messages before discarding them.
- `src/core/rebelCore/contextPreservation.ts` — **`PRESERVATION_CATEGORIES`** — shared 6-category schema for what must survive compaction (used by both native and BTS paths).
- `src/core/rebelCore/agentLoop.ts` — **`runAgentLoop()`** — agent loop with inline compaction, thinking block cleanup, overflow recovery, and between-turn hooks.
- `src/core/rebelCore/clientFactory.ts` — Client creation with `enableContextManagement` gating.
- `src/core/rebelCore/clients/anthropicClient.ts` — Anthropic-specific: `cache_control`, `context_management` block, `clear_tool_uses`, optional `compact_20260112`.
- `src/core/rebelCore/clients/openaiClient.ts` — OpenAI-compatible: no native context editing, 10-min implicit cache TTL.
- `src/core/rebelCore/modelLimits.ts` — Per-model context window and max output token resolution.
- `src/core/rebelCore/toolOutputCurator.ts` — LLM-based tool output curation (currently disabled).
- `src/core/services/compactionService.ts` — **`generateIntelligentSummary()`** / **`generateCompactionSummary()`** — sliding-window summarization with parallel BTS compressions.
- `src/core/services/conversationHistoryService.ts` — Rebuilds context from persisted sessions, respects compaction boundaries, front-truncates to 100K chars.
- `src/core/services/costLedgerService.ts` — Append-only JSONL cost ledger with per-model usage breakdown.
- `src/main/services/agentTurnExecutor.ts` — Turn orchestration, history injection, extended context tracking.
- `src/main/services/recovery/desktopRecoveryAdapter.ts` — Overflow recovery wrapper (summary generation, retry with tool limits).
- `src/main/services/agentMessageHandler.ts` — Token aggregation, context utilization calculation, cost ledger writes.
- `src/main/services/promptCacheWarmupService.ts` — JIT prompt cache warmup with 5-min TTL heuristic.
- `src/main/services/turnErrorRecovery.ts` — Multi-provider overflow error classification.
- `src/main/tracking.ts` — Tool output size tracking and `max_output_chars` limit suggestions.
- `src/renderer/features/agent-session/hooks/useAgentSessionEngine.ts` — Renderer-side compaction UX and retry orchestration.
- `src/renderer/features/agent-session/store/sessionStore.ts` — `performCompaction()`, compaction boundaries, LRU caching.

---

## Architecture Overview

Rebel manages context through six layers, each addressing a different facet of the problem:

```
Layer 1: Stable prompt construction + prompt caching
Layer 2: Provider-native context editing (Anthropic server-side)
Layer 3: In-loop pruning/truncation (thinking blocks, large tool outputs)
Layer 4: Structured compaction/summarization (BTS or native compact)
Layer 5: Tool output offloading/materialization (to files)
Layer 6: Observability — cost tracking + context utilization telemetry
```

### Decision Flow

Every between-turn decision flows through `decideCompaction()` in `contextPolicy.ts`:

```
Input: inputTokens, contextWindow, msSinceLastApiCall, config, capabilities
  │
  ├─ <75% utilization → no action
  │
  ├─ 75-90% → clear_tool_uses (Anthropic native) or client_prune_tool_pairs (others)
  │
  ├─ 90-95% → native_compact (if available) or BTS (cache-aware: deferred if warm, immediate if cold)
  │
  └─ ≥95% → native_compact (if available) or emergency BTS (immediate regardless of cache)
```

Cache warmth is a **tie-breaker** in the 90-95% tier, not the primary trigger. The system prefers to defer BTS compaction while the prompt cache is warm (saving the cache write investment) but will not defer past 95%.

### Provider Capabilities

Each provider declares capabilities that drive the policy:

| Provider | Native Context Editing | Native Compaction | Cache Strategy | Cache TTL Heuristic |
|----------|----------------------|------------------|---------------|-------------------|
| Anthropic (direct) | Yes (`clear_tool_uses`) | Reserved (off by default) | `ephemeral` | 5 min |
| OpenAI-compatible | No | No | `implicit` | 10 min |
| Others | No | No | `none` | 0 |

---

## Layer 1: Prompt Construction & Caching

**Goal:** Maximize prompt cache hit rate by keeping static content stable and upfront.

- System prompt is assembled as `TextBlock[]` with `cache_control: { type: 'ephemeral' }` on stable blocks.
- MCP tool descriptions are sorted alphabetically and frozen per session for cache stability (`mcpService.ts`).
- Sub-agent prompts split into stable + dynamic blocks (`agentTool.ts`).
- Environment context uses time buckets instead of exact timestamps.
- JIT cache warmup on composer focus when TTL likely expired (`promptCacheWarmupService.ts`).

**See:** [PROMPT_CACHING](PROMPT_CACHING.md) for full details.

---

## Layer 2: Provider-Native Context Editing (Anthropic)

**Goal:** Let the API server handle low-value context pruning where possible.

When `enableContextManagement` is true (default, unless `REBEL_DISABLE_CONTEXT_MANAGEMENT=1`):

- `clear_tool_uses_20250919` at **50%** of model context window — clears old tool_use/tool_result pairs server-side.
- `clear_tool_inputs: true` — clears tool input blocks alongside.
- `exclude_tools` — preserves `Read`, `rebel_search_files`, `Grep` (tools whose results are often referenced later).
- Optional `compact_20260112` at **75%** — server-side compaction with shared preservation instructions. Gated behind `experimental.compactEnabled` (default off).

Applied edits are logged via `context_management.applied_edits` in the API response.

**Not available** for non-Anthropic providers — they fall through to Layer 3.

---

## Layer 3: In-Loop Pruning & Truncation

**Goal:** Reduce context size cheaply without LLM calls.

Three mechanisms in `agentLoop.ts`:

1. **Thinking block removal** — `stripOldThinkingBlocks()` removes `thinking`/`redacted_thinking` blocks from all but the 2 most recent assistant turns. Runs every iteration.

2. **Large tool output truncation** — `compactMessageHistory()` replaces tool_result content >5,000 chars with `[Tool output truncated — N chars removed]` in messages older than the last 3 turns. Triggered proactively at **85%** utilization.

3. **Context warning** — At **70%** utilization, emits a `context:warning` event for UI indication.

On overflow, retries compaction up to **3 attempts** before throwing `ContextOverflowError` (which carries the already-compacted messages for fallback model retry).

---

## Layer 4: Structured Compaction & Summarization

**Goal:** When simple pruning isn't enough, use an LLM to summarize old context while preserving critical information.

### Preservation Schema

Six categories of information that must survive any form of compression (defined in `contextPreservation.ts`):

1. **Task Context** — goals, constraints, requirements
2. **Key Decisions** — choices, rationale, rejected alternatives
3. **Artifacts** — file paths, URLs, tool names, identifiers
4. **Constraints** — budget, deadlines, platform restrictions
5. **Progress State** — accomplished, remaining, blockers, failed approaches
6. **Recent Context** — most recent exchanges preserved in detail

### BTS (Behind-the-Scenes) Compaction

`compactionService.ts` provides two paths:

- **`generateIntelligentSummary()`** — Sliding window: keeps recent N turns verbatim (default 3, reduced to 1 at depth 2), compresses older messages >5K chars via parallel BTS calls (up to 5), then generates a cohesive summary.
- **`generateCompactionSummary()`** — Legacy full-summary fallback.

### Compaction Boundary

When compaction occurs, `sessionStore.ts` records a `CompactionBoundary` — a marker in the event stream that separates pre-compaction from post-compaction context. History rebuilding respects these boundaries.

### Context State Tracking

Before pruning old tool pairs, `contextStateUpdate.ts` extracts them and uses an LLM to update a structured `RebelCoreContextState` object. This state captures the important information from pruned messages in a structured format, preventing information loss during incremental pruning.

---

## Layer 5: Tool Output Materialization

**Goal:** Keep large tool outputs out of the prompt entirely.

Three strategies:

1. **Limit output before it arrives** — `max_output_chars` parameter. `tracking.ts` suggests limits during compaction retries (depth 1: top 2 tools at 50%, depth 2+: top 5 tools at 25%, minimum 10K chars).

2. **Materialize to files** — both **MCP tools** (via Super-MCP, see [SUPERMCP_OVERVIEW](SUPERMCP_OVERVIEW.md)) and the **built-in `Bash` tool** (via `src/core/utils/builtinToolMaterialization.ts`) write large outputs to `.rebel/tool-outputs/`. Agent gets a 2KB preview + file path, then uses `Read` (with `offset`/`limit`) or `Grep` against the file. Both code paths share the same threshold (`MATERIALIZATION_THRESHOLD_CHARS = 20_000`), the same atomic-write pattern (tmp + rename), the same 20MB size cap, and the same agent-readable directory. The system-prompt sub-block in `rebel-system/AGENTS.md` `[TOOL_USE]` (Large-data operating guidance) teaches agents the discipline: profile-before-dump, aggregate-over-raw, `Read`-with-offset on materialised paths. The kill-switch env var `REBEL_DISABLE_BASH_MATERIALIZATION=1` falls back to inline truncation if needed. See `docs/plans/260501_bash_materialisation_and_large_data_prompt_guidance.md` for design and `docs/plans/260329_auto_materialization_large_tool_outputs.md` for the original Super-MCP rollout.

3. **LLM-based curation** — `toolOutputCurator.ts` for intelligent summarization of 8K+ outputs. **Currently disabled** (`ENABLE_TOOL_OUTPUT_CURATION = false`).

---

## Layer 6: Cost Tracking & Observability

**Goal:** Know how much context costs and how efficiently it's being used.

### Token Tracking

`agentMessageHandler.ts` aggregates per-turn:
- `inputTokens`, `outputTokens`
- `cacheCreationTokens`, `cacheReadTokens`
- Per-model usage breakdown (for multi-model turns)
- Context utilization: `(input + cacheCreate + cacheRead) / contextWindow`

### Cost Ledger

`costLedgerService.ts` writes append-only JSONL entries with:
- USD cost, session/turn IDs, model, auth method
- Per-model usage map (`mu` field)
- Cache token counts
- Estimated-vs-exact flag

Categories defined in `costCategories.ts`: `conversations`, `automations`, `fileIntelligence`, `compaction`, `compaction-bts`, `warmup`, etc.

### Pricing

`src/shared/data/modelCatalog.ts` contains per-model pricing (input, output, cache-read, cache-creation per million tokens) for Anthropic, OpenAI, Google, DeepSeek, xAI, and Cerebras models.

**See:** [COST_TRACKING](COST_TRACKING.md) for the full cost tracking architecture.

---

## Configuration & Kill Switches

| Setting | Location | Default | Effect |
|---------|----------|---------|--------|
| `REBEL_DISABLE_CONTEXT_MANAGEMENT` | env var | unset (enabled) | Disables Anthropic `context_management` block entirely |
| `experimental.compactEnabled` | `AppSettings` | `false` | Enables Anthropic `compact_20260112` server-side compaction |
| `ENABLE_TOOL_OUTPUT_CURATION` | `toolOutputCurator.ts` | `false` | Enables LLM-based tool output curation |
| Compaction thresholds | `contextPolicy.ts` | 75/90/95% | Adjustable via `CompactionConfig` |
| `PRESERVE_LAST_N_TURNS` | `agentLoop.ts` | 3 | Turns preserved verbatim during truncation |
| `TOOL_OUTPUT_TRUNCATION_THRESHOLD` | `agentLoop.ts` | 5,000 chars | Tool outputs above this are truncated in older turns |
| `MAX_COMPACTION_ATTEMPTS` | `agentLoop.ts` | 3 | Overflow retry limit in the agent loop |
| `MAX_COMPACTION_DEPTH` | `compactionUtils.ts` | 2 | Orchestrator-level compaction retry limit |

---

## Key Design Decisions

1. **Cache warmth is a tie-breaker, not a gate.** The system never defers compaction past 95% utilization regardless of cache state. This prevents context overflow at the cost of occasionally discarding cached prefixes.

2. **Provider-aware, not provider-locked.** The policy engine (`contextPolicy.ts`) is a pure function that accepts capabilities as input. Adding a new provider means declaring its capabilities, not modifying policy logic.

3. **Shared preservation schema.** Both native Anthropic compaction and client-side BTS use the same 6-category preservation instructions (`contextPreservation.ts`), ensuring consistent information retention regardless of compaction path.

4. **Execution model for compaction.** BTS compaction calls use the execution model (not the planning model) to avoid Opus-tier costs in planning-mode sessions.

5. **Structured state tracking.** Rather than just discarding old context, `contextStateUpdate.ts` extracts structured state before pruning, preserving key information in a lightweight format.

6. **Tool output as a file problem.** Large outputs are increasingly materialized to files rather than kept in the prompt, converting a context budget problem into a filesystem problem.

---

## Known Limitations & Future Directions

- **Native compact is off by default** — `compact_20260112` is experimental; Anthropic API currently rejects it. Ready to enable when supported.
- **Tool output curation is disabled** — The LLM-based curation path exists but is turned off. May be enabled after further testing.
- **Cache TTL is heuristic** — Providers don't expose actual cache validity. Anthropic uses a 5-min heuristic, OpenAI 10-min. Actual TTL may differ.
- **No cross-turn token budget** — Current system reacts to per-turn utilization. There's no proactive budgeting across anticipated future turns.
- **Materialization thresholds still evolving** — Super-MCP materialization thresholds and watchdog diagnostics are under active refinement.
