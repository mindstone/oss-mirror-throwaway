---
description: "Intent and guardrails for Actions auto-resolution, backlog sweeps, connector-agnostic evidence, and cost-bounded daily cleanup."
last_updated: "2026-05-26"
---

# Actions Auto-Resolution

## Why This Exists

Actions should represent open loops that still need the user, not a graveyard of things already handled in Slack, Notion, email, GitHub, Linear, calendar, or a later meeting.

The original product problem came from stale items such as:

- "Review Liam's prod engineer hiring criteria in Notion" after the user had already replied "looks good".
- "Check Operators beta exposure with Josh" after Josh/product had already answered in Slack.
- "Prep for Kim Scott 'speak truth to power' session" when the user was out of office and would not attend.
- System receipts such as memory-hygiene summaries remaining as if they were tasks.

The intended product behaviour is:

- First-run / user-triggered backlog sweeps can clean up a large existing pile of Actions.
- Daily maintenance keeps the list from getting noisy again.
- Both paths resolve from evidence, not vibes.

## Product Contract

There are two different modes. Do not collapse them into one.

### First-Time Backlog Sweep

Use when the feature first ships, or when the user explicitly asks to clean up all Actions.

- May process all active Actions, including 50, 100, or 200+ item backlogs.
- Runs in batches rather than as one silent long operation.
- Produces a dry-run receipt before applying changes.
- Groups outcomes as resolved, dismissed/obsolete/not-user-owned, needs user review, and left active.
- Includes connector work performed and short evidence notes.
- Applies changes only after the user authorises the specific cleanup result.

This is the "clean the garage" pass.

### Daily Maintenance

Use for unattended recurring cleanup.

- Small, cost-bounded, and conservative.
- Prioritises overdue items, exact references, and likely completion signals.
- Stops when the budget is spent or confidence drops.
- Leaves uncertain items active.

This is "don't let dishes pile up again".

## Connector-Agnostic Evidence

Never assume a fixed connector stack. Different users and companies use different systems of record.

Resolve Actions using the systems the user normally uses for that action type. Infer that from:

- exact `references` on the Action,
- source provenance,
- `Chief-of-Staff/README.md`,
- connected tool packages,
- recent source history,
- scoped feedback examples.

Evidence route:

1. Exact reference.
2. Same source thread, page, task, issue, event, or document.
3. User's normal tool for that person/topic.
4. At most one targeted cross-system search.
5. If inconclusive, leave active.

Examples:

- Email users may use Gmail or Outlook.
- Messaging may be Slack, Teams, or another connector.
- Documents may live in Notion, Drive, SharePoint, or workspace files.
- Work tracking may be Linear, GitHub, Asana, Jira, or Git commits.

## Evidence Classes

High-confidence resolution evidence includes:

- User replied, approved, commented, edited, or sent the requested response.
- For communication-derived scheduling or follow-up Actions, the originating communication system or the user's normal communication system later shows the sync/call happened, was scheduled, was cancelled, or is no longer needed.
- Named teammate or responsible team explicitly answered the open question.
- Later meeting/call evidence shows the user reviewed and used the feedback.
- Matching commit, merged PR, release note, closed issue, or completed task covers the requested work.
- Calendar or source evidence shows the user declined, is out of office, or will not attend a prep item.
- The item is a system receipt or automation log rather than an action.
- The work is owned by someone else and there is no explicit user follow-up deadline.

Weak evidence that must not resolve an item:

- Same topic appears somewhere.
- A document was edited but not approved/commented/used.
- A teammate mentioned the subject without closing the loop.
- A related issue exists but is still open or unrelated.

## Cost And Trust Guardrails

Normal daily runs must use the existing automation cadence only.

They should stop at the first of:

- item cap,
- low background connector-call budget,
- time budget,
- low evidence yield.

Do not add:

- a new always-on background resolver,
- whole-workspace crawling,
- broad mailbox/channel sweeps,
- large document body fetches unless exact-reference evidence requires it,
- per-item LLM judging.

Backlog sweeps can do more work, but only as explicit dry-run receipts in batches.

## User-Request Items

User-requested Actions have the highest trust bar.

Do not resolve them from indirect evidence unless:

- exact-source evidence proves the requested outcome is complete, or
- the user authorises the cleanup result after a dry-run receipt.

## Implementation Signposts

- `rebel-system/skills/memory/source-capture/AUTOMATION.md` — scheduled source capture and Actions freshness policy.
- `rebel-system/skills/operations/morning-triage/AUTOMATION.md` — morning triage completion checks and backlog sweep policy.
- `resources/mcp/rebel-inbox/server.cjs` — MCP Actions creation guidance, reference metadata policy, and reference formatting.
- `src/main/ipc/inboxHandlers.ts` — deterministic app-side email-thread fast path. This is intentionally not the broad connector-agnostic resolver.
- `src/shared/ipc/channels/inbox.ts` — `inbox:check-resolution` IPC contract.
- `evals/fixtures/action-auto-resolution/` — durable examples for the behaviour classes.
- `evals/__tests__/actionAutoResolutionPromptCoverage.test.ts` — zero-token policy coverage for prompt changes.
- `docs/plans/260526_low_cost_actions_auto_resolution.md` — original planning record and live-cleanup notes from the 2026-05-26 implementation.

## Future Changes Warning

Before changing this system, check whether the change preserves all three principles:

1. **User trust:** do not silently remove uncertain Actions.
2. **Connector agnosticism:** do not hardcode one user's tool stack as the product model.
3. **Cost control:** do not turn daily maintenance into a hidden crawler.

If a change weakens any of these, it needs a product decision, not just a code edit.
