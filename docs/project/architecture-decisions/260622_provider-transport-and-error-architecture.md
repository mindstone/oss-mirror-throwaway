---
description: Widen workstream "C" from provider-error → provider transport + error architecture — transport hygiene + per-transport ownership. Status decided; rebuild deferred behind Phase 2.
last_updated: 2026-06-22
---

# Provider Transport + Error Architecture — widening "C"

Records the decision to widen workstream "C" (`docs/plans/260611_provider_error_architecture/`) from *"provider-error architecture"* to *"provider **transport** + error architecture"*, bringing **transport hygiene** and **per-transport ownership** into "C"'s scope.

**Status: decided; rebuild deferred behind Phase 2.** This ADR settles *scope and commitment*, not a build. The actual transport rearchitecture rides on top of the multi-provider chain (Phase 2 of [`MULTIPROVIDER_ROADMAP.md`](../../plans/260614_smart-model-routing/MULTIPROVIDER_ROADMAP.md)) — "after the multi-provider chain exists and makes it cheaper + provably-shaped." Nothing here authorises a rebuild in the current run.

## Context

The trigger is concrete. The `260619_turn-hang-hardening` run tried to add a first-byte ceiling to Anthropic requests; heavy review (reading the actual `@anthropic-ai/sdk` source) showed it **couldn't be scoped to Anthropic-direct cleanly**, because the **Anthropic SDK is the shared in-process client for non-Anthropic proxy traffic** (Codex/OpenRouter routes in `src/core/rebelCore/clientFactory.ts`). So the SDK's retry / timeout / error-classification semantics govern Codex/OpenRouter proxy traffic, and a thrown timeout was re-wrapped by the SDK into a non-retryable error. Stage 1 was dropped (see [`260619_turn-hang-hardening/PLAN.md`](../../plans/260619_turn-hang-hardening/PLAN.md)) and reframed as the proposal [`260620_transport-hygiene-and-ir-convergence/PLAN.md`](../../plans/260620_transport-hygiene-and-ir-convergence/PLAN.md).

That proposal floated as DIRECTION open-question #13, but the workstream it would fold into ("C") was parked and scoped to **routing / recovery / error-kind**, not the **transport / SDK** layer — so the policy stayed proposed-but-uncommitted. This ADR closes that gap: it makes the transport layer committed scope of "C".

## Decision

1. **Widen "C".** Rename the effort in spirit from *provider-error architecture* → *provider **transport** + error architecture*. The error-taxonomy / recovery / classification work ("B" already shipped; "C"'s recovery-keyed-by-error-kind-×-capability still parked) stays in scope; transport ownership is **added**.

2. **Adopt the transport-hygiene policy (verbatim, from `260620` §4(A)):**
   > **The Anthropic SDK is allowed only for `anthropic-direct`. Anthropic-compatible proxy/provider routes may still speak the Anthropic Messages format, but should use a Rebel-owned fetch/SSE transport so retries, timeouts, and error classification are Rebel/provider-owned.**

3. **Per-transport ownership.** Each provider route owns its own fetch/SSE, **retry policy**, **timeout budget**, **first-byte / stream lifecycle**, and **error normalization** — rather than inheriting them from the shared Anthropic SDK.

4. **Format vs transport — keep the format, drop the SDK.** "Anthropic Messages" is two separable things: the wire **format** (a fine internal lingua franca / what our local proxy speaks) and the Anthropic **SDK transport** (the client that owns retries, timeouts, error-typing). This decision is only about the *transport*: keep speaking the Anthropic *format* to the proxy; stop using the Anthropic *SDK* as the pipe for non-Anthropic routes.

5. **Gemini `thought_signature` proxy is an explicit non-exception.** The proxying need is real, but it is **not** an argument for Anthropic-SDK reuse — keep the proxy where needed; change the *client transport* that calls it.

6. **The policy is falsifiable.** The Stage-2 characterization tests (`src/core/rebelCore/__tests__/clientFactory.transportConformance.test.ts`) pin the *current* per-transport retry / timeout / error behaviour, so a future transport rebuild that silently changes those semantics is a visible test change rather than a quiet regression.

## Zombie decisions closed here

- **"One translation desk" / scoped-`RequestPlan` (S8 half-decision) — formally CLOSED.** It was marked "DECIDED — yes" in the May S-series, then re-opened/narrowed in June to "do it incrementally, escalate only with sign-off," and never built. It is **closed**, not parked: revisit *only* when the feature-divergence heuristic fires (DIRECTION §8 #9 / `260620` §4(B)). The grand `RequestPlan`/`ProviderTarget` god-object stays **rejected**.
- **`resolvedModelCapabilities` read-model — already deleted in code; nothing to wire.** The capability read-model that supported the "one translation desk" half-decision was the dead, no-production-caller `src/core/rebelCore/resolvedModelCapabilities.ts`. It was **deleted** (`5763d35d5f`, "WS2a — delete the orphaned resolvedModelCapabilities read-model"), so the close-vs-wire question resolves to **close**: the corpus just catches up to the code (the lagging DIRECTION code-spine reference was removed alongside this ADR).

## References

- [`docs/plans/260620_transport-hygiene-and-ir-convergence/PLAN.md`](../../plans/260620_transport-hygiene-and-ir-convergence/PLAN.md) — the proposal this ADR settles (the trigger, the format-vs-transport distinction, the verbatim §4(A) policy).
- [`docs/plans/260611_provider_error_architecture/PLAN.md`](../../plans/260611_provider_error_architecture/PLAN.md) — the (now widened) "C" effort. Still **PARKED** for the rebuild; only its scope/commitment is settled here.
- [MODEL_AND_PROVIDER_DIRECTION § open-question #13](../MODEL_AND_PROVIDER_DIRECTION.md) — the DECIDED entry that points here.
- [`docs/plans/260507_provider_architecture_consolidation_chief_engineer.md`](../../plans/260507_provider_architecture_consolidation_chief_engineer.md) — prior art to harvest (splits wire protocols but keeps the Anthropic SDK as the universal in-process client — helps only partially).
- [`docs/plans/260619_turn-hang-hardening/PLAN.md`](../../plans/260619_turn-hang-hardening/PLAN.md) — where the first-byte ceiling was dropped (the trigger).
- Code spine: `src/core/rebelCore/clientFactory.ts` (`createClientFromRoutePlan` — the per-transport switch on `ProviderRouteDecision.transport`).
