---
description: "Reliability contract for the knowledge-work eval harness: error preservation, retry policies, parallelism caps, watchdog semantics, and crash isolation."
last_updated: "2026-06-04"
---

# Eval Harness Reliability

The knowledge-work eval harness is designed to survive failures gracefully — rate-limits, network errors, missing keys, and even per-fixture crashes — without aborting a run. Every failure mode is observable in the output, never silent.

## Error Preservation

Every `AgentEvent` of kind `error` carries a top-level `rawError: string?` field that preserves the upstream provider's error body, regardless of error category. This was added in Stage 2 of the [reliability plan](../plans/260429_eval_reliability_judge_panel.md) to close the diagnostic gap where fixtures errored with no visible cause.

Before persistence, the raw error body is:
- **Redacted** of secrets: `sk-` tokens, `sk-ant-` tokens, Bearer tokens, Authorization headers, Google API keys (`AIzaSy...`), JWT-shaped strings, and `api_key=` values. Implemented in [`src/core/utils/redactRawError.ts`](../../src/core/utils/redactRawError.ts) using layered patterns over the shared `redactSensitiveData()` helper.
- **Truncated** to 4,096 bytes so an oversized provider body cannot inflate the persisted JSON.

The redaction is intentional — keys never appear in result files, but enough context is preserved to diagnose any error kind, not just `rate_limit` or `billing` errors which previously had special handling. The `rawError` field is only populated when `errorSource === 'main'` (renderer-originated errors continue to use `humanizedCopy` only).

Source: `dispatchAgentErrorEvent` in [`src/core/services/agentEventDispatcher.ts`](../../src/core/services/agentEventDispatcher.ts).

## Retry Policies

Two pure helpers implement the retry logic. Both accept an `attempt` counter (1-indexed) and an error classification, and return a `shouldRetry` + `delayMs` decision:

| Helper | rate_limit | parse | 5xx | timeout | 4xx (auth/quota) |
|--------|---|---|---|---|---|
| `decideFixtureRetry` | 30 / 90 / 270s | 2 / 8 / 32s | 5 / 15 / 45s | 90s once | fail-fast |
| `decideJudgeRetry` | 30 / 90 / 270s | 2 / 8 / 32s | 5 / 15 / 45s | 60s once | fail-fast |

Both helpers apply ±20% jitter to the delay and cap at 3 attempts total (initial + 2 retries). `decideJudgeRetry` is in [`evals/judgePanel.ts`](../../evals/judgePanel.ts); `decideFixtureRetry` is in [`evals/knowledge-work.ts`](../../evals/knowledge-work.ts).

The worst-case wall-clock budget per judge per fixture is approximately 7 minutes (429 backoff path). Judge calls are parallelised across the panel via `Promise.allSettled`, so this budget does not stack sequentially.

## Parallelism Caps per Provider

`resolveParallelismCap` in [`evals/knowledge-work-setup.ts`](../../evals/knowledge-work-setup.ts) sets the default worker count based on the provider's rate-limit headroom. The `'other'` provider type (profile-driven models via OpenRouter-compatible endpoints) falls through to the OpenRouter cap of 2.

| Provider | Default parallelism |
|----------|---------------------|
| `anthropic` | 4 |
| `openrouter` | 2 |
| `codex` | 1 |
| `other` (profile path) | 2 (openrouter cap) |

The `--parallel N` CLI flag overrides the default regardless of provider.

## Watchdog vs Harness Timeout

These are two distinct timeout signals:

- **`watchdogFired`** — set on a `FixtureResult` when the watchdog process killed a fixture's agent loop. Mirrors the `watchdogDiagnostic` field from `AgentEvent`. Indicates the agent was still running but exceeded the per-fixture watchdog threshold.
- **`timeoutDiagnostic`** (harness 15-minute cap) — set when the eval harness itself timed out waiting for the agent. This is a distinct signal from watchdog; the harness cap and the watchdog are independent layers.

In `resolveTimeoutDiagnostics()`, `watchdogFired` is only true when `watchdogDiagnostic` is present, not when `timeoutDiagnostic` is present. They are never both true for the same fixture.

## Watchdog Self-Resolved Stalls (recoveredStalls)

The watchdog has a third state alongside "fired" and "did not fire": **self-resolved**. When the watchdog detects a stall but the agent recovers before the kill threshold, the stall is logged but the run continues. Before Stage 5 of the [260503 robustness plan](../plans/260503_kw_eval_infra_robustness.md), these were silent in the run summary; operators had to grep logs to know they happened.

Two `FixtureResult` fields surface them:

- **`recoveredStalls?: number`** — count of self-resolved stalls observed during the fixture's primary + continuation turns (0 when no stall recovered).
- **`recoveredStallsMs?: number[]`** — list of `resolvedAfterMs` durations, in observation order. Useful for distribution-shape analysis (long tail of slow recoveries indicates underlying instability).

The summary line `Watchdog recovers: N self-resolved stalls across M/T fixtures` always prints when `N > 0`. The summary additionally **warns** when the share of fixtures with any recovery exceeds 12% — see the inline comment in `printSummary` (`evals/knowledge-work.ts`) for the rationale on the fixture-share denominator vs raw stall count.

**Contract for reading the values:** the eval bootstrap exposes `getRecoveredStallsMs(turnId)` on `EvalBootstrapDeps`, which delegates to `agentTurnRegistry.getRecoveredStallsMs`. Callers MUST read inside the per-turn event listener on the terminal `result` / `error` event (synchronous dispatch path, before runtime terminal cleanup). Reading after the Promise resolves can race against `cleanupTurn` and silently return `[]`. The registry returns a defensive copy of the internal storage.

**Source files:**
- `src/core/services/agentTurnRegistry.ts` — `recordWatchdogSelfResolution(turnId, ms)` + `getRecoveredStallsMs(turnId)` + cleanup
- `src/main/services/agentTurnExecutor.ts` — single-line hook inside the existing `Watchdog self-resolved` log block
- `evals/knowledge-work-bootstrap.ts` — `EvalBootstrapDeps.getRecoveredStallsMs`
- `evals/knowledge-work.ts` — per-fixture accumulation in `runFixture`; `printSummary` aggregate + 12%-fixture-share warning

## MCP Twin Contract per Mode

The reproducible-corpus MCP twins (`evals/mcp-twins/server.ts`) advertise different contracts depending on `MCP_TWIN_HERMETIC`:

- **Hermetic mode** (`MCP_TWIN_HERMETIC=1`, set automatically when the eval launcher takes the all-reproducible path): the twin's tool catalog is intended to be a **closed superset** of the bundle's `connectedPackages`. The contract is enforced **at the first unknown tool call** (boot-time catalog diff is deferred — see [the 260503 plan](../plans/260503_kw_eval_infra_robustness.md)) by returning a LOUD `[twin contract]` error naming the tool, listing the catalog (sorted alphabetically), and pointing at the source files in `evals/mcp-twins/<service>-tools.ts`. The intent: when the bundle's `connectedPackages` and the twin's tool catalog drift apart, fail fast at first occurrence with an actionable diagnostic instead of letting the agent's recovery path silently mask the contract violation as transient `Unknown tool` noise.
- **Non-hermetic mode** (default): the twin advertises an **explicit subset** of production tools. Unknown calls return the legacy recoverable `Unknown tool: <name>` so the agent's existing recovery path keeps working for non-reproducible fixtures.

The boot log includes `[contract: hermetic / closed-superset]` or `[contract: non-hermetic / recoverable-subset]` so operators can verify the active contract.

The `[twin contract]` prefix is a stable, machine-readable signal that aggregators can use to distinguish "twin missing tool" (catalog drift) from "model called nonsense tool" (model-quality issue) without parsing the message body.

**Source files:**
- `evals/mcp-twins/server-helpers.ts` — `buildUnknownToolResult(toolName, advertisedTools, hermetic)` (parameterised hermetic flag for unit-test determinism)
- `evals/mcp-twins/server.ts` — module-scope `HERMETIC_MODE` env-var read; passes through to helper
- `evals/mcp-twins/__tests__/twin-contract.test.ts` — 7 unit tests covering both modes

## Per-Fixture Loop Crash Isolation

`runFixture` has its own `try/catch`. Additionally, `runModelEval` (the outer loop over fixtures) carries a defensive catch around the `runFixture` call. If a fixture throws unexpectedly — a programmer error, a rejected promise, or any non-`Error` value — the outer catch synthesises a `FixtureResult` with `completed: false`, `errorCategory: 'loop_catastrophic'`, and the error detail logged at `log.error`. This prevents one exploding fixture from killing the entire run.

## Recoverable Coverage Gaps (incomplete-agent)

An incomplete agent run is now a recoverable coverage gap, not a fatal judging-quality failure. `classifyJudgeAdequacy()` can return remediation `rerun_agent_fixture`; `RECOVERABLE_AGENT_REMEDIATIONS` marks that remediation as fixable by rerunning the fixture because judge replay cannot reconstruct missing agent output.

Operators should rerun the affected fixture, for example `--fixture <id>`, then re-run analysis. The canonical coverage planner classifies these cells as `incomplete_agent` and selects them in the next run-missing pass; see [EVAL_CANONICAL_COVERAGE_PLANNER.md](EVAL_CANONICAL_COVERAGE_PLANNER.md) for the full state table.

## Per-Fixture Degraded Verdicts

When the judge panel cannot produce a clean three-judge consensus, the fixture receives a degraded verdict. Two fields capture this:

- `degradedVerdict: true` — the verdict is valid but reached via a degraded path.
- `degradedReason` — one of:
  - `arbitrator_unavailable_during_disagreement` — primaries disagreed and the arbitrator was unavailable; median of primaries is used.
  - `all_primaries_and_arbitrator_failed` — all judges failed; fail-closed verdict with no score.
  - `arbitrator_failed_on_split_panel` — primaries split and arbitrator failed; median of primaries used, arbitrator failure recorded.
  - `arbitrator_failed_on_primary_failure_replacement` — fewer than two primaries succeeded and the arbitrator was invoked as replacement; recorded for observability.

The degraded verdict is distinct from `volatile` (which measures judge score variance across multiple runs). Analyzers can aggregate degraded verdicts to flag runs that should not be used for cross-version comparisons.

The enum is in [`evals/judgePanel.ts`](../../evals/judgePanel.ts) (`DegradedReason` type).

## See Also

- [TESTING_EVALS_KNOWLEDGE_WORK.md](TESTING_EVALS_KNOWLEDGE_WORK.md) — Harness overview
- [EVAL_CANONICAL_COVERAGE_PLANNER.md](EVAL_CANONICAL_COVERAGE_PLANNER.md) — idempotent canonical coverage planning and `incomplete_agent` recovery
- [EVAL_JUDGE_PANELS.md](EVAL_JUDGE_PANELS.md) — Judge panel design, replay tool, configuration
- [WRITING_EVALS.md](WRITING_EVALS.md) — Eval index
- [`src/core/services/agentEventDispatcher.ts`](../../src/core/services/agentEventDispatcher.ts) — `rawError` population site
- [`src/core/utils/redactRawError.ts`](../../src/core/utils/redactRawError.ts) — Redaction patterns and truncate logic
- [`evals/judgePanel.ts`](../../evals/judgePanel.ts) — `decideJudgeRetry`, `JudgeStatus`, `DegradedReason`
- [`evals/knowledge-work.ts`](../../evals/knowledge-work.ts) — `decideFixtureRetry`, `classifyErrorCategory`, `runModelEval` crash isolation, `recoveredStalls` accumulation
- [`evals/mcp-twins/server-helpers.ts`](../../evals/mcp-twins/server-helpers.ts) — twin contract per mode
- [260503 robustness plan](../plans/260503_kw_eval_infra_robustness.md) — full context for `recoveredStalls`, twin contract, and the multi-state E2E gate
