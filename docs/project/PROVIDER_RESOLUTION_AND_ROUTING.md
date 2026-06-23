---
description: "End-to-end map of how a (model id + active provider/profile) becomes a concrete ModelClient and reaches the right upstream — the decision layer, the client-construction layer, the proxy egress, and the model-dialect axis that makes wrong-dialect routing a compile error."
last_updated: "2026-06-14"
---

# Provider Resolution and Routing

How does a model id plus the active provider/profile turn into a concrete `ModelClient`
pointed at the right upstream API? This doc is the navigation map across the layers that
answer that question. It is intentionally sparse on *how* — the code is the source of truth —
and dense on *where* and *why*.

The hard problem this machinery exists to solve: a bare `startsWith('claude-')` model id is
**ambiguous**. The same id can legitimately mean Anthropic-direct, OpenRouter
`anthropic/claude-*`, or (if mis-routed) a Codex endpoint that physically cannot serve Claude.
The layers below add explicit axes — and one branded type — so an omitted-axis mistake fails
**loud** (a 401 or a compile error) instead of silently producing a wrong-model turn.

## The two cooperating layers

### 1. Decision layer — what should happen

`src/core/rebelCore/providerRouting.ts` turns an input (model choice + settings + role) into a
typed decision:

- `ProviderRouter.forTurn` / `forBTS` / `forSubagent` — role-specific entry points. All three
  funnel through `routeDecision(input, role)`.
- `selectProviderMode(settings)` — chooses the provider mode from settings.
- `resolveProfile(input)` — resolves the working/explicit `ModelProfile` (and records *where*
  it was resolved from via `ProviderResolvedFrom`), degrading gracefully when a referenced
  profile is unusable.
- `resolveProviderRoutePlan(request, runtimeContext)` — the async front door: runs the
  decision via `decisionForRequest`, then hands it to `materializePlanRuntime`.

The output is a `ProviderRouteDecision` (`src/core/rebelCore/providerRouteDecision.ts`), which
splits the routing question onto **two orthogonal axes** so neither can be silently conflated:

- **transport** (`ProviderRouteTransport` / `DispatchableTransport`) — which *wire dialect* the
  upstream speaks (Anthropic-native vs OpenAI-compatible HTTP vs local).
- **dispatchPath** (`DispatchPath` / `DispatchableDispatchPath`) — *how* the request is routed
  (proxy vs direct vs route-table), orthogonal to transport. Use the predicates
  `isProxyDispatch` / `isDirectDispatch` / `isRouteTableDispatch` rather than re-deriving.

A decision is either `kind: 'dispatchable'` (transport + dispatchPath both executable) or
`kind: 'terminal'` (cannot be executed; `assertDispatchableRoutePlan` throws
`TerminalDispatchError`). The dispatchable/terminal split is a type-level guarantee — see
`docs/plans/260508_dispatchable_terminal_type_split_and_subagent_constructor_input.md` for why
it was introduced.

`inferModelDialect(model, profile)` assigns the model-dialect (`ProviderModelDialect`) carried
on every decision arm — the in-core counterpart to the proxy's `classifyModelDialect` (below).

`materializePlanRuntime(decision, ctx)` in `src/core/rebelCore/providerRoutePlan.ts` is the
final decision-layer step: it attaches runtime **auth** and derives the **wire headers** that
the executor will inject into the environment.

Within the **executor request path** the route decision is materialised once via
`resolveProviderRoutePlan` (`src/core/rebelCore/providerRouting.ts` — its function-form runtime
context derives from the *same* `ProviderRouteDecision` the plan is built from, eliminating the
same-request double-derive), and the discriminated preflight result below reads that one decision.
This is **not yet universal**: other production paths still derive their own decision separately —
e.g. the settings "test route" handler in `src/main/ipc/settingsHandlers.ts` runs its own
`ProviderRouter.forTurn` alongside `resolveProviderRoutePlan` — so do not read this as "every
production path has stopped re-deriving."

## Routing SSOT — the typed authorities (v0.4.46)

The Jun-4 routing-SSOT rearchitecture (the `routing-ssot` series) consolidated three previously
implicit decisions into typed authorities, each the single source of truth for its question. The
durable invariants behind them live in `docs/plans/260604_routing-ssot-divergence/PLAN.md`; this
section records them as the canonical map.

- **Typed plan-mode target** — `resolvePlanModeTarget()` in `src/shared/utils/modelNormalization.ts`
  produces a `PlanModeTarget | null`; `resolveModelConfig` keys split mode off `planMode !== null`,
  not off a model-string compare. Invariant: **the only way into plan mode is a typed/branded
  target, not a model-string sentinel** — a synthetic id (e.g. `PREFERRED_PLANNING_MODEL`) can no
  longer trigger split mode positionally. See
  [MODEL_ROLES_AND_THINKING](./MODEL_ROLES_AND_THINKING.md) (Axis 1) for the full mechanism.

- **Discriminated preflight result** — the agent-turn executor's `createDirectPreflightClient`
  (`src/core/services/turnPipeline/agentTurnExecute.ts`) returns a discriminated
  `PreflightClientResult` of `{ kind: 'client' } | { kind: 'proxy-required' } | { kind: 'unavailable' }`.
  This kills the overloaded `null` that previously meant **both** "proxy-required (fall through to
  the proxy)" **and** "couldn't build a direct client" — see the inline comment block above the type.
  Each consumer switches exhaustively on `kind` rather than re-interpreting a null.

- **Typed model-eligibility authority** — `src/core/rebelCore/routeEligibility.ts` is a **pure
  single-candidate adapter** over `ProviderRouter`: `eligible(candidate, ctx)` itself obtains
  exactly **one** `ProviderRouteDecision` from the `ProviderRouter` chokepoint (by role) and
  `eligibilityFromDecision()` maps it to a `ModelEligibilityResult`
  (`{ kind: 'eligible'; routePlan } | { kind: 'ineligible'; … }`), with `EligibilitySource` a pure
  total function of the invalid reason (`assertNever`-guarded). Note this module computes its **own**
  decision per candidate — it is *not* a view over the executor's already-materialised decision, and
  it adds no parallel resolution beyond delegating to `routeDecision`/`selectProviderMode`. Invariant:
  **eligibility is a pure typed verdict derived from a single `routeDecision`, never a 2nd/3rd
  resolver** — it computes nothing `routeDecision` does not already compute. (`connectedProviders`
  is carried in `RouteEligibilityContext` for a future prioritised-config shape but is **inert**
  today; broadening eligibility means extending `routeDecision`, not branching here.) As of v0.4.46
  this is **test-covered / future-facing**: its only non-fixture importer is its own suite
  (`__tests__/routeEligibility.test.ts`) — there is no downstream production consumer yet. It is the
  typed authority that eligibility questions *should* route through rather than re-deriving a verdict
  from a decision by hand.

### 2. Client-construction layer — build the client

The decision-layer plan reaches the executor, which applies it to the process environment
(`ANTHROPIC_BASE_URL` + `ANTHROPIC_CUSTOM_HEADERS`; see the header note in `extractProxyConfig`'s
TSDoc, which points back to `queryOptionsBuilder` / `applyAuthPlanToEnv`). On the way back:

- `extractProxyConfig(env)` in `src/core/rebelCore/queryRouter.ts` parses `ANTHROPIC_BASE_URL`
  and `ANTHROPIC_CUSTOM_HEADERS` back into a `ProxyConfig` — crucially recovering the
  **provider-identity headers** baked into the custom-headers blob.
- `createModelClient(options)` in `src/core/rebelCore/clientFactory.ts` builds the actual
  `AnthropicClient` or `OpenAIClient`. Its multi-level **PRECEDENCE** ladder is documented in the
  file header (PRECEDENCE 1 proxy → 2 direct Anthropic → 3 Gemini-via-proxy → 4/5
  OpenAI-compatible). Read that header before changing routing — each rung preserves a specific
  council / ad-hoc / tier behaviour.
- *(Historical — removed 2026-06-01.)* A second, client-layer resolver
  (`resolveTargetForModel` → `ResolvedTarget`) used to re-encode the same decision in a parallel
  vocabulary. It was **deleted** in commit `73f305559` (routing-SSOT Stage 3.3); its return to
  production is blocked by `scripts/check-no-legacy-resolver.ts` (in `validate:fast`). Routing now
  flows through the single `ProviderRouteDecision` decision layer. Only vestigial `vi.mock`
  references survive in tests.

## Proxy egress — reaching the upstream

`src/main/services/localModelProxyServer.ts` is the local proxy the Anthropic SDK talks to.
`handleMessagesRequest` is the entry point; it calls `classifyRequest`
(`src/main/services/localModelProxy/classifier.ts`) to get a typed `RequestClassification`,
then dispatches on `classification.consumerClass` with an **exhaustive switch + `assertNever`**.
That `assertNever` is deliberate: adding a new consumer class (e.g. a future `gemini-turn`)
without handling it here is a **compile error**, not a silent fall-through to the
route-resolved branch. From there it forwards via the passthrough handlers (Anthropic
passthrough, OpenRouter passthrough, Codex passthrough).

### The model-dialect axis + the `CodexEgressModel` brand

`classifier.ts` pins each inbound model name onto a `ModelDialect`
(`'anthropic-native' | 'openai-codex' | 'openai-other'`) via `classifyModelDialect`, which
recognises *both* bare `claude-*` and vendor-prefixed `anthropic/claude-*`. The Codex egress
constructor `remapToCodexEgressModel` returns a **branded** `CodexEgressModel` (`string & {
__brand }`). Because the Codex upstream path only accepts `CodexEgressModel`, handing it an
un-remapped `claude-`-dialect string is a **type error** — "Claude leaked to Codex" cannot
compile. See the `codex-model-dialect-axis` entry in
[`docs/project/boundary-registry.yaml`](./boundary-registry.yaml).

## Header contract (compact)

Provider-identity / routing headers that travel on a proxy request:

- `x-openrouter-turn: true` — the user deliberately chose OpenRouter for this turn; lingering
  Anthropic keys must not override it (enforced in the decision layer — `providerRouting.ts`).
- `x-codex-turn: true` — Codex passthrough turn; Claude ids must **not** reach this path.
- `x-routed-turn-id` — correlates a route-table turn to its routing decision.
- `x-routed-model` — the resolved model for a route-table turn; missing/unknown → `400
  route_required` (see the route-table branch in `localModelProxyServer.ts`).
- `x-proxy-auth` — the internal proxy auth token, carried separately from the upstream
  `Authorization` / `x-api-key` so they don't collide.

## Design note: the dual-resolver tension (RESOLVED 2026-06-01)

> **This debt is closed — do not treat it as a live consolidation candidate.** Earlier revisions
> of this doc described two resolvers (`ResolvedTarget` in `clientFactory.ts` and
> `ProviderRouteDecision` in `providerRouteDecision.ts`) encoding the same decision in different
> vocabularies, kept consistent by hand. The `ResolvedTarget` / `resolveTargetForModel` resolver
> was **deleted** in commit `73f305559` (routing-SSOT Stage 3.3), leaving `ProviderRouteDecision`
> as the single decision authority; `scripts/check-no-legacy-resolver.ts` (in `validate:fast`)
> blocks its reintroduction. The stale "dual-resolver" framing here previously misled automated
> researchers into citing a `clientFactory.ts:determineProviderForModel()` that does not exist.

For historical context: the Jun-4 routing-SSOT work first narrowed the double-derive *within* a
request (the decision is materialised once; the discriminated preflight result and
`routeEligibility` are typed *views* over it), and the Jun-1 Stage-3.3 deletion then removed the
cross-layer vocabulary split entirely. The dialect axis + `CodexEgressModel` brand remain the
compile-time backstop against wrong-model-via-Codex. Background:
`docs/plans/260604_routing-ssot-divergence/PLAN.md`,
`docs/plans/260506_routing_transport_refactor_and_council_rename.md`, and
`docs/plans/260422_provider_routing_residual.md`.

## Direct-Anthropic dialect chokepoint

All three direct-Anthropic arms — active-provider, profile-Anthropic, and the Codex-divert path —
now route their model id through one `resolveDirectAnthropicModel` chokepoint
(`src/core/rebelCore/providerRouteDecision.ts`, called from the three arms in
`providerRouting.ts`). It strips a *matching* `anthropic/` self-prefix down to a bare native id
(e.g. `anthropic/claude-haiku-4-5` → native), while genuinely foreign dialects (`openai/…`,
`anthropic/not-claude`, `anthropic/anthropic/…`) still **fail closed**. A `validate:fast` CI guard,
`scripts/check-direct-anthropic-route-chokepoint.ts`, fails the build if any arm bypasses the
chokepoint. This killed a recurring (4×) dialect-normalization bug family by construction.
(be4d44f78, d9baa19c9, ef850e3b7, 26fab81ec, df6633b46)

Key files: `src/core/rebelCore/providerRouteDecision.ts`, `providerRouting.ts`,
`src/shared/utils/wireModelId.ts`.

## Routing-model consolidation (the dormant "trio" scaffolding was removed)

An earlier dormant, presence-gated "trio" scaffolding for per-turn routing — typed
`ModelConfigTrio` / `ModelRoutingConfig`, the pure resolvers `resolveActiveTrio` /
`resolveTurnModelViaTrio`, a provider-route eligibility bridge, and an absent-by-default
`settings.modelRoutingConfig` field — **never wired in and was deleted** on 2026-06-12 (commit
`6bb7356a`); the orphaned `providerRouteEligibility.ts` was removed on 2026-06-14 once `routeRef`
landed without re-wiring it. Don't look for those symbols — they're gone.

The live adaptive per-turn routing work sits on a different foundation: provider-bound `routeRef`
references for the planner/adaptive picker (commits `fef42441`, `40d04591`), a canonical
`ResolvedModelCapabilities` read-model (`16f47dbc`), capability resolution consolidated onto the
catalog behind a dispatch-seam guard (`c3d9ba8f`), and a single client-side
`resolveCredentialsForProfile` credential chokepoint (`4f0caa34`, E2a — the router-side
`profileDecision` site is **not yet** unified onto it). See
[SMART_MODEL_PICKING](./SMART_MODEL_PICKING.md) for intent, and
`docs/plans/260612_smart-picker-multiprovider/PLAN.md` + `docs/plans/260614_smart-model-routing/`
for the live workstream.

## See also

- [REBEL_CORE](./REBEL_CORE.md) — runtime architecture this routing sits inside.
- [LOCAL_MODEL_SUPPORT](./LOCAL_MODEL_SUPPORT.md) — local / OpenAI-compatible providers, the
  consumers of the OpenAI transport branches above.
- `PROVIDER_REQUEST_PARAM_MATRIX.md` — sibling doc: which request params each provider/transport
  supports (the *payload* side of what this doc routes).
- `PROXY_AUTH_BOUNDARY.md` — sibling doc: the auth/credential boundary behind `x-proxy-auth` and
  the upstream key handoff.
- [BOUNDARY_REGISTRY](./BOUNDARY_REGISTRY.md) — registry of typed boundaries, including
  `codex-model-dialect-axis`.
- `docs-private/postmortems/260530_operator_consult_temperature_unsupported_postmortem.md` — why
  per-provider param/routing consistency matters.
- `docs-private/postmortems/260417_openrouter_adhoc_auth_failure_postmortem.md` — the OpenRouter ad-hoc
  auth failure that motivates the `x-openrouter-turn` provider-identity header contract.
