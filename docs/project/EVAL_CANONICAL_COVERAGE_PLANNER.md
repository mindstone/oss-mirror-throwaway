---
description: "Idempotent and resumable canonical knowledge-work eval runs: how deriveCoveragePlan classifies fixtures and chooses what to skip, re-run, or rejudge."
last_updated: "2026-06-04"
---

# Eval Canonical Coverage Planner

The canonical coverage planner makes tier-0 knowledge-work runs idempotent. A default canonical run should spend API budget only on missing or stale cells, while preserving an explicit escape hatch for full re-runs.

## See Also

- [TESTING_EVALS_KNOWLEDGE_WORK.md](TESTING_EVALS_KNOWLEDGE_WORK.md) — runner flow, CLI flags, fixture types, and result output
- [WRITING_EVALS.md](WRITING_EVALS.md) — eval-system hub and harness guidance
- [EVAL_CORPUS_IDENTITY.md](EVAL_CORPUS_IDENTITY.md) — `fixtureCorpusHash`, score-field fingerprints, and corpus equivalence
- [EVAL_HARNESS_RELIABILITY.md](EVAL_HARNESS_RELIABILITY.md) — recoverable incomplete-agent gaps and failure observability
- [EVAL_JUDGE_PANELS.md](EVAL_JUDGE_PANELS.md) — panel identity and `panel_mismatch` recovery
- [`evals/knowledge-work-coverage.ts`](../../evals/knowledge-work-coverage.ts) — `deriveCoveragePlan()`, `FixtureCoverageState`, and `CoveragePlan`
- [`evals/knowledge-work.ts`](../../evals/knowledge-work.ts) — `applyCanonicalCoverageSelection()` and `selectFixturesForCoveragePlan()`

## Default Behavior

For a default canonical tier-0 run, `knowledge-work.ts` calls `applyCanonicalCoverageSelection()` before dispatching fixtures. That function builds the current model-variant key, loads the canonical panel, calls `deriveCoveragePlan()`, and then runs only the fixtures that still need work.

This selection applies only when the invocation is the default canonical static-response path:

- `--tier 0`
- no explicit `--fixture`, `--family`, or `--suite`
- not calibration mode
- no persona overlay
- no showrunner overlay
- not a worker-batch subprocess
- no `--rerun-all` / `--no-skip`

Every other invocation keeps the caller's explicit selection.

## Coverage States

`deriveCoveragePlan()` classifies each canonical fixture for one model variant:

| State | Meaning | Planner action |
|---|---|---|
| `properly_run` | Current schema major, comparable corpus, completed agent run, adequate judges, canonical panel | Skip |
| `missing` | No result cell for the fixture | Re-run agent fixture |
| `incomplete_agent` | Agent output is missing or `completed !== true` | Re-run agent fixture |
| `inadequate_judging` | Judge data is unusable and cannot be fixed by panel replay alone | Re-run agent fixture |
| `stale_schema` | A result exists, but its `analysisSchemaVersion` major is no longer current | Re-run agent fixture |
| `stale_corpus` | A result exists, but its corpus hash is not current or score-equivalent | Re-run agent fixture |
| `panel_mismatch` | Agent output is usable, but the judge panel signature differs | Rejudge from snapshot |

The plan returns three useful lists:

- `properlyRun` — fixtures already safe to keep.
- `toRun` — full agent re-runs needed for missing, incomplete, stale, or inadequate cells.
- `toRejudge` — panel mismatches where judge replay is enough.

## Resume by Construction

The planner reads existing result files from the target output directory. If a prior run completed 24 of 30 canonical fixtures, the next default run selects the 6 gaps. If all 30 are `properly_run`, the selected fixture list is empty and the run exits without wasting API spend.

This also makes interrupted runs cheap to resume: re-run the same canonical command and the planner resumes from the observed coverage state. Use `--rerun-all` or `--no-skip` only when you intentionally want to bypass skip-good behavior and regenerate every fixture.

## Corpus Equivalence

Coverage freshness uses `areCorpusHashesComparable()` rather than raw string equality. That lets documented score-equivalent full-corpus hashes stay `properly_run` while still rejecting known score-affecting drift, such as the temporary 2026-05-18..20 `judgment-material-ambiguity-clarification-01` v6 hash window.

For explicit fixture recovery runs, the planner computes the expected per-file hash for the fixture IDs covered by that result file. That keeps partial recovery output compatible with the exact subset it attests.

## Incomplete Agent Runs

`RECOVERABLE_AGENT_REMEDIATIONS` marks `rerun_agent_fixture` as a recoverable coverage gap. In practice this means an incomplete agent run should not be treated as a fatal judging-quality failure: re-run that fixture, then re-analyze. The successful rerun is folded back into the same variant/fixture cell by the analyzer's repeat-collapse policy.
