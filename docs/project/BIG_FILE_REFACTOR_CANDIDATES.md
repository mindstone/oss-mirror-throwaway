---
description: "Prioritized assessment of oversized source files worth refactoring, the ease×value×collision methodology behind it, and how to refresh the list. The companion to the recommendation-drain process for structural (not bug-driven) debt."
last_updated: 2026-06-22
---

# Big-File Refactor Candidates

Some source files have grown large enough that they hurt: not because line count is intrinsically bad, but because **large + high-churn files are where multi-agent merge collisions concentrate** (5–7 agents share `dev`; see [GIT_WORKTREES](GIT_WORKTREES.md)). This doc is the standing, refreshable shortlist of which big files are worth splitting, ranked by **ease × value**, and — critically — **which to leave alone**.

> **Intent.** This is the structural-debt sibling of [IMPLEMENT_PRIOR_POSTMORTEM_AND_PLAN_RECOMMENDATIONS](IMPLEMENT_PRIOR_POSTMORTEM_AND_PLAN_RECOMMENDATIONS.md): that process drains *bug-prevention* recommendations; this one drains *oversized-file* debt. Both feed the weekly review and both implement through [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md).

## The three axes (why size alone is a trap)

A refactor only earns its keep when value clears the risk. Score each candidate on:

1. **Value = size × churn.** Churn (commits / 6 months) is the real signal — it's how often agents collide on the file. A 6k-LOC file touched twice a quarter costs nothing; a 4k-LOC file touched daily is a collision magnet. **Big-but-stable files are not candidates.**
2. **Ease = clean seams + test coverage.** Files with cohesive internal groupings (pure helpers, distinct domains, a sliceable store) and existing tests refactor safely. Tangled closures, effect-ordering, and module-init side-effects lower ease.
3. **Collision exposure *right now*.** A whole-file reorganization that sits in a worktree for days will lose to whatever the rest of the fleet is actively editing. **Prefer surgical small-diff extractions over whole-file reshuffles while the surface is hot.** Before starting, check `git log --since='3 days ago' --all --oneline -- <file>` and avoid the current hot zone (as of 2026-06-14 that's model/provider routing — `src/core/rebelCore/*`, `providerRout*`, `clientFactory*`, `localModelProxyServer.ts`, `mcpService.ts`, `automationScheduler.ts`).

## Methodology — how this list was built (and how to refresh it)

```bash
# Size (largest first)
find src cloud-service cloud-client packages mobile -type f \( -name '*.ts' -o -name '*.tsx' \) \
  -not -path '*/node_modules/*' -not -name '*.test.*' -not -name '*.spec.ts' \
  | xargs wc -l | sort -rn | head -50

# Churn for a given file (commits, last 6 months)
git log --since='6 months ago' --oneline -- <file> | wc -l

# Collision check before starting a refactor (recent cross-agent activity)
git fetch origin -q && git log --since='3 days ago' --all --oneline -- <file>
```

Then assess separability per file (cohesive unit vs god-file; named extraction seams; test coverage). The richest first pass was four parallel `Explore` agents — one per candidate cluster.

## Prioritized shortlist (as of 2026-06-14)

Sizes/churn are snapshots — **re-run the commands above before acting**; these drift within days.

| Rank | File | LOC | Churn/6mo | Ease | Value | Verdict |
|---|---|---|---|---|---|---|
| 1 | `src/main/services/safety/memoryWriteHook.ts` | 4,101 | 148 | — | — | **DONE (2026-06-14, `5191c556ba`)** — the prescribed extraction already landed: bash analyzers → `bashContentExtractor.ts`, safety-level resolvers → `memorySafetyLevels.ts` (behavior-preserving re-export facade). The frontmatter was just never refreshed, which caused a re-pick on 2026-06-22. Residual bulk is the tangled `createMemoryWriteHook` closure — **low ease, not a candidate**. |
| 2 | `src/main/index.ts` | 7,710 | 700 | 3 | **5** | **HIGH VALUE, hot — partially extracted (2026-06-23, 8,340→7,710, −630).** The deep-link cluster + `createWindow` have been pulled to `src/main/startup/deepLinkHandler.ts` + `mainWindowFactory.ts` (behavior-preserving, characterization-test-first; plan `docs/plans/260623_refactor-index-startup-extract/`). **Remaining high-value work: decompose the ~4,300-line anon `app.whenReady()` callback into named phases (~60–70% collision-reduction est).** Still **deferred** — needs a coordinated quiet window + a startup-sequencing characterization test first. |
| 3 | `src/renderer/.../store/sessionStore.ts` | 4,317 | 195 | 3 | 4 | **DONE (2026-06-22, 6,196→4,317, −1,879 ~30%)** — Stages 1-8 landed: module-level subsystems extracted to 8 sibling modules behind a re-export facade (`sessionStoreTypes`, `sessionStoreHelpers`, `thinkingDeltaScheduler`, `validationTelemetry`, `currentSessionEvents`, `backgroundEventBuffer`, `leakDiagnostics`, `shadowBusyProbes`). Export surface byte-identical (56 names) at every stage; 381/381 store tests green; cross-family review (GPT-5.5-xhigh + Composer-2.5) SHIP-WITH-NITS conf 90/91, all nits addressed. The delete-authority-harness anti-rot nit is fixed (harness now pins the moved non-write markers in sibling files). **NB: the Zustand action closure (~95 actions) is intentionally NOT sliced** (slicing moves LOC sideways while importing devtools-mutator-tuple typing risk — see plan §2), so the residual ~4,300 is mostly that closure. Optional Stages 9-10 (selectors fold; resurrectionGuards) judged low-value/higher-risk, not pursued. Plan + reviews: `docs/plans/260622_refactor-session-store/`. |
| 4 | `src/main/services/automationScheduler.ts` | 4,683 | 151 | 4 | 4 | **DEFER (hot)** — split store+34-migrations from execution runner. Provider-readiness rules → currently in the hot zone. |
| 5 | `src/main/services/mcpService.ts` | 3,873 | 160 | 3 | 5 | **DEFER (hot)** — extract OAuth orchestration (~650). Provider/connector-adjacent. |
| 6 | `src/main/services/bundledMcpManager.ts` | 4,468 | 215 | 4 | 4 | **CANDIDATE** — extract per-provider instance builders + bundled-MCP registry. Connector-adjacent; coordinate with connector work. |

### Explicitly NOT worth it (large but cohesive or stable)

- **`src/renderer/App.tsx`** (11,915 LOC, **939** churn) — the biggest, churniest file, but a refactor *trap*: it's genuine cross-feature orchestration. Extracting **all** plausible hooks nets ~550 lines (~4.6%). The real fix is **documentation + discipline** (AGENTS.md still says "~2,800 LOC" — stale by ~4×) and opportunistic extraction per its existing policy (feature logic → `features/<x>/hooks/`), not a big-bang refactor.
- **`inboxBridgeStateMachine.ts`** (6,590 / 35) — large but **low churn**; thin HTTP routing over real services. Extraction adds indirection for little collision relief.
- **`toolSafetyService.ts`** (5,461 / 56), **`agentTurnExecute.ts`** (5,912 / 73) — moderate churn, mostly organizational gain; cohesive orchestrators.
- **`localModelProxyServer.ts`** (4,678 / 156), **`libraryHandlers.ts`** (4,760 / 90) — cohesive (proxy translation; workspace-file dispatcher). Leave alone.

## How to drain this list

1. Pick the top **DO** item whose surface is *cold* per the collision check.
2. Run it through [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) — default-on worktree, planning folder, cross-family review. **Refactors are behavior-preserving**: the bar is "identical behavior, smaller files," verified by the *existing* test suite (and, for safety/startup files, a characterization test written first).
3. Refactor verification (CE2 §7): grep every moved symbol; confirm zero dangling references; no new type errors / lint warnings in touched files.
4. After landing, update this doc's table (drop the item; re-snapshot sizes if convenient).

> **Parallelism caution.** Multiple simultaneous whole-file refactors into a hot `dev` is exactly the chaos the collision axis warns against. Prefer one surgical extraction at a time, or parallelize only across *genuinely independent, currently-cold* subtrees (e.g. a safety-service extraction alongside a renderer-store slice).

## See also

- [IMPLEMENT_PRIOR_POSTMORTEM_AND_PLAN_RECOMMENDATIONS](IMPLEMENT_PRIOR_POSTMORTEM_AND_PLAN_RECOMMENDATIONS.md) — the bug-prevention recommendation drain (this doc's sibling)
- [CODE_HEALTH_TOOLS](CODE_HEALTH_TOOLS.md) — code-health tool catalog; the size×churn scan belongs to its periodic-sweep family
- [WEEKLY_AUTOMATED_REVIEW](WEEKLY_AUTOMATED_REVIEW.md) — the weekly runbook that surfaces this list
- [GIT_WORKTREES](GIT_WORKTREES.md) — why multi-agent churn makes big files painful
- [CHIEF_ENGINEER2](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) — the implementation workflow
