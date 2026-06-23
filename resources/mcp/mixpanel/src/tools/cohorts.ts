/**
 * Cohort + retention tools — Stage 4 (use-case 2).
 *
 * Plan: docs/plans/260515_mixpanel_mcp.md
 */
import { z } from 'zod';

import { MixpanelClient } from '../client.js';
import { MixpanelError, QUERY_WINDOW_MAX_DAYS } from '../types.js';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

export const listCohortsSchema = z.object({
  limit: z.number().int().min(1).max(500).optional().default(50).describe('Max cohorts to return.'),
  name_contains: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Case-insensitive substring match against cohort name. Applied client-side after fetch.'),
});

export const getRetentionSchema = z.object({
  event_name: z.string().min(1).describe('Cohort-defining (born) event — the event that places a user in the cohort.'),
  retention_event_name: z.string().optional().describe('Return-defining event. Defaults to the cohort event if omitted.'),
  from_date: dateString.describe('Start date YYYY-MM-DD.'),
  to_date: dateString.describe('End date YYYY-MM-DD, inclusive. Window must be ≤ 90 days.'),
  interval: z.enum(['day', 'week', 'month']).optional().default('week').describe('Retention bucket size.'),
  cohort_id: z.union([z.number(), z.string()]).optional().describe('Optional cohort ID to scope the analysis.'),
});

export type ListCohortsArgs = z.infer<typeof listCohortsSchema>;
export type GetRetentionArgs = z.infer<typeof getRetentionSchema>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const daysBetween = (a: string, b: string): number => {
  const av = Date.parse(`${a}T00:00:00Z`);
  const bv = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(av) || !Number.isFinite(bv)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.floor((bv - av) / (24 * 3600 * 1000))) + 1;
};

const errorToResponse = (err: unknown): Record<string, unknown> => {
  if (err instanceof MixpanelError) {
    return {
      ok: false,
      code: err.code,
      error: err.message,
      resolution: err.resolution,
      ...(err.context.retryAfterSeconds !== undefined ? { retry_after_seconds: err.context.retryAfterSeconds } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, code: 'API_ERROR', error: message, resolution: 'Try again with narrower filters.' };
};

export async function mixpanelListCohorts(client: MixpanelClient, args: ListCohortsArgs): Promise<string> {
  try {
    const result = await client.listCohorts({ limit: args.limit });
    const allCohorts = Array.isArray(result) ? result : [];
    const needle = args.name_contains?.trim().toLowerCase();
    const cohorts = needle && needle.length > 0
      ? allCohorts.filter((c) => isRecord(c) && typeof c.name === 'string' && c.name.toLowerCase().includes(needle))
      : allCohorts;
    const summary = cohorts.slice(0, 10).map((c) => {
      if (!isRecord(c)) return null;
      return {
        id: c.id,
        name: c.name,
        count: c.count,
        description: c.description,
      };
    }).filter((x) => x !== null);
    const paginationWarning =
      needle && cohorts.length === 0 && allCohorts.length === (args.limit ?? 50)
        ? "No matches in the first page. Mixpanel returned the maximum 'limit'; matches may exist beyond it — increase 'limit' (max 500) or remove 'name_contains' to inspect raw results."
        : undefined;
    return JSON.stringify({
      ok: true,
      summary: {
        total: cohorts.length,
        first_10: summary,
        ...(needle ? { name_filter: args.name_contains, total_before_filter: allCohorts.length } : {}),
        ...(paginationWarning ? { warning: paginationWarning } : {}),
      },
      count: cohorts.length,
      data: cohorts,
    });
  } catch (err) {
    return JSON.stringify(errorToResponse(err));
  }
}

export async function mixpanelGetRetention(client: MixpanelClient, args: GetRetentionArgs): Promise<string> {
  if (daysBetween(args.from_date, args.to_date) > QUERY_WINDOW_MAX_DAYS) {
    return JSON.stringify({
      ok: false,
      code: 'WINDOW_TOO_WIDE',
      error: `Date window exceeds ${QUERY_WINDOW_MAX_DAYS} days.`,
      resolution: `Narrow the window to ${QUERY_WINDOW_MAX_DAYS} days or fewer.`,
    });
  }

  try {
    const result = await client.getRetention({
      eventName: args.event_name,
      retentionEventName: args.retention_event_name,
      fromDate: args.from_date,
      toDate: args.to_date,
      interval: args.interval,
      cohortId: args.cohort_id,
    });

    // Mixpanel retention response: { "2026-05-01": { counts: [N0, N1, N2, ...], first_date: "..." }, ... }
    if (!isRecord(result)) {
      return JSON.stringify({
        ok: false,
        code: 'RESPONSE_INVALID',
        error: 'Mixpanel returned an unexpected retention response shape.',
        resolution: 'Try again, or simplify the request.',
      });
    }

    const buckets: Array<{ cohort_start: string; cohort_size: number; retention: number[] }> = [];
    for (const [cohortStart, payload] of Object.entries(result)) {
      if (!isRecord(payload)) continue;
      const counts = Array.isArray(payload.counts) && payload.counts.every((n) => typeof n === 'number')
        ? (payload.counts as number[])
        : undefined;
      if (!counts || counts.length === 0) continue;
      const cohortSize = counts[0] ?? 0;
      const retention = cohortSize === 0 ? counts.map(() => 0) : counts.map((n) => Math.round((n / cohortSize) * 1000) / 10);
      buckets.push({ cohort_start: cohortStart, cohort_size: cohortSize, retention });
    }

    return JSON.stringify({
      ok: true,
      summary: {
        cohort_event: args.event_name,
        retention_event: args.retention_event_name ?? args.event_name,
        interval: args.interval,
        date_range: { from: args.from_date, to: args.to_date },
        cohort_count: buckets.length,
        avg_first_period_retention_pct: buckets.length === 0
          ? 0
          : Math.round(
              (buckets.reduce((acc, b) => acc + (b.retention[1] ?? 0), 0) / buckets.length) * 10,
            ) / 10,
      },
      count: buckets.length,
      data: buckets,
    });
  } catch (err) {
    return JSON.stringify(errorToResponse(err));
  }
}
