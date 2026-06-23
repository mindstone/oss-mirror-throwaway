---
description: "Operator runbook for bumping ADEQUACY_POLICY_VERSION or canonical judge panel: pre-flight, migration procedure, and failure modes."
last_updated: "2026-06-04"
---

# Evals Policy Bump Runbook

Operator runbook for changes to:
- `ADEQUACY_POLICY_VERSION` in `evals/knowledge-work-judge-adequacy.ts`
- canonical judge panel definition in the hermetic eval config file used with `--config` (typically `evals/configs/default.json`)

## Pre-flight

1. Confirm a **no-runners window** (no concurrent eval writers on the corpus).
2. Ensure working tree is clean for the policy/migration branch:
   - `git status --porcelain`
3. Ensure you are ready to run remediation tooling on the knowledge-work corpus.

## Procedure

1. Make the policy change:
   - bump `ADEQUACY_POLICY_VERSION`, or
   - edit canonical panel in your target hermetic config file.
2. Run:
   - `npm run validate:eval-canonical-panel`
   - Expected: drift is detected (non-zero) until migration + baseline refresh are done.
3. Generate migration report:
   - `npm run eval:remediate-inadequate report --config evals/configs/default.json --report-path /tmp/policy-bump-report.json`
4. Present headline numbers to lead/user:
   - total estimated cost vs approved cap
   - by-action breakdown (rejudge vs quarantine buckets)
5. Execute migration with approved cap + epoch slug:
   - `npm run eval:remediate-inadequate apply --config evals/configs/default.json --cost-cap-usd <approved> --epoch <slug>`
6. Verify corpus is clean:
   - `npm run validate:eval-corpus-clean`
7. Refresh baseline:
   - `npx tsx scripts/check-eval-canonical-panel-drift.ts --update-baseline`
8. Commit in the **same PR**:
   - policy change
   - `evals/.policy-baseline.json`
   - any required changelog updates

## Failure modes

- **Cost cap hit**  
  Re-run with `--resume` after cap approval/update.

- **Lock contention / active runners**  
  Wait for the no-runners window, then retry migration. Do not run concurrent writers against the same corpus.

- **Corrupt `MOVE_LOG.json`**  
  Manually inspect first. Only use `--accept-corrupt-move-log` after manual review confirms overwrite is safe.

## Background

- Remediation planning and policy decisions:
  `docs/plans/260515_inadequate_judging_policy_remediation.md`
- Corpus identity and schema comparability policy:
  [EVAL_CORPUS_IDENTITY.md](EVAL_CORPUS_IDENTITY.md)
