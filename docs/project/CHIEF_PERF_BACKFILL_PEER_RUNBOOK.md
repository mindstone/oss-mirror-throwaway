---
description: "Step-by-step runbook for any developer to contribute Stage 1 backfill rows to the shared chief_perf report"
last_updated: "2026-05-15"
audience: "Any Mindstone developer with local Factory CLI history. Hand this doc (or its path) to your coding agent (Droid / Claude Code / Cursor) to run the workflow for you."
dependencies:
  - "./CHIEF_PERF_BACKFILL.md"
  - "../plans/260515_chief_perf_stage2_replay_stage3_doc_q5b_all_analyses.md"
  - "../../scripts/chief-perf-backfill.sh"
---

# Chief-perf backfill — peer-developer runbook

## What we're trying to do

The chief-performance analyzer reads Chief signal collection files (`[REVIEW-SCORE]` lines etc.) to score reviewer / implementer / specialist performance across the team's CHIEF_ENGINEER work. Historically only **canonical** rows survive — about **368** for a 32-day window when Greg is the only contributor.

Recent work (Phase A of the chief_perf v2 data-recovery workstream — see [`260515_chief_perf_stage2_replay_stage3_doc_q5b_all_analyses.md`](../plans/260515_chief_perf_stage2_replay_stage3_doc_q5b_all_analyses.md)) added a **Stage 1 backfill**: reviewer-observed rows are reconstructed from each developer's local Factory CLI session JSONLs at `~/.factory/sessions/`. On Greg's machine alone Stage 1 added another **504** rows for a **2.4x N lift**. The remaining ~131 CHIEF sessions in the 32-day window happened on someone else's machine, so the N lift compounds when other devs contribute their own backfills.

**Your job**: run the local extractor on your machine and rsync the staged output to the shared Drive. That's it. The analyzer takes care of aggregation automatically.

**Privacy**: raw Factory session JSONLs (which include reviewer prose, internal prompts, intermediate Chief messages) **stay on your machine**. Only allowlisted output files (extracted review-score rows + metadata + a per-run README) get staged for upload. The exact allowlist is enforced in code: [`upload_allowlist.py`](../../coding-agent-instructions/scripts/chief_perf_v2/upload_allowlist.py).

## Prerequisites

- Bash, macOS or Linux (script uses `printf %q`, `bash` arrays, and BSD-compatible `date -u +%Y%m%d%H%M%S` — both portable). Windows untested.
- Python 3.10+ available as `python3`.
- A local Factory sessions directory for this repo at `~/.factory/sessions/-Users-<you>-<...>-rebel-app/`.
- The rebel-app repo cloned somewhere on your machine.
- Google Drive desktop sync for `Shared drives/Product/`. The default upload prefix is `<Drive>/Product/droid-performance-backfills/<your-handle>/<run-id>/` under your `[external-email]`-style cloud sync; if your sync mount uses a different email, set `CHIEF_PERF_DRIVE_PREFIX` and `CHIEF_PERF_REPORTS_PREFIX` env vars (see [`CHIEF_PERF_BACKFILL.md`](./CHIEF_PERF_BACKFILL.md) § Prerequisites).
- About 1-2 minutes of compute.

## The runbook (5 steps)

### 1. Pull the latest dev branch

```bash
cd /path/to/rebel-app
git status            # MUST be clean (no uncommitted work)
git checkout dev
npx tsx scripts/git-safe-sync.ts --no-push    # safe sync; honours submodule integrity
```

If your repo doesn't have `tsx` available, fall back to `git pull --ff-only origin dev && git submodule update --init --recursive` (this repo enforces `pull.ff=only`, so the `--ff-only` flag is redundant but explicit). The submodule `coding-agent-instructions/` contains the analyzer code; it has to be in sync with `dev` for the helper to find the right Python modules.

### 2. Locate the latest analysis report

The bash helper reads from an existing chief_perf_v2 analysis report (someone — usually Greg — generates one every few days). To auto-discover the most recent run:

```bash
ls -t "$HOME/Library/CloudStorage/GoogleDrive-<your email>/Shared drives/Product/droid-performance-reports/" | head -5
```

You should see directories named like `260514_1328_chief_perf_32d`. Pick the most recent one. If you don't see any, ask in Slack `#chief-engineer` (a fresh report needs to be generated first — see [`CHIEF_PERF_BACKFILL.md`](./CHIEF_PERF_BACKFILL.md) § Re-running for the analyzer command, or just ask Greg).

### 3. Run the backfill helper

**Dry run first** (sanity check):

```bash
CHIEF_PERF_REPORTS_PREFIX="$HOME/Library/CloudStorage/GoogleDrive-<your email>/Shared drives/Product/droid-performance-reports" \
  bash scripts/chief-perf-backfill.sh --auto-discover --dry-run
```

Expected output (numbers will differ):

```text
Privacy notice: raw Factory session JSONLs stay local. ...
Resolved configuration:
  repo:             /path/to/rebel-app
  analysis run dir: /path/to/.../260514_1328_chief_perf_32d
  dev handle:       <you>
  output dir:       ~/.factory/chief-perf-backfills/<UTC-ts>-<you>
  staging dir:      ~/.factory/chief-perf-backfills/<UTC-ts>-<you>/upload_staging
  allowlist:        review_scores_backfilled.ndjson, backfill_metadata.json, ...

INFO Found 210 CHIEF_ENGINEER sessions in analysis run
INFO N / 210 CHIEF sessions have local Factory data
INFO DRY RUN — would write N rows to .../review_scores_backfilled.ndjson
INFO   rows_emitted:               N
INFO   confidence_parsed:          N  (XX%)
INFO   issues_parsed:              N  (XX%)
Dry run complete.
```

If `N / 210 CHIEF sessions have local Factory data` is **0**, your local Factory history doesn't overlap the window — talk to Greg / try a wider window. If it's >5, you have signal to contribute.

**Real run** (drops `--dry-run`):

```bash
CHIEF_PERF_REPORTS_PREFIX="$HOME/Library/CloudStorage/GoogleDrive-<your email>/Shared drives/Product/droid-performance-reports" \
  bash scripts/chief-perf-backfill.sh --auto-discover
```

This produces a local output directory under `~/.factory/chief-perf-backfills/<run-id>/` containing the extracted NDJSON + metadata + a `upload_staging/` subdir with only the allowlisted files.

### 4. Inspect the staged output

```bash
ls -la ~/.factory/chief-perf-backfills/<run-id>/upload_staging/
```

Expected contents (and nothing else):

```text
README.md
backfill_metadata.json
pre_write_inventory.json
review_scores_backfilled.ndjson
```

Sanity-check counts:

```bash
wc -l ~/.factory/chief-perf-backfills/<run-id>/review_scores_backfilled.ndjson
python3 -m json.tool ~/.factory/chief-perf-backfills/<run-id>/backfill_metadata.json | head -80
```

Look for `stats.rows_emitted` non-zero and `config.analysis_run_dir` pointing at the right report.

### 5. Copy to the shared Drive

The helper prints the exact rsync command at the end of step 3. It looks like:

```bash
rsync -a ~/.factory/chief-perf-backfills/<run-id>/upload_staging/ \
  "<Drive>/Product/droid-performance-backfills/<your-handle>/<run-id>/"
```

Review the printed target path. If it looks right, copy-paste the command and run it. **The helper never uploads automatically**; this is a deliberate human-in-the-loop checkpoint.

That's it. Once the rsync completes and Google Drive desktop sync finishes uploading, Greg (or whoever next runs the analyzer with `--backfill-source auto`, which is the default since A8) will pick up your contribution.

## How to interpret your local output

The `INFO` lines in step 3 are the most useful signal:

| Stat | What it means | Healthy range |
|---|---|---|
| `analysis_run_chief_sessions` | Total CHIEFs in the report you targeted | (varies) |
| `local_factory_sessions_processed` | CHIEFs whose Factory JSONLs are on your disk | depends on team / window |
| `analysis_chiefs_without_local_data` | CHIEFs on other people's machines | the bigger this is, the more team coverage matters |
| `reviewer_task_calls_found` | Reviewer Task tool calls extracted | should be ~10x the canonical row count for your sessions |
| `child_jsonls_linked` | Reviewer Task calls successfully traced to a child JSONL | aim for >95% |
| `rows_emitted` | Final NDJSON row count | (raw) |
| `confidence_parsed` | Rows where reviewer confidence score parsed cleanly | aim for >80% |
| `issues_parsed` | Rows where issues structure parsed | (lower is fine) |
| `phase_inferred` / `mode_inferred` / `stage_id_inferred` | Best-effort heuristics for these fields | (lower is fine; canonical rows are authoritative for these) |

## Debugging

### "Python executable not found"

Set `PYTHON=/path/to/python3` in front of the bash command.

### "ERROR: analysis run dir does not exist"

Either you don't have Google Drive synced for the `Shared drives/Product/` folder, or you're pointing at the wrong email. Inspect:

```bash
ls "$HOME/Library/CloudStorage/"
```

Set `CHIEF_PERF_REPORTS_PREFIX` to the right path (must end with `droid-performance-reports`).

### `local_factory_sessions_processed: 0`

Your Factory CLI sessions directory doesn't overlap the analysis window. Check:

```bash
ls ~/.factory/sessions/ | head -5
# Each directory is a per-repo session store. Find the rebel-app one:
ls ~/.factory/sessions/-Users-<you>-<...>-rebel-app/ | head -5
```

If empty, you haven't used Factory CLI on this repo (so you have nothing to contribute — that's fine). If non-empty but the date range doesn't match, ask for a wider analysis window.

### "TypeError: '<' not supported between instances of dict and dict"

You're on an older `dev` checkout. Pull again — `scripts/chief-perf-backfill.sh` was fixed for this in commit `62d075567`.

### "TruffleHog blocked a commit"

You shouldn't be committing anything as part of this workflow — only running the script and rsync'ing to the shared Drive. If TruffleHog fires, you're committing something unrelated; investigate separately.

### The staging dir contains files you didn't expect

Compare the staged file list against the allowlist:

```bash
PYTHONPATH=coding-agent-instructions/scripts \
  python3 -c "from chief_perf_v2.upload_allowlist import COPY_ALLOWLIST; print(*COPY_ALLOWLIST, sep='\n')"
```

If files outside the allowlist appear, that's a bug — open an issue and DO NOT rsync until it's resolved.

### Phase B (`--with-replay`) — accepted but no-op

`--with-replay` is parsed for forward compatibility; Phase A is reviewer-only and does not run replay. Ignore it.

## Privacy & trust boundaries

- **What stays local**: `~/.factory/sessions/**/*.jsonl` (raw transcripts), debug logs, any `.env` files.
- **What gets staged**: the four files listed in [`upload_allowlist.py`](../../coding-agent-instructions/scripts/chief_perf_v2/upload_allowlist.py) — review-score NDJSON, backfill metadata, source-data inventory, run README.
- **The script refuses**: symlinks named like allowlisted files (defense against raw-JSONL smuggling), case-variant filenames (defense against HFS+/NTFS case-collapse bypass), directories named like allowlisted files. See [`upload_staging.py`](../../coding-agent-instructions/scripts/chief_perf_v2/upload_staging.py) and `test_upload_allowlist.py`.
- **Allowlist evolves**: if the allowlist needs a new file added, that requires a code change + Security specialist review. Don't manually add files to the staging dir between staging and rsync.

## Why your contribution matters

The Q11 per-user table and the index data-health card already use the combined canonical + backfilled rows. The more devs contribute, the better the report covers the actual team. Backfilled rows have parsed reviewer score, model, and confidence — but **no Chief synthesis** (accepted / rejected counts, finding IDs, Chief-only fields). The analyses migrated to use the union (Q11 + data-health) handle this distinction explicitly via the caveat tooltip. Other analyses (Q1, Q4, Q8, Q12, Q13) stay canonical-only because they depend on the Chief synthesis fields.

For the Chief-adjudicated story (Q4 DA vs std, etc.), the team will eventually need **Phase B** (cross-model adjudication), which replays each reviewer's finding through a different model. That's a separate workstream, gated on Phase A having team-wide adoption first.

## Questions

- Workflow doc maintainer: see [`CHIEF_PERF_BACKFILL.md`](./CHIEF_PERF_BACKFILL.md) for the operator-oriented version
- Implementation details: see [`260515_chief_perf_stage2_replay_stage3_doc_q5b_all_analyses.md`](../plans/260515_chief_perf_stage2_replay_stage3_doc_q5b_all_analyses.md)
- Extractor reference: see [`coding-agent-instructions/scripts/chief_perf_v2/BACKFILL.md`](../../coding-agent-instructions/scripts/chief_perf_v2/BACKFILL.md)
- Slack: `#chief-engineer`
