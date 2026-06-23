---
description: "Rebel Core agent runtime — architecture, design decisions, and code signposting"
last_updated: "2026-06-20"
---

# Rebel Core

Rebel Core is Rebel's agent runtime for executing agent turns. It lives entirely in `src/core/rebelCore/` and is the sole runtime — all turns route through Rebel Core.


## See Also

- [MODEL_AND_PROVIDER_OVERVIEW](./MODEL_AND_PROVIDER_OVERVIEW.md) — hub for the model / provider / billing / thinking territory; [PROVIDER_RESOLUTION_AND_ROUTING](./PROVIDER_RESOLUTION_AND_ROUTING.md) maps the routing flow that lives in `rebelCore/` (queryRouter → clientFactory → ModelClient)
- [CLAUDE_AGENT_SDK_REFERENCE](../research/libraries/CLAUDE_AGENT_SDK_REFERENCE.md) — archived reference for the removed Claude Agent SDK (historical)
- [ARCHITECTURE_AGENT_TURN_EXECUTION](./ARCHITECTURE_AGENT_TURN_EXECUTION.md) — turn execution architecture
- [ARCHITECTURE_OVERVIEW](./ARCHITECTURE_OVERVIEW.md) — system-level architecture
- [MODEL_CONSTANTS](./MODEL_CONSTANTS.md) — model limit constants
- [SUPERMCP_OVERVIEW](./SUPERMCP_OVERVIEW.md) — Super-MCP HTTP transport used by Rebel Core's MCP client
- [PROMPT_CACHING](./PROMPT_CACHING.md) — prompt caching strategies (Rebel Core explicit cache control)
- Planning docs (chronological):
  - `docs/plans/260318_rebel_core_native_agent_runtime.md` — original intent and architecture
  - `docs/plans/260320_rebel_core_agent_loop_eval_harness.md` — eval harness for runtime comparison
  - `docs/plans/260324_rebelcore_model_independence.md` — first provider decoupling step
  - `docs/plans/260324_rebelcore_remove_artificial_token_caps.md` — settings-driven token limits
  - `docs/plans/260325_rebelcore_true_model_independence.md` — neutral types, OpenAI client, TurnParams
  - `docs/plans/260325_rebel_core_native_and_model_settings_revamp.md` — intended future as exclusive runtime
  - `docs/plans/260326_rebel_core_prompt_caching.md` — prompt caching for cost parity
  - `docs/plans/260326_rebel_core_super_mcp_streamable_http_fix.md` — Super-MCP StreamableHTTP fixes
- Tutorial: `docs/tutorials/260325_rebel_core_native_agent_runtime.html` — conceptual explainer (partially stale; trust code over tutorial)


## Intent and Motivations

Rebel Core was built to solve several problems with the former Claude Agent SDK dependency (removed April 2026):

1. **Performance**: The SDK spawns a `claude` CLI subprocess per query, adding ~200-500ms per turn.
2. **Reliability**: Subprocess model causes opaque failures (exit code 1, empty stderr, hook cleanup races). See the [SDK known bugs table](../research/libraries/CLAUDE_AGENT_SDK_REFERENCE.md#known-sdk-bugs).
3. **Coupling**: The SDK ties Rebel to Anthropic's closed-source CLI binary, making it impossible to support other model providers natively.
4. **Control**: An in-process runtime gives Rebel full control over the agent loop — retry behaviour, error UX, tool handling, task continuation, and prompt caching.

From the original planning conversation:
> "Could you give me a list of everything [the SDK] does that we would have to replace if we removed the Agent SDK?"
> "Can we do this in a way that sits behind a flag in settings atm, only for advanced users?"
> "This is going to be entirely in /rebelCore, not changing any other existing files and no interference possibility until we decide to flip the switch?"

Over time, Rebel Core became the strategic vehicle for:
- **True model independence** — supporting OpenAI, Gemini, local models, and any OpenAI-compatible endpoint
- **Settings-driven token limits** — removing hardcoded caps, letting model metadata and user settings drive limits
- **Prompt caching** — explicit cache control for cost optimization
- **Now the sole runtime** — the SDK path was fully removed (April 2026)


## Key Design Decisions

- **Single switch point**: All routing goes through `queryRouter.ts` — no branching at individual call sites.
- **SDK message compatibility**: Rebel Core emits SDK-compatible messages via `agentMessageAdapter.ts`, so all downstream systems (IPC, renderer, logging) work unchanged.
- **Anthropic-inspired neutral types**: `modelTypes.ts` defines Rebel Core's own internal wire format types. The naming (`tool_use`, `tool_result`, `input_schema`) is Anthropic-inspired because Rebel Core was originally Anthropic-only. Renaming was evaluated and explicitly rejected (40+ file blast radius, zero functional gain). Provider clients (`anthropicClient.ts`, `openaiTranslators.ts`) translate between these types and each provider's native API format.
- **Per-turn MCP sessions**: Reuses Super-MCP HTTP transport rather than rebuilding MCP server lifecycle. Each turn gets its own session via `mcpClient.ts`.
- **Task-board-first continuation**: Deterministic unfinished-task continuation happens before behavioural stop hooks.
- **Simple prompt caching**: Top-level `cache_control: { type: 'ephemeral' }` rather than complex breakpoint orchestration.
- **Prior-turns awareness**: On non-initial turns (especially `AskUserQuestion` continuations), the model receives a structured XML header (`<prior_turns>...</prior_turns>`) summarizing prior tool calls so it doesn't redo work. Three layers: (1) **Header layer** — `buildPriorTurnsHeader.ts` renders the header; `buildContinuationContext.ts` is the canonical injection entry point (proactive-main / continuation-accumulator / recovery modes). (2) **Tool layer** — `priorTurnsTools.ts` exposes `inspect_prior_turns` and `get_tool_call` for on-demand inspection; both are suppressed for sub-agents (F1). (3) **Read layer** — `priorTurnsReader.ts` reads `transcripts/<sid>.jsonl` with compaction-aware filtering and a ZWSP sentinel escaper. Feature is opt-in via `enablePriorTurnsHeader` (default `false`). See [`docs/plans/260525_cross_turn_awareness_layer1_layer2.md`](../plans/260525_cross_turn_awareness_layer1_layer2.md).


## Architecture

### Runtime Model

Every agent turn goes through `queryWithRuntime()` in `queryRouter.ts`, which delegates directly to `rebelCoreQuery()`. There is no branching — Rebel Core handles all turns.

`agentTurnExecutor.ts` builds a unified `TurnParams` object and passes it to Rebel Core. Rebel Core then selects the provider-specific `ModelClient` (Anthropic direct, Anthropic proxy, or OpenAI-compatible) while keeping downstream event handling SDK-compatible via `agentMessageAdapter.ts`. The router uses `hasValidAuth()` to check for any viable provider -- Anthropic API key, OAuth token, configured model profile with API key, or local model. Users with only an OpenAI key can use Rebel Core. **Limitation**: Google-only users require the proxy (for Gemini thought signatures), which still needs Anthropic auth.

### Component Map

```
agentTurnExecutor.ts
  └─ queryRouter.ts (queryWithRuntime)
       └─ rebelCoreQuery.ts (orchestrator)
                 ├─ clientFactory.ts → ModelClient
                 │    ├─ anthropicClient.ts (Anthropic direct)
                 │    └─ openaiClient.ts (OpenAI-compatible)
                 ├─ mcpClient.ts (Super-MCP HTTP session)
                 ├─ agentLoop.ts (model → tools → model loop)
                 ├─ agentTool.ts (sub-agent spawning + lightweight mode)
                 ├─ foragerPrompt.ts + foragerTypes.ts (built-in forager agent)
                 ├─ hookPipeline.ts (PreToolUse/PostToolUse/Stop hooks)
                 ├─ planningMode.ts (thinking-model planning pass)
                 ├─ taskState.ts + taskStatePersistence.ts (task board)
                 ├─ modelLimits.ts (context/output/thinking resolution)
                 └─ agentMessageAdapter.ts (→ SDK-compatible messages)
```

### Key Components

- **`queryRouter.ts`** — Single entry point (`queryWithRuntime`). Routes all turns directly to `rebelCoreQuery()`.
- **`rebelCoreQuery.ts`** — Main orchestrator. Creates the model client, opens MCP session, resolves model limits, optionally runs planning mode, builds hook-aware tool executor, runs the agent loop, saves task board.
- **`agentLoop.ts`** — The core model-tools-model loop. Calls `client.stream()`, processes tool use blocks, emits events, handles stop conditions.
- **`modelClient.ts`** — Provider-neutral interface defining `create()` and `stream()` methods. All provider clients implement this.
- **`clientFactory.ts`** — Chooses the right `ModelClient` implementation based on the resolved route. `createClientFromRoutePlan` switches on the `ProviderRouteDecision.transport` discriminant for compile-time provider routing safety (see [Model Independence](#model-independence)). Protected by an ESLint lint guard that prevents direct `AnthropicClient`/`OpenAIClient` construction outside `clientFactory.ts` and tests.
- **`clients/anthropicClient.ts`** — Direct Anthropic API client with retry/backoff and prompt caching.
- **`clients/openaiClient.ts`** — OpenAI-compatible client using `fetch()` + SSE parsing. Supports Chat Completions and Responses API.
- **`agentMessageAdapter.ts`** — Translates Rebel Core events into SDK-style messages so all downstream systems work unchanged.
- **`mcpClient.ts`** — Per-turn Super-MCP HTTP session using `StreamableHTTPClientTransport`.
- **`agentTool.ts`** — Native sub-agent tool with provider-aware alias resolution, subagent lifecycle hooks, lightweight mode for economy-tier agents, and dynamic agent discovery (`buildAgentToolDefinition`).
- **`hookPipeline.ts`** — Runs PreToolUse, PostToolUse, Stop, and Subagent hooks.
- **`modelLimits.ts`** — Resolves context window, max output tokens, and thinking config from model metadata + user settings.
- **`turnParams.ts`** — Rebel Core's boundary contract type, built by `agentTurnExecutor.ts`.
- **`modelTypes.ts`** — Provider-neutral message and content block types.
- **`planningMode.ts`** — Optional thinking-model planning pass before the main agent loop.
- **`taskState.ts`** / **`taskStatePersistence.ts`** — In-memory task board with deterministic auto-continue.

Provider stream events are mapped at the client boundary into a typed `RuntimeActivityEvent` discriminated union — see [`src/core/rebelCore/runtimeActivity.ts`](../../src/core/rebelCore/runtimeActivity.ts). The closed taxonomy + compile-time exhaustiveness force every new SDK event type to be classified explicitly (or fail to compile), structurally closing a regression class that produced three production Sentry storms in April 2026. The union has four kinds — `'token-delta'`, `'lifecycle'`, `'tool-event'`, `'unknown'` — and the watchdog's level-1 Sentry-capture gate (`shouldSuppressLevel1WatchdogCapture` in [`watchdogTracker.ts`](../../src/main/services/watchdogTracker.ts)) reads the typed event directly rather than parsing the raw event-type string. Three synthetic terminal `'lifecycle'` subkinds — `'cancelled'` (user-initiated stop), `'superseded'` (newer turn admitted via `signal.reason === 'superseded'`), and `'aborted'` (watchdog auto-abort) — are emitted at `agentTurnExecutor`'s stream-loop termination so that downstream telemetry sees a typed cancellation cause rather than the last upstream event before stall (S7, May 2026).

**Watchdog stuck-turn observability (260510_1739):** The watchdog layer was further hardened to preserve per-iteration routing metadata and watchdog-judge parse details even on stuck-turn events, improving diagnostic signal for the most opaque stall patterns. See [`docs/plans/260510_rebel_t4_fingerprint_disambiguation.md`](../plans/260510_rebel_t4_fingerprint_disambiguation.md) for the structuralKind fingerprint disambiguation work that enabled this.

**Turn pre-dispatch liveness + resource hardening (260619):** The window *before* model dispatch (auth/MCP/prompt resolution, provider routing) previously ran with no liveness guard, so a wedged setup could spin forever. A coarse deadline (`PRE_DISPATCH_SETUP_TIMEOUT_MS`, `src/core/services/turnPipeline/agentTurnExecute.ts`) now errors and routes to recovery via the `pre_turn_setup_timeout` cleanup reason — mapped by turn observability (`classifyTerminalKind`, `src/core/services/turnObservability.ts`) to the `pre_dispatch_setup_timeout` terminalKind — instead of silently spinning, with a `preDispatchGuardFired` stale-turn flag so a later-resolving await no-ops. Supporting resource hardening: the libuv thread-pool floor is set at boot (`computeThreadpoolSize`, `THREADPOOL_SIZE_FLOOR = 32`, `src/core/startup/threadpoolSize.ts`; applied via `applyThreadpoolSizeAtBoot` in `src/main/startup/applyThreadpoolSize.ts`) to reduce the known cloud-symlink starvation risk by keeping spare libuv workers available for agent turns; the open-files limit is raised at startup (`raiseFdLimit`, `src/main/startup/raiseFdLimit.ts`) to reduce EMFILE pressure; and a support-facing "all providers unreachable" verdict (`detectAllProvidersUnreachable`, `src/core/services/diagnostics/providerReachabilitySnapshot.ts`) feeds the diagnostic bundle (it only acts on fresh+definite probe evidence, else `inconclusive`; drives no user-facing copy or routing).

**IPC parity invariant**: `rawStreamLastEventType: string | null` (defined in `src/shared/ipc/schemas/agent.ts`, `src/shared/contracts/agentEventManifest.ts`, `src/shared/types/agent.ts`) continues to mirror `serializeRuntimeActivityForTelemetry(lastActivity)` verbatim — the typed migration adds new wire values (`'turn.cancelled'`, `'turn.aborted'`, `'turn.superseded'`) but preserves the field shape, so existing renderer telemetry consumers remain unaffected.

**Mapper-failure observability**: Each producer's `try { onStreamActivity?.(...) } catch` site captures via the shared `reportRuntimeActivityMapperFailure` helper in [`src/core/rebelCore/clients/runtimeActivityMapperReporter.ts`](../../src/core/rebelCore/clients/runtimeActivityMapperReporter.ts) with structured Sentry tags (`area: 'runtime-activity'`, `condition: 'runtime_activity_mapper_failure'`, `provider: '<anthropic|openai-responses|openai-chat|codex>'`) and per-(provider × error-message) per-process dedupe (cap 256, message truncated to 200 chars, fail-open at cap with single-fire warn log). Silent classification regressions surface in production rather than degrading the watchdog gate silently.


## Model Independence

Rebel Core provides multi-provider support through a layered abstraction:

1. **`ModelClient` interface** (`modelClient.ts`) — provider-neutral contract
2. **Provider clients** — `anthropicClient.ts` (Anthropic) and `openaiClient.ts` (OpenAI, Together, Cerebras, DeepSeek, local models)
3. **Client factory** (`clientFactory.ts`) — routes to the right client based on the resolved route. `createClientFromRoutePlan` switches on the `ProviderRouteDecision.transport` discriminant (`anthropic-direct | codex-proxy | openrouter-proxy | anthropic-compatible-local-proxy | openai-compatible-http | local-openai-compatible-http`), which encodes *how* the client is constructed at the type level, eliminating scattered `startsWith('claude-')` and `providerType === 'google'` checks across callers. An **ESLint lint guard** (`no-restricted-syntax`) prevents direct `AnthropicClient`/`OpenAIClient` construction outside `clientFactory.ts`, ensuring all client creation routes through the factory for consistent routing and provider resolution.
4. **Neutral types** (`modelTypes.ts`) — Anthropic-shaped but provider-agnostic wire format

**Note**: The top-level router (`queryRouter.ts`) uses `hasValidAuth()` which accepts any viable provider (Anthropic API key, OAuth, model profile, local model). End-to-end provider-only access works -- a user with only an OpenAI key can use Rebel Core. The internal wire format uses Anthropic-inspired naming (`tool_use`, `tool_result`, `input_schema`) but these are Rebel Core's own types, not SDK imports. Renaming was considered and rejected (40+ file blast radius, zero functional benefit).


## Current State

### Implemented and working
- Centralized runtime router
- Native agent loop with manual model-tools-model cycling
- Provider-neutral ModelClient with Anthropic and OpenAI-compatible clients
- Prompt caching for Anthropic direct calls
- Native sub-agent tool with provider-aware alias resolution
- **Forager agent** — built-in Haiku-class subagent for cheap extractive content triage. Uses `lightweight` mode (minimal ~250-token prompt, no mission/task-board/summarize injection). Returns structured evidence cards (exact quotes + relevance scores + source pointers). Always registered on RC turns. See `foragerPrompt.ts`, `foragerTypes.ts`, and [planning doc](../plans/260405_foraging_subagent.md).
- **Dynamic Agent tool discovery** — `buildAgentToolDefinition()` generates Agent tool schema with `enum` of available agents + descriptions, replacing the static definition for top-level turns.
- **Lightweight subagent mode** — `RebelCoreAgentDefinition.lightweight: true` skips SubagentStart hooks, mission briefing, and SummarizeResult injection/tool for economy-tier agents.
- **Sub-agent cost tracking** — `mergeSubAgentUsage()` on the adapter accumulates per-model token usage from sub-agent `turn:complete` events via `onSubAgentComplete` callback. Sub-agent costs are included in the parent turn's `total_cost_usd` and cost ledger. Per-model breakdown exists in the adapter but is flattened at the handler boundary — see [COST_TRACKING.md](COST_TRACKING.md#7-sub-agent-costs) for the full data flow and known gaps.
- **Sub-agent `max_tokens` clamp keys off the concrete routed backend** — the output cap for a sub-agent is clamped against the **concrete routed backend** model, not the alias route-table model (`'working'`). Clamping on the alias produced wrong caps when the alias resolved to a different backend (e.g. a Haiku sub-agent routed under a GPT alias got a 128k cap > Haiku's 64k → a 400). Reasoning-replay is keyed the same way. Fixed 2026-06-13 (commits `b8ae88c0`, `5906daca`); pinned by `agentTool.subAgentMaxTokensClamp.test.ts`. Latent siblings (`subThinking`/`subApiEffort`/`supportsReasoningReplay`) were spun out to a descriptor `limitModel`.
- **Per-subagent wall-clock timeout** — `RebelCoreAgentDefinition.maxDurationMs` composes `AbortSignal.any()` with the parent signal. On timeout, returns error result to orchestrator (does not throw) and bubbles partial usage. Uses `timedOut` boolean for race-free abort classification. Forager default: 60s. Known limitation: between-turn protection only (MCP tools have their own 120s timeout).
- **Parallel sub-agent execution groups** — Planner steps can emit shared `parallel_group` IDs that are parsed via `derivePlanParallelGroups()` before execution, and `agentLoop.ts` fans out grouped Agent calls through `runWithLimit(PARALLEL_AGENT_CAP)` with `PARALLEL_AGENT_CAP = 4` to cap per-turn concurrency while preserving per-call error handling. The cap is per `runAgentLoop` instance, hard-bounded at `4 × 4 = 16` total in-flight at the leaf level (the `Agent` tool is gated by `depth < 2` in `agentTool.ts`), and planner-derived fan-out is top-level only. See [260503_parallel_plan_execution.md](../plans/260503_parallel_plan_execution.md) and `src/core/rebelCore/constants/limits.ts`.
- **Dedicated BTS task group for foraging** — `btsCategory` field on `RebelCoreAgentDefinition` routes model resolution through `resolveBtsModel()` instead of alias resolution, enabling per-task model override in Settings → Agents → Background Task Models. Includes `profile:<id>` resolution with fallback for missing profiles.
- Task board with deterministic auto-continue
- Super-MCP HTTP session integration
- SDK message compatibility adapter
- Planning mode
- Hook pipeline (PreToolUse, PostToolUse, Stop, Subagent)
- Model limit resolution from settings + model metadata
- **Built-in web and file search tools** — `WebSearch` (DuckDuckGo HTML scraping, zero-config, CAPTCHA detection with graceful degradation, 5/turn rate limit), `WebFetch` (local fetch + linkedom + Readability + Turndown for URL reading; SSRF via `followRedirectsSafely()` in `src/core/utils/ssrfProtection.ts` with per-hop IP validation and pinned-dispatcher connect-to-validated-IP; 10/turn rate limit — see [OUTBOUND_NETWORKING_AND_SSRF](./OUTBOUND_NETWORKING_AND_SSRF.md)), `SearchFiles` (3-tier fallback: rg → grep → Node.js, cross-platform with option injection prevention), `Glob` (3-tier file-pattern search: rg → find+picomatch → Node walker; gitignore-style globs; symlink-aware), and `LS` (directory listing with metadata; symlink-aware; recursive mode via `safeWalkDirectory`). Tool implementations live in `src/core/rebelCore/tools/`. These are model-independent and require no user configuration. See [`docs/plans/260527_glob_ls_builtins_and_bash_offramp.md`](../plans/260527_glob_ls_builtins_and_bash_offramp.md) for the Glob/LS design and the bash-overuse regression they address.
- **Full-fidelity JSONL transcript logging** — Captures pre-sanitization events (complete tool inputs/outputs, assistant messages, usage, subagent activity) at the `emitEvent` level in `rebelCoreQuery.ts`. Per-session append-only files at `{userData}/transcripts/{sessionId}.jsonl` with 14-day TTL. Fire-and-forget, fail-open — never blocks agent turns. See `src/core/services/transcriptService.ts` and `docs/plans/260413_rebel_core_transcript_logging.md`.
- **Capability suppression** — When MCP web-search providers are configured (e.g., Perplexity, Tavily, Brave), `capabilityResolutionService.ts` computes `disallowedTools` which flow through `queryOptionsBuilder.ts` → `TurnParams.suppressedBuiltins` → `rebelCoreQuery.ts` filtering → subagent inheritance via `AgentToolContext`. Suppressed builtins are excluded from both the adapter tool manifest and the agent loop tool list. Suppression only applies when MCP is actually attached; degraded/no-MCP turns keep builtins.

### Known remaining items
- `agentLoop.ts` still has `DEFAULT_MAX_TOKENS = 4096` fallback
- `settings.claude.*` namespace still used at the storage level (runtime isolated via `settingsAccessors.ts`). Provider-neutral naming completed at the runtime layer: `opusplan`, `ANTHROPIC_DEFAULT_*_MODEL`, and `opusPlanMode` aliases have been eliminated in favor of provider-neutral alternatives. The `settingsAccessors.ts` accessor layer presents a provider-neutral interface while reading from the legacy `claude.*` namespace internally. Cost tracking now differentiates subscription-based auth (OAuth/Codex) from API-key auth via the `auth` field in cost ledger entries — see [COST_TRACKING.md](COST_TRACKING.md) and `src/main/startup/costLedgerAuthMigration.ts`.
- **Tool execution is now concurrent**: `agentLoop.ts` uses `Promise.all` to execute parallel tool calls concurrently. See `docs/plans/260401_rebel_core_concurrent_tool_execution.md` for the concurrency policy and intent.
- **Provider-aware context overflow fallback**: RC supports profile-based and model-name-based fallback on context overflow via `profileOverride` in `clientFactory.ts`.

### Planned
- `settings.claude.*` key rename to provider-neutral names (requires UI + store migration)


## Structured Output Schema Boundary

The planner uses provider-side structured-output enforcement so the planning JSON
always parses and never drifts into prose. The boundary contract:

- **Source of truth** — `JsonSchemaFormat` in `modelClient.ts` carries a stable
  `name` plus a standard JSON-Schema document. `PLAN_OUTPUT_FORMAT` in
  `planningMode.ts` is the single instance for plan mode.
- **Three downstream dialects** — the same schema flows into:
  - **Anthropic**: `output_config.format` (constrained decoding) — see
    `anthropicClient.ts`.
  - **OpenAI Chat Completions** (and OpenAI-compatible providers): `response_format:
    { type: 'json_schema', json_schema: { name, schema, strict } }` — see
    `openaiClient.ts`.
  - **OpenAI Codex Responses API**: `text.format: { type: 'json_schema', name,
    schema, strict }` — translated by `codexResponsesTranslator.ts`.
- **Provider-specific quirks the schema must satisfy**:
  - **OpenAI strict mode** — root `type: 'object'` only; no top-level `anyOf`,
    `oneOf`, `allOf`, `not`, or `enum` *unconditionally* (the rule applies
    even when sibling `type:'object'` is also present — see the May-8
    flatten-discriminator plan
    [`260508`](../plans/260508_planner_schema_openai_strict_flatten_discriminator.md)
    and `260505` postmortem § Lessons Learned for the historical
    misinterpretation that motivated the unconditional phrasing).
    Every object needs `additionalProperties: false`, and every key in
    `properties` must appear in `required`. Express discriminated unions
    via a property `enum` discriminator (`PLAN_RESPONSE_SCHEMA_OPENAI_STRICT`
    uses `properties.type: { type: 'string', enum: ['direct_answer', 'plan'] }`)
    with variant-irrelevant fields nullable / empty by design;
    `normalizePlanningDocument` enforces variant semantics post-parse.
    Nullability is expressed via `type: ['T', 'null']` arrays (which
    OpenAI strict accepts; Anthropic constrained decoding does NOT —
    that's why the universal-subset schema uses nested `anyOf` instead).
  - **Anthropic constrained decoding** — every object needs
    `additionalProperties: false`. Array-form `type` (e.g. `["string", "null"]`)
    combined with `enum` is rejected; use a nested `anyOf` of
    `{ type: 'string', enum: [...] }` and `{ type: 'null' }` instead.

These rules are encoded as recursive validators in
`src/core/rebelCore/__tests__/planSchemaProviderCompat.test.ts` and run on every
build. Any change to `PLAN_RESPONSE_SCHEMA` MUST keep both validators returning
empty violation arrays.

**Runtime safety net** — `runPlanningPhase` wraps `client.stream()` in a
schema-rejection guard using the shared `isStructuredOutputSchemaRejection`
predicate (`packages/shared/src/utils/structuredOutputErrorClassification.ts`).
If a provider rejects the structured-output schema with a 400 + `invalid_request`,
the planner logs the rejection, captures it via `captureKnownCondition('model_error', ...)`
with `tags.sdk_error_category: 'structured_output_schema_rejected'`, and retries once
with `outputConfig` omitted, falling back to the prompt-level schema instructions.
This bridges provider-dialect drift between CI runs while still surfacing the
failure in logs and Sentry. The same shared predicate is used in
`src/main/services/turnErrorRecovery.ts` so user-facing copy uses
`humanizeStructuredOutputSchemaRejection()` from `humanizeAgentError.ts`
instead of the generic `invalid_request` banner.

Origin incidents and full diagnosis:
[`docs-private/investigations/260506_planning_schema_provider_compat_class_bug.md`](../../docs-private/investigations/260506_planning_schema_provider_compat_class_bug.md).

### BTS request boundary

The Behind-The-Scenes (BTS) client uses the same structured-output contract,
but on a separate code path: BTS callers (timeSaved, safety eval, summaries,
community share, watchdog judge, etc.) pass `BehindTheScenesRequestOptions.outputFormat`
through `behindTheScenesClient.ts` and the local model proxy to whichever
upstream is selected by the BTS route plan. The wire body uses the
**Anthropic-shaped `output_format` field** as its canonical channel; each
proxy branch then translates it into the upstream-API-shaped enforcement
field. This boundary has its own invariants, separate from planner mode:

1. **BTS callers send Anthropic-shaped `output_format`.** `callViaCodexProxy`,
   `callViaOpenRouterProxy`, `callViaAnthropicCompatibleProxy`, and the
   direct Anthropic path all set `body.output_format = options.outputFormat`
   plus the `anthropic-beta: structured-outputs-2025-11-13` header. This is
   the canonical wire contract.
2. **Every typed Anthropic→OpenAI translator MUST translate `output_format`
   to `response_format.json_schema`.** `localModelProxyServer.ts` exposes a
   shared helper `translateAnthropicOutputFormatToOpenAIResponseFormat()`
   that defaults `strict: false` and `name: 'structured_output'`. All five
   proxy branches (Codex non-streaming, Codex streaming,
   `handleStreamingRequest`, `handleStreamingViaResponsesApi`, generic
   non-streaming OpenAI-compat) must call it when the inbound request has
   `output_format`. Forgetting to call it silently downgrades the upstream
   call to free-text mode and the BTS caller's domain validator rejects the
   prose-shaped JSON with `Invalid response structure`.
3. **Raw-string passthroughs MUST preserve all body fields including
   `output_format`.** `handleAnthropicPassthrough` forwards the original
   body bytes unchanged. `handleOpenRouterPassthrough` rebuilds a JSON body
   for thinking↔reasoning translation but must not strip `output_format`
   (which OpenRouter Messages honors via the `anthropic-beta` header).
4. **The Codex Responses API uses `text.format.json_schema`, not
   `output_format`.** The translator
   (`codexResponsesTranslator.ts:translateChatToResponses`) reads
   `chatBody.response_format.json_schema` and emits Responses
   `text.format.json_schema`. The proxy must therefore call
   `translateAnthropicOutputFormatToOpenAIResponseFormat()` BEFORE handing
   the request to `translateChatToResponses()` — otherwise the translator
   defaults `text.format` to `{ type: 'text' }` and Codex returns prose.

The Codex non-streaming branch is the user-visible failure path because
BTS forces `stream: false` (so it can return JSON) and Codex-subscription
auth is the most common BTS routing for ChatGPT Pro users. The
`[CODEX-DIAG]` log lines on each translation branch include
`inboundOutputFormat` and `outboundResponseFormat` so divergence
(`true → false`) is detectable from logs alone.

Out of scope for this contract: profile-direct calls
(`callDirectWithProfile`) intentionally use `response_format:
{ type: 'json_object' }` for broad provider compatibility — schema
enforcement requires per-provider gating that's a separate effort.

Origin incident and full diagnosis:
[`docs-private/investigations/260509_bts_output_format_dropped_codex_proxy.md`](../../docs-private/investigations/260509_bts_output_format_dropped_codex_proxy.md).


## Testing

Unit tests live in `src/core/rebelCore/__tests__/`:
- `queryRouter.test.ts` — routing logic
- `modelResolution.test.ts` — model limit resolution
- `planningMode.test.ts` — planning pass (includes runtime schema-rejection fallback tests)
- `planSchemaProviderCompat.test.ts` — CI gate enforcing OpenAI / Anthropic
  structured-output schema rules on `PLAN_OUTPUT_FORMAT.schema`
- `promptCaching.test.ts` — cache control behaviour
- `agentMessageAdapter.status.test.ts` / `agentMessageAdapter.accumulatedText.test.ts` — message translation
- `rebelCoreIntegration.test.ts` — end-to-end integration
- `subAgentAliasResolution.test.ts` — provider-aware alias mapping
- `fullPathIntegration.test.ts` — full execution path

Eval harness: `docs/plans/260320_rebel_core_agent_loop_eval_harness.md` describes the framework for behavioural regression testing and SDK-vs-Rebel-Core comparison.
