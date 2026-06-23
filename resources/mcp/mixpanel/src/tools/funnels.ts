/**
 * Funnels + insights tools — Stage 5 (use-case 3).
 *
 * Plan: docs/plans/260515_mixpanel_mcp.md
 */
import { z } from 'zod';

import { MixpanelClient } from '../client.js';
import { MixpanelError, QUERY_WINDOW_MAX_DAYS } from '../types.js';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

export const listInsightsSchema = z.object({
  workspace_id: z.union([z.number(), z.string()]).optional().describe('Optional Mixpanel workspace ID.'),
  bookmark_id: z.union([z.number(), z.string()]).optional().describe('Optional bookmark / report ID.'),
  limit: z.number().int().min(1).max(500).optional().default(100).describe('Max insights to return.'),
  name_contains: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Case-insensitive substring match against insight name. Applied client-side after fetch.'),
});

export const getInsightSchema = z.object({
  bookmark_id: z
    .union([z.number(), z.string().trim().min(1, 'bookmark_id must not be empty')])
    .describe('Saved insight / bookmark ID. Find it via mixpanel_list_insights or copy from the Mixpanel UI URL.'),
  from_date: dateString.optional().describe('Optional start date YYYY-MM-DD. Defaults to the insight\'s saved range.'),
  to_date: dateString.optional().describe('Optional end date YYYY-MM-DD, inclusive. Window must be ≤ 90 days when both dates are set.'),
  workspace_id: z.union([z.number(), z.string()]).optional().describe('Optional Mixpanel workspace ID.'),
});

export const getFunnelSchema = z.object({
  funnel_id: z
    .union([z.number(), z.string()])
    .describe('Numeric Mixpanel funnel ID. Find it in the Mixpanel UI URL (e.g. mixpanel.com/.../funnels/12345) or via mixpanel_list_insights.'),
  from_date: dateString.describe('Start date YYYY-MM-DD.'),
  to_date: dateString.describe('End date YYYY-MM-DD, inclusive. Window must be ≤ 90 days.'),
  interval: z.enum(['day', 'week', 'month']).optional().default('week').describe('Time bucket size for the funnel time series.'),
});

export type ListInsightsArgs = z.infer<typeof listInsightsSchema>;
export type GetInsightArgs = z.infer<typeof getInsightSchema>;
export type GetFunnelArgs = z.infer<typeof getFunnelSchema>;

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

export async function mixpanelListInsights(client: MixpanelClient, args: ListInsightsArgs): Promise<string> {
  try {
    const result = await client.listInsights({
      workspaceId: args.workspace_id,
      bookmarkId: args.bookmark_id,
      limit: args.limit,
    });
    const allItems = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.results) ? result.results : [];
    const needle = args.name_contains?.trim().toLowerCase();
    const items = needle && needle.length > 0
      ? allItems.filter((it) => isRecord(it) && typeof it.name === 'string' && it.name.toLowerCase().includes(needle))
      : allItems;
    const condensed = items.slice(0, 20).map((it) => {
      if (!isRecord(it)) return null;
      return {
        id: it.id,
        name: it.name,
        type: it.type,
        workspace_id: it.workspace_id,
      };
    }).filter((x) => x !== null);
    const paginationWarning =
      needle && items.length === 0 && allItems.length === (args.limit ?? 100)
        ? "No matches in the first page. Mixpanel returned the maximum 'limit'; matches may exist beyond it — increase 'limit' (max 500) or remove 'name_contains' to inspect raw results."
        : undefined;
    return JSON.stringify({
      ok: true,
      summary: {
        total: items.length,
        first_20: condensed,
        ...(needle ? { name_filter: args.name_contains, total_before_filter: allItems.length } : {}),
        ...(paginationWarning ? { warning: paginationWarning } : {}),
      },
      count: items.length,
      data: items,
    });
  } catch (err) {
    return JSON.stringify(errorToResponse(err));
  }
}

export async function mixpanelGetInsight(client: MixpanelClient, args: GetInsightArgs): Promise<string> {
  if (args.from_date && args.to_date && daysBetween(args.from_date, args.to_date) > QUERY_WINDOW_MAX_DAYS) {
    return JSON.stringify({
      ok: false,
      code: 'WINDOW_TOO_WIDE',
      error: `Date window exceeds ${QUERY_WINDOW_MAX_DAYS} days.`,
      resolution: `Narrow the window to ${QUERY_WINDOW_MAX_DAYS} days or fewer, or omit dates to use the insight's saved range.`,
    });
  }

  try {
    const result = await client.getInsight({
      bookmarkId: args.bookmark_id,
      fromDate: args.from_date,
      toDate: args.to_date,
      workspaceId: args.workspace_id,
    });
    if (!isRecord(result)) {
      return JSON.stringify({
        ok: false,
        code: 'RESPONSE_INVALID',
        error: 'Mixpanel returned an unexpected insight response shape.',
        resolution: 'Verify bookmark_id via mixpanel_list_insights.',
      });
    }

    // Mixpanel insight responses can come back as either:
    //   { computed_at, date_range, series: { "<series_label>": { "<date>": <number>, ... }, ... }, headers: [...] }
    //   { computed_at, data: { series: {...}, values: {...} }, ... }
    //   { results: [...] }  (a listing — caller passed bookmark_id but Mixpanel echoed list)
    // We try the most-common shape and fall through. The full payload is always preserved in `data`.
    const seriesRoot = isRecord(result.series)
      ? result.series
      : isRecord(result.data) && isRecord((result.data as Record<string, unknown>).series)
        ? ((result.data as Record<string, unknown>).series as Record<string, unknown>)
        : isRecord(result.data) && isRecord((result.data as Record<string, unknown>).values)
          ? ((result.data as Record<string, unknown>).values as Record<string, unknown>)
          : undefined;

    const seriesSummary: Array<{ label: string; total: number; latest: number | null; points: number }> = [];
    if (seriesRoot) {
      for (const [label, points] of Object.entries(seriesRoot)) {
        if (!isRecord(points)) continue;
        const entries = Object.entries(points).filter(([, v]) => typeof v === 'number') as Array<[string, number]>;
        if (entries.length === 0) continue;
        entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        const total = entries.reduce((acc, [, n]) => acc + n, 0);
        const latest = entries[entries.length - 1]?.[1] ?? null;
        seriesSummary.push({
          label,
          total: Math.round(total * 1000) / 1000,
          latest: latest === null ? null : Math.round(latest * 1000) / 1000,
          points: entries.length,
        });
      }
      seriesSummary.sort((a, b) => b.total - a.total);
    }

    const unrecognizedShape = seriesRoot === undefined;
    return JSON.stringify({
      ok: true,
      summary: {
        bookmark_id: args.bookmark_id,
        date_range: args.from_date && args.to_date
          ? { from: args.from_date, to: args.to_date }
          : 'insight_default',
        series_count: seriesSummary.length,
        top_series: seriesSummary.slice(0, 5),
        computed_at: typeof result.computed_at === 'string' ? result.computed_at : undefined,
        ...(unrecognizedShape
          ? {
              warning:
                "Unrecognized Mixpanel insight response shape — could not extract series. The raw payload is preserved in 'data'; inspect it directly or report the shape.",
            }
          : {}),
      },
      data: result,
    });
  } catch (err) {
    return JSON.stringify(errorToResponse(err));
  }
}

export async function mixpanelGetFunnel(client: MixpanelClient, args: GetFunnelArgs): Promise<string> {
  if (daysBetween(args.from_date, args.to_date) > QUERY_WINDOW_MAX_DAYS) {
    return JSON.stringify({
      ok: false,
      code: 'WINDOW_TOO_WIDE',
      error: `Date window exceeds ${QUERY_WINDOW_MAX_DAYS} days.`,
      resolution: `Narrow the window to ${QUERY_WINDOW_MAX_DAYS} days or fewer.`,
    });
  }

  try {
    const result = await client.getFunnel({
      funnelId: args.funnel_id,
      fromDate: args.from_date,
      toDate: args.to_date,
      interval: args.interval,
    });
    if (!isRecord(result)) {
      return JSON.stringify({
        ok: false,
        code: 'RESPONSE_INVALID',
        error: 'Mixpanel returned an unexpected funnel response shape.',
        resolution: 'Verify funnel_id with mixpanel_list_insights.',
      });
    }

    // Mixpanel funnel response: { meta: {...}, data: { "2026-05-01": { steps: [...], analysis: {...} } } }
    const dataMap = isRecord(result.data) ? result.data : {};
    const periodEntries = Object.entries(dataMap).filter(([, v]) => isRecord(v));
    const totals = periodEntries.reduce(
      (acc, [, v]) => {
        const obj = v as Record<string, unknown>;
        const analysis = isRecord(obj.analysis) ? obj.analysis : undefined;
        const starting = typeof analysis?.starting_amount === 'number' ? analysis.starting_amount : 0;
        const completion = typeof analysis?.completion === 'number' ? analysis.completion : 0;
        return { starting: acc.starting + starting, completion: acc.completion + completion };
      },
      { starting: 0, completion: 0 },
    );
    const overallRate = totals.starting === 0 ? 0 : Math.round((totals.completion / totals.starting) * 1000) / 10;

    return JSON.stringify({
      ok: true,
      summary: {
        funnel_id: args.funnel_id,
        date_range: { from: args.from_date, to: args.to_date },
        interval: args.interval,
        period_count: periodEntries.length,
        overall_starting: totals.starting,
        overall_completion: totals.completion,
        overall_conversion_pct: overallRate,
      },
      data: result,
    });
  } catch (err) {
    return JSON.stringify(errorToResponse(err));
  }
}
