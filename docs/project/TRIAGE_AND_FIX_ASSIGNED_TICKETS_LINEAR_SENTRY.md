---
description: "Process for working a batch of assigned Linear bug tickets (+ their Sentry issues) end-to-end: pull, prioritise, fix via CHIEF_ENGINEER2, comment, close in both systems."
last_updated: "2026-06-09"
---

# Triage & Fix Assigned Tickets (Linear + Sentry)

Short operating procedure for: **"work through the bugs assigned to me, fix them, and close them out."** This is the *fix-and-close* loop for tickets already triaged onto a person — it is **not** the Sentry stream sweep (that's [`SENTRY_TRIAGE.md`](./SENTRY_TRIAGE.md), which decides what's worth fixing in the first place).

> **By default, run this autonomously.** Don't checkpoint the user per ticket — pull the batch, fix what's worth fixing, close it, and report at the end. Escalate only for product/intent/irreversible calls (per the autonomy norm).

## 1. Pull the work-list

- **Linear "my issues":** `list_issues(assignee:"me", state:"started")` and `list_issues(assignee:"me", state:"unstarted")`. These are the assigned, not-yet-done tickets.
- Each ticket's Sentry origin (if any) is in its `attachments` — a `sentry.io/.../issues/<numericId>/...` URL. Note the `<numericId>`; you'll need it to resolve the Sentry side.

## 2. Filter to **bugs only** — and say what you dropped

Work **bugs** (something is broken / behaves wrong), not **enhancements** (feature requests, "it would be nicer if…", differentiation/UX asks). Signals: the `Bug` label, a reproduction / "expected vs actual", a Sentry `source:user-bug-report` origin. High-priority strategic items (e.g. "No granular privacy controls", "Why Rebel? differentiation") are enhancements — skip them here.

**Tell the user what you filtered out.** In the final report, list the tickets you excluded as enhancements/non-bugs so they know those were deliberately deferred, not missed.

## 3. Prioritise by ease × value × recency

Order the surviving bugs by a quick ease × value score, breaking ties toward **recency** (a bug reported this week beats a months-old one of equal weight — it's more likely still live and the reporter is still watching). Before fixing, **check the bug isn't already fixed on current `dev`** — most reports lag the build; compare the reported `release`/app-version tag against `dev` (see [`SENTRY_TRIAGE.md` § stale-vs-live](./SENTRY_TRIAGE.md)). Already-fixed → skip straight to step 5 (comment + close), don't re-fix.

## 4. Fix via CHIEF_ENGINEER2

Run [`CHIEF_ENGINEER2`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md). Batch where feasible:

- **One batch / planning-folder for several related tickets** when they share a subsystem or root cause (cheaper, lets CE2 find the common fix). This was the right call for the recent FOX-34xx Sentry batch.
- **Separate planning-folders** when tickets are unrelated enough that a shared plan would muddy scope.

## 5. Comment with what was learned, then close **both** systems

For **every** ticket you touch (fixed, or confirmed already-fixed/stale/duplicate), leave a Linear comment summarising the diagnosis / fix / disposition, signed:

```
- from [USER]'s CHIEF_ENGINEER2
```

`[USER]` = the repo owner running CE2 (e.g. `- from Greg's CHIEF_ENGINEER2`). Use `save_comment(issueId, body)`.

Then mark resolved in **both** places:

- **Linear:** `save_issue(id, state:"Done")` (or `"Duplicate"` / `"Canceled"` for non-fixes). The `Fixes REBEL-<id>` commit convention (see [`SENTRY_TRIAGE.md` § commit conventions](./SENTRY_TRIAGE.md)) also closes the issue on merge.
- **Sentry:** moving the Linear issue to Done usually **auto-resolves** the linked Sentry issue via the integration — so **verify first** (`get_sentry_resource(resourceType:"issue", organizationSlug:"mindstone", resourceId:"<numericId>")`; look for `status: resolved`). If it's still `unresolved`, the **Sentry MCP here is read-only**, so resolve via REST:

  ```bash
  # token: SENTRY_AUTH_TOKEN in .env.local (gitignored; copy into worktrees)
  PUT https://us.sentry.io/api/0/organizations/mindstone/issues/<numericId>/
  Authorization: Bearer $SENTRY_AUTH_TOKEN
  body: {"status":"resolved"}   # 200 = done; idempotent
  ```

  Mechanics (token loading, endpoint table): [`SENTRY_REST_FALLBACK.md`](../../coding-agent-instructions/docs/SENTRY_REST_FALLBACK.md). Resolving here is **authorised** because we've just fixed/verified the bug — distinct from the read-mostly caution the triage *sweep* applies to mass archiving.

## 6. Report

End with a compact table: each bug, its disposition (fixed `<sha>` / already-fixed-stale / duplicate), and Linear + Sentry status. Separately list the **enhancements/non-bugs you filtered out** (step 2).

---

### See also
- [`SENTRY_TRIAGE.md`](./SENTRY_TRIAGE.md) — the Sentry stream sweep + Rebel project config (org/project IDs, REST fallback, severity model). Read it for *what* to fix; this doc is *how to close the loop* once a bug is assigned.
- [`CHIEF_BUGFIXER`](../../coding-agent-instructions/workflows/CHIEF_BUGFIXER.md) / [`CHIEF_ENGINEER2`](../../coding-agent-instructions/workflows/CHIEF_ENGINEER2/CHIEF_ENGINEER2.md) — the fix workflows invoked in step 4.
