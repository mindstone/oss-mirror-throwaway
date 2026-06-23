/**
 * Event tools — Stage 3 business value (per-user lookup + ad-hoc queries + schema discovery).
 *
 * Plan: docs/plans/260515_mixpanel_mcp.md
 *  - DL-5 default-summary, hard caps, streaming abort, 90-day window
 *  - DL-13 read-only, tool-list invariant
 *  - DL-16 email → distinct_id bridge
 *  - DL-17 structured filters DSL (no raw `where`)
 *  - DL-18 URL-token redaction (applied in client.fetchJson / stream consumer)
 */
import { z } from 'zod';

import {
  MixpanelClient,
  buildWhereClause,
  redactUrlTokensDeep,
} from '../client.js';
import {
  MixpanelError,
  NDJSON_EVENT_HARD_CAP,
  PER_USER_EVENT_HARD_CAP,
  QUERY_WINDOW_MAX_DAYS,
  type MixpanelFilter,
  type MixpanelFilterOp,
} from '../types.js';

// ── Zod schemas ────────────────────────────────────────────────────────────

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

const FILTER_OPS = ['==', '!=', 'in', 'not_in', 'is_set', 'is_not_set'] as const;
// Compile-time check that FILTER_OPS exhausts MixpanelFilterOp.
type _FilterOpsExhaustive = Exclude<MixpanelFilterOp, (typeof FILTER_OPS)[number]> extends never ? true : false;
const _filterOpsExhaustive: _FilterOpsExhaustive = true;
void _filterOpsExhaustive;

const filterClauseSchema = z.object({
  property: z.string().min(1).describe('Event property name (e.g. "$email", "country_code").'),
  op: z.enum(FILTER_OPS).describe('Comparison operator.'),
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.union([z.string(), z.number(), z.boolean()])),
    ])
    .optional()
    .describe('Value for == / != (scalar), in / not_in (array). Omit for is_set / is_not_set.'),
});

export const listEventsForUserSchema = z.object({
  email: z.string().email().optional().describe('User email. One of email or distinct_id required.'),
  distinct_id: z.string().optional().describe('Mixpanel distinct_id. One of email or distinct_id required.'),
  from_date: dateString.describe('Start date YYYY-MM-DD (project local timezone).'),
  to_date: dateString.describe('End date YYYY-MM-DD (project local timezone), inclusive.'),
  limit: z.number().int().min(1).max(PER_USER_EVENT_HARD_CAP).optional().default(50).describe(`Max events to return (hard cap ${PER_USER_EVENT_HARD_CAP}).`),
  return_json: z.boolean().optional().default(false).describe('If true, include the full event list in the response.'),
});

export const queryEventsSchema = z.object({
  from_date: dateString.describe('Start date YYYY-MM-DD.'),
  to_date: dateString.describe('End date YYYY-MM-DD, inclusive. Window must be ≤ 90 days.'),
  event_name: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe('Filter to a single event name or an array of event names.'),
  filters: z.array(filterClauseSchema).optional().describe('Structured property filters (ANDed). No raw where strings.'),
  limit: z.number().int().min(1).max(NDJSON_EVENT_HARD_CAP).optional().default(100).describe(`Max events scanned/returned (hard cap ${NDJSON_EVENT_HARD_CAP}).`),
  return_json: z.boolean().optional().default(false).describe('If true, include the event list in the response.'),
});

export const listEventNamesSchema = z.object({
  type: z.enum(['general', 'average', 'unique']).optional().default('general').describe('Event type bucket.'),
  limit: z.number().int().min(1).max(1000).optional().default(100).describe('Max event names to return.'),
});

export const getEventPropertiesSchema = z.object({
  event_name: z.string().min(1).describe('Event name (e.g. "Signup", "Page View").'),
  property_name: z.string().min(1).describe('Property name (e.g. "$email", "country_code").'),
  from_date: dateString.optional().describe('Start date YYYY-MM-DD (defaults to last 30 days).'),
  to_date: dateString.optional().describe('End date YYYY-MM-DD (defaults to today).'),
  limit: z.number().int().min(1).max(1000).optional().default(255).describe('Max distinct values to return.'),
});

export type ListEventsForUserArgs = z.infer<typeof listEventsForUserSchema>;
export type QueryEventsArgs = z.infer<typeof queryEventsSchema>;
export type ListEventNamesArgs = z.infer<typeof listEventNamesSchema>;
export type GetEventPropertiesArgs = z.infer<typeof getEventPropertiesSchema>;

// ── Helpers ─────────────────────────────────────────────────────────────────

const TIMEZONE_BASIS_EXPORT = 'mixpanel_project_timezone';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const daysBetween = (fromIso: string, toIso: string): number => {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.floor((b - a) / (24 * 3600 * 1000))) + 1;
};

const suggestNarrowerRanges = (fromIso: string, toIso: string): Array<{ from_date: string; to_date: string }> => {
  // Suggest 3 halving steps of the user's window starting from the to_date.
  const total = daysBetween(fromIso, toIso);
  if (!Number.isFinite(total) || total <= 1) return [];
  const out: Array<{ from_date: string; to_date: string }> = [];
  let step = Math.max(1, Math.floor(total / 2));
  for (let i = 0; i < 3 && step >= 1; i += 1) {
    const to = toIso;
    const fromMs = Date.parse(`${toIso}T00:00:00Z`) - (step - 1) * 24 * 3600 * 1000;
    const from = new Date(fromMs).toISOString().slice(0, 10);
    out.push({ from_date: from, to_date: to });
    step = Math.max(1, Math.floor(step / 2));
  }
  return out;
};

const summariseEvents = (events: Array<Record<string, unknown>>): {
  total: number;
  by_event_name: Record<string, number>;
  first_event_at?: string;
  last_event_at?: string;
} => {
  const byName: Record<string, number> = {};
  let first: number | undefined;
  let last: number | undefined;
  for (const ev of events) {
    const name = typeof ev.event === 'string' ? ev.event : 'unknown';
    byName[name] = (byName[name] ?? 0) + 1;
    const props = isRecord(ev.properties) ? ev.properties : undefined;
    const time = typeof props?.time === 'number' ? (props.time as number) : undefined;
    if (typeof time === 'number') {
      if (first === undefined || time < first) first = time;
      if (last === undefined || time > last) last = time;
    }
  }
  return {
    total: events.length,
    by_event_name: byName,
    first_event_at: first !== undefined ? new Date(first * 1000).toISOString() : undefined,
    last_event_at: last !== undefined ? new Date(last * 1000).toISOString() : undefined,
  };
};

const errorToResponse = (err: unknown): Record<string, unknown> => {
  if (err instanceof MixpanelError) {
    const payload: Record<string, unknown> = {
      ok: false,
      code: err.code,
      error: err.message,
      resolution: err.resolution,
    };
    if (err.context.retryAfterSeconds !== undefined) {
      payload.retry_after_seconds = err.context.retryAfterSeconds;
    }
    if (err.context.timeoutMs !== undefined) {
      payload.timeout_ms = err.context.timeoutMs;
    }
    if (err.context.endpoint !== undefined) {
      payload.endpoint = err.context.endpoint;
    }
    if (err.context.suggestedRanges !== undefined) {
      payload.suggested_ranges = err.context.suggestedRanges;
    }
    return payload;
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    code: 'API_ERROR',
    error: message,
    resolution: 'Mixpanel returned an unexpected error. Try again with narrower filters.',
  };
};

// ── Tool handlers ──────────────────────────────────────────────────────────

/**
 * mixpanel_list_events_for_user — per-user event lookup.
 * DL-16 email → distinct_id bridge.
 */
export async function mixpanelListEventsForUser(
  client: MixpanelClient,
  args: ListEventsForUserArgs,
): Promise<string> {
  if (!args.email && !args.distinct_id) {
    return JSON.stringify({
      ok: false,
      code: 'CONFIG_MISSING',
      error: 'Either email or distinct_id is required.',
      resolution: 'Provide an email address or a Mixpanel distinct_id.',
    });
  }

  if (daysBetween(args.from_date, args.to_date) > QUERY_WINDOW_MAX_DAYS) {
    return JSON.stringify({
      ok: false,
      code: 'WINDOW_TOO_WIDE',
      error: `Date window exceeds ${QUERY_WINDOW_MAX_DAYS} days.`,
      resolution: `Narrow the window to ${QUERY_WINDOW_MAX_DAYS} days or fewer.`,
      suggested_ranges: suggestNarrowerRanges(args.from_date, args.to_date),
    });
  }

  try {
    // DL-16: resolve email → distinct_id via Engage when only email is provided.
    let distinctId = args.distinct_id;
    let bridgeUsed: 'engage_lookup' | 'event_property_fallback' | 'direct_distinct_id' = 'direct_distinct_id';
    let whereClause: string | undefined;

    if (!distinctId && args.email) {
      const profile = await client.getEngageProfile({ email: args.email });
      const resolved = extractDistinctIdFromEngage(profile);
      if (resolved) {
        distinctId = resolved;
        bridgeUsed = 'engage_lookup';
      } else {
        // Fallback: filter event properties for the email (DL-16).
        bridgeUsed = 'event_property_fallback';
        whereClause = `properties["$email"] == ${JSON.stringify(args.email)} or properties["email"] == ${JSON.stringify(args.email)}`;
      }
    }

    if (distinctId && !whereClause) {
      whereClause = `properties["distinct_id"] == ${JSON.stringify(distinctId)} or properties["$distinct_id"] == ${JSON.stringify(distinctId)}`;
    }

    const events: Array<Record<string, unknown>> = [];
    const limit = args.limit ?? 50;
    const streamResult = await client.exportEvents({
      fromDate: args.from_date,
      toDate: args.to_date,
      whereClause,
      onEvent: (ev) => {
        if (isRecord(ev)) {
          events.push(redactUrlTokensDeep(ev));
        }
        return events.length < Math.min(limit, PER_USER_EVENT_HARD_CAP);
      },
    });

    if (events.length === 0) {
      return JSON.stringify({
        ok: true,
        no_match: true,
        count: 0,
        summary: `No events matched for ${args.email ?? args.distinct_id} in ${args.from_date}..${args.to_date}.`,
        timezone_basis: TIMEZONE_BASIS_EXPORT,
        bridge: bridgeUsed,
        truncated: false,
      });
    }

    const summary = summariseEvents(events);
    const payload: Record<string, unknown> = {
      ok: true,
      summary: {
        ...summary,
        date_range: { from: args.from_date, to: args.to_date },
        bridge_used: bridgeUsed,
        distinct_id: distinctId ?? null,
      },
      count: events.length,
      timezone_basis: TIMEZONE_BASIS_EXPORT,
      truncated: streamResult.truncated || events.length >= limit,
      truncation_reason: streamResult.truncated ? 'event_cap' : undefined,
    };
    if (args.return_json) {
      payload.data = events;
    }
    return JSON.stringify(payload);
  } catch (err) {
    return JSON.stringify(errorToResponse(err));
  }
}

const extractDistinctIdFromEngage = (response: unknown): string | undefined => {
  if (!isRecord(response)) return undefined;
  const results = Array.isArray(response.results) ? response.results : undefined;
  if (!results || results.length === 0) return undefined;
  const first = results[0];
  if (!isRecord(first)) return undefined;
  if (typeof first.$distinct_id === 'string') return first.$distinct_id;
  if (typeof first.distinct_id === 'string') return first.distinct_id;
  return undefined;
};

/**
 * mixpanel_query_events — ad-hoc time-bounded event query with structured filters.
 * Hard window cap = 90 days (DL-5). No raw `where` strings — DL-17.
 */
export async function mixpanelQueryEvents(
  client: MixpanelClient,
  args: QueryEventsArgs,
): Promise<string> {
  if (daysBetween(args.from_date, args.to_date) > QUERY_WINDOW_MAX_DAYS) {
    return JSON.stringify({
      ok: false,
      code: 'WINDOW_TOO_WIDE',
      error: `Date window exceeds ${QUERY_WINDOW_MAX_DAYS} days.`,
      resolution: `Narrow the window to ${QUERY_WINDOW_MAX_DAYS} days or fewer.`,
      suggested_ranges: suggestNarrowerRanges(args.from_date, args.to_date),
    });
  }

  try {
    const eventNames = args.event_name === undefined
      ? undefined
      : Array.isArray(args.event_name)
        ? args.event_name
        : [args.event_name];

    let whereClause: string | undefined;
    if (args.filters && args.filters.length > 0) {
      whereClause = buildWhereClause(args.filters);
    }

    const events: Array<Record<string, unknown>> = [];
    const limit = args.limit ?? 100;
    const streamResult = await client.exportEvents({
      fromDate: args.from_date,
      toDate: args.to_date,
      eventNames,
      whereClause,
      onEvent: (ev) => {
        if (isRecord(ev)) {
          events.push(redactUrlTokensDeep(ev));
        }
        return events.length < Math.min(limit, NDJSON_EVENT_HARD_CAP);
      },
    });

    if (events.length === 0) {
      return JSON.stringify({
        ok: true,
        no_match: true,
        count: 0,
        summary: `No events matched in ${args.from_date}..${args.to_date}.`,
        timezone_basis: TIMEZONE_BASIS_EXPORT,
        truncated: false,
      });
    }

    const summary = summariseEvents(events);
    const payload: Record<string, unknown> = {
      ok: true,
      summary: {
        ...summary,
        date_range: { from: args.from_date, to: args.to_date },
        event_name_filter: eventNames ?? null,
        filter_count: args.filters?.length ?? 0,
      },
      count: events.length,
      timezone_basis: TIMEZONE_BASIS_EXPORT,
      truncated: streamResult.truncated || events.length >= limit,
      truncation_reason: streamResult.truncated ? 'event_cap' : undefined,
    };
    if (args.return_json) {
      payload.data = events;
    }
    return JSON.stringify(payload);
  } catch (err) {
    return JSON.stringify(errorToResponse(err));
  }
}

/**
 * mixpanel_list_event_names — schema discovery.
 */
export async function mixpanelListEventNames(
  client: MixpanelClient,
  args: ListEventNamesArgs,
): Promise<string> {
  try {
    const result = await client.listEventNames({ type: args.type, limit: args.limit });
    const names = Array.isArray(result) ? result.filter((v): v is string => typeof v === 'string') : [];
    return JSON.stringify({
      ok: true,
      summary: {
        total: names.length,
        type: args.type,
      },
      count: names.length,
      data: names,
    });
  } catch (err) {
    return JSON.stringify(errorToResponse(err));
  }
}

/**
 * mixpanel_get_event_properties — distinct values for one property of one event.
 */
export async function mixpanelGetEventProperties(
  client: MixpanelClient,
  args: GetEventPropertiesArgs,
): Promise<string> {
  try {
    const result = await client.getEventPropertyValues({
      eventName: args.event_name,
      propertyName: args.property_name,
      fromDate: args.from_date,
      toDate: args.to_date,
      limit: args.limit,
    });
    const values = Array.isArray(result) ? result : [];
    return JSON.stringify({
      ok: true,
      summary: {
        total: values.length,
        event_name: args.event_name,
        property_name: args.property_name,
      },
      count: values.length,
      data: values,
    });
  } catch (err) {
    return JSON.stringify(errorToResponse(err));
  }
}
