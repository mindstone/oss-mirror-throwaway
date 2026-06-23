---
description: "Developer reference for automations: schedules, event triggers, execution pipeline, approval staging, IPC, and renderer surfaces."
last_updated: "2026-05-11"
audience: "contributors"
---

> Non‑technical user guide: see `rebel-system/help-for-humans/automations.md`

### Automations

Automations are scheduled, headless agent runs driven by local markdown skill files. Each run produces an `AutomationRun` with status and timing, and may link to a session. Automation sessions are hidden from history by default and can be toggled visible.

#### See also

- `docs/project/ARCHITECTURE_OVERVIEW.md` — Where the scheduler runs and how sessions are managed
- `docs/project/ARCHITECTURE_IPC.md` — Contract-first IPC and codegen
- `docs/project/INBOX_PANEL.md` — Related persistence/doc history for the surface now labeled **Actions** in the UI
- Main process:
  - `src/main/services/automationScheduler.ts` — Scheduler lifecycle, timers, execution pipeline; eager migration with reentrancy guard; per-definition try/catch on framework migrations v17/v24/v31; quarantine envelope for unrepairable persisted definitions
  - `src/main/index.ts` — `getAutomationScheduler()` provisioning and renderer notifications
- Shared types: `src/shared/types/automations.ts` — branded `AutomationSchedule` (intersection with `__brand: 'AutomationSchedule'`); see Constructors section below
- Shared schemas: `src/shared/ipc/schemas/automations.ts` — canonical Zod source of truth (`AutomationScheduleSchema`); compile-time drift guard between manual + Zod-inferred declarations
- Shared utilities:
  - `src/shared/utils/automationSchedule.ts` — **Mandatory entry point for constructing schedules.** 7 constructors (`AutomationSchedule.hourly/daily/weekly/monthly/event/once/everyNDays`) and `fromUntrusted(value, ctx)` repair-aware parser. Returns branded `AutomationSchedule` or typed error. The brand guarantees that any value typed as `AutomationSchedule` came through one of these gates.
  - `src/shared/utils/automationScheduling.ts` — Pure scheduling math (`calculateNextRunAt`, `calculateMostRecentScheduledTime`); fail-closed anchorDate guards retained as defense-in-depth (see R6 Active Constraint §7)
- Renderer UI:
  - `src/renderer/features/automations/hooks/useAutomationsAppState.ts`
  - `src/renderer/features/automations/components/AutomationsPanel.tsx`

#### Schedule Algebra Refactor (R6 COMPLETE, 260427_1438)

R6 centralized all schedule parsing and composition into a dedicated algebra layer, replacing scattered inline validation with a unified contract. The canonical entry point is [`src/shared/utils/automationSchedule.ts`](https://github.com/mindstone/rebel-app/blob/main/src/shared/utils/automationSchedule.ts): `AutomationSchedule` constructors (7 branches: `hourly`, `daily`, `weekly`, `monthly`, `event`, `once`, `everyNDays`) and `fromUntrusted(value, ctx)` for repair-aware parsing from untrusted sources (IPC, MCP, store-load, cloud-reload). Pure scheduling math (`calculateNextRunAt`, `calculateMostRecentScheduledTime`) lives in [`src/shared/utils/automationScheduling.ts`](https://github.com/mindstone/rebel-app/blob/main/src/shared/utils/automationScheduling.ts). The brand guarantee ensures any value typed as `AutomationSchedule` passed the canonical Zod parse — raw object literals no longer satisfy the type at upsert boundaries. The full repair matrix, 13 active constraints, and decision rationale are documented in [`docs/plans/260427_refactor_schedule_algebra.md`](../plans/260427_refactor_schedule_algebra.md).

#### Schedule construction (post-R6)

**Always use the constructors.** Raw object literals like `{ type: 'daily', time: '09:00' }` no longer satisfy the branded `AutomationSchedule` type and will compile-fail at the upsertDefinition boundary. Use:

```ts
import { AutomationSchedule } from '@shared/utils/automationSchedule';

// From typed inputs (e.g., system-default factory, UI form):
const schedule = AutomationSchedule.daily({ time: '09:00' });
const event = AutomationSchedule.event({ eventType: 'transcript-ready' });
const cadence = AutomationSchedule.everyNDays({ intervalDays: 7, time: '09:00', anchorDate: '2026-04-27' });

// From untrusted inputs (IPC, MCP, plugin, store-load migration, cloud reload):
const result = AutomationSchedule.fromUntrusted(rawValue, {
  source: 'mcp',                      // 'ipc' | 'mcp' | 'plugin' | 'store-load' | 'cloud-reload'
  existingCreatedAt: existing?.createdAt,
  now: Date.now(),
});
if (result.ok) {
  scheduler.upsertDefinition({ /* ... */ schedule: result.value });
} else {
  // result.error.kind ∈ 'unknown' | 'missing-field' | 'wrong-type' | 'missing-anchor-no-context' | …
  // Caller chooses to reject (IPC throws, MCP returns 400 with errorKind/field, store-load quarantines)
}
```

The repair table in `fromUntrusted` accepts legacy aliases (`event_type`, `trigger`) and missing `anchorDate` (backfilled from `existingCreatedAt` for updates or `now` for create). See [`260427_refactor_schedule_algebra.md`](../plans/260427_refactor_schedule_algebra.md) for the full repair matrix and the 13 Active Constraints. Persisted JSON shapes that can't be repaired are kept in an opaque `quarantined: AutomationScheduleQuarantineEntry[]` envelope (`AutomationStoreState.quarantined`) and surfaced read-only in the UI with a delete-only action.

#### How to add a new schedule branch

> Use this checklist when adding a new branch to `AutomationSchedule` (e.g. a new event-trigger sub-type, a new cadence like `weekly_business_days`, a new external-trigger family). The brand makes most omissions compile-fail, but a few surfaces only fail at runtime — work through all of them.

The dual-declaration drift guard (`_AutomationScheduleDualDeclarationDriftGuard` in `src/shared/ipc/schemas/automations.ts`, tuple-wrapped `[T] extends [U]`) compile-fails if `AutomationScheduleShape` (`src/shared/types/automations.ts`) and the inferred Zod type diverge. **Both must be updated together** — `lint:ts` will catch the drift but only after both files are saved consistently.

1. **Shape + Zod schema** (must be updated in lockstep):
   - `src/shared/types/automations.ts` — add the new variant to `AutomationScheduleShape` discriminated union.
   - `src/shared/ipc/schemas/automations.ts` — add the matching Zod object to `AutomationScheduleSchema`.
   - The drift guard `_AutomationScheduleDualDeclarationDriftGuard` will compile-fail until both line up.

2. **Constructor** (`src/shared/utils/automationSchedule.ts`):
   - Add `AutomationSchedule.<branch>(args)` to the constructors object. Use `constructSchedule(literal)` so the canonical Zod parse runs (which gives you the brand for free).
   - Add a unit test: deliberate bad input (wrong type, missing field) → constructor throws/rejects.

3. **`fromUntrusted` repair table** (`src/shared/utils/automationSchedule.ts`):
   - If the new branch needs legacy-alias repair (e.g. `intervalDays`/`interval_days`), add to the repair switch.
   - If it needs context-sensitive backfill (e.g. anchorDate-style), thread `existingCreatedAt`/`now` through. **Don't hide the lookup inside the constructor** — keep IPC plumbing explicit at the call site.
   - Add a `fromUntrusted` test: bad shape → typed `result.error.kind`, repaired shape → `ok: true`.

4. **Scheduling math** (`src/shared/utils/automationScheduling.ts`):
   - `calculateNextRunAt` and `calculateMostRecentScheduledTime` use `assertNever` exhaustive switches — TypeScript will compile-fail on the new branch. Add a math case.
   - Cover DST + month-boundary + leap-year if the new branch involves calendar arithmetic. Luxon (not raw ms) for date math.

5. **Migrations** (`src/main/services/automationScheduler.ts`):
   - If the new branch replaces or supersedes an existing one, add a migration in the `runEagerMigration` framework. Migrations must be wrapped in per-definition try/catch so a single bad row doesn't kill the whole store; unrepairable rows go to `quarantined`.
   - Bump `AUTOMATION_STORE_VERSION` in `src/core/constants.ts` and update `ALL_STORE_VERSIONS` (CI validates via `scripts/check-store-versions.ts`).

6. **Cloud parity** (`cloud-service/src/cloudAutomationStore.ts`):
   - Cloud runs its own eager `fromUntrusted` pass on persisted definitions. If the new branch needs cloud-specific repair logic, mirror it here. Bump the local cloud `STORE_VERSION` (independent of `AUTOMATION_STORE_VERSION`).

7. **MCP / IPC surfaces**:
   - `src/main/ipc/automationsHandlers.ts` and `src/main/services/bundledInboxBridge.ts` use the parse-then-repair flow. New branch is automatically supported once `fromUntrusted` knows about it — no per-handler wiring needed.
   - `resources/mcp/rebel-automations/server.cjs` exposes a Zod schema to MCP clients. Update the input schema if the new branch should be MCP-creatable. Re-run `npm run test:mcp:smoke` to verify.

8. **Operator role-generation schema** (`src/main/ipc/operatorsHandlers.ts`, the `roleJsonSchema` literal — search for `enum: ['daily', 'weekly']`):
   - This is an **LLM-facing JSON schema** sent to the role-generation prompt. Adding a new branch here = LLM prompt-contract change → **STOP gate: requires eval coverage** per AGENTS.md "LLM Prompt Changes Require Eval Coverage". Do NOT add it without updating `operatorGenerationPrompt.ts` (so the LLM knows how to use it) AND updating/creating evals.

9. **UI** (`src/renderer/features/automations/components/AutomationsPanel.tsx`):
   - Schedule picker — new branch needs a UI affordance.
   - Display formatting — `formatScheduleHuman` (or equivalent) should describe the new branch.
   - Test both light and dark modes.

10. **Tests + verification**:
    - Unit tests: constructor, `fromUntrusted`, scheduling math, migration (if applicable).
    - `npm run validate:fast` — TS ratchet 0/0, store-version check, MCP bundle check.
    - Cast sweep: `rg 'as AutomationSchedule' src cloud-service` should still return only the 2 sanctioned sites in `automationSchedule.ts`. The ESLint brand-cast guard (`no-restricted-syntax`) will fail any new cast outside that file.

The R6 planning doc ([`260427_refactor_schedule_algebra.md`](../plans/260427_refactor_schedule_algebra.md)) has worked examples of all 7 existing branches and the 13 Active Constraints — read it before designing the new branch's shape.

---

### Data model (key excerpts; authoritative in `src/shared/types/automations.ts`)

> **Note (post-R6, 2026-04-27):** `AutomationSchedule` is a branded intersection (`& { __brand: 'AutomationSchedule' }`). Constructing one requires going through the constructors or `fromUntrusted` in `src/shared/utils/automationSchedule.ts` — raw object literals will not satisfy the type at upsert boundaries. The unbranded shape below is shown for shape reference only; the canonical Zod schema lives in `src/shared/ipc/schemas/automations.ts`.

```ts
// Shape reference (the actual exported type adds & { __brand: 'AutomationSchedule' }):
export type AutomationScheduleShape =
  | { type: 'hourly'; minute: number }                       // 0–59
  | { type: 'daily'; time: string; additionalTimes?: string[] }  // "HH:mm" local; additionalTimes for multiple runs/day
  | { type: 'every_n_days'; intervalDays: number; time: string; anchorDate: string /* ISO */ }
  | { type: 'weekly'; daysOfWeek: number[]; time: string }   // 0=Sun..6=Sat
  | { type: 'monthly'; daysOfMonth: number[]; time: string; runOnLastDayIfShorter?: boolean }
  | { type: 'event'; eventType: AutomationEventType }        // Event-triggered (see below)
  | { type: 'once'; dateTime: string };                      // ISO 8601 local run time

export type AutomationRunStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'completed_with_blocks'
  | 'failure'
  | 'blocked_by_security'
  | 'cancelled';
export type AutomationTrigger = 'schedule' | 'manual' | 'launch' | 'catch-up' | 'event' | 'rules-update';
export type SystemAutomationType =
  | 'use-case-refresh'
  | 'wins-learnings-uncover'
  | 'community-highlights'
  | 'calendar-sync'
  | 'source-capture'
  | 'transcript-analysis'
  | 'transcript-distribution'
  | 'morning-triage'
  | 'community-video-recs'
  | 'focus-weekly-prep'
  | 'focus-monthly-review';

/**
 * Event types that can trigger automations. Supports parent/child semantics:
 * - 'transcript-ready': Any transcript (matches all sub-types)
 * - 'transcript-ready:rebel': Only Rebel meeting bot transcripts
 * - 'transcript-ready:external': Only external provider transcripts (Fireflies, Fathom)
 * - 'transcript-distribution-ready': Transcript is at final quality and ready for distribution
 */
export type AutomationEventType =
  | 'transcript-ready'
  | 'transcript-ready:rebel'
  | 'transcript-ready:external'
  | 'transcript-distribution-ready';

export interface AutomationDefinition {
  id: string;
  name: string;
  description?: string;
  filePath: string;
  schedule: AutomationSchedule;
  enabled: boolean;
  catchUpIfMissed?: boolean;  // Run if scheduled time was missed (app closed). Default: true for daily+, false for hourly
  createdAt: number;
  updatedAt: number;
  lastRunStatus?: AutomationRunStatus;
  lastRunAt?: number | null;
  lastSuccessAt?: number | null;
  nextRunAt?: number | null;
  isSystem?: boolean;
  systemType?: SystemAutomationType;
  executeIn?: 'local' | 'cloud';
  timezone?: string;
  model?: string;
  thinkingModel?: string;
}

export interface BlockedAction {
  toolId: string;
  toolName: string;
  reason: string;
  timestamp: number;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  startedAt: number;
  completedAt?: number | null;
  status: AutomationRunStatus;
  trigger: AutomationTrigger;
  sessionId?: string | null;
  error?: string | null;
  eventsByTurn?: Record<string, AgentEvent[]>;
  messages?: AgentTurnMessage[];
  session?: AgentSession | null;
  blockedActions?: BlockedAction[];
  targetPeriodStart?: number;
}

/** Session type filter for sidebar - 'all' shows both conversations and automations */
export type SessionTypeFilter = 'all' | 'conversations' | 'automations';

export interface AutomationStoreState {
  version: number;
  definitions: AutomationDefinition[];
  runs: AutomationRun[];
  sessionTypeFilter: SessionTypeFilter;  // 'all' | 'conversations' | 'automations'
}
```

---

### IPC surfaces

Subscriptions (main → renderer):
- `automation:state` — Push updates of `AutomationStoreState`

Invoke (renderer → main):
- `automations:state` → `AutomationStoreState`
- `automations:upsert` (partial definition with required `schedule`) → updated state/definition
- `automations:delete` (automationId) → `AutomationStoreState`
- `automations:run-now` (automationId) → `AutomationRun | null`
- `automations:set-session-type-filter` (SessionTypeFilter) → `AutomationStoreState`

Preload helpers (`src/preload/index.ts`):
- `loadAutomations`, `upsertAutomation`, `deleteAutomation`, `runAutomationNow`, `setSessionTypeFilter`, `onAutomationState`

---

### Main-process scheduler (`src/main/services/automationScheduler.ts`)

- Persistence: `electron-store` (`automations`) with versioning and safe migrations; read-only mode when a future-version store is detected.
- Scheduling:
  - Computes `nextRunAt` per definition and registers timers (hourly/daily/interval/weekly/monthly/once)
  - Uses **Luxon** for DST-correct date math (avoids 86,400,000 ms per day assumption)
  - Respects low-power mode (skips scheduling when applicable)
  - Handles long delays (>24.8 days) by setting intermediate timers that re-evaluate
  - Triggers: `schedule`, `manual` (via `run-now`), `catch-up` (missed while app closed)
- Execution pipeline:
  - Runs a headless agent pipeline and records `AutomationRun` with status, timing, optional error, and session linkage
  - Strips YAML frontmatter from markdown files before execution
  - Substitutes prompt variables (e.g., `[LAST_EXECUTED_SUCCESS]` → timestamp of last successful run)
  - When a tool or memory write is blocked by access rules, the action is **staged for user approval** (see "Access rules and staging approval" below) rather than hard-denying
  - Tracks security denials; if tools were blocked and the run failed, status becomes `blocked_by_security`
  - Re-schedules the automation after each run (re-fetches definition to avoid resurrecting disabled/deleted automations)
  - Prevents concurrent runs of the same automation
- Session filtering: `sessionTypeFilter` controls which sessions appear in the sidebar ('all' | 'conversations' | 'automations')
- Provisioning: Created in `src/main/index.ts` (`getAutomationScheduler()`), which also forwards state to the renderer via `automation:state`
- **Unit tests**: `src/main/services/__tests__/automationScheduler.test.ts` (65+ tests covering all schedule types)

System automations
- `use-case-refresh`: Refreshes personalized use cases; created during onboarding, scheduled daily at 17:00 local by default.
- `wins-learnings-uncover`: Daily Wins & Learnings automation; runs `rebel-system/skills/operations/wins-and-learnings-uncover/SKILL.md` at 09:30 local by default.
- `community-highlights`: Fetches trending topics from the Rebels community; scheduled daily at 08:00 local by default.
- `calendar-sync`: LLM-based calendar sync for "other" (non-Google/Microsoft) calendar providers. **Only enabled when `settings.calendar.useOtherCalendarProvider` is true.** For Google/Microsoft calendars, the free deterministic `directCalendarSync.ts` path handles sync automatically (no LLM, no safety evaluation, no approval prompts). The invariant — automation enabled state must mirror the setting — is enforced at 4 layers: settings change handler, startup reconciliation, `executeAutomation()` guard, and `upsertDefinition()` guard. See `docs/plans/260329_calendar_sync_split_brain_fix.md` for the full rationale and `docs/plans/obsolete/260123_direct_calendar_sync.md` for the original architecture decision.
- `source-capture`: Captures citable sources (meetings, documents, files) into memory with provenance metadata; runs `rebel-system/skills/memory/source-capture/AUTOMATION.md` twice daily at 12:30 and 17:30 local by default.
- `transcript-analysis`: Runs when a transcript arrives and generates the follow-on analysis session.
- `transcript-distribution`: Runs on `transcript-distribution-ready` after transcript quality/distribution prerequisites are satisfied.
- `morning-triage`, `community-video-recs`, `focus-weekly-prep`, `focus-monthly-review`: Additional built-in automations provisioned by `automationScheduler.ts`; see the scheduler defaults for current timings and enablement rules.

### Event-triggered automations

Automations can be triggered by events (e.g., when a meeting transcript is saved) instead of or in addition to time-based schedules.

**How events flow:**
1. An event source (e.g., meeting bot service) emits an event via `transcriptEventBus` (`src/main/services/meetingBot/transcriptEventBus.ts`)
2. The main process (`src/main/index.ts`) subscribes to relevant events and calls `scheduler.triggerByEvent(eventType, context)`
3. The scheduler finds all enabled automations with `schedule.type === 'event'` and matching `eventType`
4. Matching automations are executed with `trigger: 'event'` recorded in the run

**Event type matching:**
- Parent types (e.g., `transcript-ready`) match all child types (e.g., `transcript-ready:rebel`, `transcript-ready:external`)
- Child types only match their specific variant
- This allows creating automations that run for any transcript OR only for specific sources

**UI configuration:**
- Users can select "When transcript is ready" or other event-based triggers in the Automations panel schedule picker
- The event type dropdown allows selecting specific transcript sources, distribution-ready, or the broad catch-all event

**Failure modes:**
- If no automations match the event type, the event is silently ignored
- If the automation is already running (same automation ID), the event is skipped
- If the transcript/file is not yet available, the run may fail with an error

**Implementation pointers:**
- `src/main/services/automationScheduler.ts::triggerByEvent()` — Entry point for event-driven runs
- `src/main/services/meetingBot/transcriptEventBus.ts` — Event bus for transcript events
- `src/main/index.ts` — Wires `onTranscriptSaved` events to the scheduler
- `src/renderer/features/automations/components/AutomationsPanel.tsx` — UI for configuring event-triggered automations

### Access rules and staging approval

Automations have per-definition **access rules** — LLM-generated allowlists describing which tools the automation may use. When an automation tries to use a tool or write to a memory space not covered by its rules, the action is **staged for user approval** instead of being hard-denied. Once the user approves, access rules are automatically expanded and the automation restarts.

See also:
- [TOOL_SAFETY.md](TOOL_SAFETY.md) — General tool safety (sibling system); the "Automation-specific behavior" section covers how staging interacts with tool safety hooks
- [MEMORY_SAFETY.md](MEMORY_SAFETY.md) — Memory write safety; the "Automation-specific behavior" section covers staging of blocked memory writes

#### Access rules lifecycle

```
Automation runs → Tool/memory call not in access rules
    │
    ▼
Action staged for user approval
(MCP tools: staged tool call; non-MCP: deny-then-retry; memory: CoS pending)
    │
    ▼
Run completes with staged items → automationPendingItemsTracker coordinates
    │
    ▼
User reviews staged items (NotificationDrawer, Actions, ApprovalPointerBar)
    │
    ├── Approve → Access rules auto-expanded via LLM
    └── Reject → No rule change
    │
    ▼
All items resolved → Auto-restart automation (trigger: 'rules-update')
    │
    ├── Max 3 auto-restarts → then fallback to update_suggested status
    └── Clean success → restart counter resets
```

#### How blocked actions are staged

When an automation encounters an action not covered by its access rules, the routing depends on the tool type:

| Tool type | Staging mechanism | How it appears to user |
|-----------|-------------------|----------------------|
| MCP tools (via Super-MCP) | Staged tool call (`stagedToolCallsService`) — tool returns `_rebel_staged` allow with error result | "Automation" badge on staged item in NotificationDrawer |
| Non-MCP tools (Bash, etc.) | Deny-then-retry pattern — tool denied, approval card shown | Standard approval card with "Automation" badge |
| Memory writes | Staged to CoS pending (`cosPendingService`) — write returns deny-without-continue | Pending file in Actions (backed by the inbox store) with the standard review flow |

#### Coordination: `automationPendingItemsTracker`

The `automationPendingItemsTracker` service (`src/main/services/safety/automationPendingItemsTracker.ts`) coordinates the lifecycle of all pending items across the three staging mechanisms. It tracks items per automation ID and fires a callback when:
1. All items are resolved (approved or rejected), AND
2. The run has completed (`markRunComplete` called by the scheduler)

This two-condition gate prevents premature restarts while items are still being collected during the run.

#### Auto-update of access rules

When items are approved, the system calls `handleApprovalAndUpdateRules()` (`accessRulesManager.ts`) which:
1. Calls `expandAccessRulesFromApprovals()` (`accessRulesGenerator.ts`) — an LLM prompt that generalizes the approved actions into new access rule clauses
2. Merges the expanded rules with existing rules
3. Clears the access rules cache so the next run uses updated rules

#### Auto-restart

After all staged items are resolved and the run is marked complete:
- If any item was approved → restart the automation with trigger `'rules-update'`
- Maximum **3** auto-restarts per automation to prevent infinite loops
- After 3 restarts, the system falls back to `accessRulesStatus: 'update_suggested'` (shows a banner in the Automations panel)
- The restart counter resets on a clean success (no staged items)

#### Key files

| File | Purpose |
|------|---------|
| `src/main/services/safety/automationPendingItemsTracker.ts` | In-memory coordination of pending items across all staging mechanisms |
| `src/core/safetyPromptLogic.ts` | LLM-based generation and expansion of access rules |
| `src/core/safetyPromptLogic.ts` | Orchestrates rule updates, cache clearing, and fallback |
| `src/main/services/safety/automationContextLookup.ts` | Resolves access rules for a given session/automation |
| `src/main/services/toolSafetyService.ts` | `handleAutomationAccessRulesBlock()` — routes blocked MCP/non-MCP tools to staging |
| `src/main/services/safety/memoryWriteHook.ts` | `stageAutomationMemoryWriteBlock()` — routes blocked memory writes to CoS pending |
| `src/main/services/automationScheduler.ts` | Wires tracker callbacks, auto-restart logic, restart counter |
| `src/main/services/safety/__tests__/automationPendingItemsTracker.test.ts` | 18 tests for tracker lifecycle |

---

### Writing automation-compatible skill files

Automation skill files are sent as the user message to the agent. The content must be **imperative and actionable** — telling the agent what to do, not describing what the skill does.

- Use `[LAST_EXECUTED_SUCCESS]` for time-scoped incremental processing (substituted with ISO timestamp)
- If a skill's `SKILL.md` is documentation-style, create a thin `AUTOMATION.md` wrapper that references it (see `rebel-system/skills/memory/source-capture/`)

---

### Date/time handling

All schedule times are **local time** — "7am daily" means 7am in the user's current timezone, wherever they are. This is the correct behavior for a personal productivity app.

Key implementation details:
- `calculateNextRunAt()` and `calculateMostRecentScheduledTime()` are pure functions exported for testing
- Luxon handles DST transitions correctly (adding 1 day adds 1 calendar day, not 86,400,000 ms)
- Anchor dates for `every_n_days` are parsed as local midnight to preserve the user's intended calendar day

---

### Renderer surfaces

- Hook: `useAutomations` (split into focused sub-hooks with adaptive polling and local `busyElapsedMs` tracking) loads state and subscribes to `automation:state`.
- Hook: `useAutomationApprovals` maps pending tool/memory approvals to their parent automations (via session ID linkage).
- UI: `AutomationsPanel` allows create/update schedules, enable/disable, "Run now," delete, view pending approvals, and filter session history.
- History: The sidebar has a type filter (All / Conversations / Automations) controlled by `sessionTypeFilter`. Automation sessions appear with a purple "Automation" badge.

---

### Typical flows

App launch
1. Automations are loaded; the scheduler initializes and registers timers.
2. Any enabled automations with `catchUpIfMissed: true` that missed their scheduled time (within 7-day grace period) run once as a catch-up.

Scheduling and running
1. Create or edit an automation with name, markdown `filePath`, and schedule.
2. Scheduler computes `nextRunAt` and registers the timer.
3. At trigger time (or when “Run now” is clicked), the scheduler executes, records an `AutomationRun`, and re-schedules.
4. If history visibility is enabled, associated sessions appear with a badge in history/search.

---

### Troubleshooting & gotchas

- Future-version store → read-only: Writes are blocked to avoid data loss. Open the latest app or backup/remove the store before downgrading.
- Low-power mode: Scheduling is skipped when in low-power mode.
- Missing or moved file: Runs fail if the markdown `filePath` is invalid; update the definition in the Automations panel.

---

### Privacy & logging

- No secrets are logged; structured logs record status/error events.
- Automation runs create agent sessions; when history visibility is enabled, these sessions are user-visible like normal runs.

---

### Maintenance notes

- Contract changes: Update `src/shared/ipc/contracts.ts` and `src/preload/ipcBridge.ts`, run `npm run validate:ipc`.
- Store evolution: Add migrations and bump the automations store version.
- Renderer performance: Use selector-based subscriptions; avoid unnecessary re-renders in panels.



