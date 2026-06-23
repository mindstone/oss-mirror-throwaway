---
description: "Developer workflow for running and staging chief_perf_v2 Factory-session backfills"
last_updated: "2026-05-15"
dependencies:
  - "../plans/260515_chief_perf_stage2_replay_stage3_doc_q5b_all_analyses.md"
  - "../../scripts/chief-perf-backfill.sh"
  - "../../coding-agent-instructions/scripts/chief_perf_v2/BACKFILL.md"
  - "../../coding-agent-instructions/scripts/chief_perf_v2/upload_allowlist.py"
---

# Chief-perf backfill — developer workflow

## What this does and why

The chief performance analyzer can recover reviewer-observed score rows from local
Factory CLI session transcripts. Each developer has a different local transcript
set, so Phase A only becomes useful when developers run the backfill on their own
machines and stage the safe output files for shared Drive aggregation.

This document is the operator workflow. The detailed implementation plan is
[`260515_chief_perf_stage2_replay_stage3_doc_q5b_all_analyses.md`](../plans/260515_chief_perf_stage2_replay_stage3_doc_q5b_all_analyses.md),
especially §6.A4. The low-level extractor reference is
[`chief_perf_v2/BACKFILL.md`](../../coding-agent-instructions/scripts/chief_perf_v2/BACKFILL.md).

## Prerequisites

- Python 3.10+ available as `python3` or via `PYTHON=/path/to/python`.
- A local Factory sessions directory for this repo under `~/.factory/sessions/`.
- A chief_perf_v2 analysis report directory, usually under the shared Drive
  `droid-performance-reports` folder.
- Google Drive desktop sync if you plan to copy the staged output into the
  shared `droid-performance-backfills` folder.
- Optional environment variables:
  - `CHIEF_PERF_REPORTS_PREFIX` — root used by `--auto-discover`.
  - `CHIEF_PERF_DRIVE_PREFIX` — upload root printed in the final `rsync` command.
  - `CHIEF_PERF_DEV_HANDLE` — upload namespace; otherwise the helper uses the
    local part of `git config user.email`, then `whoami`.

Stage 1 does not call an LLM API. The `--with-replay` flag is reserved for Phase B;
the Phase A helper accepts it for forward compatibility but still runs Stage 1
only.

## Running the backfill

### One-shot (recommended)

Ask Droid:

> Please run the chief-perf backfill on my machine and upload the results.

Droid should run the helper, inspect the staged files, and leave the final Drive
sync command for a human/operator to execute. The helper deliberately refuses to
upload by itself.

### Manual

From the superproject root:

```bash
bash scripts/chief-perf-backfill.sh --auto-discover
```

Or point at a specific report:

```bash
bash scripts/chief-perf-backfill.sh \
  --analysis-run-dir "/path/to/260512_1805_chief_perf_60d"
```

Useful variants:

```bash
# Preview extractor behavior without writing or staging files.
bash scripts/chief-perf-backfill.sh --dry-run --analysis-run-dir "/path/to/report"

# Override the developer namespace used in the Drive target.
bash scripts/chief-perf-backfill.sh --auto-discover --dev-handle greg
```

## What gets produced

The helper writes a local run directory:

```text
~/.factory/chief-perf-backfills/<UTC-timestamp>-<dev-handle>/
  review_scores_backfilled.ndjson
  backfill_metadata.json
  pre_write_inventory.json
  README.md
  upload_staging/
    review_scores_backfilled.ndjson
    backfill_metadata.json
    pre_write_inventory.json
    README.md
```

File meanings:

- `review_scores_backfilled.ndjson` — Stage 1 reviewer-observed rows recovered
  from local Factory transcripts.
- `backfill_metadata.json` — extractor configuration, input fingerprint, and
  coverage counters.
- `pre_write_inventory.json` — helper-side inventory of the source report's
  `data/` files before local output was staged.
- `README.md` — self-description for this local run.
- `upload_staging/` — a copy containing only files in the canonical upload
  allowlist.

Phase B may later add:

- `review_scores_replayed.ndjson`
- `replay_metadata.json`
- `validation_summary.json`

Those names are already allowlisted, but the Phase A helper does not generate
them.

## Uploading to Drive

The shared target convention is:

```text
<CHIEF_PERF_DRIVE_PREFIX>/<dev-handle>/<run-id>/
```

By default:

```text
~/Library/CloudStorage/[external-email]/Shared drives/Product/droid-performance-backfills/<dev-handle>/<run-id>/
```

At the end of a successful run the helper prints a one-line command like:

```bash
rsync -a ~/.factory/chief-perf-backfills/<run-id>/upload_staging/ \
  "<Drive prefix>/<dev-handle>/<run-id>/"
```

Review `upload_staging/` first, then copy the command. The helper never invokes
`rsync`, `scp`, Drive APIs, or any other upload mechanism on its own.

## Activating the backfill in a report

The bash helper produces a local backfill directory but does NOT regenerate the
analysis report. To actually surface the backfilled rows in `Q11.html` and
`index.html` (data-health), re-run the analyzer with `--backfill-source`:

```bash
cd coding-agent-instructions/scripts
PYTHONPATH=. python -c "from chief_perf_v2 import main; import sys; sys.exit(main([
  '--rebuild-html-from', '<analysis run dir>',
  '--backfill-source', '<your local backfill output dir, OR the shared Drive prefix>',
  '--no-packets',
]))"
```

The `--backfill-source` flag accepts:

- `none` (default) — canonical-only, no backfill activation.
- `auto` — discover backfill runs from `<analysis-run-dir>/backfill_runs/` AND the
  `CHIEF_PERF_DRIVE_PREFIX` default.
- An explicit path — walked recursively, so pointing it at
  `<Drive>/droid-performance-backfills/` aggregates every developer's uploaded
  bundle in one analyzer invocation.

The optional `--backfill-since YYYY-MM-DD` flag skips runs whose
UTC-ms-timestamp directory name is older than the cutoff.

The Q11 confidence tooltip and the data-health caveat row will show
`N = {total} review-score rows: {canonical} from canonical Chief signal collection
+ {backfilled} reconstructed via Stage 1 backfill ...` so readers know exactly
how the headline N was assembled.

### Multi-developer aggregation

Each developer runs `scripts/chief-perf-backfill.sh --auto-discover` on their own
machine and copies the staged output via the printed `rsync` command into
`<Drive>/droid-performance-backfills/<dev-handle>/<run-id>/`. To analyze the
union, point `--backfill-source` at the shared backfills prefix:

```bash
--backfill-source "/path/to/Shared drives/Product/droid-performance-backfills/"
```

`backfill_loader.discover_backfill_runs()` walks the prefix recursively, picks
up every `<dev>/<run-id>/` subdir that contains a non-empty
`review_scores_backfilled.ndjson`, skips any with the `INCOMPLETE_RUN.txt`
tombstone, dedupes on `reviewer_raw`, and merges them. The cross-tooltip caveat
will reflect the aggregated count.

## Verifying success

Check the staged file list:

```bash
find ~/.factory/chief-perf-backfills/<run-id>/upload_staging -maxdepth 1 -type f -print | sort
```

Check row count:

```bash
wc -l ~/.factory/chief-perf-backfills/<run-id>/review_scores_backfilled.ndjson
```

Check metadata:

```bash
python3 -m json.tool ~/.factory/chief-perf-backfills/<run-id>/backfill_metadata.json | head -80
```

Expected sanity signals:

- `stats.rows_emitted` is non-zero for machines with matching local Factory data.
- `config.analysis_run_dir` points at the report you intended.
- `config.factory_sessions_dir` points at this repo's Factory session directory.
- `upload_staging/` contains only the allowlisted files.

## Re-running

Re-run when:

- A new chief_perf_v2 report is generated.
- Local Factory sessions have accumulated since the previous backfill.
- The Stage 1 extractor changes.
- Phase B replay support ships and the team explicitly gates it on.

The underlying extractor supports `--skip-if-unchanged`. The helper passes that
flag through, but because helper runs use timestamped output directories, a new
manual run still gets its own local directory. Treat repeated runs as immutable
snapshots; upload the newest intended run and leave older local runs alone unless
you have a separate cleanup task.

## Privacy

Raw Factory session JSONLs stay local. They can include reviewer prose, internal
prompts, and intermediate Chief messages. Do not upload `~/.factory/sessions/`,
`*.jsonl`, debug logs, `.env` files, or ad-hoc scratch output.

The upload allowlist lives in
[`upload_allowlist.py`](../../coding-agent-instructions/scripts/chief_perf_v2/upload_allowlist.py).
The helper stages by iterating that Python tuple through
[`upload_staging.py`](../../coding-agent-instructions/scripts/chief_perf_v2/upload_staging.py);
there is no recursive copy and no glob-based upload step. Tests assert raw
session files and debug logs are not staged.

## Promotion rules

Backfilled Stage 1 rows are reviewer-observed evidence, not Chief-adjudicated
truth. Promotion from illustrative panels to decision-grade headline numbers is
governed by
[`§6.C Promotion rules`](../plans/260515_chief_perf_stage2_replay_stage3_doc_q5b_all_analyses.md#6c-promotion-rules-decision-grade-vs-illustrative-governance).

In short: Phase A can expand confidence/coverage-style views, but accepted /
rejected / uniqueness claims need the appropriate adjudication tier.

## Phase B gate criteria

Phase B is gated by
[`§6.B`](../plans/260515_chief_perf_stage2_replay_stage3_doc_q5b_all_analyses.md#6b-phase-b--cross_model_adjudication--chief-dependent-lift-gated).
Before enabling replay-generated outputs, confirm:

- The replay/adjudication implementation exists and has deterministic tests.
- Budget controls and row-level replay deltas are in place.
- `validation_summary.json` binds to the replay model, prompt version, prompt
  timestamp, and input/output fingerprints.
- Sanity checks pass against the agreed ground-truth conversations.
- The user/team has made the explicit post-Phase-A go/no-go decision.
