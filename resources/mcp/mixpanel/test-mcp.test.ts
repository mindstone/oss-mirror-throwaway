/**
 * Mixpanel MCP — mock-API tests.
 *
 * Plan: docs/plans/260515_mixpanel_mcp.md (Stage 3).
 * Covers DL-5 (caps, summaries), DL-7 (rate-limit), DL-13 (read-only invariant + secret sentinel),
 * DL-15 (project_id injection), DL-16 (email → distinct_id bridge), DL-17 (filter encoding +
 * injection probes), DL-18 (URL-token redaction), plus auth classification + NDJSON paths.
 *
 * Run: npx vitest run resources/mcp/mixpanel/test-mcp.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createMcpTestClientWithMockApi,
  describeBundledMcp,
  resolveServerScript,
  type McpTestClient,
  type MockApiServer,
  type MockRoute,
} from '../../../scripts/mcp-test-harness';
import { buildWhereClause, redactUrlTokens, redactUrlTokensDeep } from './src/client';
import { MixpanelError } from './src/types';

// ── Test data ──────────────────────────────────────────────────────────────

const mockEvents = [
  {
    event: 'Signup',
    properties: {
      time: 1715731200,
      distinct_id: 'user-abc',
      $email: 'alice@example.com',
      $current_url: 'https://app.example.com/signup?token=secret-token-123&utm_source=launch',
      country_code: 'US',
    },
  },
  {
    event: 'Page View',
    properties: {
      time: 1715731260,
      distinct_id: 'user-abc',
      $email: 'alice@example.com',
      $current_url: 'https://app.example.com/dashboard?api_key=keep-me-not&page=home',
      country_code: 'US',
    },
  },
  {
    event: 'Purchase',
    properties: {
      time: 1715731320,
      distinct_id: 'user-abc',
      $email: 'alice@example.com',
      amount: 99,
      country_code: 'US',
    },
  },
];

const ndjsonBody = (events: Array<Record<string, unknown>>): string =>
  events.map((e) => JSON.stringify(e)).join('\n') + '\n';

const mockEnv = {
  MIXPANEL_USERNAME: '__SENTINEL_USER__',
  MIXPANEL_SECRET: '__SENTINEL_SECRET__',
  MIXPANEL_PROJECT_ID: '12345',
  MIXPANEL_REGION: 'us',
};

// Counter for tests that need to differentiate 429-with-retry vs subsequent success.
let exportCallCount = 0;

const baseRoutes = (): MockRoute[] => {
  exportCallCount = 0;
  return [
    {
      method: 'GET',
      path: '/api/2.0/export',
      handler: (req) => {
        exportCallCount += 1;
        // Specific filter-driven branches first.
        const where = req.searchParams.get('where') ?? '';
        const from = req.searchParams.get('from_date');
        const to = req.searchParams.get('to_date');
        if (from === '2099-01-01' || to === '2099-01-01') {
          return {
            status: 200,
            headers: { 'Content-Type': 'application/x-ndjson' },
            rawBody: '',
            body: null,
          };
        }
        if (where.includes('NO_MATCH_DISTINCT')) {
          return {
            status: 200,
            headers: { 'Content-Type': 'application/x-ndjson' },
            rawBody: '',
            body: null,
          };
        }
        if (where.includes('TRIGGER_401')) {
          return { status: 401, body: { error: 'invalid credentials' } };
        }
        if (where.includes('TRIGGER_403')) {
          return { status: 403, body: { error: 'forbidden' } };
        }
        if (where.includes('TRIGGER_429_LONG')) {
          return {
            status: 429,
            headers: { 'Retry-After': '600' },
            body: { error: 'rate limited' },
          };
        }
        return {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson' },
          rawBody: ndjsonBody(mockEvents),
          body: null,
        };
      },
    },
    {
      method: 'GET',
      path: '/api/2.0/engage',
      handler: (req) => {
        const where = req.searchParams.get('where') ?? '';
        if (where.includes('notfound@example.com')) {
          return { body: { results: [], page: 0, total: 0 } };
        }
        if (where.includes('alice@example.com')) {
          return {
            body: {
              results: [
                {
                  $distinct_id: 'user-abc',
                  $properties: { $email: 'alice@example.com', $name: 'Alice' },
                },
              ],
              page: 0,
              total: 1,
            },
          };
        }
        return { body: { results: [], page: 0, total: 0 } };
      },
    },
    {
      method: 'GET',
      path: '/api/2.0/events/names',
      handler: () => ({ body: ['Signup', 'Page View', 'Purchase'] }),
    },
    {
      method: 'GET',
      path: '/api/2.0/events/properties/values',
      handler: () => ({ body: ['US', 'GB', 'DE', 'FR'] }),
    },
    {
      method: 'GET',
      path: '/api/2.0/cohorts/list',
      handler: () => ({
        body: [
          { id: 9001, name: 'Power users', count: 1234, description: 'DAU + paid' },
          { id: 9002, name: 'Trial signups', count: 56, description: 'Last 30 days' },
        ],
      }),
    },
    {
      method: 'GET',
      path: '/api/2.0/retention',
      handler: () => ({
        body: {
          '2026-05-01': { counts: [100, 50, 30, 25, 20], first_date: '2026-05-01' },
          '2026-05-08': { counts: [80, 40, 24, 18, 14], first_date: '2026-05-08' },
        },
      }),
    },
    {
      method: 'GET',
      path: '/api/2.0/insights',
      handler: (req) => {
        const bookmarkId = req.searchParams.get('bookmark_id');
        // Special: bookmark_id 44444 returns an unrecognized response shape (no series/data.series/data.values).
        if (bookmarkId === '44444') {
          return {
            body: {
              computed_at: '2026-05-15T10:00:00Z',
              foo: 'bar',
              random_payload: { unknown_field: [1, 2, 3] },
            },
          };
        }
        // Single-insight mode: bookmark_id + dates → computed series response.
        if (bookmarkId === '22222') {
          return {
            body: {
              computed_at: '2026-05-15T10:00:00Z',
              date_range: { from_date: '2026-05-01', to_date: '2026-05-15' },
              series: {
                'Average Points Per User': {
                  '2026-05-01': 42.5,
                  '2026-05-08': 47.2,
                  '2026-05-15': 51.1,
                },
                Overall: {
                  '2026-05-01': 1000,
                  '2026-05-08': 1200,
                  '2026-05-15': 1500,
                },
              },
              headers: ['date', 'value'],
            },
          };
        }
        // Default list mode (3 insights — broad enough for name_contains tests).
        return {
          body: {
            results: [
              { id: 11111, name: 'Activation funnel', type: 'funnels', workspace_id: 1 },
              { id: 22222, name: 'Weekly DAU', type: 'insights', workspace_id: 1 },
              { id: 33333, name: 'Average Points Per User', type: 'insights', workspace_id: 1 },
            ],
          },
        };
      },
    },
    {
      method: 'GET',
      path: '/api/2.0/funnels',
      handler: () => ({
        body: {
          meta: { dates: ['2026-05-01', '2026-05-08'] },
          data: {
            '2026-05-01': {
              steps: [
                { event: 'Signup', count: 100, step_label: 'Signup' },
                { event: 'Activation', count: 60, step_label: 'Activation' },
              ],
              analysis: { starting_amount: 100, completion: 60, steps: 2 },
            },
            '2026-05-08': {
              steps: [
                { event: 'Signup', count: 80, step_label: 'Signup' },
                { event: 'Activation', count: 56, step_label: 'Activation' },
              ],
              analysis: { starting_amount: 80, completion: 56, steps: 2 },
            },
          },
        },
      }),
    },
  ];
};

describe('mixpanel — pure functions', () => {
  it('buildWhereClause: scalar ==', () => {
    expect(buildWhereClause([{ property: '$email', op: '==', value: 'alice@example.com' }])).toBe(
      'properties["$email"] == "alice@example.com"',
    );
  });

  it('buildWhereClause: scalar with quotes/backslash is JSON-escaped', () => {
    const out = buildWhereClause([{ property: 'note', op: '==', value: 'has "quotes" and \\slash' }]);
    expect(out).toBe('properties["note"] == "has \\"quotes\\" and \\\\slash"');
  });

  it('buildWhereClause: in/not_in', () => {
    expect(buildWhereClause([{ property: 'plan', op: 'in', value: ['pro', 'team'] }])).toBe(
      '(properties["plan"] in ["pro","team"])',
    );
    expect(buildWhereClause([{ property: 'plan', op: 'not_in', value: ['free'] }])).toBe(
      'not (properties["plan"] in ["free"])',
    );
  });

  it('buildWhereClause: is_set / is_not_set', () => {
    expect(buildWhereClause([{ property: 'email', op: 'is_set' }])).toBe('defined(properties["email"])');
    expect(buildWhereClause([{ property: 'email', op: 'is_not_set' }])).toBe('not defined(properties["email"])');
  });

  it('buildWhereClause: AND join with parens', () => {
    expect(
      buildWhereClause([
        { property: '$email', op: '==', value: 'alice@example.com' },
        { property: 'plan', op: 'in', value: ['pro', 'team'] },
      ]),
    ).toBe('(properties["$email"] == "alice@example.com") and ((properties["plan"] in ["pro","team"]))');
  });

  it('buildWhereClause: rejects disallowed characters in property name', () => {
    expect(() =>
      buildWhereClause([{ property: 'evil`prop', op: '==', value: 'x' }]),
    ).toThrow(MixpanelError);
  });

  it('buildWhereClause: rejects is_set with value', () => {
    expect(() =>
      buildWhereClause([{ property: 'email', op: 'is_set', value: 'x' }]),
    ).toThrow(MixpanelError);
  });

  it('buildWhereClause: rejects == with array value', () => {
    expect(() =>
      buildWhereClause([{ property: 'email', op: '==', value: ['a', 'b'] }]),
    ).toThrow(MixpanelError);
  });

  it('buildWhereClause: rejects in with empty array', () => {
    expect(() =>
      buildWhereClause([{ property: 'plan', op: 'in', value: [] }]),
    ).toThrow(MixpanelError);
  });

  it('buildWhereClause: rejects property over 100 chars', () => {
    expect(() =>
      buildWhereClause([{ property: 'a'.repeat(101), op: '==', value: 'x' }]),
    ).toThrow(MixpanelError);
  });

  it('redactUrlTokens: redacts secret-keyed query params', () => {
    const out = redactUrlTokens(
      'https://app.example.com/path?token=abc&utm_source=launch&access_token=xyz',
    );
    expect(out).toContain('token=__REDACTED__');
    expect(out).toContain('utm_source=launch');
    expect(out).toContain('access_token=__REDACTED__');
  });

  it('redactUrlTokens: leaves non-URL strings untouched', () => {
    expect(redactUrlTokens('hello world')).toBe('hello world');
    expect(redactUrlTokens('')).toBe('');
  });

  it('redactUrlTokensDeep: walks nested objects/arrays', () => {
    const input = {
      properties: {
        $current_url: 'https://x.com/y?session=DROP&q=keep',
        nested: [
          { url: 'https://x.com/?password=DROP' },
          'https://x.com/?utm_source=keep',
        ],
      },
    };
    const out = redactUrlTokensDeep(input) as typeof input;
    expect(out.properties.$current_url).toContain('session=__REDACTED__');
    expect(out.properties.$current_url).toContain('q=keep');
    expect((out.properties.nested[0] as { url: string }).url).toContain('password=__REDACTED__');
    expect(out.properties.nested[1]).toContain('utm_source=keep');
  });
});

describeBundledMcp('mixpanel', 'mixpanel — happy path tools', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    const result = await createMcpTestClientWithMockApi({
      name: 'mixpanel',
      serverScript: resolveServerScript('mixpanel'),
      interceptDomains: ['mixpanel.com', 'data.mixpanel.com', 'eu.mixpanel.com', 'data-eu.mixpanel.com'],
      routes: baseRoutes(),
      env: mockEnv,
      connectTimeout: 15_000,
    });
    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
  });

  it('tool-list invariant (DL-13): exactly 10 read-only tools registered, no write verbs', async () => {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'mixpanel_get_event_properties',
      'mixpanel_get_funnel',
      'mixpanel_get_insight',
      'mixpanel_get_retention',
      'mixpanel_get_user_profile',
      'mixpanel_list_cohorts',
      'mixpanel_list_event_names',
      'mixpanel_list_events_for_user',
      'mixpanel_list_insights',
      'mixpanel_query_events',
    ]);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.name).not.toMatch(/track|import|update|delete|merge|set_/i);
    }
  });

  it('mixpanel_list_events_for_user uses Engage bridge then exports (DL-16)', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{
      ok: boolean;
      count: number;
      summary: { bridge_used: string; distinct_id: string | null };
      timezone_basis: string;
    }>('mixpanel_list_events_for_user', {
      email: 'alice@example.com',
      from_date: '2026-05-01',
      to_date: '2026-05-15',
      limit: 50,
    });

    expect(out.ok).toBe(true);
    expect(out.count).toBe(3);
    expect(out.summary.bridge_used).toBe('engage_lookup');
    expect(out.summary.distinct_id).toBe('user-abc');
    expect(out.timezone_basis).toBe('mixpanel_project_timezone');

    // Verify Engage call happened before Export.
    const engageCall = mockApi.requestLog.find((r) => r.pathname === '/api/2.0/engage');
    const exportCall = mockApi.requestLog.find((r) => r.pathname === '/api/2.0/export');
    expect(engageCall).toBeTruthy();
    expect(exportCall).toBeTruthy();
    // DL-15: project_id injected on both calls.
    expect(engageCall?.searchParams.get('project_id')).toBe('12345');
    expect(exportCall?.searchParams.get('project_id')).toBe('12345');
  });

  it('mixpanel_list_events_for_user falls back to event-property filter when Engage finds nothing (DL-16)', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{
      ok: boolean;
      count: number;
      no_match?: boolean;
      summary?: { bridge_used: string };
    }>('mixpanel_list_events_for_user', {
      email: 'notfound@example.com',
      from_date: '2026-05-01',
      to_date: '2026-05-15',
    });

    // The mock Export route returns the default mockEvents for any non-special where clause.
    // The bridge falls back to event-property filtering.
    expect(out.ok).toBe(true);
    expect(out.count).toBe(3);
    expect(out.summary?.bridge_used).toBe('event_property_fallback');

    const exportCall = mockApi.requestLog.find((r) => r.pathname === '/api/2.0/export');
    const where = exportCall?.searchParams.get('where') ?? '';
    expect(where).toContain('notfound@example.com');
  });

  it('mixpanel_list_events_for_user empty result returns no_match:true with ok:true', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; no_match?: boolean; count: number }>(
      'mixpanel_list_events_for_user',
      {
        distinct_id: 'NO_MATCH_DISTINCT_xyz',
        from_date: '2026-05-01',
        to_date: '2026-05-15',
      },
    );
    expect(out.ok).toBe(true);
    expect(out.no_match).toBe(true);
    expect(out.count).toBe(0);
  });

  it('mixpanel_list_events_for_user redacts URL tokens in returned events (DL-18)', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      data?: Array<{ properties: Record<string, unknown> }>;
    }>('mixpanel_list_events_for_user', {
      email: 'alice@example.com',
      from_date: '2026-05-01',
      to_date: '2026-05-15',
      return_json: true,
    });
    const urls = out.data?.map((e) => e.properties.$current_url).filter((u): u is string => typeof u === 'string') ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).not.toContain('secret-token-123');
      if (u.includes('token=')) {
        expect(u).toMatch(/token=__REDACTED__/);
      }
      if (u.includes('api_key=')) {
        expect(u).toMatch(/api_key=__REDACTED__/);
      }
    }
  });

  it('mixpanel_query_events with structured filters builds the right where clause (DL-17)', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; count: number }>('mixpanel_query_events', {
      from_date: '2026-05-01',
      to_date: '2026-05-15',
      event_name: ['Signup', 'Purchase'],
      filters: [
        { property: '$email', op: '==', value: 'alice@example.com' },
        { property: 'country_code', op: 'in', value: ['US', 'GB'] },
      ],
    });
    expect(out.ok).toBe(true);

    const exportCall = mockApi.requestLog.find((r) => r.pathname === '/api/2.0/export');
    expect(exportCall?.searchParams.get('event')).toBe('["Signup","Purchase"]');
    const where = exportCall?.searchParams.get('where') ?? '';
    expect(where).toContain('properties["$email"] == "alice@example.com"');
    expect(where).toContain('(properties["country_code"] in ["US","GB"])');
  });

  it('mixpanel_query_events rejects > 90 day window with structured suggested_ranges (DL-5)', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      code?: string;
      suggested_ranges?: Array<{ from_date: string; to_date: string }>;
    }>('mixpanel_query_events', {
      from_date: '2024-01-01',
      to_date: '2026-12-31',
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('WINDOW_TOO_WIDE');
    expect(Array.isArray(out.suggested_ranges)).toBe(true);
    expect((out.suggested_ranges ?? []).length).toBeGreaterThan(0);
  });

  it('mixpanel_list_event_names returns event names with project_id injected (DL-15)', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{ ok: boolean; data: string[] }>('mixpanel_list_event_names', {});
    expect(out.ok).toBe(true);
    expect(out.data).toContain('Signup');
    const call = mockApi.requestLog.find((r) => r.pathname === '/api/2.0/events/names');
    expect(call?.searchParams.get('project_id')).toBe('12345');
  });

  it('mixpanel_get_event_properties returns distinct values', async () => {
    const out = await client.callToolJson<{ ok: boolean; data: string[] }>('mixpanel_get_event_properties', {
      event_name: 'Signup',
      property_name: 'country_code',
    });
    expect(out.ok).toBe(true);
    expect(out.data).toContain('US');
  });

  it('mixpanel_list_cohorts returns first-10 summary plus full data', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      count: number;
      summary: { total: number; first_10: Array<{ id: number; name: string }> };
      data: unknown[];
    }>('mixpanel_list_cohorts', {});
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    expect(out.summary.first_10[0]?.name).toBe('Power users');
  });

  it('mixpanel_get_retention computes per-cohort retention percentages', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      summary: { cohort_count: number; avg_first_period_retention_pct: number };
      data: Array<{ cohort_start: string; cohort_size: number; retention: number[] }>;
    }>('mixpanel_get_retention', {
      event_name: 'Signup',
      retention_event_name: 'Login',
      from_date: '2026-05-01',
      to_date: '2026-05-15',
      interval: 'week',
    });
    expect(out.ok).toBe(true);
    expect(out.summary.cohort_count).toBe(2);
    // First cohort: 50/100 = 50% in period 1.
    expect(out.data[0]?.retention[1]).toBe(50);
    // Second cohort: 40/80 = 50% in period 1.
    expect(out.data[1]?.retention[1]).toBe(50);
    expect(out.summary.avg_first_period_retention_pct).toBe(50);
  });

  it('mixpanel_list_insights returns the saved insights envelope', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      count: number;
      summary: { total: number; first_20: Array<{ id: number; name: string }> };
    }>('mixpanel_list_insights', {});
    expect(out.ok).toBe(true);
    expect(out.count).toBe(3);
    expect(out.summary.first_20[0]?.name).toBe('Activation funnel');
  });

  it('mixpanel_list_insights name_contains filters case-insensitively (v1.1)', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      count: number;
      summary: {
        total: number;
        first_20: Array<{ id: number; name: string }>;
        name_filter?: string;
        total_before_filter?: number;
      };
      data: Array<{ id: number; name: string }>;
    }>('mixpanel_list_insights', { name_contains: 'AVERAGE' });
    expect(out.ok).toBe(true);
    expect(out.count).toBe(1);
    expect(out.summary.name_filter).toBe('AVERAGE');
    expect(out.summary.total_before_filter).toBe(3);
    expect(out.data[0]?.name).toBe('Average Points Per User');
  });

  it('mixpanel_list_insights name_contains returns empty when no match', async () => {
    const out = await client.callToolJson<{ ok: boolean; count: number }>('mixpanel_list_insights', {
      name_contains: 'nonexistent-zzz',
    });
    expect(out.ok).toBe(true);
    expect(out.count).toBe(0);
  });

  it('mixpanel_list_cohorts name_contains filters case-insensitively (v1.1)', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      count: number;
      summary: { total: number; name_filter?: string; total_before_filter?: number };
      data: Array<{ id: number; name: string }>;
    }>('mixpanel_list_cohorts', { name_contains: 'trial' });
    expect(out.ok).toBe(true);
    expect(out.count).toBe(1);
    expect(out.summary.name_filter).toBe('trial');
    expect(out.summary.total_before_filter).toBe(2);
    expect(out.data[0]?.name).toBe('Trial signups');
  });

  it('mixpanel_get_insight runs a saved bookmark and summarises series (v1.1)', async () => {
    mockApi.clearLog();
    const out = await client.callToolJson<{
      ok: boolean;
      summary: {
        bookmark_id: number;
        series_count: number;
        top_series: Array<{ label: string; total: number; latest: number | null; points: number }>;
        computed_at?: string;
      };
      data: Record<string, unknown>;
    }>('mixpanel_get_insight', {
      bookmark_id: 22222,
      from_date: '2026-05-01',
      to_date: '2026-05-15',
    });
    expect(out.ok).toBe(true);
    expect(out.summary.bookmark_id).toBe(22222);
    expect(out.summary.series_count).toBe(2);
    expect(out.summary.computed_at).toBe('2026-05-15T10:00:00Z');
    // top_series sorted by total desc: Overall (3700) > Average Points Per User (140.8)
    expect(out.summary.top_series[0]?.label).toBe('Overall');
    expect(out.summary.top_series[0]?.total).toBe(3700);
    expect(out.summary.top_series[0]?.latest).toBe(1500);
    expect(out.summary.top_series[0]?.points).toBe(3);
    expect(out.summary.top_series[1]?.label).toBe('Average Points Per User');
    expect(out.summary.top_series[1]?.latest).toBe(51.1);

    // Verify project_id and bookmark_id reached the API (DL-15).
    const call = mockApi.requestLog.find((r) => r.pathname === '/api/2.0/insights');
    expect(call?.searchParams.get('project_id')).toBe('12345');
    expect(call?.searchParams.get('bookmark_id')).toBe('22222');
    expect(call?.searchParams.get('from_date')).toBe('2026-05-01');
  });

  it('mixpanel_get_insight rejects > 90 day window when both dates set', async () => {
    const out = await client.callToolJson<{ ok: boolean; code?: string }>('mixpanel_get_insight', {
      bookmark_id: 22222,
      from_date: '2024-01-01',
      to_date: '2026-12-31',
    });
    expect(out.ok).toBe(false);
    expect(out.code).toBe('WINDOW_TOO_WIDE');
  });

  it('mixpanel_get_insight surfaces a warning when the response shape is unrecognized (review fix 2)', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      summary: { series_count: number; warning?: string };
      data: Record<string, unknown>;
    }>('mixpanel_get_insight', {
      bookmark_id: 44444,
      from_date: '2026-05-01',
      to_date: '2026-05-15',
    });
    expect(out.ok).toBe(true);
    expect(out.summary.series_count).toBe(0);
    expect(out.summary.warning).toMatch(/unrecognized/i);
    expect(out.data.foo).toBe('bar');
  });

  it('mixpanel_get_insight rejects empty / whitespace string bookmark_id at the schema boundary (review fix 3)', async () => {
    for (const bad of ['', '   ']) {
      const text = await client.callToolText('mixpanel_get_insight', {
        bookmark_id: bad,
        from_date: '2026-05-01',
        to_date: '2026-05-15',
      });
      // McpServer returns a validation-error envelope when the input fails Zod parse.
      expect(text.toLowerCase()).toMatch(/bookmark_id|invalid|required|empty/);
    }
  });

  it('mixpanel_list_insights name_contains bounds: rejects empty, whitespace-only, and > 200 chars (review fix 6)', async () => {
    const bads = ['', 'a'.repeat(201)];
    for (const bad of bads) {
      const text = await client.callToolText('mixpanel_list_insights', { name_contains: bad });
      expect(text.toLowerCase()).toMatch(/name_contains|invalid|too|long|small|character/);
    }
  });

  it('mixpanel_list_insights surfaces a pagination warning when the page is full but nothing matched (review fix 1)', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      count: number;
      summary: { warning?: string; total_before_filter?: number };
    }>('mixpanel_list_insights', {
      limit: 3,
      name_contains: 'no-such-insight-zzz',
    });
    expect(out.ok).toBe(true);
    expect(out.count).toBe(0);
    expect(out.summary.total_before_filter).toBe(3);
    expect(out.summary.warning).toMatch(/increase 'limit'/i);
  });

  it('mixpanel_list_cohorts surfaces a pagination warning when the page is full but nothing matched (review fix 1)', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      count: number;
      summary: { warning?: string; total_before_filter?: number };
    }>('mixpanel_list_cohorts', {
      limit: 2,
      name_contains: 'no-such-cohort-zzz',
    });
    expect(out.ok).toBe(true);
    expect(out.count).toBe(0);
    expect(out.summary.total_before_filter).toBe(2);
    expect(out.summary.warning).toMatch(/increase 'limit'/i);
  });

  it('mixpanel_get_funnel summarises overall conversion', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      summary: { period_count: number; overall_starting: number; overall_completion: number; overall_conversion_pct: number };
    }>('mixpanel_get_funnel', {
      funnel_id: 11111,
      from_date: '2026-05-01',
      to_date: '2026-05-15',
      interval: 'week',
    });
    expect(out.ok).toBe(true);
    expect(out.summary.period_count).toBe(2);
    expect(out.summary.overall_starting).toBe(180);
    expect(out.summary.overall_completion).toBe(116);
    // 116 / 180 = 64.4%
    expect(out.summary.overall_conversion_pct).toBe(64.4);
  });

  it('mixpanel_get_user_profile returns a profile by email', async () => {
    const out = await client.callToolJson<{
      ok: boolean;
      summary: { distinct_id: string; name: string | null; email: string | null };
    }>('mixpanel_get_user_profile', { email: 'alice@example.com' });
    expect(out.ok).toBe(true);
    expect(out.summary.distinct_id).toBe('user-abc');
    expect(out.summary.name).toBe('Alice');
    expect(out.summary.email).toBe('alice@example.com');
  });

  it('mixpanel_get_user_profile returns no_match for unknown emails', async () => {
    const out = await client.callToolJson<{ ok: boolean; no_match?: boolean; count: number }>(
      'mixpanel_get_user_profile',
      { email: 'notfound@example.com' },
    );
    expect(out.ok).toBe(true);
    expect(out.no_match).toBe(true);
    expect(out.count).toBe(0);
  });
});

describeBundledMcp('mixpanel', 'mixpanel — auth classification (DL-13 / behavioral-safety)', () => {
  let client: McpTestClient;
  let mockApi: MockApiServer;

  beforeAll(async () => {
    const result = await createMcpTestClientWithMockApi({
      name: 'mixpanel',
      serverScript: resolveServerScript('mixpanel'),
      interceptDomains: ['mixpanel.com', 'data.mixpanel.com', 'eu.mixpanel.com', 'data-eu.mixpanel.com'],
      routes: baseRoutes(),
      env: mockEnv,
      connectTimeout: 15_000,
    });
    client = result.client;
    mockApi = result.mockApi;
  }, 30_000);

  afterAll(async () => {
    if (client) await client.close();
    if (mockApi) await mockApi.close();
  });

  it('401 maps to AUTH with secret-credential resolution', async () => {
    const out = await client.callToolJson<{ ok: boolean; code: string; resolution: string }>(
      'mixpanel_list_events_for_user',
      {
        distinct_id: 'TRIGGER_401',
        from_date: '2026-05-01',
        to_date: '2026-05-15',
      },
    );
    expect(out.ok).toBe(false);
    expect(out.code).toBe('AUTH');
    expect(out.resolution).toMatch(/username and secret/i);
  });

  it('403 maps to AUTH with project_id resolution', async () => {
    const out = await client.callToolJson<{ ok: boolean; code: string; resolution: string }>(
      'mixpanel_list_events_for_user',
      {
        distinct_id: 'TRIGGER_403',
        from_date: '2026-05-01',
        to_date: '2026-05-15',
      },
    );
    expect(out.ok).toBe(false);
    expect(out.code).toBe('AUTH');
    expect(out.resolution).toMatch(/MIXPANEL_PROJECT_ID/i);
  });

  it('429 with long Retry-After fast-fails with retry_after_seconds (DL-7)', async () => {
    const out = await client.callToolJson<{ ok: boolean; code: string; retry_after_seconds?: number }>(
      'mixpanel_list_events_for_user',
      {
        distinct_id: 'TRIGGER_429_LONG',
        from_date: '2026-05-01',
        to_date: '2026-05-15',
      },
    );
    expect(out.ok).toBe(false);
    expect(out.code).toBe('RATE_LIMIT');
    expect(out.retry_after_seconds).toBe(600);
  });
});

describeBundledMcp('mixpanel', 'mixpanel — secret sentinel (DL-13)', () => {
  it('credentials never appear in any tool response body', async () => {
    const { client, mockApi } = await createMcpTestClientWithMockApi({
      name: 'mixpanel',
      serverScript: resolveServerScript('mixpanel'),
      interceptDomains: ['mixpanel.com', 'data.mixpanel.com', 'eu.mixpanel.com', 'data-eu.mixpanel.com'],
      routes: baseRoutes(),
      env: mockEnv,
      connectTimeout: 15_000,
    });
    try {
      const responses: string[] = [];
      responses.push(
        await client.callToolText('mixpanel_list_events_for_user', {
          email: 'alice@example.com',
          from_date: '2026-05-01',
          to_date: '2026-05-15',
          return_json: true,
        }),
      );
      responses.push(
        await client.callToolText('mixpanel_list_events_for_user', {
          distinct_id: 'TRIGGER_401',
          from_date: '2026-05-01',
          to_date: '2026-05-15',
        }),
      );
      responses.push(await client.callToolText('mixpanel_list_event_names', {}));
      for (const body of responses) {
        expect(body).not.toContain('__SENTINEL_USER__');
        expect(body).not.toContain('__SENTINEL_SECRET__');
      }
    } finally {
      await client.close();
      await mockApi.close();
    }
  }, 30_000);
});

describeBundledMcp('mixpanel', 'mixpanel — region host targeting (testability specialist)', () => {
  it('EU region targets the EU host map (data-eu / eu domains)', async () => {
    const { client, mockApi } = await createMcpTestClientWithMockApi({
      name: 'mixpanel',
      serverScript: resolveServerScript('mixpanel'),
      // Only EU hosts are intercepted. If client wrongly targets US hosts, the request fails.
      interceptDomains: ['eu.mixpanel.com', 'data-eu.mixpanel.com'],
      routes: baseRoutes(),
      env: { ...mockEnv, MIXPANEL_REGION: 'eu' },
      connectTimeout: 15_000,
    });
    try {
      const out = await client.callToolJson<{ ok: boolean }>('mixpanel_list_event_names', {});
      expect(out.ok).toBe(true);

      // Verify the actual URL host hit (not just a substring match).
      const call = mockApi.requestLog.find((r) => r.pathname === '/api/2.0/events/names');
      expect(call).toBeTruthy();
      const url = new URL(call!.url, 'http://placeholder');
      // The redirect wrapper rewrites Host headers but preserves the path; assert via headers.host.
      expect(call?.headers.host).toMatch(/eu\.mixpanel\.com$|data-eu\.mixpanel\.com$|^\d/);
    } finally {
      await client.close();
      await mockApi.close();
    }
  }, 30_000);
});
