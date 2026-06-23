---
workflow: chief_engineer_v2
role: implementer
stage: 3
model: claude-opus-4-8
session-id: ea88c913-fb9d-4bc6-9fb4-8b451ee09f9e
planning-doc: docs/plans/260604_routing-ssot-divergence/PLAN.md
review-mode: heavy
---

# Stage 3 — Typed model-eligibility authority over route decisions

## Summary

Landed a typed eligibility **authority** that is a PURE view over the route
decision the engine already computes. New module
`src/core/rebelCore/routeEligibility.ts` exports exactly the two single-now
functions the packet specified, plus the result/context/candidate types. No
second/third resolver and no list-taking resolver introduced. Consumer wiring
is **deferred** (see below) — authority + tests landed, per the packet's
"stop and report if more than a thin guard" instruction.

## Authority API

```ts
type EligibilitySource =
  | 'credentials' | 'provider' | 'rate-limit' | 'subscription' | 'profile' | 'route';

type ModelEligibilityResult =
  | { kind: 'eligible'; routePlan: DispatchableRouteDecision }
  | { kind: 'ineligible'; reason: string; source: EligibilitySource; retryAfter?: number };

interface ModelCandidate { model: RoutingModelId; role: ProviderRouteRole }   // C6: branded id

interface RouteEligibilityContext {
  settings: ProviderRouteSettings;
  activeProvider?: ActiveProvider;
  connectedProviders?: readonly ActiveProvider[];   // INERT (F1/C2) — carried, never read in the verdict
  codexConnectivity?: CodexConnectivity;
  hasManagedKey?: boolean;                           // forwarded so selectProviderMode (invariant #3) sees it
}

function eligibilityFromDecision(decision: ProviderRouteDecision): ModelEligibilityResult  // PURE mapper
function eligible(candidate: ModelCandidate, ctx: RouteEligibilityContext): ModelEligibilityResult
```

- `eligibilityFromDecision` is the pure projection: `dispatchable` → `eligible`
  (carries the decision as `routePlan`), `terminal` → `ineligible` with
  `source` a pure total function of `invalidReason`, `reason` taken from the
  existing `buildTerminalReconnectMessage` for recoverable reasons (raw code for
  the non-recoverable `proxy-dialect-in-direct-anthropic`).
- `eligible` obtains EXACTLY ONE `ProviderRouteDecision` by delegating to the
  existing public chokepoint (`ProviderRouter.forTurn`/`forBTS`/`forSubagent`
  by role) — which itself owns `selectProviderMode`/`getManagedKeyAvailability`
  (invariant #3, never reimplemented or double-invoked) — then maps via
  `eligibilityFromDecision`. It computes no fact `routeDecision` doesn't already
  compute. `connectedProviders` is read off `ctx` only to carry the future
  shape; it never influences the verdict (proven by the INERT test).
- `retryAfter?` is present in the type but always omitted (no backoff store).

## source mapping table (exhaustive, by-construction)

A `Record<ProviderRouteInvalidReason, EligibilitySource>` PLUS a paired
`switch`/`assertNever` — adding a new invalid reason is a compile error in BOTH
until mapped.

| `ProviderRouteInvalidReason`        | `source`       |
|-------------------------------------|----------------|
| `missing-anthropic-credentials`     | `credentials`  |
| `missing-openrouter-credentials`    | `credentials`  |
| `missing-mindstone-credentials`     | `subscription` |
| `missing-codex-connection`          | `provider`     |
| `codex-disconnected-bts-blocked`    | `provider`     |
| `codex-unsupported-model`           | `route`        |
| `proxy-dialect-in-direct-anthropic` | `route`        |
| `missing-profile-credentials`       | `profile`      |

(`rate-limit` exists in the source union for the future shape but is unmapped
today — no `invalidReason` arm produces it, which is correct: there is no
backoff store yet.)

## Consumer wiring — DEFERRED (why)

Deferred to a closer/later stage. The terminal-decision surface is ALREADY a
typed chokepoint in production: `clientFactory.ts:567` and `agentTool.ts:1331`
branch on `isTerminalRoutePlan(plan)` and surface
`buildTerminalReconnectMessage`. An unservable auxiliary-role model already
fails there today. Wiring `eligible()`/`eligibilityFromDecision()` as a real
consumer would require one of:
  - a redundant parallel call alongside the existing `isTerminalRoutePlan`
    branches (same fact, zero behaviour change, pure noise), or
  - replacing the existing terminal-plan handling with the eligibility result,
    which touches the runtime `ProviderRoutePlan` path, the reconnect-message
    plumbing, and multiple call sites.

The second is more than a thin additive guard and risks behaviour drift on the
existing servable/terminal paths — exactly the scope the packet says to STOP on.
The REBEL-538 symmetric surface (BTS `fast` + subagent unservable-Claude-under-
Codex) is fully covered at the authority level by tests, as the packet permits.

## F1 fold-in (Stage 1+2 review)

Tightened the plan-mode-target mocks in
`agentTurnExecutor.testHarness.ts` (`resolvePlanModeTarget` and
`planModeTargetFromThinkingModel`) to mirror production: both now route the
resolved thinking model through a `decodeRoutingModelIdLike` helper that strips
`model:`, passes bare ids, and REJECTS `profile:*` (returns null) — matching the
real `decodeRoutingModelId` gate in `modelNormalization.planModeTargetFromThinkingModel`.
Previously the mocks returned `{ thinkingModel: trimmed }` directly, accepting
`profile:*` that production rejects.

## Validation (verbatim)

- `npm run lint:ts` → exit 0 (`tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.renderer.json --noEmit`, no output).
- `npx vitest run --project=desktop routeEligibility providerRouteDecision providerResolution.parityMatrix providerRouting subAgentRouting`
  → `Test Files 11 passed (11) | Tests 459 passed | 1 skipped (460)`.
- `npx vitest run --project=desktop providerRouting.snapshots routeEligibility`
  → `Test Files 2 passed (2) | Tests 88 passed (88)` — snapshots unchanged (no obsolete/written).
- `npx vitest run --project=desktop agentTurnExecutor routeEligibility`
  → `Test Files 24 passed (24) | Tests 235 passed (235)` (covers the F1 mock fold-in).

Tests added (`__tests__/routeEligibility.test.ts`):
- **F6 KILL contract:** Codex active + Claude thinking model + no Anthropic key →
  `{ kind:'ineligible', source:'credentials', reason:/Anthropic/ }`, NOT eligible.
- **Exhaustive source mapping:** table-driven over all 8 `ProviderRouteInvalidReason`
  arms; the `EXPECTED_SOURCE` Record is keyed by the union so a new reason fails to compile.
- **REBEL-538 symmetric surface:** BTS `fast` + subagent unservable Claude under Codex → ineligible/credentials.
- **connectedProviders INERT:** adding `['anthropic','codex']` does not change the kill verdict.
- **Behaviour-preserving servable cases:** Anthropic+key→eligible; Codex+supported model→eligible.
- dispatchable → eligible carrying the route plan by reference.

## Invariants

- #3 Mindstone: delegates to `selectProviderMode` (owns `getManagedKeyAvailability`); never reimplemented/double-invoked. `hasManagedKey` forwarded.
- #6 decision-type semantics unchanged: `isDispatchableDecision`/`isTerminalDecision`/`buildTerminalReconnectMessage` untouched; the view is purely additive.
- No behaviour change for any servable case (the authority only re-expresses already-failing unservable cases as typed results; not yet wired into production).

## Scope flags

- Consumer wiring deferred (justified above) — recommend a closer decides whether
  the future prioritised-model-config feature needs the chokepoint rewired, or whether
  the existing `isTerminalRoutePlan` surface stays canonical and `eligible()` is the
  programmatic/UX query API.
- `rate-limit` source + `retryAfter?` are future-shape only (no backoff store) — intentional, OUT of scope.
- Did NOT touch Stage 4 (double-derive) or Stage 5 (lint).

## Confidence: 88/100

Authority is small, pure, fully type-gated (exhaustive Record + assertNever), and
green across the routing/executor suites including the F6 kill test. The −12 is
entirely the deferred consumer wiring: the authority is correct and tested, but it
is not yet load-bearing in any production path, so its real-world value depends on
the closer's wiring decision.
