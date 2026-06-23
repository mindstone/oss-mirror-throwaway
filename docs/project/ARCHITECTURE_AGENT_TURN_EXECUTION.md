---
description: "Main-process turn runner: lifecycle, prompt assembly, model routing, MCP resolution, pre-turn context worker"
last_updated: "2026-06-20"
---

# Agent Turn Execution Architecture

### Introduction

This document describes the main-process orchestration of agent turns in Mindstone Rebel. It covers the turn lifecycle, preconditions, prompt assembly, model routing, tool safety integration, and event emission. This is the "orchestration hub" that coordinates multiple domain-specific systems during each agent turn.

### See also

- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) — High-level system architecture, component responsibilities, and data flows
- [REBEL_CORE.md](REBEL_CORE.md) — Rebel Core agent runtime: architecture, design decisions, and code signposting
- [CLAUDE_AGENT_SDK_REFERENCE](../research/libraries/CLAUDE_AGENT_SDK_REFERENCE.md) — Archived reference for the removed Claude Agent SDK (historical)
- [SYSTEM_PROMPT.md](SYSTEM_PROMPT.md) — How the composite system prompt is constructed (platform + user instructions + runtime context)
- [TOOL_SAFETY.md](TOOL_SAFETY.md) — LLM-based tool safety evaluation, security levels, and approval flow
- [MEMORY_SAFETY.md](MEMORY_SAFETY.md) — Memory write safety: approval flow for file writes to memory spaces
- [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) — MCP and Super-MCP configuration, discovery, HTTP vs stdio mode
- [COST_TRACKING.md](COST_TRACKING.md) — API usage cost tracking and aggregation
- [ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md](ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md) — Session model, history persistence, and context-resume behavior
- [ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md](ARCHITECTURE_RENDERER_STATE_MANAGEMENT.md) — Renderer state architecture and data flow patterns
- [ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK.md](ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK.md) — 1M context window (always-on when enabled) and OAuth→API key fallback for rate limits
- `src/main/services/agentTurnExecutor.ts` — Core execution orchestrator (~2,735 lines; see Module Structure below)
- `src/main/services/agentQueryRunner.ts` — Unified agent query iteration loop (replaces 8 duplicated for-await loops)
- `src/main/services/turnErrorRecovery.ts` — 10 named error recovery handlers + dispatcher (extracted from catch block)
- `src/main/services/agentTurnCleanup.ts` — Turn lifecycle cleanup, resource teardown, cost ledger
- `src/core/services/conversationHistoryService.ts` — Session history reconstruction
- `src/main/services/recovery/desktopRecoveryAdapter.ts` — Context overflow recovery wrapper (compaction/retry)
- [ARCHITECTURE_CONVERSATION_CONTEXT_CONTINUITY.md](ARCHITECTURE_CONVERSATION_CONTEXT_CONTINUITY.md) — Context delivery paths and history injection
- `src/main/utils/agentTurnFormatters.ts` — Param hint + tool context formatters (pure functions)
- `src/main/utils/attachmentValidation.ts` — 7-type attachment validation and filtering
- `src/main/services/agentTurnRegistry.ts` — Turn state tracking
- `src/main/services/agentEventDispatcher.ts` — Event emission to renderer
- `src/main/services/agentMessageHandler.ts` — Agent message processing, tool hints, empty-result recovery
- `src/main/ipc/agentHandlers.ts` — IPC entry points for agent turns
- `src/main/services/mcpService.ts` — MCP resolution and system prompt assembly
- `src/main/services/preTurnWorkerService.ts` — Pre-turn utilityProcess worker
- `src/core/rebelCore/queryRouter.ts` — Runtime router (`queryWithRuntime`) — single entry point for all Rebel Core turns
- `src/core/rebelCore/modelClient.ts` — Provider-neutral `ModelClient` interface for Rebel Core model calls
- `src/core/rebelCore/clients/openaiClient.ts` — OpenAI-compatible `ModelClient` implementation (OpenAI, Together, Cerebras)
- `src/core/rebelCore/agentTool.ts` — Rebel Core sub-agent spawning tool (`Agent`)
- `src/core/services/capabilityResolutionService.ts` — MCP capability resolution and built-in tool suppression
- `src/shared/types.ts` — Core types (`AgentEvent`, `AgentTurnRequest`)


## Module Structure

The agent turn executor was decomposed from a single 5,549-line file into a set of focused modules (see `docs/plans/260329_agent_turn_executor_hardening.md` for the full hardening plan and rationale):

| Module | Location | Purpose |
|--------|----------|---------|
| **agentTurnExecutor.ts** | `src/main/services/` | Core orchestrator — turn lifecycle, model/MCP resolution, hook assembly (~2,735 lines) |
| **agentQueryRunner.ts** | `src/main/services/` | Single `runAgentQuery()` function with configurable error routing; replaces 8 duplicated `for-await` iteration loops |
| **turnErrorRecovery.ts** | `src/main/services/` | 10 named error recovery handlers + linear dispatcher; replaces 1,850-line catch block |
| **agentTurnCleanup.ts** | `src/main/services/` | `completeTurnCleanup()`, `finalizeTurnLogger()`, `makeSyntheticResult()`, and turn tracking state (council/ad-hoc/tier Sets and Maps) |
| **conversationHistoryService.ts** | `src/main/services/` | `buildConversationHistoryContext()`, `loadConversationHistory()` — session history reconstruction from disk |
| **priorTurnsReader.ts** | `src/core/services/` | Reads `transcripts/<sid>.jsonl`, applies compaction-aware filtering, returns `TranscriptTurnSummary[]`; ZWSP sentinel escaper for literal `<prior_turns>` substrings; `priorTurnsReaderFallback` event for null-session / missing transcript / parse errors |
| **buildPriorTurnsHeader.ts** | `src/core/services/` | Renders the `<prior_turns>...</prior_turns>` XML header block; 1,200-token (~4,800-char) cap; escaped tool outputs, deduped file/query strings, materialized-file pointers |
| **buildContinuationContext.ts** | `src/core/services/` | Canonical context-assembly for non-initial turns; discriminated-union mode (`proactive-main` / `continuation-accumulator` / `recovery`); emits unified `priorTurnsHeader` log event with `source` discriminator |
| **agentTurnFormatters.ts** | `src/main/utils/` | `extractParamHints()`, `formatSuggestedToolsContext()`, `formatFrequentToolsContext()`, `formatConnectedPackagesContext()` — pure formatting functions |
| **attachmentValidation.ts** | `src/main/utils/` | `validateAndFilterAttachments()` — validates and filters 7 attachment types (text, image, PDF, office, etc.) with count/size limits |

The orchestrator imports from all extracted modules. Error recovery handlers call `runAgentQuery()` for fallback loops and receive a `retryTurn` callback (not a direct import) for recursive retry paths, avoiding import cycles.

**Active decomposition work (R1 Stage 1, 260427_2247):** The `agentTurnExecutor.ts` orchestrator is being further decomposed via a typed-phase-pipeline scaffold in [`src/main/services/turnPipeline/`](https://github.com/mindstone/rebel-app/blob/main/src/main/services/turnPipeline/). This in-flight work is breaking the monolithic execution path into discrete, testable phases (`turnAdmission`, `turnCompletion`, `runPhase`, `cleanupTypes`) while preserving the same external contract. See the sequencing plan for scope and intent.


## Turn Lifecycle Overview

Agent turns flow through these stages:

```
IPC Request (agent:turn)
    │
    ▼
agentHandlers.ts ─── Validates request, generates turnId
    │
    ▼
executeAgentTurn() ─── Core orchestration (agentTurnExecutor.ts)
    │
    ├── Early exits (missing auth, coreDirectory)
    │
    ▼
Pre-Turn Context Assembly (new conversations only)
    ├── utilityProcess worker (non-blocking, preferred)
    │   ├── Semantic search (HyDE + embeddings)
    │   └── Tool index search (suggested tools)
    ├── Main-process fallback (if worker unavailable)
    └── Router evaluation (direct answer vs agent)
    │
    ▼
Prompt Assembly
    ├── Semantic context injection (<file_context>)
    ├── Suggested tools injection (<suggested-tools>)
    ├── Attachment processing
    ├── System prompt resolution
    │
    ▼
Model, MCP & Runtime Resolution
    ├── Model config (Claude vs local proxy)
    ├── Extended context handling
    ├── MCP servers (Super-MCP or direct)
    ├── MCP capability resolution (optional built-in suppression)
    ├── Runtime routing (Rebel Core entrypoint (`queryWithRuntime()` → `rebelCoreQuery()`))
    │
    ▼
Runtime Query Execution
    ├── queryWithRuntime() router entrypoint
    ├── Rebel Core direct API loop
    ├── Message streaming loop
    ├── Tool safety hooks (PreToolUse)
    │
    ▼
Event Dispatch ─── dispatchAgentEvent() to renderer
    │
    ▼
Turn Cleanup ─── Registry cleanup, logger finalization
```


## Rebel Core Query Entry Point

`executeAgentTurn()` imports `queryWithRuntime()` as `query`, and `queryWithRuntime()` now delegates every agent turn directly to `rebelCoreQuery()`.

- **Single runtime:** Rebel Core is the sole turn runtime; the SDK path and rebelCoreEnabled routing gate have been removed.
- **Provider selection:** Rebel Core instantiates the appropriate `ModelClient` for the resolved provider/model.
- **Non-turn callers:** Compaction, behind-the-scenes (BTS) calls, warmup, and similar lightweight utilities use `callWithModelAuthAware()` in `behindTheScenesClient.ts`, which provides auth-aware routing (API key vs OAuth) and model resolution via `resolveBtsModel()`. These calls still use the Anthropic SDK client directly (not the Rebel Core agent loop), but route through provider-aware model resolution that supports profile-based model selection per BTS category.


## Provider-Neutral ModelClient Layer

When routing through Rebel Core, model calls go through a **provider-neutral `ModelClient` interface** rather than being hard-coded to Anthropic's API. This abstraction enables Rebel Core to call any LLM provider (Anthropic, OpenAI, Together, Cerebras, or any OpenAI-compatible endpoint) using a single code path.

### ModelClient Interface (`src/core/rebelCore/modelClient.ts`)

Defines the contract all provider clients must implement:

- **`create(params)`** — Non-streaming completion (used for simple single-shot calls).
- **`stream(params, onEvent)`** — Streaming completion with `text_delta` and `thinking_delta` events.
- Both accept provider-agnostic `StreamParams` / `CreateParams` (model name, system prompt, messages, tools, thinking config, abort signal, retry callback).
- Returns provider-agnostic `StreamResult` / `CreateResult` (content blocks, stop reason, token usage).

### Tool-Result Image Content

Tool-result images are now part of the model-facing context path.

- When a tool returns `ToolExecutionResult.imageContent`, Rebel Core forwards those image blocks into the next model request's `tool_result` content (not just the UI event stream).
- This is a deliberate reversal of the prior strip policy; rationale and rollout details live in `docs/plans/260429_chief_designer_visual_verification_loop.md` (Stage 2.5).
- Provider translators are responsible for wire-shape conversion:
  - Anthropic messages map internal image blocks to `{ type: 'image', source: { type: 'base64', media_type, data } }`.
  - OpenAI-compatible messages map image blocks to `image_url` content parts.
- When `capabilities.supportsImageContent(model)` is false (per-request model — provider term AND per-model catalog term, e.g. deepseek), images are not silently dropped. The loop replaces each image with explicit text placeholders (including saved path when available) and emits a structured warning log.

### OpenAI-Compatible Client (`src/core/rebelCore/clients/openaiClient.ts`)

The primary non-Anthropic client. Handles OpenAI, Together, Cerebras, and any OpenAI-compatible API:

- Translates neutral message/tool formats to OpenAI's Chat Completions or Responses API shape.
- Automatically selects the Responses API route when the request has tools + reasoning effort (required by OpenAI for reasoning models with tool use).
- Built-in retry with exponential backoff for transient errors (rate limits, server errors).
- Streaming via SSE parsing for both Chat Completions and Responses API formats.

### Provider-Aware Routing (`src/core/rebelCore/queryRouter.ts`)

`queryWithRuntime()` is the single entry point for all agent turns. All turns route through `queryWithRuntime()` → `rebelCoreQuery()`. There is no fallback to an external runtime.

- **Provider selection** — Rebel Core instantiates the appropriate `ModelClient` based on the resolved model/provider.
- **Proxy config** — When `ANTHROPIC_BASE_URL` is set (local model proxy), the router extracts it as explicit config for the ModelClient.

The router is imported only by `agentTurnExecutor.ts`. Other callers (compaction, behind-the-scenes, warmup) use the Anthropic SDK client via `callWithModelAuthAware()` in `behindTheScenesClient.ts` for simple single-shot calls. These go through auth-aware routing and `resolveBtsModel()` for provider-aware model selection, but bypass the full Rebel Core agent loop.

### Fallback resolution (`src/shared/utils/getDefaultModelForProvider.ts`)

When a settings field that names a model is silent (empty / undefined / not yet user-configured), every production call site MUST resolve the default through `getDefaultModelForProvider(settings, role)` rather than reaching for a hardcoded `'claude-sonnet-4-6'` literal or a `?? DEFAULT_MODEL` import.

- **Why a dedicated resolver** — Before April 2026 the agent loop, synthesis paths, the automation scheduler v26→v27 migration, and renderer-adjacent shims each fell back to `?? DEFAULT_MODEL` (Anthropic Sonnet). On non-Anthropic auths (OpenRouter, Codex) this silently routed Sonnet to the wrong provider, inflated per-token spend (OR `gpt-5.5` is 1.82× Sonnet/token; Codex `gpt-5.5` is 1.72× Sonnet/token), and produced the "OpenRouter Sonnet bypass" cost regression. The remediation plan is `docs/plans/260514_openrouter_sonnet_bypass_remediation.md`.

- **`ProviderModelDefaults` shape** — `getProviderModelDefaults(settings)` returns a discriminated union keyed on `provider: 'anthropic' | 'openrouter' | 'codex'` with three roles: `working`, `thinking`, `background`. The Anthropic constants live in `src/shared/utils/providerDefaultConstants.ts`; the OpenRouter/Codex constants live next to them so the helper has a leaf-module dependency path (no circular import with the model normalisation layer). The discriminated `switch` in the helper uses `assertNever` in the `default` arm so adding a fourth provider literal is a compile-time error in every consuming switch.

- **Defensive fallback** — When `activeProvider` is `undefined` (pre-normalisation boundary call) or an unknown literal (forward-compat), the helper coerces to Anthropic Sonnet defaults. This is intentional and tested; see plan-doc Failure Mode Matrix #12 and the unit-test contract in `src/shared/utils/__tests__/getDefaultModelForProvider.test.ts`.

- **Telemetry breadcrumb** — When the helper has to coerce, or when a settings/migration site decides the default differs from the previously-saved model, the call site emits a structured fallback-reason breadcrumb via `emitSettingsFallbackTelemetry` / `emitTurnFallbackTelemetry` (`src/shared/utils/emitFallbackTelemetry.ts`). The breadcrumb is a two-variant discriminated union: turn-side calls carry the four join keys (`turnId`, `sessionId`, `auth`, `resolvedAuthLabel`); settings-side calls carry a `bootPhase` discriminator (one of `boot`, `save`, or `migration`) instead. Cost-tracking dashboards aggregate by these tuples — see `src/shared/types/fallbackTelemetry.ts` for the field-shape contract.

- **ESLint guard** — `eslint-rules/no-default-model-literal.js` is scoped to `src/main/services/**` + `src/shared/utils/**` and forbids `?? DEFAULT_MODEL` / `?? 'claude-sonnet-4-6'` patterns (plus the equivalent `||`, `return`, ternary forms). The rule's own three-file allowlist exempts (i) `openRouterModels.ts` (BYOK Anthropic alias catalog), (ii) `promptCacheWarmupService.ts` (Anthropic-only preflight), and (iii) `useCaseGeneratorService.ts` (Anthropic-pinned planning). The allowlist contents are pinned by `eslint-rules/__tests__/no-default-model-literal.test.js` — any drift (removal, fourth entry without a documented precondition + plan-link, missing precondition text) fails the regression test. For genuine Anthropic-only paths outside the allowlist (e.g. `councilService.ts`'s `if (activeProvider === 'anthropic') { … }` branch), use a per-line `// eslint-disable-next-line rebel-provider-defaults/no-default-model-literal -- <reason citing the gate>` comment.

- **Boundary registry** — `provider-routing-class-central-resolver` in `docs/project/boundary-registry.yaml` lists `getDefaultModelForProvider`, `getProviderModelDefaults`, and the `ANTHROPIC_DEFAULT_*` constants as the canonical resolver identifiers. Any plan or diff touching these files triggers the Spec Reader protocol (see `CHIEF_ENGINEER2/CHIEF_ENGINEER2.md` § 6.4 BOUNDARY_CHECKLIST.md).


## Turn State Management

### Turn Registry (`agentTurnRegistry.ts`)

The `agentTurnRegistry` singleton manages all per-turn state:

| State | Purpose |
|-------|---------|
| `turnLoggers` | Per-turn structured logger for debugging |
| `rendererSessionByTurn` | Maps turnId → rendererSessionId |
| `activeTurnControllers` | AbortController per turn for cancellation |
| `turnPrompts` | Original prompt for context overflow recovery |
| `turnContextAccumulators` | Accumulated messages for graceful degradation |
| `contextOverflowDispatchedForTurn` | Deduplication for overflow events |
| `securityDenialsByTurn` | Tool safety denials (for headless/automation) |
| `turnModels` | Model used (captured from system.init) |
| `turnRetryCounts` | Retry count for transient network errors |
| `turnPrivateModes` | Private mode flag per turn |

### Session ID Mapping

Two IDs are involved in session continuity:

1. **turnId** — Unique per turn, generated in `agentHandlers.ts`
2. **rendererSessionId** — Conversation session from the UI

The registry maintains the mapping:
- On new turn: `rendererSessionByTurn[turnId] = rendererSessionId`

Context continuity is maintained via disk-based history injection — there is no server-side session resume.

### Abort Controllers

Each turn gets an `AbortController` for cancellation:
- Set via `setActiveTurnController(turnId, controller)`
- Signal passed to SDK query options
- `agent:stop-turn` IPC aborts via `controller.abort()`
- `abortAllTurns()` called during app shutdown

### Sub-agent Concurrency Cap

Parallel intent is planner-authored: steps that share a `parallel_group` value (and do not declare intra-group dependencies) are grouped by `derivePlanParallelGroups()` before execution. At the Agent fan-out site in `src/core/rebelCore/agentLoop.ts`, grouped sub-agent calls run through `runWithLimit(PARALLEL_AGENT_CAP)`, where `PARALLEL_AGENT_CAP = 4` in `src/core/rebelCore/constants/limits.ts`, so a single turn cannot exceed four concurrent sub-agent dispatches.
The cap is per `runAgentLoop` instance. Sub-agents at depth 1 carry the `Agent` tool (gated by `depth < 2` in `src/core/rebelCore/agentTool.ts`); depth-2 sub-agents do not. This hard-bounds recursive concurrency at `PARALLEL_AGENT_CAP × PARALLEL_AGENT_CAP = 16` total in-flight at the leaf level. Planner-derived `parallel_group` fan-out is top-level only — `executeAgentTool` calls `runAgentLoop` directly without invoking `runPlanningPhase`, so `parallel_group` hints never reach depth-1+ contexts. Depth-2 fan-out can therefore arise only from a depth-1 worker LLM emitting multiple `Agent` tool_uses in one assistant message — a model-discretion event, not a planner-emitted plan.

Execution is observable via three machine status events: `parallel:subagents:start` (banner shown), `parallel:subagents:progress` (parsed but intentionally non-rendering to avoid mid-flight flicker), and `parallel:subagents:complete` (final summary banner). All three are parsed by `src/core/rebelCore/parallelSubagentsStatus.ts`; cloud/mobile banner translation uses `src/core/services/agentTurnReducer/live.ts`, and desktop uses the same parser/formatter in `src/renderer/features/agent-session/utils/turnStepContext.ts`, keeping parity without cloud-service-specific adapters. See [260503_parallel_plan_execution.md](../plans/260503_parallel_plan_execution.md).

### Per-Tool-Call Fault Isolation

In the parallel tool-execution batch in `runAgentLoop` (`src/core/rebelCore/agentLoop.ts`), each non-sub-agent `executeToolUse(toolUse, index)` carries its own `.catch` (commit `8ec337fe3`), mirroring the already-settled semantics of the sub-agent path (`runWithLimit`). Before this, a single tool-call rejection rejected the whole `Promise.all` batch, which re-threw at the turn catch and surfaced as an unhandled rejection in the detached run chain — taking down sibling tool calls (and the eval worker). Now a non-abort tool failure is folded into a recoverable error `tool_result` so the turn continues. Two invariants are preserved by construction and asserted inline:

- **Invariant 1 (abort teardown):** a genuine abort/cancel/timeout (`isAbortOrTimeoutError(error) || config.signal?.aborted`) is **re-thrown unchanged**, so turn-level teardown is identical to before — only non-abort errors are folded.
- **Invariant 2 (`tool_use`↔`tool_result` pairing):** every `tool_use` always gets exactly one `tool_result` (the error branch populates `toolResultsByIndex[index]`), satisfying the unresolved-tool-use check.

The fix has a regression test proven to fail without it (`src/core/rebelCore/__tests__/agentLoop.concurrency.test.ts`).


## Preconditions and Early Exits

`executeAgentTurn()` validates preconditions before SDK invocation:

### Missing Core Directory

```typescript
if (!settings.coreDirectory) {
  dispatchAgentEvent(win, turnId, { type: 'error', error: 'Core directory is not configured.' });
  finalizeTurnLogger(turnId, 'missing-core-directory');
  return;
}
```

### Authentication Required

```typescript
if (!hasValidAuth(settings)) {
  dispatchAgentEvent(win, turnId, { type: 'error', error: 'Claude authentication is missing.' });
  finalizeTurnLogger(turnId, 'missing-auth');
  return;
}
```

`hasValidAuth()` checks for either:
- `claude.apiKey` (direct API)
- `claudeMaxToken` (Claude Max subscription)

> **1M context + Claude Max**: Most Max subscriptions don't support the 1M beta. OAuth users can opt in, but if 1M fails, it's remembered for the conversation (session memory) so subsequent turns skip the retry. See [`ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK.md`](ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK.md#claude-max--1m-context-session-level-fallback-memory) for details.


## Pre-Turn Worker Architecture

For new conversations, expensive pre-turn operations run in a **utilityProcess worker** to keep the main Electron process responsive during:
- HyDE API calls (hypothetical document generation)
- Semantic search (embedding + LanceDB queries)
- Tool index search (suggested tools matching)

### Worker Lifecycle

The worker (`preTurnWorkerService.ts`) is spawned once on first use and kept alive for subsequent requests:

```
Main Process                    utilityProcess Worker
     │                                    │
     ├── assemblePreTurnContext() ──────► │
     │                                    ├── HyDE generation
     │                                    ├── Embedding + LanceDB
     │                                    ├── Tool index search
     │ ◄──────── PreTurnResult ───────────┤
     │                                    │
```

**Crash supervision**: Worker restarts automatically on crash (up to 3 times), then falls back to main-process implementation permanently.

**Workspace binding**: Each workspace gets its own worker. Switching workspaces disposes the old worker and spawns a new one.

See: `src/main/services/preTurnWorkerService.ts`

### Continuation Turn Optimization

**Continuation turns skip pre-turn work** (semantic search) when `resetConversation` is `false`:

Rationale:
1. Conversation context is already available from previous turns (via history injection)
2. Searching on a short follow-up message ("yes, do it") returns unrelated files
3. Router can't properly interpret follow-up messages without conversation history

### Fallback Strategy

If the worker is unavailable (disabled, crashed, or not initialized), the main process handles pre-turn work synchronously:

1. **Semantic context**: `enhancePromptWithSemanticContext()` runs in main process
2. **Tool search**: `searchTools()` runs in main process (with a **5-second timeout budget** via `Promise.race()` — if the search doesn't return in time, the turn proceeds without suggested tools)
3. **Both emit the same tool events** (`file_search`, `tool_search`) for UI consistency

#### Worker `toolSearchStatus` Field

The worker returns `toolSearchStatus: 'ok' | 'skipped' | 'unavailable'` alongside tool search results (mirroring the existing `conversationSearchStatus` pattern):

| Status | Meaning | Executor behavior |
|--------|---------|-------------------|
| `'ok'` | LanceDB query executed (even if zero results) | Skip main-process fallback |
| `'skipped'` | Smart query generation determined no tools needed (empty `tool_query`) | Skip main-process fallback |
| `'unavailable'` | Tool index not found, LanceDB error, or embedding missing | Run main-process fallback (with 5s timeout) |

The executor captures `workerToolSearchStatus` and only runs the main-process fallback when `workerToolSearchStatus === 'unavailable'`. This prevents unnecessary fallback searches when the worker intentionally skipped tool search (e.g., casual conversation where smart query generation returns empty `tool_query`).

**Intent signaling**: The `toolSearchIntentionallySkipped` flag is set explicitly by `preTurnWorkerService.ts` when `useSmartQueries && !queries.tool_query`. This explicit intent signaling prevents misclassifying embedding failures as intentional skips. See [planning doc](../plans/260402_tool_index_incremental_refresh.md) for design rationale.

### Pre-Turn Assembly Timeout & Ghost Session Pruning — Intent & Design Rationale

**Problem:** Conversation `148dd4bc` hung indefinitely because pre-turn context assembly stalled in a gap between per-phase timeouts (worker init 120s, RPC 30s, embeddings 8s each). No wrapping timeout existed, so the turn blocked forever. Separately, ghost session entries (summary in index but backing file missing) persisted across backfill runs, causing unnecessary disk I/O every startup.

**Approach:** A 60-second `Promise.race()` wraps the entire assembly pipeline (worker path + main-process fallback, before ABORT CHECKPOINT 2). On timeout, the turn proceeds without pre-turn context — identical to the existing double-failure fallback. An `assemblyTimedOut` flag gates all closure mutations (`assembledSemanticContext`, `contextSections`, `suggestedToolsCollected`, etc.) via `isAssemblyStillActive()` to prevent abandoned promises from writing stale data after the turn moves on. Ghost pruning in `backfillConversationEmbeddings()` calls `sessionFileExists()` (ENOENT-specific `fs.access` check) before pruning, distinguishing true ghosts from transiently unreadable files (locked, corrupt).

**Why Promise.race, not AbortController:** AbortController would cancel in-flight operations but requires threading the signal through every sub-operation (worker RPC, embedding API calls, LanceDB queries). Promise.race abandons them — acceptable because abandoned operations complete via their own timeouts and results are discarded. Avoids invasive changes; aligns with the future `preTurnContextAssembler.ts` extraction (plan `260329`).

**Why ENOENT-specific check for ghosts:** `getSession()` returns null for ANY read failure (missing file, locked file, parse error). Pruning on null alone would destroy sessions that are transiently unreadable. The explicit `fs.access()` + ENOENT catch confirms the file is truly gone before deletion.

**Rejected alternatives:** (A) Lowering individual phase timeouts — doesn't cover inter-phase gaps. (B) AbortController threading — too invasive for a safety-net timeout. (C) Periodic batch reconciliation for ghosts — risks subset-reconcile churn per postmortem `260330`. (D) Only removing ghosts from conversation index — leaves stale entries in `listSessions()`, causing repeated `getSession()` calls every backfill.

**Constraints for future agents:**
- `assemblyTimedOut` flag **must** gate all closure mutations after the `Promise.race` — removing this creates non-deterministic data races from abandoned promises.
- Ghost pruning **must** verify file is actually missing (ENOENT), not just unreadable — see `sessionFileExists()` in `incrementalSessionStore.ts`.
- Ghost pruning **must** stay scoped to individual `summary.id` after `getSession() === null` — never batch reconciliation (postmortem `260330`).
- The 60s timeout is a safety net, not the primary timeout — per-phase timeouts should fire first for their specific failures.
- `setupNodeEnvironment()` **must** run before the timeout scope (ordering constraint from `260206` parallelization plan).
- Conversation injection (post ABORT CHECKPOINT 2) is intentionally outside the timeout scope.

See: `docs/plans/260402_preturn_timeout_and_ghost_pruning.md` for full research, alternatives, and review history.

## Prompt Assembly Pipeline

Context sections are collected during pre-turn processing, then assembled into a single user message via `buildUserMessageContext()` (`agentTurnUtils.ts`). Each section is wrapped in XML tags, with the user's request last:

```xml
<meeting-context>...</meeting-context>       <!-- if meeting companion session -->
<relevant-conversations>...</relevant-conversations>  <!-- auto or @conversations -->
<suggested-tools>...</suggested-tools>       <!-- if new conversation -->
<relevant-files>...</relevant-files>         <!-- semantic search results -->
<user-request>User's actual message</user-request>
```

When no context sections are present, the user message is sent bare (no wrapping).

### Semantic Context Injection

Workspace files relevant to the user's prompt are collected into `contextSections.relevantFiles`:

**Worker-first approach** (preferred):
```typescript
if (workerResult.semanticContext) {
  contextSections.relevantFiles = workerResult.semanticContext.formattedContext;
}
```

**Main-process fallback**:
```typescript
const { contextAdded, formattedContext } = await enhancePromptWithSemanticContext(prompt, { ... });
if (contextAdded && formattedContext) contextSections.relevantFiles = formattedContext;
```

Behavior varies by prompt content:
- `@files` keyword: 15 files, 0.30 threshold (explicit broad search)
- Action intent detected: 10 files, 0.30 threshold (automatic)
- Default: 5 files, 0.55 threshold (conservative)

### Suggested Tools Injection

Tools matching the user's intent are collected into `contextSections.suggestedTools`:

```
Potentially relevant tools for this request (not an exclusive list). Use if helpful; call get_tool_details for schemas before first use.
- `gmail/send_email` (work@example.com) - Send an email message
- `linear/create_issue` - Create a new Linear issue
```

This helps the model discover relevant tools without needing to enumerate all available tools. The agent can discover full schemas via MCP `get_tool_details()` if needed. A `suggestedToolsCollected` boolean flag prevents duplicate injection between worker and fallback paths.

**Server account hints**: Multi-account servers (e.g., Gmail with multiple accounts) include account labels for disambiguation.

### Attachment Processing

Attachments are separated by type and validated:

| Type | Max Count | Max Size | Processing |
|------|-----------|----------|------------|
| Text (workspace) | 20 | 120KB chars | Appended to prompt |
| Images | 10 | 5MB | API content blocks |
| PDFs (native) | 5 | 32MB | API content blocks |
| PDFs (extracted) | 5 | 500KB text | Appended to prompt |
| Office (Word/Excel) | 5 | 500KB text | Appended to prompt |
| Text files (uploaded) | 20 | 500KB | Appended to prompt |

For media attachments (images, native PDFs), the SDK requires an async generator:
```typescript
const promptOrGenerator = hasMedia
  ? createUserMessageGenerator(effectivePrompt, textAttachments, imageAttachments, documentAttachments)
  : promptWithAttachments;
```

### System Prompt Resolution

See [SYSTEM_PROMPT.md](SYSTEM_PROMPT.md) for full details.

`resolveSystemPrompt()` builds the composite prompt:
1. Platform instructions (`rebel-system/AGENTS.md`)
2. User instructions (`Chief-of-Staff/README.md`)
3. Dynamic environment block (`<env>`)

Also builds connected packages context for tool awareness.


## Model Routing

### Model Config Resolution

```typescript
const modelConfig = resolveModelConfig(
  settings.claude.model,
  settings.claude.thinkingModel ?? null,
  extendedContextEnabled
);
```

Returns:
- `model`: Canonical model name
- `envOverrides`: Environment variables for SDK

### Extended Context

When enabled, extended context uses 1M token window:
```typescript
customHeaders = 'anthropic-beta: context-1m-2025-08-07';
```

If 1M context fails (subscription limit), automatically retries with standard 200K:
```typescript
if (isExtendedContextUnavailableError(error)) {
  modelConfig = stripExtendedContextFromConfig(modelConfig);
  // Retry with standard context
}
```

### Local Model Proxy

When a local model profile is active:
```typescript
if (settings.localModel?.activeProfileId && getProxyServerUrl()) {
  env.ANTHROPIC_BASE_URL = getProxyServerUrl();
}
```

The proxy translates Anthropic API calls to OpenAI-compatible endpoints.

For multi-model fan-out paths (Council mode, ad-hoc model dispatch, and always-on pre-registration), the same proxy infrastructure runs with turn-scoped routing headers (`x-council-turn-id`) so concurrent turns can route to different upstream models safely.

### Always-On Pre-Registration of Model Profiles

Smart-picking model profiles (`routingEligible: true` and `enabled !== false`) are **always pre-registered** as dispatchable subagents on every turn — not just when council mode (`//council`) is active or the user @-mentions them. This enables orchestrating workflows (like the Showrunner) to see and dispatch to non-Anthropic models (GPT-5.5, Gemini, etc.) without requiring explicit user triggers.

The pre-registration merges with any ad-hoc @-mentioned profiles into a **unified pipeline** — one `buildAdHocAgentConfig()` call and one `addRoutes()` call per turn — to avoid route-overwrite issues. When pre-registered profiles exist, an `<available_models>` metadata section is injected into the system prompt at turn time, listing each profile's provider family, cost tier, context window (if ≥500K), and `subagent_type` name for dispatch.

Key design decisions:
- **Scope**: Only `routingEligible` profiles are pre-registered (not all profiles). The Smart-picking pool is the user-approved set for both per-step model selection and sub-agent delegation; profiles outside it are for explicit @-mention or council fan-out only.
- **`enabled` field**: `ModelProfile.enabled` (default `true` when absent) gates dispatch visibility. `enabled: false` excludes profiles from pre-registration, council fan-out, ad-hoc detection, and `<available_models>`.
- **Three distinct concepts** (each with its own membership chip in Settings → Models): `routingEligible` (Smart-picking pool — drives per-step model choice **and** always-on sub-agent pre-registration), `councilEnabled` (council membership — participates in `//council` parallel fan-out only), and council-active-for-turn (`//council` activated for this specific message).

See `docs/plans/260331_always_register_model_profiles.md` for the original always-on design (which gated pre-registration on `councilEnabled`); the gate was later retied to `routingEligible` so it matches the Smart-picking chip's stated UI semantics and stops conflating "available as sub-agent" with "participates in council fan-out". Implementation: `getPreRegistrableProfiles()` and `buildAvailableModelsPrompt()` in `councilService.ts`, unified pipeline in `agentTurnExecutor.ts`.


## MCP Resolution and Tool Context

### MCP Server Resolution

```typescript
const mcpResult = await resolveMcpServers(settings);
// Returns: { servers, mode, upstreamCount, configPath }
```

Modes:
- `super-mcp`: HTTP-based router (preferred, concurrent-safe)
- `direct`: Each MCP server attached directly (debug/escape hatch)
- `none`: No MCP servers configured

See [MCP_ARCHITECTURE.md](MCP_ARCHITECTURE.md) for resolution rules.

### Skip MCP Option

Background tasks can skip MCP for built-in SDK tools only:
```typescript
if (turnOptions?.skipMcp) {
  mcpServers = undefined;
  mcpMode = 'skipped';
}
```

### Connected Packages Context

Tool packages are injected as context for subagents:
```typescript
const connectedPackages = await buildConnectedPackages();
// Injected via SubagentStart hook
```

### MCP Capability Resolution (Built-in Tool Suppression)

Before query execution, `resolveCapabilities(connectedPackages)` computes capability upgrades declared by connected MCP packages.

- Active capabilities can append prompt guidance (e.g., prefer MCP web search over built-in `WebSearch`).
- Capabilities compute `disallowedTools` (e.g., `['WebSearch']` when a `web-search` MCP provider is connected).
- **Suppression flow**: `capabilityResolutionService` → `queryOptionsBuilder.ts` maps `disallowedTools` to `TurnParams.suppressedBuiltins` (typed as `BuiltinToolName[]`) → `rebelCoreQuery.ts` filters both `allToolNames` (adapter manifest) and `allTools` (agent loop) against the suppressed set → subagents inherit suppression via `AgentToolContext.suppressedBuiltins` in `agentTool.ts`.
- Suppression is applied **only** when `mcpServers` is truthy and `disallowedTools` is non-empty; degraded/no-MCP turns keep built-ins to avoid capability gaps.
- **Key code paths**: `src/core/services/capabilityResolutionService.ts` (computes disallowed), `src/main/services/queryOptionsBuilder.ts` (maps to `suppressedBuiltins`), `src/core/rebelCore/rebelCoreQuery.ts` (filters tools), `src/core/rebelCore/agentTool.ts` (subagent propagation).


## Tool Safety Integration

### Safety Hooks

Tool safety is integrated via SDK's `PreToolUse` hook:

```typescript
hooks: {
  PreToolUse: [
    ...(toolSafetyHook ? [{ hooks: [toolSafetyHook] }] : []),
    ...(memoryWriteHook ? [{ hooks: [memoryWriteHook] }] : []),
    ...(userQuestionHook ? [{ hooks: [userQuestionHook] }] : []),
  ],
}
```

### AskUserQuestion Hook

The SDK's built-in `AskUserQuestion` tool is intercepted by a dedicated PreToolUse hook (`src/main/services/userQuestionHook.ts`) using the **deny-and-retry** pattern. When the agent calls AskUserQuestion:

1. Hook validates the payload, persists a pending question batch, dispatches a `user_question` AgentEvent to the renderer, and returns `{ continue: false }` (deny)
2. Turn ends cleanly; renderer shows an inline question card that can be choice-based, direct text-entry (`options: []`), or hybrid via option-level `requiresInput`
3. User answers and submits; answers flow back via IPC as a continuation message that starts a new turn

The tool is already in `SKIP_TOOL_NAMES` (bypasses safety evaluation) and `BUILTIN_TOOLS`. The hook only activates for renderer sessions (`rendererSessionId` check). See `docs/plans/260327_ask_user_questions.md` for full design rationale.

> **Cross-session routing invariant**: The `user_question` event carries an authoritative `sessionId` stamped by `userQuestionHook` at emission time (`src/shared/types/agent.ts`, `src/shared/ipc/schemas/agent.ts`). `userQuestionResponseHandler` rejects responses whose `request.sessionId` does not match the stored event's `sessionId`; the idempotency cache key is `${sessionId}:${turnId}:${batchId}`; renderer extractors filter cross-session events. When adding consumers or new submission paths, do not derive session identity from ambient renderer state (`currentSessionId` in `useAgentSessionEngine.ts` can lag due to `useDeferredValue`). See `docs-private/investigations/260424_user_question_cross_session_routing_leak.md` and `docs-private/postmortems/260424_user_question_cross_session_routing_leak_postmortem.md`.

> **Note**: The `turn_started` event broadcast gives the renderer a uniform signal for all turns regardless of who initiated them. AskUserQuestion continuations are **renderer-started** via `sendMessageToSession` (see `docs/plans/260414_user_question_renderer_started_continuation.md`) and use the same `turn_started` event — no special-case IPC response, `onContinuationStarted` callback, or `markBusyForSystemContinuation` safety net is required. See `docs/plans/260409_turn_started_event_broadcast.md` for the broadcast design.

### Safety Level Resolution

```typescript
const effectiveToolSafetyLevel = turnOptions?.privateMode
  ? 'cautious'
  : globalToolSafetyLevel;
```

Private mode forces `'cautious'` level (always ask before actions).

### Bypass Option

Background tasks can bypass tool safety if they have their own safety gate:
```typescript
if (turnOptions?.bypassToolSafety) {
  toolSafetyHook = undefined;
}
```

See [TOOL_SAFETY.md](TOOL_SAFETY.md) for the full approval flow.


## Event Emission to Renderer

### Event Types (`AgentEvent`)

| Type | Purpose | When Dispatched |
|------|---------|-----------------|
| `turn_started` | Turn lifecycle start signal | Immediately after `setRendererSession()`, before any model/MCP work |
| `status` | Lifecycle/progress messages | Throughout turn |
| `assistant` | Assistant content chunks | As SDK streams |
| `result` | Final result with usage | Turn completion |
| `tool` | Tool usage hints | On tool_use/tool_result |
| `error` | Terminal errors | On failure |
| `context_overflow` | Prompt too long | Context limit hit |

### Dispatch Flow

`executeAgentTurn()` emits a `turn_started` event immediately after `setRendererSession()`, inside the `if (rendererSessionId)` block. This is the **first event** for every renderer-bound turn, emitted before any model resolution, MCP work, or pre-turn context assembly. The renderer uses it to show the spinner/busy state for ALL turns generically. See `docs/plans/260409_turn_started_event_broadcast.md` for the full design.

```typescript
dispatchAgentEvent(win, turnId, {
  type: 'status',
  message: 'Starting agent turn...',
  timestamp: Date.now(),
});
```

`dispatchAgentEvent()` in `agentEventDispatcher.ts`:
1. Sends event via IPC to renderer (`win.webContents.send('agent:event', { turnId, event })`)
2. Accumulates events in context accumulator (for overflow recovery)
3. Notifies automation event listeners (for headless turns)

### Accumulation for Recovery

All events are accumulated in the registry:
```typescript
const updatedContext = updateConversationWithEvent(currentContext, turnId, event);
agentTurnRegistry.setContextAccumulator(turnId, updatedContext);
```

Used for:
- Context overflow recovery (generating compaction summaries)
- Graceful degradation on empty result anomaly


## Error Handling

Error recovery is implemented in `src/main/services/turnErrorRecovery.ts` as 10 named handler functions called by a linear dispatcher. Each handler takes a shared `ErrorRecoveryContext` and returns `{ handled: true }` if it fully resolved the error (dispatched events + cleanup), or `{ handled: false }` to pass through to the next handler. See [ERROR_CLASSIFICATION_AND_ROUTING.md](ERROR_CLASSIFICATION_AND_ROUTING.md) for the full error taxonomy and routing architecture.

The agent iteration loop (`src/main/services/agentQueryRunner.ts`) provides per-call-site error routing via `rethrowKinds` sets, so different fallback paths can control which errors bubble up to recovery handlers.

Allowlist-style boundaries in this pipeline (e.g. the set of functions permitted to humanize errors) must ship with a forcing function — a fixture, eval, or ingest check that surfaces new unhandled shapes before they reach users; an allowlist with no drift detector silently rots.

### Error Categories

| Category | Detection | User Message |
|----------|-----------|--------------|
| `context_overflow` | HTTP 413, prompt too long | Triggers compaction flow (see below) |
| `model_unavailable` | HTTP 404/403, "model not found" | Downgrades thinking model via `FALLBACK_PLANNING_MODEL` and retries |
| `attachment_size` | Request too large + hasMedia | "Attachment exceeds 32MB limit" |
| `stream_closed` | Race condition in MCP | Warning, continues |
| `process_exit` | CLI crashed | "Tool connection failed" |
| `schema_validation` | MCP tool invalid schema | "Connected tool has invalid configuration" |
| `empty_result_anomaly` | `result === ""` with `output_tokens > 0` | Recovers from accumulator or retries |
| Transient network | Various patterns | Silent retry (up to 3x) |

### Timeout Diagnostics

When `MessageTimeoutError` fires (no `AgentMessage` within 180s), handler 10 in `turnErrorRecovery.ts` runs `diagnoseTimeout()` from `src/core/services/timeoutDiagnosticsService.ts` to classify the cause (Anthropic outage, internet unreachable, or transient stall) and produce a scenario-specific error message. The `rawStreamTracker` closure in `agentTurnExecutor.ts` — which tracks last raw stream event type, timestamp, and count — enriches both watchdog logs and timeout error diagnostics. See [ERROR_CLASSIFICATION_AND_ROUTING.md § Timeout Diagnostics](ERROR_CLASSIFICATION_AND_ROUTING.md#timeout-diagnostics) and `docs/plans/260408_timeout_diagnostics_and_messaging.md`.

OpenAI-compatible streams also have a 5-minute stream-start guard (`STREAM_FIRST_CHUNK_TIMEOUT_MS`). Stalled Chat Completions, Responses API, Codex, and title streams compose an `AbortSignal` that fires if the first chunk never arrives; that abort is classified as a transient server error so the normal retry path runs instead of hanging indefinitely before any content. The guard is cleared as soon as the first chunk lands.

Mid-stream stalls (a dead SSE socket that delivers zero bytes after some chunks have already arrived) are caught by a separate **inter-chunk idle deadline** in `openaiClient.ts` (`STREAM_IDLE_TIMEOUT_MS = 90s`, applied in `readWithFinishDeadline` across all three read loops; commit `8ec337fe3` + `4d666d422`). Crucially, the idle deadline is **armed only after the first chunk has arrived** (`armIdleDeadline` / `firstChunkSeen`) — pre-first-chunk stalls remain the job of the 5-minute stream-start guard, never the 90s idle deadline. Before this, a dead OpenRouter socket blocked `reader.read()` until the multi-minute watchdog; now it fast-fails as a transient `server_error` so the existing `runWithRetry` re-issues. Healthy streams (chunks within 90s) and post-`finish_reason` behavior are byte-identical. Phase-scoping is locked by `clients/__tests__/openaiClient.streamDeadlines.test.ts`.

Raw provider stream events are classified through the typed `RuntimeActivityEvent` taxonomy in [`src/core/rebelCore/runtimeActivity.ts`](../../src/core/rebelCore/runtimeActivity.ts), then consumed by the watchdog gate in [`src/main/services/watchdogTracker.ts`](../../src/main/services/watchdogTracker.ts).

### Silent Retry for Transient Errors

Handled by `handleTransientAndProcessExitRetry()` in `turnErrorRecovery.ts`:

```typescript
if (isTransientError(errorMessage) && retryCount < MAX_SILENT_RETRIES) {
  const delayMs = 1000 * Math.pow(2, retryCount) + Math.random() * 500;
  await new Promise(resolve => setTimeout(resolve, delayMs));
  return executeAgentTurn(win, turnId, prompt, turnOptions);
}
```

### Empty Result Anomaly Recovery

The SDK may return an empty `result` field despite generating output tokens (known Anthropic API behavior). When detected, Rebel attempts to recover from accumulated content before retrying:

**Detection** (`agentMessageHandler.ts`):
```typescript
if (!resultText && message.usage?.output_tokens && message.usage.output_tokens > 0) {
  // Check accumulator for recoverable content
}
```

**Recovery strategy**:
1. Check if context accumulator has substantial assistant content (>100 chars)
2. If yes → use accumulated content as result (no retry needed)
3. If no → throw `empty_result_anomaly` for retry (treated as transient error)

**Safeguards**:
- Minimum 100-char threshold prevents recovering from preambles like "I'll help you with that"
- Falls back to existing retry logic if no substantial content accumulated
- Preserves usage stats from original SDK message for cost tracking

**Why this works**: Assistant messages are accumulated synchronously as they stream, so by the time the empty result arrives, all streamed content is already in the accumulator. This avoids expensive retries and duplicate tool execution.

See `docs/plans/finished/260118_empty_result_anomaly_recovery.md` for the full analysis and design decision.

### Model Unavailable Recovery

When a model returns 404/403 "model not found" (e.g., a thinking model isn't available):
1. `handleThinkingModelFallback()` in `turnErrorRecovery.ts` detects the error
2. `downgradeThinkingModelConfig()` downgrades the thinking model (e.g., Opus → Sonnet via `FALLBACK_PLANNING_MODEL`)
3. Retries the turn with the downgraded model configuration

In the Rebel Core path (`rebelCoreQuery.ts`), a separate 404 detection may force direct Anthropic routing when the proxy doesn't support the requested Claude model.

### `stop_reason` Field — Known Pitfall (Historical)

> **Note**: The Claude Agent SDK has been removed; these types are now locally defined in `agentRuntimeTypes.ts`. This section is preserved as historical reference for understanding the `stop_reason` field behavior.

> **WARNING**: Do not use `stop_reason === null` as a truncation signal. In the former `@anthropic-ai/claude-agent-sdk` v0.2.34, `stop_reason` was `null` on most or all result messages — it was the SDK's default value, not an error indicator. Using it for truncation detection caused 415 false-positive events across 213 sessions in 3 days, resulting in duplicate text in the chat UI.

**What happened (2026-03-10 to 2026-03-12):**

Commit `0ec48c000` introduced a check: `if (message.stop_reason === null) throw TRUNCATED_RESPONSE_RETRY`. The intent was to detect interrupted responses (network drops, server timeouts). In practice, every SDK result message had `stop_reason: null`, so every turn triggered "truncation" continuation — regenerating the same text and appending it to the original response.

**Current behavior** (`agentMessageHandler.ts`):

The `stop_reason` value is logged at `debug` level when it differs from `'end_turn'`, but no branching or retry logic depends on it. The continuation machinery (helper function, prompt constant, catch blocks, re-throw branches, error catalog entries, and tests) was fully removed. The implementation is preserved in git history if a future SDK version provides a meaningful `stop_reason`.

**If you need to detect real truncation in the future:**
- Do NOT rely on `stop_reason === null` — verify against the SDK version's actual behavior first
- Consider checking for `stop_reason === 'max_tokens'` (a real truncation signal, if the SDK starts populating it)
- Cross-reference `output_tokens` against the model's max output limit
- Test with real sessions — inspect JSONL files to confirm the field's actual values

See `docs/plans/finished/260312_truncation_continuation_tool_safety.md` (Phase 3) for the full investigation and evidence.


## Turn Cleanup

On completion (success, error, or abort):

```typescript
agentTurnRegistry.deleteRendererSession(turnId);
agentTurnRegistry.deleteTurnPrompt(turnId);
agentTurnRegistry.clearContextOverflowDispatched(turnId);
agentTurnRegistry.deleteRetryCount(turnId);
agentTurnRegistry.deleteTurnModel(turnId);
finalizeTurnLogger(turnId, reason);
agentTurnRegistry.deleteActiveTurnController(turnId);
```

The `cleanupTurn()` helper clears all state except security denials (cleared separately by caller).

### Terminal Telemetry

`completeTurnCleanup()` emits exactly one PII-safe terminal event per turn — `Agent Turn Terminal Observed` (`TURN_TERMINAL_EVENT`) — via the core `turnObservability` module (`src/core/services/turnObservability.ts`). It captures origin/provider/duration/terminalKind/retry-count/offline-detected fields (no prompt content). Observability-only and fail-open: it never blocks or alters turn teardown.


## IPC Entry Points

### `agent:turn`

Starts a new agent turn:
```typescript
registerHandler('agent:turn', async (event, request: AgentTurnRequest) => {
  const turnId = randomUUID();
  // ... validation
  queueMicrotask(() => {
    executeAgentTurn(win, turnId, prompt, options);
  });
  return { turnId };
});
```

Returns immediately with `turnId`; execution is async.

### `agent:stop-turn`

Stops an active turn:
```typescript
const controller = getActiveTurnController(turnId);
controller.abort();
```

### `agent:generate-summary`

Generates compaction summary for context overflow:
```typescript
const summary = await generateCompactionSummary(settings, agentMessages, largeToolNames);
```

### `agent:tool-safety-response`

Handles user approval/denial of tool operations:
```typescript
handleApprovalResponse(toolUseID, approved, allowForSession, input);
```


## Performance Considerations

### Concurrent Turns

The registry tracks active turn count via `getActiveTurnCount()`:
- Used for race condition detection logging
- HTTP mode (Super-MCP) handles concurrent turns safely

### Attachment Limits

Limits prevent context bloat:
- Max attachments per type
- Max size per attachment
- Oversized attachments are dropped with warning

### Semantic Context Caching

Embedding results are cached to avoid redundant API calls on similar queries.


## Appendix: Turn Options

Options passed to `executeAgentTurn()`:

| Option | Type | Purpose |
|--------|------|---------|
| `resetConversation` | boolean | Skip history injection (forces new conversation context) |
| `sessionId` | string | Renderer session ID for conversation continuity |
| `attachments` | AnyAttachmentPayload[] | Files to attach |
| `bypassToolSafety` | boolean | Skip safety evaluation (for background tasks) |
| `memoryWriteHook` | HookFunction | For memory update turns |
| `privateMode` | boolean | Force cautious safety levels |
| `skipMcp` | boolean | Use only built-in SDK tools |
| `modelOverride` | string | Override model for this turn only |
| `sessionType` | SessionType | Context awareness (interactive, automation, cli, mcp_server) |
| `voiceActive` | boolean | Whether voice input/output is active |
| `loadSessions` | () => AgentSession[] | Lazy loader for @conversations context injection |


## Continuation Callback Contract

**Rule: Renderer-visible continuations must be renderer-started.**

Continuations that affect user-visible conversation state (spinner, isBusy, message queue) must route through the renderer's message queue (`sendMessageToSession`) rather than calling `window.agentApi.turn()` directly. This eliminates the timing gap between approval and busy-state, which historically caused stall bugs (see `docs-private/postmortems/260414_user_question_continuation_stall_recurring_postmortem.md`).

### Async callback safety

All `sendContinuation` / `onSendContinuation` callbacks must be typed as:

```typescript
(sessionId: string, message: string, receiptText?: string) => Promise<void> | void
```

Callers must await the return value using `await Promise.resolve(callback(...))` inside a try/catch. This catches rejections from async callbacks that would otherwise become unhandled promise rejections when invoked from a void-typed parameter.

**Anti-pattern** (silent failure):

```typescript
// BAD: async rejection bypasses the try/catch
try {
  sendContinuation(sessionId, message);
} catch (err) { /* never reached for async errors */ }
```

**Correct pattern**:

```typescript
// GOOD: catches both sync throws and async rejections
try {
  await Promise.resolve(sendContinuation(sessionId, message));
} catch (err) {
  console.warn('Continuation failed:', err);
}
```

### Continuation patterns inventory

| Pattern | File | Route |
|---|---|---|
| User question answers | `useUserQuestions.ts` | Renderer-started via `sendMessageToSession` |
| Memory approvals (Inbox) | `usePendingApprovals.ts` → `saveMemoryApproval.ts` | Renderer-started via `onSendContinuation` |
| Tool approvals (Inbox) | `usePendingApprovals.ts` | Renderer-started via `onSendContinuation` |
| Automation approvals | `useAutomationApprovals.ts` | Callback when provided; direct IPC fallback. `automation-*` sessions suppress continuation entirely. |
