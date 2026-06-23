---
description: "CI failure diagnosis runbook using GitHub CLI and Actions logs — classifier command, decision tree, local repro packet, and bugfix handoff"
last_updated: "2026-06-02"
---

# GitHub CLI and Actions Check

A decision-tree runbook for diagnosing failed CI runs on this repo. Optimised for AI agents (Claude / Droid / Cursor / Factory) and the humans supervising them.

The goal is to land on the right local repro command and the right `CHIEF_BUGFIXER` lens within one tool call — not to re-derive the answer on every failure.

## See also

- [`CI_PIPELINE.md`](CI_PIPELINE.md) — canonical CI matrix, branch rules, GCS artifacts. **Single source of truth for the workflow→trigger mapping.** This doc does not duplicate it.
- [`CODE_HEALTH_TOOLS.md`](CODE_HEALTH_TOOLS.md) — what the `dev-checks` validators actually check.
- [`TESTING_E2E.md`](TESTING_E2E.md) — E2E test suite details.
- [`E2E_TEST_FIXING_GUIDELINES.md`](E2E_TEST_FIXING_GUIDELINES.md) — **STOP-gate** before fixing any E2E failure.
- [`CHIEF_BUGFIXER.md`](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md) — bug-fix orchestration (parallel debuggers → consensus → surgical fix → review).
- [`/git-safe-sync-and-push`](../../.factory/commands/git-safe-sync-and-push.md) — the only sanctioned push path.
- [`RELEASE_TO_BETA.md`](RELEASE_TO_BETA.md) — the autonomous "push to beta → watch CI → diagnose & fix within a risk ceiling → re-push until green" loop. Wraps the push path + this runbook.
- [`/ci-check`](../../.factory/commands/ci-check.md) — the slash command that wraps the helper script below.
- [`scripts/ci-investigate.ts`](../../scripts/ci-investigate.ts) — the helper script. **Inline regex catalog lives here, not in this doc.**
- `.factory/droids/reviewer-gpt5.5-high.md` — primary reviewer droid.

---

## TL;DR — the one command

```bash
npm run ci:investigate
```

Runs `gh run list` → `gh run view --log-failed` → classifier → repro packet, all in one. Output is a small structured packet (workflow, failed jobs, matched signature, local repro command, suggested `CHIEF_BUGFIXER` lens, log path).

Or invoke via `/ci-check` (same flow, fewer keystrokes; supports `--bugfix-handoff` for end-to-end diagnose-and-fix).

If you'd rather drive `gh` by hand, jump to the [Detect](#1-detect) section.

---

## Decision tree

```
CI failed
   │
   ├─ Run: npm run ci:investigate
   │
   ├─ exit 0 + status="classified"
   │     → use packet's repro.command locally
   │     → if it reproduces, fix and re-push
   │     → if it doesn't, hand the log to CHIEF_BUGFIXER
   │
   ├─ exit 0 + status="no_failure"
   │     → most recent run on the branch passed; check the branch
   │
   ├─ exit 0 + status="in_progress"
   │     → wait or `gh run watch <id>`
   │
   ├─ exit 2 + status="unknown"
   │     → classifier doesn't recognise the signature
   │     → inspect tmp/ci-investigate/<runId>.log directly
   │     → consider adding a fixture + catalog entry to ci-investigate.ts
   │     → or hand off to CHIEF_BUGFIXER's parallel debuggers
   │
   └─ exit 1 + status="hard_error"
         → packet's `remediation` says what to do
            (install gh / gh auth login / set GH_TOKEN / --from-file)
```

---

## Prerequisites

### Install GitHub CLI

```bash
# macOS (Homebrew)
brew install gh

# Windows (winget)
winget install --id GitHub.cli

# Linux (Debian/Ubuntu)
sudo apt install gh

# Or download from: https://cli.github.com/
```

Minimum version: 2.50 (the helper script probes and emits a `hard_error` if older).

### Authenticate

```bash
gh auth login
```

Or set `GH_TOKEN` for headless invocations (CI runners, sandboxed agents). The helper script honours both.

---

## 1. Detect

### Default — the helper script

```bash
npm run ci:investigate                                # latest run on current branch
npm run ci:investigate -- --branch dev                # explicit branch
npm run ci:investigate -- --run-id 25600243693        # specific run
npm run ci:investigate -- --json                      # machine-readable
npm run ci:investigate -- --from-file ./failure.log   # degraded mode (no gh required)
npm run ci:investigate -- --no-fetch                  # re-classify a cached log
npm run ci:investigate -- --dry-run                   # preview the plan
```

The script:

- Resolves the latest run on the branch via `gh run list ... --json databaseId,name,conclusion,status,workflowName,event,headBranch,attempt`.
- Branches on `conclusion`/`status` (no `--status failure` filter — that would hide `in_progress` runs).
- Streams `gh run view <id> --log-failed` to `tmp/ci-investigate/<runId>-attempt-<n>.log` (atomic rename from `.partial.log`).
- Classifies the **full streamed log** against an inline regex catalog (the catalog is the single source of truth — see [`scripts/ci-investigate.ts`](../../scripts/ci-investigate.ts)).
- Truncates only the user-facing log excerpt (≤ 800 lines / ≤ 400 KB tail).
- Emits a discriminated-union packet: `{ status: 'classified' | 'unknown' | 'no_failure' | 'in_progress' | 'hard_error', ... }`.

Exit codes: `classified=0`, `no_failure=0`, `in_progress=0`, `unknown=2`, `hard_error=1`.

### Manual `gh` (when you don't want the wrapper)

```bash
# Latest run on current branch
RUN_ID=$(gh run list --branch "$(git rev-parse --abbrev-ref HEAD)" --limit 1 \
  --json databaseId -q '.[0].databaseId')

gh run view "$RUN_ID"                          # summary
gh run view "$RUN_ID" --log-failed > /tmp/ci-failure.log
gh run watch "$RUN_ID"                         # follow a running workflow
```

For most agent flows, the wrapper is the better default — it captures the run id, logs, and classification in one packet you can paste forward.

---

## 2. Classify

The classifier lives inline in [`scripts/ci-investigate.ts`](../../scripts/ci-investigate.ts). **Do not duplicate the regex catalog here** — it changes; this doc shouldn't.

> **Current catalog scope (2026-05-31):** validation-time `dev-checks` failures — knip-health, circular deps, MCP lockfile drift, IPC contract drift, TS ratchet regression, React hooks exhaustive-deps, store-version mismatch, submodule pointer not-pushed, cross-surface parity baseline drift, ESLint new-warning regressions, and selected Vitest/Eval cleanup failures — plus selected operational and high-noise workflow signatures for Release E2E, Mobile TestFlight/EAS submit, Dependabot private-submodule access, and schema-boundary planner eval failures. Unknown mobile, cloud, release, deploy, or eval failures should still be inspected directly and then added as fixture-backed catalog entries when the line-local signature is stable.

What a `classified` packet looks like (human mode):

```
Run: 25600243693 (failed) — Workflow: Desktop Dev Checks — Job: knip-health
Signature: knip-health unused-file (1 match)
Local repro: npm run validate:knip-health
Suggested CHIEF_BUGFIXER lens: none (mechanical) — likely Knip catching a real
  dead file or a missed entry-point in `knip.json`.
Signpost: docs/project/CODE_HEALTH_TOOLS.md (knip section)
Log: tmp/ci-investigate/25600243693.log (full, 1234 lines, truncated for display)
```

In `--json` mode, the packet is keyed on `status`; consumers should narrow on that field before reading variant fields.

When the classifier returns `unknown`:

- `tentativeRepro` (if present) is a **low-confidence hint**, not a confirmed diagnosis. The generic GitHub `##[error]Process completed with exit code 1.` is the most common trigger; the actual failure may need direct log inspection.
- The right next step is either to add a fixture + catalog entry (so the next agent doesn't repeat the work) or to hand the log to `CHIEF_BUGFIXER`'s parallel debuggers.

---

## 3. Reproduce locally

Pick the command that matches the failed workflow + job. The CI matrix in [`CI_PIPELINE.md`](CI_PIPELINE.md) is the canonical mapping; this table is a quick-reference subset for the workflows agents hit most often:

| Workflow | Job | Local repro |
|---|---|---|
| `dev-checks.yml` | `validate-and-test` | `npm run verify:agent` |
| `dev-checks.yml` | `knip-health` | `npm run validate:knip-health` |
| `dev-checks.yml` | `super-mcp-tests` | `cd super-mcp && npm test` |
| `release.yml` | `validate-and-test` | `npm run verify:agent:full` |
| `release.yml` | `test-e2e` | `npm run package && npm run test:e2e` (**STOP** — read [`E2E_TEST_FIXING_GUIDELINES.md`](E2E_TEST_FIXING_GUIDELINES.md) first) |
| `cloud-ci.yml` | (cloud tests) | `npm run test:cloud` |
| `mcp-catalog-tests.yml` | (catalog) | `npm run test:mcp:smoke` |
| `build-cloud.yml` | (Docker smoke) | `npm run verify:cloud-docker` |
| `mobile-preview.yml` / `mobile-production.yml` | (mobile builds) | see [`CI_PIPELINE.md`](CI_PIPELINE.md) |

### The `verify:agent` ladder

`validate:fast` is **one rung**, not the full reproduction. The full local mapping for `dev-checks` is `verify:agent`; for release-tier validation it's `verify:agent:full`.

| Command | What it covers | Equivalent CI surface |
|---|---|---|
| `npm run validate:fast` | Static checks: lint, IPC, store versions, MCP bundles + lockfiles, circular deps, TS ratchet, etc. (See `package.json` for the full chain.) | One step inside `validate-and-test` |
| `npm run verify:agent` | `validate:fast` + `validate:knip-health` + unit tests + `eval:app-bridge-install` | Full `dev-checks.yml` reproduction |
| `npm run verify:agent:full` | `verify:agent` + `validate:openrouter-providers` + impact map + `electron-vite build` | Release-tier validation reproduction |
| `npm run test:e2e` | Playwright E2E (requires `npm run package` first) | `release.yml` `test-e2e` job |

If the failure is something niche (cloud, MCP catalog, mobile runtime integrity), check [`CI_PIPELINE.md`](CI_PIPELINE.md) for the exact workflow→trigger mapping.

---

## 4. Fix

For trivial mechanical fixes (knip dead file, react-hooks dep, store-version bump, MCP lockfile drift), apply the fix locally, re-run the repro command to confirm green, and proceed to [Verify](#6-verify).

For non-trivial fixes — anything touching logic, shared contracts, cross-process boundaries, or with consumers — **route through [`CHIEF_BUGFIXER`](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md)**. That workflow is the default for medium/high severity bugs:

1. Phase 0: confirm intent with the user.
2. Phase 1: parallel debuggers reproduce locally.
3. Phase 2: consensus diagnosis.
4. Phase 3: smallest surgical fix, reviewed by subagent.
5. Phase 4: postmortem record.

For E2E failures, **STOP** and read [`E2E_TEST_FIXING_GUIDELINES.md`](E2E_TEST_FIXING_GUIDELINES.md) first — and reference [`WHY_E2E_TESTS_ARE_HARD_TO_FIX.md`](WHY_E2E_TESTS_ARE_HARD_TO_FIX.md) for prior attempts.

---

## 5. Escalate

Use the slash command's bugfix-handoff mode when you want one continuous flow from "CI failed" to "fix in flight":

```bash
/ci-check --bugfix-handoff
```

This runs the diagnosis in `--json` mode and chains the packet into `CHIEF_BUGFIXER` Phase 0 (intent confirmation). It does **not** auto-push, auto-fix, or auto-rerun.

When to escalate to a `[BUG-POSTMORTEM]`:

- Medium/high severity bugs (per `CHIEF_BUGFIXER`).
- Anything that broke production or beta.
- Anything where the root cause was non-obvious or where the fix had unexpected consequences.

Postmortems are not required for every CI failure — only for the ones worth learning from.

---

## 6. Verify

Before pushing the fix:

```bash
npm run verify:agent       # for dev-checks failures
npm run verify:agent:full  # for release-tier failures
```

Husky's pre-push hook runs `validate:fast` (and tier-2/3 scopes for beta/main pushes) automatically — but the `verify:agent` ladder is the one that actually reproduces what CI runs.

Then push via the canonical path:

```bash
/git-safe-sync-and-push
```

(Push is **per-turn explicit user authorisation only** — see `AGENTS.md` STOP gates and [`/git-safe-sync-and-push`](../../.factory/commands/git-safe-sync-and-push.md). An autonomous push that carries a bad merge blocks every other agent on the repo.)

---

## Degraded mode — when `gh` is unavailable

```bash
# On a machine that has gh:
gh run view 25600243693 --log-failed > /tmp/failure.log

# On the machine that doesn't:
npm run ci:investigate -- --from-file /tmp/failure.log
```

Or download the log via the GitHub UI (run page → "View raw logs" → save as `.txt`) and pass it via `--from-file`. The classifier runs identically on a local file as it does on a `gh`-fetched stream.

If `gh` is installed but unauthenticated, the script returns `hard_error` with the remediation `gh auth login` (or set `GH_TOKEN`). If `gh` is rate-limited or hits a network error, the script retries once with a 5s backoff before failing with a parsed remediation message.

---

## Anti-patterns (do not reintroduce)

These were considered and rejected during planning (see `docs/plans/260510_ci_investigation_tooling.md`). Future agents: do not undo these decisions without an explicit user authorisation.

- **LLM-based log interpretation pipeline.** Slow, non-deterministic, and the inline regex catalog already covers the recurring signatures.
- **External YAML pattern catalog.** Drifts from the script. Catalog stays inline in `scripts/ci-investigate.ts`.
- **Auto-fix / auto-rerun / auto-push.** Push requires explicit per-turn user authorisation. The classifier never edits files.
- **Documentation-drift guard / pre-push reminder hook.** Husky already runs `validate:fast` on every push; a personal reminder hook is redundant.
- **Duplicated CI matrix.** The matrix lives in [`CI_PIPELINE.md`](CI_PIPELINE.md). This doc signposts; it does not copy.
- **`[BUG-POSTMORTEM]` on every CI failure.** Postmortems are reserved for medium/high severity bugs per `CHIEF_BUGFIXER`.

---

## Troubleshooting

### `gh: command not found`

Install the GitHub CLI (see [Prerequisites](#prerequisites)). Or use `--from-file` with a log fetched from a machine that has `gh`.

### `gh auth login` fails

Run `gh auth status` to see the current state. For headless contexts (CI, sandboxed agents), set `GH_TOKEN` to a token with `repo` + `read:org` scopes.

### Cannot view logs for a run

Confirm you have access to the repo and the run id is correct (`gh run list`). Some long-running workflows may also retain logs only for a limited window.

### Submodule-related failures

If CI fails with "submodule commit not found", you pushed the superproject before pushing the submodule. The fix lives in [`/git-safe-sync-and-push`](../../.factory/commands/git-safe-sync-and-push.md), which handles ordering automatically (`--recurse-submodules=on-demand`).

### Run still in progress

The script returns `status: 'in_progress'` and exit 0. Re-run in a few minutes, or `gh run watch <id>`.

### Classifier returns `unknown`

The signature is not in the inline catalog. Two paths:

1. **Add a fixture + catalog entry** (preferred for recurring signatures): drop a `.log` fixture under `scripts/__tests__/fixtures/ci-investigate/` and a catalog row in `scripts/ci-investigate.ts`. The next agent will get a deterministic answer.
2. **Hand the log to `CHIEF_BUGFIXER`** (one-off): the parallel debuggers will diagnose the failure from the raw log.

### `gh` rate limit / network error

The script retries once with a 5s backoff and then surfaces a parsed remediation (`Wait or set GH_TOKEN`, `Check VPN/connectivity`, etc.) with `status: 'hard_error'`.
