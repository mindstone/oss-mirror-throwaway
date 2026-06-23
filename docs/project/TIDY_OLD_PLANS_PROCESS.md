---
description: "Periodic cleanup process for docs/plans/ — age cutoffs, MiniMax batch classification, destination folders, move commits"
last_updated: "2026-05-14"
---

# Tidy Up Old Plans Process

Periodic cleanup of `docs/plans/` — move planning docs older than ~6 weeks into `finished/`, `obsolete/`, or `partway/` subfolders so the top-level stays focused on what's actually in motion.

The work is delegated to **MiniMax** subagents in parallel for cost efficiency (~$0.20 per 100 plans). The orchestrator (this droid) collects classifications, applies `git mv` operations, and commits one wave at a time.

## When to run

Ad-hoc when `docs/plans/` top level has grown unwieldy (rule of thumb: > ~1000 entries). The user invokes the process by asking for tidy-up; no automatic schedule.

## Defaults

| Setting | Default | Override |
|---|---|---|
| **Cutoff** | Plans older than 6 weeks (by filename `yyMMdd_` prefix) | User may say "older than N months" or specify a date |
| **Folder layout** | `finished/`, `obsolete/`, `partway/` | Use whatever already exists (e.g. `obsolete/` not `discarded/`) |
| **Batch size** | 10 plans per subagent | Increase to 20-30 if the volume is large and you don't mind less granular retries |
| **Parallelism** | 10 subagents per wave | Each wave = one commit |
| **Bias** | "When in doubt → `finished/`" | User may override |
| **Subagent** | `reviewer-minimax2.7` (MiniMax, cheaper) | `reviewer-gpt5.5-high` for accuracy-critical runs |

## Process

### 1. Enumerate plans past the cutoff

Plans use `yyMMdd_` filename prefixes (also accept legacy `YYYY-MM-DD-` prefixes). Filter by **filename date** (the authority — file mtime is unreliable due to checkouts):

```bash
cutoff=YYMMDD  # 6 weeks ago, e.g. 260401 for today=260513
cd docs/plans
ls -1 *.md | awk -v c="$cutoff" '
  match($0, /^[0-9]{6}/)         { if (substr($0, RSTART, 6) < c) print; next }
  match($0, /^[0-9]{4}-[0-9]{2}-[0-9]{2}/) {
    p=substr($0, RSTART, 10); print substr(p,3,2) substr(p,6,2) substr(p,9,2) " " $0
  }
' > /tmp/plans_to_process.txt
```

### 2. Split into batches

```bash
mkdir -p /tmp/plans_batches /tmp/plan_results
split -l 10 -d -a 3 /tmp/plans_to_process.txt /tmp/plans_batches/batch_
```

### 3. Dispatch subagents in waves

Run **10 parallel subagent calls per wave** (`reviewer-minimax2.7`). Each gets one batch file path and writes results to `/tmp/plan_results/batch_NNN.json`.

**Prompt template:**

```
## Goal
Classify N planning docs as `finished`, `obsolete`, or `partway`. Write result JSON to `/tmp/plan_results/batch_NNN.json` via Execute.

## Inputs
- Batch file: `/tmp/plans_batches/batch_NNN`
- Plans dir: <repo>/docs/plans/
- Repo root: <repo>

## Rules
- **finished**: enacted (code exists, commits reference it, plan complete)
- **obsolete**: never enacted/superseded/abandoned
- **partway**: clear partial implementation
- **Bias**: when in doubt → `finished`

## Investigate per file (~30s each)
1. Skim plan's first 100 lines for status markers
2. `git log --all --oneline -- 'docs/plans/<filename>' | head -3`
3. Grep src/ for feature keywords if still unclear

## CRITICAL OUTPUT
Use Execute. Use keys EXACTLY: `file`, `destination`, `reason`.
`destination` MUST be one of: `finished`, `obsolete`, `partway` (no prefix, no synonyms).

cat > /tmp/plan_results/batch_NNN.json << 'JSON_EOF'
[ ... N entries ... ]
JSON_EOF
python3 -c "import json; d=json.load(open('/tmp/plan_results/batch_NNN.json')); assert all(e['destination'] in {'finished','obsolete','partway'} for e in d); print(len(d))"

Final response: "DONE". Do NOT summarize.
```

### 4. Normalize results

MiniMax is unreliable about output keys. Run a normalization pass before applying moves (see "MiniMax reliability" below):

```python
import json, re, os
valid = {'finished', 'obsolete', 'partway'}
synonyms = {'enacted':'finished','completed':'finished','done':'finished','shipped':'finished',
            'abandoned':'obsolete','discarded':'obsolete','superseded':'obsolete',
            'partial':'partway','in_progress':'partway','in-progress':'partway'}
for f in sorted(os.listdir('/tmp/plan_results')):
    path = f'/tmp/plan_results/{f}'
    data = json.load(open(path))
    fixed = []
    for e in data:
        new = {
            'file': e.get('file') or e.get('filename') or e.get('plan') or '',
            'destination': e.get('destination') or e.get('status') or e.get('classification') or '',
            'reason': e.get('reason') or e.get('notes') or e.get('rationale') or '',
        }
        d = new['destination']
        d = re.sub(r'^docs/plans/', '', d)
        new['destination'] = synonyms.get(d.lower(), d)
        fixed.append(new)
    json.dump(fixed, open(path,'w'), indent=2)
```

### 5. Apply moves and commit per wave

Reusable script: `/tmp/apply_wave.sh` (recreate per run; not checked in). It does `git mv` from `docs/plans/<file>` → `docs/plans/<destination>/<file>`, creating subfolders as needed — follow [`rebel-system/skills/system/rename-or-move-and-update-references/SKILL.md`](../../rebel-system/skills/system/rename-or-move-and-update-references/SKILL.md) for the underlying rename discipline (prefer `git mv`, confirm old paths are gone, etc.).

Most planning docs are not heavily cross-referenced, so reference updates are usually unnecessary. If you do find stale links pointing at moved plans, use `sd` (literal-string mode with `--preview` first) to update them — see [`rebel-system/skills/utilities/sd-string-displacement-find-replace/SKILL.md`](../../rebel-system/skills/utilities/sd-string-displacement-find-replace/SKILL.md).

Commit each wave separately so the per-wave rename diffs stay reviewable. **Stage only the renames** — do not use `git add -A` (other agents' WIP may be in the working tree):

```bash
cd <repo>
git diff --cached --name-status | awk '{print $1}' | sort | uniq -c  # sanity: should be all R100
git commit -m "chore(docs/plans): Move N old plans into finished/obsolete/partway subfolders (wave X of Y). ..."
```

Don't push automatically — leave that to the user.

## MiniMax reliability — known gotchas

Of ~50 MiniMax batch calls in the 990-plan reference run:

- **~5%** wrote `status` / `classification` instead of `destination`.
- **~5%** wrote `filename` / `plan` instead of `file`.
- **~5%** wrote synonyms (`enacted`, `completed`, `abandoned`) instead of the literal `finished`/`obsolete`/`partway`.
- **~5%** prefixed destinations with `docs/plans/` (e.g. `docs/plans/finished`).
- **~2%** claimed they wrote a file but didn't (silent skip).
- **~1%** reported a file write was "blocked" when it wasn't — needed a retry with a hint that Execute does allow `/tmp` writes.
- **~30%** ignored the "do NOT summarize" instruction and returned a chatty response anyway (harmless, just noisy).

Ideas to try next time for better reliability:

1. **Send a JSON skeleton with placeholder values.** Pre-fill `{"file": "<filename>", "destination": "TBD", "reason": "TBD"}` for each row and ask the subagent to only mutate the `destination` and `reason` fields. This removes the key-naming variance entirely.
2. **Strict-enum validator in the prompt.** Add an inline `python3 -c "..."` that fails loudly on synonyms, so the subagent retries before responding `DONE`.
3. **One file per plan** instead of one JSON per batch. The subagent writes `/tmp/plan_results/<plan>.txt` with just `finished\n<reason>`. Simpler format → fewer schema errors. Trade-off: 10× more files to read back.
4. **Use a stricter MiniMax variant** (or `reviewer-gpt5.5-high`) for the first attempt and only fall back to MiniMax for retries — but you lose the cost savings.
5. **Examples in the prompt.** Include 2-3 fully-formed example JSON entries demonstrating the exact key names and destination values. MiniMax follows examples better than rules.

The normalization step in step 4 already absorbs ~all of the observed variance, so this is a "would be nicer" rather than "must fix".

## Reference run

The first execution of this process (2026-05-13) tidied **990 plans** older than 2 months across 5 commits on `dev` (58ae2577c, 85e3aad7c, 9b9d73971, 049ec2c6d, 391b9600e). Distribution:

- finished/: 681 added (870 total)
- obsolete/: 148 added (190 total)
- partway/: 157 added (157 total — folder created in wave 1)
