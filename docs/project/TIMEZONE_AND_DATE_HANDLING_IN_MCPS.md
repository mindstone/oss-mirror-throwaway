---
description: "Timezone handling guidelines for MCP tool responses — ensures calendar and time data reaches the LLM in the user's timezone"
last_updated: "2026-04-09"
---

# Timezone and Date Handling in MCPs

Guidelines for handling timezones in MCP server tool responses. Applies to all bundled MCPs that return time-related data to the LLM agent.

## See Also

- [DATES_AND_TIMES](DATES_AND_TIMES.md) — General date/time handling in Rebel (local date pattern, Intl formatting, anti-patterns)
- [MCP_IMPROVEMENT_WORKFLOW](MCP_IMPROVEMENT_WORKFLOW.md) — MCP development workflow with quality checklist (includes timezone item)
- [`build-custom-mcp-server` references](../../rebel-system/skills/coding/build-custom-mcp-server/references/) — User-facing MCP development references (includes `timezone_handling.md`)
- [Planning doc: 260409_calendar_timezone_fix](../plans/260409_calendar_timezone_fix.md) — Original investigation, design decisions, and MCP audit results
- `src/core/services/calendarTimeUtils.ts` — Timezone-aware utilities (required `timeZone: string` parameter pattern)

## Why This Matters

The LLM agent runs in Rebel Core (main process on desktop, Node.js server on cloud). On desktop, the host timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) matches the user. On cloud, the server runs in UTC. If an MCP tool returns times formatted using the host timezone, cloud users see UTC times instead of their local time. Even on desktop, some APIs (e.g., Google Calendar) return UTC timestamps that need conversion.

**The triggering bug:** Google Calendar MCP used `events[0]?.start?.timeZone || 'UTC'` as the timezone for text formatting. When the first event lacked an explicit timezone field, times displayed as UTC (e.g., "12:00 PM" instead of "1:00 PM BST").

## The 4-Layer Defense

Each layer catches failures from the layer above:

| Layer | Where | What it Does |
|-------|-------|-------------|
| **1. MCP handler** | `resources/mcp/<name>/` | Fetch user timezone from the service API; format times in that timezone |
| **2. Core assembler** | `src/core/services/` | Format cached meeting data using explicit `timeZone: string` parameter |
| **3. System prompt** | `rebel-system/AGENTS.md` | Instruct agent to convert UTC/ISO timestamps and use date-calc script for day-of-week |
| **4. Eval** | `evals/fixtures/` | Regression fixtures testing timezone conversion and day-of-week accuracy |

## MCP Tool Response Requirements

### Text mode (default)

When a tool returns human-readable text, format all times in the **user's timezone**:

```
Reference: Today is Thursday, April 9, 2026
Timezone: Europe/London (all times shown in this timezone)
Calendar: 5 events

**Thursday, Apr 9**
  1:00 PM–2:00 PM - Team Standup
    [id: event_123]
```

Key requirements:
- Include a `Timezone:` header line so the LLM knows which timezone times are in
- Include a `Reference: Today is...` line to ground the LLM in the current date
- Format times with `toLocaleTimeString('en-US', { timeZone })` or equivalent
- All-day events show as "All day" (no time conversion needed)

### JSON mode (`returnJson: true`)

When a tool returns structured JSON, include timezone metadata with full source transparency:

```json
{
  "timezoneInfo": {
    "resolved": "Europe/London",
    "source": "calendar_settings",
    "calendarTimezone": "Europe/London",
    "deviceTimezone": "Europe/London",
    "timezoneMismatch": false
  },
  "referenceTimeUTC": "2026-04-09T12:00:00.000Z",
  "events": [ ... ]
}
```

- `timezoneInfo.resolved`: The timezone used for formatting — best available from the priority chain
- `timezoneInfo.source`: Where it came from (`calendar_settings`, `event`, `device`, `utc_fallback`)
- `timezoneInfo.calendarTimezone`: From the service API (null if unavailable)
- `timezoneInfo.deviceTimezone`: From the LLM's `deviceTimezone` parameter (null if not provided)
- `timezoneInfo.timezoneMismatch`: True if calendar and device timezones differ
- `referenceTimeUTC`: Current time in UTC (useful for relative time calculations)
- Raw event data preserved as-is (ISO strings with offsets)

Tools should accept an optional `deviceTimezone` parameter (IANA string, e.g. `"Europe/London"`) that the LLM populates from the system prompt's device timezone. This serves as a fallback when calendar settings are unavailable and enables mismatch detection.

### Fetching the user's timezone

| Service | API | Returns | Conversion needed? |
|---------|-----|---------|-------------------|
| Google Calendar | `calendar.settings.get({ setting: 'timezone' })` | IANA (e.g., `Europe/London`) | No |
| Microsoft Graph | `/me/mailboxSettings` → `timeZone` | Windows TZ name (e.g., `GMT Standard Time`) | Yes → use `windowsToIanaTimezone()` from `microsoft-shared` |
| Slack | Workspace/user settings | IANA | No |
| Generic | User profile/settings API | Varies | Normalize to IANA |

### Windows timezone → IANA conversion

Microsoft APIs return Windows timezone names. Use `windowsToIanaTimezone()` from `resources/mcp/microsoft-shared/src/timezoneMapping.ts` (~140 CLDR mappings). Unknown names are logged and returned as-is (they may already be IANA in newer API versions).

## Anti-Patterns

### ❌ Using host timezone implicitly

```typescript
// WRONG: Uses host process timezone (UTC on cloud)
new Date(isoString).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
```

```typescript
// RIGHT: Explicit timezone
new Date(isoString).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
```

### ❌ Falling back to UTC silently

```typescript
// WRONG: Silent UTC fallback masks bugs
const tz = events[0]?.start?.timeZone || 'UTC';
```

```typescript
// RIGHT: Fetch from settings with observable fallback
const tz = await getUserCalendarTimezone(email, events[0]?.start?.timeZone);
// Helper logs when degraded source is used
```

### ❌ Using `new Date(naiveString).getDay()` for day-of-week

```typescript
// WRONG: Host-local day, wrong on cloud
const dayName = DAY_NAMES[new Date(meeting.startTime).getDay()];
```

```typescript
// RIGHT: Timezone-aware day
const dayName = getDayNameInTz(new Date(meeting.startTime), timeZone);
```

### ~~❌ Hardcoding UTC for Microsoft event creation~~ ✅ Resolved

Microsoft Graph expects `{ dateTime, timeZone }` for event times. The write path uses `resolveTimezone()` (calendar settings > device timezone > fail) and rejects operations when no timezone is available — never silently defaults to UTC.

## Audit Status

From the April 2026 MCP timezone audit (see planning doc § Deferred Investigation).
This shows the status of **specific surfaces** audited, not entire packages — google-workspace and microsoft-calendar still have remaining issues in non-calendar handlers.

| Status | Count | Surfaces |
|--------|-------|----------|
| **Fixed** | 5 | google-workspace calendar handlers + forms/drive, microsoft-calendar (read + write paths with multi-timezone transparency), granola |
| **Remaining issues** | 6 | slack, email-imap, hubspot, fathom, quickbooks, google-workspace (remaining non-calendar handlers) |
| **Clean (no date output)** | 26 | All other bundled MCPs |

The 6 remaining MCPs with issues are documented in the planning doc for future fix.
