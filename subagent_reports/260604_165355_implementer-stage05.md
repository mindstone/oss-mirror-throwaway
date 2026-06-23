---
workflow: chief_engineer_v2
session_id: ea88c913-fb9d-4bc6-9fb4-8b451ee09f9e
role: implementer
stage: 5
implementer_model: claude-opus-4-8
report_type: implementer
planning_doc: PLAN.md
created_at: 2026-06-04T16:53:55Z
---

# Stage 5 Implementer Report — Lint guard + completion cleanups

## Summary

Stage 5 (final stage) of `260604_routing-ssot-divergence`. **Task 1 (PRIMARY) DONE**, **Task 3 DONE**, **Task 2 DEFERRED** (non-trivial, per packet STOP-and-report instruction). Confidence **88/100**.

## Task 1 (PRIMARY) — the lint guard

**Form: eslint `no-restricted-syntax` AST selector** (the AST expressed the rule precisely — no `validate:fast` guard script needed, contrary to the packet's fallback contingency).

### The rule
`planningSentinelGuardSelectors` in `eslint.config.mjs`:
```
selector: "CallExpression[callee.name=/^(resolveModelConfig|resolvePlanModeTarget|planModeTargetFromThinkingModel)$/] Identifier[name='PREFERRED_PLANNING_MODEL']"
```
Flags `PREFERRED_PLANNING_MODEL` appearing as **any descendant argument** of a model-resolution call (`resolveModelConfig`, `resolvePlanModeTarget`, `planModeTargetFromThinkingModel`) — the killed sentinel-as-mode-trigger pattern from REBEL-655.

- **Descendant (space) combinator, not direct-child (`>`):** the killed shape was `resolveModelConfig(model, thinkingProfile ? PREFERRED_PLANNING_MODEL : null, ...)` — the sentinel sits inside a `ConditionalExpression`, so `>` missed it (verified: `>` gave 0 hits on the violation fixture). The space combinator catches it. The callee Identifier can never false-match because its `name` is constrained to the three resolution-function names, which `PREFERRED_PLANNING_MODEL` is not.
- **Does NOT flag legitimate fallback-VALUE uses** (the packet's hard constraint): auth-failure fallback (`decodeTurnRoutingModelOrThrow(PREFERRED_PLANNING_MODEL, ...)` + `to: PREFERRED_PLANNING_MODEL` registry log at agentTurnExecute.ts:3843/3856), 1M downgrade / comparison (`baseModel !== PREFERRED_PLANNING_MODEL`), council lead, hero choice (`return PREFERRED_PLANNING_MODEL`), settings-store/UI seed (`{ model: PREFERRED_PLANNING_MODEL }`). Verified: linting all 6 real files that reference the constant → **0 planning-sentinel hits**.
- **Postmortem referenced** in the rule message (`260603_plan_mode_synthetic_claude_planning_sentinel_creds_postmortem.md`, REBEL-655; family REBEL-538/540). Per-line escape: `// eslint-disable-next-line no-restricted-syntax -- planning-sentinel-justified: <reason>`.

### Wiring (flat-config last-block-wins subtlety)
The substitution site `src/core/services/turnPipeline/agentTurnExecute.ts` is authoritatively covered by the block at eslint.config.mjs:~1838 (it lists exact filenames + `__lint_fixtures__/**`), whose `no-restricted-syntax` spreads `meetingEmitBaseRestrictedSelectors + restrictedSelectors + turnPolicyRefactorFenceSelectors`. Appending only to `providerRoutingTypeSafetySelectors` would NOT have reached this file (the later `src/core/**` blocks at :3024/:3062 set only type-aware rules, not `no-restricted-syntax`, so block-1838 stays authoritative). Therefore wired in **two places**:
1. `planningSentinelGuardSelectors` appended to block-1838's `no-restricted-syntax` array (covers the executor — the real substitution site).
2. An equivalent selector appended to `providerRoutingTypeSafetySelectors` (covers the routing-engine files providerRouting.ts / clientFactory.ts / behindTheScenesClient.ts and the broad routing blocks).

### Fixture test
`src/core/services/turnPipeline/__tests__/planningSentinelLintFixtures.test.ts` (precedent: `providerFeatureGateLintFixtures.test.ts`). Shells out to the ESLint CLI (`--no-ignore`) over 3 on-disk fixtures under `__lint_fixtures__/planningSentinel/` (a path already in block-1838's `files`, so the production rule runs verbatim — no `--rule` injection). Used the CLI-subprocess path rather than `ESLint.lintText` because the type-aware `no-misused-promises` rule crashes on synthetic top-level code.
- `resolveModelConfigViolation.fixture.ts` (sentinel in a `?:` into `resolveModelConfig`) → errors. ✅
- `planModeTargetViolation.fixture.ts` (sentinel into `planModeTargetFromThinkingModel`) → errors. ✅
- `sanctionedFallback.fixture.ts` (decode/log/seed/compare/return) → 0 planning-sentinel errors. ✅
- 3/3 green.

Fixtures excluded from `tsconfig.node.json` (they are intentionally type-invalid — the sentinel is not assignable to `PlanModeTarget`), mirroring the existing `src/main/services/turnPipeline/__lint_fixtures__/**` exclusion.

## Task 2 — third double-derive (settingsHandlers.ts:~2150) — DEFERRED

`settings:test-model-choice` computes `ProviderRouter.forTurn(routeInput.input)` at :2150, then `resolveProviderRoutePlan` re-derives internally — the F1 third site. **Deferred per the packet's explicit "STOP and report if non-trivial / behaviour-affecting" instruction.**

Root of the difficulty: Stage 4's dedup API is a **synchronous** `(decision) => ProviderRouteRuntimeContext` builder. The executor (Stage 4) satisfies this because it reads the proxy URL synchronously (`proxyManager.getUrl()`). But the settings-test path's `runtimeContextForTestDecision` is **async** — it calls `proxyManager.getUrl() ?? await proxyManager.ensureRunningForBts()`, a decision-dependent on-demand proxy *start*. That async, decision-gated work cannot move into the synchronous builder. True single-derivation would require either (a) an async-builder API change to `resolveProviderRoutePlan` (rippling back to the executor's builder signature — out of scope), or (b) eager unconditional `ensureRunningForBts()` (starts the proxy even for direct-Anthropic dispatches — a behaviour change on a user-facing preview path).

**Harmlessness verified:** `ProviderRouter.forTurn` / `routeDecision` is a pure, deterministic, synchronous function of its input. The decision at :2150 and the one `resolveProviderRoutePlan` computes internally are derived from the *identical* `routeInput.input`, so they cannot diverge here — this is redundant computation, not the "two plans from one snapshot disagree" hazard. Left as a follow-up (smallest correct fix is the async-builder API change, best done as its own change).

## Task 3 — drop the benign `await` — DONE

`agentTurnExecute.ts:3751`: `createClientFromRoutePlan` returns `ModelClient` (synchronous, clientFactory.ts:387-391), so the `await` was a no-op (TS 80007). Dropped. The call sits inside a `try/catch` whose `unavailable` arm carries the original error; a synchronous function still throws synchronously into the same catch, so error semantics are byte-identical. Behaviour-preserving.

## Validation (verbatim)

- `npm run lint:ts` → **exit 0** (`tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.renderer.json --noEmit`).
- eslint over the 6 real files referencing `PREFERRED_PLANNING_MODEL` → **0 planning-sentinel hits** (rule is green; banned pattern absent in current code, as Stage 1 removed it).
- `npx vitest run planningSentinelLintFixtures.test.ts` → **3 passed**.
- `npx vitest run --project=desktop` routing suites (providerRouting, snapshots, parityMatrix, invariants, clientFactory.routePlan, rebel655 repro, modelNormalization) → **287 passed | 1 skipped**.
- `npx vitest run --project=desktop` settingsHandlers + routeEligibility + executor runtimeRouting/routePlanBroadcast/fallbacks/authErrorDispatch → **88 passed**.
- Sibling lint-fixture tests (providerFeatureGate, turnPipelineLint, modelsNamespace) → **28 passed** (no eslint config regression).
- Snapshots/parity unchanged (Tasks 2/3 behaviour-preserving; Task 2 untouched).

## Scope flags

- **Task 2 deferred** (above) — non-trivial async-builder mismatch; flagged not silently dropped.
- **PRE-EXISTING DEV-RED (NOT Stage 5):** `npm run lint` has **1 error** at `src/core/rebelCore/__tests__/routeEligibility.test.ts:28` — `bts-flow-shape/no-model-brand-casts` on `(value) as RoutingModelId`. Confirmed pre-existing: introduced by **Stage 3 commit `829cf2dea`**, present with my changes stashed, and not in any Stage 5 path. It blocks full `npm run lint` green. Out of my mandate ("Stage 5 paths only / do not touch unrelated surfaces"); needs a Stage 3 fix-forward (sanctioned per-line override or route through `decodeRoutingModelId`). Flagging for the Chief to route.

## Confidence: 88/100
Deductions: Task 2 deferred (the packet anticipated this as possible); the pre-existing Stage-3 lint error means `npm run lint` is not fully green at HEAD (independent of Stage 5). The Stage 5 deliverables themselves (rule + fixtures + Task 3) are high-confidence and fully verified.
