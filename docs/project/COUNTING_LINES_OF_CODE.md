---
description: "Methodology for defensible platform LOC reporting — scc commands, exclusions, report format, investor-facing headline figures"
last_updated: "2026-04-12"
---

# Counting Lines of Code

How to measure and report the Mindstone platform's codebase size accurately.

Scope: rebel-app (Electron desktop app), rebel-platform (backend), and owned submodules.


## Why This Matters

LOC is a blunt metric — it measures size, not quality or productivity. For investor presentations, it serves a narrow purpose: demonstrating the scale and complexity of engineering effort. The key is to report an honest, defensible number with clear methodology, not to inflate it.


## Principles

1. **Count "Code" lines, not "Lines"** — scc distinguishes raw lines (including blanks and comments) from actual code lines. Always report the "Code" column.
2. **Exclude generated code** — `src/preload/generated/` (auto-generated IPC bridge), drizzle migration snapshots (JSON), build artifacts (`out/`, `dist/`, `build/`).
3. **Exclude external dependencies** — `node_modules`, `package-lock.json`, `pnpm-lock.yaml`, vendored libraries, `Anthropic-official-skills/` (third-party skills).
4. **Include test code** — Tests are real engineering work (unit tests, E2E tests, test infrastructure). They're included in the headline figure.
5. **Include functional Markdown** — Skill definitions (prompts shipped to users), help-for-humans docs (user-facing product docs), and system prompts are legitimate authored content. Internal developer docs (`docs/project/`, `docs/plans/`) are not.
6. **Be transparent about CSS** — CSS modules are ~60k code lines. This is legitimate UI engineering, but worth calling out since some audiences discount styling.
7. **Include the full platform** — Count rebel-platform (backend) alongside rebel-app (desktop app) for the full product picture.


## Tool

We use [scc](https://github.com/boyter/scc) (Sloc Cloc and Code), a fast and accurate counter. Install with `brew install scc`.

The script `scripts/count-loc.sh` wraps scc with project-specific exclusions.


## Recommended Commands

### Core Application Code (Best Point Estimate)

Production TypeScript + CSS in `src/`, excluding generated code and test files, plus build scripts:

```bash
# Production app code (src/ minus generated, minus tests)
scc src --no-cocomo --sort code \
  --exclude-dir generated --exclude-dir tests --exclude-dir __tests__ \
  --include-ext ts,tsx,css \
  --not-match "\.(test|spec)\."

# Build tooling (scripts/ + config/)
scc scripts config --no-cocomo --sort code --exclude-dir node_modules
```

### Using the Script

```bash
# Source code only (src/, scripts/, config/) — excludes tests/ dir
# NOTE: This includes .test.ts/.spec.ts files co-located in src/.
# For a precise prod-only count, use the scc commands above.
./scripts/count-loc.sh

# Include tests/ directory
./scripts/count-loc.sh --all

# Include submodule breakdowns
./scripts/count-loc.sh --all --submodules

# Everything (source + docs + skills + submodules)
./scripts/count-loc.sh --full --all --submodules

# JSON for programmatic use
./scripts/count-loc.sh --json
```


## Known Script Caveats

1. **In-tree test files** — The `--exclude-dir tests` flag only excludes the top-level `tests/` directory. It does NOT exclude ~105 `.test.ts`/`.spec.ts` files co-located inside `src/` (~25k code lines). The default script output therefore over-counts production code by ~25k lines.
2. **`meeting-bot-worker` and `avatar-webpage`** — These companion projects (~1.5k and ~1.6k code lines respectively) are not included in any script mode. They're separate deployable components and should be counted separately if relevant.
3. **Generated IPC bridge** — The `generated` directory exclusion in scc catches `src/preload/generated/ipcBridge.ts` (~876 code lines). The script correctly excludes this.
4. **Root config files** — The script counts `*.json`, `*.js`, `*.ts`, `*.mjs`, `*.cjs` at the repo root (~2.9k code lines). These are legitimate build configuration.
5. **`--full` mode Markdown inflation** — Adding `--docs` or `--full` includes ~318k Markdown "Code" lines. This makes the total misleading for a "lines of code" metric.
6. **Root Markdown counted by default** — `build_targets()` globs `*.md` at the repo root even in "source only" mode. Impact is small (~2.7k lines) but slightly inflates the default count.
7. **Undefined `LOCKFILE_EXCLUDES`** — The script references `LOCKFILE_EXCLUDES` in submodule sections but never defines it. This is harmless because scc ignores `package-lock.json` by default, but the dead code should be cleaned up.


## LOC Reports

Individual LOC snapshots are stored as dated reports in [`docs-private/reports/counting_lines_of_code/`](../reports/counting_lines_of_code/). Each report includes the full breakdown, raw scc output, exact reproduction commands, and the git commit it was measured at.

**When running a new analysis**, create a new report file:

```
docs-private/reports/counting_lines_of_code/YYMMDD_loc_report.md
```

Each report should contain:
1. **Headline figure** — the recommended rounded number
2. **Platform summary table** — all components with code lines and delta vs previous report
3. **Detailed breakdown** — per-component tables with language splits, file counts
4. **What's excluded** — list of exclusions for transparency
5. **Exact reproduction commands** — full `scc` commands pinned to the git commit
6. **Raw scc output** — copy-pasted terminal output for auditability

### Current Reports

| Date | Headline | Report |
|---|---|---|
| 2026-03-08 | ~490,000 | [260308_loc_report.md](../reports/counting_lines_of_code/260308_loc_report.md) |
| 2026-02-10 | ~390,000 | [260210_loc_report.md](../reports/counting_lines_of_code/260210_loc_report.md) |


## How to Report for Investor Presentations

### Latest Figure: ~490,000 Lines (as of 2026-03-08)

> "The Mindstone platform comprises approximately **490,000 lines of authored code and content** across the desktop app, mobile app, web companion, cloud services, backend, automated tests, MCP infrastructure, AI skill definitions, and user-facing help documentation."

This includes all production source code, build tooling, automated tests, owned submodule code, companion services, cloud/mobile/web platforms, functional Markdown (skills, help docs), and SQL migrations — but excludes generated code, external dependencies, internal developer docs, and third-party skills.

See the [latest report](../reports/counting_lines_of_code/260308_loc_report.md) for the full breakdown.

### What's Excluded

- `node_modules`, `package-lock.json`, `pnpm-lock.yaml` (external dependencies)
- `src/preload/generated/` (auto-generated IPC bridge)
- `drizzle/meta/*.json` (auto-generated DB schema snapshots)
- `rebel-system/skills/Anthropic-official-skills/` (third-party)
- `out/`, `dist/`, `build/` (build artifacts)
- `docs/project/`, `docs/plans/` (internal developer docs)
- `coding-agent-instructions` (internal developer guidance — counted separately)
- `rebel-system-temp-copy` in rebel-platform (temporary duplicate)


## Appendix: Historical Data

Detailed run data, raw output, and exact commands for each measurement are in the individual report files:

- [2026-03-08 report](../reports/counting_lines_of_code/260308_loc_report.md) — ~490,000 (commit `59b9a5441`)
- [2026-02-10 report](../reports/counting_lines_of_code/260210_loc_report.md) — ~390,000 (commit `56f4304a`)
