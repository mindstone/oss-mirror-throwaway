---
description: "Rebel-vs-CoWork comparison: fixture pairing, fixtureCorpusHash comparability policy, trajectory divergence, and cost ledger semantics."
last_updated: "2026-06-04"
---

# Eval Comparison: Rebel vs CoWork

Rebel-vs-CoWork comparison runs the same knowledge-work fixtures through Rebel's in-process agent loop and CoWork's `claude-code` loop, then pairs the result files to show outcome, quality, trajectory, and cost deltas. It is an internal benchmarking tool for spotting regressions and competitive gaps; it is not a public product claim generator.

## See Also

- [`docs/plans/260515_rebel_vs_cowork_eval_comparison.md`](../plans/260515_rebel_vs_cowork_eval_comparison.md) — intent, decision locks, staged implementation notes, and known limitations.
- [`docs/project/WRITING_EVALS.md`](WRITING_EVALS.md) — main eval-system guide for fixture design, eval validation, and harness patterns.
- [`docs/project/EVAL_CORPUS_IDENTITY.md`](EVAL_CORPUS_IDENTITY.md) — corpus hash equivalence policy used when pairing comparable result files.
- [`evals/knowledge-work.ts`](../../evals/knowledge-work.ts) — Rebel-side runner and result-file writer.
- [`evals/cowork/`](../../evals/cowork/) — CoWork-side harness (runner types, binary resolver, system-prompt extraction, trajectory divergence).
- [`evals/compare-rebel-cowork.ts`](../../evals/compare-rebel-cowork.ts) — pairing tool that emits JSON, CSV, and Markdown comparison artifacts.

## Quick Start

Use a dedicated Anthropic API key and do not print it:

```bash
API_KEY=$(jq -r '.claude.apiKey' "$HOME/Library/Application Support/mindstone-rebel/app-settings.json")
```

Run the three-fixture smoke set on Rebel:

```bash
ANTHROPIC_API_KEY="$API_KEY" npx tsx \
  --tsconfig tsconfig.node.json \
  --require tsconfig-paths/register \
  evals/knowledge-work.ts \
  --suite=smoke \
  --fixtures=judgment-clear-request-no-clarification-01,email-triage-inbox-priority-02,company-name-resolves-from-tool-targeted-space \
  --max-cost-usd=2.5
```

Run the matching CoWork side:

```bash
ANTHROPIC_API_KEY="$API_KEY" npx tsx evals/cowork-runner.ts \
  --suite=smoke \
  --mode=cowork-internal-baseline \
  --fixtures=judgment-clear-request-no-clarification-01,email-triage-inbox-priority-02,company-name-resolves-from-tool-targeted-space \
  --non-interactive \
  --max-cost-usd=2.5
```

Pair the stitched results:

```bash
npx tsx evals/compare-rebel-cowork.ts \
  --rebel-results=evals/runs/<rebel-run-id>/results.json \
  --cowork-results=evals/runs/<cowork-run-id>/cowork/results.json \
  --output-dir=evals/runs/comparison/<comparison-run-id>
```

Model, commit, and dirty-checkout differences no longer block pairing. They are the point of cross-environment comparison, so the pairing tool records them as `setupDifferences` and places them at the top of `comparison.md`.

If the local Claude app has moved ahead of the frozen prompt snapshot, the CoWork runner fails closed; use `--allow-prompt-drift` only for an explicitly annotated smoke run.

## Mode Reference

- `internal-baseline` is the authoritative v1 comparison mode: Rebel result files with `harnessIdentity.mode: "rebel-default"` are paired with CoWork result files with `harnessIdentity.mode: "cowork-internal-baseline"`.
- `internal-baseline-degraded` is a legacy soft-warn path for old Rebel files that predate `harnessIdentity`. It can help inspect history, but should not be used for fresh conclusions.

## Comparability Policy

The pairing tool hard-rejects only when a comparison would be structurally meaningless:

- the Rebel/CoWork runner + mode tuple is not in the accepted-pair table, or
- `fixtureCorpusHash` differs and is not accepted by `areCorpusHashesComparable()`, because different score-affecting fixture corpora mean different tasks.

Setup differences are soft warnings, not blockers:

- observed/top-line model mismatch,
- repo commit mismatch,
- dirty checkout on either side,
- persona simulator model mismatch,
- accepted prompt drift.

These appear in top-level `setupDifferences[]`, in `softWarnings[]`, and in the Markdown **Setup Differences** section immediately after pair acceptance. Treat them as interpretation context, not as reasons to suppress the comparison.

## Observed vs Requested Model

`harnessIdentity.model` records the requested/top-line model for backward compatibility and configuration auditing. `harnessIdentity.observedModel` records the model actually reported by SDK usage/result events.

The pairing tool surfaces `observedModel` mismatches as setup differences because the model/setup difference is often the comparison being measured. If both sides lack `observedModel`, display falls back to requested-model metadata. If only one side has it, the comparison emits `legacy-no-observed-model` as a soft warning.

## Trajectory Divergence

Persona-overlay fixtures call the persona simulator independently on each side. Because that call is stochastic, the pairing tool computes normalized Levenshtein distance over matched `continuationPromptText` entries in `harnessIdentity.personaTrajectory`.

The output reports per-fixture divergence and run-level aggregates. Stage 4 keeps the first-cut V15 breach thresholds (`mean > 0.20` on more than `30%` of fixtures, or `p95 > 0.40`) as warnings only; Stage 5 is reserved for recalibration from real smoke data.

## Cost Ledger Semantics

CoWork result files break spend into:

- `cowork-agent`,
- `judge-panel`,
- `claim-audit`,
- `predicate`,
- `persona-simulator`.

Rebel result files expose comparable eval LLM costs where the in-process runner already tracks them. If pricing fallback counts are non-zero, treat cost deltas as directionally useful rather than ledger-grade.

## Cost-Cap-Abort Handling

When a fixture reaches a configured cost cap, the runner records `outcome: "cost-cap-aborted"` and the comparison maps that to `regressionTrigger: "cost-cap-aborted"`. This is different from `regressionTrigger: "rate-limited"` (provider throttling) and from normal model failure (`cowork-only-fail`, `rebel-only-fail`, or `both-fail`): the fixture did not complete enough work to support a quality judgment.

Agreement-rate denominators exclude rate-limited, cost-cap-aborted, and not-comparable fixtures. If any fixture is cap-aborted, `comparison.md` begins with a warning banner such as:

> **Warning: 2/3 fixtures hit cost cap (`cost-cap-aborted`). Verdict agreement rate is over the completed 1/3 fixtures only. Re-run with higher caps for full apples-to-apples comparison.**

Treat any smoke with this banner as a harness-health signal, not a model-quality conclusion.

## Interpreting Results

Use the artifacts together:

- `comparison.json` is the machine-readable source of truth.
- `comparison.csv` is for quick spreadsheet slicing.
- `comparison.md` is the operator summary.

Valid conclusions include per-fixture pass/fail deltas, agreement-rate changes, tool-call pattern differences, cost deltas, and trajectory-divergence breaches. Invalid conclusions include broad "Rebel is better than CoWork" claims from a three-fixture smoke, cost claims that ignore CoWork's no-cache disadvantage, or absolute judge-score claims without remembering judges are live model calls.

## Known Limitations

1. Persona-simulator stochasticity is accepted in v1 and measured, not eliminated.
2. CoWork pays a no-cache subprocess penalty that Rebel does not.
3. Rebel and CoWork do not expose identical tool scaffolding, so some structural advantages remain.
4. Timeout policies are intentionally similar but not identical.
5. `AskUserQuestion` scripted-answer support is out of scope because current fixtures do not exercise it.
6. V15 trajectory thresholds are first-cut and must be recalibrated after live smoke data.
