---
description: "Rebel-specific Sentry triage configuration — project IDs, thresholds, REST fallback, noise categories, workflow handoffs"
last_updated: "2026-06-11"
---

# Sentry Triage — Rebel Project Config

This is the **project-specific configuration** for Sentry triage in the Mindstone Rebel repo. The actual triage process lives in the project-agnostic guide:

> **[`coding-agent-instructions/docs/SENTRY_TRIAGE.md`](../../coding-agent-instructions/docs/SENTRY_TRIAGE.md)** — Read this in full before triaging. It contains the STOP gates, severity criteria, log format, MCP usage, silencing process, and JSON schema.

### See Also

- [TRIAGE_AND_FIX_ASSIGNED_TICKETS_LINEAR_SENTRY](./TRIAGE_AND_FIX_ASSIGNED_TICKETS_LINEAR_SENTRY.md) — Fix-and-close loop for bugs already assigned in Linear (pull "my issues" → prioritise → fix via CHIEF_ENGINEER2 → comment → resolve in Linear *and* Sentry). This doc is *what* to fix; that one is *how to close the loop*.
- [ERROR_MONITORING_AND_SENTRY](./ERROR_MONITORING_AND_SENTRY.md) — Technical reference for Sentry implementation: what gets captured, tagging conventions, how to add new captures.
- [SENTRY_ISSUE_ANALYSIS](../../coding-agent-instructions/docs/SENTRY_ISSUE_ANALYSIS.md) — Companion guide for extracting full diagnostic evidence from a single Sentry issue once triaged as SHOULD FIX.
- [CHIEF_BUGFIXER](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md) — Workflow for investigating and fixing SHOULD FIX issues.
- [CHIEF_PATHOLOGIST](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST.md) — Postmortem workflow run on every bug confirmed fixed by a commit.

---

## How to Run Triage

1. **Read the generic guide** ([SENTRY_TRIAGE](../../coding-agent-instructions/docs/SENTRY_TRIAGE.md)) end-to-end. **If the Sentry MCP isn't connected** (the usual case in a Claude Code session), don't STOP — use the [REST API fallback](#accessing-sentry--rest-api-fallback-when-the-mcp-isnt-connected) below.
2. Apply the **Project Configuration** values below wherever the generic guide uses `<PLACEHOLDER>` tokens.
3. **Run multi-axis discovery, not just the frequency sweep** — see [Discovery & Ranking](#discovery--ranking--multi-axis-the-heart-of-the-sweep). Run all retrieval passes (volume / breadth / reactivated / new / regressed + the internal-cohort tag), merge into one candidate set, apply the **multi-path severity gate** (break the AND) with the **windowed rate**, then de-noise. This supersedes the generic guide's single-axis `sort=freq` framing.
4. Apply the **Project-Specific Noise Categories** below in addition to the generic noise framework.
5. **Drain the watch list** — run the [Escalation Ledger](#escalation-ledger--forcing-terminal-dispositions) check (issues carried in ≥3 prior logs → top-of-log `DECISION REQUIRED` block) and the archive-forever footgun audit.
6. Use the **Rebel commit conventions** below when recording commit-based resolutions.
7. **Spot-check the alert rules against this run's noise findings** (read-only): if a class you marked SKIP this run is paging (`lastTriggered` recent on "Rebel Error"), note it as an alert-hygiene gap in the log and propose a filter — see [Alert-Rule Hygiene](#alert-rule-hygiene-what-pages-the-team-vs-what-the-sweep-catches). REST: `GET /api/0/projects/mindstone/rebel/rules/`.

CI invokes this file via `droid exec --auto medium -f docs/project/SENTRY_TRIAGE.md` from `.github/workflows/sentry-triage.yml` — the droid is expected to read both this file and the generic guide it links to.

---

## Project Configuration (Rebel)

Fill these into the generic guide's placeholders:

| Field | Value |
|-------|-------|
| `<PROJECT_NAME>` | Rebel |
| `<ORG_SLUG>` | `mindstone` |
| `<PROJECT_SLUG>` | `rebel` |
| `<PROJECT_ID>` | `4510399226839040` |
| `<REGION_URL>` | `https://us.sentry.io` |
| `<ISSUE_PREFIX>` | `REBEL` (e.g. `REBEL-Q2`, `REBEL-HP`, `REBEL-123`) |
| `<TRIAGE_LOG_DIR>` | `docs-private/sentry-triage-log/` |
| `<POSTMORTEM_DIR>` | `docs-private/postmortems/` (filename pattern `YYMMDD_<bug-name>_postmortem.md`) |
| `<SHOULD_FIX_THRESHOLD_DAILY>` | `>5 events/day` — **computed as a windowed rate (events-in-14d ÷ 14), not total ÷ lifetime**. See [Discovery & Ranking → Rate](#rate--a-trailing-14d-window-not-lifetime). |
| `<SHOULD_FIX_THRESHOLD_USERS>` | `>1 user` (path 1 of the OR-gate) |
| Breadth entry-path (Rebel) | `≥10 distinct users in 14d`, any rate (OR-gate path 2; Sentry's "widespread" threshold) |
| Server-side entry-path (Rebel) | `>5/day` windowed, **any user count** (OR-gate path 3; the `userCount:0` class, e.g. REBEL-64K) |
| `<STALE_THRESHOLD>` | `7 days` (`<STALE_THRESHOLD_DAYS>` = `7`) |
| `<LOG_RETENTION>` | `30 days` (`<LOG_RETENTION_DAYS>` = `30`) |
| `<ARCHIVED_REVIEW_WINDOW>` | `2 months` |
| `<SLOW_BURN_THRESHOLD>` | `3 of last 7 daily logs` |
| `<POSTMORTEM_WORKFLOW>` | [`CHIEF_PATHOLOGIST`](../../coding-agent-instructions/workflows/CHIEF_PATHOLOGIST.md), launched as a `worker` subagent in standalone mode, one parallel Task call per resolved bug, emitting `[BUG-POSTMORTEM]` structured log lines for longitudinal analytics. **Mandatory** — do not skip. |
| `<INVESTIGATION_WORKFLOW>` | [`CHIEF_BUGFIXER`](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md). For investigation droid selection, see [`PROJECT_OVERRIDES`](./PROJECT_OVERRIDES.md) (current `debugger-*` roster). For implementation, use `implementer`. For review, use `reviewer-gpt5.5-high`. |

### Useful URLs (pre-built)

| View | URL |
|------|-----|
| All unresolved issues | [link](https://mindstone.sentry.io/issues/?project=4510399226839040&query=is%3Aunresolved) |
| Stale issues (7+ days old) | [link](https://mindstone.sentry.io/issues/?project=4510399226839040&query=is%3Aunresolved%20lastSeen%3A%2B7d&statsPeriod=14d) |
| Unresolved user-bug-reports (desktop) | [link](https://mindstone.sentry.io/issues/?project=4510399226839040&query=is%3Aunresolved%20source%3Auser-bug-report&statsPeriod=90d) — see [User Bug Reports](#user-bug-reports-in-app-feedback--rebel-60c-pattern) |
| Unresolved cloud-feedback (mobile/web) | [link](https://mindstone.sentry.io/issues/?project=4510399226839040&query=is%3Aunresolved%20source%3Acloud-feedback&statsPeriod=90d) — see [Cloud Feedback](#cloud-feedback-mobileweb-in-app-feedback) |

---

## Accessing Sentry — REST API fallback when the MCP isn't connected

The generic guide **STOP-gates on the Sentry MCP**. That gate is correct for Droid/CI runs (the MCP is wired via `.factory/mcp.json`), but the MCP is usually **not** connected in a Claude Code session. Rather than stopping, fall back to Sentry's **REST API** — it gives the same fidelity (event counts, user counts, last-seen, tags) for triage. Do **not** scrape the web UI; use the API.

> **Canonical mechanics live in [`SENTRY_REST_FALLBACK.md`](../../coding-agent-instructions/docs/SENTRY_REST_FALLBACK.md)** — token scope, the MCP-availability probe, the logging contract, and the REST equivalents for issue-detail / event / trace / attachment / resolution endpoints. Read it for those; this section only adds the **triage-specific listing** endpoints it doesn't cover (the SSOT is issue-ID-scoped for the bugfixer flow and notes `search_*` has no single REST equivalent).

The User Auth Token lives in **`.env.local` as `SENTRY_AUTH_TOKEN`** (documented in `.env.example` for `scripts/fetch-sentry-attachment.ts`). Load it without echoing:

```bash
export SENTRY_AUTH_TOKEN="$(grep -E '^SENTRY_AUTH_TOKEN=' .env.local | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
```

Base `https://us.sentry.io`, org `mindstone`, project `rebel`, header `Authorization: Bearer $SENTRY_AUTH_TOKEN`. Triage-specific listing endpoints (use `curl --get --data-urlencode` per param):

- **List issues:** `GET /api/0/projects/mindstone/rebel/issues/?query=is:unresolved&sort=freq` — returns `shortId`, `count`, `userCount`, `title`, `lastSeen`, `annotations` (Linear links). Add `&query=is:unresolved firstSeen:-7d` for the new-issue sweep.
- **User bug reports (desktop):** `query=is:unresolved source:user-bug-report` (see [User Bug Reports](#user-bug-reports-in-app-feedback--rebel-60c-pattern)).
- **Cloud feedback (mobile/web):** `query=is:unresolved source:cloud-feedback` (see [Cloud Feedback](#cloud-feedback-mobileweb-in-app-feedback)). Distinct channel, distinct `source` value — the `user-bug-report` query does **not** catch these.
- **Issue-detail / latest-event / attachments / resolution:** see the REST equivalent table in [`SENTRY_REST_FALLBACK.md`](../../coding-agent-instructions/docs/SENTRY_REST_FALLBACK.md#rest-endpoint-mapping).

**Gotchas:**
- The issues endpoint only accepts `statsPeriod` ∈ {``, `24h`, `14d`} (NOT `90d`).
- `.env.local` is gitignored and is **not** copied into fresh worktrees — copy it in (`cp <primary>/.env.local .`) before running the fallback from a worktree.
- Resolving/archiving via the API is an outward action — leave it to a human / explicit go-ahead per the silencing process; treat the API as read-mostly for triage (consistent with recent triage logs).

---

## Discovery & Ranking — multi-axis (the heart of the sweep)

> **Why this exists.** Ranking the stream by **event frequency alone is a recognized anti-pattern** (Google SRE, Sentry, Datadog, GitLab): it serves neither broad-but-quiet issues nor flat-but-chronic ones. Our own history proves it — **REBEL-64K** (1971 server-side failures, invisible ~13 days because server errors carry `userCount=0`), **REBEL-63K / 5EJ** (mid-frequency, many users, never in the freq head), and **REBEL-1G8** (noted "watch" in 15 logs, never acted) all slipped a freq-only funnel. The fix is **multi-axis retrieval merged into one candidate set + a multi-path gate + a windowed rate** — and a draining ritual (see [Escalation Ledger](#escalation-ledger--forcing-terminal-dispositions)) so coverage actually converts to fixes instead of a bigger "watch" pile.

> **One merged list, not annexes.** Run the passes below and **merge their hits into the single SHOULD-FIX candidate set** the run already assesses. Do **not** emit a separate report section per pass — a standalone "breadth pass" section is just another pile humans skim past. The passes are *retrieval*; the gate is *inclusion*; the output is *one list*.

### Retrieval passes (run all; merge results; then de-noise + gate)

Each is one REST query (gotchas: 100-result cap; `statsPeriod` ∈ {``,`24h`,`14d`}; sort is descending). All validated against project `rebel` 2026-06-18.

| Axis | Query (append to the REST base) | Catches the blind spot | Notes |
|------|------|------|------|
| **Volume** (existing) | `?query=is:unresolved&sort=freq&statsPeriod=14d` | high-volume regressions | the historical sole axis |
| **Breadth** | `?query=is:unresolved&sort=user&statsPeriod=14d` | broad-but-thin (many users, low rate) | `sort=user` = users-affected; surfaced 5BM #4, 5EJ #54, 1G8 #60, 63K #85 in the 100-pull |
| **Recently-reactivated** | `?query=is:unresolved&sort=date&statsPeriod=14d` | an old issue that just got active again | cheap; pairs with the windowed rate |
| **New** (existing) | `?query=is:unresolved firstSeen:-7d` | fresh regressions | keep level-filtering to error/fatal |
| **Regressed** | `?query=is:unresolved is:regressed` | resolved-then-recurred (someone thought it was fixed) | high-signal, usually tiny |
| **Internal cohort** *(a TAG, not a standing pass)* | `?query=is:unresolved user.email:*@example.com level:[error,fatal]` | dogfooders silently hitting bugs | annotate surfaced issues with internal-user concentration; do **not** elevate to a daily headline pass — it's one cohort signal among many |

> **Inspect the full merged set at triage altitude, not just the freq head.** Past runs read only the top ~25 of the freq pull and waved the rest off as "known noise"; that is where the mid-tail misses live. The other axes exist precisely so the mid-tail surfaces — assess every merged candidate against the gate, then apply the noise taxonomy.

### Severity gate — break the conjunctive AND

The historical gate (`>5 events/day` **AND** `>1 user`) is a conjunction of two *necessary* conditions, so anything strong on one axis but weak on the other is excluded by construction. **Replace it with independent OR entry-paths** — an issue is **SHOULD-FIX** if it meets **any**:

1. **(existing)** `>5/day` (windowed — see below) **AND** `>1 user`.
2. **Breadth:** **≥10 distinct users** (`userCount`), *any* rate. (Sentry's own "What to Prioritize" treats `>10 users` as widespread.) Note `userCount` is **lifetime** (the list endpoint has no per-window user count), so the **recency guard does the windowing** — require `lastSeen` within 14d. "Broad" then means "broad *and* still firing," not "was broad once." Catches 63K (13u), 5EJ (34u), 1G8 (30u), 5BM (176u).
3. **Server-side / single-loop high-volume:** `>5/day` (windowed) **regardless of user count**. This is the **REBEL-64K** path — note 64K is `environment:production`, `server_name:localhost`, **not** `cloud`, so do **not** filter by env; instead, on the volume pull, stop auto-skipping `userCount:0`/`1` high-volume issues. (`userCount:0` is not a searchable token — read the field off each result.)
4. **(existing carve-outs, unchanged):** user-visible raw/unhumanized errors; crashes; `cloud.image_rollback.recovered`; the feedback slices (frequency-exempt).

A hit on any path joins the one SHOULD-FIX list. False positives here cost one report line (this is a read-only shortlist, not a pager), so lean inclusive.

### Rate = a trailing 14d window, not lifetime

Compute the daily rate as **events-in-14d ÷ 14**, **not** `total ÷ (lastSeen − firstSeen)`. Lifetime division is perverse: at constant volume an issue's computed rate *falls as it ages*, so chronic bugs drift **away** from the gate over time — the literal "long-standing bugs ignored" complaint. (A 7d window would be slightly crisper but REST only offers `{24h,14d}`, so 14d it is.)

> **⚠️ Use the windowed `stats` bucket, NOT the `count` field.** Verified 2026-06-18: the issues list endpoint's **`count` and `userCount` are LIFETIME totals** — they do **not** change with `statsPeriod` (REBEL-1G8 returned `count=3425`/`userCount=30` identically at `statsPeriod=''`, `24h`, and `14d`). **Never divide `count` by 14** — that would over-state old issues. The *windowed* number lives in the list response's **`stats["14d"]`** field (an array of `[timestamp, count]` daily buckets when you pass `statsPeriod=14d`); **events-in-14d = sum of those buckets** (e.g. 1G8 = 1360 over 14d → ~97/day), then ÷14.

### Coverage without randomness — deterministic rotation + a backtest

**Do not add random backlog sampling.** It is essentially unadopted as a triage *router* (high variance on rare events, wastes scarce attention; risk-based selection beats it). Where we want guaranteed coverage of the tail, use **determinism**, which is reproducible and auditable:

- **Axis rotation (overload fallback only):** the default is to **run all retrieval passes every run** (above). Rotation is *only* for when a run genuinely can't deep-assess every axis — then rotate which secondary axis gets the deep look on a fixed cadence (e.g. `cycle-day mod 3` → breadth / reactivated / regressed) so each is covered on a known schedule, with no "random pile." Don't let rotation become a normal substitute for running all passes.
- **Backtest (calibration):** periodically re-run this discovery+gate logic against the last quarter of logs and confirm the known misses still surface (see [the named-miss acceptance set](#acceptance-self-check)). We have 31 logs of ground truth — a deterministic backtest tells you *which rule* failed, which random spot-checks never can.

#### Acceptance self-check

After changing discovery/gate logic, confirm these historical misses surface as SHOULD-FIX under the new rules: **REBEL-64K** (server-side `u=0`), **REBEL-63K** (mid-freq, 13u), **REBEL-5EJ** (broad-thin, 34u), **REBEL-1G8** (15-log chronic), **REBEL-1AF** (11-log). If any still slips, the rule that should have caught it is wrong.

---

## Project-Specific Noise Categories (Electron / Desktop)

These augment the generic "Known Noise Categories" framework. Treat patterns matching these as silencing candidates unless they clearly correlate with a real Rebel bug:

| Category | Examples | Why It's Noise |
|----------|----------|----------------|
| **Native Chromium crashes** | `partition_alloc::internal::OnNoMemoryInternal`, `__pthread_kill`, `logging::LogMessage::HandleFatal` | Internal Chromium/Electron crashes outside our control |
| **macOS system crashes** | `-[NSApplication _crashOnException:]`, `-[AVCaptureDALDevice ...]` | OS-level crashes, often hardware/driver related |
| **User environment** | `ENOSPC` (disk full), `EACCES` (permissions) | User's system state, not our bug |
| **Network failures** | `ENOTFOUND`, `ENETUNREACH`, `ETIMEDOUT` for external services | User's network, firewalls, or transient issues (see [caveat](#network-failures-over-broad-caveat) below) |
| **Third-party updater quirks** | Squirrel `Command failed: 4294967295` (rare edge cases) | Known Windows updater issues with special characters in paths |
| **Worker-exit residue (REBEL-5RT class)** | `the worker has exited` / `the worker is ending` (`fatal`) | Fixed in current releases; residual volume is old builds (~68% of ALL events as of 260610). Do NOT page; do NOT re-adjudicate new sub-fingerprint mints. **Proposed disposition: inbound-filtered at Sentry ingest** (error-message filter, Action A in [OUTWARD_PROPOSAL](../plans/260610_improve-sentry-noise/OUTWARD_PROPOSAL.md)) — once applied, verify via the Stats `filtered` outcome (positive control), and sunset/review the filter when the filtered-outcome volume decays. The capture-side strings live in `WORKER_LIFECYCLE_MESSAGES` (`src/core/logger.ts`) — anyone renaming/extending that list must check the inbound filter stays in sync. ≥0.4.44 regressions stay visible via the structured `['logger-transport-error','REBEL-5RT']` error-level channel, which the message filter does not match. |
| **Model tool-guessing (REBEL-13Y class)** | `MCP error -330xx Argument validation failed` / `-32602 Unknown tool` / `-33002 Tool not found` | The model guesses/mis-invokes tool names under Super-MCP dynamic discovery; handled gracefully via `onMcpError` (`src/core/services/turnPipeline/agentTurnExecute.ts`). High user-count but not our defect. |
| **Deliberate known-condition telemetry** | `captureKnownCondition[…]` (`info`) | Intentional telemetry via the known-conditions registry (`src/core/sentry/knownConditions.ts`). **Each wrapped condition is mirrored to the on-device diagnostic ledger** (`recordKnownConditionLedgerOnly`). Since 2026-06-11 every `info` condition declares a `sink`: `ledger-only` conditions **never reach Sentry at all** (the wrapper skips the capture by construction), so info known-condition volume decays to ~0 on new releases. An `info` known-condition event still in the stream means an old build, or an explicit `sink: 'issue-stream'` adjudication (e.g. `cloud_self_update_credentials_missing`, whose event count IS the stuck-cohort signal). See [ERROR_MONITORING § Level semantics](./ERROR_MONITORING_AND_SENTRY.md#level-semantics--sink-policy-conventions). Not a fix. |
| **Raw status telemetry** | `cloud_connection_*` (degraded/recovered) | **MIGRATED 2026-06-11** — now registry-owned with ledger mirrors (was raw `captureMessage` with no ledger). `recovered` and `degraded` are ledger-only (never captured); `degraded_escalated` is a sweep-visible warning. Old issues (REBEL-570/571/5BC) go dormant — see the [rename map](#registry-migrations-2026-06-1011--old-issue--new-condition-rename-map). |

#### Network-failures over-broad caveat

> **Caveat:** "Network failure" noise applies to *external/third-party* targets and
> *transient* patterns. A **sustained, high-user** `fetch failed` / `ETIMEDOUT` against
> a **Rebel or cloud** endpoint (e.g. REBEL-5D4 `fetch failed`, 802 ev / 59 u) is a
> real-defect candidate — our endpoint may be down. Don't auto-SKIP on the string alone;
> check the target host and the user/time shape first.

### Rebel-specific "user-visible raw error" indicators

When applying the generic guide's "User-visible raw/unhandled errors" rule (SHOULD FIX regardless of frequency), pay particular attention to:

- Sentry issue titles containing raw JSON structures like `{"type":"error",...}`
- `sdk_error_category: unknown` in tags or context
- `invalid_request_error` or similar Anthropic/OpenAI provider error strings leaking to the UI
- Affected files like `AutomationsPanel.tsx`, `useAgentSessionEngine.ts`, or `agentMessageHandler.ts` surfacing untranslated provider errors

These are Rebel-specific symptoms of an LLM-provider error being shown to the user without humanization.

> **Verify against the humanizer before flagging — a raw Sentry title ≠ a raw *user-facing* error.** Sentry captures the unhumanized `rawError`/`ModelError.message` as telemetry; the user sees the *humanized* `displayError`. Before marking a raw-looking issue SHOULD FIX, trace `classifyHttpError`/`classifyError` (`src/core/rebelCore/modelErrors.ts`) → `ModelError.kind` → the owned-kinds switch in `humanizeAgentError` (`packages/shared/src/utils/humanizeAgentError.ts`). If `kind` ∈ `HUMANIZER_OWNED_KINDS` (e.g. `billing`, `invalid_request`, `auth`, `server_error`), the primary UI shows safe humanized copy and it is **not** a user-visible-raw bug — only `kind:'unknown'` falls through to `humanizeUnclassified(rawMessage)`. (The one surface that still shows raw `rawError` is the **Diagnostics → Raw Events** developer view — dev tooling, not the user error path.) Two issues — REBEL-616 (Vertex 403 → `invalid_request`) and REBEL-61V (Anthropic out-of-credits 400 → `billing`) — were flagged SHOULD FIX in the 2026-05-30 run but are humanized end-to-end; see the 2026-06-05 triage log.

---

## User Bug Reports (in-app feedback) — REBEL-60C pattern

Rebel's in-app bug-report form (`src/main/ipc/bugReportHandlers.ts`) submits user-filed reports **through Sentry as transport** — they are **not** native Sentry User Feedback objects. Each is captured as a *message* event with:

- `source: user-bug-report` and `feedback_type: bug_report` tags (set at `bugReportHandlers.ts:443-445`), plus an `urgency` tag (`low`/`medium`/`high`)
- fingerprint `['user-bug-report', title]` (`bugReportHandlers.ts:569`)
- the report body as the event "message" — there is **no exception or stacktrace**

**At the issue level these look identical to ordinary errors** (`issueCategory: error`, `type: default`, `level: error`); the Sentry UI shows **"(No error message)"** because the payload is prose, not an exception. The only reliable discriminator is the **tag** — and it IS queryable: `source:user-bug-report`.

> **Sub-variety — "Company dashboard feedback".** A second desktop surface (the company dashboard feedback widget) also stamps `source:user-bug-report` but with `feedback_type: bug | improvement` (titles like `## Company dashboard feedback`, `**Type:** Improvement idea` / `Something is broken`). Because it shares the `source` tag, the `source:user-bug-report` query already catches it — no separate slice needed. Just don't be surprised when a "bug report" is actually a dashboard improvement idea.

These reports are **high-signal but structurally one-off** — almost always `count=1, users=1`, and no two are alike. The standard severity model and the stale-archive rule both mishandle them, so apply the overrides below.

### Query them as a dedicated slice

Run a **separate pass** for user bug reports — do not let them blend into the generic error stream, where they get lumped into "newest N single-event issues, skip":

```
is:unresolved source:user-bug-report
```

(Pre-built link in the [Useful URLs](#useful-urls-pre-built) table above.)

### Severity: exempt from frequency thresholds

User bug reports are **exempt from the `>5 events/day` AND `>1 user` thresholds** — same spirit as the generic guide's "user-visible raw error → SHOULD FIX regardless of frequency" carve-out. Assess each on **content**, not frequency; by design they never trip aggregate thresholds, so frequency math is the wrong axis.

Default disposition: these are **product feedback, not Sentry-fixable exceptions** — route to the product backlog via Linear (below). Escalate to SHOULD FIX only when the report describes a reproducible defect in Rebel's own code that warrants an engineering fix.

### Stale-archiving: do NOT auto-archive on the 7-day rule

A user bug report is `count=1` with `lastSeen == firstSeen`, so it will **always** look stale after 7 days. **Do not archive user bug reports under the generic stale rule.** Resolve/archive one only when its linked Linear ticket is closed. The stale rule targets low-value recurring noise; bug reports are the opposite.

### Report them as their own bucket — with aging + orphan check

Each triage run must report user bug reports as a **separate bucket** in the log, including:

- **Open total** (from the dedicated query)
- **Oldest open age** — flag anything beyond the team's Linear SLA; if old reports sit unresolved, the forward-to-Linear loop is leaking
- **Orphans**: any report with **no Linear annotation** — never forwarded to the product backlog, fallen through the crack. Detect via the issue's `annotations` field (presence of a `linear.app` URL).

Log section template:

```markdown
## User Bug Reports (in-app feedback)

**Open total**: X    **Oldest**: REBEL-XX (N days)    **Orphans (no Linear)**: X

| Issue | Age | Linear | Urgency | One-line |
|-------|-----|--------|---------|----------|
| [REBEL-XX](url) | Nd | FOX-#### / **none** | low/med/high | … |
```

---

## Cloud Feedback (mobile/web in-app feedback)

Rebel's **mobile and web-companion** apps have their own in-app feedback form (`mobile/app/(tabs)/help.tsx`, `web-companion/src/screens/HelpScreen.tsx`). It does **not** call Sentry directly — it POSTs to the cloud server's `/api/feedback` endpoint (`cloud-service/src/routes/feedback.ts`), which then forwards to Sentry via `cloud-service/src/sentryFeedback.ts`. This is a **separate transport from the desktop bug-report form** and is the reason it was a triage blind spot until 2026-06-06.

**Discriminator — these are NOT caught by `source:user-bug-report`:**

- `source: cloud-feedback` (set at `sentryFeedback.ts:72`) — the reliable query discriminator
- `feedbackType: bug | improvement | other` (camelCase — note the desktop form uses underscore `feedback_type:bug_report`)
- `urgency: low | medium | high | critical`, `environment: cloud`, `platform: ios | android | web`, `serverVersion`
- rich diagnostics tags when present: `hasDiagnostics`, `queuePending/queueProcessing/queueMaxAttempts/queueAuthExpired`, `continuityConnection/continuitySessions`, `device.*`, `logLineCount`
- fingerprint `['cloud-feedback', feedbackType, title]` (`sentryFeedback.ts:143`); attachments: `filtered-logs.ndjson`, `mobile-diagnostics.json`, `diagnostic-sections.json`, `server-context.json`
- like desktop reports, the event "message" is prose, not an exception → Sentry shows **"(No error message)"**; `count=1, users=1`

### Query them as a dedicated slice

Run a **separate pass**, exactly as for desktop bug reports:

```
is:unresolved source:cloud-feedback
```

(Pre-built link in the [Useful URLs](#useful-urls-pre-built) table.) The `source:cloud-feedback` query sweeps in `bug`, `improvement`, and `other` feedback types in one go — no need to query `feedbackType` separately.

### Apply the same overrides as desktop bug reports

Cloud feedback is structurally identical to desktop user bug reports (one-off, high-signal, prose), so apply the **same** rules from [User Bug Reports](#user-bug-reports-in-app-feedback--rebel-60c-pattern):

- **Exempt from frequency thresholds** — assess on content, not `>5 events/day` / `>1 user`.
- **Do NOT auto-archive on the 7-day stale rule** — resolve only when the linked Linear ticket closes.
- **Report as its own bucket** with open total / oldest age / orphan (no-Linear) check.

> **Note on diagnostics:** because cloud-feedback reports carry queue/continuity telemetry (`queuePending`, `queueAuthExpired`, etc.) and an attached diagnostics bundle, an upload/sync complaint is often **directly diagnosable from the issue itself** — more so than desktop reports. Worth a quick look at the diagnostics before defaulting to "route to Linear".

Log section template (mirror the desktop bug-report bucket):

```markdown
## Cloud Feedback (mobile/web in-app feedback)

**Open total**: X    **Oldest**: REBEL-XX (N days)    **Orphans (no Linear)**: X

| Issue | Age | Linear | Type | Urgency | Platform | One-line |
|-------|-----|--------|------|---------|----------|----------|
| [REBEL-XX](url) | Nd | FOX-#### / **none** | bug/improvement | low/med/high | ios/android/web | … |
```

---

## Conversation Feedback (thumbs + free-text on a conversation) — light slice

Rebel's per-conversation feedback widget (thumbs/rating 1–5 + sentiment + dimension chips + a free-text note) emits to Sentry from both desktop (`src/main/sentryFeedbackReporter.ts`) and cloud (`cloud-service/src/sentryFeedbackReporter.ts`). These carry `feedback_type: conversation` (and **no `source` tag**), and they **group by sentiment** into three long-lived aggregator issues:

| Sentiment | Aggregator (as of 2026-06-06) | Triage action |
|-----------|-------------------------------|---------------|
| `positive` | REBEL-5N6 (~23 events) | **Ignore** — product analytics, never actionable |
| `neutral` | REBEL-5TG (~2 events) | **Skim new notes** — sometimes a real gap |
| `negative` | REBEL-5NX (~7 events) | **Read every new free-text note** — highest-signal |

The free-text notes are genuinely valuable and **not** captured by any other channel — e.g. a negative note *"it stated that my name was written wrong… It looks like a hallucination"* (an accuracy/hallucination defect) and a neutral *"missed several emails and wasn't precise enough"*. These are quality signals (accuracy, hallucination, missed-data), not crashes.

**How to triage (light touch):**

- Query: `is:unresolved feedback_type:conversation sentiment:negative` (and `sentiment:neutral`). Skip `positive`.
- These are **permanent aggregator issues** — they never "resolve" and new feedback just bumps the count. **Do NOT apply the stale-archive rule, and do NOT try to resolve them.** Instead, read the **new events since the last triage run** and pull out any free-text note describing a reproducible defect.
- Escalate a note to SHOULD FIX / Linear **only** when it describes a concrete, reproducible Rebel defect (e.g. a hallucination with a named conversation link). Vague dissatisfaction → leave as analytics.
- Report as a one-line bucket: `**Conversation feedback**: negative +N new notes (M actionable), neutral +K new` — don't enumerate positives.

---

## Non-feedback channels (no triage slice needed)

The high-volume `source:rebel-core-runtime` (desktop runtime) and `source:claude-agent-sdk` (agent SDK) values are **runtime errors**, not user feedback — they flow through the generic error sweep (now **multi-axis** — see [Discovery & Ranking](#discovery--ranking--multi-axis-the-heart-of-the-sweep), not freq-only) and need no special slice. Likewise the cloud operational anomaly captures (`super-mcp url missing`, `boot pressure parse error`, `continuity tombstone race`) are `captureMessage` telemetry that surfaces in the generic unresolved sweep. See the [full taxonomy appendix](#appendix-complete-sentry-input-channel-taxonomy) for how every channel relates.

### Cloud update / rollback health (added 2026-06-07)

The cloud auto-update + image-rollback layer was historically **invisible to Sentry** — `selfUpdateScheduler.ts`, `cloudUpdateService.ts`, and the pre-bootstrap watchdog only used the scoped logger, which emits Sentry *breadcrumbs* but never *captures* events (the watchdog also runs before Sentry init). So a cloud that silently stopped updating, or one a bad image was auto-rolled-back from, produced **zero** Sentry issues. Two explicit `captureMessage` titles now close that gap:

- **`cloud.self_update.failed`** (`cloud-service/src/selfUpdateScheduler.ts`) — the cloud-side 6h self-updater hit a genuine failure. Grouped by a `cause` tag/fingerprint: `tag-resolve-failed` / `fly-update-failed` / `vm-signal-write-failed` / `cycle-exception` (level **warning** — real operational problem), and `fly-token-missing` / `fly-env-missing` (level **info** — known-degraded BYOK config that self-heals once the desktop bootstraps the Fly token; the event count is the size of the stuck cohort). Self-healing/expected paths (GHCR rate-limit, agent-turn deferral, quarantine skip, up-to-date) deliberately do **not** capture.
- **`cloud.image_rollback.recovered`** (`cloud-service/src/services/cloudUpdateStatus.ts`, reported on the next healthy boot) — the pre-bootstrap watchdog rolled this machine back to its last-known-good image because a shipped image crash-looped. One event per distinct rollback (deduped across boots). Level **error** (re-leveled from warning 2026-06-11 so it stays alertable under a level-filtered alert rule). **This is a high-signal "a bad cloud image shipped" alarm** — a `cloud.image_rollback.recovered` issue means a released image failed to boot in production; treat it as SHOULD-FIX-investigate regardless of frequency (find the bad tag in `extra.rolledBackFromTag`).

Query slice (operational, not feedback — folds into the generic sweep, but worth an explicit check):

```
is:unresolved environment:cloud cloud.self_update.failed
is:unresolved environment:cloud cloud.image_rollback.recovered
```

These are `environment:cloud`, have **no `source` tag** (like other cloud operational anomalies), and surface in the generic unresolved sweep; the explicit titles just make update-health directly queryable. Note the still-uncovered case: a cloud that **fully crash-loops** (rollback failed / cap exceeded) never reaches Sentry init, so it emits nothing here — that case is detected desktop-side via Fly machine-state polling, not via Sentry.

---

## Escalation Ledger — forcing terminal dispositions

> **The problem this fixes.** Coverage is worthless without a forced decision. The log history shows issues that live *forever* in non-terminal holding states — REBEL-1G8 "outbox appears stuck" appears in **15** logs, REBEL-1AF in 11, REBEL-13Y in 24 — each re-noted as "watch / known / monitor-fade / out-of-scope" and never resolved or escalated. Surfacing more issues (the multi-axis passes above) only helps if something **drains** the watch list.

The triage agent is **read-only** (it can't resolve, archive, or ticket — those are human/go-ahead actions), so it acts as the **bailiff, not the executor**: it makes the decision unavoidable and one-click cheap, and the human performs the terminal action.

**The rule.** Before writing the log, grep the prior logs in `docs-private/sentry-triage-log/` for each issue you're about to mark "watch / known / monitor-fade / out-of-scope." **Any issue carried in ≥3 distinct prior logs** goes in a dedicated **`## ⚠️ DECISION REQUIRED`** block at the **top** of the run's log (above the discovery sections, not buried), with:

- a **forced terminal ask — no "watch" option** — choosing exactly one of: **(a)** open a Linear ticket *(pre-draft the title + one-line body so the human pastes it)*, **(b)** **accept → archive-until-escalating** in Sentry *(give the exact issue URL)*, or **(c)** fix now.
- a **proposed owner** per row (`decision needed from: <name>` — best guess from the affected code/area or who last touched it). An unowned ledger just becomes a louder ignored pile; name a human so the decision has an addressee. Keep it to one field — this is not a workflow system.
- a **monotonic, visible backlog counter** in the log header — e.g. `Escalation ledger: 4 items awaiting disposition, oldest 41 days` — so the cost of skipping is visible and grows, not hidden. (Count must match the number of ledger rows — get the arithmetic right.)
- if skipped, the item does **not** silently re-enter "watch" — it stays in the `DECISION REQUIRED` block next run, louder.

**Accept = archive-until-escalating, never archive-forever.** The only "accept" disposition that is *both* terminal (off the watch list) *and* safety-netted is Sentry's **archive-until-escalating** (it auto-resurfaces if the issue exceeds its own forecast baseline). **Never** use "archive forever" — see the footgun audit below.

### Archived-set hygiene + the archive-forever footgun

The generic guide's monthly "Archived Issues Review" has **never once run** in 31 logs — the slow-leak backstop is dead-lettered. Replace the manual ritual with Sentry's built-in **Escalating Issues** (turn it on / verify): it auto-resurfaces an archived issue that rises above its own baseline, which is what the manual review was supposed to catch. Then the only thing left to sweep manually is the footgun:

- **Archive-forever audit (REST-feasible):** `GET …/issues/?query=is:archived&statsPeriod=14d` exposes `substatus` per issue; `substatus:"archived_forever"` means the safety net is **disabled** — the issue records events but can *never* escalate. Run this each sweep and surface any archived-forever issue **still receiving events** for conversion to archive-until-escalating. (Snapshot 2026-06-18: ~17 such issues, including **REBEL-QJ** — a `user_activity` insert failure, a sibling of the live REBEL-64K — i.e. a real bug someone silenced forever; treat the count as illustrative, re-run for the current list.)
- **Frozen-priority audit (REST-feasible — confirmed 2026-06-18):** the list response carries **`priorityLockedAt`** per issue; non-null means a human manually set the priority, which **freezes auto-escalation** (the issue opts out of the Escalating-Issues safety net). Flag issues with a non-null `priorityLockedAt` whose locked priority looks too low for their current breadth/volume — same footgun as archive-forever, different field.

---

## Alert-Rule Hygiene (what pages the team vs. what the sweep catches)

Everything above governs the **triage SWEEP** — a query-driven pass over the issue
stream. It does **not** govern the **Sentry alert rules** that ping Slack in real time.
Those are a *separate system*, and historically an unaudited one: the "Rebel Error"
rule fires on **anything** crossing **3 events/1h with no filters**, so it pages on
every noise class this doc tells the sweep to ignore (REBEL-61S, a known SKIP class,
paged the team on 2026-06-07 — that is what this section exists to prevent).

**This noise taxonomy is the SSOT for what the alert filter should exclude.** When you
add or change a noise category above, reflect it here and (with go-ahead) in the Sentry
alert rule. Two answers to "is this worth a human's attention?" must not drift apart.

### Layer split (rules vs sweep vs outcome monitor)

| Layer | Watches | Owns | Does not do |
|---|---|---|---|
| Sentry alert rules | Indexed issue stream, real-time | Immediate paging on real defects + feedback arrival | Pre-ingest drop/filter outcomes |
| Triage sweep | Indexed issue stream, periodic | Human adjudication and fix/skip/archive decisions | Real-time paging; pre-ingest outcomes |
| Outcome monitor (`scripts/sentry-outcome-monitor.mjs`) | `stats_v2` outcomes (pre-ingest) + desktop bug-report id reconciliation | Drop-delta checks (B/C), accepted-but-never-indexed detector (A), daily dead-man digest with coverage state (D), permanent-failure surge (F), bug-report delivery reconciliation (G), safety-eval billing-degradation sustained-rate (H) | Issue content adjudication or alert-rule mutation |

<a id="check-h"></a>
### Outcome monitor — Check H (safety-eval billing degradation, SUSTAINED-RATE)

**What it pages on.** A **persistent, worsening** rate of safety evaluations failing CLOSED
because users' safety-eval models hit a plan cap. The producer (`recordSafetyEvalFailed` in
`src/core/safetyPromptLogic.ts`) emits a `Safety eval fail-closed` Sentry message tagged
`reasonKind:billing`; Check H reads the **daily distinct affected users** (not raw events —
the producer throttles identical fingerprints to 1/60s, so raw `count()` is dampened and
misleading) for the last few days and pages only when **each of the last
`SAFETY_DEGRADED_SUSTAINED_DAYS` days had ≥ `SAFETY_DEGRADED_DAILY_USER_THRESHOLD` distinct
billing users**. It is a TREND detector, not a spike detector.

This is the standing detector for the 260622 "opaque single-credential routing
starvation" class: a single-credential user (one provider, no fallback) whose model is out
of quota gets their action silently blocked by the fail-closed safety gate.

**Why sustained-rate, not a spike.** A 30-day Sentry backtest showed this is a **steady
background**, not a rare incident: ≈6 distinct billing users/day (24h=6, 7d=12, 30d=22). A
6h fresh-edge spike detector at a low floor would therefore page constantly. So Check H
fires only on a real worsening trend — the daily threshold sits **clearly above** that ~6/day
baseline.

**Query** (Sentry `/events/`, `dataset:errors`, one read per day window — the monitor reads
the last M trailing days plus one pre-window guard day):

```
message:"Safety eval fail-closed" reasonKind:billing environment:production
```
with aggregate fields `count_unique(user)` and `count()`, over a 24h window per day.

**Thresholds** (named constants in `scripts/lib/outcomeMonitorChecks.mjs`, **tune from the
Sentry dashboard**):
- `SAFETY_DEGRADED_DAILY_USER_THRESHOLD = 10` distinct billing users/day (clearly above the
  ~6/day steady state — the ~6/day baseline must never page).
- `SAFETY_DEGRADED_SUSTAINED_DAYS = 3` consecutive days, all ≥ threshold.
- So: **"≥10 distinct billing users/day for 3 straight days"** = a real worsening trend.

**Verdicts & re-page suppression.**
- `sustained-surge` → **pages** (fresh): the trailing M days are all ≥ threshold AND the day
  immediately before them was below threshold (a fresh crossing).
- `sustained-elevated` → **does not re-page**: still above threshold but the pre-window guard
  day was also elevated, i.e. it has already paged. It stays a **daily-digest line** only, so
  a persistent condition is not a repeated page.
- `quiet` → below threshold on at least one trailing day (incl. the ~6/day steady state and a
  lone spike day).
- `unavailable` → a daily read inside the trailing window was malformed/unreadable (or fewer
  than M days are available). Do **not** treat `unavailable` as all-clear — self-health
  already counts it as a degraded `sentry_events` read.

**What to do when it pages.**
1. Pull the matching events: filter the Sentry issue stream on
   `message:"Safety eval fail-closed" reasonKind:billing` over the last several days and read
   the daily distinct affected users + the `provider` / `model` / `upstreamProvider` tags.
2. Confirm it's a plan-cap (billing) class, not a misclassification — `errorKind:billing`
   and `httpStatus:429` on the same events corroborate.
3. If real: a growing cohort is being silently blocked. The fix space is product/routing
   (automatic fallback model for quota-exhausted single-credential users, clearer in-app
   messaging, plan-upgrade prompt) — see [`MODEL_AND_PROVIDER_DIRECTION.md`](./MODEL_AND_PROVIDER_DIRECTION.md)
   and the postmortem `docs-private/postmortems/260622_safety_eval_connector_error_messages_postmortem.md`.
   Escalate per the usual bug-fix routing (CHIEF_ENGINEER2 `bug_mode`).
4. `verdict=unavailable`: the daily aggregate read failed or returned a malformed body — treat
   it like any other monitor read-path degradation (self-health already counts it).

### Current alert rules (project `rebel`, verify via REST `…/rules/`)

| Rule | id | Fires on | Filters | Action |
|---|---|---|---|---|
| User Reported Rebel Bugs | 16749838 | new issue, `source co user-bug-report`/`cloud-feedback` | scoped ✅ | Slack #rebel-feedback-testimonials + Linear issue |
| Rebel Error | 16471532 | issue seen >3×/1h | **none** ⚠️ | Slack #rebel-monitoring |

REST: `GET /api/0/projects/mindstone/rebel/rules/` (read-only; the same listing endpoint family as the [REST fallback](#accessing-sentry--rest-api-fallback-when-the-mcp-isnt-connected) above).

### Alert threshold vs. sweep thresholds — different axes, on purpose

- **Sweep SHOULD-FIX gate:** the multi-path OR-gate in [Discovery & Ranking](#severity-gate--break-the-conjunctive-and) — any of `(>5/day-windowed AND >1u)`, `(≥10 users)`, or `(server-side high-volume, any user count)`, plus the carve-outs above. (Daily rate is the 14d window, not lifetime.)
  Purpose: *which issues are worth a fix.*
- **Alert page trigger:** `3 events / 1h` (the "Rebel Error" rule).
  Purpose: *which issues are worth waking someone for, right now.*

`3/1h` is a reasonable page trigger **only once the rule is scoped to real errors**.
On an unfiltered stream it is the spam mechanism. Do not "fix" the spam by raising the
count — fix it by adding the filters below.

### Disposition per noise category

For each noise class, decide one of three:
- **filter-out-of-alert** — keep tracking in Sentry (sweep still sees it), but exclude
  it from the page (Sentry alert-rule tag/level filter).
- **suppress-at-capture** — stop it becoming an alertable issue at all: re-level, route
  to the diagnostic-events ledger / analytics, or drop in `beforeSend`. We own the
  capture site (e.g. `captureKnownCondition` sets `level` from `KNOWN_CONDITIONS` in
  `src/core/sentry/knownConditions.ts`).
- **leave-alertable** — a genuine defect; it *should* page.

| Noise category (from tables above) | Top examples | Level(s) | Disposition | How |
|---|---|---|---|---|
| Worker-exit residue (5RT class) | REBEL-5RT/5SM/5SD/5SE… | fatal | **proposed: inbound-filtered at ingest** | error-message inbound filter (Action A in [OUTWARD_PROPOSAL](../plans/260610_improve-sentry-noise/OUTWARD_PROPOSAL.md)); verify via Stats `filtered` outcome; sunset/review when filtered-outcome decays |
| MCP tool-guessing (13Y class) | REBEL-13Y/61R/61S/628/62B | warning | filter-out-of-alert | `level != warning` filter or `onMcpError` tag |
| Watchdog telemetry | (was REBEL-N4/1AD/RD) | warn/info | **DONE 2026-06-10: suppress-at-capture** | registry-owned: self-resolved never captured (ledger+analytics); stalled/auto-abort = registry warnings (`agent_watchdog_stalled`/`agent_watchdog_auto_abort`) — sweep-visible, non-paging under a level-filtered rule |
| Cloud-connection telemetry | (was REBEL-570/571/5BC) | warn/info | **DONE 2026-06-11: suppress-at-capture** | registry-owned: recovered/degraded ledger-only by construction; `cloud_connection_degraded_escalated` (warning) marks sustained incidents |
| Known-condition `info` telemetry | REBEL-5PN/5K3/60A | info | **DONE 2026-06-11: suppress-at-capture** | registry `sink` policy: ledger-only info conditions skip Sentry by construction; raw info-level captures no longer compile |
| Humanized provider state | REBEL-603/5BP/5CV/5BT/5CN/61V | warn/err | filter-out-of-alert | these are handled UX; don't page |
| Native Chromium / OS / env | REBEL-WC/R/W/5M0/537/536 | err/fatal | filter-out-of-alert | not our bug; sweep watches |
| Network failures (external/transient only) | REBEL-52T/531 | warning | filter-out-of-alert | see [caveat](#network-failures-over-broad-caveat) — sustained high-user `fetch failed` to our endpoint is NOT noise |
| Watchdog-stop / turn-unresponsive | REBEL-5BK/5EF/16E | error | filter-out-of-alert | expected behaviour telemetry |
| Real defects (deadlock, recovery-fail, routing leak, SuperMcp startup) | REBEL-56D/5BM/540/61X | err/fatal | **leave-alertable** | page; these are the signal |

### Registry migrations 2026-06-10/11 — old issue → new condition rename map

Stages 2–5 of [260610_improve-sentry-noise](../plans/260610_improve-sentry-noise/PLAN.md)
converted raw captures to registry-owned conditions. Conversions from
`captureMessage` to the wrapper's `captureException` **regroup** — Sentry mints
new issue IDs while the old ones go dormant on releases carrying the change.
**Do not re-adjudicate the old issues**; archive-until-escalating once the
replacement condition appears (the housekeeping list lives in the
[OUTWARD_PROPOSAL](../plans/260610_improve-sentry-noise/OUTWARD_PROPOSAL.md)).

| Old issue (goes dormant) | New condition (registry) | Where it lives now |
|---|---|---|
| REBEL-N4 "Watchdog self-resolved" (info) | `agent_watchdog_self_resolved` | **Never captured** — diagnostic ledger + analytics event `'Watchdog Self-Resolved'` |
| REBEL-1AD "agent output stalled" (warning) | `agent_watchdog_stalled` | New issue, fingerprint `agent-watchdog-stalled`, warning, full diagnostics extras |
| REBEL-RD "Watchdog auto-abort" (warning) | `agent_watchdog_auto_abort` | New issue (message→exception regroup), fingerprint `agent-watchdog-auto-abort`, warning |
| REBEL-570 `cloud_connection_degraded` (warning) / REBEL-5BC `cloud_connection_degraded_escalated` (warning) | `cloud_connection_degraded` (info, ledger-only) / `cloud_connection_degraded_escalated` (warning) | degraded never captured; escalated = new issue, fingerprint `cloud-connection-degraded-escalated` |
| REBEL-571 `cloud_connection_recovered` (info) | `cloud_connection_recovered` | **Never captured** — ledger + breadcrumb |
| REBEL-5PN / REBEL-5K3 / REBEL-51V (wrapped info: structured-output fallback, time-saved, codex-disconnected) | same condition names | `sink: 'ledger-only'` — zero Sentry events from new releases |
| `cloud.self_update.failed` info causes (`fly-token-missing`/`fly-env-missing`) | `cloud_self_update_credentials_missing` (info, `sink: 'issue-stream'`) | Fingerprint `['cloud.self_update.failed', cause]` preserved → same grouping, but the issue TITLE changes (message→exception). Deliberately still in the stream: event count = stuck-cohort size |
| MS OAuth ghost callback / cloud-sync boot-rehab / tombstone-applied / cloud pressure-capability (raw info) | `microsoft_oauth_no_pending_callback`, `cloud_sync_boot_rehab_summary`, `cloud_sync_tombstone_applied`, `cloud_pressure_capability_missing` | All ledger-only — no longer in the stream |

`cloud.image_rollback.recovered` did not move registries but was **re-leveled
warning → error** (2026-06-11) so the "bad image shipped" pager survives a
level-filtered alert rule (see [Cloud update / rollback health](#cloud-update--rollback-health-added-2026-06-07)).

### Archived-but-accumulating issues are an open triage surface

`archived_until_escalating` is not "handled forever." An issue that keeps receiving
events at a steady-but-not-spiking rate never meets Sentry's "escalating" forecast,
so a real, broadly-affecting defect (e.g. a native-crash cohort) can accumulate
users for weeks while archived and nobody looks. **Treat archived issues that are
still receiving events as an open triage surface, not a closed one.** This is the
class that hid REBEL-1ES (`__pthread_kill` native crash) and REBEL-5RT until the
260621 detection-gap review re-surfaced them.

**Weekly read-only sweep** — archived issues still receiving events recently, ranked
by affected users:

```bash
curl -sS --get "${AUTH[@]}" "$SENTRY/organizations/mindstone/issues/" \
  --data-urlencode 'query=is:ignored lastSeen:-7d' \
  --data-urlencode 'sort=user' --data-urlencode 'statsPeriod=14d' \
  --data-urlencode 'project=4510399226839040' --data-urlencode 'limit=25'
```

`lastSeen:-7d` is the recency filter; `statsPeriod` must be one of the values the
issues endpoint accepts (`14d` here — **not** `7d`).

**Triage rule.** Any archived issue with a recent `lastSeen` AND a user count above a
threshold (start at ~50) gets re-adjudicated to exactly one of:
- **un-archive for a fix** — a real accumulating defect (the REBEL-1ES case); or
- **ingest-filter** — confirmed dead-build / stuck-cohort residue (the REBEL-5RT
  case; 260610 [Action A](../plans/260610_improve-sentry-noise/OUTWARD_PROPOSAL.md) pattern); or
- **re-archive with a documented reason** — genuinely benign, and say why.

This is a human/triage step. It is intentionally **not** owned by the outcome monitor
(`scripts/sentry-outcome-monitor.mjs`), which reads pre-ingest `stats_v2` outcomes +
bug-report reconciliation, not the issue stream — keep the two separate.

### Recommended "Rebel Error" rule change (outward — needs go-ahead)

The concrete, copy-pasteable outward actions (inbound worker-exit message
filter = Action A; rule 16471532 level-filter diff = Action B, with rollback
bodies and sequencing gates) live in
[OUTWARD_PROPOSAL](../plans/260610_improve-sentry-noise/OUTWARD_PROPOSAL.md).
Summary of Action B: add a **level filter** to rule 16471532:
> filter: `level` is one of `fatal`, `error` (drops the entire `warning`+`info`
> firehose — ~38% of all events, incl. the tool-guessing and known-condition classes).

Then layer tag filters for the residual `error`/`fatal` noise classes above
(worker-exit residue, humanized provider state, native/env). Keep the daily sweep as
the backstop for `warning`/`info` — never rely on the alert filter to catch slow-burn
`warning` defects (e.g. 5RB safety-eval).

> **Do NOT apply rule changes from a triage run** — mutating shared production alert
> rules is an outward action, same gate as resolve/archive. Propose the exact rule diff
> + current-state screenshot and hand to a human.

### Before changing ANY Sentry filter/rule — carve-out checklist

Run this checklist **after every outward change** (inbound filter, alert-rule
edit, bulk archive) **and after capture-side stages ship**. Every row must
still hold; if one fails, roll the change back first and investigate.

| Carve-out | Why it must survive | Check |
|---|---|---|
| REBEL-1C8 / WC / 63K / 52P (EMFILE, open SHOULD-FIX) | real fd-exhaustion class | still ingesting (Discover by short-id); 1C8 fatal still matches `level gte error` alert filter |
| REBEL-61X SuperMcpStartupError, 5Z1 `_registeredTools`, QS UNKNOWN watch, 540 routing leak | real-defect candidates, error-level | still ingesting; still alert-eligible |
| REBEL-5BM/5BX recovery failures, 5D4 `fetch failed` (our endpoint) | real-defect candidates | still ingesting; still alert-eligible |
| `cloud.image_rollback.recovered` | designated leave-alertable ("bad image shipped") | level `error` (re-leveled 2026-06-11) — must page under a `level gte error` rule; verify on next occurrence or via a staging test event |
| user-bug-report / cloud-feedback | human signal channels (alerted) | rule 16749838 untouched; inbound message filters cannot match them (prose titles); these are raw **error-level** message events, never wrapped |
| conversation-feedback (`feedback_type:conversation`) | human signal channel (sweep-only, NOT alerted — by design) | no `source` tag and no explicit error level (`sentryFeedbackReporter.ts` doesn't set one), so rule 16749838 does not match it; it stays ingestable and is read by the sweep's conversation-feedback slice |
| REBEL-5RB safety-eval + slow-burn warnings | warning-level real defects | NOT paged post-filter by design — the daily sweep is the documented backstop (warning-digest rule is a recorded follow-up) |
| Worker-exit regression in ≥0.4.44 builds | a filter must not blind us to recurrence | structured channel `['logger-transport-error','REBEL-5RT']` at level error is unaffected by the message glob; confirm that fingerprint's issue stays alert-eligible |

Pre-apply check for any new inbound message filter (read-only): run a Discover
query for issues whose matched field contains the filter strings that are NOT
in the intended family — must return none.

---

## Rebel Commit Conventions

- **Sentry short-id in commit messages**: When fixing a triaged issue, include the `REBEL-XX` short-id in the commit subject so the next triage's commit-based resolution check auto-links it. Example: `fix(voice): handle null audio context on permission denial (REBEL-HP)`.
- **Postmortem location**: `docs-private/postmortems/YYMMDD_<bug-name>_postmortem.md` (date-prefixed, lowercase slug).
- **AI provenance trailers**: Triage-driven fixes follow the standard Rebel commit format including `AI-Workflow`, `AI-Implementer`, `AI-Review-Mode` trailers (see [AGENTS.md § Commit message format](../../AGENTS.md)).

---

## Rebel Voice / Cadence Notes

- We move fast and fix issues quickly — the 7-day stale threshold reflects this; don't loosen it without team discussion.
- Daily CI cadence is the default. Manual triage runs are welcome but should still follow the same logging conventions so they remain comparable.
- "Until escalating" is the right archive mode for almost every stale issue — it keeps the alert active if frequency rises.
- The triage noise taxonomy is the **SSOT for both** the sweep *and* the alert-rule filters. When you add a noise category, give it an [Alert-Rule Hygiene](#alert-rule-hygiene-what-pages-the-team-vs-what-the-sweep-catches) disposition too — a sweep-noise category is a **candidate for alert-disposition review** (filter-out / suppress-at-capture / leave-alertable), not automatically page-suppressed: some "noise" is still worth *tracking*, and some `warning`s are slow-burn defects that should still be caught (if not by the page, then by the sweep).

---

## Fingerprint Disambiguation Patterns (REBEL-T4)

When a single Sentry issue groups disparate error shapes that need to be separated into sub-issues, use a **secondary structural discriminator** added to the fingerprint. The pattern is: split a single issue into sub-issues via a secondary structural discriminator on top of the primary error category.

**REBEL-T4 pattern for `AgentSessionError`** (`src/renderer/features/agent-session/utils/classifySessionError.ts`):

The renderer-side `AgentSessionError` captures use a `buildAgentSessionErrorFingerprint` helper that builds a fingerprint tuple:
- **2-tuple** (default): `['AgentSessionError', errorCategory]` — when `structuralKind` is absent or unknown; an 80-char message-prefix is used as the tertiary discriminator for truly unknown cases
- **3-tuple**: `['AgentSessionError', errorCategory, structuralKind]` — when `structuralKind` is known; enables grouping structurally-similar errors across different message content

This 3-tuple pattern is the general template for "split a single Sentry issue into sub-issues via a secondary structural discriminator." Reuse as needed for future overgrouping in Sentry — the key principle is: same structural shape → same fingerprint slot, regardless of high-cardinality message variance.

Planning doc: [260510 rebel_t4 fingerprint disambiguation](../plans/260510_rebel_t4_fingerprint_disambiguation.md) — root cause, helper signature, and rollout. Follow-up captured in [260510 rebel_t4 followups](../plans/260510_rebel_t4_followups.md).

---

## Carry-over notes for upcoming triage runs


### Bug-report invalid_json drops (260611) — fixed; verify via next-beta canary

The 2026-06-10/11 outage where every in-app bug report was rejected at ingest (`outcome:invalid reason:invalid_json`, unpaired-surrogate class) is fixed by the well-formedness sweep in `260611_bugreport-envelope-fd-leak` — see [ERROR_MONITORING § Outgoing-event UTF-16 well-formedness sweep](./ERROR_MONITORING_AND_SENTRY.md#outgoing-event-utf-16-well-formedness-sweep-invalid_json-class-kill-2026-06-11). Verification = next-beta canary: a live `source:user-bug-report` submission **indexing in Sentry**, with `stats_v2` attachment bytes matching the app log. Do NOT read the chronic heterogeneous invalid_json tail (2–15/day error-category, predates the bug) as the bug persisting — discriminate by `source:user-bug-report` events indexing + the attachment-byte match. Delete this note once the canary passes.

### Renderer/mobile full-redaction unification (260611) — regroup carry-over

- Expect one mobile dev-build regroup class from stacktrace home-path redaction (REBEL-170 pattern): old issue id goes dormant and a successor id may mint.
- REBEL-1C8 keeps its issue id; new events drift to `~`-normalized path titles after exception-value redaction.

### Super-MCP startup class (260610-11)

Two standing notes from the `260610_supermcp-install-robustness` run (delete each once actioned):

1. **Deliberate rebaseline — expect a new "router-not-running" issue.** The downstream Super-MCP capture is now fingerprint-pinned (`['super-mcp','router-not-running']`) and its copy changed, so the old copy-keyed groups **REBEL-S2 / S1 / 15F go quiet** and one new successor issue appears as releases roll out. This is intentional (and gives a clean post-fix baseline free of the historical stale-version inflation). Don't flag the old issues' silence as "fixed" evidence, and don't treat the successor as a regression; set its alert posture deliberately.
2. **Windows spawn-death root cause — investigate once telemetry accumulates.** Startup failures now carry a `failureCategory` Sentry tag + `attemptSummary` (attempt/phase/category) extras (shipped 260610-11, first in releases containing `bc72ffe9c`). Once ~1-2 weeks of field data exists on a release with this telemetry, run the deferred investigation: the category distribution (`process_crash` vs `health_timeout` vs `spawn_missing_executable` vs `fs_exhaustion`, by OS) should finally identify the long-unknown "process died during startup" root cause (REBEL-SG class; AV/firewall hypothesis). Evidence base: `docs/plans/260610_supermcp-install-robustness/` (Composer failure taxonomy + plan).
3. **Breadcrumb wire-channel bypass (routed 2026-06-12, from the 260611 redaction-unification evidence pack).** Sensitive-keyed breadcrumb `data` reaches the Sentry wire despite both processes' `beforeBreadcrumb`/`beforeSend` redaction hooks (server-side scrubbing currently catches it at rest — it shows as `[Filtered]`). Unification did NOT close this channel and docs deliberately don't claim it does. Decisive experiment when picked up: instrument one renderer error, diff the renderer `beforeSend` payload against the outgoing envelope bytes, and open remediation if a downstream merge bypass is confirmed. Evidence: `docs/plans/260611_sentry-fd-detection-followups/subagent_reports/260611_200140_stage04-redaction-evidence.md` (unresolved-mechanism flag).

---

## Appendix: Complete Sentry Input-Channel Taxonomy

**Why this exists:** Rebel funnels *everything* — desktop, mobile, web-companion, and cloud-server — into a **single Sentry project** (`rebel`, id `4510399226839040`, DSN `…@o457803.ingest.us.sentry.io/4510399226839040`). That means user feedback and machine errors from four surfaces all land in one stream, and several feedback forms are easy to miss because they're transported as ordinary `captureMessage` events with **"(No error message)"** titles. This appendix is the authoritative map of every channel, the tag that identifies it, and our deliberate triage decision for each. The mobile cloud-feedback blind spot (REBEL-663, "recordings won't upload") was the trigger for writing it down — that channel had never once entered a triage log.

### The two tag axes

Two independent tags discriminate channels. **Mind the naming inconsistency** (a known wart, not worth a migration):

- **`source`** — set on bug-report-style feedback and on runtime errors: `user-bug-report`, `cloud-feedback`, `rebel-core-runtime`, `claude-agent-sdk`. Conversation feedback has **no** `source`.
- **`feedback_type`** (underscore) vs **`feedbackType`** (camelCase) — the **desktop** forms use the underscore (`bug_report`, `bug`, `improvement`, `conversation`); the **cloud/mobile/web** form uses camelCase (`bug`, `improvement`, `other`). Don't assume one query catches both spellings.

### Every channel (feedback + non-feedback)

| # | Channel | Surface | Emitter (file) | `source` | `feedback_type` / `feedbackType` | Triage slice | Disposition & why |
|---|---------|---------|----------------|----------|-----------------------------------|--------------|-------------------|
| 1 | **Desktop bug report** | Desktop | `src/main/ipc/bugReportHandlers.ts` | `user-bug-report` | `feedback_type:bug_report` | `source:user-bug-report` | **INCLUDED** — [User Bug Reports](#user-bug-reports-in-app-feedback--rebel-60c-pattern). Content-assessed, frequency-exempt, Linear-routed. |
| 2 | **Company dashboard feedback** | Desktop | dashboard feedback widget | `user-bug-report` | `feedback_type:bug` / `improvement` | (rides on #1's query) | **INCLUDED** — same `source` tag → no separate slice. Just a different content shape. |
| 3 | **Cloud/mobile/web feedback** | Mobile + web-companion → cloud | form → `cloud-service/src/routes/feedback.ts` → `sentryFeedback.ts` | `cloud-feedback` | `feedbackType:bug` / `improvement` / `other` | `source:cloud-feedback` | **INCLUDED** (added 2026-06-06) — [Cloud Feedback](#cloud-feedback-mobileweb-in-app-feedback). Carries rich queue/continuity diagnostics → often self-diagnosable. |
| 4 | **Conversation feedback** | Desktop + cloud | `src/main/sentryFeedbackReporter.ts`, `cloud-service/src/sentryFeedbackReporter.ts` | *(none)* | `feedback_type:conversation` | `feedback_type:conversation sentiment:negative` (+ `neutral`) | **INCLUDED (light)** — [Conversation Feedback](#conversation-feedback-thumbs--free-text-on-a-conversation--light-slice). Read new negative/neutral notes; ignore positive. Permanent sentiment-grouped aggregators — never resolve/archive. |
| 5 | **Desktop runtime errors** | Desktop | `src/renderer/**` captures (e.g. `captureRendererException`, `AgentSessionError`) | `rebel-core-runtime` | — | (generic error sweep) | **INCLUDED via generic sweep** — the [multi-axis gate](#severity-gate--break-the-conjunctive-and) applies (not freq-only); not feedback. |
| 6 | **Agent SDK errors** | Desktop/core | claude-agent-sdk integration | `claude-agent-sdk` | — | (generic error sweep) | **INCLUDED via generic sweep** — multi-axis gate; humanizer carve-out applies (see Noise Categories). |
| 7 | **Cloud operational anomalies** | Cloud | `cloud-service/src/bootstrap.ts`, `health/pressureSampler.ts`, `routes/sessions.ts` | *(none / area tags)* | — | (generic error sweep) | **INCLUDED via generic sweep** — `captureMessage` warnings/errors (super-mcp missing, boot-pressure parse, continuity tombstone race). Self-rate-limited; no special handling. |
| 8 | **Cloud update / rollback health** | Cloud | `cloud-service/src/selfUpdateScheduler.ts`, `cloud-service/src/services/cloudUpdateStatus.ts` | *(none)* | — | (generic sweep + explicit titles — see [Cloud update / rollback health](#cloud-update--rollback-health-added-2026-06-07)) | **INCLUDED (added 2026-06-07)** — `cloud.self_update.failed` (warning/info by `cause`) + `cloud.image_rollback.recovered` (error; re-leveled 2026-06-11). `image_rollback.recovered` = a bad image shipped and was auto-recovered → investigate regardless of frequency. |

### Alert disposition per channel

The "Disposition & why" column above is **sweep-side** (coverage). Alerting is a separate guarantee — see [Alert-Rule Hygiene](#alert-rule-hygiene-what-pages-the-team-vs-what-the-sweep-catches). Per-channel, the current alert behaviour is:

| Channel | Alert disposition |
|---|---|
| 1/2 Desktop bug report + dashboard | **Alertable** — "User Reported Rebel Bugs" rule (Slack + Linear). Correctly scoped. |
| 3 Cloud/mobile/web feedback | **Alertable** — same rule (`source co cloud-feedback`). Correctly scoped. |
| 4 Conversation feedback | **Not alerted** — permanent aggregators; sweep-only. Correct. |
| 5 Desktop runtime errors | **Over-alerted** — "Rebel Error" pages on all `warning`/`info` here; scope to `error`/`fatal` + exclude noise classes. |
| 6 Agent SDK errors | **Over-alerted** — humanized provider state pages despite handled UX; filter out. |
| 7 Cloud operational anomalies | **Over-alerted** — `captureMessage` telemetry pages; suppress-at-capture / filter. |
| 8 Cloud update / rollback health | **Mixed** — captures are levelled to avoid the pager: `cloud.self_update.failed` is `warning`/`info` (operator-attention, sweep-caught, **filter-out-of-alert** under the recommended `level in (fatal,error)` rule scope). **Exception: `cloud.image_rollback.recovered`** is high-signal (a bad image shipped) — re-leveled to **error** (2026-06-11) so it stays **leave-alertable** under a level-scoped rule with no tag-based carve-out needed. Until the "Rebel Error" rule is scoped, a `fly-token-missing` cohort (`info`) could page spuriously → covered by the recommended warning/info level filter. |

### What this means for a triage run

A complete run touches **four feedback slices + the generic error sweep**:

1. Generic unresolved error sweep ([multi-axis](#discovery--ranking--multi-axis-the-heart-of-the-sweep): volume + breadth + reactivated + new + regressed) — channels 5/6/7 land here.
2. `source:user-bug-report` — desktop bug reports + dashboard feedback (channels 1, 2).
3. `source:cloud-feedback` — mobile/web feedback (channel 3).
4. `feedback_type:conversation sentiment:negative` (+ `neutral`) — conversation notes (channel 4); skip positive.

If a future feedback form appears, it will show up as a new `source` value or a new `feedback_type`/`feedbackType` value — **re-run the tag-values enumeration** (`GET /api/0/projects/mindstone/rebel/tags/source/values/` and `…/feedback_type/values/` and `…/feedbackType/values/`) periodically to catch new channels before they become blind spots like cloud-feedback did.

### Nothing is silently dropped

Every channel above is either in a dedicated slice or the generic sweep. The historical gap was channel 3 (cloud-feedback) — three real "recordings won't upload" reports (REBEL-663/5RG/5G6) sat outside triage for days, reaching Linear only via Sentry→Linear auto-routing. With channel 3 and channel 4 now sliced, there is no known unmonitored user-input path into Sentry.

> **Coverage vs. alerting are different guarantees.** Every channel is in a sweep slice
> or the generic sweep (coverage ✅). But until the "Rebel Error" rule is scoped (see
> [Alert-Rule Hygiene](#alert-rule-hygiene-what-pages-the-team-vs-what-the-sweep-catches)), channels 5–7 are *over-alerted*: real-time
> pages fire on classes this doc marks SKIP. Coverage ≠ alert hygiene.
