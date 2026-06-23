---
description: "Where the model & provider stack is GOING — the consolidated vision, intent, settled decisions, decision reversals, open questions, and sequencing for the multi-provider / smart-model-picking refactor. The 'direction' companion to MODEL_AND_PROVIDER_OVERVIEW.md (which is how it works today). Synthesised 2026-06-18 from ~180 planning docs + the postmortem corpus + cross-family (GPT-5.5) review. NOT a spec — reconcile with the live plan docs before implementing."
last_updated: "2026-06-18"
status: "direction / decisions hub — large parts are NOT yet built"
---

# Models & Providers — Direction, Decisions & Open Questions

> **What this is.** The single place to recover *where the model/provider effort is heading and why* — the north star, the decisions Greg has settled, the reversals (so we don't relitigate), the tensions the planning corpus hasn't resolved, and the sequencing. It exists because ~180 planning docs orbit this area; this doc is the front door to their **intent**, the way [MODEL_AND_PROVIDER_OVERVIEW](./MODEL_AND_PROVIDER_OVERVIEW.md) is the front door to **how it works today** and [SMART_MODEL_PICKING](./SMART_MODEL_PICKING.md) is the intent hub for the picker specifically.
>
> **It is intent + handoff, not a spec.** It records decisions and open questions; it does not lock an implementation. Before implementing any part, **reconcile with the live plan doc** for that part (signposted throughout and collected in [§10](#10-signposting)).
>
> **⚠️ Read [§8 Concerns & open questions](#8-concerns-open-questions--inconsistencies-resolve-before-implementing) before starting any implementation** — it lists what must be resolved (and *when* each one bites) so the decisions surface at the right moment instead of being discovered mid-build.

---

## 1. The story in five beats

1. **Economic driver (why now).** Routing is too blunt — work tends to run through the most expensive model. The sharpest case is **ambient/automation work**: automations dominate spend (≈57% of a recent 7-day window), source-capture/morning-triage run monolithic 100–233-tool-call loops, ~97% on GPT-5.5 (the priciest), with a bimodal cost profile (top-5 turns ≈44% of the month). The fix is **per-task routing to the cheapest *adequate* model** — not blanket downgrades (those trigger retries/loops and cost *more*). Evidence: [`260614_smart-model-routing/SYNTHESIS.md`](../plans/260614_smart-model-routing/SYNTHESIS.md) §5, [`260615_automation-model-tier-and-backoff/`](../plans/260615_automation-model-tier-and-backoff/).
2. **Product promise.** Non-technical knowledge workers should never learn model/provider economics. Rebel makes the cost/capability tradeoff *for* them across whatever providers they've connected, spend visible and steerable.
3. **Architecture unlock.** Two orthogonal layers, kept separate: **Layer 1 — capability selection** (what *tier* the step needs; cheap-by-default, escalate when warranted) and **Layer 2 — route/credential selection** (route the chosen model via the highest-priority *available* provider). **Billing follows the route.**
4. **Safety rails (non-negotiable for dynamic routing).** A **switch budget** (prompt-cache cold-start is model+provider-specific and recurs silently), **routing observability** (requested→resolved→provider→fallbacks→reason→cost), **no surprise paid spend**, and **cross-surface parity** (desktop/cloud/mobile).
5. **Sequencing.** Build the multi-provider framework on **non-Mindstone (user-pays) providers first**; add **Mindstone last** — it's the only one carrying company-cost exposure + role gates.

---

## 2. The mental model (vocabulary that must not be conflated)

Conflating these axes is "the main trap" the postmortems keep punishing. Canonical definitions live in [NEW_PROVIDER_SUPPORT_PROCESS](./NEW_PROVIDER_SUPPORT_PROCESS.md) and [PROVIDER_RESOLUTION_AND_ROUTING](./PROVIDER_RESOLUTION_AND_ROUTING.md).

- **Model** — a catalog id; capability + cost *facts as data* in `src/shared/data/modelCatalog.ts`. **This already IS the registry** — the direction is to lean into it as data, not build a new structure. → [MODEL_REGISTRIES](./MODEL_REGISTRIES.md).
- **Provider** (`ActiveProvider`: `anthropic | openrouter | codex | mindstone`) — how Rebel reaches & pays for a model. *Mindstone is asymmetric:* `ActiveProvider:'mindstone'` with **no own `ModelProviderType`**, reusing OpenRouter transport/catalog — so it is **not a full new provider axis**.
- **Profile** — a user-configured `(model + credential + endpoint)` (`ModelProfile`).
- **Route** — the resolved dispatch binding `(model + profile + provider + credential + transport + role)`, owned by `ProviderRouteDecision` (the single routing authority; legacy `ResolvedTarget` deleted + CI-guarded).
- **Role** — *who is calling*: user-facing trio Working / Thinking / Background (BTS) (+ Recovery); routing fans this into `execution | planning | bts | subagent`. → [MODEL_ROLES_AND_THINKING](./MODEL_ROLES_AND_THINKING.md).

Smart picking decides *what to route* (Layer 1); routing decides *how* (Layer 2). Council (parallel models on one prompt) and explicit per-role assignments are distinct neighbours — see [SMART_MODEL_PICKING § what it is and is not](./SMART_MODEL_PICKING.md).

---

## 3. Greg's settled decisions (in force — don't relitigate)

> Verbatim intent is preserved in the plan docs' `## Decision Log` / "User Intent" sections (those are the conversation record — see [§10](#10-signposting)). The richest single Greg-authored artifact is [`260614_add-model-ui-NOTES-from-greg.md`](../plans/260614_add-model-ui-NOTES-from-greg.md).

**Routing / economics** (sources: [`SMART_MODEL_PICKING`](./SMART_MODEL_PICKING.md) §"Decisions so far", [`260614_smart-model-routing/MULTIPROVIDER_ROADMAP.md`](../plans/260614_smart-model-routing/MULTIPROVIDER_ROADMAP.md), [`STAGE1_DESIGN.md`](../plans/260614_smart-model-routing/STAGE1_DESIGN.md))
- **Multiple providers live at once** (G1); evolve past the single global `activeProvider` toward "an ordered list of available & enabled providers."
- **Provider-priority = a three-party cost chain, user-overridable, provider-level (not per-model): ChatGPT Pro ($0 to Mindstone) → Mindstone (flat-fee managed) → user's own pay-as-you-go keys.** "Prefer subscription" falls *out* of this ordering. Priority only bites for a model reachable via >1 of the user's providers.
- **Clustering is the default; switching is LLM-judged and budgeted.** Stay put for prompt-cache efficiency unless (a) rate-limit forces failover, or (b) the model judges a cross-family review worth it for a correctness-critical/risky step. The switch budget *gates* an LLM-requested switch; it doesn't forbid switching.
- **Billing follows the route** — relax `isManagedMode` from global `activeProvider==='mindstone'` to per-route; `isManagedRouteUsable` (`src/shared/types/managedProvider.ts`) + `resolveBillingSourceForModel` (`src/shared/utils/billingSource.ts`) must flip **together**.
- **Mindstone billed only for greenlit models** (GPT-5.5 + DeepSeek v4 Flash) — the proxy allow-list guarantees this by construction; the small menu bounds Mindstone's backend cost.
- **Role-restriction matters; soft enforcement now, hard mechanistic gate later — but we must reach the hard gate.**
- **Data-governance / privacy is OUT OF SCOPE** — all connected providers treated as equally trusted; routing carries no data-sensitivity dimension. (Risk acknowledged & accepted; see [§8](#8-concerns-open-questions--inconsistencies-resolve-before-implementing).)
- **Rate-limit handling:** the vision *does* include cross-provider failover + a cooldown store. The narrow, settled hard-fail is **Codex/ChatGPT-Pro quota exhaustion must not silently fall back to a paid backup** (FOX-3152). The open part is the *consent guardrail* around any paid fallback — not whether failover exists.

**Architecture posture** (sources: [`260507_provider_architecture_consolidation_chief_engineer.md`](../plans/260507_provider_architecture_consolidation_chief_engineer.md), [`260612_provider-registry/`](../plans/260612_provider-registry/), [`SMART_MODEL_PICKING`](./SMART_MODEL_PICKING.md) T5)
- **No big rewrite. Incremental + targeted consolidation.** "Fewer resolution *authorities*, not fewer types." Don't collapse the branded `StoredModelChoice → RoutingModelId → WireModelId` lifecycle (it makes illegal states uncompilable; came from the 260529 prefix-leak postmortem).
- **(R1) `ProviderDescriptor` registry and (R2) grand-unified `ProviderTarget`/RequestPlan god-object both stay REJECTED** (mis-axed / over-engineering on the reliability-critical agent-turn spine). (R3) `modelCatalog.ts` already is the catalog-registry.
- Recurring instruction: *"best long-term decision, no shortcuts… but wary of over-engineering"*; *"push back if the simpler answer is right."* Strong preference for **bug-by-construction** (exhaustiveness-checked seams, lint guards, single chokepoints that fail loud) and **testing baked in stage-by-stage**.

**Smart picking surface** (source: [`SMART_MODEL_PICKING`](./SMART_MODEL_PICKING.md), [`260614_recommended-models-engine/`](../plans/260614_recommended-models-engine/))
- **Keep smart picking plan-mode-only for now** — "sometimes is right; always would be overkill." (Generalising to all turns is open — but the route/policy *layer* shouldn't be plan-mode-shaped even while the *trigger* stays plan-mode.)
- **Recommendation engine is deterministic (a script)**; LLM-as-judge only in offline eval validation. "Do the work for most users so they don't have to think about it, with an override for power-users."

**Mindstone product** (sources: [`BILLING_AND_SUBSCRIPTION_TIERS`](./BILLING_AND_SUBSCRIPTION_TIERS.md), [`MANAGED_PROVIDER_LIFECYCLE`](./MANAGED_PROVIDER_LIFECYCLE.md), [`260521_rename_managed_tiers_pro_dash_expert_rogue.md`](../plans/260521_rename_managed_tiers_pro_dash_expert_rogue.md), [`260428_subscription_tiers.md`](../plans/260428_subscription_tiers.md))
- **Mindstone should feel like "one more provider"** in user-facing & routing *policy* — server-side entitlements, **no user API keys**. Prompt traffic still routes through Rebel's **local proxy → OpenRouter** path (the managed key is injected and the allow-list enforced at the proxy edge); the Mindstone backend provisions entitlements/key material and is **not** the prompt-processing service ("we ideally don't want the user's prompts/data going through our servers").
- **Tiers renamed Pro/Expert → Dash/Rogue** (Greg, 2026-05-21; clean wire break, no backward-compat). Copy always "Dash plan"/"Rogue plan"; provider label bare "Mindstone"; auth copy "Covered by your Mindstone plan."

**Add-model UI** (source: [`260614_add-model-ui-NOTES-from-greg.md`](../plans/260614_add-model-ui-NOTES-from-greg.md) — Greg verbatim) — *process: get CHIEF_DESIGNER input but don't let it implement / change drastically without discussing first; run CE2 planning autonomously, then STOP at the Phase-3 checkpoint before building.*
1. **A small SET of recommendations, not one headline pick.**
2. **"Use recommended defaults" = YES**, plus a **NEW provider-level recommendation ladder** keyed on what the user has: no providers → recommend a subscription (cheapest Mindstone); one subscription → recommend the *other* (ChatGPT Pro ↔ Mindstone as mutual rate-limit fallback); then OpenRouter ("max flexibility, no rate limits").
3. **Plan models → "Included in your plan" chip + tooltip** (fold into the recommended set).
4. **Editorial/unproven models (Opus 4.8, Gemini) → show nothing special.**
- Cross-cutting: lots of hover-tooltips/links (per-model pricing discoverable); progressive disclosure; engine slots → human JOBS ("Most capable" / "Most economical" / "Best for images"); availability → action (Add / "Connect X" / "Included in your plan"); power-user "Browse all models" collapsed below.

---

## 4. The 3-phase roadmap + where we are

> Canonical sequencing: [`260614_smart-model-routing/MULTIPROVIDER_ROADMAP.md`](../plans/260614_smart-model-routing/MULTIPROVIDER_ROADMAP.md).

- **Phase 1.5 — Role-vocabulary unification — ✅ DONE (on `dev`).** ONE canonical `ModelRoleTier = working|thinking|background`; `'fast'` misnomer retired *internally* → `'background'`; persisted **wire stays `'fast'`** (zero migration) via boundary mappers; `/config` keeps `'bts'`. The first *verified* win was a single exhaustiveness-checked `modelRoleForRouteRole` mapping (the roadmap explicitly rejected broad type-collapse); Greg then pushed back on "leave it layered", a serialization trace proved real drift, and the broader unification was authorized & shipped. → [MODEL_ROLES_AND_THINKING](./MODEL_ROLES_AND_THINKING.md), [`ROLE_VOCAB_UNIFICATION_PLAN.md`](../plans/260614_smart-model-routing/ROLE_VOCAB_UNIFICATION_PLAN.md).
- **Phase 2 — Multi-provider framework, non-Mindstone providers only — NEXT.** Starts with a **behaviour-preserving `selectProviderMode` restructure** ("enumerate available providers → pick one") → priority-ordered selector over enabled/available providers → cooldown/rate-limit failover store → provider enable/disable + priority settings UX → **routing observability (land it EARLY, not last)**. The routeRef **deterministic core + planner-prompt activation already shipped** (live-eval verified); what's deferred is the **multi-provider priority/availability policy layered on top of routeRef**, not routeRef itself. All money stays on the user's own keys/subscriptions → no Mindstone exposure, no peer-collision. → [`260612_smart-picker-multiprovider/PLAN.md`](../plans/260612_smart-picker-multiprovider/PLAN.md), [`260604_routing-ssot-divergence/`](../plans/260604_routing-ssot-divergence/), [`260614_routeref-foundation/`](../plans/260614_routeref-foundation/).
- **Phase 3 — Mindstone as one more provider (deferred, now well-scoped):** role-aware managed authorization → priority entry + per-route managed gate + cost-flip → hard role-gate (`x-rebel-route-role` header) + existing-user migration. Coordinate with the recommended-models peer agent on `managedProvider.ts` / `billingSource.ts`. → [`260614_smart-model-routing/STAGE1_DESIGN.md`](../plans/260614_smart-model-routing/STAGE1_DESIGN.md), [`260613_managed-models-visibility/`](../plans/260613_managed-models-visibility/), [MANAGED_PROVIDER_LIFECYCLE](./MANAGED_PROVIDER_LIFECYCLE.md).

*Why defer Mindstone:* nearly all the *risk* is Mindstone-specific (greenlit allow-list, role-restriction, "Mindstone pays", fail-closed managed gate, peer-collision files). The framework is identical; Mindstone is one more priority-chain entry.

---

## 5. The consumer-facing track (parallel to the routing spine)

- **Recommendation engine — landed in `src/core/modelRecommendation/`; UI wiring deferred.** Deterministic ranked slot-filling, eval-grounded (KW Pareto data), **provider-conditional effective cost** (a subscription flips GPT-5.5 from USD-dominated to flat). Buckets: ≥1 highly-intelligent (prefer the one the user has all-you-can-eat), ≥1 cheap, ≥1 good vision; optional middle. → [`260614_recommended-models-engine/`](../plans/260614_recommended-models-engine/), [`260614_recommended-models-followup/`](../plans/260614_recommended-models-followup/), and the engine blurb in [MODEL_AND_PROVIDER_OVERVIEW](./MODEL_AND_PROVIDER_OVERVIEW.md).
- **"Model jobs" + optional "Model team" IA.** Three default jobs (Main work / Deep thinking / Behind the Scenes) + an optional team powering **Smart picking** (per-step) and **Council** (parallel). Renamed "adaptive routing" → **"Smart model picking"**; "routing eligible" → **"Included in Smart picking."** → [`260509_model_team_and_smart_picking.md`](../plans/260509_model_team_and_smart_picking.md), [`260510_models_settings_ia_simplification.md`](../plans/260510_models_settings_ia_simplification.md).
- **Add-a-model / settings UI — much already shipped in stages** (catalog-first picker, ~46 descriptions, "Add to team", offline catalog **search**, disable toggle, "Recommended for most people" group, Mindstone-plan models shown as addable for subscribers). The **recommendation-driven redesign + provider-ladder is the deferred CE2 run needing the chief-designer + Greg checkpoint before build.** → [`260511_add_model_dialog_redesign.md`](../plans/260511_add_model_dialog_redesign.md), [`260612_add-model-search/`](../plans/260612_add-model-search/), [`260614_add-model-ui-NOTES-from-greg.md`](../plans/260614_add-model-ui-NOTES-from-greg.md).

> **⚠️ Treat the provider-recommendation ladder as its own product-policy surface** — an *acquisition/onboarding* ordering (recommend Mindstone first to a no-provider beginner) that is deliberately *distinct from* the *runtime* cost chain (which prefers ChatGPT Pro *before* Mindstone because Mindstone costs the business money). Same words, opposite ordering, different jobs — keep them explicitly separate. (See [§8 #2](#8-concerns-open-questions--inconsistencies-resolve-before-implementing).)

### Add-a-model UI — captured suggestions (2026-06-18; DEFERRED, needs design detail)

> Sketches agreed in conversation, recorded so they're not re-derived. **Not final** — the redesign run needs the chief-designer + a Greg checkpoint before build, and is **deferred behind the plumbing** (§9). The current add-a-model UI is adequate meanwhile.

**Two kinds of recommendation, kept separate:**

**(a) Model recommendations — a small SET (not one headline), labelled by job:**

```
┌─ Add a model ──────────────────────────────────────────────┐
│  Recommended for most people              [ Use these ✓ ]  │
│  ┌──────────────────────────────────────────────────────┐ │
│  │ ⭐ Most capable     Claude Opus 4.8        [  Add  ]  │ │
│  │    Best for hard reasoning · ~$$ per use (est.)  (i)  │ │
│  ├──────────────────────────────────────────────────────┤ │
│  │ 💲 Most economical  DeepSeek v4 Flash      [  Add  ]  │ │
│  │    Cheap everyday work · Included in your plan   (i)  │ │  ← chip, not a price
│  ├──────────────────────────────────────────────────────┤ │
│  │ 🖼 Best for images  Gemini 3 Pro    [ Connect Google ]│ │  ← availability→action
│  │    Reads screenshots & PDFs · Pay-as-you-go(est.)(i)  │ │     (shown ONLY if neither
│  └──────────────────────────────────────────────────────┘ │      capable nor economical
│  ▸ Browse all models   (🔍 search…)                        │      already does images)
└────────────────────────────────────────────────────────────┘
```

**(b) Provider recommendation ladder — what to *get* next (acquisition, not runtime order):**

```
What you already have            Suggest…                      Why (tooltip)
────────────────────────────     ─────────────────────────     ─────────────────────────────
nothing connected         ─────▶ "Start with a Mindstone plan" cheapest way in
ChatGPT Pro only          ─────▶ "Add a Mindstone plan"        backup when ChatGPT hits limits
Mindstone plan only       ─────▶ "Add ChatGPT Pro"            backup — AND it then jumps ABOVE
                                                                Mindstone in runtime priority
already has a subscription ────▶ "Add OpenRouter"             max flexibility, no rate limits
```

**Refined decisions (Greg, 2026-06-18):**
- **"Best for images" is conditional** — include it only if *neither* the most-capable *nor* the most-economical pick already supports images.
- **What "add to team" means:** the model joins the pool the **planner can draw on (likely as a worker)**. Worth ensuring the set gives the planner **≥1 extra high-capability model for cross-family review**, and possibly **one model just above or below the cheapest** (depending on how capable the cheapest is). *(Mental model still slightly fuzzy — refine with chief-designer.)*
- **Costs:** use **OpenRouter prices for the real numbers**, shown as **estimates** (a tooltip / "est." indicator so users don't read them as exact).
- **Onboarding placement of the ladder:** deferred — revisit at the end.

**Open questions for the design run:** does **[Use these]** just *add* or also *assign* to jobs/smart-picking? · exact set size · do editorial models appear in the set or only in browse-all? · the "Included in your plan" chip's add/use behaviour is blocked on the Phase-3 managed-visibility gate (§8 #6).

---

## 6. What the bug history says the framework MUST get right

The model/provider postmortem corpus (in `docs-private/postmortems/`) is the strongest evidence for the architecture direction. Root-cause themes:

1. **Anthropic-first accretion without rearchitecture** — "alt model = Claude fallback" is the structural symptom; recovery/classification/routing grew as bolt-ons. → [`260611_provider_error_architecture/`](../plans/260611_provider_error_architecture/), `260429_provider_routing_anthropic_native_under_codex_postmortem.md`, `260616_chatgpt_reconnect_codex_anthropic_stranding_postmortem.md` (FOX-3494), `260609_memory_update_inherited_thinking_model_anthropic_key_postmortem.md`.
2. **Classification and copy are separate contracts that drift.** → `260611_rate_limit_alt_model_terminal_generic_copy_postmortem.md`, `260607_provider_error_misclassification_403_billing_postmortem.md`, `260608_disconnected_provider_rejected_credentials_toast_17dde9d_postmortem.md`, [ERROR_CLASSIFICATION_AND_ROUTING](./ERROR_CLASSIFICATION_AND_ROUTING.md).
3. **Derived facts distributed to call sites** (optional fields default wrong, forgotten injectors). → `260602_mindstone_managed_key_injection_gap_postmortem.md`, `260611_openrouter_user_profile_oauth_resolver_gap_postmortem.md`, `260608_subagent_route_table_body_model_divergence_postmortem.md`.
4. **Storage shape ≠ wire shape ≠ UI shape** (`model:` / `profile:` / `anthropic/` prefix leaks). → `260529_bts_model_choice_storage_prefix_wire_leak_postmortem.md`, `260605/260505_anthropic_prefix_not_stripped_before_native_wire_postmortem.md`, `260606_direct_anthropic_self_prefix_reject_auth_mislabel_postmortem.md`.
5. **Provider-level capabilities answering per-model questions** (vision, thinking, sampling, tool-use compat across gateways). → `260610_image_input_unsupported_by_model_postmortem.md`, `260616_bts_sampling_forbidden_opus48_postmortem.md`, `260617_coppel-gateway-preservation/` (Vertex `reasoning_effort`→`thinking.type`; Gemini `thought_signature`), [PROVIDER_REQUEST_PARAM_MATRIX](./PROVIDER_REQUEST_PARAM_MATRIX.md).
6. **Cross-surface / per-provider parity not enforced by construction.** → `260422_codex_oauth_death_loop_cloud_mobile_parity_postmortem.md`, [Cross-Surface Parity in PROJECT_OVERRIDES2](./PROJECT_OVERRIDES2.md#architecture--cross-surface-parity) (26% of prod bugs).
7. **Observability optimised for route *target*, not *culprit*** — support misled for days. → `260424_sentry_model_error_fingerprint_fragmentation_postmortem.md`, FOX-3494 postmortem.

→ The multi-provider framework must bake in: honest end-to-end error taxonomy (rate-limit / billing / subscription / auth / connection-not-configured / gateway-incompatible) with distinct copy+recovery+telemetry; a single classification/humanization chokepoint; declarative recovery ownership (`RECOVERY_OWNER_BY_KIND`, order-independent); a per-provider × per-model capability matrix with gateway auto-detect; chokepoint resolution for credentials/managed-keys/model-id; provider-heal symmetry (compile-forced per `ActiveProvider`); telemetry carrying culprit + requested model; seam contract tests on user-visible outcomes.

---

## 7. High-signal decision reversals (so we don't re-litigate)

- **Broad role-type collapse:** recommended-against → **Greg overrode → unified** (serialization trace won). ([`MULTIPROVIDER_ROADMAP.md`](../plans/260614_smart-model-routing/MULTIPROVIDER_ROADMAP.md) "Phase 1 VERIFIED FINDINGS" vs [`ROLE_VOCAB_UNIFICATION_PLAN.md`](../plans/260614_smart-model-routing/ROLE_VOCAB_UNIFICATION_PLAN.md).)
- **Per-message tier classifier** (260405) → **planner-driven routing** (260417); classifier abandoned.
- **Prioritised model-config *lists* per tier** (260531) → **strict trios** (single-provider v1) → trios **deleted entirely** for routeRef + provider-priority. ([`260531_prioritised-model-configs/`](../plans/260531_prioritised-model-configs/) → [`260612_smart-picker-multiprovider/`](../plans/260612_smart-picker-multiprovider/).)
- **`ProviderDescriptor` registry rejected** (mis-axed); grand-unified `RequestPlan`/`ProviderTarget` **rejected twice** — only a narrow additive capability read-model (Option A) survives as a question ([`260614_model-identity-descriptor/HANDOFF_DECISION.md`](../plans/260614_model-identity-descriptor/HANDOFF_DECISION.md)).
- **Model-remap-on-provider-switch → clear all overrides** on switch.
- **Mindstone managed:** client-bundled token → **server-side provisioning**; `routingAvailable` flag → **removed**; `modelProviders` per-model OR routing → added then **removed**.
- **Fable 5:** added as a 5th "Frontier" $$$$$ opt-in tier (Greg chose a new tier over repointing Maximum) → **withdrawn/hidden** when access lapsed.
- **Gateway thinking:** manual "Off" toggle shipped 0.4.48 → **removed** 2026-06-18 ("we do not want to offer turning thinking off by choice") → auto-detected `thinkingCompatibility` only ([`260617_coppel-gateway-preservation/`](../plans/260617_coppel-gateway-preservation/)).

---

## 8. Concerns, open questions & inconsistencies (RESOLVE BEFORE IMPLEMENTING)

> Each item names **when it bites** so it surfaces at the right moment. ⚠️ = needs Greg's call; 🔧 = engineering decision (resolve via diverse review + Arbitrator, not a user checkpoint).

1. **✅ RESOLVED (2026-06-18) — Provider-error: (B) is already shipped; (C) committed for later.** **(B)** — the honest error taxonomy + culprit-aware telemetry — **already landed** via the `260611_provider-error-redesign` work (verified by code + docs research): `RECOVERY_OWNER_BY_KIND` ownership table, `limitScope`/`headlineClass` facets, structured-fields-first classification (403 disambiguation), kind-correct copy, stable Sentry fingerprints, the FOX-3494 culprit fields on `ai_error_shown` (`routeInvalidReason`/`failedRouteRole`/`unsupportedModelId`/`upstreamProvider`), and the `enforceHumanizerOwnedOverrideContract()` kind-blind-copy guard. **So there is no "B" plumbing left to build** (a marginal explicit-`requestedModel`/`culpritProvider` telemetry field was considered and dropped — redundant with the shipped culprit fields). **(C)** = the full provider-agnostic rearchitecture — retire the Claude-first "alt-model fallback" frame (provider-default assumptions live across `selectProviderMode` (defaults *unset* → Anthropic), `bestNonCodexProvider` (prefers OpenRouter), and the Claude-divert-under-codex paths — `providerRouting.ts`); recovery keyed by `errorKind × providerCapabilities` — which **we will definitely do**, *after* the multi-provider chain exists and makes it cheaper + provably-shaped. *Still open:* the paid-fallback consent rule (#3). ([`260611_provider_error_architecture/`](../plans/260611_provider_error_architecture/) = the C design — parked.)
2. **✅ Confirmed design (Greg, 2026-06-18) — Acquisition ladder ≠ runtime cost chain (two separate surfaces, deliberately opposite).** The add-model UI's *acquisition* ladder recommends what to **get next**; the *runtime* cost chain decides what to **use first**. Worked example: a **Mindstone-only** user is *suggested* ChatGPT Pro (acquisition); once they add it, **ChatGPT Pro jumps *above* Mindstone in the runtime priority** — spend the already-paid-for ChatGPT Pro allotment first (it's $0 to Mindstone) before drawing on Mindstone-subscription tokens. So the two orderings genuinely diverge and must stay **two distinct policy surfaces**. *Bites at:* the add-model-UI run AND Phase 2's priority-default computation.
3. **✅ DECIDED (Greg, 2026-06-18) — auto-fallback, no cap.** On quota/rate-limit exhaustion, Rebel **auto-fails-over to the next provider in the chain — including a paid own-key route — with no spending cap** (seamlessness chosen over a spend guard). This **supersedes the earlier FOX-3152 "no silent paid fallback" stance** for the multi-provider failover case. **Required safeguard (build it, since own-key spend is now unbounded on failover): observability** — the routing telemetry + usage surface must make a paid-route failover *visible*, ideally a user-facing indicator when a turn ran on a paid fallback. *Bites at:* Stage 4 (failover selector takes billing-source as an input — no cap logic) + Stage 5 (surface it). *Note:* the **safety-eval fail-closed on a quota-exhausted single-credential user** (the 260622 "opaque single-credential routing starvation" class — see `docs-private/postmortems/260622_safety_eval_connector_error_messages_postmortem.md`; the Sentry monitor now shows ≈6 such users/day) is the same shape as this provider failover and *could* be subsumed by it rather than handled as a separate automatic safety-eval fallback. Not a mandate — just where it might naturally land.
4. **⚠️ Plan-mode-only picking vs automation cost.** Greg chose plan-mode-only for the picker, but the biggest spend is ambient/automation loops, which aren't plan-mode. Keep the route-binding/policy layer provider-shaped, not plan-mode-shaped, even if the picker *trigger* stays plan-mode. *Bites at:* Phase 2 (don't bake plan-mode assumptions into the policy layer) and the automation-routing decision (#7).
5. **🔧 Cluster-for-cache vs cheapest-adequate model.** "Cheapest adequate" is only true *after* the cache cold-start and switch budget are priced in; switching to a cheaper/diverse model can erase prompt-cache savings (the dominant constraint, T1), and family-diversity reviews spend the *user's* money (T6). *Bites at:* the switch-budget design ([SMART_MODEL_PICKING § Constraints](./SMART_MODEL_PICKING.md)).
6. **⚠️ When can managed-plan models be added/used while another provider is active?** Billing-affecting; currently a **held gate** + footgun-free interim ([`260613_managed-models-visibility/`](../plans/260613_managed-models-visibility/)). *Bites at:* Phase 3 Stage 1 (the `isManagedRouteUsable` + `resolveBillingSourceForModel` co-flip).
7. **⚠️ Automation routing model.** Static `systemType→tier` map (Arbitrator choice) vs dynamic smart-picker per turn (Greg leaned dynamic post-eval; eval showed source-capture must stay on `working`, not cheap). *Bites at:* [`260615_automation-model-tier-and-backoff/`](../plans/260615_automation-model-tier-and-backoff/) implementation.
8. **⚠️ Data-governance / privacy is currently OUT OF SCOPE** — routing carries no data-sensitivity dimension; all connected providers equally trusted. A reviewer flagged this as a blind spot. *Bites at:* any future point a user expects "don't send this to provider X" — confirm it stays out of scope as multi-provider lands.
9. **🔧 Model-identity descriptor: Option A / B / C / D.** A narrow additive capability read-model (A, recommended) vs full `RequestPlan` (B, close to the twice-rejected shape) vs spike (C) vs stop (D). Shares infra with Layer-1 capability lookup. *Bites at:* before any capability-resolution consolidation work ([`260614_model-identity-descriptor/HANDOFF_DECISION.md`](../plans/260614_model-identity-descriptor/HANDOFF_DECISION.md)).
10. **🔧 Unit of switching.** Is cross-provider switching failover-only, per-step (today), per-turn/role boundary, or full canonical-history handoff? This sets the granularity of `routeRef` and the switch budget. *Bites at:* before any discretionary cross-provider switching, and the switch-budget design ([SMART_MODEL_PICKING § Constraints T2](./SMART_MODEL_PICKING.md), [`SYNTHESIS.md`](../plans/260614_smart-model-routing/SYNTHESIS.md) §7).
11. **🔧 Planner-LLM vs deterministic-policy split (Layer 1).** Which choices are hard deterministic rules (prefer-subscription, cluster-for-cache, cost floor) vs planner-LLM judgment (difficulty, when-to-diversify)? A hybrid is likely, but the split is unsettled — and it widens once picking generalises beyond plan mode. *Bites at:* the Layer-1 selection design (Phase 2+) ([SMART_MODEL_PICKING § Constraints T4](./SMART_MODEL_PICKING.md)).
12. **✅ DONE (2026-06-18) — Stage C:** renamed the unrelated `ModelRoles`/`ModelRolesSchema` (safety/memory/auxiliary) → `SpecialTaskModelOverrides`/`SpecialTaskModelOverridesSchema` in `ipc/schemas/settings.ts` (3 self-contained lines, zero external refs, persisted `modelRoles` key unchanged → zero migration).
13. **🔧 DECIDED (2026-06-22) — Transport hygiene policy adopted; implementation deferred behind Phase 2 (no rebuild in this run).** **Policy (verbatim, from [`260620_transport-hygiene-and-ir-convergence/PLAN.md`](../plans/260620_transport-hygiene-and-ir-convergence/PLAN.md) §4(A)):** *"The Anthropic SDK is allowed only for `anthropic-direct`. Anthropic-compatible proxy/provider routes may still speak the Anthropic Messages format, but should use a Rebel-owned fetch/SSE transport so retries, timeouts, and error classification are Rebel/provider-owned."* Context: `clientFactory` today routes `codex-proxy` / `openrouter-proxy` through the shared `AnthropicClient` (Anthropic SDK, sentinel key), so the SDK's retry / timeout / error-classification semantics govern **Codex/OpenRouter proxy traffic**, not just `anthropic-direct` (direct OpenAI-compatible profiles use the separate `OpenAIClient`); the dropped `260619` first-byte ceiling couldn't be scoped to Anthropic-direct because of this. **The bright line:** this settles the *policy* (keep the Anthropic *format*, drop the Anthropic *SDK* as the pipe for non-Anthropic routes) — the actual transport *rebuild* is **deferred behind Phase 2; no rebuild happens in this run**. Now committed scope under a widened "C" → ADR [`260622_provider-transport-and-error-architecture.md`](./architecture-decisions/260622_provider-transport-and-error-architecture.md) + [`260611_provider_error_architecture/`](../plans/260611_provider_error_architecture/PLAN.md). *Bites at:* the "C" rearchitecture / Phase 2+.
14. **🔧 Provider SELECTION must be dialect/serveability-aware (Phase-2 requirement; confirmed consistent 2026-06-23).** Today the Layer-2 selector (`isUsableProviderMode` / `pickProviderMode` / `enumerateProviderModeCandidates` in `providerRouting.ts`, behind `multiProviderRoutingEnabled`) treats a provider as "available" on **credentials + connectivity + cooldown only — *dialect-blind***. So a chosen model can be bound to a provider that cannot serve its dialect (a `deepseek/…` BTS model selected onto the codex proxy → wire crash for slash ids, *silent* misroute for bare non-OpenAI ids; the `260623_memory_bts_codex_arm_dialect_blind_admission` postmortem). "Available" must also include **provider × model dialect/serveability compatibility** — which is **known largely as static data, factored in *before* the call** (model→dialect via `toModelDialect` / `isCodexServableModel`; provider→speakable-dialects), with gateway-discovered capability (vision/thinking) the only runtime tail. This is **§6 root-theme #5 ("provider-level capabilities answering per-model questions") made real** — the provider × model capability matrix the framework must bake in. Then a chosen model routes to the highest-priority *enabled **and serveable*** provider instead of failing. **Cross-family review (Claude + GPT-5.5, 2026-06-23) confirms this is consistent with the direction (it IS Layer 2 — §1 beat 3, §4 Phase 2) — but FOLD INTO the Phase-2 `selectProviderMode` restructure, NOT a standalone selector tweak**: an ad-hoc change to `isUsableProviderMode` (documented as *deliberately* not per-model-capable) spawns another partial routing authority — against §3 "fewer resolution *authorities*" + §6 theme-#1 bolt-on warning. Rails it must respect: select only among **enabled/available** providers (never invent one because its dialect matches); **runtime cost-chain priority, NOT the acquisition ladder** (§5 / §8 #2); **billing-follows-route + observable** — no surprise paid spend (§1 beat 4 / §8 #3, e.g. silently routing background automation onto a paid OpenRouter key); Mindstone deferred to Phase 3; preserve **cross-surface parity + switch-budget** accounting (a dialect-driven switch still has cache/cost consequences). Keep it a **narrow capability read-model feeding the existing route seam** — must NOT become a rejected §7 shape (`ProviderDescriptor` registry / grand-unified `RequestPlan` / per-model provider-priority UI / remap-on-switch). **Interim, SHIPPED 2026-06-23 (`dev`):** both codex route arms + a `createClientFromRoutePlan` seam backstop + a producer-granularity lint now make a non-serveable model **fail loud as a clean terminal** — the honest, debuggable holding pattern until this lands. *Bites at:* Phase 2 (the `isUsableProviderMode` / `pickProviderMode` "available" definition) + the automation-routing decision (#7) — BTS/automation is the biggest spend (§1 beat 1) and is exactly where this fires. → `docs-private/postmortems/260623_memory_bts_codex_arm_dialect_blind_admission_postmortem.md`, [`260612_smart-picker-multiprovider/PLAN.md`](../plans/260612_smart-picker-multiprovider/PLAN.md).

---

## 9. Recommended next step (GPT-reviewed)

**First a tiny decision slice, then the foundation — both non-Mindstone, with observability baked in (not a reporting add-on).**

**Step 0 — error taxonomy + culprit telemetry ("B") — ✅ ALREADY SHIPPED (verified 2026-06-18).** The honest categories + culprit-aware telemetry the foundation needs already landed (see §8 #1); the only remaining product decision in this area is the *no-surprise-paid-fallback* rule (§8 #3). So the FAST track skips straight to the foundation below.

**Then — the foundation slice:** `selectProviderMode` behaviour-preserving restructure → enabled/available provider chain for non-Mindstone routes → cooldown/failover with the "no surprise paid spend" hook → **routing decision telemetry** (requested→resolved→provider→credential-source→fallback-reason→billing-source→why), landed *with the first selector change*, not at the end.

This proves the machinery where user/company billing risk is lowest, and lands the debug/observability surface that dynamic routing (and eventually Mindstone) needs *before* it's needed — rather than retrofitting it after auto-routing has become support-hostile. Make **cross-surface parity** (desktop/cloud/mobile) an explicit invariant of the slice.

> **Sequencing chosen (Greg, 2026-06-18): plumbing-first (this FAST track).** The add-a-model UI redesign is **deferred** — it needs more design thought (§5 captured suggestions), and the *existing* add-model UI is adequate in the meantime. The only UI in the FAST track is a small provider **on/off + priority** panel at the tail of Phase 2.

---

## 10. Signposting

### ⭐ Most important plan docs (read these first)
- [`260614_smart-model-routing/SYNTHESIS.md`](../plans/260614_smart-model-routing/SYNTHESIS.md) — the reconciled view of all strands (the single best starting point).
- [`260614_smart-model-routing/MULTIPROVIDER_ROADMAP.md`](../plans/260614_smart-model-routing/MULTIPROVIDER_ROADMAP.md) — the 3-phase sequencing + Greg's steer.
- [`260614_smart-model-routing/STAGE1_DESIGN.md`](../plans/260614_smart-model-routing/STAGE1_DESIGN.md) — the Mindstone-provider (Phase 3) specifics + billing priority.
- [`260612_smart-picker-multiprovider/PLAN.md`](../plans/260612_smart-picker-multiprovider/PLAN.md) + `CONSOLIDATION_smart-model-picking_260614.md` — the live multi-provider foundation (E1–E6, routeRef, credential chokepoint).
- [`260614_add-model-ui-NOTES-from-greg.md`](../plans/260614_add-model-ui-NOTES-from-greg.md) — Greg's verbatim add-model UI intent (the conversation record).
- [`260614_model-identity-descriptor/HANDOFF_DECISION.md`](../plans/260614_model-identity-descriptor/HANDOFF_DECISION.md) — the Option A/B/C/D capability-read-model decision.

### Supporting plan docs (by theme)
- **Provider architecture:** [`260507_provider_architecture_consolidation_chief_engineer.md`](../plans/260507_provider_architecture_consolidation_chief_engineer.md), [`260604_routing-ssot-divergence/`](../plans/260604_routing-ssot-divergence/), [`260601_routing-route-compiler/`](../plans/260601_routing-route-compiler/), [`260614_routeref-foundation/`](../plans/260614_routeref-foundation/), [`260612_provider-registry/`](../plans/260612_provider-registry/) (rejection rationale), [`260612_new-provider-process/`](../plans/260612_new-provider-process/), [`260620_transport-hygiene-and-ir-convergence/`](../plans/260620_transport-hygiene-and-ir-convergence/PLAN.md) (transport-hygiene policy **DECIDED 2026-06-22** — see #13 + ADR [`260622_provider-transport-and-error-architecture.md`](architecture-decisions/260622_provider-transport-and-error-architecture.md); implementation deferred behind Phase 2. The incremental-IR-convergence half remains exploratory).
- **Roles / capability / identity:** [`260509_centralize_model_role_selection.md`](../plans/260509_centralize_model_role_selection.md), [`260606_centralize-model-role-selection/`](../plans/260606_centralize-model-role-selection/), [`260513_capability_aware_tier_resolver.md`](../plans/260513_capability_aware_tier_resolver.md), [`260514_canonical_model_spec_string.md`](../plans/260514_canonical_model_spec_string.md).
- **Recommended models / smart picking:** [`260614_recommended-models-engine/`](../plans/260614_recommended-models-engine/), [`260614_recommended-models-followup/`](../plans/260614_recommended-models-followup/) (holds the `isManagedRouteUsable` + cost co-flip handoff Phase 3 must not miss), [`260531_prioritised-model-configs/`](../plans/260531_prioritised-model-configs/) (trios history), [`260615_automation-model-tier-and-backoff/`](../plans/260615_automation-model-tier-and-backoff/).
- **Mindstone / managed / tiers:** [`260428_subscription_tiers.md`](../plans/260428_subscription_tiers.md), [`260428_openrouter_managed_subscription.md`](../plans/260428_openrouter_managed_subscription.md), [`260521_rename_managed_tiers_pro_dash_expert_rogue.md`](../plans/260521_rename_managed_tiers_pro_dash_expert_rogue.md), [`260613_managed-models-visibility/`](../plans/260613_managed-models-visibility/), [`260314_mindstone_managed_cloud.md`](../plans/260314_mindstone_managed_cloud.md).
- **Settings / UI IA:** [`260510_models_settings_ia_simplification.md`](../plans/260510_models_settings_ia_simplification.md), [`260511_add_model_dialog_redesign.md`](../plans/260511_add_model_dialog_redesign.md), [`260401_conversation_model_selector_slider_redesign.md`](../plans/260401_conversation_model_selector_slider_redesign.md), [`260612_add-model-search/`](../plans/260612_add-model-search/).
- **OpenRouter / cross-provider:** [`260324_openrouter_integration.md`](../plans/260324_openrouter_integration.md), [`260416_cross_provider_model_mixing.md`](../plans/260416_cross_provider_model_mixing.md), [`260417_cross_provider_model_visibility.md`](../plans/260417_cross_provider_model_visibility.md), [`260511_openrouter_provider_rotation.md`](../plans/260511_openrouter_provider_rotation.md).
- **Error architecture:** [`260611_provider_error_architecture/`](../plans/260611_provider_error_architecture/) ⭐ — **PARKED, but it's the Phase-2 telemetry/error-taxonomy decision dependency (see §8 #1 + §9 Step 0)**; [`260611_provider-error-redesign/`](../plans/260611_provider-error-redesign/), [`260616_surface-provider-error-message/`](../plans/260616_surface-provider-error-message/), [`260617_coppel-gateway-preservation/`](../plans/260617_coppel-gateway-preservation/).

### Postmortems (the evidence base — `docs-private/postmortems/`)
Most load-bearing for direction: `260611_rate_limit_alt_model_terminal_generic_copy`, `260616_chatgpt_reconnect_codex_anthropic_stranding` (FOX-3494), `260602_mindstone_managed_key_injection_gap`, `260529_bts_model_choice_storage_prefix_wire_leak`, `260607_provider_error_misclassification_403_billing`, `260608_subagent_route_table_body_model_divergence`, `260610_image_input_unsupported_by_model`, `260616_bts_sampling_forbidden_opus48`. The prevention-recommendation index (`npm run regenerate:postmortem-recommendations`) and [PROJECT_OVERRIDES2 § Recommendation Drain](./PROJECT_OVERRIDES2.md#recommendation-drain-action-gap) are how these recs get drained.

### Territory hubs & evergreen docs
- [MODEL_AND_PROVIDER_OVERVIEW](./MODEL_AND_PROVIDER_OVERVIEW.md) ⭐ — how it works **today** (this doc's companion). Start there for the request journey + tombstones.
- [SMART_MODEL_PICKING](./SMART_MODEL_PICKING.md) ⭐ — the picker intent hub (goals G1–G7, tensions T1–T6).
- [NEW_PROVIDER_SUPPORT_PROCESS](./NEW_PROVIDER_SUPPORT_PROCESS.md) — adding a provider (archetypes, the ~40-file scatter).
- [PROVIDER_RESOLUTION_AND_ROUTING](./PROVIDER_RESOLUTION_AND_ROUTING.md), [MODEL_ROLES_AND_THINKING](./MODEL_ROLES_AND_THINKING.md), [MODEL_REGISTRIES](./MODEL_REGISTRIES.md), [MODEL_SETTINGS_RESOLUTION](./MODEL_SETTINGS_RESOLUTION.md).
- [BILLING_AND_SUBSCRIPTION_TIERS](./BILLING_AND_SUBSCRIPTION_TIERS.md), [MANAGED_PROVIDER_LIFECYCLE](./MANAGED_PROVIDER_LIFECYCLE.md), [COST_TRACKING](./COST_TRACKING.md), [TESTING_EVALS_KNOWLEDGE_WORK_COSTS](./TESTING_EVALS_KNOWLEDGE_WORK_COSTS.md).
- [ERROR_CLASSIFICATION_AND_ROUTING](./ERROR_CLASSIFICATION_AND_ROUTING.md), [PROVIDER_REQUEST_PARAM_MATRIX](./PROVIDER_REQUEST_PARAM_MATRIX.md).

### Code spine
- `src/shared/data/modelCatalog.ts` — the facts-as-data catalog (R3).
- `src/core/rebelCore/providerRouting.ts` + `providerRouteDecision.ts` — route materializer; the single-`activeProvider` constraint lives here.
- `src/core/rebelCore/planningMode.ts` + `rebelCoreQuery.ts` (`compileStepRoutes`) — where picking is decided today (plan-mode).
- `src/shared/utils/credentialResolution.ts` (`resolveCredentialsForProfile`) — the E2a credential chokepoint.
- `src/main/services/localModelProxyServer.ts` (`isManagedMode`) — the managed/billing gate (Phase 3 relaxation target).
- `src/core/modelRecommendation/` — the recommendation engine.
- `src/shared/types/managedProvider.ts` (`isManagedRouteUsable`) + `src/shared/utils/billingSource.ts` (`resolveBillingSourceForModel`) — the co-flip pair.

### Research
- [`docs/research/260614_model_routing_industry_research.md`](../research/260614_model_routing_industry_research.md) — how comparable products (OpenRouter, LiteLLM, Vercel, Continue, Aider, Goose, Not Diamond) architect routing/failover/cost.
