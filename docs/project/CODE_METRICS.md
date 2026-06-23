---
description: "Code metrics guide for rebel-app LOC counting with scc — script flags, scope, exclusions, output formats, gotchas"
last_updated: "2026-06-06"
---

# Code Metrics

Counting lines of code (LOC) for the rebel-app project using `scc`.

## See Also

- `scripts/count-loc.sh` — The script itself
- [CODE_VISUALISATIONS.md](CODE_VISUALISATIONS.md) — Git-history charts: commits/day, churn/day (mine vs everyone), per-author totals
- [CODE_HEALTH_TOOLS.md](CODE_HEALTH_TOOLS.md) — Other code health tools (Knip, Madge, bundle analysis)


## Prerequisites

Install `scc` (Sloc Cloc and Code):

```bash
brew install scc
```

Why `scc`? It's the fastest LOC counter, respects `.gitignore`, provides language breakdown, and outputs JSON/CSV for automation. See [scc on GitHub](https://github.com/boyter/scc).


## Quick Start

```bash
# Source code only (default) - excludes tests
./scripts/count-loc.sh

# Include test files
./scripts/count-loc.sh --all

# Count evals separately (harness + fixtures)
./scripts/count-loc.sh --evals

# Include documentation
./scripts/count-loc.sh --docs

# Include docs + skills
./scripts/count-loc.sh --full

# Count submodules separately
./scripts/count-loc.sh --submodules

# JSON output for scripting
./scripts/count-loc.sh --json
```


## What's Counted

### Default (source code)

| Directory | Description |
|-----------|-------------|
| `src/` | Main/preload/renderer/shared code |
| `scripts/` | Build and utility scripts |
| `config/` | Configuration files |
| Root `*.ts`, `*.js`, `*.json`, `*.md` | Config files at project root |

### With `--evals`

Counts the `evals/` directory in two separate sections:
- **Harness code** — eval runners, MCP twin servers, benchmarks, tests, GUI (`evals/*.ts`, `mcp-twins/`, `__tests__/`, `gui/`, `benchmarks/`)
- **Fixtures** — JSON fixture files and corpus data (`evals/fixtures/`)

See [TESTING_EVALS_KNOWLEDGE_WORK.md](TESTING_EVALS_KNOWLEDGE_WORK.md) for eval architecture details.

### With `--docs`

Adds `docs/` directory (project documentation, planning docs, research).

### With `--full`

Adds `docs/` and `skills/` directories.

### With `--submodules`

Separately counts:
- `rebel-system` — User-facing docs, skills, help content (excludes `Anthropic-official-skills/`)
- `super-mcp` — MCP server aggregator
- `coding-agent-instructions` — Shared AI coding guidelines


## What's Always Excluded

| Excluded | Reason |
|----------|--------|
| `node_modules/` | Dependencies |
| `dist/`, `out/`, `build/` | Build artifacts |
| `coverage/`, `test-results/` | Test outputs |
| `.git/`, `.vite/`, `.cache/` | Tool caches |
| `src/preload/generated/` | Auto-generated IPC bridge |
| `tests/`, `__tests__/` | Test files (unless `--all`) |
| `resources/` | Bundled assets (node runtime, MCP servers, images) |
| Submodules | Counted separately with `--submodules` |


## Example Output

```
================================================================================
rebel-app Lines of Code (source only: src/, scripts/, config/) [excluding tests]
================================================================================

Language                Files     Lines   Blanks  Comments     Code
TypeScript                763    239912    23965     32041   183906
CSS                       146     60093     8673      2125    49295
JavaScript                 19      4191      428       643     3120
...
Total                     960    311030    33722     35085   242223

================================================================================
Options: --all (tests) | --docs | --full | --submodules | --json
================================================================================
```


## Gotchas

1. **Generated code is excluded** — `src/preload/generated/ipcBridge.ts` (~1500 lines) is auto-generated and excluded via `--exclude-dir generated`.

2. **Submodules are separate repos** — They have their own version history. Use `--submodules` to see their contribution, but they're excluded from the main count by design.

3. **`resources/` is never counted** — Contains bundled dependencies (node runtime, MCP server packages, STT models, images). These are third-party or binary assets, not project source code.

4. **Root config files included** — Files like `package.json`, `tsconfig.json`, `electron.vite.config.ts` are counted. `package-lock.json` is excluded.

5. **Markdown in `docs/` is substantial** — ~2.9M lines of planning docs, project docs, and research. Use `--docs` only if you want to include documentation in the count.

6. **Evals are separate** — The `evals/` directory (~45K harness code + ~25K fixtures) is not included in any default count. Use `--evals` to see it broken down into harness code vs fixture data.


## JSON Output for Automation

```bash
# Get total code lines
./scripts/count-loc.sh --json | jq '[.[].Code] | add'

# Get TypeScript lines only
./scripts/count-loc.sh --json | jq '.[] | select(.Name == "TypeScript") | .Code'

# Save to file for historical tracking
./scripts/count-loc.sh --json > loc-$(date +%Y%m%d).json
```


## Typical Results (as of Apr 2026)

| Scope | Lines of Code |
|-------|---------------|
| Source (no tests) | ~445K |
| Source (with tests) | ~582K |
| Evals harness code | ~45K |
| Evals fixtures | ~25K |
| Source + docs | ~3,454K |
| rebel-system submodule | ~57K |
| super-mcp submodule | ~16K |
