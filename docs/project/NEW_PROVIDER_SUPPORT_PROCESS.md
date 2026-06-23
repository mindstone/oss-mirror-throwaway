---
description: "Comprehensive file-by-file process for adding a new provider (a connection/auth/routing/billing source like ChatGPT Pro, Mindstone-managed, OpenRouter, Anthropic, Gemini) — archetypes, the provider vocabulary, phased checklist, guards, cross-surface, discovery grep, and recommended cleanups"
last_updated: "2026-06-12"
---

# New Provider Support Process

Step-by-step process for adding a **new provider** — a connection / auth / routing / billing source such as ChatGPT Pro subscription, a Mindstone-managed subscription, OpenRouter, Anthropic direct, or Gemini. This is the **provider** analogue of [NEW_MODEL_SUPPORT_PROCESS](./NEW_MODEL_SUPPORT_PROCESS.md), which covers adding a new **model** within an existing provider.

> **Provider vs model — read this first.** A *model* is an entry in the catalog (`claude-opus-4-8`, `openai/gpt-5.5`). A *provider* is *how Rebel reaches and pays for* a model: which credential it uses, which transport/proxy it routes through, who is billed. Adding a model is mostly a catalog edit ([NEW_MODEL_SUPPORT_PROCESS](./NEW_MODEL_SUPPORT_PROCESS.md)). Adding a provider threads a new identity through ~40 must-touch files across types, auth, routing, UI, persistence, and tests. If you only need a new model from an existing provider, **stop and use the model process instead.**


## See Also

- [MODEL_AND_PROVIDER_OVERVIEW](./MODEL_AND_PROVIDER_OVERVIEW.md) — the **territory hub** this doc lives under. Start there for the "journey of a request: chosen → routed → authed → billed → thinking budget" map and signposts to every doc below.
- [NEW_MODEL_SUPPORT_PROCESS](./NEW_MODEL_SUPPORT_PROCESS.md) — the structural analogue (adding a model, not a provider). Reuse its grep/verify discipline.
- [PROVIDER_RESOLUTION_AND_ROUTING](./PROVIDER_RESOLUTION_AND_ROUTING.md) — the resolver → client-construction → proxy-egress flow and the dual-resolver tension (`ResolvedTarget` vs `ProviderRouteDecision`).
- [MODEL_SETTINGS_RESOLUTION](./MODEL_SETTINGS_RESOLUTION.md) — `models.*` vs legacy `claude.*`, `normalizeSettings`, the two `activeProvider` reification paths.
- [AUTHENTICATION](./AUTHENTICATION.md) + [PROXY_AUTH_BOUNDARY](./PROXY_AUTH_BOUNDARY.md) — credential resolution and the proxy strip/inject boundary where a provider's secret is injected.
- [BILLING_AND_SUBSCRIPTION_TIERS](./BILLING_AND_SUBSCRIPTION_TIERS.md) — the four billing models and the `BillingSource` label vocabulary.
- [MANAGED_PROVIDER_LIFECYCLE](./MANAGED_PROVIDER_LIFECYCLE.md) — the Mindstone-managed activation / reconcile / opt-out lifecycle: the closest precedent for a new **managed** provider.
- [LOCAL_MODEL_SUPPORT](./LOCAL_MODEL_SUPPORT.md) — the local proxy and profile-shaped providers: the precedent for a **profile/BYOK** provider.
- [CROSS_SURFACE_PARITY_CHECKLIST](./CROSS_SURFACE_PARITY_CHECKLIST.md) + [CROSS_SURFACE_PARITY_TRAP_CATALOGUE](./CROSS_SURFACE_PARITY_TRAP_CATALOGUE.md) — desktop / cloud / mobile parity (the `activeProvider: 'codex'` trap is the canonical example).
- [PROVIDER_REQUEST_PARAM_MATRIX](./PROVIDER_REQUEST_PARAM_MATRIX.md) — per-endpoint request-parameter capability contract (request shaping).
- [ADDING_AN_OPENROUTER_MODEL](./ADDING_AN_OPENROUTER_MODEL.md) — the OpenRouter-model fast path (model, not provider — shows catalog/allow-list mechanics).


## When to Use This Process

Use this whenever you add a value to the `ActiveProvider` union — a new way for Rebel to authenticate, route, and bill LLM calls:

- A new **subscription** source (e.g. a second OAuth-subscription like ChatGPT Pro/Codex).
- A new **managed-pool** source (e.g. a second Mindstone-style flat-fee plan that seeds an allow-list server-side).
- A new **direct BYOK provider** (e.g. a first-party Gemini or a new OpenAI-compatible endpoint that needs its own credential + catalog).

Do **not** use this process for: a new model from an existing provider (use [NEW_MODEL_SUPPORT_PROCESS](./NEW_MODEL_SUPPORT_PROCESS.md)); a new OpenRouter model (use [ADDING_AN_OPENROUTER_MODEL](./ADDING_AN_OPENROUTER_MODEL.md)); a coding-droid model upgrade ([SUBAGENT_MODEL_UPGRADE_PROCESS](./SUBAGENT_MODEL_UPGRADE_PROCESS.md)).


## Step 0 (decide first): Which provider archetype are you adding?

**This is the most important decision in the whole process** — it determines how many of the phases below apply. The three archetypes differ in surface by roughly an order of magnitude. Pick yours, then read the per-phase tables filtering by the "Archetypes" column.

| Archetype | What it is | Worked example | Surface (rough) | Key trait |
|---|---|---|---|---|
| **A. Managed-subscription pool** | A flat-fee plan whose key + allow-list are seeded by the server via `/api/config`; reuses an *existing* route surface (OpenRouter transport + `pool`/`subscription` billing). The client never sees the raw key. | **`mindstone`** (just shipped — the canonical precedent) | Smallest | Reuses a transport; surfaced as a **data-gated UI section**, not a new catalog handle. Adding it is mostly one `ActiveProvider` value + `OPENROUTER_EFFECTIVE_PROVIDERS` + a managed-key resolver + the data-gated section. |
| **C. OAuth-subscription** | A user-authenticated subscription with an OAuth/PKCE login flow and its own token lifecycle (refresh or static), proxied through its own transport. | **`codex`** (ChatGPT Pro) | Medium | Adds a login service + token store + 401/refresh lifecycle + a proxy-identity header + a provider card. No catalog allow-list join. |
| **B. Full BYOK / direct provider** | A bring-your-own-key direct provider needing its own credential entry, catalog, presets, and (often) a new `ModelProviderType` + transport. | A first-party **Gemini**, or a new OpenAI-compatible endpoint | Largest | Adds a `ModelProviderType`, a `CatalogProviderType`, a `derive<X>Catalog()`, presets, a `PROVIDER_PRESETS` entry, and possibly a new `ProviderRouteTransport`. |

> **The Mindstone shortcut (Archetype A).** Mindstone was added with **zero new catalog handle**: it rides the existing `openrouter` `pool` catalog and is surfaced as a data-gated section (`isMindstoneActive && managedAllowedModels.length > 0`) joined against `PROVIDER_CATALOGS.openrouter`. The 4-handle `CatalogConnectionHandle` enum (`codex|openrouter|anthropic|gemini`) was **untouched**. If your provider is a managed/subscription-pool that reuses an existing route surface, you can skip most of Phase 4's catalog work — see [the Mindstone pattern](#the-mindstone-pattern-archetype-a-shortcut) below.

> **The codex precedent (Archetype C).** Codex/ChatGPT Pro is `providerType: 'openai'` + `routeSurface: 'subscription'` + `ActiveProvider: 'codex'`. It is the template for an OAuth-subscription provider: a loopback-PKCE login service (`codexAuthService.ts`), a dedicated token store with refresh (`codexTokenStorage.ts` + `codexAuthCore.ts`), a proxy-identity header, and a hand-written provider card in AgentsTab.

Record the chosen archetype (and *why* it is that archetype) in your planning doc before writing code, exactly as the model process records the selectability/tier decision.


## The provider vocabulary (the orthogonal axes — do not conflate them)

There is **no single "Provider" abstraction**. A provider's identity is expressed along several independent axes, each defined in a different place, each touched by a different archetype. Conflating them is the single biggest documentation/implementation trap. Learn this table before touching code.

| Axis | Type / location | What it discriminates | When a new provider touches it |
|---|---|---|---|
| **`ActiveProvider`** | `src/shared/types/settings.ts:383` — `'anthropic' \| 'openrouter' \| 'codex' \| 'mindstone'` | The **single in-use routing switch** — the radio-like "what powers Rebel right now". Persisted on `AppSettings.activeProvider`. **Closed union → adding a member is compile-forcing.** | **Always** (every archetype). This is your guaranteed entry point: `selectProviderMode` ends in `assertNever(settings.activeProvider, 'ActiveProvider')` (`providerRouting.ts:191`) so the compiler points you at the first switch. |
| **`ModelProviderType`** | `src/shared/types/settings.ts:694` — `anthropic\|openai\|google\|together\|cerebras\|openrouter\|other\|local` | The **catalog / preset / credential** axis (profile-level). Feeds `PROVIDER_CATALOGS`, `PROVIDER_PRESETS`, dedup keys, display-name maps. `ProviderKeyId = Exclude<ModelProviderType, 'anthropic'\|'other'\|'local'>` (settings.ts:75) drives shared `ProviderKeys`. | **Archetype B only** (a genuinely new model API / endpoint). Archetypes A and C reuse an existing `ModelProviderType` (`mindstone` borrows `openrouter`; `codex` is `openai`). |
| **`RouteSurface`** | `src/shared/types/settings.ts:696` — `'subscription' \| 'api-key' \| 'pool' \| 'local'` (on `ModelProfile`/`CatalogEntry`) | The **billing/profile classification**. `(providerType, routeSurface, normalizeCatalogModelId(model))` is the canonical catalog **dedup key** (`providerCatalogs.ts`). ChatGPT Pro and a direct OpenAI key share `(openai, model)` and differ *only* by `routeSurface`. | Whenever the provider's billing/dedup classification differs from an existing one. Often reused (Mindstone reuses `pool`/`subscription`). |
| **Route-internal enums** | `src/shared/types/providerRoute.ts` — `ProviderRouteProvider` (:9), `ProviderRouteTransport` (:19), `ProviderModelDialect` (:39), `PROVIDER_CREDENTIAL_SOURCES` (:46); `ProviderMode` (`providerRouting.ts:89`) | The **wire/transport** layer: which proxy, which dialect, which credential-source pairing. NOT 1:1 with `ActiveProvider` — `mindstone` is **absent** here (it dispatches *through* the `openrouter` route provider). | Archetype C/B if it gets its own transport (adds a `ProviderRouteTransport` + threads `deriveDispatchPath`/transport sets/clientFactory switch). Archetype A reuses the OpenRouter transport → no new member. |
| **`OpenAIProviderType`** | `src/core/rebelCore/clients/openaiClientTypes.ts:12` — `'openai' \| 'together' \| 'cerebras' \| 'other'` | The **feature-gating** axis. `providerFeatureGuards.ts` predicates switch on this, NOT on `ActiveProvider`. Guards the "feature added to the shared OpenAI client silently fans out to a provider that can't do it" bug class. | **Only** if the provider introduces a new OpenAI-compatible *endpoint type*. A subscription/managed provider usually does NOT add a predicate here. **Watch the `<8` budget gate** (see Guards). |
| **`BillingSource`** | `src/shared/utils/billingSource.ts:4` — `'subscription' \| 'pool' \| 'pay-per-use' \| 'local'` | The **UI billing pill** label/tooltip. Derived from `RouteSurface`. | Only if the provider has a genuinely new cost model. Usually reused. |

> **Worked mapping.** `codex` = `ActiveProvider:'codex'` + `ModelProviderType:'openai'` + `RouteSurface:'subscription'` + transport `codex-proxy` + `OpenAIProviderType:'openai'`. `mindstone` = `ActiveProvider:'mindstone'` + **no `ModelProviderType` of its own** (borrows `openrouter`) + `RouteSurface:'pool'`/`'subscription'` + transport `openrouter-proxy` (absent from `ProviderRouteProvider`) + **no `OpenAIProviderType`**. The asymmetry is the point: `mindstone` is purely an `ActiveProvider` + data-gating exercise.


## Phased file-by-file checklist

The **Archetypes** column tells you whether a row applies: **A** = managed-pool, **B** = BYOK/direct, **C** = OAuth-subscription, **All** = every archetype. Skip rows that don't match your Step-0 archetype.

> **`ActiveProvider` is compile-atomic, the rest is not.** Adding the literal to `ActiveProvider` (Phase 1, row 1) immediately red-compiles every `assertNever` switch (Phase 2/3 — `selectProviderMode`, `getProviderModelDefaults`, route-decision dispatch). Those are your *guaranteed* stops. The ~40 bare `activeProvider === '<literal>'` branches (Phase 4/5) and UI cards are **convention-only** — they compile fine while silently no-op'ing. The [discovery grep](#discovery-finding-all-references) is how you find them.

### Phase 1: Type, classification & defaults (the identity spine)

| # | File | What a new provider changes | Archetypes |
|---|------|-----------------------------|------------|
| 1 | `src/shared/types/settings.ts:383` | Add the literal to `ActiveProvider` + a JSDoc line (376-382). **This is the master change** — it compile-forces every `assertNever` switch below. | All |
| 2 | `src/shared/utils/providerDefaultConstants.ts:73` | If the provider is OpenRouter-routed (managed-pool, Mindstone-shaped), add its literal to `OPENROUTER_EFFECTIVE_PROVIDERS`. **This single edit updates BOTH `getDefaultModelForProvider` and `settingsUtils.normalizeSettings`'s `isEffectivelyOpenRouter` at once** — the one working co-consumer chokepoint (the comment at :60-72 documents this intent). Non-OR providers skip it. | A |
| 3 | `src/shared/utils/providerDefaultConstants.ts` | Add `<PROVIDER>_DEFAULT_{WORKING,THINKING,BTS}_MODEL` constants (mirroring `MINDSTONE_DEFAULT_*` at :96-98 / `CODEX_DEFAULT_*` / `OR_DEFAULT_*`). For managed providers these are **client fallback only** — the server is the source of truth and the client only reaches them when a slot is unseeded; keep them allow-list-safe (matching the seeded tier) to avoid a `MANAGED_MODEL_NOT_ALLOWED` 403. | All |
| 4 | `src/shared/utils/getDefaultModelForProvider.ts` | Add an `if (activeProvider === '<new>')` early-return block (mirroring the Mindstone special-case), OR fold into the `isOpenRouterEffectiveProvider` branch if defaults match BYO OpenRouter. `getProviderModelDefaults()` ends in an `assertNever` discriminated switch — it compile-forces. | All |
| 5 | `src/shared/types/settings.ts:694` (`ModelProviderType`) + `:696` (`RouteSurface`) | Only if the provider is a new model API (B) — add a `ModelProviderType` member; reuse an existing `RouteSurface` unless the billing model is genuinely new. | B |
| 6 | `src/shared/types/providerRoute.ts` | If the provider gets its own transport: add to `PROVIDER_ROUTE_PROVIDERS` (:9), `ProviderRouteTransport` (:19), a `ProviderModelDialect` (:39 — usually reuse), and `PROVIDER_CREDENTIAL_SOURCES` (:46 — add `<provider>-managed-key`/`-token` + a `missing-<provider>` twin). Reused-transport providers (A) skip the transport/dialect members. | B, C |

### Phase 2: Auth, connection & credential resolution

| # | File | What a new provider changes | Archetypes |
|---|------|-----------------------------|------------|
| 7 | New `src/main/services/<x>AuthService.ts` + flow core in `src/core/services/<x>AuthCore.ts` | The login flow. **Loopback PKCE** (codex-style): reuse `bindLoopbackServers()` from `codexAuthService.ts:101-177` (dual-stack 127.0.0.1 + ::1 on a fixed allow-listed port set — the `d06ff08bc` Happy-Eyeballs fix) with your own port set + handler. **Worker + deep-link** (OpenRouter-style): extend the `OAuthRedirectConnector` union in `src/core/services/oauthRedirectUri.ts`, add a deep-link `startsWith` case in `src/main/index.ts`, and a `handle<X>DeepLinkCallback`. Keep PKCE math + token-refresh in `src/core` so cloud/mobile reuse them; keep keychain/safeStorage/IPC in `src/main`. | C |
| 8 | New `src/main/ipc/<x>Handlers.ts` + register in `src/main/index.ts` | IPC handlers (`<x>:login`, `<x>:logout`, `<x>:status`); broadcast `settings:external-update` on token change. | C |
| 9 | `src/core/services/tokenStorage/providerTokenStorage.ts` (or a bespoke store) | Token storage. Prefer the generic, cloud-compatible `providerTokenStorage.ts` (`saveProviderOAuthTokens(providerId, …)`); only fork a bespoke store for special token shapes (codex's `accountId/email`). Bespoke store → add a `*_TOKEN_STORE_VERSION` to `ALL_STORE_VERSIONS` (`src/core/constants.ts:150`) and update `check-store-versions.ts` (the store-version STOP gate). | C |
| 10 | `src/shared/types/managedProvider.ts` | **(Managed only)** The `ManagedProviderInfo`/`ManagedDefaultModels` shape is **already provider-generic** — `provider` is `string` (currently always `'openrouter'`, :23), `allowedModels`/`defaultModels` carry no OpenRouter assumption. A second managed provider reuses this shape unchanged; the server sets `subscription.managedProvider.provider = '<new>'`. The *client* blockers are in row 11. | A |
| 11 | `src/main/services/openRouterTokenStorage.ts` (managed key) + `authService.ts` auto-activation | **(Managed only — currently OpenRouter-hardcoded; see cleanup §De-OpenRouter-ify.)** Today the managed key lives in a single OpenRouter slot (`saveManagedOpenRouterKey`/`hasManagedOpenRouterKey`/`clearManagedOpenRouterKey`) and auto-activation hardcodes `activeProvider: 'mindstone'`. A *second* managed provider needs these parameterised by provider — surface this as the headline managed-provider refactor (see [cleanup](#known-cleanup-debt--recommended-refactors)) rather than copy-pasting a second hardcoded slot. | A |
| 12 | `src/core/rebelCore/providerRouting.ts:158` (`selectProviderMode`) | Add the `activeProvider` arm → `ProviderMode { provider, credentialSource }`. Managed-pool reuses the `openrouter` provider with a new credential-source (Mindstone widened the OR arm: `'mindstone-managed-key' \| 'missing-mindstone'`, resolving availability via the injected `getManagedKeyAvailability()` DI seam). **`assertNever` at :191 compile-forces this.** | All |
| 13 | `src/core/rebelCore/providerRouting.ts:~620` (`profileDecision`) + `src/shared/utils/connectionCredentials.ts` (`resolveConnectionCredentials`) | The other two credential-resolution sites (see the **multi-site hazard** below). Add a per-`providerType`/credential-shape arm in each. These have **no exhaustiveness guard** — a forgotten site silently mis-resolves (the REBEL-5D4 class). | C, B |
| 14 | `src/main/services/localModelProxy/upstreamAuth.ts` | Header injection. Add a `CredentialPlan` discriminated-union variant (e.g. `anthropic-x-api-key` → `x-api-key` header) so the proxy strips client-supplied auth and injects the real upstream credential at the edge. | All |
| 15 | `src/main/services/oauthRefreshFailureStore.ts` (`PROVIDER_KEY_BY_BASE_NAME`, ~:486) | **(OAuth only)** Register the provider in the **closed** failure-store name map; map `invalid_grant` → `needsReconnect` (escalates after 3 consecutive). Decide refresh-vs-static; if OAuth, follow codex's contract: single-flight, `TOKEN_REFRESH_BUFFER_MS` pre-emptive buffer, clear-on-400/401, preserve-on-5xx/429. | C |

> **The credential-resolution multi-site hazard.** Multiple sites independently answer "does this have valid credentials?" and have drifted before (REBEL-5D4, fixed 260612): `selectProviderMode` (`providerRouting.ts:158`, `assertNever`-guarded, `ActiveProvider`-keyed), `profileDecision` (`providerRouting.ts:~620`), and `resolveConnectionCredentials` (`connectionCredentials.ts`, profile-keyed). A new provider that forgets one silently mis-resolves. (Historical note: a `profileTargetEligible`/`modelRoutingConfig` THROW tripwire that used to live here was **removed** in commit `6bb7356a7`, and the orphaned `providerRouteEligibility.ts` itself — production-unused after that refactor — was deleted on 2026-06-14 once routeRef landed without re-wiring it.) The recommended fix (a single `resolveCredentialsForProfile` chokepoint) is in the [cleanup section](#known-cleanup-debt--recommended-refactors). `profileSource` (`'connection'|'auto'|'user'|undefined`) is **provenance only** — never gate credential logic on it.

### Phase 3: Routing, client construction & proxy enforcement

| # | File | What a new provider changes | Archetypes |
|---|------|-----------------------------|------------|
| 16 | `src/core/rebelCore/providerRouteDecision.ts` | `DISPATCHABLE_TRANSPORT_BY_PROVIDER_AND_DIALECT` (:209) — add a provider×dialect→transport row only if it has a new transport. `ProviderInvalidReason` (:260, add `missing-<provider>-credentials`), `isRecoverableTerminalReason` (:332), and `buildTerminalReconnectMessage` (:349 — **brand-voice reconnect copy lives here**). The terminal-decision dispatch ends in `assertNever`. | B, C (A: reason + copy only) |
| 17 | `src/core/rebelCore/clientFactory.ts` | Maps transport → concrete client. New transport adds a case; the **PRECEDENCE-1 proxy branch** (~:216) detects provider-identity headers (`x-codex-turn`, `x-openrouter-turn`). The header-detection comment (~:222-231) is a **mandatory checklist**: a new proxy provider must add its identity header, add to `proxyHandlesAuth`, re-emit in all `queryOptionsBuilder` env builders, and add regression tests. | B, C |
| 18 | `src/main/services/localModelProxyServer.ts` | The runtime egress. Managed-pool: `resolveManagedOpenRouterApiKey()` (:103, fail-closed — never falls back to personal), `handleOpenRouterPassthrough` (:2063) where `isManagedMode = activeProvider === 'mindstone'` (:2074) picks the key, and the **managed allow-list enforcement** at :2096-2116 returning **403 `MANAGED_MODEL_NOT_ALLOWED`** when the requested model isn't in `getManagedAllowedModelIds(presence.managedProvider)`. This 403 is the runtime backstop for managed-tier model lockdown — a second managed provider must route through an equivalent enforced path, not bypass it. New transport: add a passthrough handler + base URL + auth injection. | All (A: reuse + un-hardcode `=== 'mindstone'`) |
| 19 | `src/core/rebelCore/managedKeyAvailability.ts` | **(Managed only)** Copy the managed-key-availability leaf-module pattern (a deliberate zero-import leaf to avoid the `providerRouting` cycle) + register the DI seam at each surface bootstrap (desktop `() => liveRead`, cloud/CLI `() => false`). | A |

### Phase 4: UI — Add-a-model dialog, catalogs, presets, billing, display, cards

> **Archetype A can skip most of this.** A managed-pool provider that reuses an existing route surface is surfaced as a **data-gated section**, not a new catalog handle — see [the Mindstone pattern](#the-mindstone-pattern-archetype-a-shortcut). The rows below are the **full BYOK (B)** surface.

| # | File | What a new provider changes | Archetypes |
|---|------|-----------------------------|------------|
| 21 | `src/renderer/features/settings/components/models/steps/ChoosePathStep.tsx` | Extend `CatalogConnectionHandle` (:13, currently `codex\|openrouter\|anthropic\|gemini`); add a `PROVIDER_GROUPS` entry (:53, `{handle, title, billingSource}`); add a branch to `providerHandleForEntry` (:96, else falls through to `'codex'`); add `reconnectGuidanceForProvider` copy (:103). Managed-pool instead adds a **data-gated section** like the Mindstone block (:344-368 derivation, :614-668 render, gated on `isMindstoneActive && managedEntries.length > 0`). | B (A: data-gated section) |
| 22 | `src/renderer/features/settings/components/LocalModelSection.tsx` | Add to `providerConnections` (:446); derive + append a catalog to `wizardCatalogEntries` (:437); add a `<CatalogProviderGroup>` block (:950-1031 — four near-identical blocks today); add a `connectionProfileGroupMeta` branch (:228). `catalogBillingSource` (:144) maps `routeSurface → BillingSource` (the clean derivation). | B |
| 23 | `src/renderer/features/settings/components/models/steps/ProviderStep.tsx` | **(BYOK custom path)** A `PROVIDER_PRESETS` entry auto-renders a card (:90-93); add a `PROVIDER_CARD_DESCRIPTIONS` entry (:62) or it renders `undefined`. | B |
| 24 | `src/shared/data/providerCatalogs.ts` | Extend `CatalogProviderType` (:30); add a `derive<X>Catalog()` (a pure reshape of an upstream model list, :144-250); register in `PROVIDER_CATALOGS` (:262); optional `*_CATALOG_DESCRIPTIONS` map + register in `HAND_MAINTAINED_CATALOG_DESCRIPTION_MAPS` (keys are test-enforced by `providerCatalogs.descriptions.test.ts`). | B |
| 25 | `src/shared/data/modelProviderPresets.ts:151` | Add a `PROVIDER_PRESETS` entry (`label`, `serverUrl`, `requiresApiKey`, `models`, `apiKeyPlaceholder`, `apiKeyHelpUrl`, optional `presetProfiles`). The `label` doubles as the canonical display name via `getProviderDisplayLabel`. | B |
| 26 | `src/shared/utils/billingSource.ts` | Decide `BillingSource`. Only add a value (`:4`) + resolution branches (`resolveBillingSourceForOption` :20, `resolveBillingSourceForProfile` :66) if the cost model is genuinely new. Note the existing scattered `activeProvider === 'mindstone'` special-cases (:48-52, :75-77) — a registry would centralise these. | All (if new cost model) |
| 27 | `src/renderer/components/ui/BillingBadge.tsx` | `BILLING_BADGE_CONFIG` (:11) — only add a `BillingSource` entry if you added a value in row 26. Tooltips were made **provider-agnostic** (260612): `subscription` → "Included with your subscription plan.", `pool` → "Billed from your account credits." (previously hardcoded "ChatGPT Pro"/"OpenRouter", which mislabelled the Mindstone `subscription` badge). Keep any new entry's copy provider-agnostic. | All (if new cost model) |
| 28 | `src/shared/utils/providerDisplay.ts` | `PROVIDER_DISPLAY_NAMES` (:5); subscription routes add a special-case in `getProfileProviderDisplayName`/`getProfileProviderSubtitle` (mirrors the ChatGPT Pro hack — duplicated, see cleanup). | B, C |
| 29 | `src/renderer/features/settings/components/tabs/AgentsTab.tsx` | The in-use switch + connection cards. Add an `is<X>Active` boolean + an `activeProviderLabel` branch (:744-752); add a connect/disconnect handler + status state; add **either** a managed block (`<SubscriptionSection …>` like Mindstone at :767-777) **or** a BYO provider card (the three ~80-LOC cards at :779+ — ChatGPT Pro, OpenRouter, Anthropic); ensure `planProviderSwitch` (`@shared/utils/providerSwitch`) handles the new `ActiveProvider`. | All |
| 30 | `src/renderer/features/settings/components/ProviderLogos.tsx` | Add an `<X>Logo` (currently only OpenAI/OpenRouter/Anthropic — **Gemini and Mindstone have no logo**, a gap a new provider inherits) and wire it into the AgentsTab card. | B, C |
| 31 | `src/renderer/hooks/useManagedDefaults.ts` + `App.tsx` (`PROVIDER_BILLING_URLS`/`PROVIDER_LABELS` ~:469-482) | **(Managed)** `useManagedDefaults` already returns `managedProvider` — consume it instead of hardcoding `'mindstone'`. Add label + billing-URL map entries in `App.tsx`. | A (labels: All) |
| 32 | Onboarding: `features/onboarding/steps/ApiStep.tsx`, `OnboardingWizard.tsx`, `useOnboardingFlow.ts` | Provider cards + managed opt-out in the first-run flow. | All |

#### The Mindstone pattern (Archetype A shortcut)

A managed subscription/pool provider that reuses an existing route surface (`openrouter`/`pool`) **skips** the catalog handle (rows 21 handle / 24), and instead adds:

1. An `ActiveProvider` value (Phase 1 row 1) + `OPENROUTER_EFFECTIVE_PROVIDERS` (row 2).
2. A **data-gated section** in `ChoosePathStep.tsx` (`isMindstoneActive && managedAllowedModels.length > 0`, joined against `PROVIDER_CATALOGS.openrouter`) — with the **observable-failure F1 effect** (`ChoosePathStep.tsx:389-407`) that logs allow-list IDs missing from the bundled catalog. *Do not* silently drop unmatched IDs — that is the "silent failure is a bug" exemplar.
3. Billing/display branches (rows 26/28/31) + a managed block in AgentsTab (`SubscriptionSection`, not a BYO card — row 29).
4. The managed-key + allow-list + proxy enforcement (Phase 2 row 11, Phase 3 rows 18-19).

This is materially less surface than a full BYOK provider like Gemini. **Cross-surface bonus:** `managedAllowedModels` is empty on cloud/mobile by design, so the section simply doesn't render there — no synced flag, no hardcoded IDs. This is the recommended pattern for managed-plan providers.

### Phase 5: Persistence, normalization & cross-surface

| # | File | What a new provider changes | Archetypes |
|---|------|-----------------------------|------------|
| 33 | `src/shared/utils/settingsUtils.ts` | The `activeProvider` migration/derivation switch (~:1296) — add an arm. The OR-effective check at ~:570 (`isEffectivelyOpenRouter`) is covered automatically if you added to `OPENROUTER_EFFECTIVE_PROVIDERS`; the **duplicate** hand-rolled check `isOpenRouterProvider` (~:1191) is NOT — and it intentionally differs (no `undefined` guard), so don't naively reroute it (see the small-items list). | All |
| 34 | `src/core/constants.ts:150` (`ALL_STORE_VERSIONS`) | Only if you added a dedicated token store (Phase 2 row 9) — add the `*_TOKEN_STORE_VERSION`; `DATA_SCHEMA_EPOCH` (:220) is the sum, validated by `check-store-versions.ts`. | C (if bespoke store) |
| 35 | Provider "migration" (heal-at-normalize) | There are **no numbered store migrations** keyed on `activeProvider`. If existing persisted users should auto-derive into the new provider, add an **idempotent `normalizeSettings` heal + an epoch-ms idempotency stamp**, following `settingsStore.openRouterProviderHeal` / `codexRepairMigration` patterns, plus a `settingsStore.<provider>...Migration.test.ts`. (This heal-then-stamp recipe is the canonical provider-migration mechanism — see cleanup §C4.) | All (if users auto-derive) |
| 36 | `src/shared/cloudChannelPolicies.ts` | **Cross-surface.** The only provider-routable channel today is `'codex:sync-tokens'` (:104, `routable + dualWrite`). If the provider's credential is a token/key the cloud surface needs, add a `<provider>:sync-tokens`-style channel (**default answer: sync the data, don't disable the feature on cloud/mobile**). `activeProvider` itself rides the generic `settings:update` dual-write. | C, B (managed: server has the key natively) |
| 37 | `src/shared/types/settings.ts` (the `CROSS_SURFACE_PARITY_EXEMPT` comments) | The cross-surface gate (`scripts/check-cross-surface-parity-gap.ts`) **fires** on any `settings.ts` field matching `/(provider\|auth\|token\|client\|service)/`. Either wire a cloud registrant or write a real `// CROSS_SURFACE_PARITY_EXEMPT: <reason>` (≥30 chars, no TODO/FIXME/WIP) mirroring the `activeProvider` exemption (:1208) and `managedProviderDeactivated` (:1220). | All |
| 38 | `src/core/utils/authEnvUtils.ts` + `validateProviderCredentials.ts` + CLI | `isUsingOpenRouter` (:77 — `mindstone`→true) / `getAuthEnvVars` (:103) branches; `validateProviderCredentials` switch → `ProviderCredentialState.kind` (consumed by `runCli.ts` and `cliProviderValidator.ts` for user-facing CLI messages). | All |

### Phase 6: Tests & guards

| # | File | What a new provider changes | Archetypes |
|---|------|-----------------------------|------------|
| 39 | `providerRoutePlan/{forTurn,forBTS,forSubagent}/*.json` corpus + `providerRouting.snapshots.test.ts.snap` | Add fixtures for the new provider's happy + terminal paths; regenerate snapshots. ~70-fixture corpus — this is a hard gate. | All |
| 40 | `turnPipelineReplay.test.ts` + `fixtures/turnPipelineReplay/row-*.json` | Add a replay row exercising the new provider's happy + terminal paths (cf. `row-04-active-provider-override`, `row-25/26` codex, `row-06/27/48/56` OpenRouter). | All |
| 41 | Parity-matrix tests: `providerResolution.parityMatrix.test.ts`, `providerRouting.profileCredentialMatrix.test.ts`, `routeInvariantBreaches.test.ts`, `providerRouting.invariants.test.ts` | Add `(provider × credential)` matrix rows. | All |
| 42 | `modelLimits.openrouter.test.ts`, `providerCatalogs.descriptions.test.ts` | (B with catalog rows) add to the flag-lock loop / descriptions coverage. | B |
| 43 | Test harness/builders (`settingsBuilder.ts`, `eventBuilder.ts`, `testHarness.ts`) + `settingsStore.<provider>Migration.test.ts` | Builders first, then the heal-migration test if row 35 applies. | All |

### Phase 7: Docs

| # | File | What to update | Archetypes |
|---|------|----------------|------------|
| 44 | This doc + [MODEL_AND_PROVIDER_OVERVIEW](./MODEL_AND_PROVIDER_OVERVIEW.md) | Add a row to [Past Additions](#past-additions); confirm the hub lists the provider. | All |
| 45 | `rebel-system/help-for-humans/` (changelog + any provider/billing help) | User-facing changes → changelog in Rebel's dry, witty voice. See [CHANGELOG_UPDATE_PROCESS](./CHANGELOG_UPDATE_PROCESS.md). | All (if user-facing) |
| 46 | `MANAGED_PROVIDER_LIFECYCLE` / `BILLING_AND_SUBSCRIPTION_TIERS` / `AUTHENTICATION` | Update the precedent doc that owns the provider's archetype. | per archetype |


## What's Guarded vs Convention-Only

The single highest-value safety artifact: which surfaces **fail CI when missed** versus which **silently degrade**. The convention-only sites are where a forgotten provider edit ships a quiet bug.

**Fail red in CI when missed:**

| Surface | Guard |
|---|---|
| `ActiveProvider` union exhaustiveness | Closed union + `assertNever(settings.activeProvider)` (`selectProviderMode` :191, `getProviderModelDefaults`, route-decision dispatch) — compile-force the first switches |
| Feature-gate predicate budget | `scripts/check-feature-gate-budget.ts` (cap **8**, currently 4 in `providerFeatureGuards.ts`) — a provider needing new capability gates risks tripping it; that's a "stop & escalate to the typed capability matrix" tripwire, not a normal failure |
| No inline `providerType === '<literal>'` gates | ESLint `no-restricted-syntax` — forces new gates into a `providerFeatureGuards.ts` predicate |
| `OpenAIProviderType` exhaustiveness | `providerFeatureGuards.ts` predicates `switch` + `assertNever` (note: keyed on `OpenAIProviderType`, NOT `ActiveProvider`) |
| Cross-surface parity gap | `scripts/check-cross-surface-parity-gap.ts` (`validate:fast`) — fires on provider/auth/token-named `settings.ts` fields without a registrant or `CROSS_SURFACE_PARITY_EXEMPT` |
| Store-version registry | `scripts/check-store-versions.ts` — only if a dedicated token store is added |
| Provider-routing snapshots | `providerRouting.snapshots.test.ts.snap` + the ~70-fixture `providerRoutePlan/{forTurn,forBTS,forSubagent}` corpus |
| Turn-pipeline replay | `turnPipelineReplay.test.ts` + `fixtures/turnPipelineReplay/row-*.json` |
| Parity-matrix | `providerResolution.parityMatrix.test.ts`, `providerRouting.profileCredentialMatrix.test.ts`, `routeInvariantBreaches.test.ts` |
| Catalog-blurb keys (B) | `providerCatalogs.descriptions.test.ts` |

**Convention-only (no red gate — silently degrade if missed):**

- The **~40 hand-written `activeProvider === '<literal>'` branches** across ~8 clusters (auth env, billing, telemetry, diagnostics, onboarding, settings UI). Plain string compares, no exhaustiveness — a new provider silently no-ops there. The [discovery grep](#discovery-finding-all-references) is the only way to find them.
- **UI provider cards / labels** (`AgentsTab` BYO cards, `activeProviderLabel`, `formatActiveProviderLabel` in `providerSwitch.ts`) — a missing case just doesn't render.
- **Display-name maps** (3 unsynced sources: `PROVIDER_DISPLAY_NAMES`, `getProviderDisplayLabel`, ad-hoc literals).
- **`PROVIDER_LABELS`/`PROVIDER_BILLING_URLS`** (`App.tsx`), `PROVIDER_KEY_BY_BASE_NAME` (failure store), the deep-link `startsWith` ladder (`index.ts`) — closed maps with no compile guard.
- **Fallback priority** (`pickFallbackProvider` in `providerSwitch.ts`) — convention-ordered.
- **`BillingBadge` tooltips** — were hardcoded provider names; made provider-agnostic 260612 (no longer a gap).


## Cross-Surface Requirements

Providers are a textbook cross-surface trap: a flag (`activeProvider: 'codex'`) syncs to cloud/mobile while the supporting service (OAuth tokens) is desktop-only. The **default answer is to sync the underlying credential data**, not to disable the provider on the other surfaces.

A new provider's credential falls into one of three cross-surface shapes — decide which, then act:

| Credential shape | Cross-surface action |
|---|---|
| **BYO key in settings** (Anthropic, OpenRouter OAuth token stored in `openRouter` settings) | Syncs for free via `settings:update` dual-write. Confirm it is NOT accidentally in `LOCAL_ONLY_SETTINGS_KEYS_ARRAY` (`cloudSettingsPolicy.ts:35`). |
| **Managed key (server-side)** | The cloud surface already has it via `/api/config`. No channel needed; the managed UI section simply doesn't render where `managedAllowedModels` is empty (the Mindstone pattern). |
| **Desktop-only OAuth token** (codex) | Add a `<provider>:sync-tokens` `routable + dualWrite` channel to `cloudChannelPolicies.ts` (mirror `codex:sync-tokens` :104). If genuinely desktop-only (interactive login/keychain), isolate that bit and write a `CROSS_SURFACE_PARITY_EXEMPT` rationale. |

The gate (`scripts/check-cross-surface-parity-gap.ts`) **will fire** on the `settings.ts` edit. Write a real exemption (≥30 chars, no weak words) mirroring `activeProvider`'s (`settings.ts:1208`) or wire the channel. Then verify on all three surfaces per [CROSS_SURFACE_PARITY_CHECKLIST](./CROSS_SURFACE_PARITY_CHECKLIST.md).


## Discovery: finding all references

Provider identity is stringly-typed and scattered. After the `ActiveProvider` edit compile-forces the `assertNever` sites, use these to find the **convention-only** sites that won't fail to compile.

```bash
# The union + its switches (the must-touch core)
rg "ActiveProvider\b" src/ -l

# The convention-only string compares (the silent-degrade surface)
rg "activeProvider ===|activeProvider:" src/ -n

# Exhaustive switches that may need a new arm
rg "case 'codex'|case 'mindstone'|case 'openrouter'|case 'anthropic'" src/ -n

# Enumerate the bare-equality branch files (the ~40-file scatter)
rg -ln "activeProvider === '" src --type ts | grep -v test

# Mindstone is the most recent precedent — its full blast radius IS your template
rg "mindstone" src/ -l
```

> **False-positive classes to ignore** (literal matches that are NOT provider touch-points): voice providers (`VoiceSettings.provider`), connector catalog ids, model-name strings (`openai/gpt-5.5`, `anthropic/claude-…`), `CloudInstanceConfig.providerId` (the cloud-VM provider — a *different* "provider" concept), and the `ModelProviderType` profile axis (only relevant for an Archetype-B profile-shaped provider). The raw `rg -i "'anthropic'|'openrouter'|'codex'|'mindstone'"` returns ~519 files — mostly noise. The genuine `ActiveProvider` surface is **~40-45 files** across the 8 clusters above.


## Known cleanup debt / recommended refactors

All four research reports converged on the same finding: **provider identity is scattered, not centralised.** Adding the Nth provider today is N parallel edits across ~40 files and ~6 parallel enums, several with no exhaustiveness guard. The cleanups below are recorded so a future provider-add (or a dedicated refactor) can act on them.

### Headline future refactors (NOT yet done — require sign-off)

These touch routing/auth/billing — hard-to-reverse shared contracts. They are **recommended, not scheduled**; surface them for explicit user sign-off rather than landing unilaterally inside a provider-add.

> **Investigated 2026-06-12 (Planner + DA + Arbitrator vs live code) — verdict: the fat registry below is NOT worth building as sketched.** It is **mis-axed**: most of what it would "collapse" keys on a *different* axis than `ActiveProvider` (display names are `Record<ModelProviderType,string>`, 8 keys; `billingSource` is profile-level `(providerType, routeSurface)`; reconnect copy switches on `ProviderRouteInvalidReason`), and several "duplicated" sources **intentionally diverge** so there is no parity target (the 4 OR-effectiveness checks; `App.tsx PROVIDER_LABELS` `anthropic→'Claude'` vs `formatActiveProviderLabel` `→'Anthropic'`). Only **one** `assertNever` actually keys on `ActiveProvider` (`selectProviderMode`), and it is already safe. The genuinely-parity-safe remainder is thin: a per-`ActiveProvider` `{working,thinking,bts}` default-model record, the AgentsTab `is*Active` boolean de-dup, and filling the missing Gemini/Mindstone logos — a small cleanup, NOT a registry. Plan/DA/Arbitrator reports: `docs/plans/260612_provider-registry/subagent_reports/`.

1. ~~**A `ProviderDescriptor` registry**~~ collapsing display names / billingSource / reconnect copy / the OR-effectiveness checks — **rejected** (mis-axed; see box above). If a registry is ever revisited, it can only own the genuinely `ActiveProvider`-keyed, non-divergent fields (default models, the `is*Active` predicate, `OPENROUTER_EFFECTIVE_PROVIDERS` membership — the last already being a working chokepoint), which is too thin to justify the abstraction.

2. **A single credential-resolution chokepoint.** One `resolveCredentialsForProfile(profile, settings)` called by the sites that duplicate the logic today (`selectProviderMode` — `ActiveProvider`-keyed; `resolveConnectionCredentials` — profile-keyed; `profileDecision`). Still a real latent drift risk (the REBEL-5D4 class). **Reduced urgency (corrected 2026-06-12):** the REBEL-5D4 fix already shipped (260612), and commit `6bb7356a7` (on `dev`) **already deleted** the `modelRoutingConfig` architecture *and* the old `providerRouteEligibility` THROW tripwire — so the earlier "unblocks modelRoutingConfig / lets the tripwire be deleted" payoff is **moot**. The merge is non-trivial (two differently-keyed resolvers). Prescribed by the `260611_openrouter_user_profile_oauth_resolver_gap` + `260513` postmortems; treat as its own scoped run if ever pursued.

Supporting refactors the registry would subsume (also sign-off-gated): de-OpenRouter-ify the managed tier (parameterise the managed-key slot + auto-activation by `managedProvider.provider` so a 2nd managed provider doesn't copy a hardcoded slot — `openRouterTokenStorage.ts:153-154`, `authService.ts:767`); generalise the codex-only 401-retry into a shared `ModelClient.handleAuthError()`; de-duplicate the three ~80-LOC AgentsTab BYO cards into a declarative `ProviderConnectionCard` + descriptor array (gives Gemini/new providers a card for free); de-duplicate the four `<CatalogProviderGroup>` blocks into a `.map()`.

### Small items

- **`BillingBadge` tooltip hardcodes — FIXED (260612).** Were "Billed to your ChatGPT Pro subscription." / "Billed from your OpenRouter credits." (mislabelled the Mindstone `subscription` badge); now provider-agnostic ("Included with your subscription plan." / "Billed from your account credits."). A new `BillingSource` should keep provider-agnostic copy.
- **The duplicate OR-effectiveness check** (`settingsUtils.ts` `isOpenRouterProvider`, ~:1191) — investigated and **left as deliberate debt** (260612): its third arm (`openRouter.enabled && oauthToken`) has **no `undefined` guard**, so it is NOT semantically equal to `isOpenRouterEffectiveProvider` (which the `isEffectivelyOpenRouter` site at ~:570 uses). Collapsing it would change behaviour for `anthropic`/`codex` users holding leftover OR tokens. An explanatory comment was added at the site; the proper fix is the `ProviderDescriptor` registry above, not a naive substitution.

### The recipe to codify (doc-only)

The "heal at `normalizeSettings`-time + epoch-ms idempotency stamp" pattern is the consistent, working provider-migration mechanism (vs numbered store bumps). New provider migrations should follow it (Phase 5 row 35).


## Past Additions

| Date | Provider | Archetype | Scope |
|------|----------|-----------|-------|
| 2026-06 | `mindstone` (managed subscription) | **A — managed-subscription pool** | The canonical precedent for this doc. Added as an `ActiveProvider` value + `OPENROUTER_EFFECTIVE_PROVIDERS` entry + `MINDSTONE_DEFAULT_*` constants + a managed-key resolver (`resolveManagedOpenRouterApiKey`, fail-closed) + allow-list 403 enforcement in `localModelProxyServer.ts` + a **data-gated UI section** (`isMindstoneActive && managedAllowedModels`, joined against `PROVIDER_CATALOGS.openrouter`) with an observable F1 missing-id effect + `SubscriptionSection` block in AgentsTab. **No new catalog handle** (the 4-handle `CatalogConnectionHandle` enum was untouched) — materially less surface than a BYOK provider. Cross-surface: rides `settings:update` dual-write + server-native managed key; `managedAllowedModels` empty on cloud/mobile by design. `managedProviderDeactivated` opt-out flag added. |
| (precedent) | `codex` (ChatGPT Pro) | **C — OAuth-subscription** | Loopback-PKCE login (`codexAuthService.ts`, dual-stack bind), dedicated token store with refresh (`codexTokenStorage.ts` + `codexAuthCore.ts` single-flight + pre-emptive buffer), `codex-proxy` transport + proxy-identity header, `codex:sync-tokens` cross-surface channel, hand-written AgentsTab card. `providerType: 'openai'` + `routeSurface: 'subscription'`. |
| (precedent) | `openrouter` | C (worker + deep-link OAuth, static key) | Worker-callback PKCE returning a permanent API key (no refresh), `mindstone://openrouter/callback` deep link, `openrouter-proxy` transport. Is the `OPENROUTER_EFFECTIVE_PROVIDERS` anchor that managed providers piggyback. |
| (baseline) | `anthropic` | B (direct API key) | The default. Direct `x-api-key`, no OAuth, `anthropic-direct` transport. |
