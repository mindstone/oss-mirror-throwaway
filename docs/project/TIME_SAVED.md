---
description: "Time saved estimation architecture — auxiliary LLM prompt, trigger rules, storage, backfill repair, impact weighting"
last_updated: "2026-05-22"
---

# Time Saved Estimation

Rebel estimates how much time users save on each task by using an auxiliary LLM call (currently Sonnet via `modelRoles.auxiliary`) to analyze what was accomplished versus what manual effort would have been required.

## See Also

- `src/main/services/timeSavedService.ts` — Main estimation service, prompt construction, API call
- `src/main/services/timeSavedStore.ts` — Persistent storage, aggregation, milestones
- `src/core/services/timeSavedBackfillService.ts` — Repair backfill for missed estimates
- `rebel-system/skills/system/time-saved-estimation/SKILL.md` — **The estimation prompt template**
- `docs/plans/finished/251213_time_saved_feature.md` — Original design doc with UX rationale
- `src/renderer/features/homepage/HomepagePanel.tsx` — Header indicator (weekly total)
- `src/renderer/components/TimeSavedModal.tsx` — Dashboard modal
- `src/renderer/features/agent-session/components/TimeSavedSummary.tsx` — Inline display after turns
- [DATES_AND_TIMES.md](DATES_AND_TIMES.md) — **Local vs UTC date handling patterns** (timeSavedStore uses local dates)

---

## How It Works

### Trigger

Time saved estimation is triggered in `agentMessageHandler.ts` when a turn completes successfully (agent `result` message type). It runs as a fire-and-forget background process, same pattern as memory updates.

**Skip conditions:**
- Sessions with IDs starting with `memory-update-`, `use-case-discovery-`, or `cli-chat-`
- Turns under 30 seconds duration

### Input Data

The estimation receives:
| Field | Source | Description |
|-------|--------|-------------|
| `userPrompt` | Accumulated user messages | What the user asked for |
| `finalSummary` | SDK result text (truncated to 2000 chars) | What was delivered |
| `toolSummary` | Count of tool events | e.g., "15 tool calls" or "No tools used" |
| `durationSeconds` | Estimated from turn timing | How long Rebel took |

### Estimation Prompt

The prompt (in `timeSavedService.ts`) asks the model to estimate how long a human would take to do the same work manually, accounting for:
- Context-gathering and tool navigation time
- Reading, processing, synthesizing information
- Drafting and iteration cycles
- Realistic human pace with interruptions

**Calibration reference in prompt (for successful, valuable output):**
| Task Type | Low | High |
|-----------|-----|------|
| Quick lookup / fact check | 0 min | 1 min |
| Simple file search | 1 min | 3 min |
| Short email (no research) | 2 min | 5 min |
| Email with research | 10 min | 20 min |
| Basic meeting prep | 15 min | 30 min |
| Comprehensive meeting prep | 30 min | 60 min |
| Strategic analysis | 90 min | 180 min |

**For low-value outcomes:**
| Outcome Type | Low | High |
|--------------|-----|------|
| Partial/incomplete attempt | 0 min | 5 min |
| Brainstorming without deliverable | 0 min | 5 min |
| Exploratory research (no synthesis) | 0 min | 10 min |
| Wrong direction / needs redo | 0 min | 0 min |

### Structured Output

Uses Anthropic's structured outputs (`json_schema` format) to return:
```typescript
{
  estimate_minutes_low: number;
  estimate_minutes_high: number;
  confidence: 'low' | 'medium' | 'high';
  task_type: 'research' | 'writing' | 'coordination' | 'analysis' | 'automation' | 'mixed';
  reasoning: string;
  impact: 'trivial' | 'low' | 'medium' | 'high' | 'critical';
}
```

### Restoration and Repair Backfill (v0.4.41)

The structured ROI-hour estimate path is restored: time-saved calls again request the typed estimate shape above instead of relying on loose prose parsing. The BTS call site keeps the `timeSaved` cost category inline at the `callWithModelAuthAware()` invocation so the contract-test heuristic can verify attribution; do not hide that category behind a shared variable.

Missed historical estimates are repaired by `timeSavedBackfillService`. The backfill scans eligible completed sessions after the cutoff, skips sessions that already have a time-saved entry for the turn, and writes recovered entries through `addTimeSavedEntryAt()` so aggregates preserve the original turn timestamp rather than the repair time. This keeps daily, weekly, and monthly totals aligned with when the work happened.

---

## Impact Weighting

Time saved estimates are weighted by organizational impact. This prevents counting busywork that "saved time" but shouldn't have been done, and ensures high-impact quick wins are properly valued.

### Impact Levels and Multipliers

| Level | Multiplier | Criteria |
|-------|------------|----------|
| `critical` | 1.5x | Strategic, high-stakes, unlocks others' work |
| `high` | 1.25x | Important deliverable, external-facing |
| `medium` | 1.0x | Standard work task (**baseline**) |
| `low` | 0.5x | Nice-to-have, no deadline |
| `trivial` | 0x | Shouldn't have been done |
| `unknown` | 1.0x | Migrated entries (preserves historical totals) |

**Key design decisions:**
- `medium` is the baseline (1.0x) — standard work is unchanged
- Impact adjusts at the margins, boosting high-value and deflating low-value work
- Existing entries migrated with `unknown` (1.0x) to preserve historical totals

### UI Display

- **High impact** (critical/high): Shows ⚡ badge next to time saved
- **Medium impact**: Normal display, no badge
- **Low impact** (low/trivial): Muted appearance (reduced opacity)

The tooltip shows the impact level when hovering over time saved.

---

## Display Logic

### Display Threshold

Estimates below **5 minutes** are stored but not shown in the UI. The rationale: "You saved 2 minutes" feels trivial and undermines trust.

### UI Surfaces

1. **Inline summary** (`TimeSavedSummary.tsx`) — Shows after turn completion with midpoint estimate
2. **Header indicator** (`HomepagePanel.tsx`) — Weekly total with trend arrow (↑ ahead of pace, → on pace)
3. **Dashboard modal** (`TimeSavedModal.tsx`) — This week, last week, all-time totals
4. **Sidebar annotations** — Session-level estimates in history sidebar

When an estimate is unavailable (for example, parsing failed or the BTS call could not return a valid typed estimate), progress surfaces explain that weekly estimates are unavailable instead of rendering missing data as a real zero-minute total.

### First-Time Experience

On the user's first qualifying estimate, a tooltip appears: "I'm keeping track of time saved. Conservative estimates—I don't exaggerate."

---

## Persistence

### Store Structure (`timeSavedStore.ts`)

```typescript
interface TimeSavedStoreState {
  version: number;
  entries: TimeSavedEntry[];           // Last 1000 entries
  aggregates: TimeSavedAggregates;     // Weekly/monthly/all-time
  acknowledgedMilestones: number[];    // Milestones user has seen
  hasSeenFirstEstimate: boolean;
  dailyTotals: Record<string, number>; // Last 90 days
  firstBigWinShown: boolean;
  firstWeekShown: boolean;
}
```

### Milestones

Cumulative milestones (in minutes): 60, 600, 1440, 3000, 6000, 10080, 43200, 525600, 5256000

When a user crosses a milestone, it can trigger a toast notification (one-time, dismissible).

---

## Settings

The feature can be toggled in **Settings > System > Appearance**:
- **"Estimate time saved after conversations"** checkbox

When disabled (`settings.timeSavedEstimation.enabled === false`):
- No estimation API calls are made after turns
- The header indicator hides (no weekly total shown)
- Existing historical data is preserved

Default is enabled.

---

## Known Limitations

1. **Tool summary is coarse** — Currently just a count ("15 tool calls"), not categorized. The prompt explicitly tells the model to ignore tool count as a complexity signal.

2. **No outcome awareness** — The estimation doesn't know if the task *succeeded* in the user's eyes. The prompt instructs the model to return 0 for incomplete/uncertain output, but this relies on the model's interpretation of the summary.

3. **No user feedback loop** — Users cannot mark estimates as wrong, so there's no calibration mechanism.

---

## Troubleshooting

- **Estimates not appearing**: Check `settings.timeSavedEstimation.enabled`, verify turns exceed 30s, check logs for API errors
- **Estimates seem wrong**: The estimation prompt may need calibration—see next section

---

## Available Data for Enhanced UI

The store maintains granular data that can be used to make the time-saved summary more persuasive:

### Per-Entry Data (`TimeSavedEntry`)
```typescript
interface TimeSavedEntry {
  turnId: string;
  sessionId: string;
  estimate: TimeSavedEstimate; // includes taskType, reasoning, confidence
  timestamp: number;
}
```

### Existing APIs

| API | Returns | Use Case |
|-----|---------|----------|
| `getTimeSavedBySession()` | `Record<sessionId, minutes>` | Top contributing sessions |
| `getCurrentWeekDailyTotals()` | `Record<date, minutes>` | Daily breakdown chart |
| `getTimeSavedState()` | Full store state | Access to raw entries for aggregation |

### Session Title Lookup
Session titles can be looked up via `listSessions()` which returns `AgentSessionSummary[]` with `id`, `title`, `preview`, etc.

### Enhancement Ideas (80/20)

1. **Top Contributors section** — Show top 3-5 sessions with most time saved this week, with titles and task-type badges. Clickable to open conversation.

2. **Task-type breakdown** — Simple list showing time saved by category:
   - Research: 18h (42%)
   - Writing: 12h (28%)
   - etc.

3. **Daily hover tooltips** — On hover over day bar, show top 2-3 sessions for that day.

Implementation requires:
- New IPC: `getWeekTopSessions()` returning `Array<{ sessionId, minutes, taskType }>`
- New IPC: `getWeekTaskTypeBreakdown()` returning `Record<taskType, minutes>`
- Session title lookup in renderer from existing session list

---

## Analytics Reporting

Time-saved data is reported to RudderStack/PostHog for org-level aggregation via the `Daily Time Saved Summary` event.

**How it works:**
- On app startup, aggregates time-saved entries by UTC date
- Reports completed days only (never "today")
- Uses idempotency key for deduplication
- Fire-and-forget pattern (non-blocking)

**Source:** `src/main/services/dailyTimeSavedReportingService.ts`

**Event details:** See [`Daily Time Saved Summary` in ANALYTICS_DATA_DICTIONARY.md](./ANALYTICS_DATA_DICTIONARY.md#daily-time-saved-summary) for full property schema.

---

## Future Improvements

See `docs/plans/finished/251213_time_saved_feature.md` for Phase 3 ideas including:
- User accuracy feedback
- Better tool categorization in input
- Caching similar task patterns
