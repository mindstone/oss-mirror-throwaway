---
description: "Intent & goals for Smart Model Picking — what it's for, what exists today vs what's aspirational, the hard constraints (cache cold-start switch cost, multi-provider dependency, billing), and the open design questions. NOT a spec."
last_updated: "2026-06-20"
status: "intent / goals — large parts are NOT yet built; reconcile with the active plan before implementing"
---

# Smart Model Picking — Intent & Goals

> **Read this as intent + handoff, not a spec.** It captures *what we want and why*, *what genuinely exists today*, *the constraints/tensions a design must resolve*, the *decisions made so far*, a *recommended shape*, and the *outstanding questions* — i.e. it is the **detailed handoff** for whoever picks up the implementation. It deliberately does **not** lock an implementation. The live foundation work is in [`docs/plans/260612_smart-picker-multiprovider/PLAN.md`](../plans/260612_smart-picker-multiprovider/PLAN.md) (routing rearchitecture) + [`CONSOLIDATION_smart-model-picking_260614.md`](../plans/260612_smart-picker-multiprovider/CONSOLIDATION_smart-model-picking_260614.md) — reconcile with them before planning.
>
> **Broader context:** this doc is the *picker-specific* intent. For the whole model/provider **direction** — multi-provider routing, Mindstone-as-provider, tiers, the add-model UI, error architecture, the 3-phase sequencing, and the cross-cutting open questions — see [MODEL_AND_PROVIDER_DIRECTION](./MODEL_AND_PROVIDER_DIRECTION.md).

## What "Smart Model Picking" is (and is not)

**Smart Model Picking** = letting Rebel automatically choose *which model* runs *which part of the work*, drawing from the models the user has access to, optimising for cost/capability/reliability without the user micromanaging it. User-facing surface: Settings → Agents & Voice → "smart model picking" toggle + the "Available models" pool ([UI: `LocalModelSection.tsx`, `SmartPickingToolbar.tsx`]).

It is distinct from three neighbours — don't conflate them:
- **Roles** (Working / Thinking / Background / Recovery) — the user's *explicit* model assignments. Smart picking layers *on top of* the Working role (the working model is always the fallback). → [MODEL_ROLES_AND_THINKING](./MODEL_ROLES_AND_THINKING.md)
- **Council mode** — runs *several* models in *parallel* on the *same* prompt for diverse opinions (`councilEnabled`, `//council`). Smart picking chooses *one* model *per step*. → [MULTI_MODEL_COUNCIL_MODE](./MULTI_MODEL_COUNCIL_MODE.md)
- **Provider routing / resolution** — the *mechanical* "this model id + this provider → this concrete client/credential/wire call". Smart picking decides *what to route*; routing decides *how*. → [PROVIDER_RESOLUTION_AND_ROUTING](./PROVIDER_RESOLUTION_AND_ROUTING.md)

## Why (the user problem)

Non-technical knowledge workers shouldn't have to know that GPT-5.5 is good at X, that DeepSeek is cheap, or that their Mindstone plan covers certain models. They want good answers at a sensible cost. Smart picking is how Rebel makes those tradeoffs *for* them — using whatever providers they've connected — while still letting them steer (enable/disable) and stay in control of spend.

## Current reality (honest — what exists *today*)

Today's smart picking is **planner-driven, single-provider, plan-mode-only adaptive routing**, gated behind the experimental flag `adaptiveRoutingEnabled` (default **off**).

- **How it picks:** during plan mode, the planner LLM is handed an `<adaptive_routing>` addendum listing eligible models (cost tier, reasoning capability, context window, notes) and emits per-step `model`/`effort` choices + a one-way **escalation** ratchet. `compileStepRoutes` turns those into per-step routes. → `src/core/rebelCore/planningMode.ts` (`buildRoutingPromptAddendum`, `buildEligibleRoutingModelIds` ~:758, `extractRoutingFromPlan`), `rebelCoreQuery.ts` (`compileStepRoutes` ~:655-862).
- **The candidate pool:** routing-eligible *local profiles* — `routingEligible === true && enabled !== false && isProfileSelectable`, then connectivity-gated. → `src/shared/utils/routingProfiles.ts`, `connectivityHelpers.ts` (`getFunctionalRoutingProfiles`). The Working model is always included as `__working__`.
- **Decision-maker:** the **planner LLM** does the judgment (sees cost tier, picks per step). There is no deterministic cost/capability rules engine.

**Capability map — what exists vs what's a goal** (verify before relying on any row; sourced from the 2026-06-14 code sweep):

| Capability | Today |
|---|---|
| Per-step model choice driven by planner | **EXISTS** (plan-mode only, flag-gated) |
| Task-difficulty → tier (escalation) | **EXISTS** — planner-emitted, one-way ratchet (no hardcoded difficulty table) |
| Temporarily disable a **model** | **EXISTS** (`ModelProfile.enabled`; the per-row toggle) |
| Pool drawn from **multiple providers in one conversation** | **ABSENT** — single `activeProvider`; the pool only mixes *local profiles within one provider*. `routeEligibility` explicitly keeps `connectedProviders` inert. *This is the foundational gap.* |
| Temporarily disable a **provider** (distinct from switching `activeProvider`) | **ABSENT** |
| Prioritised provider/model list ("use X until rate-limited, then Y") | **ABSENT** |
| Generic rate-limit / cooldown **failover** across providers | **ABSENT** (only Codex has *within-provider* tier fallback; no 429 backoff store, no cross-provider failover) |
| Prompt-cache locality as a routing criterion | **ABSENT** (caching is applied uniformly *after* selection, not considered *during*) |
| Cost-preference baked into routing (prefer flat-fee/cheaper) | **PARTIAL** — planner *sees* cost tier and can reason about it; no deterministic preference |
| Model-family diversity (e.g. GPT reviews Claude) | **ABSENT** in app routing (it's a coding-agent-workflow convention, not a product feature) |

> **Foundation landed behind a default-off flag (2026-06, inert).** The multi-provider routing **foundation** now exists behind `experimental.multiProviderRoutingEnabled` (optional boolean, **default off** — so the table rows above remain accurate for normal users; there is **no user-visible behaviour until the flag is flipped**). When the flag is on, the router consults an ordered `enabledProviders` chain and **rate-limit failover / provider divert** (incl. Codex→Claude divert correctness, Stage 4b) routes to the next available provider on a 429. Router seam: `enumerateProviderModeCandidates` in [`providerRouting.ts`](../../src/core/rebelCore/providerRouting.ts) is the flag gate — it early-returns to the single `activeProvider` when the flag is off (`selectProviderMode` is the legacy single-provider resolver, not itself flag-gated); failover seam: the Stage 4b `multi-provider-rate-limit-fallback` branch in [`turnErrorRecovery.ts`](../../src/main/services/turnErrorRecovery.ts) (gated on the flag + `resolvedFrom === 'settings'`). The flag-gated "Backup connections" settings UI that edits the chain is in [UI_SETTINGS_AND_FORMS](./UI_SETTINGS_AND_FORMS.md). This realises G3 (failover) and rungs (a)/(b) of the T2 ladder for users who opt in. Plan: `docs/plans/260618_multiprovider-foundation/PLAN.md`.

## Goals (the intent — what we want)

> Each goal carries *why* and its *current status*. Several conflict; see "Constraints & tensions".

- **G1 — Draw the pool from *all* the user's providers.** A user may have any mix: ChatGPT Pro subscription, a Mindstone subscription, an Anthropic key, an OpenRouter key. Smart picking should choose across all of them. **Status: the big dependency** — requires "multiple providers in one conversation" (today's hard single-`activeProvider` model blocks it). This is the north star of [the multi-provider plan](../plans/260612_smart-picker-multiprovider/PLAN.md); managed (Mindstone) participation additionally needs a **billing decision** (see Constraints).
- **G2 — User can temporarily enable/disable models *and* providers.** Models: exists. **Providers: new** — a temporary per-provider off-switch (and ideally a prioritised order) distinct from the global `activeProvider`. The user stays in control; smart picking only ever draws from the *enabled* set.
- **G3 — Graceful rate-limit handling.** When a provider is temporarily rate-limited (429), smart picking should fail over (or pause that provider) rather than erroring — ideally to the *same logical model on another provider* first (north-star rung (a): failover). **Status: absent generically.**
- **G4 — Prefer flat-fee subscription over pay-as-you-go**, all else roughly equal — it's more cost-efficient for the user. **Status: not implemented as a preference.**
- **G5 — Prefer same-model-same-provider *clusters* for prompt-cache efficiency.** Switching model/provider mid-conversation throws away prompt-cache savings (see tension T1). **Status: not a routing criterion.**
- **G6 — Cost-efficient *without meaningfully sacrificing capability.*** The qualifier is load-bearing: cheap-by-default, but escalate to a stronger model when the task warrants. Needs a notion of task difficulty (today: the planner's judgment).
- **G7 — A little model-family diversity for difficult tasks** — e.g. have GPT review what Claude produced, à la [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md)'s cross-family reviews, when the payoff justifies the switch cost. **Status: absent; in direct tension with G5 (see T1).**

## Constraints & tensions (internalise these before designing)

These are the crux — the goals above are individually reasonable but pull against each other.

- **T1 — The cache cold-start switch cost (the dominant constraint).** Prompt/KV cache is **model- *and* provider-specific**. Every time smart picking switches model or provider mid-conversation, the *next* call on that provider re-pays the full *uncached* prompt — and this recurs for the rest of the conversation. So **G5 (cluster for caching), G7 (family diversity by switching), G3 (failover), and G1 (mix providers) all impose a real, often *silent*, cost that fights G4/G6 (cost-efficiency).** The cross-harness research is blunt about this: most coding agents *deliberately don't* switch mid-conversation, and a **"switch budget"** (cap how often we pay the cold-start) is recommended as a *hard prerequisite* for casual cross-provider switching, not a nice-to-have. **Implication:** "use GPT to review Claude's work" is not free — it's a deliberate, budgeted decision, best at clean step/turn boundaries, reserved for tasks where the diversity payoff beats the re-cache cost.
- **T2 — "Draw from all providers" is a foundational rearchitecture, not a routing tweak.** Today there is one `activeProvider`. True multi-provider-in-one-conversation is the **north-star ladder**: (a) **failover** (same logical model, other provider, on error) → (b) **turn-boundary role switch** (different models for distinct steps, switch at clean boundaries — the realistic shape, à la Goose Lead/Worker) → (c) **canonical-history handoff** (strip reasoning, re-budget context for the new tokenizer, switch only at turn boundaries). Rebel's provider-neutral runtime is an *advantage* for (c). Smart picking as Greg describes it ≈ rung (b), generalised across providers. → [the plan's Stage 7 framing].
- **T3 — Managed (subscription-pool) routing is billing-gated → RESOLVED 260614 as per-route billing.** Today a Mindstone-plan model only routes via the managed key when `activeProvider === 'mindstone'` (`localModelProxyServer.ts` `isManagedMode`). The resolution (Greg, 260614): **billing follows whichever provider the priority chain selects for a model** — there's no "surprise billing", so the change is architectural, not a product fork. A managed-covered model routed via Mindstone bills the managed key (Mindstone's cost, accepted as part of the flat fee); routed via the user's own key, it bills the user. **Required change:** relax `isManagedMode` so the managed key routes managed-covered models whenever **Mindstone is the *selected route*** (per-route), not gated on a single global `activeProvider`. Don't hard-bake "managed key ⇔ activeProvider===mindstone". → [HANDOFF_add-a-model-managed-visibility](../plans/260612_smart-picker-multiprovider/HANDOFF_add-a-model-managed-visibility_260613.md).
- **T6 — Family diversity can spend the *user's* money, not Mindstone's.** Neither ChatGPT Pro nor Mindstone serves Claude, so a "have Claude review the GPT output" switch (G7) routes via the user's own Anthropic/OpenRouter key — a *user* cost, on top of the cache cold-start (T1). So the LLM's diversity-switch judgment is spending the user's budget; the switch budget should account for that, and diversity reviews should be reserved for genuinely high-value/risky steps.
- **T4 — Who decides: the planner LLM, or a deterministic policy engine?** Today the planner LLM picks (flexible, but non-deterministic, costs planner tokens, and only runs in plan mode). Goals G4/G5 (prefer subscription, cluster for cache) are *deterministic cost/locality rules* that may be better enforced by the engine; G6/G7 (difficulty, when-to-diversify) are *judgment* the planner is good at. A hybrid (deterministic guardrails + planner judgment within them) is the likely shape — but **this is an open decision**, and the more we move into deterministic rules the more we need cost/capability/locality as *data* (lookups), not model-name branching.
- **T5 — Don't collapse the type model.** Tempting reading of "one data structure, many functions": merge the ~15 model/config types. Don't — they're *intentionally stratified* (the branded `StoredModelChoice → RoutingModelId → WireModelId` lifecycle makes illegal states uncompilable; it came from the 260529 prefix-leak postmortem). The right translation of the instinct is **fewer resolution *authorities*** (one credential resolver, one eligibility/pool builder, one capability read-model — partly shipped: `resolvedModelCapabilities.ts`), **not fewer types**. → [internal data-structure report].

## Open questions / decisions to make

These are the steering decisions (product + architecture) this doc exists to tee up — not yet answered:

1. **Default-on cross-provider switching, or off behind a switch budget?** (T1) — recommend: off / budgeted by default; clustering as the default behaviour.
2. **Billing model for managed-plan models used cross-provider** (T3) — the gating product decision for G1 with Mindstone.
3. **Planner-LLM vs deterministic policy split** (T4) — which preferences are hard rules vs planner hints?
4. **What's the unit of switching?** per-step (today), per-turn/role (Goose-style), or full handoff? (T2 ladder rung.)
5. **Provider enable/disable + prioritised order** (G2) — new settings surface + semantics ("use X until rate-limited, then Y").
6. **How is "difficulty" determined** for G6/G7 — planner judgment, a heuristic, or explicit step metadata?
7. **Failover policy** (G3) — same-model-other-provider first? backoff/cooldown store? interaction with the switch budget and cost (failover target may be pay-as-you-go).

## Decisions so far (2026-06-14, with Greg)

- **Caching vs cross-family diversity (resolves T1/G5/G7):** optimise for prompt-cache clustering **most of the time**, but cross-model-family review is genuinely valuable when **correctness matters / the work is risky or complex**. We want the **best of both**, and we explicitly **give the LLM room to make that judgment** (spend a switch for a diversity/review pass when the task warrants) rather than hard-coding "never switch" or "always cluster". So: clustering is the *default*, switching is a *judged, deliberate* exception — and the judge is the model, within guardrails (e.g. a switch budget), not a rigid rule.
- **Multiple providers active at once (G1/G2):** the user can have several providers live simultaneously (e.g. ChatGPT Pro **and** Mindstone **and** an Anthropic/OpenRouter key). Smart picking draws from all of them.
- **Provider priority is a fallback chain, and Rebel should define a sensible default the user can override.** Worked example of the intended default: *ChatGPT Pro subscription → Mindstone subscription → Anthropic/OpenRouter API keys* — i.e. **use a provider until it rate-limits, then fall to the next.** A per-*model* priority list is too low-level; priority lives at the **provider** level.
  - **Proposed refinement (the more elegant decomposition — for discussion):** treat it as **two layers**, not one list:
    1. **Model/capability selection** — the picker chooses *what tier of model* the step needs (capability ↔ difficulty), giving "cost-efficient without sacrificing capability" (G6).
    2. **Route/credential selection for the chosen model** — among the user's providers that can actually serve that model, route via the **highest-priority available (non-rate-limited)** one. This is where the provider-priority chain + rate-limit failover live.
  - **The default order is derived from a *three-party* cost model (clarified 260614), not just "subscriptions first":**
    1. **ChatGPT Pro first** — the user already pays OpenAI for it, so it costs **Mindstone (the business) $0**. Best for all parties.
    2. **Mindstone-provider second** — flat-fee to the user (cheaper for *them* than their own key), but **Mindstone pays per-use upstream** and accepts that as part of the flat-fee deal. *This is why Mindstone's menu is deliberately small — GPT-5.5 for planning, DeepSeek V4 Flash for everything else — to bound Mindstone's backend cost.*
    3. **User's own API keys last** — because now the **user** pays per token.
    The user can reorder/toggle to override, but the default is computed from this logic — so "prefer subscription" (G4) falls out of the ordering.
  - **Key nuance to hold:** provider-priority only bites for a model **reachable via >1 of the user's providers** (e.g. `gpt-5.5` via ChatGPT Pro vs OpenRouter vs Mindstone; `deepseek` via Mindstone vs OpenRouter). A model on a single route (e.g. Claude via Anthropic key) doesn't "choose" a provider. And rate-limit failover **re-pays the cache cold-start** (T1) and needs a **cooldown store** to know when to retry the preferred provider — so even forced failover isn't free.
- **Add-a-model UI / managed-visibility is downstream.** It depends on (a) the multi-provider *routing* foundation and (b) the **managed-key billing decision** (T3). It is parked until those land; not part of the foundation work.

## Recommended shape (for the implementing run — a starting position, not a spec)

Synthesised from the 260614 discussion + the cross-harness research. The implementing run should pressure-test, not blindly follow.

1. **Two-layer decision.**
   - *Layer 1 — model/capability selection:* pick the model the step needs (capability ↔ difficulty). Default cheap-capable; escalate to a stronger model when the task warrants (LLM judgment, today's planner does this). Prefer a stronger model on the *same provider* first (no re-cache).
   - *Layer 2 — route/credential selection:* for the chosen model, route via the **highest-priority available (non-rate-limited)** provider among those that can serve it. This is where the provider-priority chain + failover live. Maps directly onto the multi-provider run's `routeRef` work — the chain is essentially an ordered, availability-filtered `routeRef` resolution. **Billing follows the route** (per-route; resolves T3).
2. **Provider priority = a Rebel-computed default the user can override**, ordered by the three-party cost logic (ChatGPT Pro → Mindstone → own keys; see "Decisions so far"). Provider-level, not per-model.
3. **Clustering is the default; switching is LLM-judged and budgeted.** Stay on one model/provider for cache efficiency unless (a) a rate-limit forces failover, or (b) the model judges a cross-family review is worth it for a correctness-critical/risky/complex step. A **switch budget** caps how often the cold-start (and, for diversity, the user's own-key cost — T6) is paid; it *gates* an LLM-requested switch, it doesn't forbid switching.
4. **New infra needed:** a **rate-limit/cooldown store** (when is provider X limited; when to retry the preferred one) — `routeEligibility` deliberately omits backoff today. And **provider enable/disable** + the priority-order setting (G2).
5. **Don't collapse the type model** (T5): fewer *resolution authorities*, not fewer types. Reuse the shipped capability read-model (`resolvedModelCapabilities.ts`) for layer-1's "what can this model do?".

## Outstanding questions (deferred — capture, don't block)

- The exact **switch-budget** shape (how many switches/conversation; what signal lets the LLM spend one; how T6's user-cost factors in).
- How **tier / difficulty** is represented for layer-1 (planner judgment vs explicit step metadata vs heuristic).
- **Settings/UX** for provider enable-disable + the overridable, cost-derived priority order (and how it reads to a non-technical user).
- Whether smart picking stays **plan-mode-only** (today) or generalises to non-plan turns.
- Failover specifics: same-model-other-provider first vs pause/queue on the limited provider; interaction with the switch budget.

## Signposting

**Active plan + research (reconcile, don't duplicate):**
- [`docs/plans/260612_smart-picker-multiprovider/PLAN.md`](../plans/260612_smart-picker-multiprovider/PLAN.md) — the live multi-provider plan: north-star ladder, switch budget, `routeRef` provider-binding, credential chokepoint, capability read-model. Decision Log has the verbatim user intent + the shipped/deferred/checkpoint state.
- `subagent_reports/260612_researcher-external-bestpractices.md` — how Goose / LiteLLM / Vercel AI SDK / Continue / Cline / OpenRouter / aider handle multi-provider, failover, cost, caching (the transferable patterns: two-layer facts/binding split, one adapter interface, capabilities-as-data, switchable profile bundles + roles).
- `subagent_reports/260612_researcher-internal-datastructures.md` — the ~15-type stratified model, branded id lifecycle, capability-vocabulary scatter.
- `subagent_reports/260612_reviewer-fable-architecture.md` — code-grounded architectural verdict (the switch-budget-as-prerequisite call, credential resolution sites, leak points).

**Code spine:**
- `src/core/rebelCore/planningMode.ts` — the eligible-pool chokepoint + routing prompt addendum + plan schema (where picking is *decided* today).
- `src/core/rebelCore/rebelCoreQuery.ts` — `compileStepRoutes`, mid-turn switch construction (`applyDueModelSwitches`/`createClientForModel`).
- `src/shared/utils/routingProfiles.ts`, `connectivityHelpers.ts` — pool construction + eligibility + `routeRef`/`supportsProfileId` resolution.
- `src/core/rebelCore/providerRouting.ts`, `providerRouteDecision.ts` — the route materializer + credential sites (the single-`activeProvider` constraint lives here).
- `src/core/rebelCore/resolvedModelCapabilities.ts` — the shipped `{declared, observed, effective}` capability read-model (the canonical place to ask "what can this model do?").
- `src/shared/data/modelCatalog.ts` — the "facts as data" SSOT (cost, context, capability flags) the picker reasons over.
- `src/main/services/localModelProxyServer.ts` — `isManagedMode` (the billing/active-provider gate behind T3).

**Territory:**
- [MODEL_AND_PROVIDER_OVERVIEW](./MODEL_AND_PROVIDER_OVERVIEW.md) — the hub (start here for the whole model→route→auth→bill journey).
- [BILLING_AND_SUBSCRIPTION_TIERS](./BILLING_AND_SUBSCRIPTION_TIERS.md) + [MANAGED_PROVIDER_LIFECYCLE](./MANAGED_PROVIDER_LIFECYCLE.md) — the cost/subscription facts behind G4 and T3.
- [COST_TRACKING](./COST_TRACKING.md) — per-turn cost accounting (the feedback signal a cost-aware picker would use).

## See also

- [MODEL_ROLES_AND_THINKING](./MODEL_ROLES_AND_THINKING.md), [MULTI_MODEL_COUNCIL_MODE](./MULTI_MODEL_COUNCIL_MODE.md), [PROVIDER_RESOLUTION_AND_ROUTING](./PROVIDER_RESOLUTION_AND_ROUTING.md), [NEW_PROVIDER_SUPPORT_PROCESS](./NEW_PROVIDER_SUPPORT_PROCESS.md).
