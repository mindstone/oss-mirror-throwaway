---
role: implementer
stage: 4
workflow: chief_engineer_v2
session_id: ea88c913-fb9d-4bc6-9fb4-8b451ee09f9e
planning_doc: PLAN.md
model: claude-opus-4-8
confidence: 92
---

# Stage 4 — One-shot materialization (kill the same-request double-derive)

## Summary

Pure dedup. The provider route decision was computed **twice** from one request: once
inside `resolveProviderRoutePlan` (via `decisionForRequest` → `ProviderRouter.forTurn`)
to materialize the plan, and a **second time** via a separate `ProviderRouter.forTurn`
call whose only job was to seed `runtimeContext`. Now the decision is computed exactly
once and threaded to the context builder.

## Threading approach

`resolveProviderRoutePlan`'s second parameter accepts a new union
`ProviderRoutePlanRuntimeContextInput = ProviderRouteRuntimeContext | ((decision) => ProviderRouteRuntimeContext)`.
The function form lets the caller derive the runtime context from the **same**
`ProviderRouteDecision` the plan is materialized from. Internally the function computes
the decision once (`decisionForRequest(request)`) and, if a builder function was passed,
invokes it with that decision; static-object callers are unchanged (backward-compatible).

`materializePlanRuntime` returns `plan.decision === decision` (the same instance), so the
plan and its runtime context are provably materialized from one decision instance.

Both executor call sites were switched to the function form:
- **Preflight** (`agentTurnExecute.ts` ~3739): `(decision) => preflightRuntimeContextForDecision(decision, routeProfile)` — removed the `ProviderRouter.forTurn(preflightRouteInput)` arg.
- **Runtime** (`agentTurnExecute.ts` ~4239): passed `routeRuntimeContextForDecision` directly — removed the conditional `ProviderRouter.forTurn(routeInput, ...)` / `ProviderRouter.forTurn(routeInput)` block. The request already carries the identical `fallback` options, so `decisionForRequest` reproduces the identical decision (incl. fallback rebuild) once.

The now-unused `ProviderRouter` import was dropped from `agentTurnExecute.ts`.

## Call-count: before → after

Per single request (preflight or runtime path): **2 → 1** derivations of `routeDecision`.
- Before: `resolveProviderRoutePlan` ran `decisionForRequest` (1) + the executor ran a
  separate `ProviderRouter.forTurn` (2).
- After: only the internal `decisionForRequest` runs (1); the context builder receives
  that same decision instance.

New test `providerRouting.oneShotMaterialization.test.ts` pins this:
1. the decision-derived context builder is invoked exactly **once** per request;
2. the decision the builder receives is the **same instance** (`plan.decision === received`) the plan is materialized from;
3. the static-object form still works (backward-compat for clientFactory/useCaseGenerator/promptCacheWarmup callers).

## Ambient side-effect check (the flagged risk)

`ProviderRouter.forTurn` → `routeDecision`, which is a pure function except:
- `sanitizeStaleProfileReference` (providerRouting.ts:411) — on a stale/missing profile
  reference it emits `log.warn(...)` AND `captureKnownCondition('bts_profile_missing', ...)`
  (Sentry telemetry).
- `selectProviderMode` (providerRouting.ts:166) — reads `getManagedKeyAvailability()` (a
  secure-storage read, not a side-effect).

**Verdict: no UNIQUE side-effect was produced by the removed second call.** Both the
first call (inside `resolveProviderRoutePlan`) and the removed second call ran on the
**identical input** through the **same `routeDecision` code path**, so they produced
**identical** diagnostics. Removing the second call yields *fewer duplicate* diagnostics
(stale-profile warn + Sentry capture fire **once** instead of twice; `getManagedKeyAvailability`
resolves once instead of twice) — exactly what PLAN.md anticipates ("expect fewer
duplicate diagnostics, not zero"). Nothing observes the second derivation independently
of the first; the second call's output was used **only** to build `runtimeContext`. No
STOP condition.

## Validation (verbatim)

- `npm run lint:ts` → exit 0 (`tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.renderer.json --noEmit`, no output).
- `npx vitest run --project=desktop` routing suites (providerRouting, snapshots, parityMatrix, invariants, providerRouteDecision, clientFactory.routePlan, routeEligibility, oneShotMaterialization, rebel655 repro): **9 files, 406 passed | 1 skipped**. **Snapshots/parity unchanged** (no snapshot writes/updates) — the behaviour-identical proof.
- `npx vitest run --project=desktop` executor integration (runtimeRouting, routePlanBroadcast, authTagging, authErrorDispatch, fallbacks, codexSubscription, availableModels, buildQueryOptions): **8 files, 60 passed**.

## Scope flags

- **In scope, done:** `resolveProviderRoutePlan` + the two executor call sites. `decisionForRequest` unchanged (the dedup is achieved by threading the single decision through the context builder, no signature change needed there).
- **Out of scope (flagged, NOT touched):** `settingsHandlers.ts:2150` (`settings:test-model-choice`) still double-derives — it calls `ProviderRouter.forTurn(routeInput.input)` separately then passes `{kind:'forTurn', input: routeInput.input}` to `resolveProviderRoutePlan`. This is GPT's "settings-inline-test" double-derive but is the **third** call site, outside the packet's binding scope ("resolveProviderRoutePlan/decisionForRequest + the two executor call sites"). The backward-compatible signature means it compiles and behaves identically; converting it to `(decision) => runtimeContextForTestDecision(settings, decision)` is a trivial follow-up if desired. Did not balloon scope to include it.
- The other 3 `resolveProviderRoutePlan` callers (clientFactory, useCaseGenerator, promptCacheWarmup) do **not** double-derive — they pass static request-level context — so they need no change.

## Confidence: 92

High confidence this is a clean, behaviour-identical dedup: the threaded decision is
provably the same instance materialized into the plan (test-pinned `===`), all snapshots/
parity are byte-identical, and the ambient side-effects are duplicates (fewer, not lost).
Residual: the settingsHandlers third site remains a double-derive (out of scope, flagged).
