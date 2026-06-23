---
description: "Language boundary for Rebel tooling — why app and eval code use TypeScript while shared hooks and utilities use Python"
last_updated: "2026-04-30"
---

# Tooling Language Boundary: Python vs TypeScript

Documents the language boundary between Python and TypeScript in the Mindstone Rebel tooling ecosystem.

## Decision (2026-04-06)

| Category | Language | Rationale |
|----------|----------|-----------|
| **App code** (`src/`, `cloud-service/`, `mobile/`) | TypeScript | Primary language, shared types, build pipeline |
| **Repo-internal eval tooling** (`evals/`) | TypeScript | Shared constants/types with app code, single test runner (Vitest), repo has full Node toolchain |
| **Shared submodule hooks** (`coding-agent-instructions/hooks/*.py`) | Python | Cross-repo portability (submodule used in non-Node repos), zero-dep stdlib, sqlite3 for Cursor DB access, ~30ms startup vs ~500ms+ for tsx |
| **Shared submodule utilities** (`scripts/resolve_mindstone_drive.py`) | Python | Consumed by the Python hooks above |

## Why Not Everything TypeScript?

Three genuine constraints prevent porting `coding-agent-instructions/hooks/` to TypeScript:

1. **Submodule portability**: `coding-agent-instructions/` is a git submodule shared across repos via `[external-email]:mindstone/coding-agent-instructions.git`. Python 3 is pre-installed on macOS and virtually all Linux. `npx tsx` requires Node.js + npm + the tsx package — unavailable in Python, Go, or Rust repos consuming the submodule.

2. **sqlite3 in `export_transcript.py`**: This hook reads Cursor's SQLite databases directly using Python's built-in `sqlite3` module — zero dependencies. The TypeScript equivalent (`better-sqlite3`) is a C++ native binding requiring compilation and platform-specific installs.

3. **Startup time for lifecycle hooks**: Hooks fire on every SessionStart/SessionEnd. `python3 script.py` starts in ~30ms; `npx tsx script.ts` starts in ~500ms-2s. This latency matters for frequently-invoked lifecycle paths.

## Why Eval Tooling IS TypeScript

The `evals/` directory benefits from TypeScript because:
- Dimension schemas, weights, pass thresholds are shared constants with the eval runner — Python duplicated these
- Single test runner (Vitest) instead of split Python/Node testing
- Types provide compile-time safety for the complex aggregation logic
- The repo guarantees a full Node.js/npm toolchain
- Eval scripts are run manually (not on lifecycle events), so startup time is irrelevant

## Factory CLI Hook System

Factory CLI hooks are command-based (`"type": "command"`) — any executable works, including TypeScript via `npx tsx`. The language constraint is practical (portability, dependencies), not technical (Factory doesn't require Python).

See also: `coding-agent-instructions/hooks/README.md` for hook setup details.

## See Also

- [WRITING_EVALS](WRITING_EVALS.md) — eval infrastructure overview
- [TESTING_EVALS_KNOWLEDGE_WORK_ANALYSIS](TESTING_EVALS_KNOWLEDGE_WORK_ANALYSIS.md) — the ported TypeScript analyzer
- [GOOGLE_DRIVE_PATH_RESOLUTION](GOOGLE_DRIVE_PATH_RESOLUTION.md) — shared drive resolution (TS in `evals/shared.ts`, Python in `scripts/resolve_mindstone_drive.py`)
