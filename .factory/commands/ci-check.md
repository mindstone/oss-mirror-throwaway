---
description: Diagnose the most recent failed CI run on the current branch and emit a deterministic repro packet
argument-hint: <optional flags, e.g. "--branch dev", "--run-id 12345678", "--json", "--from-file path/to/log.txt", "--bugfix-handoff">
---

Run the deterministic CI failure classifier and (optionally) hand the diagnosis off to `CHIEF_BUGFIXER`.

This command is a thin wrapper around `npm run ci:investigate` (`scripts/ci-investigate.ts`). It exists so an agent can diagnose a CI failure with a single keystroke instead of re-deriving the `gh` invocation each time.

**No LLM in the classifier loop. No auto-fix. No auto-rerun. No auto-push.** Push remains a separate per-turn user authorisation per `AGENTS.md` STOP gates and `[`/git-safe-sync-and-push`](.factory/commands/git-safe-sync-and-push.md)`.

## Read first

- [`docs/project/GITHUB_CLI_AND_ACTIONS_CHECK.md`](../../docs/project/GITHUB_CLI_AND_ACTIONS_CHECK.md) — full runbook (detect → classify → reproduce → fix → escalate → verify)
- [`docs/project/CI_PIPELINE.md`](../../docs/project/CI_PIPELINE.md) — canonical CI matrix
- [`docs/project/E2E_TEST_FIXING_GUIDELINES.md`](../../docs/project/E2E_TEST_FIXING_GUIDELINES.md) — **STOP** before fixing E2E failures
- [`coding-agent-instructions/workflows/CHIEF_BUGFIXER.md`](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md) — bug-fix orchestration
- [`/git-safe-sync-and-push`](git-safe-sync-and-push.md) — push policy

## Modes

This command has two modes.

### Mode 1 — Diagnose-only (default)

Read-only. Prints a deterministic diagnosis packet (workflow → local repro → suggested `CHIEF_BUGFIXER` lens) and exits. Safe to run autonomously. Produces a self-contained packet you can paste into a fresh agent thread or a teammate's chat.

```bash
npm run ci:investigate -- $ARGUMENTS
```

Pass any of the script's flags through `$ARGUMENTS`:

- `--branch <name>` — default: current branch
- `--run-id <id>` — diagnose a specific run instead of resolving the latest
- `--from-file <path>` — degraded mode (no `gh` required); classify a log file you already have
- `--json` — machine-readable output (consume from another script or paste into a structured prompt)
- `--no-fetch` — re-classify a previously cached log under `tmp/ci-investigate/`
- `--limit <n>` — how many recent runs to consider (default 1)
- `--dry-run` — print the plan without calling `gh run view`

### Mode 2 — Bugfix handoff (`--bugfix-handoff`)

When the user asks for an end-to-end "diagnose + fix" flow, run the diagnosis in `--json` mode, capture the packet, then chain into `CHIEF_BUGFIXER` Phase 0 with the diagnosis prefilled. The packet supplies workflow + repro + lens + log-tail; the user supplies the intent confirmation.

```bash
PACKET=$(npm run --silent ci:investigate -- --json $ARGUMENTS)
# Hand $PACKET off to CHIEF_BUGFIXER Phase 0; do NOT push, do NOT auto-fix.
```

After the handoff:

1. The agent confirms intent with the user (per `CHIEF_BUGFIXER` Phase 0).
2. Parallel debuggers reproduce the failure locally using the packet's `repro.command`.
3. The smallest surgical fix is reviewed before being applied.
4. Push is **only** authorised by an explicit user instruction in that same turn — see [`/git-safe-sync-and-push`](git-safe-sync-and-push.md).

## Decision tree

When invoked, follow this:

1. **Probe `gh`**: `gh --version && gh auth status` (the script does this internally; if you skip the slash command and run `gh` manually, do it yourself).
2. **Run the script**: `npm run ci:investigate -- $ARGUMENTS`.
3. **Read the exit code**:
   - **0 = `classified`** — packet contains the repro and lens. If `--bugfix-handoff` was set, proceed to Mode 2. Otherwise, hand the packet to the user (or paste into the next agent thread).
   - **0 = `no_failure`** — most recent run on the branch passed (or there are no runs yet). Confirm the branch is correct; otherwise nothing to do.
   - **0 = `in_progress`** — run is still going. Re-run the command in a few minutes, or `gh run watch <id>`.
   - **2 = `unknown`** — CI failed but the classifier doesn't recognise the signature. The packet's `logExcerptTail` is your best clue. If a `tentativeRepro` is present (e.g., generic `validate:fast` exit), it is a low-confidence hint, NOT a confirmed diagnosis. Either:
     - Manually inspect the log (`tmp/ci-investigate/<runId>.log`) and add a fixture + catalog entry to `scripts/ci-investigate.ts` (so the next agent doesn't repeat the work), or
     - Hand the log directly to `CHIEF_BUGFIXER`'s parallel debuggers.
   - **1 = `hard_error`** — `gh` missing/unauth/network/file. The packet's `remediation` field tells you what to do (install gh / `gh auth login` / set `GH_TOKEN` / use `--from-file`).

## What this command does NOT do

- Does **not** auto-fix anything. The classifier is a regex catalog; the fix is the engineer's call.
- Does **not** auto-rerun the workflow. Use `gh run rerun <id>` manually if appropriate.
- Does **not** push. Push is an explicit per-turn user authorisation (see `AGENTS.md` STOP gates).
- Does **not** call any LLM in the diagnosis path. Classification is deterministic regex matching against an inline catalog.
- Does **not** duplicate the CI matrix. The canonical mapping lives in [`CI_PIPELINE.md`](../../docs/project/CI_PIPELINE.md); the script's catalog is the runtime classifier; this command just wraps the script.

## Examples

### Most recent failure on the current branch

```bash
/ci-check
```

### A specific run

```bash
/ci-check --run-id 25600243693
```

### Degraded mode (no `gh` available)

```bash
gh run view 25600243693 --log-failed > /tmp/failure.log  # on a machine that has gh
/ci-check --from-file /tmp/failure.log
```

### Hand off to CHIEF_BUGFIXER

```bash
/ci-check --bugfix-handoff
```

### JSON output for piping into another agent

```bash
/ci-check --json --branch dev > /tmp/diagnosis.json
```

## Anti-patterns (do not reintroduce)

These were considered and rejected during planning (see `docs/plans/260510_ci_investigation_tooling.md`):

- **LLM-based log interpretation pipeline** — slow, non-deterministic, and the classifier already covers the recurring signatures.
- **External YAML pattern catalog** — drifts from the script. Catalog stays inline in `scripts/ci-investigate.ts`.
- **Auto-fix / auto-rerun / auto-push** — push requires explicit per-turn user authorisation. The classifier never edits files.
- **Documentation-drift guard / pre-push reminder hook** — both already covered (Husky pre-push + manual review).
- **Duplicated CI matrix** — signpost to `CI_PIPELINE.md`; do not copy.
- **`[BUG-POSTMORTEM]` on every CI failure** — too aggressive. Postmortems are reserved for medium/high severity bugs per `CHIEF_BUGFIXER`.
