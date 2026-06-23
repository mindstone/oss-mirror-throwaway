#!/usr/bin/env python3
"""
git-activity-over-time.py - Plot git activity per day over a recent window

Two series on each chart: one highlighted author ("mine") vs everyone. Each day
is shown as a faint scatter point, overlaid with a Gaussian-smoothed trend line.

Complements scripts/git-loc-by-author.py (which is a per-author bar chart of
totals). This one is a time-series of daily *cadence*.

USAGE:
    # Last 6 months, both charts (commits/day + churn/day), saved as PNGs
    ./scripts/git-activity-over-time.py

    # Last 12 months
    ./scripts/git-activity-over-time.py --since "12 months ago"

    # Highlight a specific author (email or name); default = git config user.email
    ./scripts/git-activity-over-time.py --author [external-email]

    # Only one metric
    ./scripts/git-activity-over-time.py --metric commits
    ./scripts/git-activity-over-time.py --metric churn

    # Write the PNGs somewhere else (e.g. the Desktop)
    ./scripts/git-activity-over-time.py --out-dir ~/Desktop

    # Show interactively instead of saving
    ./scripts/git-activity-over-time.py --show

PREREQUISITES:
    pip install matplotlib pandas scipy
    (numpy comes in with pandas/scipy)

OUTPUT (in --out-dir, default current directory):
    - git-commits-per-day.png
    - git-churn-per-day.png

NOTES:
    - "Mine" defaults to the author whose email matches `git config user.email`.
      Match is case-insensitive against both author email and author name, so a
      name like "Team Member" also works.
    - COMMITS chart counts every commit by default (including merges), matching a
      naive `git log | wc -l`. Pass --no-merges to drop merge commits.
    - CHURN chart always uses --no-merges (numstat on merge commits is empty or
      double-counts) and excludes generated / vendored / AI-transcript paths that
      otherwise produce million-line single-day spikes that flatten the signal.
      The excluded total is printed and annotated on the chart for transparency.
    - Submodules are excluded (they have their own history), matching
      git-loc-by-author.py.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

# Paths treated as generated / vendored / machine-authored rather than
# hand-written code churn. These dominate raw churn with bulk add/delete events
# (lockfile regen, dependency vendoring, snapshot updates, AI conversation dumps).
CHURN_NOISE = re.compile(
    r"(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|"
    r"composer\.lock|Gemfile\.lock|go\.sum|\.lock$|"
    r"(^|/)node_modules/|(^|/)dist/|(^|/)build/|(^|/)out/|(^|/)\.next/|"
    r"(^|/)vendor/|(^|/)third_party/|"
    r"\.min\.(js|css)$|\.map$|\.snap$|"
    r"(^|/)__snapshots__/|(^|/)fixtures?/|(^|/)\.yarn/|"
    r"(^|/)\.factory/conversations/|(^|/)conversations/droid-exports/|"
    r"(^|/)docs/conversations/)"
)

# Submodules to exclude from both metrics (same list as git-loc-by-author.py).
SUBMODULE_EXCLUDES = [":!rebel-system", ":!super-mcp", ":!coding-agent-instructions"]

ALL_COLOR = "#1f77b4"
MINE_COLOR = "#d62728"
SMOOTH_SIGMA = 4  # days; Gaussian kernel width for the trend line


def git(repo: str, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", repo, *args], capture_output=True, text=True, check=True
    ).stdout


def default_author(repo: str) -> str:
    try:
        return git(repo, "config", "user.email").strip()
    except subprocess.CalledProcessError:
        return ""


def is_mine(email: str, name: str, needle: str) -> bool:
    n = needle.lower()
    return n in (email.lower(), name.lower())


def date_range(dates):
    import pandas as pd

    return pd.date_range(min(dates), max(dates), freq="D")


def get_commits(repo, since, until, no_merges, author):
    """Return (idx, all_daily, mine_daily) Series of commit counts per day."""
    import pandas as pd

    cmd = ["log", "--date=short", "--format=%ad%x09%ae%x09%aN"]
    if no_merges:
        cmd.append("--no-merges")
    if since:
        cmd.append(f"--since={since}")
    if until:
        cmd.append(f"--until={until}")
    cmd += ["--", ".", *SUBMODULE_EXCLUDES]

    all_dates, mine_dates = [], []
    for line in git(repo, *cmd).splitlines():
        if not line:
            continue
        d, email, name = line.split("\t", 2)
        all_dates.append(d)
        if is_mine(email, name, author):
            mine_dates.append(d)

    if not all_dates:
        return None

    idx = date_range(pd.to_datetime(all_dates))
    all_daily = pd.to_datetime(pd.Series(all_dates)).value_counts().reindex(idx, fill_value=0).sort_index()
    mine_daily = pd.to_datetime(pd.Series(mine_dates)).value_counts().reindex(idx, fill_value=0).sort_index()
    return idx, all_daily, mine_daily


def get_churn(repo, since, until, author):
    """Return (idx, all_daily, mine_daily, excluded) Series of lines churned/day."""
    import pandas as pd

    cmd = ["log", "--no-merges", "--date=short", "--numstat", "--format=C%x09%ad%x09%ae%x09%aN"]
    if since:
        cmd.append(f"--since={since}")
    if until:
        cmd.append(f"--until={until}")
    cmd += ["--", ".", *SUBMODULE_EXCLUDES]

    all_rows, mine_rows = [], []
    excluded = 0
    cur_date, cur_mine = None, False
    for line in git(repo, *cmd).splitlines():
        if line.startswith("C\t"):
            _, cur_date, email, name = line.split("\t", 3)
            cur_mine = is_mine(email, name, author)
        elif line and "\t" in line:
            added, deleted, path = line.split("\t", 2)
            if not (added.isdigit() and deleted.isdigit()):
                continue  # binary file (shown as "-")
            churn = int(added) + int(deleted)
            if CHURN_NOISE.search(path):
                excluded += churn
                continue
            all_rows.append((cur_date, churn))
            if cur_mine:
                mine_rows.append((cur_date, churn))

    if not all_rows:
        return None

    all_df = pd.DataFrame(all_rows, columns=["date", "churn"])
    mine_df = pd.DataFrame(mine_rows, columns=["date", "churn"])
    all_df["date"] = pd.to_datetime(all_df["date"])
    mine_df["date"] = pd.to_datetime(mine_df["date"]) if not mine_df.empty else mine_df

    idx = date_range(all_df["date"])
    all_daily = all_df.groupby("date")["churn"].sum().reindex(idx, fill_value=0).sort_index()
    if mine_df.empty:
        mine_daily = all_daily * 0
    else:
        mine_daily = mine_df.groupby("date")["churn"].sum().reindex(idx, fill_value=0).sort_index()
    return idx, all_daily, mine_daily, excluded


def plot_series(idx, all_daily, mine_daily, *, title, ylabel, author_label, summary, out_path, show):
    import matplotlib.dates as mdates
    import matplotlib.pyplot as plt
    from scipy.ndimage import gaussian_filter1d

    all_smooth = gaussian_filter1d(all_daily.values.astype(float), sigma=SMOOTH_SIGMA)
    mine_smooth = gaussian_filter1d(mine_daily.values.astype(float), sigma=SMOOTH_SIGMA)

    fig, ax = plt.subplots(figsize=(14, 7))
    ax.scatter(idx, all_daily.values, s=14, alpha=0.30, color=ALL_COLOR, label="Everyone (daily)")
    ax.scatter(idx, mine_daily.values, s=14, alpha=0.30, color=MINE_COLOR, label=f"{author_label} (daily)")
    ax.plot(idx, all_smooth, color=ALL_COLOR, lw=2.5, label="Everyone (smoothed)")
    ax.plot(idx, mine_smooth, color=MINE_COLOR, lw=2.5, label=f"{author_label} (smoothed)")

    ax.set_title(title, fontsize=13, fontweight="bold")
    ax.set_xlabel("Date")
    ax.set_ylabel(ylabel)
    ax.xaxis.set_major_locator(mdates.MonthLocator())
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))
    ax.grid(True, alpha=0.25)
    ax.legend(loc="upper left", framealpha=0.9)
    ax.set_ylim(bottom=0)
    ax.text(0.99, 0.97, summary, transform=ax.transAxes, ha="right", va="top",
            fontsize=9, bbox=dict(boxstyle="round", fc="white", alpha=0.85))

    plt.tight_layout()
    if show:
        plt.show()
    else:
        plt.savefig(out_path, dpi=130)
        print(f"Saved chart to: {out_path}")


def main():
    parser = argparse.ArgumentParser(
        description="Plot git commits/day and code churn/day (mine vs everyone) over a recent window.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--since", default="6 months ago", help='git --since value (default: "6 months ago")')
    parser.add_argument("--until", default=None, help="git --until value (default: now)")
    parser.add_argument("--author", default=None, help="email or name to highlight (default: git config user.email)")
    parser.add_argument("--author-label", default=None, help='legend label for the highlighted author (default: "Mine")')
    parser.add_argument("--metric", choices=["commits", "churn", "both"], default="both", help="which chart(s) to produce")
    parser.add_argument("--no-merges", action="store_true", help="exclude merge commits from the COMMITS chart (churn always excludes them)")
    parser.add_argument("--repo", default=".", help="path to the git repo (default: current directory)")
    parser.add_argument("--out-dir", default=".", help="directory to write PNGs into (default: current directory)")
    parser.add_argument("--show", action="store_true", help="show interactively instead of saving")
    args = parser.parse_args()

    try:
        import pandas  # noqa: F401
        import matplotlib  # noqa: F401
        import scipy  # noqa: F401
    except ImportError as e:
        sys.exit(f"Missing dependency: {e.name}. Install with: pip install matplotlib pandas scipy")

    if not args.show:
        import matplotlib
        matplotlib.use("Agg")

    repo = str(Path(args.repo).expanduser().resolve())
    author = args.author or default_author(repo)
    if not author:
        sys.exit("No author to highlight: pass --author or set `git config user.email`.")
    author_label = args.author_label or "Mine"
    out_dir = Path(args.out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)

    window = f"since {args.since}" + (f", until {args.until}" if args.until else "")
    repo_name = Path(repo).name

    if args.metric in ("commits", "both"):
        res = get_commits(repo, args.since, args.until, args.no_merges, author)
        if res is None:
            print("No commits found in window.")
        else:
            idx, all_daily, mine_daily = res
            merge_note = " (no merges)" if args.no_merges else " (incl. merges)"
            summary = (
                f"Total: {int(all_daily.sum()):,} commits  |  {author_label}: {int(mine_daily.sum()):,} "
                f"({mine_daily.sum() / max(all_daily.sum(), 1) * 100:.0f}%)\n"
                f"Everyone median {all_daily.median():.0f}/day, peak {int(all_daily.max())}  |  "
                f"{author_label} median {mine_daily.median():.0f}/day, peak {int(mine_daily.max())}"
            )
            plot_series(
                idx, all_daily, mine_daily,
                title=f"{repo_name} — commits per day, {window}{merge_note}",
                ylabel="Commits per day",
                author_label=author_label, summary=summary,
                out_path=out_dir / "git-commits-per-day.png", show=args.show,
            )

    if args.metric in ("churn", "both"):
        res = get_churn(repo, args.since, args.until, author)
        if res is None:
            print("No churn found in window.")
        else:
            idx, all_daily, mine_daily, excluded = res
            summary = (
                f"Total (code only): {int(all_daily.sum()):,}  |  {author_label}: {int(mine_daily.sum()):,} "
                f"({mine_daily.sum() / max(all_daily.sum(), 1) * 100:.0f}%)\n"
                f"Everyone median {all_daily.median():,.0f}/day, peak {int(all_daily.max()):,}  |  "
                f"{author_label} median {mine_daily.median():,.0f}/day, peak {int(mine_daily.max()):,}\n"
                f"Excluded as generated/vendored/transcripts: {excluded:,} lines"
            )
            plot_series(
                idx, all_daily, mine_daily,
                title=(f"{repo_name} — code churned per day, {window}\n"
                       "(added + deleted; --no-merges; lockfiles/build/vendored/snapshots/AI-transcripts excluded)"),
                ylabel="Lines churned per day (added + deleted)",
                author_label=author_label, summary=summary,
                out_path=out_dir / "git-churn-per-day.png", show=args.show,
            )


if __name__ == "__main__":
    main()
