---
description: "Date and time handling guidelines — local date keys, Intl display formatting, UTC timestamps, Luxon scheduling, and anti-patterns"
last_updated: "2026-04-10"
---

# Date and Time Handling

Guidelines for handling dates and times in Mindstone Rebel to avoid timezone bugs and ensure consistency across the codebase.

## See Also

- `src/main/services/timeSavedStore.ts` — Daily/weekly aggregation using local dates; canonical example of the local date pattern
- `src/main/services/automationScheduler.ts` — Uses Luxon for cron-style scheduling
- `src/renderer/utils/formatters.ts` — Display formatting utilities using `Intl.DateTimeFormat`
- `src/shared/utils/usageHistoryUtils.ts` — Usage aggregation by date

## Key Principles

1. **Use local dates for date-only strings** — When storing or comparing dates without time components (e.g., "today's data", daily aggregations)
2. **Use `Intl.DateTimeFormat` for display** — Respects user's locale and timezone automatically
3. **Use UTC timestamps for cross-timezone comparisons** — API calls, server sync, session timestamps

## The Local Date Pattern

For date-only strings (e.g., daily totals, week boundaries), use this pattern:

```typescript
const getLocalDateString = (timestamp: number): string => {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
```

This produces `YYYY-MM-DD` strings in **local time**, avoiding UTC conversion issues.

### Why This Pattern Exists

The bug pattern that caused off-by-one day errors:

```typescript
// ❌ WRONG: Creates timezone bugs
const dateKey = new Date(timestamp).toISOString().split('T')[0];
```

**What goes wrong:**
1. `toISOString()` converts the date to UTC
2. For users in UTC-negative timezones (e.g., US Pacific at UTC-8), a local 11 PM timestamp becomes the next day in UTC
3. Data gets attributed to the wrong day

**Example:** User in San Francisco (UTC-8) saves data at 11 PM on Monday local time:
- Local: Monday 11:00 PM
- UTC: Tuesday 7:00 AM
- `toISOString().split('T')[0]` returns Tuesday's date
- User's Monday data incorrectly counts as Tuesday

## When to Use Each Approach

| Use Case | Approach | Example |
|----------|----------|---------|
| Daily aggregations | Local date pattern | `timeSavedStore.ts` |
| Week/month boundaries | Local date pattern | `getWeekStartDate()` |
| Cron scheduling | Luxon | `automationScheduler.ts` |
| Display timestamps | `Intl.DateTimeFormat` | `formatters.ts` |
| API timestamps | UTC / `toISOString()` | Server communication |
| Session `createdAt` | Unix timestamp (ms) | Already timezone-agnostic |

## Display Formatting

For user-facing dates/times, prefer `Intl.DateTimeFormat` which automatically handles locale:

```typescript
// Relative time display
const formatter = new Intl.DateTimeFormat([], {
  month: 'short',
  day: 'numeric'
});
return formatter.format(timestamp);

// Full timestamp
const formatter = new Intl.DateTimeFormat([], {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
});
```

See `formatters.ts` for standard display formatting utilities.

## Luxon for Scheduling

For complex scheduling (cron expressions, timezone-aware scheduling), use Luxon:

```typescript
import { DateTime } from 'luxon';

const now = DateTime.now();
const nextRun = now.plus({ hours: 1 });
```

Used in `automationScheduler.ts` for automation scheduling.

## Anti-Patterns to Avoid

### ❌ `toISOString().split('T')[0]` for local dates

```typescript
// WRONG: Timezone bug
const dateKey = new Date(timestamp).toISOString().split('T')[0];
```

### ❌ `new Date('YYYY-MM-DD')` for local dates

```typescript
// WRONG: Parses as UTC midnight, not local midnight
const date = new Date('2025-01-15');
// At UTC-8, this is actually Jan 14 at 4 PM local!
```

If you must parse a YYYY-MM-DD string as local time:

```typescript
// Correct: Force local parsing
const date = new Date(isoDate + 'T00:00:00');
```

### ❌ Hardcoded date formatting

```typescript
// WRONG: Ignores user's locale
return `${month}/${day}/${year}`;
```

```typescript
// RIGHT: Use Intl.DateTimeFormat
return new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' }).format(date);
```

## Testing Timezone Edge Cases

When testing date-related code, consider these scenarios:
- User in UTC-positive timezone (e.g., UTC+10 Sydney)
- User in UTC-negative timezone (e.g., UTC-8 Los Angeles)
- Operations happening near midnight local time
- Operations happening near midnight UTC

## MCP Tool Responses

MCP servers that return time data have additional timezone requirements — the user's timezone must be fetched from the service API and used explicitly. See [TIMEZONE_AND_DATE_HANDLING_IN_MCPS](TIMEZONE_AND_DATE_HANDLING_IN_MCPS.md) for the full guideline.

Key points:
- Text mode: format times in user's timezone with `Timezone:` header including source label
- JSON mode: include `timezoneInfo` object (resolved timezone, source, calendar/device values, mismatch flag) and `referenceTimeUTC`
- Tools accept optional `deviceTimezone` parameter for fallback and mismatch detection
- Core assemblers (`src/core/services/`): use `calendarTimeUtils.ts` functions with **required** `timeZone: string` parameter
- Never rely on host `process.env.TZ` for time formatting in core or MCP code

## Known Issues

`src/shared/utils/usageHistoryUtils.ts` uses `toISOString().split('T')[0]` for session date grouping. Since `session.createdAt` is a UTC timestamp and usage is typically viewed in aggregate, this may be acceptable, but could cause minor inconsistencies for users reviewing daily usage near their local midnight.
