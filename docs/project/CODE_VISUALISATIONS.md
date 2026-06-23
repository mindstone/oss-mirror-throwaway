---
description: "Git-history visualisation guide — commit cadence, churn trends, per-author totals, plotting scripts, counting caveats"
last_updated: "2026-06-06"
---

# Code Visualisations

Charts of git history — who's committing, how much code is moving, and how that
changes over time. These complement the static line-of-code counts in
[CODE_METRICS.md](CODE_METRICS.md) (which is about *how big* the codebase is right
now) by showing *activity over time*.

## See Also

- [CODE_METRICS.md](CODE_METRICS.md) — Static LOC counting with `scc`
- [CODE_HEALTH_TOOLS.md](CODE_HEALTH_TOOLS.md) — Knip, Madge, bundle analysis
- `scripts/git-activity-over-time.py` — Daily commits + churn time-series (this doc)
- `scripts/git-loc-by-author.py` — Per-author totals as a horizontal bar chart


## Prerequisites

The plotting scripts are Python and need a few scientific libraries:

```bash
pip install matplotlib pandas scipy
```

(`numpy` comes in transitively.) No `scc` needed — these read git history directly.


## Activity over time — `git-activity-over-time.py`

Plots **two metrics**, each as its own chart, over a recent window:

1. **Commits per day** — raw cadence of commits.
2. **Code churned per day** — lines added + deleted (a proxy for volume of change).

Each chart draws **two series** — one highlighted author ("mine") versus everyone —
with a faint scatter point for each day overlaid by a Gaussian-smoothed trend line
(σ ≈ 4 days) so the underlying rhythm is readable through the day-to-day noise.

### Quick Start

```bash
# Last 6 months, both charts, written to the current directory
./scripts/git-activity-over-time.py

# Highlight a specific author (email or name); default = git config user.email
./scripts/git-activity-over-time.py --author [external-email] --author-label Greg

# Last 12 months
./scripts/git-activity-over-time.py --since "12 months ago"

# Only one metric
./scripts/git-activity-over-time.py --metric commits
./scripts/git-activity-over-time.py --metric churn

# Write the PNGs somewhere else
./scripts/git-activity-over-time.py --out-dir ~/Desktop

# Show interactively instead of saving
./scripts/git-activity-over-time.py --show
```

### Output

Two PNGs in `--out-dir` (default current directory):

- `git-commits-per-day.png`
- `git-churn-per-day.png`

### Options

| Flag | Default | Meaning |
|------|---------|---------|
| `--since` | `"6 months ago"` | Start of the window (any git `--since` value) |
| `--until` | now | End of the window |
| `--author` | `git config user.email` | Email **or** name to highlight as "mine" |
| `--author-label` | `Mine` | Legend label for the highlighted author |
| `--metric` | `both` | `commits`, `churn`, or `both` |
| `--no-merges` | off | Exclude merge commits from the **commits** chart (churn always excludes them) |
| `--repo` | `.` | Path to the git repo |
| `--out-dir` | `.` | Directory to write PNGs into |
| `--show` | off | Display interactively instead of saving |

### What's counted, and the gotchas

These choices matter a lot for what the charts say — read before drawing conclusions:

1. **"Mine" is matched on author email or name** (case-insensitive). The default is
   `git config user.email`. Note a person can have several git identities — e.g. in
   this repo Greg's commits are authored as `[external-email]`, not
   `[Mindstone-email]`. Pass `--author` explicitly if the default has no commits.

2. **Commits chart includes merge commits by default.** This repo syncs `dev` very
   frequently, so merges are a large share of commit count (≈80/day total is mostly
   sync merges, not features). Pass `--no-merges` for a feature-cadence view. The
   churn chart **always** uses `--no-merges` — numstat on a merge is empty or
   double-counts.

3. **Churn excludes generated / vendored / machine-authored paths.** Raw churn is
   dominated by million-line single-day spikes that are *not* hand-written code:
   lockfiles, `dist/`/`build/`/`node_modules/`, minified bundles and sourcemaps,
   test snapshots, and — by far the biggest in this repo — **AI conversation
   transcript dumps** (`.factory/conversations/`, `docs/conversations/droid-exports/`).
   These are filtered out (see `CHURN_NOISE` in the script) and the excluded line
   total is printed and annotated on the chart for transparency. In a recent 6-month
   window this removed ~10.7M of ~17.3M churned lines.

4. **Submodules are excluded** (`rebel-system`, `super-mcp`, `coding-agent-instructions`)
   — they have their own history. This matches `git-loc-by-author.py`, and means the
   commit count here is lower than a naive `git log | wc -l` run at the repo root.

5. **Smoothing is cosmetic.** The σ≈4-day Gaussian line is for reading the trend; the
   scatter points are the real per-day values. Edit `SMOOTH_SIGMA` in the script to
   change the smoothing window.


## Per-author totals — `git-loc-by-author.py`

A horizontal bar chart of lines added (green) / deleted (red) per author over a
window — answers "who changed how much," not "when." See the script's docstring for
usage; it shares the author-alias and submodule-exclusion conventions with the
time-series script above.

```bash
./scripts/git-loc-by-author.py --since "6 months ago" -o by-author.png
```
