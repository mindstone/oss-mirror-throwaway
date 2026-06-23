---
description: "Rebel pointer + project overrides for the daily HTML changelog explainer. The generic craft guidance lives in coding-agent-instructions; this file supplies Rebel's wiring."
use_cases:
  - "Generating rich daily HTML explainers from git history for the product/dev team"
  - "Preparing deep context before demos or team syncs"
last_updated: "2026-06-18"
dependencies:
  - "../../coding-agent-instructions/workflows/CHANGELOG_DAILY_EXPLAINER.md"
  - "../../coding-agent-instructions/workflows/TEAM_ACTIVITY_DIGEST.md"
  - "./CHANGELOG_UPDATE_PROCESS.md"
  - "../../CHANGELOG.md"
  - "../../rebel-system/help-for-humans/changelog.md"
agent_type: "main_agent"
---

# Daily Changelog Explainer — Rebel overrides

> **The process lives in the shared workflow:** [`coding-agent-instructions/workflows/CHANGELOG_DAILY_EXPLAINER.md`](../../coding-agent-instructions/workflows/CHANGELOG_DAILY_EXPLAINER.md). Read it for the full craft — gather → cross-reference → group/prioritize → research diffs → write progressive-disclosure HTML → index → review → cross-day signposting. This file only supplies Rebel's concrete values for that workflow's `{placeholders}`. Nothing about *how to write a good explainer* lives here — that's all in the shared doc, so it stays in one place and improves for every repo at once.

## Rebel's overrides

| Placeholder | Rebel value |
|-------------|-------------|
| `{CHANGELOG_DIR}` | The `Shared drives/Product/changelog/` folder on the Product Google Shared Drive. On a synced Mac that mounts as `…/Library/CloudStorage/GoogleDrive-<you>@example.com/Shared drives/Product/changelog/` (the canonical CSS + existing days were authored under greg's mount). A **single flat folder shared with other repos** (e.g. `weteachbackend`); Kept out of git, alongside pathologist/perf reports. |
| `{repo-slug}` | `mindstonerebel` — so new days are named `mindstonerebel_yyMMdd_changes.html`, keeping them distinct from `weteachbackend_…` in the same folder. |
| `{submodules}` | `rebel-system`, `super-mcp`, **and** `coding-agent-instructions` — scan all three in step 1; the template carries a per-submodule section. (Note: unlike the user-facing changelog, the explainer *does* include `coding-agent-instructions` — it's team-facing context, not shipped product copy.) |
| `{repo-commit-url}` | Main repo: `https://github.com/mindstone/rebel-app/commit/<sha>`. Submodule commits link to each submodule's own GitHub repo. |
| `{changelog-sources}` | Internal: [`CHANGELOG.md`](../../CHANGELOG.md). User-facing: [`rebel-system/help-for-humans/changelog.md`](../../rebel-system/help-for-humans/changelog.md) (pull `<!-- detail: -->` tooltips and benefit-first framing from here). |
| `{subagent-roster}` | Research: `researcher-gpt5.5-high`. Per-day generation: `implementer`. Review (step 7): `reviewer-gpt5.5-high` (cross-family review is the point). See [MODEL_ROSTER](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/MODEL_ROSTER.md). On Claude Code, route GPT roles through the Codex CLI ([CODEX_CLI_AS_SUBAGENT](../../coding-agent-instructions/docs/CODEX_CLI_AS_SUBAGENT.md)). |
| `{canonical-css}` | `$CHANGELOG_DIR/260406_changes.html` — the canonical CSS template; reuse its `<style>` verbatim for every day. |
| `{trigger}` | Triggered as the **mandatory follow-up** of [CHANGELOG_UPDATE_PROCESS](./CHANGELOG_UPDATE_PROCESS.md) — see its `[FOLLOW-UP — MANDATORY]` section. Run immediately after the changelog commit, while the grouping/triage context is fresh. |

## Rebel notes

- **Source of triage**: the `[yyMMdd_*]` entries in [`CHANGELOG.md`](../../CHANGELOG.md) already carry audience + importance tags from [CHANGELOG_UPDATE_PROCESS](./CHANGELOG_UPDATE_PROCESS.md) — use them as the prioritisation input rather than re-triaging from raw commits.
- **Voice**: headlines and exec summaries follow Rebel's [BRAND_VOICE](./BRAND_VOICE.md) — dry, benefit-first, no insider jargon in the always-visible text.
- **Legacy filenames (no migration)**: Rebel's pre-existing days are flat and **un-prefixed** (`yyMMdd_changes.html`, newest `260508_changes.html`); they were not renamed. Only *new* days get the `mindstonerebel_` prefix. So the first prefixed day's "previous day" link should point at the last un-prefixed file (`260508_changes.html`), and the canonical CSS source stays `260406_changes.html`. Everything from that bridge forward uses `mindstonerebel_`.
- **Companion**: for *who did what and why* (from conversation transcripts rather than commits), see [TEAM_ACTIVITY_DIGEST](./TEAM_ACTIVITY_DIGEST.md) — joined to the explainer by commit SHA.
