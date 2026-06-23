---
description: "Current model constants and normalization rules used by Rebel's provider-aware routing"
last_updated: "2026-06-11"
---

# Model Constants and Normalization

## Introduction

This document describes how model identifiers are managed across the codebase today. The canonical constants live in `src/shared/utils/modelNormalization.ts`, which defines the Anthropic defaults used by plan mode and direct-Claude routing while the wider app routes requests across Anthropic, OpenRouter, Codex, and profile-based providers.

Rebel supports multiple LLM providers, but `modelNormalization.ts` still matters because several core fallbacks, migrations, and plan-mode helpers use Claude-family aliases as their canonical defaults.


## See Also

**Claude constants & pricing:**
- `src/shared/utils/modelNormalization.ts` — **Canonical source** for Claude model constants and normalization logic
- `src/shared/utils/providerDefaultConstants.ts` — Provider-aware defaults, including the OpenRouter behind-the-scenes default
- `src/shared/utils/pricingCalculator.ts` — Model pricing tables (import models from here too)
- `src/shared/data/modelCatalog.ts` — Unified catalog from which Anthropic model options and legacy migrations are derived

**Rebel Core multi-provider architecture:**
- `src/core/rebelCore/modelClient.ts` — `ModelClient` interface: provider-neutral contract for query execution
- `src/core/rebelCore/clients/openaiClient.ts` — OpenAI-compatible client implementation (covers OpenAI, local proxies, etc.)
- `src/core/rebelCore/clients/anthropicClient.ts` — Anthropic client implementation
- `src/core/rebelCore/queryRouter.ts` — Provider-aware routing: maps model identifiers to the correct `ModelClient`
- `src/core/rebelCore/clientFactory.ts` — Client instantiation and caching

**Related docs:**
- [LOCAL_MODEL_SUPPORT](LOCAL_MODEL_SUPPORT.md) — Using alternative LLM models via proxy
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) — User-configurable model settings


## Key Principles

1. **Use aliases, not dated snapshots**: Anthropic model aliases (e.g., `claude-sonnet-4-6`) automatically resolve to the latest version. Avoid dated versions like `claude-sonnet-4-5-20241022` in code.

2. **Import from centralized constants**: Never hardcode model strings. Import from `@shared/utils/modelNormalization`:
   ```typescript
   import { DEFAULT_MODEL, DEFAULT_AUXILIARY_MODEL } from '@shared/utils/modelNormalization';
   ```

3. **User settings override defaults**: For user-facing model selection, respect `settings.claude.model`. Use constants only as fallbacks.


## Available Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `DEFAULT_MODEL` | `claude-sonnet-4-6` | Main agent model (when user hasn't configured) |
| `DEFAULT_AUXILIARY_MODEL` | `claude-haiku-4-5` | Claude-family auxiliary fallback for background tasks |
| `PREFERRED_PLANNING_MODEL` | `claude-opus-4-8` | Preferred planning/thinking model in plan mode |
| `FALLBACK_PLANNING_MODEL` | `claude-sonnet-4-6` | Fallback when the preferred planning model is unavailable |
| `PLAN_MODE_ALIAS` | `planner` | Internal alias that activates split planning/execution routing |
| `ENV_THINKING_MODEL` | `PLANNING_MODEL` | Env var used to inject the planning model into plan mode |
| `ENV_EXECUTION_MODEL` | `EXECUTION_MODEL` | Env var used to inject the execution model into plan mode |
| `MODEL_OPTIONS` | Array | Anthropic model options derived from `MODEL_CATALOG` for Anthropic-facing dropdowns |

> **Claude Fable 5 (2026-06-11):** `claude-fable-5` is in the catalog as a selectable top tier *above* Opus 4.8 (direct Anthropic + OpenRouter), but it deliberately changes **no default constant** — `PREFERRED_PLANNING_MODEL` stays `claude-opus-4-8`, `DEFAULT_MODEL` stays `claude-sonnet-4-6`, `DEFAULT_AUXILIARY_MODEL` stays `claude-haiku-4-5`. Promoting Fable to a default is a separate product decision (2× Opus price, safety-classifier refusals, 30-day retention requirement). Fable is also the first model with the `thinkingAlwaysOn` catalog flag (always-on adaptive thinking; sampling params rejected on the wire) — see [NEW_MODEL_SUPPORT_PROCESS](NEW_MODEL_SUPPORT_PROCESS.md) and `getThinkingModelDowngradeTarget()` in `modelNormalization.ts` for the unavailability downgrade ladder (Fable → Opus 4.8 → Sonnet 4.6). Plan: `docs/plans/260611_fable-5-support/PLAN.md`.


## Usage Patterns

### Main Agent Model
Uses the configured working model with the Anthropic default as fallback:
```typescript
const model = settings.claude?.model ?? DEFAULT_MODEL;
```

### Background/Behind-the-Scenes Tasks
Uses `behindTheScenesModel` setting. For OpenRouter, the default is now DeepSeek V4 Flash (`deepseek/deepseek-v4-flash`) rather than Haiku; `DEFAULT_AUXILIARY_MODEL` remains the Claude fallback when Anthropic routing needs a background model. The stored value may carry a `model:` prefix; always decode with `stripStoredModelPrefix()` before passing to a wire/RPC API:
```typescript
import { DEFAULT_AUXILIARY_MODEL } from '@shared/utils/modelNormalization';
import { stripStoredModelPrefix } from '@shared/utils/modelChoiceCodec';

const decoded = stripStoredModelPrefix(settings.behindTheScenesModel ?? '');
const model = decoded ?? DEFAULT_AUXILIARY_MODEL;
```

OpenRouter DeepSeek routing is compliance-gated by provider allowlists in `src/main/services/localModelProxyServer.ts`. The `deepseek/` allowlist excludes first-party China/Singapore routes, including Singapore-based DeepSeek providers such as NOVITA SG PTE. LTD.; update that allowlist deliberately if provider availability changes.

### Cost Calculation
Use the shared pricing calculator (which handles model alias resolution):
```typescript
import { calculateCost } from '@shared/utils/pricingCalculator';

const cost = calculateCost(model, inputTokens, outputTokens);
```


### Plan Mode

When Thinking and Working differ, `resolveModelConfig()` uses `PLAN_MODE_ALIAS` plus env overrides to split planning and execution:

```typescript
import {
  PLAN_MODE_ALIAS,
  ENV_THINKING_MODEL,
  ENV_EXECUTION_MODEL,
  PREFERRED_PLANNING_MODEL,
} from '@shared/utils/modelNormalization';
```

## Rebel Core: Provider-Neutral Routing

Rebel Core introduces a provider-agnostic layer on top of the Claude-specific constants above. The key abstraction is the `ModelClient` interface (`src/core/rebelCore/modelClient.ts`), which each provider implements.

**How model selection works in Rebel Core:**

1. User selects a model identifier (e.g., `claude-sonnet-4-6`, `gpt-4o`, a local model name)
2. `queryRouter.ts` inspects the identifier and delegates to the appropriate `ModelClient`
3. The client handles provider-specific API details (auth, streaming format, token counting)

Claude model constants (`DEFAULT_MODEL`, `DEFAULT_AUXILIARY_MODEL`, `PREFERRED_PLANNING_MODEL`, etc.) remain the defaults when no explicit provider override is configured. The normalization and migration logic in `modelNormalization.ts` applies to Claude identifiers only.

For implementation details, start at `src/core/rebelCore/queryRouter.ts` and follow the `ModelClient` interface.


## `behindTheScenesModel` Storage Encoding

`settings.behindTheScenesModel` stores model choices in a prefixed string form. The codec lives in `src/shared/utils/modelChoiceCodec.ts` — the **single source of truth** for both encode (write) and decode (read).

### Prefixed forms

| Stored value | Meaning |
|---|---|
| `model:<id>` | A specific model ID (e.g. `model:claude-haiku-4-5`). The `model:` prefix disambiguates from `profile:<id>` at storage boundaries. |
| `profile:<id>` | A profile reference — passed through unchanged to the BTS routing layer. |
| Bare model ID | Legacy form; also accepted (decoder handles both prefixed and bare). |

### Decoder requirement

**All callers that pass `behindTheScenesModel` to a wire/RPC API must first decode it** using `stripStoredModelPrefix()` from `modelChoiceCodec.ts` or `resolveBtsModel()` from `src/shared/utils/btsModelResolver.ts`. The raw stored value must not reach provider clients directly.

The decoder handles three cases:
- `model:<id>` → returns bare `modelId` (removes prefix)
- `profile:<id>` → returns as-is (profile refs flow to routing layer)
- Bare string → returns as-is (legacy compatibility)

### ESLint guardrail

`eslint-rules/no-raw-bts-model-read.js` blocks the dangerous flow shape: raw `settings.behindTheScenesModel` or `settings.behindTheScenesOverrides[...]` passed to routing/wire sinks without prior decode. Exceptions: codec internals and the per-task BTS overrides UI (`AgentsTab.tsx`).

### Spike verification

`scripts/spikes/bts-prefix-leak-end-to-end.ts` provides an end-to-end wire-level regression check. Run with `npm run spike:bts-prefix-leak` (env-gated; requires credentials).

### Forward-compatibility: `rebel-model://` URI scheme

Phase 2 (b) (tracked in [`docs/plans/260514_canonical_model_spec_string.md`](../plans/260514_canonical_model_spec_string.md)) will introduce a fully-qualified model-spec URI. The codec helpers in `modelChoiceCodec.ts` will be the natural extension point when that lands.

## What NOT to Do

```typescript
// BAD: Hardcoded dated snapshot (will become stale)
const model = 'claude-sonnet-4-20250514';

// BAD: Duplicate pricing table
const MODEL_PRICING = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  // ...
};

// GOOD: Import from shared module
import { DEFAULT_MODEL } from '@shared/utils/modelNormalization';
import { calculateCost } from '@shared/utils/pricingCalculator';
```


## Legacy Model Migration

`modelNormalization.ts` includes a `LEGACY_MODEL_MIGRATIONS` map that automatically migrates old dated model versions stored in user settings to current aliases. This runs during settings normalization.


## Adding New Models

When Anthropic releases new models:

1. Add the model to `MODEL_CATALOG` in `src/shared/data/modelCatalog.ts` — `MODEL_OPTIONS` derives from the catalog automatically
2. **(2026-04-28)** If the model also routes through OpenRouter, add the
   nested `openRouter: { id, sdkModel|pricingFollows, displayLabel,
   legacyOrIds? }` block on the same catalog entry. If the model should
   appear in the OR provider preset dropdown, also add nested
   `presetMetadata: { isMainModel: true, displayLabel }`. Both registries
   derive eagerly from the catalog at module load time — no separate
   edits to `openRouterModels.ts` or `modelProviderPresets.ts` are needed.
   The CI guard `validate:model-registry-consistency` (run as part of
   `validate:fast`) blocks merges that drift the registries.
3. Add pricing to `MODEL_PRICING` in `pricingCalculator.ts`
4. Add any legacy version mappings to `LEGACY_MODEL_MIGRATIONS`
5. Update `DEFAULT_MODEL`, `PREFERRED_PLANNING_MODEL`, or `FALLBACK_PLANNING_MODEL` if the new model should become a default
6. Update `applyExtendedContextSuffix()` if the new model supports 1M context
7. Update `help-for-humans/AI-models.md` and `help-for-humans/settings-and-configuration.md`


## UI Dropdown Options

Anthropic model selection dropdowns in Settings (`AgentsTab.tsx`) render from the `MODEL_OPTIONS` array in `modelNormalization.ts`. Each option has `isMainModel` and `isAuxiliaryModel` flags to control which dropdowns it appears in. OpenRouter and Codex use their own provider-specific option sets (`openRouterModels.ts`, `codexModels.ts`), so `MODEL_OPTIONS` is no longer a universal catalog for every provider.
