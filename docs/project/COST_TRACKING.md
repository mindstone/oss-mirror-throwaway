---
description: "How Rebel records, estimates, aggregates, and reports multi-provider AI usage costs."
last_updated: "2026-04-16"
---

# Cost Tracking

How Mindstone Rebel tracks and displays API usage costs.

---

## See Also

- [CONTEXT_MANAGEMENT.md](CONTEXT_MANAGEMENT.md) - Hub doc for the full context management system (compaction, caching, materialization, cost tracking)
- [ARCHITECTURE_CONTEXT_OVERFLOW_RECOVERY.md](ARCHITECTURE_CONTEXT_OVERFLOW_RECOVERY.md) - How context overflow triggers compaction and how costs are preserved during recovery
- `docs/research/libraries/CLAUDE_AGENT_SDK_REFERENCE.md` - Archived SDK reference (historical — SDK removed April 2026)
- `docs/plans/finished/251209_Cost_Visibility_Implementation_Plan.md` - Original implementation plan with detailed research
- `docs/plans/finished/251224_cost_ledger_implementation.md` - JSONL cost ledger implementation plan
- `src/shared/costCategories.ts` - **Cost category registry** (single source of truth for all categories, groups, labels)
- `src/core/services/costLedgerService.ts` - Persistent cost ledger (append-only JSONL; main-process shim re-exports this)
- `src/main/services/agentMessageHandler.ts` - Where agent turn cost data is extracted and written to ledger
- `src/shared/utils/usageAggregator.ts` - Core aggregation logic
- `src/shared/utils/usageHistoryUtils.ts` - Historical usage aggregation
- `src/shared/utils/usageFormatters.ts` - Display formatting utilities
- `src/renderer/features/settings/components/tabs/UsageTab.tsx` - Settings > Usage display
- `src/core/services/dailyCostReportingService.ts` - Daily cost summary reporting to analytics (main-process shim re-exports this)
- [ANALYTICS_DATA_DICTIONARY.md](./ANALYTICS_DATA_DICTIONARY.md#daily-cost-summary) - `Daily Cost Summary` event schema

---

## Overview

Rebel tracks AI usage costs across multiple auth and routing paths: direct Anthropic API keys, OpenRouter, ChatGPT Pro / Codex routing, direct provider profiles, and local models. Rebel Core normalizes these into a single `result` message shape with `total_cost_usd` and `modelUsage`, which the app then stores, aggregates, and displays across UI and analytics surfaces.

For agent turns, `total_cost_usd` is Rebel's canonical per-turn cost field. It prefers exact provider-reported cost when the upstream exposes one, and falls back to the unified local pricing catalog when only token counts are available. Auxiliary/background callers use the same pricing catalog to estimate costs from tokens.

All cost categories (agent turns, auxiliary services, automations, etc.) are defined in the **cost category registry** at `src/shared/costCategories.ts` (`COST_CATEGORY_REGISTRY`). This is the single source of truth for category metadata — UI grouping, labels, descriptions, and type definitions all derive from it.

### Data Flow

```
Provider call (Anthropic direct / OpenRouter / Codex / provider profile / local)
    ↓
Rebel Core client + agentMessageAdapter
    ├──► exact provider cost when exposed
    └──► pricingCalculator(modelCatalog) fallback when only tokens are available
    ↓
result message { usage: {...}, total_cost_usd, modelUsage: {...} }
    ↓
agentMessageHandler.ts
    ├──► AgentEvent → sessionStore.eventsByTurn (tokens, model - ephemeral)
    ├──► buildCompactModelUsage() → mu field (per-model breakdown)
    └──► appendCostEntry → cost-ledger.jsonl (cost + mu - persistent)
    ↓
UI aggregation
    ├── Ledger: total cost, turn count, per-model breakdown (always accurate, survives deletion)
    └── Sessions: token breakdown, model (when session available)
```

---

## JSONL Cost Ledger

Rebel uses an append-only JSONL ledger to persist costs independently of session data. This ensures historical spend is preserved even when sessions are deleted, compacted, or pruned.

### File Location

```
{app.getPath('userData')}/cost-ledger.jsonl
```

On macOS: `~/Library/Application Support/Mindstone Rebel/cost-ledger.jsonl`

### Schema

Each line is a JSON object with the following fields:

```typescript
interface CostLedgerEntry {
  ts: number;      // Unix timestamp (ms)
  cost: number;    // USD (e.g., 0.0234)
  sid?: string;    // Session ID (pointer for drill-down)
  tid?: string;    // Turn ID (pointer for drill-down)
  cat?: string;    // Category (absent = 'agent'; e.g., 'safety', 'memory', 'spacesSynthesis')
  m?: string;      // Model name snapshot (for attribution/debugging)
  mu?: Record<string, { in: number; out: number; cacheR?: number; cacheC?: number; cost?: number }>;
                   // Per-model usage breakdown (for multi-model turns, e.g., sub-agents)
  auth?: string;   // Auth method snapshot ('api-key', 'openrouter', 'codex-subscription', etc.)
  inTok?: number;  // Input tokens (absent for BTS entries and pre-migration entries)
  outTok?: number; // Output tokens (absent for BTS entries and pre-migration entries)
}
```

~70-150 bytes per entry depending on optional fields. 100k entries ≈ 8-15MB.

### Design Decisions

1. **Minimal schema:** Only stores what can't be derived elsewhere. Token counts and model details come from session data when available.

2. **Append-only:** Uses `fs.appendFile` for O(1) writes. No entry limit.

3. **Dangling pointers OK:** When a session is deleted, the ledger entry remains. The `sid`/`tid` fields become orphaned but the cost is preserved. UI shows "Details unavailable" for deleted sessions.

4. **Stream-based reads:** Aggregation uses readline streams for O(1) memory usage regardless of file size.

5. **Internal sessions excluded:** Memory updates, use-case discovery, and CLI sessions are not tracked.

6. **Entry validation:** Malformed, NaN, negative, or non-finite entries are skipped on read and rejected on write.

### What the Ledger Does NOT Store

- Workspace path
- Full cache token breakdown (cache read/creation tokens are in `mu` per-model entries but not as top-level fields)

Model (`m`), auth method (`auth`), aggregate tokens (`inTok`/`outTok`), and per-model breakdown (`mu`) are stored as lightweight snapshots. Detailed per-turn event data still comes from `eventsByTurn` when session data is available.

## Auth Attribution and Payment Buckets

Cost ledger entries snapshot the auth/routing method used for that call. The current auth values you should expect in the ledger and analytics are:

| Auth value | Meaning | Bucket |
|-----------|---------|--------|
| `api-key` | Direct Anthropic API key | User-paid |
| `oauth-token` | Legacy Claude subscription routing | Subscription-covered |
| `openrouter` | OpenRouter OAuth routing | User-paid |
| `codex-subscription` | ChatGPT Pro / Codex subscription routing | Subscription-covered |
| `profile-direct` | Direct provider-profile API usage | User-paid |
| `local` | On-device local model | Free / unbilled |
| `unknown` | Historical entries before auth attribution | Unattributed historical |

`calculateSubscriptionSavings()` in `src/shared/utils/authMethodDisplay.ts` rolls these auth methods into three reporting buckets used by the Usage tab and `Daily Cost Summary` analytics:

- `subscriptionCoveredUsd` — spend covered by a subscription-backed auth path
- `userPaidUsd` — spend billed directly to the user's API/provider account
- `freeUsd` — local or otherwise unbilled usage

---

## Agent Turn Cost Data

Rebel Core emits the following normalized usage fields on `result` messages regardless of provider. Some values come directly from upstream providers; others are synthesized from accumulated token usage when the provider does not expose exact billing data:

| Field | Description |
|-------|-------------|
| `input_tokens` | Tokens in the request prompt |
| `output_tokens` | Tokens in the model response |
| `cache_creation_input_tokens` | Tokens written to prompt cache |
| `cache_read_input_tokens` | Tokens read from prompt cache |
| `total_cost_usd` | Rebel's canonical per-turn cost in USD (exact when provider-reported, otherwise estimated from catalog pricing) |

**Key point:** `total_cost_usd` is not Anthropic-only anymore. `agentMessageAdapter.ts` prefers exact provider cost (`usage.cost`, Anthropic totals, etc.) when present, and otherwise computes a good-faith estimate from the unified model catalog in `src/shared/data/modelCatalog.ts`.

### Mapping in agentMessageHandler.ts

```typescript
// src/main/services/agentMessageHandler.ts (result message handling)
usage: {
  inputTokens: message.usage?.input_tokens ?? null,
  outputTokens: message.usage?.output_tokens ?? null,
  cacheCreationTokens: message.usage?.cache_creation_input_tokens ?? null,
  cacheReadTokens: message.usage?.cache_read_input_tokens ?? null,
  costUsd: message.total_cost_usd ?? null,
}

// Per-model breakdown (for multi-model turns with sub-agents)
const mu = buildCompactModelUsage(message); // → { 'claude-sonnet-4-6': { in, out, cost }, ... }
```

---

## UI Surfaces

### 1. Settings > Usage Tab

**Location:** `src/renderer/features/settings/components/tabs/UsageTab.tsx`

Displays aggregated usage with a hero metric and category breakdown:

- **Hero section:** Total cost with witty Rebel-voiced commentary, turn count, token totals, and subscription-covered vs user-paid breakdowns when available
- **Category breakdown:** Visual bars showing spend by grouped category:
  - `conversations` — Agent turns, chat, meetings, auto-continue, plugin AI, council
  - `automations` — Scheduled background automations
  - `fileIntelligence` — Enhancement, file indexing, semantic search, atlas insights, query generation
  - `safetyChecks` — Tool safety, memory write approval, auto-done safety
  - `memoryNotes` — Memory updates, coaching, scratchpad, spaces synthesis, evidence, space descriptions
  - `housekeeping` — Quips, time saved, metadata, system, compaction, and other background tasks
- **Daily breakdown:** Collapsible table (last 14 days)
- **Time period filter:** Last 24h (rolling), Last 7 Days, Last 30 Days, All Time
- **CSV export**

Raw ledger categories are grouped into these user-facing buckets via `groupForCategory()` from `src/shared/costCategories.ts` (called by `src/core/services/usageCostAnalysis.ts`).

### 2. "Behind the scenes" Drawer (Per-Turn)

**Location:** `src/renderer/features/agent-session/components/InsightsDrawer.tsx`

Shows per-turn metrics in the stats bar:
- Duration, Steps, Tool calls, Files, Errors
- **Context:** Context window utilization as percentage (e.g., "45%")
- **Cost:** Per-turn cost

#### Context Window Utilization

The "Context" metric shows what percentage of the context window was used for that turn's prompt:

```
contextUtilization = (inputTokens + cacheCreationTokens + cacheReadTokens) / contextWindow * 100
```

- **Standard context:** 200,000 tokens
- **Extended context (1M):** 1,000,000 tokens (when `settings.claude.extendedContext` is enabled)

The calculation uses a flag tracked per-turn in `agentTurnRegistry` rather than parsing the model string, which correctly handles:
- `opusplan` mode (where the `[1m]` suffix is in an env override, not the model string)
- Extended context fallback (when 1M isn't available for the user's account)

Context utilization is clamped to 100% maximum. Values approaching 100% indicate the conversation may trigger context overflow and compaction.

### 3. Session Tooltip (DEV mode)

Shows detailed token breakdown on hover in development builds.

---

## Aggregation Utilities

### usageAggregator.ts

```typescript
interface UsageStats {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  turnCount: number;
}

// Extract usage from a single turn's result event
extractTurnUsage(turnId, events): TurnUsage | null

// Sum usage across all turns in a session
aggregateSessionUsage(eventsByTurn): UsageStats

// Calculate cache efficiency percentage
getCacheEfficiencyPercent(stats): number
```

### usageHistoryUtils.ts

```typescript
interface UsageSummary {
  totalCostUsd: number;
  totalSessions: number;
  totalTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  dailyUsage: DailyUsage[];
  byOrigin: { manual: number; automation: number };
}

// Aggregate all sessions into historical summary
aggregateUsageHistory(sessions): UsageSummary

// Export to CSV format
exportUsageToCsv(summary): string
```

### usageFormatters.ts

```typescript
// Compact display: "—", "<1¢", "4¢", "$1.23"
formatCostCompact(costUsd): string

// Token display: "500", "1.2k", "1.5M"
formatTokenCount(tokens): string
```

---

## Auxiliary Service Cost Tracking

In addition to agent turn costs, Rebel tracks costs for background "auxiliary" services (tool safety, memory summarization, search indexing, etc.). These callers can run through direct Anthropic auth, OpenRouter/Codex routing, or provider profiles, but they all use the same cost-ledger pipeline.

### How It Works

Auxiliary services call `behindTheScenesClient.ts` (separate from the main Rebel Core agent loop). These calls generally rely on token counts plus the shared pricing catalog to estimate cost:

```
Provider Response → { input_tokens, output_tokens, ... } → pricingCalculator(modelCatalog) → Estimated Cost → Ledger
```

### Tracked Services

The canonical source for all cost categories is `COST_CATEGORY_REGISTRY` in `src/shared/costCategories.ts`. Below are the main services (43 tracked call sites total — see `docs/plans/260406_cost_tracking_audit_and_hardening.md` for the full inventory):

| Service | Category | Volume | Notes |
|---------|----------|--------|-------|
| Enhancement Service | `enhancement` | HIGH | Batched (50 chunks or 30s) |
| File Index (Contextual) | `fileIndex` | HIGH | Batched (50 chunks or 30s) |
| Tool Safety Evaluation | `safety` | MODERATE | Inline tracking |
| BTS Safety Evaluation | `safety` | MODERATE | Behind-the-scenes tool safety |
| Semantic Context (HyDE) | `semantic` | MODERATE | Inline tracking |
| Compaction Service | `compaction` / `compaction-bts` | MODERATE | Conversation compaction |
| Query Generation | `queryGeneration` | MODERATE | Pre-turn search query generation |
| Auto-Continue Hook | `autoContinue` | MODERATE | Automatic continuation evaluation |
| Bot Q&A Service | `meeting-qa` | MODERATE | Meeting bot Q&A responses |
| Atlas Search Insights | `atlas-insights` | MODERATE | AI-powered file analysis |
| Plugin AI Operations | `plugin-ai` | MODERATE | Plugin AI features |
| Spaces Synthesis | `spacesSynthesis` | LOW | Weekly activity summary (uses main model) |
| Memory Summary | `memory` | LOW | Background task |
| Memory Write Hook | `memoryWrite` | LOW | Evaluates memory writes |
| Auto-Done Safety | `done-safety` | LOW | Safety evaluation for auto-done |
| Time Saved Estimation | `timeSaved` | LOW | Per-turn calculation |
| Session Coaching | `coaching` | LOW | Generates insights |
| Quip Generator | `quip` | LOW | Generates persona quips |
| Scratchpad Organize | `scratchpad` | LOW | Note organization |
| Conversation Title | `metadata` | LOW | Title generation |
| Dashboard Handlers | `metadata` | LOW | Dashboard data generation |
| Meeting Summary | `meeting-summary` | LOW | Transcript summarisation |
| Meeting State | `meeting-state` | LOW | Meeting state tracking |
| Community Share | `communityShare` | LOW | Community share composition |
| Evidence Collection | `evidence` | LOW | Evidence collection from sessions |
| Public Channel Safety | `safety` | LOW | Public channel content safety |

**Negligible cost (tracked but minimal):**
- Health Check prompts (tracked as `system`, negligible cost)

### Batching for High-Volume Services

Enhancement and file indexing services can generate 10-20+ API calls per second during indexing. To avoid ledger bloat:

- Costs are accumulated in memory
- Flushed to ledger every 50 chunks OR every 30 seconds (whichever comes first)
- A single aggregated entry is written per flush with category (`cat`) and model (`m`)
- Pending costs are flushed on app shutdown via `app.on('will-quit')`

### UI Display

Auxiliary costs are grouped into user-facing categories and displayed alongside conversation costs in **Settings > Usage**. The grouping is defined in `COST_CATEGORY_REGISTRY` (`src/shared/costCategories.ts`) and applied by `groupForCategory()`:

| UI Category | Raw Ledger Categories |
|-------------|----------------------|
| `conversations` | `agent`, `conversation`, `chat`, `stt`, `council`, `adhoc-model`, `meeting-summary`, `meeting-qa`, `meeting-state`, `autoContinue`, `plugin-ai`, `error` |
| `automations` | `automation` |
| `fileIntelligence` | `enhancement`, `fileIndex`, `indexing`, `semantic`, `atlas-insights`, `queryGeneration` |
| `safetyChecks` | `safety`, `memoryWrite`, `done-safety` |
| `memoryNotes` | `memory`, `coaching`, `scratchpad`, `spacesSynthesis`, `evidence`, `spaceDescription` |
| `housekeeping` | `metadata`, `timeSaved`, `quip`, `system`, `warmup`, `compaction`, `compaction-bts`, `communityShare`, `hero-choice`, `bug-report-diagnostics`, `weekly_assessment`, `useCaseDiscovery`, `system-improvement`, `error-evaluation`, `archive-safety`, `foraging`, and any unknown categories |

All costs contribute to the total; the UI does not currently distinguish exact from estimated costs visually, but analytics does preserve the auth split and the ledger can mark estimated abort recoveries via `est: true`.

### Pricing Catalog

Costs are calculated using `src/shared/utils/pricingCalculator.ts`, which derives pricing from the unified model catalog in `src/shared/data/modelCatalog.ts` rather than a hardcoded Anthropic-only table in this doc.

The pricing catalog covers the model families Rebel can currently price locally (including Anthropic, OpenAI-compatible, Google, DeepSeek, xAI, Cerebras, and OpenRouter aliases that resolve back to catalog models). Unknown/local models return `null` and are either skipped or treated as free, depending on the auth path.

**Updating prices:** Update `src/shared/data/modelCatalog.ts`. `pricingCalculator.ts` derives `MODEL_PRICING` and alias maps automatically. A **CI zero-pricing informational check** (`scripts/check-model-pricing.ts`) warns when catalog models have no pricing entry, catching gaps before they reach production.

**Stricter `calculateCost()` behavior:** `calculateCost()` now **throws** on invalid token data (NaN, negative, Infinity) — always a bug upstream. It returns `null` only for unknown models (expected for custom/local models). For fire-and-forget call sites, use `calculateCostOrWarn()` which wraps the function with try/catch and centralized warn-once logging.

**Council pricing warning deduplication:** `councilService.ts` tracks a per-process `_warnedUnpricedModels` set to prevent repeated warnings for the same unpriced model across turns.

### CostTier for BYOK Orchestration

`ModelProfile` includes an optional `costTier` field (`'economy' | 'mid-tier' | 'premium'`) for cost-aware routing in BYOK (bring-your-own-key) scenarios. When omitted, the tier is auto-resolved from `MODEL_CATALOG` pricing data. This enables orchestration logic (e.g., forager subagent model selection) to pick appropriately-priced models without hardcoding provider-specific heuristics.

**Code:** `CostTier` type in `src/shared/types/settings.ts`, auto-resolution in `src/shared/utils/pricingCalculator.ts`.

### Models with Unknown Pricing

When `use-alternative` is enabled (local models or custom endpoints), auxiliary costs are **not tracked** because pricing is unknown. The pricing calculator returns `null` for unrecognized models, and no ledger entry is written.

---

## Known Limitations & Edge Cases

### 1. Session Deletion Loses Cost Data — ✅ RESOLVED

**Status:** Resolved with JSONL cost ledger (December 2024).

**Previous impact:** When a user deleted a conversation, its cost data was permanently lost.

**Resolution:** Cost is now persisted in `cost-ledger.jsonl` independently of session data. Deleting a session no longer affects historical cost totals. The ledger entry's `sid`/`tid` fields become orphaned but the cost is preserved.

### 2. Session Limit (1000) Prunes Old Data — ⚠️ PARTIALLY RESOLVED

**Status:** Partially resolved with JSONL cost ledger (December 2024).

**Previous impact:** When the 1000-session limit was reached, old sessions were pruned, losing their cost data.

**Resolution:** Cost totals are preserved in the ledger. However, token counts and model details are still lost when sessions are pruned (by design—the ledger only stores cost).

**Remaining impact:** Historical token breakdown is unavailable for pruned sessions. Users see accurate total spend but "Details unavailable" for tokens/model.

### 3. Token/Model Details Unavailable After Session Deletion

**Impact:** After a session is deleted, compacted, or pruned, the ledger preserves the cost but cannot retrieve token counts or model information.

**Why:** By design, the ledger stores only `{ ts, cost, sid?, tid? }` to keep entries minimal (~60 bytes). Token and model details come from `eventsByTurn` which no longer exists.

**UI behavior:** Settings > Usage shows accurate total cost from ledger, but displays "Details unavailable" for token breakdown on affected entries.

### 4. Context Compaction Clears Turn Events — ⚠️ PARTIALLY RESOLVED

**Impact:** When context overflow triggers compaction, `eventsByTurn` is cleared for the session. This loses **token/model details** for turns prior to compaction, but **cost is preserved** in the ledger.

**Why:** Compaction creates a fresh conversation context. The old turn events (including result events with usage) are discarded from session storage. However, the cost was already appended to the JSONL ledger when the turn completed, so total spend remains accurate.

**Code:** `src/renderer/features/agent-session/store/sessionStore.ts` - `performCompaction()` sets `eventsByTurn: {}`

**What's preserved:** Total cost (from ledger)
**What's lost:** Token breakdown, model info, per-turn details (from cleared session events)

### 5. Cancelled/Aborted Turns and Retry Costs — ⚠️ MOSTLY RESOLVED

**Status:** Mostly resolved (April 2026). Abort cost recovery now captures costs for most cancelled turns.

**How it works:** When a user aborts a turn, `agentQueryRunner.ts` attempts cost recovery in two ways:
1. **Late result extraction:** If a `result` message arrives after abort is signalled (common — the API often sends the final result before the abort propagates), the exact `total_cost_usd` is captured.
2. **Estimation from accumulated tokens:** If no late result arrives but tokens were accumulated during the turn, costs are estimated from the accumulated `inputTokens`/`outputTokens` using the local pricing calculator. These entries are marked with `est: true` in the ledger.

**Remaining gaps:**
- Retry attempts (e.g., `empty_result_anomaly`, `isExtendedContextUnavailableError`) still only record the final successful retry's cost — intermediate failed attempts are not tracked.
- If abort happens very early (before any tokens are accumulated), no cost is recorded.

**Sub-agent cost on abort:** ✅ **Fixed** (April 2026). `executeAgentTool()` in `agentTool.ts` now bubbles partial sub-agent usage via `onSubAgentComplete` on all paths including abort. Previously, sub-agent tokens consumed before the user hit Stop were silently dropped.

**Code:** `src/main/services/agentQueryRunner.ts` — late result extraction and estimation in the `finally` block; `src/core/rebelCore/agentTool.ts` — sub-agent cost bubbling

### 6. Chat Mode Costs Not Tracked

**Impact:** Conversations in "chat" mode (simple completion, no tools) show "—" for cost and don't contribute to totals.

**Why:** The chat completion service explicitly sets `costUsd: null`. The chat completion path doesn't return `total_cost_usd` the way the main agent loop does.

**Code:** `src/main/services/chatCompletionService.ts (path removed — verify)` - `usage: { ..., costUsd: null }`

### 7. Sub-agent Costs — ⚠️ MOSTLY RESOLVED

**Status:** Per-model breakdown is now preserved in the cost ledger (April 2026).

**Impact:** Since Stages 5/8 (April 2026), Rebel Core sub-agent costs are merged into the parent turn's `usageByModel` map via `adapter.mergeSubAgentUsage()`. The `agentMessageHandler.ts` now writes a `mu` (model usage) field to cost ledger entries via `buildCompactModelUsage()`, preserving per-model token and cost breakdown.

- **Total cost is accurate** — sub-agent token usage is included in `total_cost_usd` and the cost ledger.
- **Per-model breakdown is preserved in the ledger** — the `mu` field contains a map of `{ model: { in, out, cacheR?, cacheC?, cost? } }` entries for each model used in the turn.
- **Per-model breakdown is not yet surfaced in the UI** — Settings > Usage and diagnostics still show aggregated totals or joined model strings.

**What's visible where:**

| Surface | Sub-agent cost included? | Per-model breakdown? |
|---------|--------------------------|---------------------|
| Cost ledger (`cost-ledger.jsonl`) | Yes | Yes (`mu` field has per-model map) |
| `agentMessageHandler` result event | Yes (aggregate) | Joined model string in `m`, structured in `mu` |
| Settings → Usage | Yes (in totals) | No (not yet surfaced from `mu`) |
| Diagnostics panel | Yes (in turn cost) | No (shows "Mixed" or joined string) |
| `Cost Incurred` analytics event | Yes | Yes (multi-model properties when applicable) |
| `Agent Turn Completed` analytics | Yes + `subAgentCount` | No per-model cost split |
| `Daily Cost Summary` analytics | Yes (in totals) | Yes (`byModel` JSON map) |

**Code:** `src/main/services/agentMessageHandler.ts` (`buildCompactModelUsage`, cost extraction), `src/core/rebelCore/agentTool.ts` (`onSubAgentComplete`).

**Known gap:** `pricingModelResolved` in analytics (`src/renderer/src/tracking.ts`) uses only the first model from a joined string, so mixed-model turns are attributed to the orchestrator model for pricing metadata.

**Parallel sub-agent fan-out:** When the orchestrator dispatches up to `PARALLEL_AGENT_CAP` sub-agents concurrently (see `docs/plans/260503_parallel_plan_execution.md`), each `onSubAgentComplete` call merges that sub-agent's `usageByModel` into the same parent `MutableSubAgentUsage` map. This is race-safe because Node/Electron's single-threaded JS event loop serializes the synchronous `Map.get` / per-model addUsage / `Map.set` sequence inside `mergeSubAgentUsage()` — only one settlement runs to completion before the next is scheduled — so concurrent settlements cannot interleave reads and writes on the same key. Per-model cost merging therefore yields the same totals whether sub-agents run sequentially or in parallel.

**See also:** [Planning doc](../plans/260405_foraging_subagent.md) Stages 5/8 for implementation details and design constraints.

### 8. Null vs Zero Cost Ambiguity

**Impact:** The UI shows "—" for both `null` (unknown/unavailable) and `0` (genuinely zero) costs. Users cannot distinguish between "cost unknown" and "free".

**Code:** `src/shared/utils/usageFormatters.ts` - `if (costUsd == null || costUsd === 0) return '—';`

### 9. UTC vs Local Timezone

**Impact:** Daily usage breakdown uses UTC dates (`toISOString().split('T')[0]`), which may not match user expectations for "today".

**Code:** `src/shared/utils/usageHistoryUtils.ts` - daily grouping

### 10. Period Filter vs Daily Grouping Mismatch

**Impact:** The Usage tab filters by `updatedAt` but groups by `createdAt`. A session created 40 days ago but updated today would appear in "Last 30 Days" but contribute to the day it was created.

**Code:**
- Filter: `src/renderer/features/settings/components/tabs/UsageTab.tsx` - `s.updatedAt >= cutoff`
- Group: `src/shared/utils/usageHistoryUtils.ts` - `new Date(session.createdAt)`

### 11. Auxiliary Costs Are Estimates (Not Necessarily Provider-Reported)

**Impact:** Costs for auxiliary services (tool safety, memory, indexing, etc.) are usually calculated locally using the pricing catalog, not copied from a provider-reported `total_cost_usd` field the way normal agent turns are.

**Why:** Auxiliary services run through `behindTheScenesClient.ts`, which works from token counts and auth/model resolution rather than a standardized exact-cost field. Costs therefore need to be estimated from the shared pricing catalog.

**Implications:**
- May drift slightly from actual billing if provider pricing changes and the local catalog isn't updated
- Rounding differences may accumulate over many calls
- Grouped with other costs in UI (no visual distinction from exact costs)

**See:** [Auxiliary Service Cost Tracking](#auxiliary-service-cost-tracking) section for details.

### 12. Alternative/Local Model Costs Not Tracked

**Impact:** When `use-alternative` is enabled (local models, custom endpoints, or unknown model identifiers), auxiliary service costs are not tracked at all.

**Why:** The pricing calculator cannot determine costs for models outside the known pricing catalog. Rather than guess, these calls are skipped entirely.

**Code:** `src/shared/utils/pricingCalculator.ts` — `calculateCost()` returns `null` for unknown models (throws on invalid token data — always a bug). See [Pricing Catalog](#pricing-catalog) for behavior details.

---

## Potential Improvements

### Short-term

1. **Preserve cost on compaction:** ⚠️ PARTIALLY ADDRESSED — Cost is now preserved via the JSONL ledger. Token/model details are still lost on compaction. A rolled-up usage snapshot could preserve token breakdown.

2. **Capture partial costs on abort:** ✅ **MOSTLY IMPLEMENTED** (April 2026) — `agentQueryRunner.ts` now extracts costs from late result messages and estimates from accumulated tokens when aborted. See [Known Limitation #5](#5-cancelledaborted-turns-and-retry-costs--️-mostly-resolved). Remaining gap: retry attempt costs.

3. **Distinguish null vs zero:** Use "?" or "N/A" for unknown costs instead of conflating with "—" (zero).

4. **Local timezone for daily grouping:** Use user's local date instead of UTC for more intuitive "today/yesterday" reporting.

### Medium-term

1. **Append-only usage ledger:** ✅ **IMPLEMENTED** (December 2024) — See [JSONL Cost Ledger](#jsonl-cost-ledger) section above. Cost now persists in `cost-ledger.jsonl` independent of session lifecycle.

2. **Estimate chat mode costs:** Calculate estimated cost from token counts + model pricing tables when `total_cost_usd` is unavailable.

3. **Per-model cost breakdown in the UI:** ⚠️ **PARTIALLY IMPLEMENTED** — Per-model data is now persisted in the cost ledger's `mu` field via `buildCompactModelUsage()` in `agentMessageHandler.ts`. The remaining work is surfacing this in the UI: `usageHandlers.ts` (IPC response), `UsageTab.tsx` (per-model display columns), and diagnostics panel (per-model cost split).

### Long-term

1. **Usage dashboards:** Charts and visualizations for spending trends over time.

2. **Budget alerts:** Notify users when approaching configurable spending thresholds.

3. **Per-workspace cost tracking:** Attribute costs to different workspaces for multi-project users.

---

## Cost Accuracy

### What's Accurate

- **Agent turn costs:** `total_cost_usd` is the canonical per-turn field. It is exact when the provider surfaces cost directly and otherwise a catalog-based estimate produced by Rebel Core.
- **Total cost (agent turns):** The JSONL ledger provides accurate historical totals that survive session deletion, compaction, and pruning.
- **Session costs:** Sum of all turn costs in a session (when session data is available).
- **Cache metrics:** `cache_creation_input_tokens` and `cache_read_input_tokens` are accurate when session data exists.

### What's Estimated (Good-Faith Approximations)

- **OpenAI-compatible / provider-profile turn costs when no exact cost is exposed:** Estimated from `modelCatalog` pricing.
- **Auxiliary service costs:** Calculated locally from token counts using the shared pricing catalog. See [Auxiliary Service Cost Tracking](#auxiliary-service-cost-tracking).
- **Batched costs:** Enhancement and file indexing costs are aggregated before writing to ledger. Timing of flush may vary.

### What May Underreport

- **Cancelled turns:** Mostly recovered via late-result extraction and token estimation (see [Known Limitation #5](#5-cancelledaborted-turns-and-retry-costs--️-mostly-resolved)). Small gap remains for very early aborts and retry intermediate attempts.
- **Chat mode:** Always shows "—" regardless of actual cost.
- **API errors:** Error results may not include usage data.
- **Pre-ledger history:** Costs from before the ledger was introduced are not backfilled.
- **Alternative models:** Costs not tracked when using `use-alternative` (unknown pricing).

### Verification

Users can cross-check against the relevant upstream surface for their auth path:

- **Anthropic API key** → Anthropic Console billing/usage
- **OpenRouter** → OpenRouter credits / usage dashboard
- **ChatGPT Pro / Codex subscription** → covered usage is local-to-Rebel accounting rather than a per-turn pay-as-you-go bill
- **Local models** → no provider bill; costs appear only in Rebel's local accounting when estimated for comparison

---

## Analytics Reporting

Cost data is reported to RudderStack/PostHog for org-level aggregation via the `Daily Cost Summary` event.

**How it works:**
- On app startup, aggregates costs from the local ledger by UTC date
- Sends one event per unreported day (up to yesterday, never "today")
- Limited to 90-day backfill on first run
- Uses idempotency key for deduplication
- Includes auth attribution (`byAuthMethod`) so org analytics can split spend by subscription-covered, user-paid, and local/free routes

**Source:** `src/core/services/dailyCostReportingService.ts`

**Event details:** See [`Daily Cost Summary` in ANALYTICS_DATA_DICTIONARY.md](./ANALYTICS_DATA_DICTIONARY.md#daily-cost-summary) for full property schema.

**What the Daily Cost Summary includes:**

| Data | Property | Notes |
|------|----------|-------|
| Total cost | `totalCostUsd` | From ledger |
| Turn count | `turnCount` | Agent turns only |
| Raw categories | `byCategory` | Raw ledger categories |
| Grouped UX categories | `byCategoryGrouped` | Matches local Usage tab (conversations, automations, memoryNotes, etc.) via `groupCategories()` |
| Per-model costs | `byModel` | JSON-serialized model→cost map |
| Auth method split | `byAuthMethod` | api-key, oauth-token, openrouter, codex-subscription, profile-direct, local, etc. |
| Subscription savings | `subscriptionCoveredUsd`, `userPaidUsd`, `freeUsd` | Three-way cost partition |
| Token totals | `totalInputTokens`, `totalOutputTokens`, `totalCacheReadTokens`, `totalCacheCreationTokens`, `totalPromptTokens` | Daily aggregates from ledger |
| Session count | `activeSessionCount` | Unique non-internal sessions (count only, no IDs) |
| Automation breakdown | `byAutomationType` | Per automation-type costs |

**What the Daily Cost Summary does NOT include (deliberately):**

Period-level metrics (`projectedMonthCost`, `avgCostPerActiveDay`, `peakDay`, period-over-period comparison) are computed locally for the Usage tab but not sent to PostHog — they can be derived from daily data via date range queries.

**Privacy:** All properties are aggregate numeric data. No session IDs, conversation titles, memory file names, or user content are sent.

**Note:** This reports from the local ledger, which captures ~99% of costs. The ~1% gap (cancelled turns, chat mode) is documented in [Known Limitations](#known-limitations--edge-cases) above.

---

## Testing

Unit tests for aggregation logic: `src/shared/utils/__tests__/usageAggregator.test.ts`

Tests cover:
- Empty eventsByTurn handling
- Single and multiple turn aggregation
- Null/undefined value handling
- Cache efficiency calculation

---

## Adding New Cost-Producing Features

When adding new features that incur API costs, follow these conventions to ensure costs are properly tracked and displayed in Settings > Usage.

### Session ID Naming Conventions

**Critical:** The `agentTurnExecutor.ts` categorizes costs based on session ID prefixes:

| Session ID Pattern | Category | Appears In |
|--------------------|----------|------------|
| `automation-{type}--{uuid}` | `automation` | Automations bar |
| `memory-update-{uuid}` | `memory` | Memory & Notes bar |
| `meeting-qa-{uuid}` | `conversation` | Conversations bar |
| `meeting-analysis-{uuid}` | `conversation` | Conversations bar |
| `{uuid}` (bare UUID) | `conversation` | Conversations bar |

**For automations:** Always use the format `automation-{type}--{uuid}` where `type` is the automation's `systemType` or `id`. This ensures:
1. Costs are categorized as `automation` (not `conversation`)
2. The automation type appears in the Usage tab's Automations tooltip
3. Automations are excluded from "Most expensive conversation" record

**Example:**
```typescript
// Good - properly prefixed
const sessionId = `automation-${automation.systemType ?? automation.id}--${randomUUID()}`;

// Bad - bare UUID gets categorized as conversation
const sessionId = randomUUID();
```

### Cost Ledger Schema

When costs are recorded via `appendCostEntry()`, the following fields affect UI display:

| Field | Purpose | Example |
|-------|---------|---------|
| `cat` | Determines UI category grouping | `'automation'`, `'safety'`, `'memory'` |
| `sid` | Session ID, parsed for automation-type breakdown | `'automation-calendar-sync--abc123'` |
| `tid` | Turn ID, for drill-down if needed | UUID |
| `auth` | Auth attribution for analytics rollups | `'oauth-token'`, `'api-key'` |

### UI Category Mapping

Categories are defined in `COST_CATEGORY_REGISTRY` (`src/shared/costCategories.ts`) and grouped by `groupForCategory()`. See [Auxiliary Service Cost Tracking > UI Display](#ui-display) for the full mapping.

### Checklist for New Features

When adding a new cost-producing feature:

- [ ] **Add category to `COST_CATEGORY_REGISTRY`** in `src/shared/costCategories.ts` — this is the **only** place to update. The type union, UI group, label, description, and tests all derive from the registry automatically.
- [ ] **Session ID follows naming convention** - Use `automation-{type}--{uuid}` for automations
- [ ] **Cost category is correct** - Verify `agentTurnExecutor.ts` assigns the right `cat`
- [ ] **Add to `AUTOMATION_TYPE_LABELS`** if adding a new automation type (for tooltip)
- [ ] **Add unit test** verifying the cost appears in the expected UI category
- [ ] **Test "Most expensive conversation"** - verify your feature doesn't appear if it shouldn't

### Helper Function (Recommended)

For consistency, consider using a helper when creating automation session IDs:

```typescript
// Suggested: Add to src/main/services/automationScheduler.ts or shared utils
const createAutomationSessionId = (type: string): string => 
  `automation-${type}--${randomUUID()}`;
```

### Historical Context

**Why this matters:** In January 2026, we discovered that the Calendar Sync automation used a bare `calendar-sync` session ID (not matching the `automation-*` prefix), causing:
1. $100+ of automation costs appearing as "Most expensive conversation"
2. Users confused by a "conversation" they couldn't find in history
3. Automation costs hidden in the Conversations category instead of Automations

See `docs/plans/finished/260123_usage_tab_cost_bugs.md` for the full bug analysis and fix.
