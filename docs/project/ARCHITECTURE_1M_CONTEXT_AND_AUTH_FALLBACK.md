---
description: "How Rebel handles 1M-context (extended-context) requests and the automatic authentication/model fallback chains (1M-unavailable, thinking-model-unavailable, rate-limit)."
last_updated: "2026-05-30"
---

# Context Window and Auth Fallback Architecture

How Rebel handles 1M context requests and authentication/model fallbacks.

## See Also

- [MODEL_AND_PROVIDER_OVERVIEW.md](MODEL_AND_PROVIDER_OVERVIEW.md) - territory hub: how a model is chosen, routed, authed, billed, and given a thinking budget
- [MODEL_ROLES_AND_THINKING.md](MODEL_ROLES_AND_THINKING.md) - the four roles + the two thinking axes; user-configured per-role fallback (`configuredRoleFallback.ts`) composes with the automatic fallbacks documented here
- [`ARCHITECTURE_AGENT_TURN_EXECUTION.md`](ARCHITECTURE_AGENT_TURN_EXECUTION.md) - Turn lifecycle and prompt assembly
- [`ARCHITECTURE_CONTEXT_OVERFLOW_RECOVERY.md`](ARCHITECTURE_CONTEXT_OVERFLOW_RECOVERY.md) - Compaction recovery for context limits
- [`MODEL_CONSTANTS.md`](MODEL_CONSTANTS.md) - Model identifiers and extended context suffix
- [`AUTHENTICATION.md`](AUTHENTICATION.md) - OAuth and API key authentication
- Diagram: [`docs/diagrams/260208a_1m_context_and_fallback_flow.mermaid`](../diagrams/260208a_1m_context_and_fallback_flow.mermaid)
- Planning docs:
  - [`docs/plans/finished/2026-02-08-simplify-1m-context-remove-lazy-escalation.md`](../plans/finished/2026-02-08-simplify-1m-context-remove-lazy-escalation.md) - Simplification plan (current)
  - [`docs/plans/finished/260131_lazy_1m_context_escalation.md`](../plans/finished/260131_lazy_1m_context_escalation.md) - Original lazy escalation (removed)

---

## Claude Max + 1M Context: Session-Level Fallback Memory

**Most Claude Max (OAuth) subscriptions do not support the 1M context beta.** Anthropic's servers reject the `context-1m-2025-08-07` beta header when used with OAuth tokens (`sk-ant-oat-*`), returning rate_limit or 401 errors. The 1M beta requires a pay-as-you-go API key on Usage Tier 4 (deposits >= $400).

References: Anthropic GitHub issues [#23472](https://github.com/anthropics/claude-code/issues/23472), [#27943](https://github.com/anthropics/claude-code/issues/27943). Confirmed Feb-Mar 2026.

### How It Works

OAuth users **can** enable 1M context in Settings. On the first turn of a conversation, Rebel attempts 1M normally. If Anthropic rejects it:

1. The executor detects the failure via two paths:
   - `isExtendedContextUnavailableError` (explicit "long context beta" error)
   - `RATE_LIMIT_RETRY` while 1M was enabled on OAuth (Anthropic often returns `rate_limit` instead of a specific error for OAuth + 1M)
2. Session memory records the failure (`agentTurnRegistry.markExtendedContextFailed(rendererSessionId)`)
3. The current turn retries at 200K on the same OAuth auth (strips `[1m]` suffix and beta header)
4. **All subsequent turns** in the same conversation skip the 1M attempt entirely -- no retry penalty
5. The amber fallback indicator shows on all affected turns (including session-memory skips, with `reason: 'session-memory'`)
6. Starting a new conversation resets the memory (new `rendererSessionId`)

### Enforcement

- **Default**: `extendedContext` defaults to `false` for OAuth users (`settingsUtils.ts`). Users must opt in.
- **Session memory**: `agentTurnRegistry.extendedContextFailedSessions` (a `Set<string>` keyed by `rendererSessionId`) tracks which conversations have had 1M failures.
- **Cleanup**: Memory is cleared at conversation-reset call sites.

### Trade-off: API Key + 1M on Subsequent Turns

Session memory intentionally suppresses the full fallback chain on subsequent turns. This means if a user has both OAuth and an API key, subsequent turns will NOT attempt API key + 1M -- they go straight to OAuth 200K. This is by design: we prefer flat-rate Max at 200K over pay-per-use API key at 1M. The first turn still exercises the full fallback chain.

### Key Code Locations

| Location | Purpose |
|----------|---------|
| `agentTurnRegistry.ts` | `extendedContextFailedSessions` Set, mark/has/clear methods |
| `agentTurnExecutor.ts` ~line 1777 | Session memory check (skips 1M if previously failed) |
| `agentTurnExecutor.ts` ~line 2922 | Records session failure via `isExtendedContextUnavailableError` path |
| `agentTurnExecutor.ts` ~line 3781 | Records session failure + retries at 200K via rate limit path (OAuth + 1M) |
| `agentTurnExecutor.ts` ~line 687 | Clears session memory on conversation reset |
| `AgentsTab.tsx` | 1M checkbox enabled for OAuth with informational tooltip |
| `settingsUtils.ts` | Default `false` for OAuth auth method |

---

## Overview

When the user enables "1M context" in settings (`settings.claude.extendedContext`), Rebel requests 1M context from the first turn via the `[1m]` model suffix and `anthropic-beta: context-1m-...` header. If 1M is unavailable (subscription tier, auth method), a fallback chain handles the error gracefully.

Three independent fallback mechanisms handle different failure scenarios:

1. **1M Context Fallback** - If 1M is unavailable, try API key auth, then fall back to 200K
2. **Model Fallback** - If the preferred planning model is unavailable, downgrade via `FALLBACK_PLANNING_MODEL`
3. **Rate Limit Fallback** - If OAuth hits rate limits, fall back to API key

All fallbacks record `TurnFallback` entries, which the UI displays via an amber indicator dot and a "Degradation" section in the usage tooltip.

---

## 1M Context Request Flow

When `extendedContext` is enabled:

1. `resolveModelConfig()` adds `[1m]` suffix to supported models (those with `supportsExtendedContext` in the catalog)
2. Beta header `anthropic-beta: context-1m-2025-08-07` is set
3. Per-turn `turnExtendedContext` flag is set for accurate context window reporting

The model suffix and header are always sent together. `agentMessageHandler` uses `turnExtendedContext` to calculate `contextWindow` (1M vs 200K) and `contextUtilization` for the usage tooltip.

### Key Code Locations

| Location | Purpose |
|----------|---------|
| `src/main/services/agentTurnExecutor.ts` | Sets `extendedContextEnabled`, beta header, calls `resolveModelConfig()` |
| `src/shared/utils/modelNormalization.ts` | `resolveModelConfig()`, `applyExtendedContextSuffix()` |
| `src/main/services/agentMessageHandler.ts` | Reports `contextWindow` and `contextUtilization` in result events |
| `src/main/services/agentTurnRegistry.ts` | Per-turn `turnExtendedContext` tracking |

---

## Fallback Chain: 1M Unavailable

When `isExtendedContextUnavailableError()` fires:

1. **OAuth + API key available** → Retry with API key auth, keep 1M. Records `TurnFallback(auth: OAuth → API Key)`.
2. **API key 1M also fails** → Strip `[1m]` suffix and beta header, retry at 200K. Records `TurnFallback(context: 1M → 200K)`.
3. **No API key** → Strip and retry at 200K directly. Records `TurnFallback(context: 1M → 200K)`.

The first turn in a conversation attempts 1M and exercises the full fallback chain. If 1M fails, session memory records the failure so subsequent turns skip 1M entirely (see [Session-Level Fallback Memory](#claude-max--1m-context-session-level-fallback-memory) above).

### Key Code Locations

| Location | Purpose |
|----------|---------|
| `src/shared/utils/modelNormalization.ts` | `isExtendedContextUnavailableError()`, `stripExtendedContextFromConfig()`, `stripExtendedContextHeader()` |
| `src/main/services/agentTurnExecutor.ts` | Catch block for 1M unavailable, OAuth→API key→200K retry chain |

---

## Fallback: Thinking Model Unavailable

When `isThinkingModelUnavailableError()` fires:

1. `handleThinkingModelFallback()` calls `downgradeThinkingModelConfig()` which swaps to `FALLBACK_PLANNING_MODEL` and strips `[1m]` if the fallback doesn't support extended context
2. Records `TurnFallback(model: <preferred> → <fallback>, reason: 'model-unavailable')`

---

## Fallback: Rate Limits (OAuth→API Key)

When OAuth hits Anthropic rate limits:

1. SDK throws `RATE_LIMIT_RETRY:` error
2. If user has API key configured, retries with API key auth
3. Records `TurnFallback(auth: OAuth → API Key, reason: rate-limit)`

### Key Code Locations

| Location | Purpose |
|----------|---------|
| `src/main/utils/authEnvUtils.ts` | `isUsingOAuth()`, `getApiKeyAuthEnvVars()` |
| `src/main/services/agentTurnExecutor.ts` | Rate limit detection and retry logic |
| `src/main/services/agentMessageHandler.ts` | Throws `RATE_LIMIT_RETRY:` errors |

---

## UI: Amber Indicator and Usage Tooltip

All fallbacks are visible to users:

- **Amber dot** on the database icon (`fallbackDot` in `MessageItem.tsx`) when any `TurnFallback` occurred
- **"Degradation" section** in `UsageTooltipContent.tsx` listing each fallback with type and from/to
- **Usage tooltip** always shows the *actual* model, context window (1M/200K), thinking effort, and auth method
- **"Settings changed since this turn"** drift detection highlights if user changed settings after a turn ran

---

## History: Lazy 1M Escalation (Removed)

Prior to 2026-02-08, a 4-state machine (`standard_200k` → `extended_1m_requested` → `extended_1m_active` / `blocked_no_1m`) deferred 1M requests until context utilization hit 50%+. This was removed because current Opus models support 1M natively and Anthropic only charges extra above 200K usage. See the planning docs linked above for full history.
