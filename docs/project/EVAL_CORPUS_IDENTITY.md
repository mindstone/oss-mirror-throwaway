---
description: "Corpus identity and score comparability for knowledge-work evals: fixtureCorpusHash, score-field fingerprints, equivalence classes, and schema-version policy."
last_updated: "2026-06-04"
---

# Eval Corpus Identity

Corpus identity answers one question: can two knowledge-work result files be compared as the same scoring task? The durable answer is not just the stored directory hash; it is the combination of scoring schema, score-affecting fixture fields, corpus data, and judge panel.

## See Also

- [TESTING_EVALS_KNOWLEDGE_WORK.md](TESTING_EVALS_KNOWLEDGE_WORK.md) — runner behavior and result metadata
- [TESTING_EVALS_KNOWLEDGE_WORK_ANALYSIS.md](TESTING_EVALS_KNOWLEDGE_WORK_ANALYSIS.md) — analyzer filtering, version gating, and report semantics
- [WRITING_EVALS.md](WRITING_EVALS.md) — eval-system hub and harness guidance
- [EVAL_CANONICAL_COVERAGE_PLANNER.md](EVAL_CANONICAL_COVERAGE_PLANNER.md) — how corpus identity drives `stale_corpus` vs skip-good coverage planning
- [EVAL_JUDGE_PANELS.md](EVAL_JUDGE_PANELS.md) — judge-panel identity, another required comparability input
- [EVAL_COMPARISON.md](EVAL_COMPARISON.md) — Rebel-vs-CoWork pairing policy that uses corpus comparability
- [EVALS_POLICY_BUMP_RUNBOOK.md](EVALS_POLICY_BUMP_RUNBOOK.md) — operator flow for panel/policy changes that affect comparability
- [`evals/knowledge-work-corpus-equivalence.ts`](../../evals/knowledge-work-corpus-equivalence.ts) — `computeScoreFieldFingerprint()`, equivalence registry, and comparability helper
- [`evals/knowledge-work-fixture-corpus-hash.ts`](../../evals/knowledge-work-fixture-corpus-hash.ts) — `computeFixtureCorpusHash()` and `computeFixtureFilesCorpusHash()`
- [`evals/knowledge-work-scoring.ts`](../../evals/knowledge-work-scoring.ts) — `KNOWLEDGE_WORK_ANALYSIS_VERSION` and version history
- [`260604_063606_corpus-substantiality-forensics.md`](../plans/260604_kw-eval-idempotent-resumable/subagent_reports/260604_063606_corpus-substantiality-forensics.md) — forensic verdict on May corpus hash drift

## `fixtureCorpusHash`

`fixtureCorpusHash` is the SHA-256 identity written into knowledge-work result metadata. For full canonical runs, `computeFixtureCorpusHash()` hashes the sorted top-level canonical fixture JSON files under `evals/fixtures/knowledge-work-reproducible/`.

It is deliberately coarse:

- It does not recurse into `evals/fixtures/knowledge-work-reproducible/corpus/`, so April `corpus/` data changes are not captured by the hash.
- It flips for hash-affecting but score-neutral edits such as disabled fixture additions or metadata-only changes.
- It is still useful for coverage planning because most fixture edits should make stale result files visible rather than silently reused.

Explicit recovery runs, such as `--fixture <id>`, use `computeFixtureFilesCorpusHash()` over the selected fixture paths. The coverage planner recomputes the expected hash for the fixture set actually covered by each result file, so single-fixture recovery runs do not need to masquerade as full-corpus runs.

## Score-Field Fingerprint

`computeScoreFieldFingerprint()` is the tighter comparability identity for the canonical fixture set. It hashes only score-affecting fields, sorted by fixture id:

- `prompt`
- `turns[].prompt` and `turns[].rubric`
- `rubric`
- `cribSheet`
- `constraints`
- `mustNotDo`
- `rubricWeightOverrides`
- `maxTurns`

It intentionally excludes descriptions, capabilities, cost estimates, persona metadata, disabled flags, and other non-scoring metadata. The equivalence registry in `evals/knowledge-work-corpus-equivalence.ts` uses this fingerprint to document when multiple `fixtureCorpusHash` values are score-equivalent.

Guardrails live in [`evals/__tests__/knowledge-work-corpus-equivalence.test.ts`](../../evals/__tests__/knowledge-work-corpus-equivalence.test.ts): the current canonical fixture fingerprint must match the registry, equivalent and excluded hashes must stay disjoint, equivalence is reflexive/symmetric, and excluded hashes do not compare against the equivalent set.

## Current Verdict

The corpus forensics report found that the current canonical 30 scoring inputs have been identical from approximately 2026-05-03 through the current 2026-06-04 worktree, with forensic score-field fingerprint `5693726d8085c7a22028592957d5aa500a53c80b16b9452be72c40ac314ffa95`. Those runs are score-comparable when they share the same analysis-schema major and judge-panel identity.

The implementation registry stores the current serializer's fingerprint value in `canonicalScoreFieldFingerprint` and records the forensic `5693726d...` value in its notes. Treat the registry as the operational source of truth; treat the forensics report as the evidence trail.

Not comparable:

- 2026-05-18 through 2026-05-20 hashes that include `judgment-material-ambiguity-clarification-01` v6. Commit `87105e193` added three `keyEvidence` checks; commit `2baad3061` reverted the fixture to v5 scoring inputs.
- Pre-May and April runs. April had heavy prompt/rubric/cribSheet/constraint churn, plus 2026-04-07 and 2026-04-12 `corpus/` data changes that `fixtureCorpusHash` does not capture.

## Comparability Rule

Compare scores only when all of these hold:

1. `analysisSchemaVersion` major matches.
2. Corpus hashes are equal or `areCorpusHashesComparable()` accepts them through the documented equivalence registry.
3. Judge-panel identity matches the canonical panel for the comparison.
4. The run mode is the same comparison universe, especially static-response canonical runs vs persona-overlay runs.

The analyzer enforces major-version gating by default. The coverage planner uses corpus comparability to decide whether a prior result is `properly_run` or `stale_corpus`. Panel drift is handled separately through judge adequacy and the `panel_mismatch` coverage state.

## `analysisSchemaVersion`

`analysisSchemaVersion` is a `major.minor` version written into every knowledge-work result file. It answers whether result structure and scoring semantics are comparable.

- Bump **major** when a change invalidates cross-version score or pass-rate comparison: rubric dimensions, pass thresholds, verdict logic, judge-panel composition, effective-pass-rate/composite-score definition, or constraint gating.
- Bump **minor** for additive or cosmetic changes: new telemetry, additive metadata, judge prompt polish that does not change scoring, new fixtures, or bug fixes that do not move scored outputs.

Default analyzer behavior keeps files with the current major and excludes older majors. `--strict-version` tightens this to exact `major.minor`; deprecated prior-version flags do not bypass major gating.
