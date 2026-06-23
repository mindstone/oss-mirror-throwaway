---
description: "Catalog of analytics events/properties emitted from main and renderer processes"
last_updated: "2026-05-31"
---

# Analytics Data Dictionary

> **Status:** Generated from codebase audit

This document catalogues all analytics events sent to RudderStack/PostHog from Mindstone Rebel. For architecture and configuration, see [ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md](./ANALYTICS_AND_TRACKING_WITH_RUDDERSTACK_POSTHOG.md).

---

## Table of Contents

1. [Main Process Events](#main-process-events)
2. [Renderer Events - Lifecycle](#renderer-events---lifecycle)
3. [Renderer Events - Onboarding](#renderer-events---onboarding)
4. [Renderer Events - Chat/Agent](#renderer-events---chatagent)
5. [Renderer Events - Tools/MCP](#renderer-events---toolsmcp)
6. [Renderer Events - Automations](#renderer-events---automations)
7. [Renderer Events - Voice](#renderer-events---voice)
8. [Renderer Events - Inbox](#renderer-events---inbox)
9. [Renderer Events - Settings](#renderer-events---settings)
10. [Renderer Events - Library](#renderer-events---library)
11. [Renderer Events - Atlas](#renderer-events---atlas)
12. [Renderer Events - Mind Map](#renderer-events---mind-map)
13. [Renderer Events - Spark/Use Cases](#renderer-events---sparkuse-cases)
14. [Renderer Events - Tutorials](#renderer-events---tutorials)
15. [Renderer Events - Meeting Bot](#renderer-events---meeting-bot)
16. [Renderer Events - Navigation](#renderer-events---navigation)
17. [Renderer Events - NPS Survey](#renderer-events---nps-survey)
18. [Renderer Events - Approvals](#renderer-events---approvals)
19. [Diagnostics Events](#diagnostics-events)
20. [Identity/Traits](#identitytraits)
21. [Milestones](#milestones)
22. [Mobile Events (React Native client)](#mobile-events-react-native-client)

---

## Main Process Events

### `Application Opened`

**Business Value:** Measures active user base, app launches, and cold vs warm start performance.

**Source:** `src/main/index.ts`, `src/main/tracking.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `version` | string | App version |
| `coldStart` | boolean | Whether this was a fresh launch (not resume) |
| `launchDurationMs` | number | Time from launch to ready |
| `platform` | string | OS (darwin, win32, linux) |
| `arch` | string | Architecture (x64, arm64) |

**Gotchas:** Sent twice in some cases - once immediately at launch (index.ts) and once after initialization completes (tracking.ts). The second call includes richer metadata.

---

### `Application Quit`

**Business Value:** Track session duration, graceful shutdowns, understand usage patterns.

**Source:** `src/main/services/gracefulShutdown.ts`, `src/main/tracking.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `version` | string | App version |
| `sessionDurationMs` | number | How long the app was open |
| `sessionsCount` | number | Number of sessions in this run |

**Gotchas:** May not fire if app crashes or is force-killed. The gracefulShutdown version has minimal properties; the tracking.ts version has richer data.

---

### `Agent File Operation`

**Business Value:** Understand which file types agents create/edit, track memory and skill usage.

**Source:** `src/main/tracking.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `turnId` | string | Agent turn ID |
| `sessionId` | string | Hashed session ID (16 hex chars) |
| `operation` | string | `create` or `edit` |
| `fileExtension` | string | File extension (e.g., `.md`, `.ts`) |
| `isMemoryFile` | boolean | Whether file is in a memory space |
| `isSkillFile` | boolean | Whether file is in skills directory |

---

### `skill_modified` / `skill_restored` / `skill_forked`

**Business Value:** Measure real collaboration activity on shared skills: how often shared skills change, how often users recover old versions, and how often they fork a shared version into a private copy.

**Source:** `src/main/services/skillChangeNotificationService.ts`, `src/main/services/driveSkillHistoryService.ts`

**Properties (`skill_modified`):**
| Property | Type | Description |
|----------|------|-------------|
| `skill_id` | string | Workspace-relative skill path |
| `author_id` | string? | Stable auth ID from the skill frontmatter |
| `modified_by` | string? | Stable ID of the responsible human modifier (falls back to `rebel` only if no human context is available) |
| `is_agent` | boolean | Whether Rebel performed the write on behalf of a human |
| `space_id` | string | Workspace-relative space path |

**Trigger conditions:** Fires on managed shared-skill writes, including the first time a shared skill file is created (no prior on-disk content).

**Properties (`skill_restored`):**
| Property | Type | Description |
|----------|------|-------------|
| `skill_id` | string | Workspace-relative skill path |
| `restored_to_version` | string | Snapshot ID restored into the live skill |
| `restored_by` | string? | Stable auth ID of the restoring user |

**Properties (`skill_forked`):**
| Property | Type | Description |
|----------|------|-------------|
| `source_skill_id` | string | Original shared skill path |
| `fork_skill_id` | string | New private fork path |
| `forked_by` | string? | Stable auth ID of the user who created the fork |

---

### `Automation Enabled` / `Automation Disabled`

**Business Value:** Track automation adoption and lifecycle.

**Source:** `src/main/services/automationScheduler.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `automationId` | string | The automation's ID |
| `runCount` | number | (Disabled only) Total runs before disabling |

---

### `Automation Run Completed` / `Automation Run Failed`

**Business Value:** Measure automation success rates, duration, and output volume.

**Source:** `src/main/services/automationScheduler.ts`

**Properties (Completed):**
| Property | Type | Description |
|----------|------|-------------|
| `automationId` | string | The automation's ID |
| `status` | string | Always `success` |
| `durationMs` | number | Execution time |
| `turnCount` | number | Agent turns in run |
| `messagesGenerated` | number | Output messages |
| `outputSessionId` | string? | Hashed session ID if output chat created |

**Properties (Failed):**
| Property | Type | Description |
|----------|------|-------------|
| `automationId` | string | The automation's ID |
| `trigger` | string | What triggered the run |
| `errorCode` | string | Error classification |
| `errorType` | string | Specific error type |
| `durationMs` | number | Time until failure |

---

### `User Engagement Heartbeat`

**Business Value:** Accurate measurement of active user engagement, independent of PostHog's session metrics which are inflated by background automations.

**Source:** `src/main/services/userEngagementService.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `idle_seconds` | number | Seconds since last user input (0-300) |
| `source` | string | Always `user_input` (distinguishes from automation events) |
| `heartbeat_interval_minutes` | number | Heartbeat interval (currently 5) |

**Conditions for firing:**
- Window is visible (not minimized)
- User had trusted DOM input (keydown/pointerdown/scroll) within last 5 minutes
- Activity occurred after last system suspend/lock

**How to calculate engagement:**
- Count heartbeats × 5 = approximate active minutes
- Use `idle_seconds` property for more granular analysis

**Gotchas:** 
- Does NOT require window focus at heartbeat time (focus when activity occurred is what matters)
- 5-minute granularity means single interactions may credit up to 5 minutes
- Voice input also triggers activity via `pingUserActivityForVoice()`

---

### `Daily Cost Summary`

**Business Value:** Aggregated cost reporting for org-level spend analysis. Enables tracking total API costs per organization per day.

**Source:** `src/core/services/dailyCostReportingService.ts` (main-process shim at `src/main/services/dailyCostReportingService.ts`)

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `date` | string | UTC date string (e.g., `2026-01-30`) |
| `totalCostUsd` | number | Total cost for that day |
| `turnCount` | number | Number of agent turns |
| `entryCount` | number | Number of ledger entries |
| `byCategory` | object | Cost breakdown by raw category (agent, automation, safety, etc.) |
| `byCategoryGrouped` | object | Cost breakdown by UX-grouped category (conversations, automations, memoryNotes, housekeeping, safetyChecks, fileIntelligence). Matches local Usage tab grouping via `COST_CATEGORY_REGISTRY`. |
| `byAuthMethod` | object | Cost breakdown by auth method (`oauth-token`, `api-key`, `unknown`) |
| `byAutomationType` | object | Automation costs by type (calendar-sync, source-capture, etc.) |
| `byModel` | string | JSON-serialized model-to-cost map (e.g., `{"claude-sonnet-4-6": 1.23}`) |
| `totalInputTokens` | number | Sum of input tokens across all ledger entries for the day |
| `totalOutputTokens` | number | Sum of output tokens across all ledger entries for the day |
| `totalCacheReadTokens` | number | Sum of cache read tokens for the day |
| `totalCacheCreationTokens` | number | Sum of cache creation tokens for the day |
| `totalPromptTokens` | number | `totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens` — convenience for cache hit ratio calculation |
| `subscriptionCoveredUsd` | number | Cost covered by subscription auth methods (e.g., Claude subscription, ChatGPT plan) |
| `userPaidUsd` | number | Cost paid by user via API keys or other non-subscription methods |
| `freeUsd` | number | Cost from local/free models (no billing) |
| `activeSessionCount` | number | Unique non-internal session IDs active on this day. Excludes automations, memory updates, CLI sessions. Note: a session spanning multiple days is counted on each day it has ledger entries. |
| `idempotencyKey` | string | `cost-{anonymousId}-{date}` for deduplication |

Events are enriched by the shared analytics context with explicit account properties when known: `company_id`, `company_name`, `company_slug`, `account_id`, `account_name`, `account_slug`, and `account_attribution_source`. These fields are required by downstream account-level cost dashboards; email/person matching is not used for customer-facing spend.

**Privacy:** All properties are aggregate numeric data. No session IDs, conversation titles, memory file names, or user content are included.

**Trigger conditions:**
- Sent on app startup (fire-and-forget)
- Only reports **completed days** (yesterday and earlier, never "today")
- Limited to 90-day backfill on first run
- Skips days with zero costs (no event sent)

**Deduplication:** Uses `idempotencyKey` property. If the app crashes between sending and updating the watermark, the same day may be re-sent on next startup. PostHog should dedupe by `idempotencyKey`.

**See also:** [COST_TRACKING.md](./COST_TRACKING.md#analytics-reporting) for how this relates to local cost tracking.

---

### `Cost Incurred`

**Business Value:** Per-entry cost tracking — every LLM call that writes to the local cost ledger also emits this event. Enables real-time cost monitoring, per-category and per-model spend analysis, and cross-referencing with the local ledger.

**Source:** `src/core/services/costLedgerService.ts` → `appendCostEntry()`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `costUsd` | number | USD cost of this entry |
| `category` | string | Cost category key from `COST_CATEGORY_REGISTRY` (e.g., `agent`, `safety`, `memory`) |
| `model` | string | Model identifier (may be composite like `claude-sonnet-4-6 + claude-haiku-4-5` for multi-model turns) |
| `authMethod` | string? | `api-key`, `oauth-token`, or `unknown` |
| `inputTokens` | number? | Input tokens consumed |
| `outputTokens` | number? | Output tokens generated |
| `cacheReadTokens` | number? | Cache read tokens |
| `cacheCreationTokens` | number? | Cache creation tokens |
| `estimated` | boolean? | `true` if cost was estimated from pricing table (not reported by API) |
| `pricingModelResolved` | string\|null | Single-model entries: the model used for pricing lookup. Multi-model entries: `null` |
| `primaryModel` | string? | (Multi-model only) Most expensive model by estimated cost |
| `modelCount` | number? | (Multi-model only) Number of distinct models in this entry |
| `modelBreakdownJson` | string? | (Multi-model only) JSON-encoded per-model usage map |

**Trigger conditions:**
- Emitted on every `appendCostEntry()` call (fire-and-forget)
- Includes both turn-level costs (agent, conversation, chat) and auxiliary costs (safety, memory, coaching, etc.)
- Skipped if tracker is not available (pre-init or offline)

**Categories:** All 44 categories from `COST_CATEGORY_REGISTRY` in `src/shared/costCategories.ts`. See [COST_TRACKING.md](./COST_TRACKING.md) for the full category list and grouping.

**See also:** `Daily Cost Summary` (aggregated daily version), [COST_TRACKING.md](./COST_TRACKING.md#analytics-reporting)

---

### `Daily Time Saved Summary`

**Business Value:** Aggregated time-saved reporting for org-level analysis. Enables tracking productivity gains per organization per day. Impact weighting surfaces whether Rebel is doing valuable work vs busywork.

**Source:** `src/core/services/dailyTimeSavedReportingService.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `date` | string | UTC date string (e.g., `2026-01-30`) |
| `totalMinutes` | number | Impact-weighted time saved (midpoint of estimates x impact multiplier). **Not raw** -- see `rawMinutes` for unweighted. |
| `rawMinutes` | number | Unweighted time saved (midpoint of estimates, no impact adjustment). Use for backward-compatible analysis. |
| `lowMinutes` | number | Sum of low estimates (raw, unweighted) |
| `highMinutes` | number | Sum of high estimates (raw, unweighted) |
| `entryCount` | number | Number of time-saved entries |
| `sessionCount` | number | Number of unique sessions |
| `byTaskType` | object | Weighted minutes breakdown by task type (research, writing, coordination, analysis, automation, mixed) |
| `byConfidence` | object | Weighted minutes breakdown by confidence level (low, medium, high) |
| `byImpact` | object | Raw minutes breakdown by impact level (trivial, low, medium, high, critical, unknown) |
| `impactWeightingRatio` | number | `totalMinutes / rawMinutes` (e.g., 1.15 means weighting added 15%). Always 1.0 when rawMinutes is 0. |
| `lowConfidenceShare` | number | Fraction of raw minutes from low-confidence estimates (0-1). High values suggest unreliable day totals. |
| `highImpactSessionCount` | number | Number of sessions with at least one critical or high impact entry. Useful for adoption/retention correlation. |
| `idempotencyKey` | string | `time-saved-{anonymousId}-{date}` for deduplication |

Events are enriched by the shared analytics context with explicit account properties when known: `company_id`, `company_name`, `company_slug`, `account_id`, `account_name`, `account_slug`, and `account_attribution_source`.

**Impact multipliers:** critical=1.5x, high=1.25x, medium=1.0x (baseline), low=0.5x, trivial=0x, unknown=1.0x (migrated entries). See [TIME_SAVED.md](./TIME_SAVED.md#impact-weighting) for details.

**Trigger conditions:**
- Sent on app startup (fire-and-forget)
- Only reports **completed days** (yesterday UTC and earlier, never "today")
- Limited to 90-day backfill on first run
- Skips days with no time-saved entries (no event sent)

**Privacy note:** The `estimate.reasoning` field from entries is NOT included - it may contain sensitive task details.

**Deduplication:** Uses `idempotencyKey` property. If the app crashes between sending and updating the watermark, the same day may be re-sent on next startup. PostHog should dedupe by `idempotencyKey`.

**See also:** [TIME_SAVED.md](./TIME_SAVED.md) for how time-saved estimation works.

---

### `Time Saved Estimated`

**Business Value:** Per-turn time-saved tracking — the per-call analogue of `Cost Incurred`, emitted once for every turn that produces a time-saved estimate. Closes the cost/time-saved asymmetry: `Daily Time Saved Summary` only carries day-level aggregates, so per-turn time-saved could not be cross-referenced or unified with `Cost Incurred` downstream. With this event, a unified per-user/per-turn cost + time-saved view across desktop and cloud is a single PostHog query.

**Source:** `src/core/services/timeSavedService.ts` → `triggerTimeSavedEstimation()` (right after `addTimeSavedEntry`).

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `turnId` | string | Agent turn ID |
| `sessionId` | string | Session ID for the turn |
| `lowMinutes` | number | Low estimate (minutes saved) |
| `highMinutes` | number | High estimate (minutes saved) |
| `taskType` | string | Categorical task type (research, writing, coordination, analysis, automation, mixed) |
| `confidence` | string | Estimate confidence level (low, medium, high) |
| `impact` | string? | Organizational impact level (trivial, low, medium, high, critical). Typed optional, but the live normalizer (`normalizeTimeSavedModelResponse` in `timeSavedService.ts`) defaults a missing impact to `'medium'`, so on the real path this dimension is **effectively always present**; the omit-when-absent guard is defensive only. |

**Trigger conditions:**
- Emitted once per turn, at the single shared `triggerTimeSavedEstimation` emit site (fire-and-forget).
- Skipped if the tracker is not available (pre-init or offline), or if the turn produced no estimate (gated/too-short/parse-failure turns emit nothing).
- **Gated on persisted store acceptance (one event per persisted turn):** the emit fires only when the store actually wrote the entry (`addTimeSavedEntry` returns `{ added: true }`). If the store rejects the write — a same-turn `duplicate`, or `read_only` protective mode — **no event is emitted**, so the analytics count never diverges from persisted turns or double-counts a retried turn.
- **Backfill does not emit this event:** the recovery path (`recoverTimeSavedEntryForTurn`, which replays missed prior-week turns via `addTimeSavedEntryAt`) intentionally does **not** fire `Time Saved Estimated`. Only the live forward path emits, so backfilling historical turns won't retroactively inflate the per-turn stream.
- **No double-counting across surfaces:** this is the only per-turn time-saved event. The turn fires it once on whichever surface executes it; mobile turns execute on cloud, so they are tagged `client_surface: 'cloud'` (via the context-provider merge) and are **explicitly excluded** from the mobile client's own events. Field choices mirror `Daily Time Saved Summary` so downstream can reconstruct the daily aggregate from the per-turn stream.

**Privacy note:** Categorical/metric properties only. The free-text `reasoning` / `reasoningDetail` fields from the estimate are NOT included — they may contain sensitive task details.

**See also:** `Daily Time Saved Summary` (aggregated daily version), `Cost Incurred` (the per-entry cost analogue), [TIME_SAVED.md](./TIME_SAVED.md).

---

### `Work Artifact Created`

**Business Value:** Count tangible, durable outputs created through Rebel for company dashboard value reporting. This is intentionally metadata-only so dashboards can report output volume without storing user content.

**Status:** Legacy compatibility event. New dashboard integrations should use `Work Output Created`; Rebel continues to emit this alias during rollout.

**Source:** `src/main/tracking.ts`, `src/main/services/agentMessageHandler.ts`, `src/main/ipc/libraryHandlers.ts`, `src/main/services/skillChangeNotificationService.ts`, `src/renderer/src/tracking.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `artifactType` | string | `draft`, `brief`, `report`, `doc`, `presentation`, `spreadsheet`, `automation`, `shared_output`, `file`, or `skill` |
| `source` | string | Creation surface/source, e.g. `agent_tool`, `library_create_file`, `library_write_file`, `automation_builder`, `shared_skill_write` |
| `shared` | boolean | Whether the output is shared/company-facing |
| `sessionId` | string? | Hashed session ID when tied to a conversation |
| `turnId` | string? | Agent turn ID when tied to a turn |
| `automationId` | string? | Automation ID when tied to an automation |
| `fileExtension` | string? | File extension only, never the file name/path |

**Privacy:** Does not include titles, file names, paths, or generated content.

**Exclusions:** Memory files, internal `.rebel` files, transient chat, and arbitrary non-deliverable files do not count as work outputs.

---

### `Work Output Created`

**Business Value:** Canonical output event for the company value dashboard. Counts durable outputs that can be reviewed, reused, sent, exported, or operationalized outside the transient chat turn.

**Source:** `src/main/tracking.ts`, `src/main/services/agentMessageHandler.ts`, `src/main/ipc/libraryHandlers.ts`, `src/main/services/skillChangeNotificationService.ts`, `src/renderer/src/tracking.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `output_id` | string | Stable hashed identifier for the output. Never a raw file path or content string. |
| `output_type` | string | Canonical dashboard category: `document`, `presentation`, `spreadsheet`, `automation`, or `skill` depending on the source surface |
| `output_format` | string | File extension or logical format, e.g. `md`, `html`, `pdf`, `csv`, `pptx`, `automation`, `skill` |
| `source_surface` | string | Creation surface/source, e.g. `agent_tool`, `library_create_file`, `automation_builder`, `shared_skill_write` |
| `shared` | boolean | Whether the output is shared/company-facing |
| `sessionId` | string? | Hashed session ID when tied to a conversation |
| `turnId` | string? | Agent turn ID when tied to a turn |

**Account attribution:** Enriched with the standard account fields when known (`company_id`, `company_name`, `account_id`, `account_name`, slugs, and attribution source).

**Privacy:** Metadata only. Do not include content, prompts, titles, file names, or raw paths.

**Exclusions:** Memory/context maintenance is diagnostic only (`memoryFilesModified`) and must not emit `Work Output Created`. Generic code/config writes and internal `.rebel` files are also excluded unless a future product contract explicitly classifies them as reusable user-facing outputs.

---

### `Skill Created`

**Business Value:** Track creation of reusable Rebel skills/workflows separately from ongoing skill edits.

**Source:** `src/main/services/skillChangeNotificationService.ts`, `src/main/tracking.ts`, `src/renderer/src/tracking.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `skillId` | string | Workspace-relative skill identifier/path |
| `skillScope` | string | `private` or `shared` |
| `source` | string | Creation source, e.g. `shared_skill_write` |
| `creatorId` | string? | Stable creator identifier when available, or `rebel` for agent-created writes without a human context |

**Related events:** `skill_modified`, `skill_forked`, `skill_restored`, shared skill usage events.

When a skill is created, Rebel also emits `Work Output Created` with `output_type: "skill"` so account dashboards can show both the skill-specific lifecycle metric and the aggregate output metric.

---

### `Impact Story Eligible` / `Impact Story Submitted` / `Impact Story Approved` / `Impact Story Dismissed`

**Business Value:** Capture approved qualitative proof that Rebel changed work, linked to a company for dashboard/customer reporting.

**Source:** `src/main/ipc/communityHandlers.ts`, `src/renderer/src/tracking.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `storyId` | string | Stable story identifier |
| `workflowType` | string? | Workflow category |
| `impactType` | string? | Impact category |
| `approvalStatus` | string | `pending` or `approved` |
| `sourceSessionId` | string? | Hashed source session ID |
| `approvedBy` | string? | Approver identifier when available |
| `approvedAt` | number? | Approval timestamp in epoch milliseconds |
| `timeSavedMinutes` | number? | Eligibility-stage time saved estimate |

**Privacy:** Store story text/examples in the approved customer-proof system; analytics carries only metadata.

---

### `Auto-Update Skipped`

**Business Value:** Track update failures, particularly Windows Squirrel path encoding issues.

**Source:** `src/main/services/autoUpdateService.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `reason` | string | Why update was skipped (e.g., `squirrel_path_error`) |
| `platform` | string | OS |
| `arch` | string | Architecture |

---

## Renderer Events - Lifecycle

### `Renderer Boot`

**Business Value:** Confirm renderer process started, track routing.

**Source:** `src/renderer/main.tsx`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `path` | string | Initial route path |
| `hash` | string | URL hash if any |

**Gotchas:** Direct analytics call (not via tracking.ts) to minimize boot dependencies.

---

## Renderer Events - Onboarding

### `Onboarding Started`

**Business Value:** Track onboarding funnel entry.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `isRelaunch` | boolean | Whether user is redoing onboarding |

---

### `Onboarding Step Viewed` / `Onboarding Step Completed` / `Onboarding Step Error`

**Business Value:** Funnel analysis - identify where users get stuck or drop off.

**Properties (Viewed):**
| Property | Type | Description |
|----------|------|-------------|
| `step` | string | Step name (e.g., `welcome`, `api`, `workspace`) |
| `stepIndex` | number | Position in sequence |
| `isBackNavigation` | boolean | User went back |

**Properties (Completed):**
| Property | Type | Description |
|----------|------|-------------|
| `step` | string | Step name |
| `durationOnStepMs` | number | Time spent on step |
| `usedDefaults` | boolean | Whether defaults were accepted |

**Properties (Error):**
| Property | Type | Description |
|----------|------|-------------|
| `step` | string | Step name |
| `errorType` | string | Error classification |
| `errorField` | string? | Specific field that errored |

---

### `Onboarding Completed`

**Business Value:** Critical conversion metric - user finished setup.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `totalDurationMs` | number | Total time in onboarding |
| `stepsCompleted` | string[] | Steps that were completed |

**Side Effects:** Also persists onboarding milestone to localStorage.

---

### `Onboarding Abandoned`

**Business Value:** Identify where users quit without completing.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `lastStep` | string | Final step reached |
| `stepReached` | number | How far they got |
| `timeSpentMs` | number? | Time spent before abandoning |

---

### `Onboarding Stage Entered`

**Business Value:** Track progression through the full onboarding funnel: wizard → coach → ui_reveal → tutorial → spark. Enables stage-level drop-off analysis.

**Source:** Various onboarding components

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `stage` | string | `wizard`, `coach`, `ui_reveal`, `tutorial`, or `spark` |

---

### `Onboarding Stage Completed`

**Business Value:** Measure per-stage completion rate and time-to-complete.

**Source:** Various onboarding components

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `stage` | string | `wizard`, `coach`, `ui_reveal`, `tutorial`, or `spark` |
| `durationSeconds` | number | Time spent in this stage |

---

### `Onboarding Stage Abandoned`

**Business Value:** Capture exactly where users drop off in the onboarding funnel.

**Source:** Various onboarding components

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `stage` | string | `wizard`, `coach`, `ui_reveal`, `tutorial`, or `spark` |
| `timeSpentSeconds` | number | Time spent before abandoning |

---

### `Onboarding Checklist Step Started` (enhanced)

**Business Value:** Track individual tutorial checklist step engagement with semantic names.

**Source:** `src/renderer/src/tracking.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `step` | number | Step ID (1-4) |
| `stepName` | string | Semantic name: `connector`, `skill`, `memory`, or `use_case` |
| `sessionId` | string? | Hashed session ID for this step |

---

### `Onboarding Checklist Step Completed` (enhanced)

**Business Value:** Track which tutorial steps get finished and how long they take.

**Source:** `src/renderer/src/tracking.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `step` | number | Step ID (1-4) |
| `stepName` | string | Semantic name: `connector`, `skill`, `memory`, or `use_case` |
| `sessionId` | string? | Hashed session ID for this step |
| `durationSeconds` | number? | Time from step start to completion |

---

### `First Real Task Attempted`

**Business Value:** Track first non-tutorial task to measure activation. Includes connector usage for understanding early integration adoption.

**Source:** `src/renderer/features/agent-session/store/effects/analyticsTracker.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `taskType` | string | `integration_task` (used MCP tools) or `general_task` |
| `connectorsUsed` | string[] | MCP servers used (e.g., `gmail`, `slack`) |
| `connectorCount` | number | Number of connectors used |
| `success` | boolean | Whether the task completed successfully |

**Conditions:** Only fires once per user, within 7 days of onboarding completion.

---

### `Cost Warning Shown`

**Business Value:** Track cost anxiety indicators - how often users encounter cost warnings.

**Source:** `src/renderer/src/tracking.ts` (stub - UI not yet implemented)

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `currentCostUsd` | number | Current accumulated cost |
| `thresholdUsd` | number | Warning threshold that was crossed |

**Note:** Tracking function defined but not yet wired to UI (cost warning feature pending).

---

### `Cost Limit Set`

**Business Value:** Track users proactively managing cost exposure.

**Source:** `src/renderer/src/tracking.ts` (stub - UI not yet implemented)

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `limitUsd` | number | Cost limit set by user |
| `previousLimitUsd` | number? | Previous limit (if changing) |

**Note:** Tracking function defined but not yet wired to UI (cost limit feature pending).

---

### `Privacy Indicator Viewed`

**Business Value:** Track engagement with privacy UI elements - measures user awareness of data privacy.

**Source:** `src/renderer/components/ui/PrivacyIndicator.tsx`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `privacyLevel` | string | `private` or `shared` |
| `source` | string | Where the indicator was shown (e.g., `library_editor`, `file_tree`) |

**Conditions:** Fires once per component mount on first mouse hover (not on every render).

---

### `Onboarding Escape Hatch Triggered/Confirmed/Cancelled`

**Business Value:** Track users who want to skip onboarding, understand friction points.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `step` | string | Current step when triggered |
| `stepIndex` | number | Position |
| `timeSpentMs` | number | Time before escape |
| `completedSteps` | string[]? | (Confirmed only) Steps done |

---

### `Claude API Key Entered` / `Voice Provider Selected` / `Voice API Key Entered`

**Business Value:** Track API configuration success.

---

### `Workspace Directory Selected`

**Business Value:** Track library/workspace setup preferences.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `isDefault` | boolean | Used default location |
| `isCustomPath` | boolean | Custom path chosen |

---

### `EULA Accepted` / `EULA Declined`

**Business Value:** Legal compliance tracking.

---

### `MCP Config Discovered` / `MCP Config Selected`

**Business Value:** Track MCP adoption and migration paths.

**Properties (Discovered):**
| Property | Type | Description |
|----------|------|-------------|
| `configCount` | number | Number of configs found |

**Properties (Selected):**
| Property | Type | Description |
|----------|------|-------------|
| `source` | string | Where config came from |
| `serverCount` | number | Servers in config |

---

### `Tool Auth Link Generated/Verified/Error/Clicked`

**Business Value:** Track tool authentication success rates.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `tool` | string | `email`, `calendar`, or `chat` |
| `isAuthenticated` | boolean? | (Verified only) Success status |
| `error` | string? | (Error only) Error message |

---

### `Microphone Permission Requested/Granted/Denied`

**Business Value:** Track voice feature adoption blockers.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `attemptNumber` | number | Which attempt this is |

---

### `File Access Requested/Granted/Denied`

**Business Value:** Track file system permission issues.

---

### `First Action After Onboarding`

**Business Value:** Understand what users do first - informs onboarding optimization.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `action` | string | First action type |
| `timeAfterOnboardingMs` | number | Time from onboarding to action |

---

### `Enterprise Config Screen Viewed/Skipped/Paste Attempted/Validation Failed/Applied`

**Business Value:** Track enterprise deployment success.

---

## Renderer Events - Chat/Agent

### `Chat Session Created`

**Business Value:** Track conversation starts, distinguish manual vs automation.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `sessionId` | string | Hashed session ID |
| `origin` | string | `manual` or `automation` |
| `isFirstSession` | boolean | First-ever session for user |

**Gotchas:** Session ID is hashed for privacy.

---

### `Chat Session Resumed` / `Chat Session Resolved` / `Chat Session Deleted`

**Business Value:** Track session lifecycle and engagement depth.

**Properties vary by event type.**

---

### `Chat Message Sent`

**Business Value:** Core engagement metric - user talking to agent.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `source` | string | `text` or `voice` |
| `sessionId` | string | Hashed session ID |
| `hasAttachments` | boolean | Files attached |
| `attachmentCount` | number | Number of files |
| `isEdit` | boolean | Editing previous message |
| `charCount` | number | Message length |

---

### `Agent Turn Completed`

**Business Value:** Critical - tracks agent performance, cost, tool usage, and multi-model spend.

**Source:** `src/renderer/src/tracking.ts` → `trackAgentTurnCompleted()`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `turnId` | string | Turn identifier |
| `sessionId` | string | Hashed session ID (privacy) |
| `durationMs` | number | Turn execution time |
| `model` | string? | Model identifier (may be composite for multi-model turns) |
| `authMethod` | string? | `api-key`, `oauth-token`, or `unknown` |
| `inputTokens` | number? | Input tokens consumed |
| `outputTokens` | number? | Output tokens generated |
| `cacheReadTokens` | number? | Cache read tokens |
| `cacheCreationTokens` | number? | Cache creation tokens |
| `costUsd` | number? | Estimated USD cost |
| `totalPromptTokens` | number | `inputTokens + cacheReadTokens + cacheCreationTokens` |
| `cacheHitRatio` | number | 0-1, `cacheReadTokens / totalPromptTokens` |
| `pricingKnown` | boolean | Whether pricing table had rates for this model |
| `pricingModelResolved` | string\|null | Model used for pricing lookup (`null` for multi-model) |
| `pricingInputUsdPerMTok` | number\|null | Input price per million tokens |
| `pricingOutputUsdPerMTok` | number\|null | Output price per million tokens |
| `pricingCacheReadUsdPerMTok` | number\|null | Cache read price per million tokens |
| `pricingCacheCreationUsdPerMTok` | number\|null | Cache creation price per million tokens |
| `primaryModel` | string? | (Multi-model only) Most expensive model by estimated cost |
| `modelCount` | number? | (Multi-model only) Number of distinct models |
| `modelBreakdownJson` | string? | (Multi-model only) JSON per-model usage map |
| `totalToolCalls` | number? | Total tool invocations |
| `failedToolCalls` | number? | Failed tool invocations |
| `filesCreated` | number? | Files created during turn |
| `filesEdited` | number? | Files edited during turn |
| `workArtifactsCreated` | number? | Created durable output count derived from successful file-create tools; excludes memory/internal/non-deliverable writes |
| `workArtifactsCreatedByType` | object? | Artifact count by type (`draft`, `brief`, `report`, `doc`, `presentation`, `spreadsheet`, `skill`) |
| `toolCalls_*` | number? | Per-category tool counts (filesystem, shell, network, etc.) |
| `mcp_*` | number? | Per-MCP-server call counts (gmail, slack, notion, etc.) |
| `mcp_total` | number? | Sum of all MCP server calls |
| `mcp_servers_used` | string[]? | MCP servers used this turn |
| `subAgentTotalInputTokens` | number? | Combined sub-agent input tokens |
| `subAgentTotalOutputTokens` | number? | Combined sub-agent output tokens |
| `finalWordCount` | number? | Word count for final assistant chat-bubble text; content-free output-shape telemetry |
| `finalHeadingCount` | number? | Markdown heading count in final chat text, excluding fenced code blocks |
| `finalBulletCount` | number? | Bullet-list item count in final chat text, excluding fenced code blocks |
| `finalNumberedListCount` | number? | Numbered-list item count in final chat text, excluding fenced code blocks |
| `finalCodeBlockCount` | number? | Fenced code-block count in final chat text |
| `finalTableLineCount` | number? | Markdown table-like line count in final chat text |
| `finalLinkCount` | number? | Markdown link + bare URL count in final chat text |
| `finalHasSourceSection` | boolean? | Whether the final chat text contains a source/reference/citation section heading |
| `finalShapeBucket` | string? | Coarse output shape: `empty`, `short_answer`, `chat_response`, `structured_response`, or `report_in_chat` |

**Gotchas:**
- Tool metrics are flattened with `toolCalls_` and `mcp_` prefixes for PostHog queryability (not nested objects).
- Multi-model properties (`primaryModel`, `modelCount`, `modelBreakdownJson`) only present when `modelCount >= 2`.
- Sub-agent partial cost is now bubbled on all paths including abort (fixed — see Known Issues #7).
- Final output-shape fields are counts/booleans only. They must never include raw response text, extracted headings, quote text, source names, or file paths.

---

### `Agent Turn Error` / `Agent Turn Interrupted`

**Business Value:** Track failure modes and user interruptions.

---

### `Message Edit Started/Cancelled/Submitted`

**Business Value:** Track edit feature usage.

---

### `Attachment Added` / `File Mentioned`

**Business Value:** Track context-providing behaviors.

---

## Renderer Events - Tools/MCP

### `Custom MCP Connected` / `Custom MCP Connection Failed` / `Custom MCP Disconnected`

**Business Value:** Track custom MCP server adoption and reliability (manual JSON config).

**Note:** These events track the rare case of users manually configuring custom MCP servers via JSON. For the main connector UI flow (95%+ of connections), see `Connector *` events below.

**Properties (Connected):**
| Property | Type | Description |
|----------|------|-------------|
| `serverName` | string | MCP server name |
| `transport` | string | Connection type (stdio/http/sse) |
| `configType` | string | `managed` or `custom` |
| `isBuiltIn` | boolean | Built-in vs third-party |

**Properties (Connection Failed):**
| Property | Type | Description |
|----------|------|-------------|
| `serverName` | string | MCP server name |
| `transport` | string | Connection type |
| `errorCode` | string | Error code (e.g., `UPSERT_FAILED`, `ADD_FAILED`) |
| `errorType` | string | Error classification |

---

### `Connector Connect Started` / `Connector Connected` / `Connector Connection Failed` / `Connector Disconnected`

**Business Value:** Track connector adoption and reliability via the UI connector cards (UnifiedConnectionsPanel).

**Note:** These are distinct from `Tool Connected/Failed/Disconnected` which track custom MCP server configuration. The `Connector *` events track the main connector UI flow where 95%+ of users connect tools.

**Properties (Connected):**
| Property | Type | Description |
|----------|------|-------------|
| `connectorName` | string | Display name of connector (e.g., "Gmail", "Slack") |
| `category` | string | Connector category (e.g., "email", "calendar", "chat") |
| `method` | string | `oauth`, `api_key`, `rebel_assist`, or `manual` |

**Properties (Connection Failed):**
| Property | Type | Description |
|----------|------|-------------|
| `connectorName` | string | Display name of connector |
| `category` | string | Connector category |
| `errorType` | string | Error classification (e.g., `bundled_setup_failed`, `oauth_failed`) |
| `errorMessage` | string? | Optional error message |

**Properties (Disconnected):**
| Property | Type | Description |
|----------|------|-------------|
| `connectorName` | string | Display name of connector |
| `wasActive` | boolean | Whether connector was actively working before disconnect |

---

### `Inbox Connected` (formerly Task Queue Connected)

**Business Value:** Track inbox tool adoption.

**Gotchas:** Legacy name `taskQueueConnected` still exists as alias.

---

### `MCP Summary Loaded` / `MCP Config Error`

**Business Value:** Track MCP initialization success.

---

## Renderer Events - Automations

### `Automation Created/Updated/Deleted/Enabled/Disabled`

**Business Value:** Track automation adoption and lifecycle.

---

### `Automation Run Started/Completed/Failed`

**Business Value:** Track automation execution and success rates.

---

## Renderer Events - Voice

### `Voice Recording Started/Stopped/Cancelled`

**Business Value:** Track voice feature usage.

---

### `Voice Transcription Completed/Error`

**Business Value:** Track transcription success and latency.

**Properties (Completed):**
| Property | Type | Description |
|----------|------|-------------|
| `latencyMs` | number | Time from request to transcription result |
| `wordCount` | number | Transcribed words |
| `provider` | string | Transcription provider |
| `audioLengthMs` | number | Audio duration (if known) |
| `costUsd` | number | Provider-reported transcription cost (if available) |
| `model` | string | Provider model identifier used for transcription |
| `source` | string | Provider family (`openai`, `elevenlabs`, `local`) |
| `inputSizeBytes` | number | Audio payload size (bytes) |

**Properties (Error):**
| Property | Type | Description |
|----------|------|-------------|
| `errorType` | string | Error category (e.g., `api_error`, `empty_result`) |
| `errorCode` | string | Provider/system error code |
| `provider` | string | Transcription provider |
| `audioLengthMs` | number | Audio duration for the failed request |

---

### `Voice Mode Activated/Deactivated`

**Business Value:** Track voice mode engagement.

---

### `TTS Playback Started/Completed/Error/Interrupted`

**Business Value:** Track text-to-speech usage.

---

## Renderer Events - Inbox

### `Inbox Item Added/Executed/Execution Completed/Execution Error/Deleted`

**Business Value:** Track inbox feature adoption and success.

**Gotchas:** Legacy `taskQueue.*` wrappers still exist as aliases.

---

## Renderer Events - Settings

### `Settings Opened/Saved/Tab Switched`

**Business Value:** Track settings engagement.

**`Settings Opened.source`:** `nav_click` | `link` | `keyboard` | `auto` | `deep_link`. Resolved at `openSettingsDialog()` ingress (e.g. unified navigation uses `deep_link`; bare re-opens from surface sync use `auto`).

---

### `Settings Destination Switched`

**Business Value:** Tracks IA redesign top-level destination changes (sidebar/search/deep link/programmatic), separate from canonical leaf changes.

**Payload:** `destination` (`agent_voice` | `connectors` | `meetings` | `workspace` | `account_preferences` | `usage` | `advanced`), `interactionType`, `leafTab`, optional `section`, optional `redirectedFrom`.

**Does not fire** when only the leaf changes inside the same destination (e.g. Agent & Voice pill switches remain on `Settings Tab Switched` only).

---

### `Workspace Directory Changed` / `Model Changed` / `Permission Mode Changed`

**Business Value:** Track configuration changes.

---

### `Tool Permission Level Changed` / `Memory Permission Level Changed`

**Business Value:** Track trust/safety preference changes.

---

### `Privacy Mode Toggled`

**Business Value:** Track privacy feature adoption.

---

### `Connector Viewed/Connect Started/Connected/Disconnected`

**Business Value:** Track tool integration adoption.

---

### `Space Added/Renamed/Deleted`

**Business Value:** Track memory space usage.

---

## Renderer Events - Library

### `Library Opened` / `Library File Opened` / `Library File Saved`

**Business Value:** Track library/file engagement.

---

### `Library Exported`

**Business Value:** Track export feature usage.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `format` | string | `pdf` or `docx` |
| `success` | boolean | Export succeeded |

---

### `Library Lens Changed`

**Business Value:** Track how users navigate the unified Library lens (Filter × View) so we can validate the View×Filter unification, see which combinations users prefer, and detect cohorts who never leave the default lens.

**Source:** `src/renderer/src/tracking.ts` (replaces legacy `Library Tab Switched` and `Library Search Scope Changed` events emitted by the previous scope-tab UI).

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `filter` | string | Active filter dimension: `spaces` \| `skills` \| `memory` \| `everything` |
| `view` | string | Active view dimension: `folders` \| `list` \| `cards` \| `atlas` |
| `axis` | string | Which axis changed in the transition: `filter` \| `view` \| `both` (where `both` captures single actions that update both dimensions, e.g. shortcut-driven lens jumps) |

**Gotchas:** Emitted from the unified `useLibraryLens` setter path so one UI or programmatic transition emits one event, even if multiple React state updates occur internally.

---

## Renderer Events - Atlas

### `Atlas Viewed`

**Business Value:** Measures Atlas adoption and rough workspace graph size when users actually view the visualization.

**Source:** `src/renderer/src/tracking.ts` (event definition), plus active Atlas view emitters where present.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `nodeCount` | number | Number of Atlas nodes rendered when the view is first shown |

**Gotchas:** Should fire once per Atlas-view mount after nodes are available and the Library surface is visible.

---

### `Atlas File Opened`

**Business Value:** Tracks which file types users open from the Atlas graph via the tooltip "Open" action.

**Source:** `src/renderer/features/atlas/components/AtlasCanvas.tsx`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `fileExtension` | string | Lowercased file extension only (no path) |

**Gotchas:** Fired from the tooltip "Open" action. Full file paths are intentionally excluded for privacy.

---

### `Atlas Conversation Started`

**Business Value:** Measures whether Atlas helps users pivot from exploration into an attached-file conversation.

**Source:** `src/renderer/features/atlas/components/AtlasCanvas.tsx`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `fileCount` | number | Unique files included when the Atlas conversation starts |

**Gotchas:** Count includes the selected node plus any currently loaded neighbors attached to the conversation.

---

### `Atlas Search Used`

**Business Value:** Shows whether users are using Atlas search and how much content matches each query.

**Source:** `src/renderer/src/tracking.ts` (event definition), plus active Atlas view emitters where present.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `resultCount` | number | Number of Atlas matches returned for the settled query |

**Gotchas:** Fires once per distinct non-empty query while Atlas is visible, after the debounced search settles.

---

### `Atlas Space Isolated`

**Business Value:** Measures use of the Atlas space-filtering affordance to inspect a single space in isolation.

**Source:** `src/renderer/src/tracking.ts` (event definition), plus active Atlas view emitters where present.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `spaceName` | string | Display name of the isolated space |

**Gotchas:** Only fires when a non-null isolated space is selected; clearing the filter does not emit an event.

---

## Renderer Events - Mind Map

### `Mind Map Rendered`

**Business Value:** Measures mind map canvas usage and rough complexity of the rendered map.

**Source:** `src/renderer/features/canvas/components/MindMapCanvas.tsx`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `nodeCount` | number | Total nodes in the initialized mind map tree |

**Gotchas:** Fires when `MindMapCanvas` initializes successfully. Today that source is the composer mind-map canvas.

---

## Renderer Events - Spark/Use Cases

### `Spark Opened` / `Spark Tab Switched`

**Business Value:** Track Spark panel engagement.

---

### `Use Case Selected` / `Use Cases Generated`

**Business Value:** Track use case discovery feature.

---

### `Skill Used`

**Business Value:** Track skill/workflow usage.

---

### `Coaching Insight Viewed/Acted/Dismissed`

**Business Value:** Track coaching feature engagement.

---

### `Community Highlight Clicked` / `Meeting Prep Clicked From Spark` / `Help Topic Clicked`

**Business Value:** Track content discovery.

---

## Renderer Events - Tutorials

### `Tutorials Modal Opened/Closed`

**Business Value:** Track tutorial engagement.

---

### `Tutorial Video Started/Completed`

**Business Value:** Track video completion rates.

---

### `Learning Path Expanded/Completed`

**Business Value:** Track learning progression.

---

### `Tutorial Whisper Shown/Clicked`

**Business Value:** Track contextual tutorial prompts.

---

## Renderer Events - Meeting Bot

### `Meeting Bot Prompt Shown/Send Clicked/Send Result/Skipped/Dismissed`

**Business Value:** Track meeting bot adoption and success.

---

### `Meeting Bot Recording Stopped` / `Meeting Transcript Ready`

**Business Value:** Track recording completion.

---

### `Meeting Prep Clicked`

**Business Value:** Track meeting prep feature usage.

---

## Renderer Events - Navigation

### `Navigation Tab Clicked`

**Business Value:** Track UI navigation patterns.

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `tab` | string | Target tab |
| `previousTab` | string? | Where user came from |

---

### `New Chat Button Clicked` / `Quick Open Opened` / `Help Menu Opened`

**Business Value:** Track feature discovery.

---

### `Conversation Starred/Unstarred/Marked Done/Activated`

**Business Value:** Track conversation management.

**Note (2026-06, "done-state rename"):** `Conversation Favorited`/`Conversation Unfavorited` were renamed to `Conversation Starred`/`Conversation Unstarred`. Separately, the `Sidebar Filter Changed` event's `filter`/`previousFilter` property now emits `'done'` instead of `'archived'` for the finished-conversations tab — dashboards filtering on the old `'archived'` value need updating.

---

## Renderer Events - NPS Survey

### `NPS Survey Shown` / `NPS Survey Dismissed` / `NPS Survey Submitted`

**Business Value:** Track Net Promoter Score collection.

**Source:** `src/renderer/features/nps/useNpsSurvey.ts` (direct analytics calls)

**Properties (Submitted):**
| Property | Type | Description |
|----------|------|-------------|
| `score` | number | NPS score (0-10) |
| `promoterType` | string | `promoter`, `passive`, or `detractor` |
| `feedbackLength` | number | Optional feedback length |

**Related dashboard event:** `NPS Survey Submitted` also emits `Customer Feedback Submitted` with `feedbackType: 'nps'` so external dashboards can query NPS alongside future CSAT/value check-ins through one event family.

---

### `Customer Feedback Submitted`

**Business Value:** Lightweight customer sentiment/value signal for external company dashboards, separate from raw usage.

**Source:** `src/renderer/src/tracking.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `feedbackType` | string | `nps`, `csat`, `value_checkin`, or `sentiment` |
| `score` | number? | Numeric score when applicable |
| `sentiment` | string? | Sentiment/promoter bucket |
| `surface` | string | UI surface that captured feedback |
| `feedbackLength` | number? | Length only; raw feedback text is not sent |

---

## Renderer Events - Approvals

### `Tool Approval Prompt Shown` / `Tool Approval Decision`

**Business Value:** Track trust/approval UX.

---

### `Memory Approval Prompt Shown` / `Memory Approval Decision`

**Business Value:** Track memory write approval flow.

---

### Approval Card Viewed / Approval View Conversation Clicked (Phase 1)

These two events document approval decision-signal facets. Properties include `hasContentPreview: boolean`, `hasWithheldPreview: boolean` (added 2026-04-22), `hasWhyFacets: boolean`, and `thinFacets: boolean`; see `src/renderer/src/tracking.ts` (around line 1320) for the authoritative TypeScript schema.

Semantics note (2026-05-31, compact approval-card redesign Stage 5): `hasContentPreview`, `hasWithheldPreview`, and `thinFacets` now represent **data availability** for those signals, not whether specific inline preview/withheld UI is rendered on-card. Inline preview/withheld rows were removed from the card, but the facet fields remain for segmentation continuity.

Full Phase 1 event-schema documentation is deferred to the forthcoming R5 analytics enrichment bundle; for the initial landing, see commit `07a10f7ed`. The `hasWithheldPreview` field was added to fix analytics pollution on withheld memory approvals (2026-04-22).

---

### Approval Preview Content Clicked

Tracks deliberate preview opens from approval flows.

Semantics note (2026-05-31, compact approval-card redesign Stage 5): this event now fires only from the **Review** path (`previewSource: 'dialog'`). Previous card-level preview entry points (file-row affordance and "Preview content" link) were removed.

---

### `skill_nudge_shown` / `skill_nudge_confirmed` / `skill_nudge_declined`

**Business Value:** Track whether non-author shared-skill protection is being seen and how often users proceed versus back away.

**Source:** `src/renderer/features/agent-session/hooks/useMemoryApproval.ts`, `src/renderer/features/document-editor/hooks/useDocumentFileIO.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `skill_id` | string | Shared skill identifier/path |
| `surface` | string | Where the nudge appeared: `chat_checkpoint` or `direct_editor` |

**Gotchas:** Direct-editor flows currently emit `shown` and `confirmed`; declines are only tracked where the UX exposes an explicit decline action.

---

### `skill_notification_viewed` / `skill_notification_dismissed`

**Business Value:** Measure whether shared-skill notifications are useful enough to drive review, or mostly get ignored.

**Source:** `src/renderer/features/inbox/components/NotificationDrawer.tsx`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `skill_id` | string | Workspace-relative skill path |
| `recipient_reason` | string | Why this user received it: `previous_editor` or `creator_fallback` |

---

## Diagnostics Events

### `RudderStack Config Check`

**Business Value:** Internal - verify analytics connectivity.

**Source:** `src/main/analytics.ts`

**Properties:**
| Property | Type | Description |
|----------|------|-------------|
| `source` | string | `main-process` |
| `category` | string | `diagnostics` |
| `retryAttempt` | number | Which retry attempt |

---

## Identity/Traits

Users are identified by anonymous ID (generated once, persisted). Optional email linking occurs when user authenticates.

**Company/account attribution:** Main-process and renderer events are enriched where possible with dashboard-friendly attribution fields. Today Rebel can populate `companyName` from app settings or auth config and derives stable pseudonymous ids/slugs from account names. CamelCase fields remain for existing analysis, and snake_case fields are emitted for Platform account dashboards. Attribution is not inferred from personal email.

**Standard Traits:**
| Trait | Type | Description |
|-------|------|-------------|
| `appVersion` | string | Current app version |
| `buildChannel` | string | Release channel |
| `platform` | string | Operating system |
| `arch` | string | CPU architecture |
| `voiceProvider` | string? | Selected voice provider |
| `permissionMode` | string | Trust level setting |
| `mcpMode` | string | MCP mode (none/super/etc) |
| `hasWorkspace` | boolean | Workspace configured |
| `hasMcpConfig` | boolean | Has MCP configuration |
| `opusPlanMode` | boolean | Extended planning enabled |
| `extendedContext` | boolean | Extended context enabled |
| `onboardingCompleted` | boolean | Finished onboarding |
| `onboardingFirstCompletedAt` | string? | ISO timestamp |
| `email` | string? | User email if identified |
| `companyId` | string? | Stable hash derived from `companyName` |
| `companyName` | string? | Company name from onboarding/settings |
| `accountId` | string? | Reserved account/org identifier from platform source |
| `accountName` | string? | Reserved account/org display name from platform source |
| `accountAttributionSource` | string? | Source of attribution, e.g. `settings.companyName` or `authConfig.companyDisplayName` |
| `company_id` | string? | Platform-compatible stable company id |
| `company_name` | string? | Platform-compatible company name |
| `company_slug` | string? | Platform-compatible company slug |
| `account_id` | string? | Platform-compatible stable account id |
| `account_name` | string? | Platform-compatible account name |
| `account_slug` | string? | Platform-compatible account slug |
| `account_attribution_source` | string? | Platform-compatible attribution source |
| `licenseTier` | string? | Current license tier when known |

---

## Global Event Properties (context-provider merge)

These attach to **every** `track()` event on a Node surface via the analytics context provider (`setAnalyticsContextProvider`), merged in by `trackMainEvent` (`src/main/analytics.ts`). Per-event `properties` win on key conflict.

| Property | Type | Description |
|----------|------|-------------|
| `client_surface` | string | The client surface that emitted the event: `desktop` (`src/main/index.ts`), `cloud` (`cloud-service/src/bootstrap.ts`, also covers mobile-driven turns, which execute on cloud), or `mobile` (the mobile RN client — `mobile/src/analytics/analytics.ts`). All three client surfaces share this one key, so cross-surface grouping/filtering of all events (cost, time-saved, etc.) is a single `GROUP BY client_surface`. **Distinct from the per-event `surface` property**, which is unrelated and carries values like `chat_checkpoint` / `nps_survey` — `client_surface` was chosen as a non-colliding key precisely to avoid overwriting those. The separate Sentry `setTag('surface', 'cloud')` is a different (error-monitoring) namespace and is independent. **Also distinct from the cloud `identify` person-trait `surface: 'cloud'`** (`cloud-service/src/bootstrap.ts` ~770, `REBEL_SURFACE ?? 'cloud'`): that lives in the **person-properties namespace** (set via `identify`, not on events), so it does not collide with either the event `surface` property or `client_surface`. |

> Mobile note: the mobile RN client tags its own events with the **event-property** `client_surface: 'mobile'` (aligned with desktop/cloud as of 260615 — see Mobile Events below), while core cost/time-saved events for a mobile-driven session are emitted by the cloud instance and carry `client_surface: 'cloud'`. **Querying implication:** all three client surfaces now share `client_surface`, so an "all client-origin events" query is a single `client_surface IN ('desktop','cloud','mobile')` — no union over separate keys.

---

## Milestones

Milestones are single-fire events tracked via localStorage to avoid duplicates.

| Milestone | When Tracked |
|-----------|--------------|
| `first_message_sent` | First chat message |
| `first_tool_connected` | First MCP tool connection |
| `first_automation_created` | First automation setup |
| `first_voice_used` | First voice recording |
| `first_memory_saved` | First memory file saved |

---

## Event Naming Conventions

- **Pattern:** `Object Action` (e.g., `Chat Session Created`, `Tool Connected`)
- **Case:** Title Case with spaces for most product events
- **Exception:** Newer collaboration/infrastructure events may use snake_case when they are designed for direct analytics querying or parity with backend/domain event naming (for example `skill_modified`)
- **Tense:** Past tense for completed actions

---

## Privacy Considerations

1. **Session IDs are hashed** - 16-character SHA-256 prefix
2. **No PII by default** - Email only set with explicit user action
3. **File paths anonymized** - Only extensions and classification (memory/skill) tracked
4. **No message content** - Only metadata (char count, attachment count)

---

## Known Issues / Technical Debt

1. **`Application Opened` sent twice** - Once at immediate launch, once after init. Consider consolidating.
2. **`Application Quit` sent twice** - From gracefulShutdown and tracking.ts.
3. ~~**NPS events bypass tracking.ts**~~ — **Fixed.** NPS events are centralized through `src/renderer/src/tracking.ts` and also emit `Customer Feedback Submitted` for dashboard pulls.
4. **Legacy `taskQueue.*` wrappers** - Deprecated but still present; map to `inbox.*` events.
5. **`analytics:identify` not in typed IPC** - Manual IPC handler while other analytics channels are typed.
6. **No analytics in meeting-bot-worker or super-mcp** - Opportunity for additional instrumentation.
7. ~~**Sub-agent cost not bubbled on abort**~~ — **Fixed.** `executeAgentTool()` now calls `onSubAgentComplete` on all paths: success, timeout, non-abort errors, and abort. Partial sub-agent tokens consumed before the user hits Stop are now included in the parent turn's cost ledger entry. See `src/core/rebelCore/agentTool.ts` and `subAgentCostTracking.test.ts`.

---

## Mobile Events (React Native client)

> **Architecture fact (critical):** the mobile app's business logic executes on the user's **cloud instance**, whose tracker (`getTracker().track(...)` in `src/core/`) already emits the core/agent-lifecycle events for a mobile-driven session. To avoid **double-counting**, the mobile RN client emits ONLY **client/UI-origin** events that core does NOT emit. Mobile re-emits desktop **renderer-origin** events (where there is a mobile analogue) but NEVER core-origin ones.
>
> Source: `mobile/src/analytics/tracking.ts` (taxonomy) → `mobile/src/analytics/analytics.ts` (gated singleton, RudderStack RN). Every event carries `client_surface: 'mobile'` (aligned with desktop/cloud as of 260615) and is routed through the mobile redaction layer + privacy contract (`mobile/src/analytics/redaction.ts`, `PRIVACY_CONTRACT.md`). The SDK is IDFA-free (`autoCollectAdvertId:false`, `collectDeviceId:false`); lifecycle events are hand-emitted (`trackAppLifecycleEvents:false`).

| Event | Properties | Trigger | Client-origin verification |
|-------|-----------|---------|----------------------------|
| `App Opened` | `client_surface` | Cold start + each background→foreground (`_layout.tsx` mount effect + AppState `active`) | Mobile-only RN lifecycle; no core equivalent |
| `App Backgrounded` | `client_surface` | AppState `background`/`inactive` (also triggers analytics `flush()`) | Mobile-only RN lifecycle; no core equivalent |
| `Pair Started` | `method` (`scan`/`manual`), `client_surface` | User initiates pairing in `PairScreen` | Mobile-only device-pairing UI; `src/core/appBridge/*` only logs "Pair…" strings, never tracks |
| `Pair Succeeded` | `method`, `client_surface` | Pairing returns with no store error | Same as above |
| `Pair Failed` | `method`, `reason` (`auth`/`network`/`unknown`), `client_surface` | Pairing returns with a store error (coarse non-PII reason) | Same as above |
| `Unpaired` | `client_surface` | Real pair→unpair transition (`_layout.tsx` `isPaired` effect) | Mobile-only; no core equivalent |
| `Screen Viewed` | `name` (joined expo-router route segments — never params), `client_surface` | Route change (single router-level effect) | Renderer/UI navigation signal; core never tracks screen views |
| `Message Sent` | `source` (`text`/`voice`), `hasAttachments`, `online`, `client_surface` | Composer send tap (`conversation/[id].tsx` `handleSend`) | Desktop emits analogous `Chat Message Sent` from the **renderer** (`src/renderer/src/tracking.ts:426`), not core. Agent turn is excluded (server-side `Agent Turn Completed/Error`) |
| `Voice Recording Completed` | `durationMs`, `client_surface` | Recording stop tap of sufficient duration (`useMobileVoiceRecording.ts` `stopRecording`) | Desktop emits `Voice Recording Stopped` from the **renderer** (`tracking.ts:785`). The transcription RESULT (`STT Transcription Completed`) is a **core** emitter (`src/core/services/audioService.ts:1040`) → EXCLUDED |
| `Approval Resolved` | `resolution` (`approved`/`denied`), `allowForSession?`, `client_surface` | Approve/deny tap in the inbox approval sheet (`inbox.tsx`) | Renderer-side on desktop. The approved tool runs on cloud, emitted there → not mirrored |
| `Inbox Action Tapped` | `action` (`execute`/`archive`/`delete`/`restore`), `client_surface` | Inbox item action tap (`inbox.tsx`) | Desktop emits Inbox-* from the **renderer** (`tracking.ts:839+`); execution outcome runs on cloud → not mirrored |

**Identity:** `identify(email)` on pair (email = SDK userId, matching desktop), reset on unpair. Email is fetched ONCE from cloud settings (shared with the Sentry identify) and is never a track property. Graceful degradation: no email → anonymousId-only (the reconciled `rebel_client_id`), logged.

**Explicitly EXCLUDED from mobile** (emitted by `src/core/` on the cloud instance for a mobile-driven session — mirroring them would double-count): `Agent Turn Completed`/`Agent Turn Error`, tool execution, cost (`Daily Cost Summary`), memory (`Memory Update Turn Completed`), `STT Transcription Completed`, `Daily Time Saved Summary`, `Watchdog Self-Resolved`.
