---
description: End-to-end build and GitHub upload pipeline for user-contributed MCP connectors inside Rebel (agent → store → fork → PR → catalog swap)
last_updated: 2026-04-24
---

# MCP Connector Contribution Flow

What happens inside Rebel between the moment an agent starts building a new MCP connector and the moment its catalog entry silently swaps in after the PR is merged. Covers the agent-side lifecycle tool, the `ConnectorContribution` store, the fork + Git Data API upload, status polling, and post-publish catalog swap.

This is the **developer-facing** plumbing doc. For the reviewer-side workflow on the `mindstone/mcp-servers` repo, see [OPEN_SOURCE_PR_REVIEW_AND_TEST](OPEN_SOURCE_PR_REVIEW_AND_TEST.md). For how published rebel-oss packages get installed and run on users' machines after all this, see [MCP_OSS_CONNECTORS](MCP_OSS_CONNECTORS.md).

> **Heads-up (2026-05):** This doc still describes the legacy promotion architecture (`promoteContributionIfReady`, `contributionPromotionService.ts`). That service was removed in commit `4ccafd7e7` (Stage 3.F of the contribution-state hardening plan) along with `signalRegistry` — the in-memory promotion truth was deleted by construction in favour of path-first ingress and durable readiness observations. The prose below is preserved for historical context; for current readiness/ingress behaviour read `src/core/services/contributionObservationService.ts` (durable observations the agent emits), `src/main/services/contributionStartupSweep.ts` (boot-time recovery of untracked / stuck contributions), and the path-first ingress in `src/main/services/bundledInboxBridge.ts`. `contributionFollowUpService.ts` is unrelated — it creates follow-up sessions for `changes_requested` / `ci_fail` states only.

## See Also

- [MCP_OSS_CONNECTORS](MCP_OSS_CONNECTORS.md) — Runtime distribution of published rebel-oss connectors (managed npm installs, startup migrations, spawn lifecycle)
- [OPEN_SOURCE_PR_REVIEW_AND_TEST](OPEN_SOURCE_PR_REVIEW_AND_TEST.md) — Mindstone-staff reviewer workflow for contributed PRs
- [MCP_CONNECTOR_WORKFLOW](MCP_CONNECTOR_WORKFLOW.md) — 6-phase workflow for building Mindstone-authored connectors (separate from user contributions)
- [MCP_SERVER_STANDARD](MCP_SERVER_STANDARD.md) — SDK patterns, tool naming, module architecture contributed PRs must follow
- [`build-custom-mcp-server` skill](../../rebel-system/skills/coding/build-custom-mcp-server/SKILL.md) — Agent-side playbook that drives the 8-phase build
- [`contribute-connector` reference](../../rebel-system/skills/coding/build-custom-mcp-server/references/contribute-connector.md) — Pre-PR contributor checklist and PR description template
- Planning docs: [260410](../plans/260410_oss_mcp_integration_forward_plan.md) (original design), [260416](../plans/260416_agent_reported_state_hardening.md) (agent-reported-state hardening), [260420](../plans/260420_simplify_mcp_build_flow.md) (building-phase + thinking-card fold)


## Flow at a Glance

```
┌───────────────────────────────────────────────────────────────────────────┐
│ 1. User asks Rebel build me a <service> connector                         │
│    → agent follows build-custom-mcp-server SKILL (8 phases)                │
│    → writes source to ~/mcp-servers/<name>-mcp/                            │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 2. Agent calls rebel_mcp_report_contribution_state at each checkpoint     │
│    → bundledInboxBridge /contribution/report-state endpoint               │
│    → contributionStore.createContribution() or updateContribution()       │
│    → status transitions: draft → testing → ready_to_submit                │
│    → evidence gate refuses premature ready_to_submit                      │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 3. MCPBuildCard UI reacts to store changes (2 s poll in renderer)         │
│    → draft/testing subphases render in the thinking card's Doing Right    │
│      Now row (Writing <name> / Testing <name>)                            │
│    → ready_to_submit renders the Add to the community CTA                 │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                    User clicks Add to the community
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 4. contribution:submit-from-store IPC (main process)                      │
│    → reads files from contribution.localServerPath                        │
│    → forkRepo() → pushConnectorFiles() → createPR() against mindstone       │
│    → store.status = 'submitted', records prUrl                            │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 5. Status polling (contributionStatusService)                             │
│    → staleness threshold 5 min, single-flight dedup                       │
│    → maps PR state → ContributionStatus (ci_pass/ci_fail/approved/...)    │
│    → final transition to 'published' when PR is merged                    │
└───────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ 6. Catalog swap on next app boot (contributionSwapService)                │
│    → scans all 'published' contributions                                  │
│    → rewrites super-mcp-router.json entry from local path → npx spec      │
│    → user's workflow is uninterrupted: same server name, same env vars    │
└───────────────────────────────────────────────────────────────────────────┘
```


## Lifecycle State Machine

The single source of truth for statuses and valid transitions is [`contributionTypes.ts`](../../src/core/services/contributionTypes.ts):

```
draft ──────────────► testing ──────────► ready_to_submit
                       ▲                        │
                       │                        ▼
                  submitted ─────────► ci_pass ──► approved
                       ├───────────────► ci_fail ──► changes_requested
                       ├───────────────► rejected       │
                       └───────────────► published      └──► testing (fix cycle)
                                              ▲
```

Full transition table lives in `VALID_STATE_TRANSITIONS`. Key rules:

- **Keep it private is a UI-only defer, not a status transition.** When the user clicks Keep it private on the inline submit-prompt, the contribution stays at `ready_to_submit`; the question card minimizes to a `MinimizedQuestionPill` (same code path as the manual minimize button). The user re-enters the share flow by (1) restoring the pill, (2) the contribution status flipping out of `ready_to_submit` and back (which clears the dismissed batch id and re-emits the card), or (3) clicking **Settings → Tools → Share with everyone** on the connector's expanded card. See [`docs/plans/260428_keep_private_minimize_and_settings_share_button.md`](../plans/260428_keep_private_minimize_and_settings_share_button.md) for the rationale and the older `ready_to_submit → draft` design that was rejected. The transition is still listed in `VALID_STATE_TRANSITIONS` for forward compatibility but is not currently triggered by any UI surface.
- **`draft → submitted` is legal** so a user can submit a `draft` contribution that hasn't been promoted to `ready_to_submit` yet (e.g., when the agent created the record at `draft` and the user hits Share with everyone before testing finishes).
- **`submitted` can skip straight to `approved` / `changes_requested` / `rejected` / `published`** because status polling may miss intermediate states between 5-minute ticks.
- **Terminal states**: `rejected` and `published` have no outbound transitions.

Every rejection writes a human-readable (or JSON-serialised) message to `lastTransitionError` so both the agent and the UI can self-correct without a second round trip.


## Agent-Side: `rebel_mcp_report_contribution_state`

The agent follows [`build-custom-mcp-server/SKILL.md`](../../rebel-system/skills/coding/build-custom-mcp-server/SKILL.md), which makes `rebel_mcp_report_contribution_state` **mandatory** at each checkpoint. The tool is exposed by the bundled inbox bridge — specifically the `/contribution/report-state` HTTP endpoint in [`bundledInboxBridge.ts`](../../src/main/services/bundledInboxBridge.ts) (search for `/contribution/report-state`).

### Checkpoints

| Phase transition                     | Status to report       | Required payload                        |
|--------------------------------------|------------------------|------------------------------------------|
| End of Phase 5 (code written, builds) | `draft`                | `localServerPath`                        |
| Start of Phase 6 (testing begins)    | `testing`              | `localServerPath`                        |
| After Phase 6 DoD passes             | `ready_to_submit`      | `localServerPath`, `prTitle`, `prBody`  |

The skill also requires the agent to emit a visible `<testing_evidence>` block before reporting `ready_to_submit`, listing every tool it actually tested and what came back. See [SKILL.md § Phase 6.6 Definition of Done](../../rebel-system/skills/coding/build-custom-mcp-server/SKILL.md) for the full evidence contract and the `pre-submit-check.sh` gate.

### Bridge evidence gate

The bridge endpoint is **not** a passthrough. When the agent reports `ready_to_submit`:

- **Existing-record path** (`testing → ready_to_submit`): routed through ``contributionPromotionService.promoteContributionIfReady``. The composition predicate requires `evidence AND (intent OR operational-state)`, where evidence signals include `test-pass`, `auto-check-success`, `file-detection`. A bare `agent-tool-call` with no `localServerPath` is rejected.
- **Direct-create path** (no prior record): accepted only if the session also has a `test-pass` or `add-server-observer` signal. Agents that skip testing and jump straight to `ready_to_submit` are rejected with a 202 and a structured `evidence-insufficient` error; the record is created at `testing` instead so the UI can show it and the agent's next turn gets the corrective `lastTransitionError`.

This is the structural anti-hallucination guard. The full predicate taxonomy is documented inline in ``contributionPromotionService.ts``.


## The Store: `ConnectorContribution`

Contribution records live in the [`connector-contributions` store](../../src/core/services/contributionStore.ts). Each record carries:

- Identity (`id`, `sessionId`, optional `followUpSessionIds`, `connectorName`)
- Build artefact pointer (`localServerPath`, resolved from tilde)
- Lifecycle (`status`, `createdAt`, `updatedAt`, `lastCheckedAt`, `lastTransitionError`)
- Submission artefacts (`prUrl`, `prTitle`, `prBody`, `attributionMode`, `attributionName`, `workflowRunUrl`)
- UI dismissal state (`acknowledgedEvents[]`, `publishedEmailSentAt`)

Full schema: [`ConnectorContribution` in `contributionTypes.ts`](../../src/core/services/contributionTypes.ts).

### Key store invariants

- **Platform-agnostic**: the store lives in `src/core/` and uses the lazy `getStore()` factory pattern — no Electron imports. This is what makes the contribution flow work on cloud/mobile later.
- **State transitions are gated**: `updateContribution` consults `VALID_STATE_TRANSITIONS`. Invalid transitions return `null` and stamp `lastTransitionError`; the caller (bridge, status service, or submit handler) decides how to recover.
- **Same-status no-op contract**: re-asserting the current status does not clear `lastTransitionError`. To clear explicitly, callers pass `lastTransitionError: undefined` in the update.

### Create vs promote

Creation happens via `createContribution` in four places:

1. **Bridge direct-create** — agent reports a status with no prior record in the session. [`bundledInboxBridge.ts`](../../src/main/services/bundledInboxBridge.ts), search for `bridge-report-state-create`.
2. **Bash build-success detection** — [`mcpBuildAutoDetectHook.handleMcpServerFileDetection`](../../src/main/services/mcpBuildAutoDetectHook.ts) creates at `testing` when it sees a successful `npm run build` in `~/mcp-servers/<name>/` or a detected `connectors/<name>/` repo.
3. **`rebel_mcp_add_server` observer** — when the agent registers the server via the MCP config tool, the observer creates at `ready_to_submit` if no record exists yet (handling subagent gap).
4. **Post-turn promotion sweep** — `runPromotionSweep` in the same file, also handles the subagent built it but the parent-turn hook never fired case.

Promotion from `testing → ready_to_submit` is consolidated behind ``promoteContributionIfReady`` — a single chokepoint. This prevents the four paths above from racing each other to promote the same record.


## Renderer: MCPBuildCard + Thinking Card

The renderer reacts to the store via a 2-second contribution poll driven by [`useMcpBuildCardState`](../../src/renderer/features/agent-session/hooks/useMcpBuildCardState.ts). The hook resolves the current contribution for the active session, and [`mapContributionToCardState`](../../src/shared/utils/contributionStateMapping.ts) maps it into one of these card phases:

| Phase              | Source status                                   | Where it renders |
|--------------------|-------------------------------------------------|-------------------|
| `building.implementing` | `draft`                                         | `ContextualProgressCard` (thinking card, Doing Right Now row) |
| `building.testing` | `testing` (no errors)                           | `ContextualProgressCard` |
| `testing-error`    | `testing` with `hasTestErrors`                  | Inline `MCPBuildCard` |
| `submit-prompt`    | `ready_to_submit`                               | Inline `MCPBuildCard` (Add to the community) |
| `submitting`       | In-flight submit                                | Footer `MCPBuildCard` |
| `submitted`        | `submitted` / `ci_*` / `approved` / `changes_requested` / `rejected` | Footer + inline phantom row |
| `submitted` (published substatus) | `published`                          | Success banner then quiet swap |

### Why building progress lives in the thinking card

Before 2026-04-23 the `building.*` subphases rendered as their own footer card at the bottom of the conversation. That left the card visually detached and, when the agent got stuck mid-build, the card sometimes lingered on later unrelated turns. The [260420 follow-up refactor](../plans/260420_simplify_mcp_build_flow.md#follow-up-fold-building-phase-into-the-thinking-card-landed-2026-04-23-commit-25abffcec) folded `building.*` into `ContextualProgressCard` as a priority-2 live activity (below `error`, above `running-tool`), with origin-turn tracking so a stuck `building` state cannot leak into turns started after the stuck episode began.

### Session-gated state

`useMcpBuildCardState` tags its cached inner state with the current `sessionId` and guards every read with a synchronous session check. This prevents a stale contribution from one session leaking into the UI of a different session. The invariant is tested at `useMcpBuildCardState.test.ts`.


## Submission in OSS-scrubbed builds

Stage 5 of the OSS content scrub removed the contribution-specific GitHub OAuth service and direct GitHub REST transport. GitHub-attributed contribution submission now fails closed in `src/main/services/contributionSubmitDispatcher.ts` rather than opening a dedicated OAuth flow.
## Status Polling

[`contributionStatusService`](../../src/main/services/contributionStatusService.ts) polls the PR on demand from each UI surface (build card, homepage panel, notification drawer). Pattern:

- **Fetch-on-mount**: each surface triggers a refresh when it becomes visible.
- **Staleness cache**: 5-minute `STALENESS_THRESHOLD_MS`. Fresh data short-circuits the GitHub call.
- **Single-flight dedup**: concurrent refreshes for the same contribution share one in-flight promise.
- **Timestamp hardening**: NaN or future `lastCheckedAt` is treated as stale (defensive).

`getPRStatus` fetches PR details + reviews + check runs for the head SHA. `mapPRStatusToContributionStatus` applies the priority order:

1. `merged` → `published`
2. `state: closed` (not merged) → `rejected`
3. Review state `APPROVED` → `approved`
4. Review state `CHANGES_REQUESTED` → `changes_requested` (review bodies joined into `reviewNotes`)
5. Any failed check → `ci_fail`
6. All checks passed → `ci_pass`
7. Otherwise → keep current status (pending checks)

Reviews outrank CI. Merge outranks everything. Nothing here writes `prUrl` — that was set at submission.


## Post-Publish: Transparent Catalog Swap

Once a PR reaches `published`, the next app boot runs [`contributionSwapService`](../../src/main/services/contributionSwapService.ts). For each `published` contribution:

1. Look up a matching rebel-oss catalog entry by `connectorName` (the catalog must have shipped an entry in a subsequent app release — see [MCP_OSS_CONNECTORS § Step 1](MCP_OSS_CONNECTORS.md#step-1-catalog-provides-the-spec)).
2. Check the user's `super-mcp-router.json` — if the entry already uses `npx` or has a `catalogId`, skip (already swapped).
3. Union env vars: catalog defaults overlaid with the user's existing env (user wins for overlapping keys).
4. `upsertMcpServerEntry` rewrites the config from `{ command: node, args: [<local-path>] }` to the catalog's `{ command: npx, args: [-y, @mindstone-engineering/mcp-server-<name>@X.Y.Z] }`.

Same server name, same identity fields, same credentials — the user does not have to reconnect. On the first spawn after boot, `managedMcpInstallService` takes over and turns the npx spec into a local managed install (see [MCP_OSS_CONNECTORS § How Managed Install Works](MCP_OSS_CONNECTORS.md#how-managed-install-works)).


## Error Recovery Surfaces

- **Stuck `testing` contributions** — Settings → Connectors surfaces a Stuck contributions section for records older than 10 min. Operators can Discard (delete from store; local files untouched) or manually re-run testing. Backed by the `contribution:delete` IPC in [`contributionHandlers.ts`](../../src/main/ipc/contributionHandlers.ts).
- **Startup sweep** — [`contributionStartupSweep`](../../src/main/services/contributionStartupSweep.ts) rebuilds promotion signals from filesystem + MCP config and retries promotion on every boot. Handles the historical subagent built it but hook never fired case.
- **`lastTransitionError`** — rejections write a machine-readable + human-readable message that the agent reads on the next turn via the `rebel_mcp_report_contribution_state` response. The agent self-corrects (e.g., notices it tried `ready_to_submit` without evidence, runs tests, reports again).
- **`testing-error` UI** — when the agent reports a `testing` state with tool-test failures, the inline card surfaces `lastTransitionError` and a Re-run check button so the user can nudge the agent.


## SE-evidence gate

The SE-evidence gate is a predicate extension that enforces the Software Engineer workflow completion before allowing `ready_to_submit`. It is off by default (Stages 0–5 of the SE-evidence gate plan); the migration to default-on is tracked in a separate planning doc.

### Predicate extension

The gate extends the composition predicate in ``contributionPromotionService.ts`` with a software-engineer evidence check. The flag `enforceSoftwareEngineerEvidence` controls whether the predicate fires:

- **Flag `false` (Stages 0–5)**: gate is dormant; contributions promote normally. This preserves the V3 baseline pass-rate during rollout.
- **Flag `true` (future migration plan)**: predicate requires SE evidence before accepting `ready_to_submit`. Contributions without evidence receive a deferred decision and recovery guidance.

### Where the gate runs

The gate fires in two places:

1. **Reducer path** — when the agent reports `ready_to_submit`, the bridge endpoint (`bundledInboxBridge.ts`) calls `contributionPromotionService.promoteContributionIfReady`. The predicate evaluates the contribution's evidence state. If the predicate rejects, the decision is `deferred` and the bridge renders a `nextAction: run_software_engineer_workflow` response.

2. **Autonomous-path** — `mcpBuildAutoDetectHook.runPromotionSweep` and `runPromotionSweep` also evaluate the gate. If the sweep finds a contribution at `testing` that satisfies all evidence except SE, the sweep writes a synthetic `lastTransitionError` to the contribution record and refuses promotion. The MCPBuildCard surfaces the error with recovery guidance.

### Recovery grammar

When the gate fires, the agent receives one of two chat-safe recovery grammars:

| Situation | `nextAction` | Chat-safe phrasing |
|---|---|---|
| Agent reported `ready_to_submit` without SE evidence | `run_software_engineer_workflow` | `Let me think this through properly before I share it.` |
| SE evidence is stale (build changed since last SE Task) | `run_software_engineer_workflow` | `Let me think this through properly before I share it.` |

The agent should invoke the Software Engineer subagent workflow, complete the working document at `docs/build-plan.md`, and re-attempt `ready_to_submit`.

### Deferred migration to default-on

The flag-flip to `enforceSoftwareEngineerEvidence: true` (default-on) is tracked in a separate migration planning doc. The migration plan covers: fixture retooling (~25 fixtures), pass-rate validation against V3 baseline, and the flag-flip itself. This document reflects the current state: flag default-off, gate dormant, no behavioural change to existing contributions.

See [`docs/plans/260428_se_evidence_and_build_context.md`](../plans/260428_se_evidence_and_build_context.md) for the full SE-evidence gate plan and the deferred migration plan reference.


## Build Context appendix

When a contribution reaches `submitted`, the contribution formatter ([`contributionPrFormatter.ts`](../../src/core/services/contributionPrFormatter.ts)) appends a Build Context block to the PR body. This is an always-on, machine-generated appendix that provides human reviewers with provenance signal.

### Content

The Build Context appendix includes:

- **model**: the model used for the agent session
- **app-version**: the Rebel app version at submission time
- **session-id**: the session identifier
- **task-subagent observations**: whether a Software Engineer Task was invoked, the subagent type, and the completion timestamp
- **build-plan shape**: the structure of the SE working document (e.g., `se-working-doc` if `docs/build-plan.md` exists with the SE template, `direct` if SE was skipped)

### Always-on policy

The Build Context appendix is **always appended** regardless of the `enforceSoftwareEngineerEvidence` flag setting. The gate controls whether SE evidence is required for promotion; the appendix provides auditability regardless of gate state.

### Truncation behaviour

The PR body is subject to `BODY_MAX = 4096` characters. A budget of `MAX_APPENDIX_LEN = 256` is reserved for the Build Context block. The truncation policy is:

1. **Body truncates first**: if the composed body exceeds `BODY_MAX − MAX_APPENDIX_LEN − 2` (for the `## Build Context` heading and separator), the body is truncated to fit. A `body_truncated` warning is emitted.
2. **Appendix always lands**: after body truncation, the Build Context appendix is appended. If the appendix itself exceeds `MAX_APPENDIX_LEN`, it is truncated with an `appendix_field_truncated` warning.

### Idempotency with mutating appendix

Because the Build Context block is auto-injected (not composed by the agent), the appendix can change between retry attempts (e.g., `session-id` stays stable, but `task-subagent observations` may be updated). The submit dispatcher handles this with identity-verified idempotency:

- **409 DUPLICATE with matching `relayContributionId`** + payload fingerprint match → treated as `idempotent_success` (the PR was submitted, the relay just saw a duplicate)
- **First-time-submit retry** (no stored `relayContributionId` yet): fallback to payload-fingerprint-only match with a `log.warn`
- **Content mismatch but ID reused**: surfaces as `real_error` with reason `content_changed_but_id_reused`; user sees chat-safe recovery message
- **Cross-contribution ID collision**: surfaces as `real_error` with reason `cross_contribution_id_collision`; user sees chat-safe recovery message

The pure helper `computePayloadFingerprintExcludingAppendix` strips the appendix block before hashing, so retries with a mutated appendix are not falsely flagged as content mismatches.

See [`architecture-decisions/contribution-relay-v1.md`](architecture-decisions/contribution-relay-v1.md) for the full idempotency protocol.

### No disk mirror

The Build Context appendix is **not persisted to disk** in the contribution store. It is generated at submit time and appended to the PR body. This is intentional: the appendix is a submit-time artefact for human reviewers, not a durable component of the contribution record. If the PR body needs to be reconstructed (e.g., after a relay-side edit), the Build Context is recomputed from the contribution store's identity fields.


## Key Code Locations

| What | File |
|------|------|
| Status enum + transition table | [`src/core/services/contributionTypes.ts`](../../src/core/services/contributionTypes.ts) |
| Persistent store (create/update/delete/ack/backfill) | [`src/core/services/contributionStore.ts`](../../src/core/services/contributionStore.ts) |
| Promotion predicate chokepoint | `src/core/services/contributionPromotionService.ts` (removed in `4ccafd7e7` — see heads-up banner at top of doc) |
| Bridge endpoint (`rebel_mcp_report_contribution_state`) | [`src/main/services/bundledInboxBridge.ts`](../../src/main/services/bundledInboxBridge.ts) — search `/contribution/report-state` |
| File-write / Bash build-success / add-server detection | [`src/main/services/mcpBuildAutoDetectHook.ts`](../../src/main/services/mcpBuildAutoDetectHook.ts) |
| Startup sweep (unstick historical `testing`) | [`src/main/services/contributionStartupSweep.ts`](../../src/main/services/contributionStartupSweep.ts) |
| PR-status polling + staleness cache + single-flight | [`src/main/services/contributionStatusService.ts`](../../src/main/services/contributionStatusService.ts) |
| Post-publish catalog swap | [`src/main/services/contributionSwapService.ts`](../../src/main/services/contributionSwapService.ts) |
| Published transactional email | [`src/main/services/contributionStatusService.ts`](../../src/main/services/contributionStatusService.ts) |
| IPC handlers (submit, submit-from-store, refresh, list, etc.) | [`src/main/ipc/contributionHandlers.ts`](../../src/main/ipc/contributionHandlers.ts) |
| IPC contracts | [`src/shared/ipc/channels/contribution.ts`](../../src/shared/ipc/channels/contribution.ts) |
| Renderer hook (session-gated read + 2 s poll) | [`src/renderer/features/agent-session/hooks/useMcpBuildCardState.ts`](../../src/renderer/features/agent-session/hooks/useMcpBuildCardState.ts) |
| Store state → card phase mapping | [`src/shared/utils/contributionStateMapping.ts`](../../src/shared/utils/contributionStateMapping.ts) |
| Thinking card with `mcpBuild` activity | [`src/renderer/features/agent-session/components/ContextualProgressCard.tsx`](../../src/renderer/features/agent-session/components/ContextualProgressCard.tsx) |
| MCPBuildCard (submit-prompt / submitted / testing-error) | [`src/renderer/features/agent-session/components/MCPBuildCard.tsx`](../../src/renderer/features/agent-session/components/MCPBuildCard.tsx) |
| Agent-side skill (8-phase build + DoD) | [`rebel-system/skills/coding/build-custom-mcp-server/SKILL.md`](../../rebel-system/skills/coding/build-custom-mcp-server/SKILL.md) |
| Agent-side submit-phase reference | [`rebel-system/skills/coding/build-custom-mcp-server/references/contribute-connector.md`](../../rebel-system/skills/coding/build-custom-mcp-server/references/contribute-connector.md) |


## Design Principles

These keep the flow robust and the UX predictable:

1. **The agent is the single authority for am I ready to submit** — per [260420 plan](../plans/260420_simplify_mcp_build_flow.md). The UI never auto-triggers testing or speculatively promotes status. The bridge evidence gate enforces this structurally.
2. **Deterministic card creation** — never rely on the agent remembering to call `rebel_mcp_report_contribution_state`. The auto-detect hook and post-turn sweep are load-bearing fallbacks. See [260414 deterministic-card plan](../plans/260414_deterministic_mcp_build_card.md).
3. **Promotion has one chokepoint** — `promoteContributionIfReady`. The composition predicate (`evidence AND (intent OR operational-state)`) is the structural correctness invariant; callers get to observe evidence, never to bypass the predicate.
4. **Session-gated UI state** — renderer caches are tagged with `sessionId` so stale data from earlier sessions cannot leak into the current conversation. Turn-gating on top of that (origin-turn tracking) prevents stuck state leaking between turns.
5. **Path safety at every boundary** — tilde expansion, home-dir guard, node_modules/dist/large-file skip, GitHub path allowlist. Each layer fails closed before the next one runs.
6. **Silent catalog swap is a feature** — the user's flow is not interrupted when their PR is published. Same server name, same env vars, cleaner runtime (managed install).


## Known Limitations

- **Post-publish email is idempotent by `publishedEmailSentAt`** — records that reached `published` before this field existed were back-filled to `updatedAt` to prevent retroactive your connector is live emails on first post-deploy refresh.
- **Fork readiness polling has a ceiling** — 10 attempts × 2 s = 20 s. If GitHub's fork queue stalls longer than that, the user must retry.
- **Renderer contribution poll is 2 s** — good for reactivity, costs re-renders. Mitigated by primitive-dep memoization in `ConversationPane`.
- **Catalog swap needs a subsequent app release** — after a PR merges, the swap only fires once a rebel-oss catalog entry ships in a new version of Rebel. Until then, the user keeps running their local build.
