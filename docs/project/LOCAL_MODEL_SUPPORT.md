---
description: "Local and alternative model profiles — proxy architecture, BYO 'Models on your machine' wizard, dual-translator reasoning-replay invariants, BTS routing"
last_updated: "2026-05-17"
---

# Local Model Support

## Introduction

Mindstone Rebel's AI stack is provider-first: users choose a primary provider card in Settings (**Anthropic**, **ChatGPT Pro / Codex**, or **OpenRouter**) and can attach local or alternative model profiles for specific routes. Those profiles use an Anthropic ↔ OpenAI translation layer so Rebel Core can talk to any OpenAI-compatible model server (DS4, LM Studio, Ollama, LocalAI, Together.ai, ...) without needing a separate agent runtime.

There are two delivery paths to a local server:

- **Models on your machine** wizard (DS4 / LM Studio / Ollama-custom / llama.cpp presets) — for BYO servers the user runs themselves. Stamped `providerType: 'other'` + `routeSurface: 'local'` + `presetKey: 'local:*'`. See [§ BYO local-inference presets](#byo-local-inference-presets-models-on-your-machine) below.
- **Bundled Ollama runtime** (Settings → Local inference, `LocalInferenceSection.tsx`) — for the Rebel-managed Ollama install with curated catalog. Stamped `providerType: 'local'`. The `experimental.localInferenceEnabled` flag gates this UI only.

The two paths are siblings, not competitors: the same loopback transport runs both, but the bundled path additionally manages Ollama process lifecycle and injects `options.num_ctx` into outbound requests, while BYO assumes the user owns their server.

The translation layer itself comes in two shapes that share invariants (see [BOUNDARY_REGISTRY](./BOUNDARY_REGISTRY.md) → `local-openai-compatible-translation`):

- **Desktop proxy translator** (`src/main/services/localModelProxyServer.ts`) — used by the regular Rebel chat flow when a local profile is selected. Runs an HTTP proxy on `127.0.0.1:18765` that intercepts Rebel Core's Anthropic-format internal requests and translates them to OpenAI Chat Completions format.
- **Core-client translator** (`src/core/rebelCore/clients/openaiTranslators.ts`) — used by Rebel Core's direct OpenAI-compatible client (the path eval bundles flow through). No proxy hop; direct translation in the same process.

Both translators share the same `supportsReasoningReplay`-gated `reasoning_content` invariants and the same bounded late-reasoning buffer policy ([§ Key design decisions](#key-design-decisions)).

**Status**: Experimental. Tool calling works well with capable models (e.g., DeepSeek V4 Flash via DS4, DeepSeek V3, Qwen); smaller models (<13B) struggle with reliable multi-step tool sequences.

## Where profiles fit in the provider system

- **Provider cards** (**Anthropic**, **ChatGPT Pro / Codex**, **OpenRouter**) define the app's primary working / thinking / background routing defaults.
- **Local or alternative profiles** add explicit profile-based routes for local inference or direct OpenAI-compatible providers that sit outside those three first-class setup paths.
- **The proxy documented here** is the bridge used only for those profile-based routes. Anthropic direct, OpenRouter passthrough, and Codex passthrough remain separate first-class paths in the wider routing system.


## See Also

- [MODEL_AND_PROVIDER_OVERVIEW](MODEL_AND_PROVIDER_OVERVIEW.md) — territory hub; [PROVIDER_RESOLUTION_AND_ROUTING](PROVIDER_RESOLUTION_AND_ROUTING.md), [PROVIDER_REQUEST_PARAM_MATRIX](PROVIDER_REQUEST_PARAM_MATRIX.md), and [PROXY_AUTH_BOUNDARY](PROXY_AUTH_BOUNDARY.md) own the routing / request-shaping / auth-boundary slices of the proxy this doc describes
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) — Canonical reference for all app settings including model configuration
- [SYSTEM_ARCHITECTURE](ARCHITECTURE_OVERVIEW.md) — High-level system architecture and component responsibilities
- [MCP_CONFIGURATION](MCP_ARCHITECTURE.md) — MCP tool configuration (local models work with MCP tools)
- [BOUNDARY_REGISTRY](./BOUNDARY_REGISTRY.md) → `local-openai-compatible-translation` and `wizard-provider-presets` — dual-translator contract and BYO preset save-shape invariant
- [`docs/plans/260516_ds4_local_model_integration_and_evals.md`](../plans/260516_ds4_local_model_integration_and_evals.md) — full design rationale for the BYO wizard, rejected alternatives, stage-by-stage implementation, failure-mode matrix
- [`docs-private/investigations/260516_ds4_reasoning_content_replay_validation.md`](../../docs-private/investigations/260516_ds4_reasoning_content_replay_validation.md) — Stage 0 spike that empirically falsified the worst-case `reasoning_content` replay assumptions on DS4
- [`evals/AGENTS.md`](../../evals/AGENTS.md) § Local-model eval setup — eval-CLI invocation against local-server profiles
- Upstream DS4: <https://github.com/antirez/ds4>
- `src/main/services/localModelProxyServer.ts` — Desktop proxy server + translator
- `src/core/rebelCore/clients/openaiTranslators.ts` — Core-client translator (used by evals)
- `src/shared/utils/reasoningCapability.ts` — `computeSupportsReasoningReplay`, `getThinkingRetentionTurns`, allow-list patterns
- `src/shared/utils/profileHelpers.ts` — `isLoopbackRoutableProfile`, `isBundledOllamaProfile` predicates
- `src/shared/data/modelProviderPresets.ts` — `LOCAL_INFERENCE_PRESETS` (single source of truth for BYO presets)
- `src/main/services/behindTheScenesClient.ts` — Background task LLM client with proxy routing
- `src/shared/types/settings.ts` — `ModelProfile`, `LocalModelSettings`, `RouteSurface`, `presetKey` type definitions


## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Electron Main Process                        │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │      Rebel Core / provider-aware route execution          │  │
│  │  (emits Anthropic-format internal requests on this path)  │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     │                                           │
│                     │ Anthropic Messages API                    │
│                     │ (ANTHROPIC_BASE_URL → localhost)          │
│                     ▼                                           │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │         Local Model Proxy Server                          │  │
│  │         (http://127.0.0.1:18765)                          │  │
│  │                                                           │  │
│  │  • Receives Anthropic-format requests                     │  │
│  │  • Translates to OpenAI Chat Completions format           │  │
│  │  • Forwards to configured model server                    │  │
│  │  • Translates responses back to Anthropic format          │  │
│  └──────────────────┬───────────────────────────────────────┘  │
│                     │                                           │
└─────────────────────┼───────────────────────────────────────────┘
                      │ OpenAI Chat Completions API
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              Local/Alternative Model Server                     │
│                                                                 │
│  Examples:                                                      │
│  • DS4 (http://127.0.0.1:8000)                                 │
│  • LM Studio (http://localhost:1234)                           │
│  • Ollama (http://localhost:11434)                             │
│  • Together.ai, OpenRouter, etc.                               │
└─────────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Proxy startup**: When a local/alternative profile is selected for a route, Rebel starts the translation proxy on `127.0.0.1:18765` (or next available port)
2. **API redirection**: Rebel Core's proxy-compatible request path is configured with `ANTHROPIC_BASE_URL` pointing to the proxy
3. **Request translation**: Incoming Anthropic Messages API requests are translated to OpenAI Chat Completions format
4. **Response translation**: OpenAI-format responses are translated back to Anthropic format before returning to Rebel Core

### Request Translation

The proxy translates these Anthropic concepts to OpenAI equivalents:

| Anthropic Format | OpenAI Format |
|------------------|---------------|
| `messages[].role: 'user'/'assistant'` | Same |
| `system` (string or blocks) | `messages[0].role: 'system'` |
| `content[].type: 'text'` | `content` (string) |
| `content[].type: 'tool_use'` | `tool_calls[]` |
| `content[].type: 'tool_result'` | `role: 'tool'` message |
| `content[].type: 'thinking'` (when gated) | `reasoning_content` (sibling of `content`) |
| `tools[]` with `input_schema` | `tools[].function.parameters` |
| `tool_choice.type: 'auto'/'any'/'tool'` | `tool_choice: 'auto'/'required'/{function}` |

### Response Translation

| OpenAI Format | Anthropic Format |
|---------------|------------------|
| `choices[0].message.content` | `content[].type: 'text'` |
| `choices[0].message.reasoning_content` | `content[].type: 'thinking'` |
| `choices[0].message.tool_calls[]` | `content[].type: 'tool_use'` |
| `finish_reason: 'stop'` | `stop_reason: 'end_turn'` |
| `finish_reason: 'tool_calls'` | `stop_reason: 'tool_use'` |
| `finish_reason: 'length'` | `stop_reason: 'max_tokens'` |

### Streaming Support

The proxy fully supports streaming responses, translating OpenAI's SSE chunks to Anthropic's streaming event format:

- `message_start` — Initial message metadata
- `content_block_start/delta/stop` — Streamed text, reasoning, and tool use
- `message_delta` — Stop reason and final usage stats
- `message_stop` — Stream completion


## Supported Models and Providers

Any model server that implements the OpenAI Chat Completions API (`/v1/chat/completions`) should work, including:

### Local Servers
- **DS4** — antirez's [DwarfStar 4](https://github.com/antirez/ds4), a DeepSeek V4 Flash–specific engine. Default URL: `http://127.0.0.1:8000/v1`. First-class BYO preset.
- **LM Studio** — Default URL: `http://localhost:1234`
- **Ollama** — Default URL: `http://localhost:11434`
- **LocalAI** — Default URL: `http://localhost:8080`
- **vLLM** — Configurable port
- **llama.cpp** — OpenAI-compatible mode; default URL: `http://localhost:8080`

### Cloud Providers (OpenAI-compatible)
- **Together.ai** — `https://api.together.xyz`
- **OpenRouter** — `https://openrouter.ai/api`
- **Groq** — `https://api.groq.com/openai`
- **Fireworks.ai** — `https://api.fireworks.ai`

### Model Recommendations

For best results with tool calling and agentic workflows:

| Model | Tool Calling | Notes |
|-------|--------------|-------|
| DeepSeek V4 Flash (DS4 local) | Excellent | 1M context, reasoning support; runs on 96–128 GB Macs at q2-imatrix |
| DeepSeek V3 | Excellent | Best open-weight option for complex tool use |
| Qwen 2.5 72B | Very Good | Strong tool calling, fast inference |
| Llama 3.3 70B | Good | Solid tool calling support |
| Mixtral 8x22B | Fair | May struggle with complex sequences |

**Note**: Smaller models (<13B parameters) generally struggle with reliable tool calling and multi-step reasoning required for agentic workflows.


## Configuration

### Model Profiles

Rebel uses a multi-profile system for local and alternative model routes. These profiles sit alongside the primary provider cards rather than replacing them. The full schema lives in `src/shared/types/settings.ts` (`ModelProfile`); the fields most relevant to local/alternative routing are:

```typescript
interface ModelProfile {
  id: string;                    // Unique identifier; BYO local-inference uses pattern local-byo-<preset>-<ts>-<rand4>
  name: string;                  // Display name (e.g., "Together.ai DeepSeek")
  providerType?: ModelProviderType;  // 'anthropic' | 'openai' | 'google' | 'together' | 'cerebras' | 'openrouter' | 'other' | 'local'
  routeSurface?: RouteSurface;   // 'subscription' | 'api-key' | 'pool' | 'local' (billing/auth classification)
  presetKey?: string;            // Preset provenance (e.g., 'local:ds4'); see § BYO local-inference presets
  serverUrl: string;             // Base URL only (proxy appends /v1/chat/completions)
  model?: string;                // Model ID to request (e.g., "deepseek-v4-flash")
  apiKey?: string;               // Optional API key for authenticated servers (omit for loopback)
  reasoningEffort?: ThinkingEffort;  // 'low' | 'medium' | 'high' | 'xhigh' — forwarded as reasoning_effort
  contextWindow?: number;        // Known max context; sources tracked via contextWindowSource
  maxOutputTokens?: number;      // Known max output; sources tracked via outputTokensSource
  createdAt: number;             // Timestamp
}
```

`providerType: 'local'` is reserved for the bundled-Ollama lifecycle path (Rebel-managed runtime). BYO loopback profiles created via the "Models on your machine" wizard save as `providerType: 'other'` + `routeSurface: 'local'` + `presetKey: 'local:*'`. The full rationale lives in [§ Key design decisions → BYO uses `providerType: 'other'`](#byo-profiles-use-providertype-other-not-providertype-local).

**Important**: The `serverUrl` should be the **base URL only**, not the full endpoint. The proxy automatically appends `/v1/chat/completions` when forwarding requests. For example:
- ✅ Correct: `http://localhost:1234/v1` or `http://localhost:1234`
- ❌ Wrong: `http://localhost:1234/v1/chat/completions` (would result in double path)

Profiles are stored in `AppSettings.localModel`:

```typescript
interface LocalModelSettings {
  profiles: ModelProfile[];
  activeProfileId: string | null; // legacy bridge; primary routing now lives on provider fields
}
```

### Settings UI

Configure profile-based routes in **Settings → AI & Models**:

1. **Add Profile**: Click "+" to add a new model server configuration. The wizard surfaces three groups:
   - **Built-in providers** — OpenAI, Google, Cerebras, Together, OpenRouter
   - **Models on your machine** — DS4, LM Studio, Ollama (custom server), llama.cpp ([§ BYO local-inference presets](#byo-local-inference-presets-models-on-your-machine))
   - **Your custom providers** — user-defined OpenAI-compatible endpoints
2. **Configure**: Enter server URL, optional model ID, and API key (the BYO local-inference presets pre-fill the URL and hide the API-key field).
3. **Activate**: Select the profile for the working/thinking/background route you want to override.
4. **Deactivate**: Clear the profile-based route or switch back to one of the primary provider cards.

### Example Configurations

**LM Studio (local)**:
```json
{
  "name": "LM Studio",
  "serverUrl": "http://localhost:1234",
  "model": "deepseek-coder-v2-instruct"
}
```

**Together.ai (cloud)**:
```json
{
  "name": "Together.ai DeepSeek",
  "serverUrl": "https://api.together.xyz",
  "model": "deepseek-ai/DeepSeek-V3",
  "apiKey": "your-api-key-here"
}
```

**Ollama (local)**:
```json
{
  "name": "Ollama Qwen",
  "serverUrl": "http://localhost:11434",
  "model": "qwen2.5:72b"
}
```


## BYO local-inference presets ("Models on your machine")

The wizard lets a user point Rebel at any OpenAI-compatible loopback server they have stood up themselves, without going through the bundled-Ollama lifecycle. Surfaces as a peer group ("Models on your machine") in `ProviderStep.tsx`, next to the cloud-provider cards and the user's custom providers.

> "Set things up in Rebel in a clean, general, reusable, long-term way to allow access to DS4 as a model" — user intent for the planning doc. The wizard is intentionally general; DS4 is the first preset, not a special case.

DS4 (antirez's [DwarfStar 4](https://github.com/antirez/ds4)) is the canonical example: a native inference engine for DeepSeek V4 Flash that runs on `127.0.0.1:8000` with an OpenAI-compatible `/v1` API. See its upstream `README.md` for architecture and operator setup.

This feature is a sibling to — not a replacement for — the bundled-Ollama path. The bundled-Ollama UI (`LocalInferenceSection`) still manages a Rebel-installed Ollama runtime on demand. "Models on your machine" is for the BYO case where the user already runs their own server.

### Available presets

Defined in `src/shared/data/modelProviderPresets.ts` (`LOCAL_INFERENCE_PRESETS`); single source of truth for label / `serverUrl` / `defaultModel` / `supportsThinking`:

| `presetKey` | Label | Default URL | Default model | Thinking |
|---|---|---|---|---|
| `local:ds4` | DS4 | `http://127.0.0.1:8000/v1` | `deepseek-v4-flash` | yes |
| `local:lm-studio` | LM Studio | `http://127.0.0.1:1234/v1` | (user-provided) | no |
| `local:ollama-custom` | Ollama (custom server) | `http://127.0.0.1:11434/v1` | (user-provided) | no |
| `local:llama-cpp` | llama.cpp | `http://127.0.0.1:8080/v1` | (user-provided) | no |

### Save-shape triple

BYO profiles are stamped with three coordinated fields at save time:

- `providerType: 'other'` — uses the generic OpenAI-compatible transport
- `routeSurface: 'local'` — type-honest classification for billing/auth helpers
- `presetKey: 'local:<key>'` — preset provenance; drives ProfileTable labelling and reasoning-replay gating

The normalizer in `settingsUtils.ts` enforces both invariants `presetKey: 'local:*' ⟹ providerType: 'other'` and `presetKey: 'local:*' ⟹ routeSurface: 'local'`, coercing on profile save and on settings load. A manual edit to `'local'` is structurally reversed; future agents cannot silently undo the generalisation.

### Adding a new preset

1. Add an entry to `LOCAL_INFERENCE_PRESETS` in `src/shared/data/modelProviderPresets.ts` — `{ key, presetKey: 'local:<key>', label, serverUrl, defaultModel, supportsThinking, description }`. Mirror the existing entries.
2. Choose `supportsThinking: true` only if (a) the upstream actually accepts a thinking-effort knob AND (b) it replays `reasoning_content` correctly. For reasoning-replay capability also extend `REASONING_REPLAY_CAPABLE_MODEL_PATTERNS` in `src/shared/utils/reasoningCapability.ts`.
3. The wizard, ProfileTable label, normalizer guards, credential admission, billing classification, and eval preflight all derive from `LOCAL_INFERENCE_PRESETS` / `presetKey` — no further wiring required for cards.
4. If the upstream returns prices in any way that doesn't map to `$0`, add a `MODEL_CATALOG` entry with `provider: 'local'` (or the genuine provider) and real pricing.
5. Add a Storybook story variant if the new preset materially changes `ProviderStep` rendering; otherwise the existing `ProviderStep.stories.tsx` covers the group.


## Key design decisions

### BYO profiles use `providerType: 'other'`, NOT `providerType: 'local'`

`providerType: 'local'` is the **bundled-Ollama lifecycle contract**. At least six consumers couple it to Rebel-managed Ollama (startup/deactivate cleanup, `ensureOllamaForLocalProfile` health checks, `injectOllamaOptions` injecting `options.num_ctx` into outbound requests, the `experimental.localInferenceEnabled` pruning path, the "Local (Ollama)" agent label, ...). Reusing it for BYO loopback servers would have silently deleted user profiles, injected Ollama-specific parameters that DS4 would reject, and misframed the UI.

The full rejected alternatives (decoupling Ollama lifecycle from `providerType: 'local'`; introducing a new `'byo-local'` enum value) are in [§5 of the planning doc](../plans/260516_ds4_local_model_integration_and_evals.md).

### `isLoopbackRoutableProfile` is the canonical loopback predicate

`isLoopbackRoutableProfile(profile)` returns true when ANY of `routeSurface === 'local'`, `providerType === 'local'`, or `isLocalhostUrl(profile.serverUrl)` holds. Six functional sites migrated to this predicate (credential admission, eval preflight, proxy upstream-timeout doubling on both streaming and non-streaming paths, fallback-provider resolution, `setLocalInferenceCloudFallback` validation, `assessProfileRoutability`, and `resolveBillingSourceForProfile`). Without these, a BYO DS4 profile would fail credential gates, get half the upstream-timeout budget on slow consumer hardware, and mislabel as "Pay-per-use" billing.

Lifecycle/cleanup sites that genuinely mean "Rebel-managed Ollama runtime" stay on the sibling `isBundledOllamaProfile` predicate; the broader 25-site predicate-consolidation pass is deferred (planning doc Followups §12 item 4).

### Reasoning-content replay is destination-gated through `supportsReasoningReplay`

DeepSeek's OpenAI-compatible contract returns `reasoning_content` as a sibling of `content` on `choice.message`. Reasoning-strict providers (DeepSeek upstream, Cohere/Mistral on certain endpoints) can return HTTP 400 if assistant history omits `reasoning_content` blocks the model previously emitted. Both OpenAI-compatible translators previously stripped `thinking`/`thinking_delta` blocks during history → outbound translation, which would have caused 400s on multi-turn conversations against strict-replay providers.

The fix lands in **both** translators (`localModelProxyServer.ts` for the desktop chat path, `openaiTranslators.ts` for the eval / core-client path), gated by a single caller-computed boolean `supportsReasoningReplay`:

- Computed in `rebelCoreQuery.ts` from the resolved `activeProfile` (plus fallback / skeleton / sub-agent recomputes) via `computeSupportsReasoningReplay(profile, modelName)`
- Threaded into `runAgentLoop` via `opts.supportsReasoningReplay` and into provider clients via `StreamParams` / `CreateParams`
- The allow-list is intentionally narrow: `presetKey === 'local:ds4'` OR model name matches `REASONING_REPLAY_CAPABLE_MODEL_PATTERNS` (currently `/^deepseek-/i`). Default off. New reasoning destinations are added with evidence (spike + integration test).
- `getThinkingRetentionTurns(supportsReasoningReplay)` returns 50 (not `Infinity`) when true, 2 when false. 50 turns is comfortably above any eval fixture's history depth, while keeping context bounded for long-tail conversations on smaller-context reasoning models.

Stage 0's empirical spike falsified DS4's worst-case strict-replay assumption: DS4 is tolerant-replay (turn 2 without `reasoning_content` returns HTTP 200 with KV-cache miss, not 400). The translator fix is therefore reframed as a **KV-cache hit-rate optimisation** for DS4 plus a **correctness invariant** for genuinely strict-replay reasoning destinations.

### Bounded late-reasoning buffer (defense-in-depth)

The streaming code paths in both translators buffer any `reasoning_content` chunks that arrive after `finish_reason` until `[DONE]` (or stream close), then emit them as a trailing `thinking_delta` block before the synthesized stop event. The buffer is capped — 256 KB cumulative bytes, 1000 chunks, OR 30 seconds since `finish_reason` (whichever comes first; the 30 s cap is an active `Promise.race(reader.read(), finishDeadlineTimer)` so a server that hangs after `finish_reason` cannot stall the read indefinitely). On cap-hit the translator emits buffered content, force-closes the stream, logs a structured event, and emits a `degraded-status` event so the renderer can surface "response truncated" inline. The Stage 0 spike found no late-after-finish emission on DS4 today; this is fail-safe code for alpha-quality server behavior changes and future reasoning destinations.

### `$0` catalog entry for `deepseek-v4-flash`

`MODEL_CATALOG` was widened to include `'local'` as a `ModelProvider` and gained a `deepseek-v4-flash` entry with explicit `$0` input/output/cache pricing. The bare-id `deepseek-v4-flash` deliberately does not collide with the OR-hosted `deepseek/deepseek-v4-flash` — the analyzer's variant key keys on `(provider, model)` so the two stay separated. `$0` communicates "no API cost, local inference"; the cost-ledger validator accepts the row (it isn't treated as "missing cost data").

### Eval-bundle wiring (`profile:<id>`)

Bare model strings are inert post-260514 Stage B reproducibility hardening; the eval CLI requires `profile:<id>` to bind to a registered local profile. The deterministic id pattern for wizard-created BYO profiles is `local-byo-<preset>-<timestamp>-<rand4>`. Operator workflow lives in [`evals/AGENTS.md` § Local-model eval setup](../../evals/AGENTS.md#local-model-eval-setup).

The `--parallel 1` sequential path gained per-fixture incremental `<output>.partial.tmp` writes (atomic tmp+rename per fixture, `ResultFile` shape, never renamed over the final file, unlinked on successful completion, 6-hour age gate on stale-cleanup). The `.partial.tmp` suffix deliberately falls outside the analyzer's `*.json` ingestion filter so partials are forensic-only.


## Behind-the-Scenes Client

Rebel uses a lightweight LLM client for background tasks that don't go through the full agent loop:

- **Safety evaluations** — Risk assessment before tool execution
- **Memory operations** — Memory write safety checks
- **Quip generation** — Personality-driven status messages
- **Time estimates** — Task duration predictions

### Routing Logic

The behind-the-scenes client (`behindTheScenesClient.ts`) routes requests based on the `behindTheScenesModel` setting. The storage encoding uses a codec prefix (`model:<id>`, `profile:<id>`); callers must decode before passing to wire APIs. See [`docs/project/MODEL_CONSTANTS.md`](../project/MODEL_CONSTANTS.md#behindthescenesmodel-storage-encoding) for the full contract and decoder requirements.

1. **`profile:<id>` route**: Route directly via `callDirectWithProfile()` using the matched profile's provider configuration
2. **Specific provider model** (for example `'claude-haiku-4-5'` or an OpenRouter model ID): Use the normal provider-aware BTS routing path
3. **Default**: Use the configured background model. If no Anthropic key is available, falls back to `getWorkingProfileFallback()` (tries the active working model profile), or throws if no viable route exists

### Privacy Default

When an alternative model profile is active, Rebel automatically defaults `behindTheScenesModel` to `'use-alternative'`. This ensures that if you've chosen a local/profile-based route for privacy reasons, background tasks stay on that route instead of silently shifting back to a primary provider.

### Fallback Behavior

The behind-the-scenes client falls back to the default auxiliary model (`claude-haiku-4-5`, with a warning log) when:
- No active model profile is configured
- The proxy server is not running
- The proxy URL is unavailable

**Model-not-found handling**: If the proxy forwards a request but the upstream returns a 404/403 "model not found" error, the agent turn error recovery system (`handleThinkingModelFallback()` in `turnErrorRecovery.ts`) downgrades the thinking model (e.g., Opus → Sonnet via `FALLBACK_PLANNING_MODEL`) and retries. See [ARCHITECTURE_AGENT_TURN_EXECUTION.md § Model Unavailable Recovery](ARCHITECTURE_AGENT_TURN_EXECUTION.md#model-unavailable-recovery).

**Other upstream errors**: If the proxy forwards a request and the upstream returns a non-model error (rate limit, auth, etc.), that error propagates — no fallback occurs in that case. This ensures you're aware of configuration issues with your model server.


## Implementation Details

### Proxy Server

**File**: `src/main/services/localModelProxyServer.ts`

The proxy is managed by the `ProxyManager` class (exported as the singleton `proxyManager`):
- `proxyManager.start(profile, port?)` — Start the proxy with a model profile
- `proxyManager.stop()` — Stop the proxy
- `proxyManager.getUrl()` — Get the current proxy URL (or null if not running)
- `proxyManager.isRunning()` — Check proxy status

The proxy:
- Binds to `127.0.0.1` only (localhost, not accessible from network)
- Uses port 18765 by default, incrementing if in use
- Handles CORS for local development
- Supports both streaming and non-streaming requests

### Settings Store

**File**: `src/main/settingsStore.ts`

- `migrateLocalModelProfilesIfNeeded()` — Migrates old single-config format to multi-profile
- Default settings initialize `localModel` with `DEFAULT_LOCAL_MODEL_SETTINGS` (not `undefined`)


## Troubleshooting

### Proxy Won't Start

**Symptom**: "Local model proxy server started" log doesn't appear

**Causes**:
- Port 18765 (and subsequent ports) are all in use
- Model profile is not properly configured

**Solution**:
- Check for other processes using ports 18765+
- Verify the model profile has a valid `serverUrl`

### Connection Refused

**Symptom**: "Local model error (ECONNREFUSED)"

**Causes**:
- Local model server is not running
- Incorrect server URL in profile

**Solution**:
- Start your local model server (DS4, LM Studio, Ollama, etc.)
- Verify the server URL matches your model server's configuration

### Tool Calling Failures

**Symptom**: Agent doesn't use tools or uses them incorrectly

**Causes**:
- Model doesn't support function calling
- Model returns malformed tool call JSON

**Solution**:
- Use a model known to support function calling (DeepSeek V4 Flash, DeepSeek V3, Qwen 2.5, etc.)
- Check the proxy logs for parsing errors

### Streaming Issues

**Symptom**: Responses don't stream or appear all at once

**Causes**:
- Model server doesn't support streaming
- Proxy translation error

**Solution**:
- Enable streaming in your model server configuration
- Check logs for SSE translation errors

### "(no content)" Placeholder Text

**Symptom**: Responses contain "(no content)" or similar placeholder text

**Cause**: Some models (e.g., DeepSeek) emit placeholder text before tool calls

**Solution**: The proxy automatically filters these patterns. If you see new patterns, they can be added to the filter in `processStreamChunk()`.


## Limitations and known gaps

1. **No image support**: The proxy doesn't translate image content blocks (yet).
2. **No prompt caching**: Profile-routed alternative models don't benefit from Anthropic's prompt caching.
3. **Variable tool calling quality**: Depends heavily on the model's capabilities.
4. **No structured outputs**: The proxy does not forward `output_format` to alternative models; this Anthropic-specific feature is dropped during translation.
5. **Auto-discovery is not wired**: The wizard always asks for the server URL (with a sensible preset default). A future `/v1/models` probe at wizard open could pre-select a card; deferred until at least three users ask.
6. **Reasoning-content catalog metadata** (planning-doc Followups item 3): the narrow regex allow-list in `REASONING_REPLAY_CAPABLE_MODEL_PATTERNS` is the source of truth today. A dedicated `MODEL_CATALOG[id].presets.reasoningContentReplay?: true` catalog field is tracked as a followup; `presets.reasoning` (which means "exposes thinking-effort knob") is not a safe proxy because Cohere/Mistral can have it true and still 400 on replay.
7. **Stage 3b structural cleanup deferred**: the broader 25-site `providerType === 'local'` literal-compare consolidation, the companion ESLint rule, and the lifecycle-site migration to `isBundledOllamaProfile` are tracked as a followup. DS4 ships correctly without it; 3b is cosmetic.


## Security Considerations

- **Localhost binding**: The proxy only binds to `127.0.0.1`, not accessible from the network
- **API key storage**: Profile API keys are stored in the app settings (electron-store)
- **Credential forwarding**: The proxy forwards only the profile's `apiKey` (if configured) to the upstream model server via `Authorization: Bearer` header. Primary-provider credentials are **never** forwarded to profile-based model servers.
- **Process isolation**: The proxy runs in the Electron main process, not exposed to renderer


## Maintenance

When modifying local model support:
- Update this document as part of the same change
- Test with at least one local server (DS4, LM Studio, or Ollama) and one cloud provider
- Verify both streaming and non-streaming modes work
- Check behind-the-scenes routing with `'use-alternative'`
- When changing the BYO save-shape contract (the `providerType` / `routeSurface` / `presetKey` triple), update the `wizard-provider-presets` boundary registry entry and the normalizer guard tests
- When extending the reasoning-replay allow-list, update both `REASONING_REPLAY_CAPABLE_MODEL_PATTERNS` and the `local-openai-compatible-translation` boundary entry, and add a dual-translator test (both `localModelProxyServer.translate.test.ts` and `openaiTranslators.test.ts`)
- When the late-reasoning buffer caps need tuning, update `localModelProxyServer.ts` and `openaiClient.ts` together; both translators share the policy and tests assert all three cap-hit paths
