---
description: "Current code health baselines and counts. Update this file whenever baselines change."
last_updated: 2026-06-14
---

# Code Health Status

Current snapshot of code health baselines. For tooling details, workflows, and how to run sweeps, see [CODE_HEALTH_TOOLS](CODE_HEALTH_TOOLS.md).

## Baselines (enforced in `validate:fast`)

| Metric | Baseline | Script |
|--------|----------|--------|
| ESLint errors | 0 | `npm run lint` |
| ESLint warnings (preflight cap) | `--max-warnings 3000` sanity cap (also the mass-regression backstop for `rebel-silent-swallow/no-silent-swallow` — never ratchet DOWN) | `npm run lint` |
| ESLint warnings — `no-unused-vars` | 63 | `scripts/check-eslint-warnings.ts` |
| ESLint warnings — `no-explicit-any` | 71 | `scripts/check-eslint-warnings.ts` |
| ESLint warnings — `no-non-null-assertion` | 31 | `scripts/check-eslint-warnings.ts` |
| ESLint warnings — `no-use-before-define` | 24 | `scripts/check-eslint-warnings.ts` |
| ESLint warnings — `naming-convention` | 15 | `scripts/check-eslint-warnings.ts` |
| ESLint warnings — `no-console` | 0 | `scripts/check-eslint-warnings.ts` |
| ESLint warnings — `no-empty` | 0 (promoted to error 260525) | `scripts/check-eslint-warnings.ts` (backstop), `eslint.config.mjs` |
| ESLint rules promoted to error (zero-tolerance) | `react-hooks/exhaustive-deps`, `react-hooks/rules-of-hooks`, `no-restricted-syntax` (incl. `sdkExtractorGuardSelectors`, `nativeBindingImportGuardSelectors`), `no-restricted-properties` (incl. `nodeEngineFloorGuardEntries`), `no-empty` (`allowEmptyCatch: false`, src/** only), `@typescript-eslint/switch-exhaustiveness-check` (DI-22, src/main/** + src/core/** + cloud-service/src/**), `@typescript-eslint/no-misused-promises` (DI-24), `@typescript-eslint/await-thenable` (DI-25), `bts-flow-shape/no-model-error-catch-clobber` (custom rule) | `npm run lint` |
| Startup IPC ordering (no late `ipcMain.handle`) | 0 late registrations | `scripts/check-startup-ipc-ordering.ts` |
| SDK extractor guard (no direct `.message.content` outside extractor) | 0 violations (scoped to SDK boundary files) | `eslint.config.mjs` → `sdkExtractorGuardSelectors` |
| Node engine-floor guard (no `fs.globSync` / `fs.promises.glob` while `engines.node` is `>=20`) | 0 violations | `eslint.config.mjs` → `nodeEngineFloorGuardEntries` |
| Native-binding ESM import guard (no `await import('@lancedb/lancedb' \| '@huggingface/transformers')` in main-process / worker code) | 0 violations (1 inline-disable in `src/main/gpu-worker/renderer.ts` for the renderer-context exemption) | `eslint.config.mjs` → `nativeBindingImportGuardSelectors` |
| Node TS errors | 0 | `scripts/check-typescript-errors.ts` |
| Renderer TS errors | 0 | `scripts/check-typescript-errors.ts` |
| Evals TS errors | 0 | `scripts/check-typescript-errors.ts` |
| Cloud-service TS errors | 0 | `scripts/check-typescript-errors.ts` |
| Cloud-service-test TS errors | 0 | `scripts/check-typescript-errors.ts` |
| Cloud-client TS errors | 0 | `scripts/check-typescript-errors.ts` |
| Cloud-client-test TS errors | 0 | `scripts/check-typescript-errors.ts` |
| Web-companion TS errors | 0 | `scripts/check-typescript-errors.ts` |
| Web-companion-test TS errors | 0 | `scripts/check-typescript-errors.ts` |
| Packages-shared TS errors | 0 | `scripts/check-typescript-errors.ts` |
| Browser-extension TS errors | 0 | `scripts/check-typescript-errors.ts` |
| Mobile TS errors | 0 | `scripts/check-typescript-errors.ts` |
| Unresolved-module (TS2307) errors | not baseline-able — **hard fail** (2026-06-14) | `scripts/check-typescript-errors.ts` |
| Renderer circular deps | 0 | `scripts/check-circular-deps.ts` |
| Main circular deps | 0 | `scripts/check-circular-deps.ts` |
| Knip unused files | 0 | `scripts/check-knip-health.ts` |
| `as any` casts | 69 | `scripts/check-escape-hatches.ts` |
| `@ts-ignore` / `@ts-expect-error` | 5 | `scripts/check-escape-hatches.ts` |
| `eslint-disable` | 261 | `scripts/check-escape-hatches.ts` (`ESLINT_DISABLE_BASELINE`) |
| ESLint warnings — `rebel-silent-swallow/no-silent-swallow` | _no count baseline_ — diff-scoped (`validate:eslint-new-warnings`) + `--max-warnings 3000` cap backstop + rule-presence smoke | `docs/plans/260612_silent-swallow-gate/PLAN.md` (Stage 3) |
| ESLint warnings — `rebel-switch-exhaustiveness/no-bare-default-bypass` | 0 (promoted to error, DI-22) | `scripts/check-eslint-warnings.ts` (backstop) |
| ESLint warnings — `@typescript-eslint/switch-exhaustiveness-check` | 0 (promoted to error, DI-22) | `scripts/check-eslint-warnings.ts` (backstop) |
| `z.any()` in IPC schemas | 7 | `scripts/check-ipc-schema-strictness.ts` |
| `z.unknown()` in IPC schemas | 31 | `scripts/check-ipc-schema-strictness.ts` |
| IPC handler parity | 0 uncontracted handlers (enforced) | `scripts/check-ipc-handler-parity.ts` |

> **Note:** TS error counts historically exhibited non-determinism between runs (~5-10% variance observed with TypeScript 6.0); baselines were set above the observed max to avoid false failures. As of 2026-05-08, all 12 TS surfaces are at baseline zero — actual count must equal baseline, eliminating flake. See the investigation in `docs-private/investigations/260329_ts_error_count_determinism.md` (if it exists).

## Bounded walker ratchet

`scripts/check-bounded-walker-recursion.ts` enforces the recursive-directory-walker ratchet from [`docs/plans/260503_s9_bounded_walker_resource_budget.md`](../plans/260503_s9_bounded_walker_resource_budget.md). New raw recursive `fs.readdir` / `fs.opendir` walkers fail `validate:fast`; annotated legacy walkers are warnings constrained by monotonic baselines.

- `BOUNDED_WALKER_PENDING_BASELINE`: 8
- `BOUNDED_WALKER_EXEMPT_BASELINE`: 0

Adding `bounded-walker-pending` or `bounded-walker-exempt` annotations requires PR review so the ratchet does not become decorative plumbing.

## Weekly review notes

### 2026-06-10 — weekly code-health pass

Mechanical baseline-lowering to match live counts measured on `dev` (slack recalibration only — no new violations absorbed).

**Baselines lowered:**

- `no-unused-vars`: 66 → 64
- ~~`rebel-silent-swallow/no-silent-swallow` (global): 2246 → 2238~~ — historical; **these count baselines were RETIRED 2026-06-12** (`docs/plans/260612_silent-swallow-gate/PLAN.md`, Stage 3). The rule is now diff-scoped (`validate:eslint-new-warnings`) + `--max-warnings 3000` cap + rule-presence smoke; there is no count to reconcile. Do not re-introduce a silent-swallow count baseline.
- ~~Silent-swallow per-surface: `src` 1968 → 1952, `cloud-service` 104 → 103, `cloud-client` 50 → 47, `mobile` 129 → 121 (`private` unchanged at 15)~~ — historical; per-surface count baselines retired with the global one (see above). The per-surface *parity* guard (every audited surface is classified covered/exempt) is kept; it has no count to drift.
- `rebel-switch-exhaustiveness/no-bare-default-bypass`: 10 → 0 (rule promoted to error in DI-22; warning backstop only)
- `@typescript-eslint/switch-exhaustiveness-check`: 28 → 0 (rule promoted to error in DI-22; warning backstop only)
- `z.unknown()` in IPC schemas: 32 → 31

**Escape-hatch baselines unchanged:** `as any` 69, `@ts-ignore` / `@ts-expect-error` 5, `eslint-disable` 261.

**Other gates (unchanged / noted):** circular deps 0/0 (renderer + main); all 12 TS surfaces at 0 errors; Knip unused-exports regression tracked separately (another agent). **npm audit:** 16 vulnerabilities (5 high) + 21 open Dependabot PRs — flagged for owner decision, not actioned in this pass.

## Milestones

| Date | Achievement |
|------|-------------|
| 2026-06-22 | **Weekly trend-debt ratchet-tighten.** `@typescript-eslint/no-non-null-assertion` baseline lowered 33 → 31 to lock in below-baseline drift-down (`scripts/check-eslint-warnings.ts`); no source changes — the actual count had already fallen to 31 from incidental cleanups elsewhere. |
| 2026-06-06 | **DI-25: `@typescript-eslint/await-thenable` promoted `warn` → `error`.** Cleared the 25 behaviour-preserving violations first (commit `de0aa912a`), then flipped the severity (commit `998609c79`). `await` on a non-thenable is now a build failure rather than a silent no-op. |
| 2026-06-06 | **DI-24: `@typescript-eslint/no-misused-promises` promoted `warn` → `error`.** Cleared the 34 violations first (commit `05fcb193c`), then flipped the severity (commit `152c9d116`). Passing a promise-returning function where a `void`/sync callback is expected (e.g. event handlers, `Array.prototype.filter`) now fails the build. |
| 2026-06-06 | **Custom rule `bts-flow-shape/no-model-error-catch-clobber` (error) + `reclassifyOrRethrow` helper.** New ESLint rule (`eslint-rules/no-model-error-catch-clobber.js`, wired in `eslint.config.mjs`) prevents a `catch` from re-wrapping an already-classified error as a fixed kind, which would clobber the original classification. The companion `reclassifyOrRethrow` helper (`src/core/rebelCore/modelErrors.ts`) is the sanctioned pattern catches must use instead. Commits `6c65d65a4`, `5d0711fbb`. |
| 2026-06-03 | **DI-22 (v0.4.46): `@typescript-eslint/switch-exhaustiveness-check` promoted `warn` → `error`** across `src/main/**` + `src/core/**` + `cloud-service/src/**` (commits `a9d2544ce`, `2db9c1b99`, `a1581d9cf`). Cleared the 28 baseline switch-exhaustiveness + 7 no-bare-default violations so a non-exhaustive switch over a closed union (the `incomplete_implementation` bug class) now fails the build. Switches over runtime-open unions (`AgentEvent`/`RebelCoreEvent` over IPC/stream/CLI, the `switch(true)` idiom) keep a `default` case behind an inline-justified `eslint-disable` — an exhaustive `assertNever` would throw on valid unknown/future values. Net effect is MORE guarding (rule now blocks everywhere else). `ESLINT_DISABLE_BASELINE` raised 244 → 251 (commit `2db9c1b99`) to absorb those sanctioned disables. |
| 2026-05-23 | Code-health follow-up sweep (CE2 Light, 2 commits). Addressed three deferred FOLLOW-UPs from the 260522 sweep (#3 PARTIALLY, #4 FULLY, #5 VERIFIED). **Stage 1 (#4 z.unknown +1 audit, fully closed):** identified the new occurrence as `ResolutionFailureSchema.metadata` in `src/shared/ipc/schemas/agent.ts:278` (commit `8bc9069077`, 2026-05-17); added shared recursive `JsonValueSchema` + `JsonValue` type to `src/shared/ipc/schemas/common.ts`; retyped the field from `z.record(z.string(), z.unknown())` → `z.record(z.string(), JsonValueSchema)`; tightened the manual `ResolutionFailure.metadata` interface and helper `RecordAssetResolutionFailureOptions.metadata` to `Record<string, JsonValue>` (closing the runtime/compile-time split-brain that reviewer F2 surfaced); added regression-guard test asserting non-JSON values are rejected; lowered `Z_UNKNOWN_BASELINE` 31 → 30. **Stage 2 (#3 partially addressed — two largest bare-disable clusters):** `react-hooks/exhaustive-deps` 39 bare → 0 (each gained a specific dep-naming rationale clause; zero escalations from implementer); `no-console` 13 bare → 0 (2 became structured logger calls — disable removed entirely; 11 gained rationale clauses). **Net Stage 2: 52 occurrences handled, 50 rationale comments added, 2 disables fully removed.** `ESLINT_DISABLE_BASELINE` lowered 232 → 230. Continuing FOLLOW-UP (post-Stage-2 path-aware re-count): **24 actual bare disable directives remained in production code post-Stage-2** — `@typescript-eslint/no-explicit-any` 17 (16 -next-line + 1 -line), `@typescript-eslint/naming-convention` 3 (all in `userQuestionResponseHandler.ts`), `@typescript-eslint/no-unused-vars` 2, `@typescript-eslint/no-non-null-assertion` 1 (`toolIndexService.ts`), `no-restricted-syntax` 1 (`FileLocationBadge.tsx`). The legacy content-only grep recipe (`grep -rh ... | grep -v ' -- ' | wc -l`) returns ~41 because `grep -h` strips filenames so path-based excludes silently fail; per-rule production reality was 24. **Stage 8 of the 260523 sweep (commit `909905019`) cleared all 24 by adding inline ` -- <reason>` rationale clauses — bare-disable count is now 0.** **Stage 3 (#5 verification, fully verified):** ran 3-grep + lint cross-check; manually classified all raw-grep output (CSS `!important`, `!==` comparisons) and certified zero `arr[i]!`/`.at()!`/`)!` index-access patterns in production code (residual 29 `no-non-null-assertion` warnings are all non-array-index cases). |
| 2026-05-22 | Code-health sweep (CE2 Light, 2 commits). **Stages 1-4** (baselines + ratchet wirings + docs, commit `9f15fd1ef`): tightened 4 ESLint warning baselines to current actuals (`no-unused-vars` 95→77, `no-explicit-any` 72→71, `no-non-null-assertion` 42→38, `no-console` 9→0); lowered `as any` 70→69; bumped `eslint-disable` baseline 204→232 with audit-backed comment (~64% of 269 line-occurrences carry rationale, ~36% bare — bare ones are next-sweep target); bumped `z.unknown()` 30→31 (acknowledgement of drift). **Wired 5 previously-unwired ratchets into `validate:fast`**: `escape-hatches`, `boundary-forbidden-terms`, `cloud-channel-parity`, `ipc-handler-parity`, `ipc-schema-strictness` (they had been documented as enforced but weren't). validate:fast end-to-end now ~64s. **Stages 5-6** (warning cleanup, commit `6ad408172`): cleared 24 production warnings across 21 files. `no-unused-vars` 77→62 (-15: 15 production deletions/renames). `no-non-null-assertion` 38→29 (-9: filter→flatMap pattern conversions in focus components, capture-and-narrow in modelRoleResolver, redundant-after-narrowing in routeLabelCacheStore + promptDoc). Explicit exclusion list honoured (skipped `rebelCoreQuery`, `behindTheScenesClient`, `shareLinksService`, `libraryHandlers`, `agentTurnExecute`, `inboxBridgeStateMachine`). **Net warning count: 229 → 205.** |
| 2026-05-08 | All 12 TS surfaces at baseline ZERO. Round-4 deferred cleanup (commits `bc12d6c89..c4085e0e9`) cleared the `cloud-service-test` baseline from 42 → 0 by typing 22+ mock declarations across the agentRoute / sessionsRoute / diagnosticsRoute / meetingSessionRoute / staleBusyReaper / agentStopEscalation suites with real signatures (`vi.fn<typeof markSessionAsCloudActive>`, `vi.fn<typeof sendPushNotification>`, `vi.fn<typeof upsertSession>`, named `MockDiagnosticsRes` / `MockMeetingRes` / `MockAgentWs` types) and a generic `body<T>()` helper. Same round dropped 11 production non-null assertions via capture-and-narrow / invariant-throw / inline-narrowing patterns (recentLogsTail, memoryWriteHook, cloudContinuityStateService, cloudSessionMergeService, NotificationDrawer, ExpandedConnectionCard, index.ts officeSidecarManager, MissionProgressCard, shareLinksService mutex). |
| 2026-05-03 | `cloud-service-test` TS baseline raised: 59 → 62 to acknowledge upstream merge regression at sync time. All 62 errors are pattern-uniform across 16 test files (TS2352 + TS2493 on `mock.calls[0]?.[0] as AgentSession`, TS18046 on `responseBody as unknown` access, TS2556 on `(...args: unknown[]) => mock(...args)` spread). One test-helpers PR (typed `mockArg<T>()` + `responseBody` narrowing helper + vararg-spread fix) clears the cluster cleanly — tracked as a sweep candidate, not a separate planning doc. |
| 2026-04-06 | Renderer TS baseline tightened: 230 (from 426). 9-stage testing infrastructure + SDK removal cleanup resolved 103+ TS test errors and enabled massive renderer reduction |
| 2026-04-06 | Node TS baseline raised to 60 (from 53). New test files from testing stages added errors; committed code debt stable |
| 2026-04-06 | Zero ESLint warnings maintained across 74 files after SDK removal sweep (commit 9f24341e) |
| 2026-04-03 | Node TS baseline tightened: 53 (from 68). Fixed 11 test regressions + 9 inboxStore type alignment errors |
| 2026-04-02 | Renderer TS baseline tightened: 426 (from 428). Added `isNetworkError`, fixed superMcpHttpManager null safety, queryOptionsBuilder types, renderer type drift |
| 2026-04-02 | Node TS baseline raised to 63 (from 51). 12 errors from orphaned untracked test files (incomplete sessions). Committed code is at 51. |
| 2026-03-30 | Node TS baseline tightened: 75 (96% total reduction from 1,889) |
| 2026-03-30 | Renderer TS baseline tightened: 669 (from 710) |
| 2026-03-30 | Recording circular deps broken: 11 → 8 (baseline still 10) |
| 2026-03-29 | TS7006 (implicit any): eliminated (36 → 0) |
| 2026-03-29 | Main circular deps: 17 → 10 (7 cycles broken) |
| 2026-03-29 | bundledInboxBridge.ts: 88 TS errors → 0 |
| 2026-03-29 | Node TS baseline tightened: 1,889 → 852 |
| 2026-03-28 | ESLint warnings: 1,489 → 0 (zero enforced) |
| 2026-03-28 | Renderer circular deps: 3 → 0 (zero enforced) |

## Dominant TS Error Categories

As of 2026-05-08: all 12 TS surfaces at baseline zero. No dominant categories remain because there are no errors; the historical reductions tracked in the Milestones table above describe the journey from 1,889 + 710 + 426 errors (Mar 2026) to zero across all surfaces (May 2026).

## Remaining Circular Dependency Cycles

Baseline is 0 (enforced in `scripts/check-circular-deps.ts`; `MAIN_CYCLE_BASELINE = 0`). The previously-cited "baseline 10, actual ~8" figures predated the architectural cycle-breaking work; the historical recording mutual exclusion chain (`gracefulShutdown → meetingBot → recording → quickCapture`) is fully resolved and the script now enforces zero new cycles. See `docs-private/investigations/260329_circular_dep_analysis.md` for cost/benefit analysis (if it exists).
