---
description: "Hub for the model / provider / billing / thinking territory — how a model is chosen, routed, authed, billed, and given a thinking budget, with a one-line signpost to every doc in the territory."
last_updated: "2026-06-20"
---

# Models, Providers, Billing & Thinking — Overview

The single front door to how Rebel turns "the user picked a model" into a real, authed, billed
LLM call with the right thinking budget. This territory grew organically — identifying models
(variants, thinking levels) across multiple providers (Anthropic direct, OpenRouter and its
downstream handoff, Codex/ChatGPT Pro, local), under multiple billing models (BYOK pay-per-use,
subscription, Mindstone-managed flat fee), with thinking / working / behind-the-scenes / council
/ recovery roles and several fallback mechanisms. This doc maps it; the linked docs go deep.

It is sparse on *how* (code is the source of truth) and dense on *where* and *why*. Start here,
then jump to the one or two docs that own your concern.

> **Where this is *going* (vs how it works today):** for the multi-provider / smart-picking
> **direction** — the vision, Greg's settled decisions, decision reversals, sequencing, and the
> cross-cutting open questions to resolve before implementing — see
> [MODEL_AND_PROVIDER_DIRECTION](./MODEL_AND_PROVIDER_DIRECTION.md). This doc is the *now*; that one is the *next*.

> **Naming trap — read this first.** `CONTEXT_AND_PROVIDER_HIERARCHY.md` is about the **React
> context/provider component tree** in the renderer. It is **not** about LLM context windows or
> model providers, despite the name. For LLM provider routing you want
> [PROVIDER_RESOLUTION_AND_ROUTING](./PROVIDER_RESOLUTION_AND_ROUTING.md).

## The journey of a request (chosen → routed → authed → billed → thinking budget)

1. **Identity.** The user's model choice is a model id (+ optional `[1m]` variant, + a
   `model:`/`profile:` storage prefix). Identity, pricing, capabilities, and all derived
   registries are anchored on one catalog. → [MODEL_REGISTRIES](./MODEL_REGISTRIES.md),
   [MODEL_CONSTANTS](./MODEL_CONSTANTS.md).
2. **Settings resolution.** That choice is read out of `AppSettings` (the provider-neutral
   `models.*` namespace composed per-field with the legacy `claude.*` mirror) into an effective
   resolved view. → [MODEL_SETTINGS_RESOLUTION](./MODEL_SETTINGS_RESOLUTION.md).
3. **Role + thinking budget.** The choice is assigned to a role (Working / Thinking / Background /
   Recovery) and given a thinking budget via one of two distinct axes (plan-mode model split vs
   reasoning effort). → [MODEL_ROLES_AND_THINKING](./MODEL_ROLES_AND_THINKING.md);
   automatic fallbacks → [ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK](./ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK.md);
   parallel council fan-out → [MULTI_MODEL_COUNCIL_MODE](./MULTI_MODEL_COUNCIL_MODE.md).
4. **Routing.** `(model id + active provider/profile)` resolves to a concrete `ModelClient`
   pointed at the right upstream. → [PROVIDER_RESOLUTION_AND_ROUTING](./PROVIDER_RESOLUTION_AND_ROUTING.md);
   the local proxy + alternative/local providers → [LOCAL_MODEL_SUPPORT](./LOCAL_MODEL_SUPPORT.md);
   runtime architecture → [REBEL_CORE](./REBEL_CORE.md).
5. **Request shaping.** Each upstream endpoint accepts a different parameter set; unsupported
   params are stripped/translated at the right seam. → [PROVIDER_REQUEST_PARAM_MATRIX](./PROVIDER_REQUEST_PARAM_MATRIX.md).
6. **Auth.** The proxy is the auth boundary: SDK clients carry a sentinel, the real upstream
   credential is injected only at the proxy edge. → [PROXY_AUTH_BOUNDARY](./PROXY_AUTH_BOUNDARY.md);
   app-level auth + per-provider credentials → [AUTHENTICATION](./AUTHENTICATION.md),
   [CLAUDE_MAX_AUTH](./CLAUDE_MAX_AUTH.md) (deprecated — see banner there).
7. **Billing.** Who pays (BYOK / subscription / Mindstone-managed flat fee) and the managed-tier
   lifecycle. → [BILLING_AND_SUBSCRIPTION_TIERS](./BILLING_AND_SUBSCRIPTION_TIERS.md),
   [MANAGED_PROVIDER_LIFECYCLE](./MANAGED_PROVIDER_LIFECYCLE.md); cost accounting →
   [COST_TRACKING](./COST_TRACKING.md).

**Shipped recently (2026-06)** — territory-hub signposts only; code is SSOT:
- **Codex quota exhaustion → HTTP 429**, not a generic 500/502 — route-resolved proxy catch +
  SSE terminal paths preserve the quota signal so downstream classifiers see `rate_limit`, not
  `api_error`. → `throwCodexTerminalError` in `src/core/services/codexResponsesTranslator.ts`;
  `src/main/services/localModelProxyServer.ts`.
- **`[1m]` / extended-context capability follows the catalog**, not visibility-filtered
  `MODEL_OPTIONS` — `modelSupportsExtendedContext` in `src/shared/utils/modelNormalization.ts` reads
  `supportsExtendedContext` without the `isMainModel` picker filter (so hiding a model doesn't
  silently flip its 1M support). → [MODEL_REGISTRIES](./MODEL_REGISTRIES.md) § `[1m]` suffix.
- **Default prompts root resolves on demand (REBEL-63K)** — `ensureConfigured()` in
  `src/core/services/promptFileService.ts` lazily resolves `getSystemSettingsPath()/prompts` instead
  of throwing "not configured" on reads; cloud bootstrap prompt-config parity +
  `scripts/check-cloud-bootstrap-policy.ts` gate. → [CLOUD_BOOTSTRAP_POLICY](./CLOUD_BOOTSTRAP_POLICY.md).
- **Claude Fable 5 hidden from selection surfaces** while API access is withdrawn — catalog
  `isMainModel: false` on direct + OpenRouter rows (`src/core/services/localInference/modelCatalog.ts`); capability flags stay
  catalog-backed. → [MODEL_AND_PROVIDER_DIRECTION](./MODEL_AND_PROVIDER_DIRECTION.md) (Fable 5).
- **Multi-provider routing foundation — flag-gated, INERT in production.** Foundation work
  (ordered `enabledProviders` chain + rate-limit failover / provider divert incl. Codex→Claude
  divert correctness, Stages 4b–7) lives behind `experimental.multiProviderRoutingEnabled`
  (optional boolean, **default off** — `src/shared/types/settings.ts`). With the flag off there is
  **no user-visible behaviour**: the router resolves the single `activeProvider` and ignores the
  chain; the Settings "Backup connections" UI is hidden. Router gate: `enumerateProviderModeCandidates`
  in `src/core/rebelCore/providerRouting.ts` early-returns to the single `activeProvider` unless the flag
  is on (`selectProviderMode` is the legacy single-provider resolver, not itself flag-gated); failover
  gate: the Stage 4b `multi-provider-rate-limit-fallback` branch in
  `src/main/services/turnErrorRecovery.ts`. The flag-gated "Backup connections" settings section
  (`BackupConnectionsSection.tsx`, gated in `AgentsTab.tsx`) edits the chain via the `writeProviderList`
  `activeProvider`↔`enabledProviders` write contract (`src/shared/utils/settingsUtils.ts`); the router
  reads the raw priority list via `getEnabledProviders` while the UI shows active-at-head via
  `getDisplayProviderChain`. `enabledProviders` cloud-syncs. → [SMART_MODEL_PICKING](./SMART_MODEL_PICKING.md),
  [UI_SETTINGS_AND_FORMS](./UI_SETTINGS_AND_FORMS.md); plan `docs/plans/260618_multiprovider-foundation/PLAN.md`.

## The docs in this territory

**Identity & registries**
- [MODEL_REGISTRIES](./MODEL_REGISTRIES.md) — every model registry, which derive from the catalog vs which are hand-maintained (the drift surface), the identity axes, and the three migration mechanisms.
- [MODEL_CONSTANTS](./MODEL_CONSTANTS.md) — the Anthropic-default constants, normalization rules, and the BTS storage-prefix codec.
- [NEW_MODEL_SUPPORT_PROCESS](./NEW_MODEL_SUPPORT_PROCESS.md) — SSOT checklist for adding a new model across the registries.
- [NEW_PROVIDER_SUPPORT_PROCESS](./NEW_PROVIDER_SUPPORT_PROCESS.md) — the **provider** analogue: archetypes (managed-pool / OAuth-subscription / BYOK), the provider vocabulary (the orthogonal `ActiveProvider`/`ModelProviderType`/`RouteSurface`/route-internal/`OpenAIProviderType` axes), the phased file-by-file checklist, what's guarded vs convention-only, and the recommended `ProviderDescriptor`-registry cleanup.
- [ADDING_AN_OPENROUTER_MODEL](./ADDING_AN_OPENROUTER_MODEL.md) — fast-path runbook for a third-party OpenRouter model: catalog entry, CN/SGP provider allowlist, and eval verification.
- **"Recommended for most people" engine** — `src/core/modelRecommendation/` (public API `recommendModels(input) → RecommendationResult` via `index.ts`; plan `docs/plans/260614_recommended-models-engine/PLAN.md`). A PURE, deterministic `src/core/` selector that, given the providers/connections a user has (`activeProvider`, `ProfileConnectivityState`, the managed allow-list), picks a small well-rounded shortlist — one highly-intelligent model, one cheap, one with good vision, optionally a middle + a 2nd cross-family intelligence pick. It is the **source for the "Recommended for most people" group in the Add-a-model flow** (Settings → Agents & Voice), replacing today's accidental `isMainModel` + provider-connected + first-6-in-file-order logic in `ChoosePathStep.tsx`. Candidate identity is the **route-aware catalog row** `(providerType, routeSurface, normalizedModelId, optionValue)`; effective cost is **provider-conditional** (reuses `resolveBillingSourceForModel` so GPT-5.5 flips to flat on ChatGPT Pro, Mindstone-plan models are flat, OpenRouter is metered) and `availability` (`usable-now`/`needs-connection`/`on-plan`) is encoded in the output types so an unavailable pick can't be silently consumed. Per-model quality/cost metadata + a committed KW-Pareto seed artifact live in `recommendationMetadata.ts` (provenance is load-bearing — eval-grounded outranks editorial); maintenance is gated by the inverted catalog-rot guard + step 14d of [NEW_MODEL_SUPPORT_PROCESS](./NEW_MODEL_SUPPORT_PROCESS.md). **Deferred consumers (NOT yet built):** the Add-a-model UI rewrite to consume the engine, and a runtime-router usable-routing-pool projection (filtering to `availability:'usable-now'`). Quality net = deterministic golden tests (`recommendModels.test.ts`, authoritative) + an advisory LLM-as-judge eval (`npm run eval:recommended-models`). **Multi-provider direction (plan `docs/plans/260614_recommended-models-followup/`):** the engine is a downstream *consumer* of the provider/cost model the [smart-model-routing](../plans/260614_smart-model-routing/) plan is building (its Layer 2 ordered/enabled-provider chain — the eventual replacement for a single `activeProvider`). The engine's managed-**availability** gate is now a single shared swap-point, `isManagedRouteUsable` (`src/shared/types/managedProvider.ts`) — byte-identical to today's `activeProvider==='mindstone'` — which the smart-model-routing work will widen to per-managed-key at its Stage 1; the matching cost-side flip in `resolveBillingSourceForModel` (`src/shared/utils/billingSource.ts:61`) must widen **together** with it, or a managed pick would read `usable-now` while still priced `pool`/`paid`.

**Settings → runtime**
- [MODEL_SETTINGS_RESOLUTION](./MODEL_SETTINGS_RESOLUTION.md) — `models.*` vs legacy `claude.*` per-field composition, the renderer-safe pure-twin accessors, `normalizeSettings`, and the two `activeProvider` reification paths.
- [SETTINGS_CONFIGURATION_AND_ENVIRONMENT](./SETTINGS_CONFIGURATION_AND_ENVIRONMENT.md) — where model/provider fields live in `AppSettings`.

**Roles, thinking & fallback**
- [MODEL_ROLES_AND_THINKING](./MODEL_ROLES_AND_THINKING.md) — the four roles → storage → resolver mapping, and the two distinct "thinking" axes (plan-mode split vs reasoning effort). UI role health and the runtime resolver now share one precedence core (`resolveModelRolePrecedence`) for working/thinking/background effective-model resolution, so the Settings UI no longer disagrees with what the agent runs there (recovery stays a documented UI-only carve-out).
- [ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK](./ARCHITECTURE_1M_CONTEXT_AND_AUTH_FALLBACK.md) — 1M context + the automatic fallback chains.
- [MULTI_MODEL_COUNCIL_MODE](./MULTI_MODEL_COUNCIL_MODE.md) — the orthogonal parallel multi-model path.
- [SMART_MODEL_PICKING](./SMART_MODEL_PICKING.md) — **intent/goals** for auto-choosing which model runs which step across the user's providers: what exists today (planner-driven, single-provider, flag-gated adaptive routing) vs the goals (multi-provider pool, rate-limit failover, cost/cache/diversity preferences) and the hard tensions between them (esp. the prompt-cache cold-start switch cost). NOT a spec.

**Routing & request shaping**
- [PROVIDER_RESOLUTION_AND_ROUTING](./PROVIDER_RESOLUTION_AND_ROUTING.md) — the end-to-end decision → client-construction → proxy-egress flow and the model-dialect axis.
- [PROVIDER_REQUEST_PARAM_MATRIX](./PROVIDER_REQUEST_PARAM_MATRIX.md) — per-endpoint request-parameter capability contract.
- [CUSTOM_GATEWAY_COMPATIBILITY](./CUSTOM_GATEWAY_COMPATIBILITY.md) — `providerType:'other'` OpenAI-compatible gateways (litellm → Vertex/Bedrock/Azure): the `reasoning_effort`→native-thinking translation hazard, the auto-detected `thinkingCompatibility` suppression gate (Test button → no `reasoning_effort`, self-healing), and what to re-check when bumping a default model.
- [LOCAL_MODEL_SUPPORT](./LOCAL_MODEL_SUPPORT.md) — the local proxy, BYO/local presets, and BTS routing.
- [REBEL_CORE](./REBEL_CORE.md) — the agent runtime the routing sits inside.
- [LLM_CALL_SITES](./LLM_CALL_SITES.md) — inventory of every LLM call site and call mechanism.

**Auth & credentials**
- [PROXY_AUTH_BOUNDARY](./PROXY_AUTH_BOUNDARY.md) — the proxy-is-the-auth-boundary invariant, the sentinel, and the single strip/inject site.
- [AUTHENTICATION](./AUTHENTICATION.md) — app-level auth (OAuth/OTP) and the `/api/config` delivery.
- [CLAUDE_MAX_AUTH](./CLAUDE_MAX_AUTH.md) — Claude Max OAuth (**deprecated** — see the banner in that doc).

**Billing & cost**
- [BILLING_AND_SUBSCRIPTION_TIERS](./BILLING_AND_SUBSCRIPTION_TIERS.md) — the four billing models, Dash/Rogue tiers, the BillingSource label vocabulary, and the entitlement axes (incl. the Managed-Cloud disambiguation).
- [MANAGED_PROVIDER_LIFECYCLE](./MANAGED_PROVIDER_LIFECYCLE.md) — the Mindstone-managed provider activation/reconcile/opt-out lifecycle.
- [COST_TRACKING](./COST_TRACKING.md) — per-turn cost accounting and aggregation.

## Cross-cutting structural notes (durable)

Several recurring incident classes live at the seams of this territory. They are durable design
risks (not live bugs) and are the natural backlog if this area is ever refactored:

- ~~**Dual provider resolvers.**~~ **RESOLVED 2026-06-01.** The legacy `clientFactory.ts:ResolvedTarget`
  / `resolveTargetForModel` resolver was deleted (commit `73f305559`, routing-SSOT Stage 3.3),
  leaving `providerRouteDecision.ts:ProviderRouteDecision` as the single decision authority;
  `scripts/check-no-legacy-resolver.ts` blocks its return. Kept as a tombstone because the stale
  "dual-resolver" wording previously misled agent researchers into citing a non-existent
  `clientFactory.ts:determineProviderForModel()`. → PROVIDER_RESOLUTION_AND_ROUTING § dual-resolver tension (RESOLVED).
- ~~**Dormant "trio" routing scaffolding.**~~ **REMOVED 2026-06-12.** The presence-gated
  `modelRoutingConfig` / `resolveActiveTrio` / `resolveTurnModelViaTrio` scaffolding never wired in
  and was deleted (commit `6bb7356a`; orphaned `providerRouteEligibility.ts` removed 2026-06-14). The
  live adaptive-routing foundation is `routeRef` + the canonical `ResolvedModelCapabilities` read-model
  + catalog-backed capability resolution. Don't cite the trio symbols. →
  PROVIDER_RESOLUTION_AND_ROUTING § routing-model consolidation; [SMART_MODEL_PICKING](./SMART_MODEL_PICKING.md).
- **State-provenance conflation.** Model slots hold *either* user-chosen *or* server-managed
  values with no provenance metadata; provider/string-shape is used to infer intent. → 260521 postmortem; MANAGED_PROVIDER_LIFECYCLE.
- **Model-id lifecycle is stringly-typed.** Stored choice vs routing id vs wire id vs catalog id
  are all `string`, differentiated by convention + per-site decoders. → 260529 BTS prefix-leak postmortem; MODEL_REGISTRIES § identity axes.
- **No typed request-parameter capability contract.** Unsupported-param leakage is caught by
  per-seam strips. → PROVIDER_REQUEST_PARAM_MATRIX.

## Cross-surface failover posture (multi-provider 429 chain)

> Verified 2026-06-22 against current code (`docs/plans/260622_provider-routing-prodflip-prep/`). The
> multi-provider rate-limit (429) failover chain is **flag-gated behind the OFF flag**
> `experimental.multiProviderRoutingEnabled` and is not yet on by default.

The Stage-4b 429 failover chain (`handleRateLimitFallback` in `src/main/services/turnErrorRecovery.ts`,
candidate enumeration via `getFailoverCredentialCandidates` in `src/core/rebelCore/providerRouting.ts`)
runs in **core**, with **no platform guard** — desktop, cloud, and mobile all execute the same chain. The
two surface-specific inputs both resolve identically through boundary seams, so the chain is cross-surface
by construction:

- **Codex connectivity** — `resolveCodexConnectivity` reads `getCodexAuthProvider().isConnected()` (a
  `@core/codexAuth` boundary). Cloud wires it at `cloud-service/src/bootstrap.ts` (`setCodexAuthProvider(DEFAULT_CODEX_AUTH_PROVIDER)`),
  so a codex candidate is included on cloud exactly when connectivity is `'connected'` — same computation
  as desktop.
- **Managed (`mindstone`) key** — `providerModeFor` reads `settings.hasManagedKey ?? getManagedKeyAvailability()`.
  Cloud registers the seam **fail-closed** (`registerManagedKeyAvailability(() => false)` at bootstrap), AND
  managed is **excluded from auto-failover on every surface by design** (`excludeManagedFromFailover` — a
  `mindstone` entry survives only when it equals the explicit primary `activeProvider`, never as a backup).
  So managed-as-failover is impossible on any surface; this is orthogonal to flip readiness, not a regression.

Parity is pinned by the cloud A→B re-drive test `cloud-service/src/__tests__/providerFailover.cloud.test.ts`,
which drives the **real** `handleRateLimitFallback` with the **real** candidate enumeration through the
cloud-wired codex/managed seams (mocking only the LLM transport / side-effect sinks).

> **DI-05 — Anthropic-OAuth (claude-max) as a server-side failover credential on cloud (carved out, NOT
> built).** Today an Anthropic-OAuth credential is reachable only via the desktop keychain; there is no
> server-side token push channel or settings fallback, so when the multi-provider flag is ON an
> Anthropic-as-failover candidate is **unreachable on cloud/mobile** (simply absent from
> `getFailoverCredentialCandidates`'s usable set on those surfaces). This is **not a flip blocker**: cloud
> users still fail over among OpenRouter (personal) and Codex, and managed is excluded from failover on every
> surface by design. Making Anthropic-OAuth work as a server-side failover credential requires a new
> cross-surface token channel/storage and is itself a parity + security decision — tracked as **DI-05**,
> explicitly out of scope for the prod-flip-prep run.

## See also

- [ARCHITECTURE_OVERVIEW](./ARCHITECTURE_OVERVIEW.md) — the system-wide architecture map that links here.
- [BOUNDARY_REGISTRY](./BOUNDARY_REGISTRY.md) — typed cross-module/process boundaries, several of which live in this territory.
- [DEV_DOCUMENTATION](./DEV_DOCUMENTATION.md) — the doc philosophy these docs follow (intent-first, heavily signposted, many small docs).
