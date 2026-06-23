---
description: "Canonical reference for app settings, MCP configuration, and environment variables"
last_updated: "2026-04-16"
---

### Introduction

Mindstone Rebel uses a combination of persisted app settings, JSON‑based MCP configuration, and environment variables to control behavior across development and production.  
This document is the canonical reference for those settings surfaces and how they interact.


### See also

- `../../README.md` – Quickstart install/run commands and top‑level project overview.
- `../../AGENTS.md` – Guidance for AI agents working on this repo, including where configuration and docs live.
- `./ARCHITECTURE_OVERVIEW.md` – High‑level architecture; this document expands on its settings/environment summary.
- `./SETUP_DEVELOPMENT_ENVIRONMENT.md` – Step‑by‑step local setup and basic "it actually works" checks.
- `./LOGGING.md` – Logging architecture, log file locations, and log‑level configuration.
- `./MCP_ARCHITECTURE.md` – Detailed reference for MCP and Super‑MCP configuration file formats, discovery, and mode selection.
- `./SUPERMCP_OVERVIEW.md` – Super‑MCP HTTP transport behavior, health checks, and concurrency considerations.
- `./LOCAL_MODEL_SUPPORT.md` – Using local/alternative LLM models via the Anthropic↔OpenAI translation proxy.
- [BUILDING](./BUILDING.md) – Build process and bundled Node/npm/npx runtime details.
- `./PACKAGED_DEPENDENCY_NOTES.md` – How Vite/Forge packaging treats dependencies and guidelines for avoiding runtime module errors.
- `./LIBRARY_AND_FILE_ACCESS.md` – Canonical reference for workspace selection, file‑tree behavior, and file‑access rules.
- `./MOVING_REBEL_BETWEEN_COMPUTERS.md` – Transferring Rebel data to a new machine (path-sensitive settings like `coreDirectory`, `mcpConfigFile`).
- `./VOICE_AND_AUDIO.md` – Voice and audio‑related settings and provider behavior.
- `./ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md` – Canonical reference for the session and history persistence model.
- `./REBEL_SYSTEM_SYNC.md` – How "rebel-system" .md files are versioned and synced (dev submodule vs production download) and how the `rebel-system/` symlink is created in the workspace.


### Principles, key decisions

- **Single canonical reference**: This document is the primary source for settings, configuration, and environment variables; other docs should link here rather than duplicating details.  
- **App‑driven configuration first**: Where possible, configuration is exposed through Rebel’s Settings UI, with environment variables used for advanced tuning and operational overrides.  
- **Safe defaults and production parity**: Defaults aim to work out of the box in development while matching production behavior (Node bundling, MCP modes) as closely as practical.


### App settings overview

**Settings storage**

- `AppSettings` is persisted via `@core/storeFactory` under the `app-settings` key. On desktop, this is backed by `electron-store`; in the cloud service, it uses JSON files on disk.  
- On desktop, `electron-store` writes JSON files under Electron's `userData` directory (for example on macOS: `~/Library/Application Support/mindstone-rebel/app-settings.json`). The cloud service uses the same file format at a configurable data path.  
- A global `ensureNormalizedSettings` call uses `normalizeSettings` to:
  - Migrate older settings schemas.  
  - Provide sensible defaults (models, providers, feature flags).  
  - Keep voice and MCP settings consistent across runs.
- Settings-store bootstrap migration signpost: `src/main/settingsStore.ts` → `applyOpenRouterProfileSourceMigration` (plan: `docs/plans/260513_openrouter_legacy_profile_source_migration.md`).

**Key settings surfaces**

- **Core workspace directory (`coreDirectory`)**  
  - Selected via Settings using a directory picker.  
  - All workspace operations (file tree, read/write, create/rename/delete) are constrained to this root.  
  - See `./LIBRARY_AND_FILE_ACCESS.md` for detailed behavior and safety rules.

- **System prompt**  
  - User-level instructions are always read from `Chief-of-Staff/README.md` in the workspace (with legacy `AGENTS.md` fallback).  
  - See `./SYSTEM_PROMPT.md` for the full composite prompt architecture.

- **MCP configuration (`mcpConfigFile`)**  
  - Path to a JSON config file that defines MCP servers or a Super‑MCP router.  
  - The main process resolves and normalizes this via `mcpService.ts`.  
  - See `./MCP_ARCHITECTURE.md` for supported shapes, discovery, and direct vs router mode.

- **Voice and audio**  
  - Provider and model selection plus `openaiApiKey` / `elevenlabsApiKey`.  
  - See `./VOICE_AND_AUDIO.md` for provider‑specific behavior and performance notes.

- **Embedded OAuth credentials (note for security review)**  
  - `src/main/services/oauthCredentials.ts` contains embedded OAuth client IDs and secrets for Google, Slack, and HubSpot integrations.  
  - These enable zero‑config OAuth flows for end users (users still authenticate themselves; these credentials identify the app to OAuth providers).  
  - For Electron/desktop apps, OAuth client credentials are considered "public client" credentials per OAuth 2.0 spec—they are extractable from distributed binaries regardless of whether they appear in source. The security model relies on redirect URI validation and user authentication, not client secret confidentiality.  
  - GitHub's secret scanning flags these; they can be dismissed as acceptable for a desktop app context.  
  - **TODO**: This assessment is preliminary (Dec 2024). A more thorough security review of embedded credentials is planned.

- **Prevent sleep during turns (`preventSleepDuringTurns`)**  
  - Settings > Advanced toggle. When enabled, uses Electron's `powerSaveBlocker` (`prevent-app-suspension` mode) to keep the system awake during agent turns. Default: off (opt-in).  
  - See `src/main/services/powerSaveBlockerService.ts` for implementation and `src/renderer/features/settings/components/sections/SystemExperimentalFeaturesSection.tsx` for the UI toggle.

- **Tool safety (`toolSafetyLevel`, `userSafetyInstructions`)**  
  - Controls how Rebel evaluates potentially risky MCP tool operations before execution.  
  - `toolSafetyLevel`: One of `'permissive'` (trust mode), `'balanced'` (default), or `'cautious'` (extra careful).  
  - `userSafetyInstructions`: Optional free‑form text for custom safety rules (e.g., "Always ask before emailing anyone outside our company").  
  - See `./TOOL_SAFETY.md` for the full architecture, decision matrix, and approval flow.

- **Memory safety (`spaceSafetyLevels`)**  
  - Controls when Rebel can automatically save to memory spaces versus prompting for approval.
  - `spaceSafetyLevels`: A `Record<string, SafetyLevel>` mapping space paths to safety levels (`'permissive'`, `'balanced'`, `'cautious'`).
  - Chief-of-Staff is always `permissive` (hardcoded, not stored in settings).
  - Private spaces default to `permissive`; shared/legacy spaces default to `balanced`. Shared spaces enforce a minimum floor of `balanced`. A structural secret gate scans permissive writes for credentials before auto-saving (see `MEMORY_SAFETY.md`).
  - **Deprecated fields (no longer used):** `spaceSafetyOverrides`, `memorySafetyBySharing`, `memorySafetyPrivate`, `memorySafetyShared`. These may exist in settings for backward compatibility but are ignored.
  - See `./MEMORY_SAFETY.md` for the full architecture and security model.

- **Primary AI provider selection (`activeProvider`)**  
  - The Settings → **AI & Models** page uses provider cards for the main conversation provider: **Anthropic**, **ChatGPT Pro** (Codex), **OpenRouter**, and **Mindstone** (managed subscription).  
  - The selected card is persisted as `activeProvider?: 'anthropic' | 'openrouter' | 'codex' | 'mindstone'`.  
  - `undefined` means no primary provider has been chosen yet (fresh onboarding or pre-migration settings).  
  - This field controls which provider-specific connection card is highlighted and which model catalogs the Working / Thinking / Background dropdowns use.

- **Anthropic (direct Claude API)**  
  - Uses `claude.apiKey` plus `activeProvider: 'anthropic'`.  
  - `claude.model` stores the Working model as a direct Anthropic / Claude model ID.  
  - `claude.thinkingModel` stores the optional Thinking model; when unset, Thinking falls back to the Working model.  
  - `behindTheScenesModel` stays on a direct Claude-compatible model ID for background tasks unless the user overrides it.

- **ChatGPT Pro / Codex**  
  - Uses a separate Codex OAuth/token store and persists the selected provider as `activeProvider: 'codex'`.  
  - Selecting the ChatGPT Pro card applies `applyCodexModelDefaults()` from `src/shared/utils/codexDefaults.ts`. That routine:
    - Sets the Working path to GPT‑5.5 via the auto-generated `claude.workingProfileId = 'codex-gpt-5.5'`
    - Clears `claude.thinkingModel` / `claude.thinkingProfileId` so Codex runs in single-model mode by default
    - Sets `behindTheScenesModel = 'profile:codex-gpt-5.4-mini'` for background work
  - Codex therefore uses the same canonical routing fields as other providers, but points them at generated OpenAI-backed profiles instead of raw Claude model IDs.

- **OpenRouter**  
  - Uses `openRouter.enabled`, `openRouter.oauthToken`, `openRouter.selectedModel`, and `activeProvider: 'openrouter'`.  
  - Selecting the OpenRouter card applies `applyOpenRouterModelDefaults()` from `src/shared/utils/openRouterDefaults.ts`, which currently defaults to:
    - Working: `openai/gpt-5.5`
    - Thinking: `anthropic/claude-opus-4-8`
    - Background tasks: `deepseek/deepseek-v4-flash`
  - When OpenRouter is active, `claude.model`, `claude.thinkingModel`, `behindTheScenesModel`, and related fallback fields store OpenRouter-style IDs (`provider/model`). `normalizeSettings()` remaps stale Anthropic IDs during provider switches so the dropdowns and runtime stay aligned.

- **Mindstone (managed OpenRouter subscription)**  
  - Uses `activeProvider: 'mindstone'`. Routes through the same OpenRouter proxy as personal OpenRouter, but uses a server-provisioned API key (billed to Mindstone) instead of the user's personal OAuth token.  
  - The managed API key is delivered via `/api/config` (`subscription.managedProvider.apiKey`), encrypted into Electron's `safeStorage` on desktop (separate slot from personal key in `openRouterTokenStorage.ts`), and never exposed to the renderer process.  
  - Subscription metadata (`keyHash`, `allowedModels`, `creditLimitMonthly`, `creditUsedMonthly`) is ephemeral in `cachedAuthConfig`, NOT in persisted settings — avoids cloud-sync contamination.  
  - Provider routing treats `'mindstone'` as an OpenRouter variant: `isUsingOpenRouter()`, `isEffectivelyOpenRouter`, and `isOpenRouterProvider` all return `true` for `'mindstone'`. The distinction is the credential source (`'mindstone-managed-key'` vs personal OAuth).  
  - Fail-closed: if `activeProvider === 'mindstone'` but no managed key is in storage, the executor blocks the turn. The proxy never falls back to the personal key (would cause billing surprise).  
  - See [planning doc](../plans/260428_openrouter_managed_subscription.md) for full design decisions and implementation status.

- **Working / Thinking / Background task routing**  
  - **Working** = `claude.model` or `claude.workingProfileId`  
  - **Thinking** = `claude.thinkingModel` or `claude.thinkingProfileId`; when unset, Thinking uses the Working route  
  - **Background tasks** = `behindTheScenesModel`, with optional per-task overrides in `behindTheScenesOverrides` and fallbacks in `backgroundFallback`, `thinkingFallback`, and `workingFallback`  
  - `claude.planMode` is derived from whether Thinking differs from Working, and `claude.extendedContext` keeps long-context routing enabled for supported Claude models.  
  - These fields power the per-conversation **quality tier selector** (`ConversationModelSelector.tsx`), which maps Quick/Balanced/Thorough/Maximum tiers to preset model combinations. The "Save as default" action persists overrides back into the same settings fields.
  - `thinkingEffort` still controls reasoning depth (`'xhigh' | 'high' | 'medium' | 'low'`) regardless of provider, but only for providers/models that support explicit effort tuning.
  - Model resolution logic lives in `resolveModelConfig()` and the normalization / migration logic in `src/shared/utils/settingsUtils.ts`. User-facing guidance lives in `rebel-system/help-for-humans/AI-models.md`.

- **BTS Routing Invariants** (intent-critical — do not reverse without reading [260421_bts_cross_provider_routing_fixes](../plans/260421_bts_cross_provider_routing_fixes.md) + [260420_settings_model_selection_fixes](../plans/260420_settings_model_selection_fixes.md))
  1. **`resolveBtsModel()` precedence stays override → `behindTheScenesModel` → default.** Read-time decoding of the codec storage prefix (`model:<id>` → `<id>`) via `stripStoredModelPrefix()` is not a "remapping" — it restores the codec round-trip invariant. Any *routing* remapping (provider fitness, etc.) still happens at write time. If a stored value is stale for the active provider, the BTS runtime guard fails loudly rather than silently remapping.
  2. **Codex subscription profiles are routable iff `codexConnected`.** Enforced at two layers: (a) write-time in `assessProfileRoutability()` inside `src/shared/utils/providerSwitch.ts`, and (b) runtime in `callBehindTheScenes / callBehindTheScenesWithAuth / callWithModelAuthAware` in `src/core/services/behindTheScenesClient.ts`. The REBEL-1DZ guard in `resolveProfileApiKey()` forbids falling back to `providerKeys.openai` for Codex profiles — Codex auth is never a shared-key operation.
  3. **Bare `gpt-*` BTS values are routable iff `to === 'codex' && codexConnected` OR `isUsingOpenRouter(targetSettings)`.** BTS has no direct-OpenAI path for bare `gpt-*`; routing happens only through Codex proxy or OR proxy. A saved `providerKeys.openai` does NOT make bare `gpt-*` routable — that saved key is for voice and direct-OpenAI custom profiles, not for inferred-OpenAI BTS.
  4. **Anthropic-direct selections bypass Codex/OR proxy injection.** The `claude.apiKey` path remains sacrosanct — no proxy inspection touches it.
  5. **`planProviderSwitch()` is the single write-time routability judge; the BTS client's fail-closed guard is the runtime safety net for stale state that pre-dates a switch.** The two must stay aligned — if you change one, update the other and add a paired test.
  6. **Inactive Codex auto-profiles (`profile:codex-*`) are FILTERED from the "Your Models" UI selectors when `activeProvider !== 'codex'`, but remain in `localModel.profiles` storage.** They are the structural routing mechanism for Codex; deletion would break Codex. See `isCodexAutoProfile()` in `src/shared/utils/codexDefaults.ts`.

- **Claude OAuth profile and usage data (`claude.oauthProfile`, `claude.usageData`)**
  - `oauthProfile`: Optional metadata fetched after OAuth setup/refresh. Contains `tier` (subscription level: Pro, Max, Team, Enterprise, Free), `displayName`, `email`, and `fetchedAt` timestamp. Not credentials — stored alongside existing oauth fields and synced via `settings:update`.
  - `usageData`: Optional subscription usage snapshot fetched fire-and-forget after OAuth setup, token refresh, and agent turns (10s debounce). Contains three utilization buckets (`fiveHour`, `sevenDay`, `sevenDaySonnet`) each with `utilization` (0-100%) and `resetsAt` (ISO timestamp), plus optional `extraUsage` for overage-enabled plans and a `fetchedAt` timestamp.
  - Both fields flow to the renderer through the existing `settings:update` channel — no additional IPC infrastructure needed.
  - The usage data cache has a 15-minute TTL due to aggressive Anthropic API rate limiting (~5 requests per token before permanent 429).
  - See [CLAUDE_MAX_AUTH.md](CLAUDE_MAX_AUTH.md) for the full profile detection and usage monitoring architecture.
  - Types defined in `ClaudeSettings` interface in `src/shared/types/settings.ts`.

- **Local/alternative model configuration (`localModel` settings object)**  
  - Enables using local LLM servers (LM Studio, Ollama) or cloud alternatives (Together.ai, OpenRouter) via an Anthropic↔OpenAI translation proxy.  
  - `profiles`: Array of saved model profiles, each with `id`, `name`, `serverUrl`, optional `model`, optional `apiKey`, `councilEnabled` (council membership), and `enabled` (dispatch availability, default `true`).  
  - `enabled?: boolean`: Controls whether a profile is available for dispatch (pre-registration, council fan-out, ad-hoc @-mentions). Default `true` when absent (backward compatible). Disabled profiles remain visible in Settings for editing but are invisible to the agent. Does not affect tier routing (Working/Thinking role assignment).  
  - `activeProfileId`: ID of the currently active profile, or `null` to use Claude.  
  - When a profile is active, a translation proxy runs on `127.0.0.1:18765` (or next available port) that converts Anthropic API calls to OpenAI format.  
  - `behindTheScenesModel`: Controls which model handles background tasks (safety checks, memory, quips). Set to `'use-alternative'` to route through the proxy, or a specific model like `'claude-haiku-4-5'` to call Anthropic directly.  
  - When an alternative model is active, `behindTheScenesModel` defaults to `'use-alternative'` for privacy.  
  - See `./LOCAL_MODEL_SUPPORT.md` for architecture, supported providers, and troubleshooting.

- **Prevent sleep during turns (`preventSleepDuringTurns`)**  
  - Settings → Advanced. Default: `false`.  
  - When enabled, prevents the system from sleeping while an agent turn is in progress, ensuring long-running turns complete without interruption.

- **Renderer‑local UI state (`window.localStorage`)**  
  - Use `localStorage` **only** for small, device‑local, renderer‑only UI state that can be lost without the user noticing or losing work.  
  - **Good fits:** view modes, dismissed banners/tooltips, panel widths, filter preferences, analytics de‑duplication flags, login email prefill.  
  - **Do not store:** user‑created content, anything the user would notice losing, large or unbounded payloads, data shared across processes, data that needs schema/versioned migration, or auth tokens/secrets.  
  - If the value needs durability, migration, or coordination outside the renderer, persist it via `AppSettings`, an IPC‑backed store, or domain‑specific on‑disk storage instead.  
  - These values are per‑machine and per‑profile, and can be cleared via standard local‑storage reset flows.  
  - Settings → Onboarding & Actions → `Relaunch onboarding` reopens the guided setup without wiping other saved configuration. It sets `onboardingCompleted=false` and clears the `permission-onboarding-shown` flag so the wizard appears again (see `./ONBOARDING_SETUP_WIZARD.md`).

- **Demo mode settings isolation**  
  - Demo mode runs from a separate temporary `userData` directory with its own `app-settings.json`; it is not an in-place overlay on the normal settings store.  
  - Demo startup always seeds demo-specific workspace / identity settings such as `coreDirectory`, `workspaceName`, `companyName` (deprecated — see [SPACES.md](./SPACES.md) § Migration story), `onboardingCompleted`, `userEmail`, `userFirstName`, and demo `spaces`.  
  - If the user chooses **Keep my API keys**, demo mode also copies the current provider configuration into the temp store (including `activeProvider`, Anthropic credentials, OpenRouter config, Mindstone managed subscription state, selected provider keys, and advanced provider/profile state used by the Settings cards).  
  - Sessions, inbox/actions data, and tool usage remain isolated inside the demo temp directory.  
  - See `./DEMO_MODE.md` for the full isolation matrix and entry/exit behavior.


### Session history and persistence

- Session history uses a file-per-session architecture via `IncrementalSessionStore`, with a bounded number of sessions (`MAX_PERSISTED_SESSIONS`).  
- On disk, sessions are stored in a `sessions/` directory within Electron's `userData` directory:
  - macOS: `~/Library/Application Support/mindstone-rebel/sessions/`  
  - Windows: `%APPDATA%\mindstone-rebel\sessions/`  
  - Linux: `$XDG_CONFIG_HOME/mindstone-rebel/sessions/` (or `~/.config/mindstone-rebel/sessions/`)
  
  The directory contains:
  - `index.json` - Lightweight index with session summaries (used for sidebar display)
  - `<sessionId>.json` - Individual session files with full conversation data

- On load, the main process:
  - Migrates from legacy `agent-session-history.json` if present (renamed to `.backup.json`)
  - Validates the index version and rebuilds if outdated
  - Normalizes in‑flight turns so they are marked as safely completed when the app exits.
- For the full session/turn model and resume behavior, see `./ARCHITECTURE_AGENT_SESSIONS_AND_HISTORY.md`.

### System instructions (rebel-system) storage & sync

See `./REBEL_SYSTEM_SYNC.md` for the canonical reference (dev submodule vs production download, storage locations across macOS/Windows/Linux, and the workspace `rebel-system/` symlink behavior).


### Execution environment and Node bundling

- In development, Rebel uses the system Node.js installation and whatever `npm`/`npx` binaries are on `PATH`.  
- In production builds:
  - A complete Node runtime bundle (`node-bundle/bin/node`, `npm`, `npx`, plus `lib/node_modules/npm`) is shipped as an extra resource.  
  - `systemUtils.ts` detects this bundle and prepares an augmented `PATH` including its `bin` directory; this augmented path is used when launching the agent CLI.  
  - MCP servers invoked by the agent (via `npx`) work without requiring a system Node installation.  
  - Note: The Super‑MCP HTTP router is launched via the bundled `super-mcp` submodule, not via `SUPER_MCP_ROUTER_CLI`; that variable is only surfaced in diagnostics for environments that launch Super‑MCP manually.
- See [BUILDING](./BUILDING.md) for the bundling implementation and the historical `../plans/251116_production_mcp_fix.md` for detailed testing steps and size trade‑offs.


### R4 BTS Routing Invariants

Provider routing for turns, behind-the-scenes calls, subagents, warmups, and direct-Anthropic-only helpers is governed by `ProviderRoutePlan` (see `docs/plans/finished/260427_refactor_provider_route_plan.md`). The load-bearing invariants are:

1. **I1 — BYOK header survival:** provider-identity headers (`x-codex-turn`, `x-openrouter-turn`, `x-council-turn-id`) survive every plan path.
2. **I2 — Slash-dialect leak:** model IDs containing `/` never reach native Anthropic without a proxy.
3. **I3 — `_resolvedAuth` exactness:** `_resolvedAuth` is derived only from `deriveResolvedAuthLabel(plan)` and preserves the legacy four-string union.
4. **I4 — Codex-disconnected BTS contract:** disconnected Codex BTS paths use the single fail-closed helper with the exact log/capture/error shape.
5. **I5 — Partial-OpenRouter fail-closed:** `activeProvider: 'openrouter'` without credentials emits `no-credentials`; it never silently falls back. Same for `activeProvider: 'mindstone'` without a managed key — emits `missing-mindstone`, never falls back to personal key.
6. **I6 — Exhaustive-never coverage:** new provider, transport, or model-dialect variants must compile-error in every routing consumer.
7. **I7 — Fallback chains:** Codex tier/provider fallback, thinking-model fallback, and alt-model fallback all preserve their existing chains through plan rebuilds.
8. **I8 — Long-context fallback:** Max 200K fallback rebuilds the plan with the long-context profile hint.
9. **I9 — Council/ad-hoc/subagent routing:** council headers, ad-hoc route tables, and Claude-native subagent provider inheritance stay intact.
10. **I10 — Direct-Anthropic-only helpers:** `promptCacheWarmupService` and `useCaseGeneratorService` gate direct SDK use with `ensureDirectAnthropicCapable(plan)`.
11. **I11 — Header emission from plan only:** consumers emit headers from `plan.headers`, not hand-rolled provider branches.
12. **I12 — Auth env projection through one adapter:** provider auth env vars and proxy headers come from `applyAuthPlanToEnv(plan, env)`; callers do not mutate `process.env`.
13. **I13 — Structured router log:** every constructed plan emits one `[ROUTER] provider route plan resolved` event with the required route, auth, header-name, proxy, and invalid-reason fields.


### Environment variables

Most features can be configured entirely through the Settings UI, but a few environment variables control advanced behavior and operational tuning.

#### Local Backend Development

- `REBEL_API_URL` – Base URL for the Rebel API server.
  - Default: `https://rebel.mindstone.com` (production)
  - For local development: `http://localhost:8080`
  - See [LOCAL_BACKEND_DEVELOPMENT.md](LOCAL_BACKEND_DEVELOPMENT.md) for full setup guide.

#### MCP / Super‑MCP

Rebel now uses a **router‑first, HTTP‑only** Super‑MCP model; there is no supported stdio transport or `SUPER_MCP_USE_HTTP` toggle in the main application. The key MCP‑related environment variables are:

- `SUPER_MCP_HTTP_PORT` – Optional TCP port hint for the HTTP router.  
  - Defaults depend on build channel: production prefers `3000–3024`, beta `3100–3124`, dev `3200–3224` (see `getDefaultSuperMcpPort()` in `systemHealthService.ts`).  
  - `findAvailablePort()` will fall back to nearby ports if the preferred one is in use.
- `MINDSTONE_FORCE_DIRECT_MCP` – **Debugging/escape‑hatch only.** When set to a truthy, non‑`false`, non‑`0` string, forces **direct MCP mode** and bypasses Super‑MCP, regardless of config shape or router settings.
- `MINDSTONE_FORCE_SUPER_MCP` – Legacy override that is no longer honoured by `resolveMcpServers`; it is only surfaced in diagnostics so you can see when it has been set accidentally.
- `SUPER_MCP_ROUTER_CLI` – Legacy/diagnostic hint for environments that launch Super‑MCP manually; the app’s built‑in HTTP manager does **not** read this when spawning the bundled router.

Example (advanced/debugging usage):

```bash
export SUPER_MCP_HTTP_PORT=3200         # Optional: preferred HTTP port for Super-MCP in dev
export MINDSTONE_FORCE_DIRECT_MCP=true  # Force direct MCP mode instead of router (debugging only)
```

For the canonical description of MCP configuration, router vs direct mode, and Super‑MCP HTTP behavior, see:

- `./MCP_ARCHITECTURE.md` – MCP and Super‑MCP configuration, discovery, and mode selection  
- `./SUPERMCP_OVERVIEW.md` – Super‑MCP HTTP transport architecture, health checks, and troubleshooting


#### Streaming behavior (historical)

> **Note:** These environment variables were used by the former Claude Agent SDK subprocess (removed April 2026). Rebel Core runs in-process and does not use these variables.

- `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` – Extended stream timeout in milliseconds used to mitigate “stream closed” errors under heavy concurrent MCP usage.

```bash
export CLAUDE_CODE_STREAM_CLOSE_TIMEOUT=300000
```


#### Voice and audio HTTP timeouts

Voice STT/TTS calls use axios timeouts in the main process (`audioService.ts`) so offline/provider issues fail fast instead of hanging indefinitely. These are configured via `config/app-config.json` (runtime config):

- `config/app-config.json` (generated from `config/app-config.template.json`) can set:
  - `voice.sttTimeoutMs` – Timeout in milliseconds for speech‑to‑text (STT) HTTP requests to providers (OpenAI Whisper, ElevenLabs Scribe). Defaults to `15000` (15s) when unset or invalid.
  - `voice.ttsTimeoutMs` – Timeout in milliseconds for text‑to‑speech (TTS) HTTP requests to providers (OpenAI, ElevenLabs). Defaults to `15000` (15s) when unset or invalid.

  Example `config/app-config.json` fragment:

  ```jsonc
  {
    "voice": {
      "sttTimeoutMs": 15000,
      "ttsTimeoutMs": 15000
    }
  }
  ```

When these timeouts fire, Rebel surfaces a concise, user‑visible error message (e.g. “Unable to reach OpenAI for transcription – check your internet connection”) while logging full provider/status/error details for later debugging (see `LOGGING.md` and `VOICE_AND_AUDIO.md`).


#### Logging

- `MINDSTONE_LOG_LEVEL` – Primary environment variable that controls log verbosity for the main‑process logger.  
- `LOG_LEVEL` – Optional shorthand used in some docs; when set, you should mirror it into `MINDSTONE_LOG_LEVEL` so behavior stays consistent.

```bash
# Preferred: set the main log level directly
export MINDSTONE_LOG_LEVEL=debug

# If your environment already uses LOG_LEVEL, keep them in sync
export LOG_LEVEL=debug
export MINDSTONE_LOG_LEVEL="$LOG_LEVEL"
```

In packaged apps, log files are written under `~/Library/Application Support/mindstone-rebel/logs/` on macOS.


#### Headless CLI (Stages 8–9)

These env-vars control the standalone Node `rebel` binary (`@mindstone/rebel-cli`) and the Electron-backed CLI (`npm run cli --` or `--headless-cli` from the .app).

**Auth (standalone CLI — env-var-only; Electron-backed CLI reads from GUI OAuth):**

- `REBEL_ANTHROPIC_API_KEY` – Anthropic API key. Required for standalone CLI with `anthropic` provider.
- `REBEL_OPENROUTER_API_KEY` – OpenRouter API key. Required for standalone CLI with `openrouter` provider.
- `REBEL_CODEX_TOKEN` – Codex bearer token. Required for standalone CLI with `codex` provider. **Short-session only** — OAuth access tokens expire after ~1 hour. For long Codex sessions, use the Electron-backed CLI (which reuses GUI OAuth tokens).

**CLI operational:**

- `REBEL_CLI_BYPASS_SAFETY=1` – **Dangerous.** Disables tool-safety, memory-write, and auto-continue safety hooks for this process. Emits a mandatory stderr danger banner on every invocation. Use only for trusted automations behind a firewall.
- `REBEL_CLI_APPROVAL_TIMEOUT_MS` – Timeout in milliseconds for interactive approval prompts (TTY mode). Default: `60000`. Non-TTY invocations ignore this.
- `REBEL_OPERATOR_IDENTITY=<name>;<mandate>` – Operator identity for automations. Format: semicolon-separated `name;free-form-mandate`. The name field must not contain `;` characters.
- `REBEL_SUPER_MCP_BIN=<path>` – Override the Super-MCP binary path. Resolution order: env-var → bundled path → `npx super-mcp-router@<pinned-version>` fallback.
- `REBEL_USER_DATA=<path>` – Override the user data directory. Both CLI paths and the GUI must use the same path to share sessions and settings. Platform defaults: macOS `~/Library/Application Support/mindstone-rebel/`, Linux `~/.config/mindstone-rebel/`, Windows `%APPDATA%\mindstone-rebel\`.
- `REBEL_SURFACE=cli-standalone` – Set automatically by the standalone binary. Used internally to guard against loading desktop-only token storage modules.

**Diagnostics (set automatically, not typically set manually):**

- `REBEL_HEADLESS=1` – Set automatically by both CLI bootstraps.
- `REBEL_HEADLESS_CLI=1` – Set automatically by the Electron-backed CLI headless mode detector.

```bash
# Example: standalone CLI with Anthropic auth and custom data path
export REBEL_ANTHROPIC_API_KEY=sk-ant-...
export REBEL_USER_DATA=~/Library/Application\ Support/mindstone-rebel/
rebel run -p "summarise my notes"

# Example: CI pipeline with bypass for trusted automation
export REBEL_CLI_BYPASS_SAFETY=1
rebel run -p "check all open PRs" --provider openrouter
```

For the full CLI reference (commands, flags, two-path model, exit codes), see [`HEADLESS_CLI_ENTRYPOINT_REFERENCE.md`](HEADLESS_CLI_ENTRYPOINT_REFERENCE.md).


#### Analytics (RudderStack)

RudderStack analytics uses a small runtime config (`config/app-config.json`) generated from `config/app-config.template.json` by `scripts/generate-runtime-config.mjs`. That script replaces `{{ env.* }}` placeholders using values from the current environment and any `.env` / `.env.local` files in the project root.

- `RUDDERSTACK_WRITE_KEY` – RudderStack source write key used by the main and renderer analytics clients. Required for `npm run generate:runtime-config`, and therefore for `npm run package` / `npm run dist`.
- `RUDDERSTACK_DATA_PLANE_URL` – RudderStack data plane URL for the same workspace.

For local development and packaging:

- Either export these variables in your shell before running `npm run package` / `npm run dist`, **or**
- Copy `.env.example` to `.env.local`.
  - Set both `RUDDERSTACK_WRITE_KEY` and `RUDDERSTACK_DATA_PLANE_URL` to `DISABLED` to keep analytics turned off while still allowing `npm run generate:runtime-config`, `npm run package`, and `npm run dist` to succeed.
  - Replace `DISABLED` with real RudderStack values to enable analytics; on app launch the main process sends a one-off test event to validate the configuration and surfaces the result in Settings → Diagnostics.
  `.env.local` is ignored by git; `.env.example` is committed as a safe template.


### Maintenance

- When adding or changing app settings, environment variables, or configuration flows, update this document as part of the same change.  
- Other docs that describe configuration (e.g. `SETUP_DEVELOPMENT_ENVIRONMENT.md`, `MCP_ARCHITECTURE.md`, `ARCHITECTURE_OVERVIEW.md`) should link here for canonical lists and explanations rather than duplicating content.


