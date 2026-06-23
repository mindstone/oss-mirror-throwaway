---
description: "Sentry Autopilot operating reference — dispatcher loop, feature flags, runner CLIs, verification, reporting, rollback"
last_updated: "2026-06-07"
---

# Sentry Autopilot

A single-VM, hourly-cron pipeline that polls Sentry, dispatches bug-fix agent sessions (either CHIEF_BUGFIXER or CHIEF_ENGINEER2 via its autonomous-mode entry point — see [Workflow switch](#workflow-switch-chief_bugfixer-vs-chief_engineer2-autonomous)), verifies their outcomes, and reports back via Slack, Linear, GitHub PRs, and the Sentry issue itself.

Code lives under [`scripts/sentry-autopilot/`](../../scripts/sentry-autopilot/). The most useful entry points are:

- [`dispatcher.ts`](../../scripts/sentry-autopilot/dispatcher.ts) — `main()` loop: drain pending actions, harvest finished sessions, poll Sentry, dispatch new sessions, housekeeping. Run via `npx tsx scripts/sentry-autopilot/dispatcher.ts`.
- [`poller.ts`](../../scripts/sentry-autopilot/poller.ts) — Sentry REST API client + triage rules.
- [`session-manager.ts`](../../scripts/sentry-autopilot/session-manager.ts) — worktree lifecycle, tmux session spawning, outcome harvest, verifier integration.
- [`reporter.ts`](../../scripts/sentry-autopilot/reporter.ts) — Slack / Sentry / Linear / GitHub side-effect executors + `planActions()` pure planner.
- [`pending-drainer.ts`](../../scripts/sentry-autopilot/pending-drainer.ts) — durable per-issue action queue drainer (mirror + enforce modes).
- [`verifier.ts`](../../scripts/sentry-autopilot/verifier.ts) — mechanical outcome verifier (plan file present, commit present, branch on origin, etc.).
- [`state.ts`](../../scripts/sentry-autopilot/state.ts) — SQLite state DB (better-sqlite3 + WAL).

The implementation plan (and every architectural decision behind the current design) is in [`docs/plans/260515_autopilot_deferred_items.md`](../plans/260515_autopilot_deferred_items.md).

## Operating envelope (load-bearing assumptions)

- **Single VM, single dispatcher process, hourly cron.** Concurrency cap: `AUTOPILOT_MAX_CONCURRENT=3` sessions, ≤~18 pending actions at peak. The simpler row-embedded `pending_actions JSON` design (instead of a separate `outbox` table with claim/lease columns) only holds because no two processes ever write the same row.
- **Sessions terminate before the next tick.** `AUTOPILOT_SESSION_TIMEOUT` (default 2700s) is enforced by the supervisor; cron runs every 60min. If a session exceeds the timeout, `failAndRelease` quarantines it and the next tick reclaims the slot.

If either invariant changes (multi-VM, sub-hourly cron, lifted concurrency) the design needs revisiting — see the planning doc's "Principles & key decisions" section for what would need to flip.

## Feature flag matrix

Every behavioural change ships at `disabled` and promotes through an intermediate value with at least 3 days of VM observation before flipping to enforce/pr.

| Env var | Values | Default | What it gates |
|---|---|---|---|
| `AUTOPILOT_PHASE` | `shadow` \| `guarded` \| `full` | `shadow` | Whether the bugfixer commits at all |
| `AUTOPILOT_VERIFY_MODE` | `disabled` \| `log_only` \| `enforce` | `disabled` | Mechanical outcome verification (plan file, commit, branch on origin) |
| `AUTOPILOT_PENDING_MODE` | `disabled` \| `mirror` \| `enforce` | `disabled` | Durable per-issue action queue |
| `AUTOPILOT_PUSH_MODE` | `disabled` \| `branch_only` \| `pr` | `disabled` | Bugfixer pushes its branch; reporter opens a PR |
| `AUTOPILOT_RELEASE_GATE_ENABLED` | `true` \| `false` | `false` | Release-aware triage filter; requires `AUTOPILOT_PENDING_MODE=enforce` |
| `AUTOPILOT_RELEASE_LAG_TOLERANCE_MINOR` | non-negative integer | `0` | Minor-version lag tolerated before release-gate skip |
| `AUTOPILOT_CURRENT_RELEASE` | semver (`vX.Y.Z`) | package.json version | Manual current-release override for operator runs |
| `AUTOPILOT_LINEAR_DEDUP_ENABLED` | `true` \| `false` | `false` | Linear-existing dedup triage filter; requires `AUTOPILOT_PENDING_MODE=enforce` |
| `AUTOPILOT_LINEAR_DEDUP_STATUSES` | comma-separated Linear status names | `Done,Cancelled,Duplicate` | Linear states that cause a matching Sentry issue to skip dispatch |
| `AUTOPILOT_INFLIGHT_DEDUP_ENABLED` | `true` \| `false` | `false` | In-flight fingerprint dedup triage filter; marks row `deferred` when another same-fingerprint session is active |
| `AUTOPILOT_INFLIGHT_DEDUP_WINDOW_HOURS` | positive integer | `6` | Lookback window for active same-fingerprint sessions in gate + dispatch-time transactional guard |
| `AUTOPILOT_WORKFLOW` | `chief_bugfixer` \| `ce2` | `chief_bugfixer` | Which autonomous-agent workflow the dispatcher hands to. `ce2` dispatches CHIEF_ENGINEER2 directly via its [autonomous-mode entry point](#workflow-switch-chief_bugfixer-vs-chief_engineer2-autonomous) (`CHIEF_ENGINEER2_AUTONOMOUS.md`). |
| `GITHUB_TOKEN` | secret | unset | Required when `pushMode=pr`; fine-grained PAT with `pull_requests:write` + `contents:read` |
| `AUTOPILOT_REPO_FULL_NAME` | `owner/repo` | unset | Required when `pushMode=pr` |

Config interlock (in [`config.ts`](../../scripts/sentry-autopilot/config.ts)):

- `pushMode=pr` ⇒ `verifyMode=enforce` (otherwise refuses to start). PR creation without verification would publish phantom-fix PRs.
- `pushMode=pr` requires both `GITHUB_TOKEN` and `AUTOPILOT_REPO_FULL_NAME` set, with the latter matching `owner/repo`.
- `releaseGateEnabled=true` ⇒ `pendingMode=enforce` (otherwise refuses to start). Release-skip quiet Sentry comments are delivered through the durable pending-action queue, so non-enforcing pending modes would silently skip delivery.
- `linearDedupEnabled=true` ⇒ `pendingMode=enforce` (otherwise refuses to start). Linear-dedup quiet Sentry comments use the same durable pending-action queue and per-issue idempotency-key pattern.
- `inFlightDedupEnabled=true` has **no** pending-mode interlock. In-flight dedup defers silently (`status='deferred'`) and does not enqueue Sentry comments, so it does not depend on pending-action draining.
- `cli=cursor` requires `CURSOR_API_KEY` to be set. If missing at runtime, the config loader **fails fast** (`throw` — refuses to start) so the breakage is loud and the operator sees it in `supervisor.log` rather than silently running on the wrong runner. To keep misconfigured VMs from getting stuck in this state, [`cloud-vm-provision.sh`](../../scripts/cloud-vm-provision.sh) downgrades `AUTOPILOT_CLI` to `droid` at provision-time when the operator selects `cursor` but skips the API key — so `~/autopilot.env` is always internally consistent. Operators flip back to `cursor` (one-line edit in `~/autopilot.env`) once they add the key.
- `cli=claude` requires `ANTHROPIC_API_KEY` to be set. Same fail-fast / provision-time-downgrade pattern as the cursor interlock.

## Runner CLI selection

The bug-fixer session runs inside a `tmux` shell launched by [`session-supervisor.sh`](../../scripts/sentry-autopilot/session-supervisor.sh). The supervisor can drive any of three runners: the **Factory Droid CLI** (`droid exec`), the **Cursor CLI** (`cursor-agent`), or the **Claude Code CLI** (`claude`). Selection is per-VM via env vars sourced from `~/autopilot.env`.

| Env var | Values | Default | Notes |
|---|---|---|---|
| `AUTOPILOT_CLI` | `droid` \| `cursor` \| `claude` | `droid` | Which runner the supervisor invokes |
| `AUTOPILOT_CURSOR_MODEL` | model id | `composer-2.5` | Passed to `cursor-agent --model`; only consulted when `cli=cursor` |
| `CURSOR_API_KEY` | secret | unset | Required when `cli=cursor` |
| `AUTOPILOT_CLAUDE_MODEL` | model id | `claude-opus-4-8` | Passed to `claude --model`; only consulted when `cli=claude` |
| `ANTHROPIC_API_KEY` | secret | unset | Required when `cli=claude` (also used by `cli=droid` under the hood; droid sources it from `~/.config/droid/env`) |

**Default is `droid`** — existing VMs keep their current behaviour without any operator action. To opt a VM into Cursor or Claude:

1. Set `AUTOPILOT_CLI=cursor` (or `claude`) in `~/autopilot.env`.
2. Set the matching API key in the same file (`CURSOR_API_KEY` or `ANTHROPIC_API_KEY`).
3. Optionally override the model env var if you don't want the runner's compiled default.
4. Restart the autopilot cron job (or wait for the next tick) — the dispatcher re-reads `~/autopilot.env` on every invocation.

The VM provisioner ([`scripts/cloud-vm-provision.sh`](../../scripts/cloud-vm-provision.sh)) installs `cursor-agent` and `claude` unconditionally on every VM and prompts for these values during `--setup-autopilot`, so the runner switch is a single env-var flip after provisioning.

### What changes between runners

Only the **subprocess that runs the bug-fix session** changes:

- `droid` → `timeout … droid exec --auto high -f "$PROMPT_FILE"`
- `cursor` → `timeout … cursor-agent --print --output-format stream-json --model "$AUTOPILOT_CURSOR_MODEL" --force --trust --workspace "$WORKTREE" < "$PROMPT_FILE"`
- `claude` → `timeout … claude --print --output-format stream-json --verbose --model "$AUTOPILOT_CLAUDE_MODEL" --dangerously-skip-permissions --bare --no-session-persistence --add-dir "$WORKTREE" < "$PROMPT_FILE"`

`--bare` is the Stage 1 design choice for claude: it skips both the `SessionEnd` Drive-export hook (which would fail on the VM — no Drive sync there) and team-loaded plugins (Codex CLI subagent, typescript-lsp). Stage 2+ will swap `--bare` for `--settings <vm-specific-file>` to re-enable the Codex subagent under claude without re-enabling the broken hook. `--verbose` is **required** with `stream-json` under `--print` (claude 2.1.165 enforces this).

`session-manager.ts` propagates `AUTOPILOT_CLI`, `AUTOPILOT_CURSOR_MODEL`, `AUTOPILOT_CLAUDE_MODEL`, `CURSOR_API_KEY`, and `ANTHROPIC_API_KEY` into the tmux process env via an inline `env KEY=val …` prefix, so the supervisor sees the same selection the dispatcher loaded.

### What does NOT change

Everything outside the runner subprocess is **runner-neutral by design**. Switching CLIs does not change:

- **Artifact contract** — `outcome.json`, `plan.md`, `supervisor.log`, branch naming (`autopilot/sentry-<id>`), and the `.catchall(z.unknown())` extras escape hatch. The bug-fixer still writes the same schema regardless of which CLI ran the session. See [Outcome-shape contract](#outcome-shape-contract-stage-56).
- **Dispatcher loop** — drain pending actions, harvest finished sessions, poll Sentry, dispatch new sessions. The dispatcher doesn't know or care which CLI ran each session.
- **Reporter** — Slack / Sentry / Linear / GitHub side-effects all consume `outcome.json` and don't reference the runner. (The "runner-neutral copy" pass in Stage 4 generalised "droid session" / "sub-droid" wording to "agent session" / "subagent" so reports read correctly regardless of CLI.)
- **Pending-action queue** — same `pending_actions` JSON schema and same drainer.
- **Verifier** — same mechanical checks (plan file present, commit present, branch on origin).
- **Rate limits + concurrency** — same `AUTOPILOT_MAX_CONCURRENT=3`, same hourly cron, same `AUTOPILOT_SESSION_TIMEOUT`.
- **STOP sentinel + escalation paths** — same `<state_dir>/ESCALATION-<runId>` markers, same `state.db.escalations` schema, same Slack notifications.

This intentional separation means rollback between any pair of runners (`droid` ↔ `cursor` ↔ `claude`) is a single env-var flip with no data migration. See the [runbook](../../docs-private/ops/260513_sentry_autopilot_vm_stabilization_runbook.md) for the VM-level mechanics (pre-flight checks, flip-on procedure, log inspection, rollback).

## Workflow switch (CHIEF_BUGFIXER vs CHIEF_ENGINEER2 AUTONOMOUS)

The autopilot can dispatch either the legacy [`CHIEF_BUGFIXER`](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md) workflow (default) or [`CHIEF_ENGINEER2`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) (CE2) — specifically the autonomous-mode entry point [`CHIEF_ENGINEER2_AUTONOMOUS.md`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2_AUTONOMOUS.md). Selection is per-VM via the `AUTOPILOT_WORKFLOW` env var (see the feature flag matrix above). Until 2026-06-05 the CE2 path went through a separate autopilot-only wrapper at `factory/sentry-auto-fix-ce2.md`; the wrapper has been retired and CE2_AUTONOMOUS.md is dispatched directly. See [`docs/plans/260605_autopilot-autonomous-migration/PLAN.md`](../plans/260605_autopilot-autonomous-migration/PLAN.md) for the migration record.

### What CE2_AUTONOMOUS.md provides

CE2 is the team's general-purpose engineering workflow — bigger, more deliberative, assumes a human at the keyboard. CE2_AUTONOMOUS.md is the autonomous-mode layering of CE2: it bakes in `bug_mode: true`, replaces every "ask the user" checkpoint with the deterministic-evidence default, and threads `diagnosis_confidence` through the judgment-block lifecycle. The autopilot dispatches it directly — there is no overlay file in between.

The autopilot still injects three categorical rules at prompt-build time (in `scripts/sentry-autopilot/prompt-builder.ts::buildWorkflowInstructionSection`), because these are project-specific cost choices rather than CE2 conventions:

1. **`bug_mode: true` and `review_mode: light` in plan frontmatter.** The Critical Workflow Instruction section instructs the agent to write these keys into the plan-doc YAML frontmatter at `docs/plans/<slug>/PLAN.md`. Subagents read the frontmatter on re-entry, so the directives propagate without inline prompt text. `review_mode: light` selects 1-2 reviewers with auto-escalation triggers; `bug_mode: true` selects the bug-diagnosis specialist set.
2. **Skip Phase 7 Final Review** when diagnosis confidence is high and reviewers concurred at light intensity. Phase 7 is a deliberation step designed for the human-in-the-loop case; autopilot sessions skip it to stay inside the `AUTOPILOT_SESSION_TIMEOUT` envelope. Documented as a one-liner in PLAN.md's `## Notes` section.
3. **Pathologist-Lite, never the heavy Pathologist.** Autopilot sessions dispatch [Pathologist-Lite](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST.md) (single specialist pass) at the postmortem step. Open design work on running the full Pathologist asynchronously post-fix is tracked in [`docs/plans/260604_autopilot_async_full_pathologist.md`](../plans/260604_autopilot_async_full_pathologist.md) — intentionally deferred; current behaviour is Pathologist-Lite only.

`prompt-builder.ts` also injects an **Autopilot Session Override** near the top of every autopilot prompt. This is not a config knob: it tells the spawned agent to skip inherited Sentry MCP probe guidance (`mcp__sentry__whoami` / `mcp probe`) because the autopilot VM is REST-only, and it lists the canonical Sentry REST endpoints the session should use for evidence retrieval.

### `diagnosis_confidence` as the commit gate

CE2's bug-diagnosis specialist emits a separate `diagnosis_confidence` field (numeric in `[0, 1]`) in its judgment block, distinct from the integer `confidence` field reviewers/implementers emit. This is first-class in `coding-agent-instructions/workflows/CHIEF_ENGINEER2/schemas/subagent-report.ts` and the autopilot's outcome contract surfaces it as the gate for the auto-commit decision under `AUTOPILOT_PHASE=guarded` / `full`. The two confidence metrics are independent — diagnosis confidence is root-cause certainty; integer confidence is outcome-level confidence in the produced artifact.

### Plan-file resolution (CE2-native + dual-accept)

CE2 writes the plan at `docs/plans/<slug>/PLAN.md` inside the worktree. The autopilot's `outcome.plan_file` schema accepts either this CE2-native path OR the legacy literal `'plan.md'` (transitional, used by eval mode). After verifier runs and before the worktree slot is released, `session-manager.ts::trySnapshotPlanFile()` snapshots the file to `<artifactDir>/plan.md`, which is the canonical durable location the reporter reads (worktree is gone by reporter time). See [`outcome-schema.ts`](../../scripts/sentry-autopilot/outcome-schema.ts) for the `planFileSchema` shape (max 512 chars, no absolute paths, no `..` segments).

### What does NOT change between workflows

Like the runner CLI switch, the workflow switch is contained: `outcome.json` schema, branch naming, the verifier, the pending-action queue, the reporter, Linear handoff body, and the dispatcher loop are all workflow-neutral. Rollback from `ce2` → `chief_bugfixer` is a single env-var flip.

### Operational status

CE2 ships at `disabled` (default `chief_bugfixer`) and promotes through the same observation cadence as every other autopilot flag — at least 3 days of VM observation per intermediate value before flipping. As of 2026-06-05 the autopilot-only wrapper has been retired in favour of running CE2_AUTONOMOUS.md directly; cost prunes (`bug_mode`, `review_mode: light`, Phase 7 skip, Pathologist-Lite) are injected by `prompt-builder.ts` rather than living in a separate overlay file.

## Branch convention + push policy

- The bugfixer commits to `autopilot/sentry-<safeSentryId>`. The `safeSentryId` is the Sentry issue ID with non-`[A-Za-z0-9._-]` characters replaced by underscore. The pattern is enforced by Zod `BRANCH_RE` in [`outcome-schema.ts`](../../scripts/sentry-autopilot/outcome-schema.ts).
- A per-worktree pre-push hook ([`hooks/pre-push`](../../scripts/sentry-autopilot/hooks/pre-push)) refuses any push that isn't to `refs/heads/autopilot/*`. `main` and `dev` are explicitly rejected.
- Installation requires `extensions.worktreeConfig=true` at the superproject level — [`setup-worktrees.sh`](../../scripts/sentry-autopilot/setup-worktrees.sh) enables it and validates the hook fires from inside slot-0 before exiting.
- `freshenWorktree()` runs `HUSKY=0 npm ci` and re-applies the worktree-scoped `core.hooksPath` so the husky `prepare` script doesn't clobber the autopilot hook chain. After checking out `origin/dev`, `freshenWorktree()` also runs `git submodule sync --recursive` and `git submodule update --init --recursive` so each dispatch starts on the current `rebel-system` / `super-mcp` / `coding-agent-instructions` pointers (a stale pointer used to make some autopilot diagnoses miss recent fixes).

## PR auto-merge into `dev` (Stage E)

Under `pushMode=pr` with passing verification and an `auto_committed` outcome, `planActions()` now enqueues **two** pending actions back-to-back: `pr_open` (creates the PR against `dev`) and `pr_merge` (squash-merges it). They sit in `ACTION_DRAIN_ORDER` immediately adjacent so a single drain pass both opens and lands the PR, removing the human-merge bottleneck that previously held autopilot fixes in queue.

- `Reporter.executePrMerge()` calls `PUT /repos/{owner}/{repo}/pulls/{n}/merge` with `merge_method: 'squash'`. It reads the PR number from `issue.pr_url` (written by `executePrOpen` in the immediately-prior drain step), so a missing `pr_url` surfaces as a transient error and retries on the next tick.
- `Reporter.probePrMerged()` GETs the PR resource and returns `merged === true`, making re-runs after a transient failure idempotent.
- 405 (not mergeable: branch protection, failing checks, conflicts) and 409 (head SHA changed) are treated as **permanent errors**. After 5 attempts the action is escalated through the standard `state.db.escalations` + `ESCALATION-<runId>` + Slack path.
- 5xx is transient and the drainer retries.

The PR body explicitly notes that auto-merge is enabled. CI required by branch protection will surface as 405 → escalation; if you need a CI-wait gate, fail the action until the merge is mergeable instead of bypassing.

## Triage noise filter + Sentry archive cleanup

Two related cleanup paths keep the autopilot from burning bugfixer slots on issues it would never confidently fix, and keep Sentry from accumulating noise:

- **Noise pre-filter** ([`noisePatterns.ts`](../../scripts/sentry-autopilot/noisePatterns.ts)): mirrors the noise categories in [`docs/project/SENTRY_TRIAGE.md`](SENTRY_TRIAGE.md) (Chromium native, macOS system, errno user-environment, network errno, Squirrel updater). `triageIssue()` consults `matchesNoiseTitle()` **before** the fatal/crash gate so titles like `partition_alloc::internal::OnNoMemoryInternal()` (a fatal-level Chromium crash) are skipped instead of dispatched. User-reported issues bypass the noise filter — a real human report always dispatches.
- **Skipped-issue archive enqueue** (`enqueueArchivePendingAction()` in [`dispatcher.ts`](../../scripts/sentry-autopilot/dispatcher.ts)): every non-user-reported triage skip and every stale-housekeeping match enqueues a `sentry_status: archived_until_escalating` pending action. The drainer's existing `executeSentryStatus` path mutates Sentry; the probe is idempotent (Sentry status `ignored` short-circuits), so re-runs are safe. User-reported issues are exempt per SENTRY_TRIAGE.md § "Stale-archiving: do NOT auto-archive on the 7-day rule".

Operational reversal: a sudden volume spike re-surfaces archived issues via Sentry's `archived_until_escalating` substatus (same semantic as the manual "Archive > Until Escalating" button).

## User-reported bugs: response draft for Slack (auto_committed only)

When a Sentry issue originated from the Sentry **User Feedback widget** (`errorType === 'feedback'`) AND the bugfixer reaches an `auto_committed` outcome, the autopilot generates a non-technical draft message we can send back to the reporter. The intent: close the loop with users who took the time to report something, without forcing an engineer to write the reply.

### Data path

1. **Poller** ([`poller.ts`](../../scripts/sentry-autopilot/poller.ts)) — `mapSentryIssue` extracts `userEmail` and `userName` from the Sentry payload **only when** `errorType === 'feedback'`. There is no fallback to `event.user.email` for logged-in users; the goal is "user gave us their email via the feedback widget", not "we happen to know who was logged in".
2. **State DB** ([`state.ts`](../../scripts/sentry-autopilot/state.ts)) — persisted in `issues.user_email` and `issues.user_name` columns. Idempotent `ALTER TABLE` migrations cover existing DBs. `normalizeIssueRow` surfaces both fields so `getIssue` / `listIssuesWithPendingActions` consumers see them.
3. **Dispatcher** ([`dispatcher.ts`](../../scripts/sentry-autopilot/dispatcher.ts)) — propagates `userEmail` / `userName` from the polled issue into `db.upsertIssue` (defaulting to `null`).
4. **Prompt builder** ([`prompt-builder.ts`](../../scripts/sentry-autopilot/prompt-builder.ts)) — when `isUserReported`, `buildUserReportedSection` instructs the agent to write `user_response_draft.md` into the artifact directory. The agent is told to (a) address the reporter by first name when one is available, (b) explain the bug and fix in plain language with no code or jargon, and (c) use conditional timeline language — see below.
5. **Reporter** ([`reporter.ts`](../../scripts/sentry-autopilot/reporter.ts)) — gates the user-facing Slack messages. `planActions` only emits `slack_user_alert` + `slack_draft_response` when `issue.is_user_reported === true` AND `outcome.outcome === 'auto_committed'`. Both messages include a `*Reporter:* Name <email@example.com>` line built by `formatReporterContactLine` so a human can follow up directly.

### Timeline language (load-bearing)

The agent is explicitly instructed in the prompt:

- If the fix was just auto-committed to `dev`, the draft may say it will ship in the next release, **"typically within a few days"** — phrased as a soft expectation, not a guarantee, and never a specific date.
- If the fix has NOT been committed to `dev` (PR opened, escalated, plan only), the draft must NOT promise any timeline. Phrasing like "we're working on it" or "the team is looking into it" is acceptable.

This is enforced at the prompt level rather than the reporter level because the agent generates the draft text. The reporter's only gate is the binary `auto_committed`-vs-not decision on whether to send the draft at all.

### Why not auto-send the email?

The autopilot **drafts** the response and posts it to Slack; it does not send email directly. A human reviews the draft, confirms the diagnosis matches the user's report, and sends it. This keeps the autopilot one step removed from outbound user communication, which is the right risk posture given the rest of the pipeline is still phased in.

## Handoff to a human-driven agent (Linear ticket contract)

When the autopilot completes an investigation but stops short of shipping a fix on its own — `plan_created` (most commonly: confidence below the auto-commit gate), `escalated`, or any non-`auto_committed` outcome that should reach a human — the **Linear ticket is the handoff document**. The picking-up agent (a human operator's fresh droid session, started from the Linear ticket title) must have enough context to either confirm + ship the autopilot's plan or independently re-investigate, **without needing access to the autopilot VM**.

The Linear ticket body has four sections, built by `buildLinearHandoffBody()` in [`reporter.ts`](../../scripts/sentry-autopilot/reporter.ts):

1. **Autopilot summary** — outcome, confidence, Sentry URL, autopilot branch name, and the `files_changed` proposed by the bugfixer.
2. **How to pick this up** — exact `git fetch && git checkout autopilot/sentry-<id>` commands so the operator's agent inherits the autopilot's WIP branch (with `plan.md` committed at the repo root). When no branch was committed (autopilot didn't reach a confident plan), this section says so explicitly and tells the operator to start fresh from `dev`.
3. **Instructions for the picking-up agent** — frames the autopilot's diagnosis as **evidence, not ground truth**. Tells the agent to independently re-derive the failure mechanism from Sentry rather than rubber-stamp, to use a different model family for diversity, and to reconcile divergent diagnoses against the autopilot's evidence rather than silently override. Includes any `blockers_to_auto_commit` and `risks` recorded by the bugfixer.
4. **Full plan (autopilot's diagnosis)** — the contents of `plan.md` from the artifact directory, inlined verbatim and capped at 50 KB (footer marker if truncated, full plan available on the autopilot branch).

The same body is used for both `linear_create_issue` (autopilot-created tickets) and `linear_comment_existing` / adopted-link comments (when the autopilot finds a pre-existing user-filed Linear ticket via `sentry.check_linear_link` and adds context to it rather than creating a new one). For the comment path, a `Sentry Autopilot update` header is prepended so the user agent knows what posted it.

**Why this matters**: a previous version of `buildLinearDescription` produced a ~850-character summary plus a path to `plan.md` on the autopilot VM. That left a fresh droid session with about 6% of the diagnostic signal the autopilot had, and forced the picking-up agent to redo most of the diagnostic work from scratch. The current contract is the source of truth — when changing it, update [`reporter.linearHandoffBody.test.ts`](../../scripts/sentry-autopilot/__tests__/reporter.linearHandoffBody.test.ts) deliberately rather than on autopilot.

**Branch name validation**: the `## How to pick this up` section renders `branch_name` directly into a copy-pasteable `git checkout` block. Because `branch_name` reaches the reporter via the outcome JSON's `.catchall(z.unknown())` extras escape hatch on `plan_created` / `escalated` outcomes (only `auto_committed` validates the typed `BRANCH_RE` field), the reporter validates it again locally before rendering. Anything that doesn't match `^autopilot/[A-Za-z0-9._-]+$` falls back to the no-branch handoff section and is logged via `logWarn`. This prevents a malformed or prompt-injected branch name from round-tripping into a Linear ticket as an executable instruction.

**Plan-availability fallback**: when `plan.md` is missing, unreadable, or the artifact directory was reaped, the body still renders persisted prose fields (`root_cause`, `plan_summary`, `diagnosis`, `reason`, `blockers_to_auto_commit`, `risks`) from `outcome.json` (durable in `state.db` even after artifact cleanup) so the picking-up agent isn't left with an outcome name and a confidence number alone.

## MCP-free invariant (Stage F policy)

> **Autopilot orchestration uses Sentry REST API only.** The poller, dispatcher, session-manager, reporter, and any other code path inside `scripts/sentry-autopilot/` MUST NOT depend on the Sentry MCP server. Sentry access is via `SENTRY_API_BASE_URL` + `SENTRY_AUTH_TOKEN` direct HTTP calls. The Sentry MCP in `~/.factory/mcp.json` is available only to the CHIEF_BUGFIXER agent during its investigation phase (Stage G in the planning doc); it is never on the autopilot cron loop's critical path. Rationale: MCP disconnects in Droid are a known operational hazard, and the loop must keep running through them.

Enforced by `validate:fast` via [`scripts/check-autopilot-no-mcp.ts`](../../scripts/check-autopilot-no-mcp.ts), which fails if any file under `scripts/sentry-autopilot/` imports an `mcp*` module, calls `await mcp.*`, or uses a `mcp__sentry__*` Droid-tool pattern. Doc/comment references are allowed (this file is the invariant itself).

## Pending-action queue (Stage C)

Side effects (Sentry status updates, Slack posts, Linear issues, PRs) are durable per-issue via `issues.pending_actions TEXT NULL` — a Zod-validated JSON array. Each action has an `idempotency_key`, an `attempts` counter, and a `last_error`.

- **mirror mode**: legacy inline reporter still fires; the row-level shadow is reconciled by probing external state (`reconcileAll` in [`pending-drainer.ts`](../../scripts/sentry-autopilot/pending-drainer.ts)) — strictly observational, never executes.
- **enforce mode**: legacy inline reporter is replaced by `drainer.drainIssue()`. At start-of-tick `drainer.drainAll()` recovers from a crashed previous run.

When an action exhausts retries (`attempts >= MAX_ATTEMPTS_PER_ACTION`, currently 5), the drainer:

1. Appends a row to `state.db.escalations` (see Appendix C of the planning doc).
2. Writes `<state_dir>/ESCALATION-<runId>` as a marker file.
3. Best-effort posts a Slack notification.

The dispatcher prints every unacknowledged escalations row to stderr on startup. See [`admin/`](../../scripts/sentry-autopilot/admin/) for the operator tooling that inspects, requeues, and cancels stuck actions.

## Outcome-shape contract (Stage 5.6)

Stage 5.6 added an outcome-shape eval harness with 18 fixtures and captured an 87.04% baseline for the current bug-fixer output shape. The dispatcher prompt now includes a typed **Outcome Contract** for `outcome.json`: `is_bug` must be a JSON boolean when present (never a string or `null`), `diagnosis` must be flat prose (structured data belongs in the preserved `diagnosis_structured` extras escape hatch), and extras must not duplicate typed fields under alternate names.

The harness and prompt tests live under `scripts/sentry-autopilot/__tests__/`. The fixture matcher is intentionally Node-20-compatible; do not reintroduce Node-22-only `fs.globSync` in this path, because CI still runs the autopilot eval checks on Node 20.

## Linear issue semantics and safety rules

The autopilot's `state.db` `issues.linear_issue_id` column records the Linear issue linked to a Sentry issue — but that link is not always created by the autopilot itself. Two distinct paths populate this column:

- **Autopilot-created**: after a `plan_created` or `escalated` outcome with no pre-existing Linear link, `reportOutcome` calls `createLinearIssue` (in [`reporter.ts`](../../scripts/sentry-autopilot/reporter.ts)), which creates a Linear issue titled `[Autopilot] <title>` with description `Autopilot outcome: <outcome>\nConfidence: <pct>%\nSentry: <url>\nPlan: <path>`. The autopilot stores the returned Linear ID in `linear_issue_id`.
- **Autopilot-adopted**: when `shouldCreateLinearIssue` is true, `reportOutcome` first calls `fetchLinearLinkFromSentry` (the `sentry.check_linear_link` operation) to probe the Sentry issue's annotations for an existing Linear link. If found, it resolves the identifier via `resolveLinearIssueId`, comments on the existing Linear issue with the diagnosis (via `commentOnLinearIssue`), and stores that existing issue's ID in `linear_issue_id` with `reused: true` on the returned `LinearIssue` object. This path handles user-reported bugs that were already linked to a Linear issue before the autopilot ran.

**Identifying autopilot-created Linear issues.** The canonical discriminator is the `[Autopilot]` title prefix — this is set by `createLinearIssue` in `reporter.ts`. Additional discriminators (use as cross-check, not primary filter):

- Description starts with `Autopilot outcome: <outcome>\nConfidence: <pct>%\nSentry: <url>\nPlan: <path>` — see `buildLinearDescription` in `reporter.ts`.
- No `REBEL` label, no `assignee`, no `startedAt` — autopilot-created issues are bare.
- User-reported issues (identified by Sentry's `isUserReported` signal = `errorType === 'feedback'` or `userReportCount > 0`; written to `is_user_reported` column at poll time in [`poller.ts`](../../scripts/sentry-autopilot/poller.ts)) typically have a `REBEL` label and a real assignee if a human has triaged them.

**Cleanup and bulk-mutation safety rule.** Any operator or agent performing bulk Linear operations driven by `state.db` MUST filter by the `[Autopilot]` title prefix before mutating. Querying `linear_issue_id IS NOT NULL` as a proxy for "autopilot-owned" will incorrectly capture user-reported bugs whose Linear linkage was adopted by the autopilot via `sentry.check_linear_link`. The `[Autopilot]` prefix is the only reliable signal.

**`is_user_reported` column meaning.** This column is set at poll time from Sentry (`isUserReported: errorType === 'feedback' || userReportCount > 0` in `poller.ts`) and reflects whether the Sentry issue was reported by a real user through in-app feedback. It does **not** mean "the Linear issue linked to this row was user-created." A user-reported Sentry issue can have an autopilot-created Linear issue (if no pre-existing link was found), or an adopted pre-existing Linear issue. The column controls dispatch priority (`is_user_reported DESC`) and triggers the user-response draft workflow in `reportOutcome`; it has no bearing on Linear ownership.

## Admin tooling

Three CLIs under [`scripts/sentry-autopilot/admin/`](../../scripts/sentry-autopilot/admin/) cover the day-to-day operator workflow:

- `pending-inspect.ts [--sentry-id <id>]` — print rows with non-empty `pending_actions` queues as structured JSON.
- `pending-requeue.ts --sentry-id <id> [--kind <kind>]` — reset `attempts=0`, `last_error=null` so the next drain retries.
- `pending-cancel.ts --sentry-id <id> --idempotency-key <key>` — remove a permanently-stuck action.

The operational runbook ([`docs-private/ops/260513_sentry_autopilot_vm_stabilization_runbook.md`](../../docs-private/ops/260513_sentry_autopilot_vm_stabilization_runbook.md)) has step-by-step "Slack pings, what now?" recipes that use these tools.

## Related docs

- [`docs/plans/260515_autopilot_deferred_items.md`](../plans/260515_autopilot_deferred_items.md) — full implementation plan, including PR template (Appendix A), escalations schema (Appendix C), and the deferred-item-to-stage map (Appendix D).
- [`docs-private/ops/260513_sentry_autopilot_vm_stabilization_runbook.md`](../../docs-private/ops/260513_sentry_autopilot_vm_stabilization_runbook.md) — VM operational runbook.
- [`coding-agent-instructions/workflows/CHIEF_BUGFIXER.md`](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md) — the legacy workflow the bugfixer agent follows inside each dispatched session (default; `AUTOPILOT_WORKFLOW=chief_bugfixer`).
- [`coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) — the alternative workflow used when `AUTOPILOT_WORKFLOW=ce2`, via the AUTONOMOUS.md entry point below.
- [`coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2_AUTONOMOUS.md`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2_AUTONOMOUS.md) — the autonomous-mode entry point dispatched directly when `AUTOPILOT_WORKFLOW=ce2`. See [Workflow switch](#workflow-switch-chief_bugfixer-vs-chief_engineer2-autonomous) above.
- [`factory/sentry-auto-fix.md`](../../factory/sentry-auto-fix.md) — the CHIEF_BUGFIXER prompt template (rendered by [`prompt-builder.ts`](../../scripts/sentry-autopilot/prompt-builder.ts) at dispatch time).
- [`docs/plans/260604_autopilot_async_full_pathologist.md`](../plans/260604_autopilot_async_full_pathologist.md) — deferred design work for running the full Pathologist asynchronously post-fix (current state: Pathologist-Lite only).
