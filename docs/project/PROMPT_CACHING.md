---
description: "Prompt caching reference for Rebel Core — cache_control usage, OpenRouter parity, cost metrics, cache-friendly prompt design"
last_updated: 2026-04-23
---

# Prompt Caching

## Introduction

This document explains how prompt caching works in Mindstone Rebel via Rebel Core (the sole agent runtime since April 2026), and best practices for maximizing cache efficiency. Prompt caching reduces API costs by up to 90% and improves latency by reusing pre-computed internal state for repeated prompt prefixes.

> **OpenRouter parity — verified working in production (2026-04-23).**
> Investigation complete. Across 195 real Rebel turns over 10.7 days ($154.69 spent), the overall cache hit ratio is **66.6%** with a 2.43x read/write ratio — caching is firing healthily for both Anthropic and OpenAI models routed via OpenRouter. The initial single-turn spike that suggested a problem was testing a worst-case shape not used in production. Multi-turn spike (v4) confirmed top-level `cache_control` reads from cache as conversations grow. Block-level `cache_control` would save ~0.4% of total spend and is not pursued as a bug fix. See [`260423_openrouter_prompt_caching_and_cost_investigation.md`](../../docs-private/investigations/260423_openrouter_prompt_caching_and_cost_investigation.md) for the full hand-off summary, evidence, ranked cost hypotheses, and suggested next steps.

## See also

- [CONTEXT_MANAGEMENT.md](CONTEXT_MANAGEMENT.md) — Hub doc for the full context management system (compaction, caching, materialization, cost tracking)
- `docs/project/SYSTEM_PROMPT.md` — How the composite system prompt is constructed (platform + user + environment context)
- `docs/research/libraries/CLAUDE_AGENT_SDK_REFERENCE.md` — Archived SDK reference (historical — SDK removed April 2026)
- `docs/plans/260326_rebel_core_prompt_caching.md` — Planning doc for Rebel Core caching implementation (original, pre-OpenRouter)
- [`docs-private/investigations/260423_openrouter_prompt_caching_and_cost_investigation.md`](../../docs-private/investigations/260423_openrouter_prompt_caching_and_cost_investigation.md) — **Primary hand-off** (2026-04-23): closed / not-a-bug, production evidence (66.6% hit ratio), ranked cost-regression hypotheses, suggested next steps.
- [`docs/research/260423_openrouter_prompt_caching_deep_dive.md`](../research/260423_openrouter_prompt_caching_deep_dive.md) — Deep dive on OpenRouter per-provider caching behaviour, sticky routing, and response-shape quirks
- [`docs/research/260423_cross_provider_prompt_cache_design.md`](../research/260423_cross_provider_prompt_cache_design.md) — Deep dive on prompt-structure patterns that cache well on Anthropic + Gemini + OpenAI simultaneously
- `src/core/rebelCore/clients/anthropicClient.ts` — Rebel Core's direct API client (includes top-level `cache_control`)
- `src/main/services/localModelProxyServer.ts` — OpenRouter passthrough (`stripTopLevelCacheControl()`, `stripContextManagementForNonAnthropic()`, provider-routing injection)
- `src/main/services/mcpService.ts` — `generateEnvContext()` builds cache-friendly environment variables
- `src/main/services/agentMessageHandler.ts` — Extracts and forwards cache metrics from agent turn results
- `src/shared/utils/usageFormatters.ts` — Formats cache metrics for display

External references:

- [Anthropic Prompt Caching Documentation](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) — Official API documentation
- [OpenRouter Prompt Caching Guide](https://openrouter.ai/docs/guides/best-practices/prompt-caching) — Per-provider caching behaviour via OpenRouter
- [Claude Agent SDK Overview](https://docs.claude.com/en/docs/agent-sdk/overview) — SDK features and capabilities (historical reference)

## Key points

1. **Rebel Core uses top-level `cache_control`** for automatic prefix caching
2. **Caching requires explicit opt-in** — There is no free automatic caching. You must include `cache_control` in API requests
3. **Mindstone Rebel implements cache-friendly patterns** — Time buckets instead of exact timestamps
4. **Cache metrics are tracked and displayed** — Users can see cache hits in turn usage
5. **Prompt structure matters for efficiency** — Static content first, dynamic content last

## How caching works

### Rebel Core (direct API)

Rebel Core calls the Anthropic Messages API directly via `@anthropic-ai/sdk`. It uses **top-level automatic caching** by including `cache_control: { type: 'ephemeral' }` at the request body level in `AnthropicClient.doStream()`.

```typescript
// From src/core/rebelCore/clients/anthropicClient.ts
const stream = this.client.messages.stream({
  model: params.model,
  max_tokens: params.maxTokens,
  system: params.systemPrompt,
  messages: params.messages,
  cache_control: { type: 'ephemeral' },  // Automatic prefix caching
  ...
} as any, { signal: params.signal });
```

With top-level `cache_control`, Anthropic automatically places a cache breakpoint on the last cacheable block. This caches the entire prefix (tools + system prompt + prior messages) and advances the breakpoint as conversations grow.

Cache metrics flow through the standard pipeline: `mapUsage()` reads `cache_creation_input_tokens` and `cache_read_input_tokens` from the API response, which feed into `TokenUsage`, `agentMessageAdapter`, `pricingCalculator`, and `usageFormatters`.

**Important:** Caching is NOT free or automatic without opt-in. You must include `cache_control` in the request. Without it, every turn pays full price for all input tokens.

## How Anthropic's prompt caching works

Per the [Anthropic documentation](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching):

### Cache hierarchy

Cache prefixes are created in order: **tools → system → messages**. Changes at each level invalidate that level and all subsequent levels.

### Minimum cacheable length

| Model | Minimum tokens |
|-------|---------------|
| Claude Opus 4.7, Opus 4.6, Opus 4.5 | 4096 |
| Claude Sonnet 4.6 | 2048 |
| Claude Sonnet 4.5, Opus 4.1, Opus 4, Sonnet 4 | 1024 |
| Claude Haiku 4.5 | 4096 |
| Claude Haiku 3.5, Haiku 3 | 2048 |

### Cache lifetime

- Default TTL: 5 minutes ("ephemeral" cache type)
- Extended retention available for some use cases (up to 1 hour)
- Cache entries become available after the first response begins

### Pricing

- **Cache writes**: 25% premium over base input token price
- **Cache reads**: 90% discount (only 10% of base input token price)
- **Net effect**: Significant savings when prompts are reused within the TTL window

## Mindstone Rebel's cache-friendly design

### Environment context uses time buckets

The `generateEnvContext()` function in `mcpService.ts` deliberately uses time buckets instead of exact timestamps to maximize cache hits:

```typescript
// From src/main/services/mcpService.ts (lines 1460-1475)

// Date and day of week (no exact time to preserve prompt caching)
// Useful for reasoning about weekdays/weekends, deadlines, and date formatting
// without introducing a high-churn timestamp that would degrade prompt cache hits.
const isoDate = now.toISOString().slice(0, 10); // YYYY-MM-DD

// Time-of-day bucket (local time)
// Guides tone/urgency suggestions and scheduling proposals (e.g., "later today" vs "tomorrow morning")
// while staying cache-friendly (no minute-level time).
const timeOfDayBucket =
  hour < 5 ? 'late_night' :
  hour < 12 ? 'morning' :
  hour < 17 ? 'afternoon' :
  hour < 21 ? 'evening' : 'night';
```

**Why this matters**: If we used exact timestamps (e.g., `2025-12-13T14:32:45Z`), every turn would have a unique system prompt, invalidating the cache. By using date + time bucket, the prompt prefix remains stable within each bucket period (several hours).

### System prompt structure

The composite system prompt (see `SYSTEM_PROMPT.md`) places content in this order:

1. **Platform instructions** (`rebel-system/AGENTS.md`) — Large, stable, rarely changes
2. **User instructions** (`Chief-of-Staff/README.md`) — Medium, user-specific, changes occasionally  
3. **Environment context** (`<env>` block) — Small, changes with time bucket

This structure is **mostly cache-friendly** because:
- The platform instructions (~3000+ tokens) are identical across all users and sessions
- Changes to user instructions only invalidate user + env portions
- The env block changes infrequently (time bucket granularity)

### Cache metrics display

Users can see cache effectiveness in the usage tooltip for each turn:

```typescript
// From src/shared/utils/usageFormatters.ts
if (event.usage.cacheCreationTokens) parts.push(`cache+: ${event.usage.cacheCreationTokens}`);
if (event.usage.cacheReadTokens) parts.push(`cache✓: ${event.usage.cacheReadTokens}`);
```

- `cache+: N` — N tokens were written to cache (first request with this prefix)
- `cache✓: N` — N tokens were read from cache (cache hit!)

## Monitoring cache effectiveness

### What to look for

**Good cache utilization**:
- High `cacheReadTokens` relative to `inputTokens`
- `cacheCreationTokens` only on first turn or after significant prompt changes
- Cache hit ratio > 50% for multi-turn conversations

**Poor cache utilization**:
- `cacheCreationTokens` on every turn (no cache hits)
- Very low `cacheReadTokens` 
- High costs despite similar prompts

### Adding cache monitoring (optional enhancement)

To track cache performance over time, consider adding logging:

```typescript
// In agentMessageHandler.ts result handler
const cacheHitRatio = cacheReadTokens && inputTokens 
  ? cacheReadTokens / (cacheReadTokens + inputTokens) 
  : 0;
turnLogger?.info({ 
  cacheHitRatio: cacheHitRatio.toFixed(2),
  cacheReadTokens, 
  cacheCreationTokens,
  inputTokens 
}, 'Cache performance for turn');
```

## Best practices

### For system prompt design

1. **Keep platform instructions at the beginning** — This maximizes the cacheable prefix
2. **Use time buckets, not timestamps** — Avoid invalidating cache with each request
3. **Stable ordering** — Don't shuffle prompt sections between requests
4. **Minimize dynamic content size** — Smaller dynamic sections = larger cacheable prefix

### For multi-turn conversations

1. **Avoid unnecessary prompt changes** — Each change can invalidate cache
2. **Batch related requests** — Multiple requests within 5 minutes benefit from same cache
3. **Keep tool definitions stable** — Tool changes invalidate the entire cache (tools are first in the hierarchy)

## Sub-agent caching behavior

Sub-agents spawned via the `Agent` tool in Rebel Core benefit from prompt caching through two mechanisms:

### Top-level automatic caching

Sub-agents run through `runAgentLoop()` → `client.stream()` → `doStream()`, which includes `cache_control: { type: 'ephemeral' }` at the request body level. This provides automatic prefix caching for the entire request (tools + system prompt + messages).

### Explicit breakpoint on `agentDef.prompt`

The sub-agent system prompt is structured as a `TextBlock[]` with an explicit `cache_control` breakpoint on the first block:

```typescript
// From src/core/rebelCore/agentTool.ts
const stableBlock: TextBlock = {
  type: 'text',
  text: `${agentDef.prompt}\n`,
  cache_control: { type: 'ephemeral' },
};
const dynamicBlock: TextBlock = {
  type: 'text',
  text: dynamicParts.join('\n\n'),  // additionalContext + missionBriefing + summarize
};
systemPrompt = [stableBlock, dynamicBlock];
```

- **Block 1 (stable):** The agent definition prompt (`agentDef.prompt`) — identical across invocations of the same agent type. Gets a `cache_control` marker.
- **Block 2 (dynamic):** Additional context (frequent tools), mission briefing (task board), and summarize instruction. Varies per invocation. No cache marker.

### When this matters most

- **Same agent type invoked multiple times** (e.g., reviewer agent for different files in a CHIEF_ENGINEER workflow): The stable agent prompt is cached and reused, saving cache write costs on subsequent invocations.
- **Agent prompts exceeding minimum cacheable length** (1024–4096 tokens depending on model): Short prompts below the threshold are not cached regardless of markers.
- **Different mission briefings per invocation**: The explicit breakpoint on Block 1 ensures caching works even when Block 2 changes between invocations.

### When it doesn't help

- Single invocation of an agent type within a session (no reuse opportunity)
- Agent prompts below minimum cacheable length
- The top-level `cache_control` on `doStream()` already catches the prefix naturally

### Empty prompt fallback

When `agentDef.prompt` is empty, the system prompt falls back to a plain string (no `TextBlock[]`). This avoids creating a cache breakpoint on an empty block.

## Cross-provider cache isolation

`cache_control` is an Anthropic-specific API parameter. It is **not** leaked to other providers:

- **AnthropicClient** (`anthropicClient.ts`): Adds `cache_control: { type: 'ephemeral' }` to both `doCreate()` and `doStream()` requests.
- **OpenAI client** (`openaiClient.ts`): Constructs its own request body from `StreamParams`/`CreateParams`. The `cache_control` field is never included — OpenAI handles caching automatically via their own mechanisms.
- **Gemini profiles**: Routed through `AnthropicClient` via the local proxy (`localModelProxyServer.ts`), which translates Anthropic requests to OpenAI-compatible format. The proxy strips `cache_control` during translation.

The `TextBlock[]` system prompt is handled by each provider's translator:
- **Anthropic**: Passes through as-is (native format).
- **OpenAI**: `openaiTranslators.ts` joins text blocks with `.join('\n')` into a single string. The `cache_control` field on individual blocks is naturally dropped during translation.

## OpenRouter routing (all providers via `/v1/messages`)

> **See the deep dives for the full picture:** [`docs/research/260423_openrouter_prompt_caching_deep_dive.md`](../research/260423_openrouter_prompt_caching_deep_dive.md) and [`docs/research/260423_cross_provider_prompt_cache_design.md`](../research/260423_cross_provider_prompt_cache_design.md).

When the active profile is OpenRouter, all traffic flows through `localModelProxyServer.ts` to `https://openrouter.ai/api/v1/messages` (OpenRouter's Anthropic-compatible endpoint). The request body is still in Anthropic format, so top-level and block-level `cache_control` remain valid syntactically — but their effect **depends on which upstream provider OpenRouter routes to**.

### Per-provider behaviour (partially measured 2026-04-23)

| Provider family | Top-level `cache_control` (single-turn, measured) | Block-level `cache_control` on system (measured) | Implicit caching without any marker |
|---|---|---|---|
| **Anthropic** (`anthropic/claude-*`) | Caches the whole request including user message — single-turn calls with different user messages pay the 1.25x write premium every time, read 0. **Multi-turn behaviour not measured** — docs imply the breakpoint advances across turns and should read-hit the prior prefix | ✅ Prefix cache hit even with different user messages, ~10x cost reduction on reads | ❌ No caching (Anthropic requires explicit opt-in) |
| **OpenAI** (`openai/gpt-*`) | No documented benefit; OpenRouter describes OpenAI caching as automatic | Harmless — `cache_control` on non-Anthropic providers is ignored | ✅ Works automatically — reported back as `cache_read_input_tokens` in the Anthropic-format response |
| **Google Gemini** | Ignored (Gemini-specific) | Only the **last** `cache_control` block is used — reserve it for the stable prefix | ⚠ Implicit caching works only if the first system/developer message is immutable. Appending a dynamic env tail breaks it |
| **DeepSeek / Grok / Groq / Moonshot** | Ignored | Ignored | ✅ Automatic (where supported) |

### Cost implication for Rebel (hypothesis, not confirmed)

Block-level `cache_control` is strictly superior for single-turn calls and for Bedrock/Vertex fallback. Whether our current top-level-only config is *also* failing on multi-turn calls — the dominant shape of real Rebel conversations — remains unverified. The post-OpenRouter cost regression has multiple plausible causes (OpenRouter markup, model mix shift, sub-agent usage growth, caching shape); see the stub plan for the investigation checklist before attributing the delta to any single cause.

### OpenRouter usage response on `/v1/messages`

OpenRouter's `/v1/messages` **normalizes** usage back to the Anthropic shape regardless of upstream provider:

- `input_tokens` — fresh input tokens (excludes cached)
- `cache_creation_input_tokens` — tokens written to cache (may be `null` for non-Anthropic providers even when caching fires)
- `cache_read_input_tokens` — tokens read from cache (populated for both Anthropic and OpenAI; ✓ picked up by our existing `mapUsage()`)
- `cost` — OpenRouter's exact billed cost (not in stock Anthropic responses)
- `cost_details` — upstream inference cost breakdown

Our `AnthropicClient.mapUsage()` already reads the two `cache_*_input_tokens` fields. That means OpenAI prefix-caching via OpenRouter is **already observable** in our existing metrics pipeline. Anthropic cache hits would also be observable — if they were firing, which today they aren't (see above).

### Cache-control 404 fallback

`localModelProxyServer.ts` detects OpenRouter's "no endpoints available that support automatic caching" 404 and retries with top-level `cache_control` stripped (`stripTopLevelCacheControl()`). This exists because top-level `cache_control` restricts OpenRouter to the Anthropic-direct provider (Bedrock and Vertex don't support it). The fallback unblocks requests but also silently disables caching for that turn; block-level breakpoints would avoid this failure mode entirely.

## Cross-model cache isolation

Different Anthropic models maintain **separate cache pools**. A cache entry created for `claude-sonnet-4-20250514` is not shared with `claude-opus-4-7` or any other model.

This means:
- Switching between models (e.g., Sonnet → Opus) within a session invalidates cache
- Sub-agents using a different model than the parent do not share cache entries
- Identical prompts sent to different models incur separate cache write costs

## `doCreate()` vs `doStream()` caching parity

Both `AnthropicClient` methods now include `cache_control: { type: 'ephemeral' }`:

| Method | `cache_control` | Used by |
|--------|-----------------|---------|
| `doStream()` | ✅ Yes | `agentLoop`, `planningMode`, sub-agents |
| `doCreate()` | ✅ Yes | Future callers (public `ModelClient` API) |

Previously, `doCreate()` was missing `cache_control`, which would have caused any future caller to silently miss caching. Both methods now have parity.

## Limitations and gotchas

### Session concurrency

Per Anthropic docs: "For concurrent requests, a cache entry only becomes available after the first response begins."

This means the first request in a session pays the cache creation cost, and subsequent requests (even if concurrent) must wait for that first response to benefit from caching.

### MCP tool definitions

Tool definitions are part of the cache hierarchy. If MCP servers change their tool schemas, the entire cache is invalidated. This is handled automatically by Super-MCP and Rebel Core's prompt assembly.

### 20-block lookback limit

When using explicit cache breakpoints, the system checks at most 20 positions backward from each breakpoint to find a matching cache entry. If a conversation turn adds >20 blocks (common in tool-heavy agentic loops), the lookback may miss prior cache entries. This is not an issue with top-level automatic caching (which Rebel Core uses), but could become relevant if explicit breakpoints are added later.

### Extended context mode

When using 1M extended context, caching behavior may differ. The minimum cacheable length thresholds still apply.

### Extended thinking blocks

Thinking blocks cannot be marked with `cache_control` directly, but they ARE cached as part of prior assistant turns when passed back in tool-use loops. Non-tool-result user messages strip all prior thinking blocks from context, invalidating that cache portion.

## Code pointers

```
// Rebel Core — prompt caching (direct API)
src/core/rebelCore/clients/anthropicClient.ts
  - doStream() — Adds cache_control: { type: 'ephemeral' } to request
  - mapUsage() — Reads cache_creation_input_tokens and cache_read_input_tokens from response
  - Debug logging for cache metrics when tokens > 0

// Rebel Core — sub-agent system prompt with explicit cache breakpoints
src/core/rebelCore/agentTool.ts
  - Builds TextBlock[] system prompt: stable agentDef.prompt (cached) + dynamic parts (uncached)

// Rebel Core — prompt caching tests
src/core/rebelCore/__tests__/promptCaching.test.ts
  - Verifies cache_control presence, system prompt passthrough, cache metric flow (stream + create)
src/core/rebelCore/__tests__/subAgentPromptCaching.test.ts
  - Verifies sub-agent prompt structure: TextBlock[] format, cache breakpoints, empty prompt fallback

// Cache-friendly environment generation
src/main/services/mcpService.ts
  - generateEnvContext() — Uses time buckets for cache stability

// Cache metrics extraction
src/main/services/agentMessageHandler.ts
  - Extracts cache tokens from API result, forwarded to renderer

// Cache metrics display
src/shared/utils/usageFormatters.ts
  - formatUsage() — Formats cache+/cache✓ for display

// Cost calculation
src/shared/utils/pricingCalculator.ts
  - calculateCost() — Already has cacheRead and cacheCreation rates per model

// Anthropic SDK type definitions
node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts
  - MessageCreateParams.cache_control (line ~1864) — Top-level automatic caching
  - TextBlockParam.cache_control — Block-level explicit caching
```

## Future enhancements

- **1-hour cache TTL**: For agentic workflows where users may be idle >5 min, the 1h TTL (at 2x write cost) could preserve cache across idle periods. Add as user setting when needed.
- **Explicit breakpoints**: If live metrics show the 20-block lookback limit causes cache misses in tool-heavy turns, add explicit breakpoints on the system prompt. The infrastructure supports up to 4 breakpoints per request.
- **Prompt cache warmup**: The existing `promptCacheWarmupService.ts` could be enhanced with more targeted warmup strategies.

## Summary

Mindstone Rebel benefits from Anthropic's prompt caching via Rebel Core, which uses top-level `cache_control: { type: 'ephemeral' }` for automatic prefix caching. The codebase implements cache-friendly patterns (time buckets, stable prompt structure) and exposes cache metrics to users.


