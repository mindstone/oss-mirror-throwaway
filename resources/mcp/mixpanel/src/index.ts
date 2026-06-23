#!/usr/bin/env node
/**
 * Mixpanel MCP server entry point.
 *
 * Plan: docs/plans/260515_mixpanel_mcp.md
 * Stages 3+ register tools below; Stage 1 shipped the skeleton with zero tools
 * and a manual ListTools handler returning [].
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { MixpanelClient } from './client.js';
import { MixpanelError } from './types.js';
import {
  getEventPropertiesSchema,
  listEventNamesSchema,
  listEventsForUserSchema,
  mixpanelGetEventProperties,
  mixpanelListEventNames,
  mixpanelListEventsForUser,
  mixpanelQueryEvents,
  queryEventsSchema,
} from './tools/events.js';
import {
  getRetentionSchema,
  listCohortsSchema,
  mixpanelGetRetention,
  mixpanelListCohorts,
} from './tools/cohorts.js';
import {
  getFunnelSchema,
  getInsightSchema,
  listInsightsSchema,
  mixpanelGetFunnel,
  mixpanelGetInsight,
  mixpanelListInsights,
} from './tools/funnels.js';
import { getUserProfileSchema, mixpanelGetUserProfile } from './tools/profiles.js';

const server = new McpServer({ name: 'mixpanel-mcp-server', version: '0.1.0' });

let _client: MixpanelClient | undefined;
const getClient = (): MixpanelClient => {
  if (_client === undefined) {
    _client = new MixpanelClient();
  }
  return _client;
};

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const withErrorHandling = async (fn: () => Promise<string>): Promise<string> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MixpanelError) {
      const payload: Record<string, unknown> = {
        ok: false,
        code: err.code,
        error: err.message,
        resolution: err.resolution,
      };
      return JSON.stringify(payload);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return JSON.stringify({
      ok: false,
      code: 'API_ERROR',
      error: msg,
      resolution: 'Mixpanel returned an unexpected error. Try again.',
    });
  }
};

server.registerTool(
  'mixpanel_list_events_for_user',
  {
    title: 'List Mixpanel events for a user',
    description: `List events for a single Mixpanel user identified by email (preferred) or distinct_id, within a date range.

WORKFLOW:
- Provide an email OR a distinct_id (Mixpanel's stable per-user identifier). If both, distinct_id wins.
- Mixpanel Export uses the project's local timezone for from_date / to_date. Use YYYY-MM-DD.
- When only email is provided, this tool first calls Engage to resolve the distinct_id, then queries events.
  If no profile matches the email, it falls back to filtering events where properties["$email"] or properties["email"] equals the address.
- The response always includes a compact summary (counts, first/last seen, top events). Pass return_json:true for the full event list (capped at 100 events).

RELATED TOOLS:
- mixpanel_query_events for time-bounded queries without a single-user filter.
- mixpanel_get_user_profile for the People profile alone.

RETURNS:
- JSON with ok, summary, count, timezone_basis, truncated, optional data.`,
    annotations: readOnlyAnnotations,
    inputSchema: listEventsForUserSchema,
  },
  async (input) =>
    textResult(await withErrorHandling(() => mixpanelListEventsForUser(getClient(), input))),
);

server.registerTool(
  'mixpanel_query_events',
  {
    title: 'Query Mixpanel events',
    description: `Ad-hoc Mixpanel event query for a date range, optionally filtered by event name(s) and structured property filters.

WORKFLOW:
- Always provide from_date and to_date (YYYY-MM-DD, project local timezone). The window must be ≤ 90 days.
- Use event_name (string or array) to narrow by event type.
- Use filters (array of {property, op, value}) for structured property filters. Supported ops: ==, !=, in, not_in, is_set, is_not_set. Top-level AND only — no OR / nesting / contains in v1.
- Response defaults to a compact summary. Pass return_json:true for the full event list (hard cap 500).

RELATED TOOLS:
- mixpanel_list_events_for_user for per-user queries.
- mixpanel_list_event_names / mixpanel_get_event_properties for schema discovery before filtering.

RETURNS:
- JSON with ok, summary, count, timezone_basis, truncated, optional data.`,
    annotations: readOnlyAnnotations,
    inputSchema: queryEventsSchema,
  },
  async (input) =>
    textResult(await withErrorHandling(() => mixpanelQueryEvents(getClient(), input))),
);

server.registerTool(
  'mixpanel_list_event_names',
  {
    title: 'List Mixpanel event names',
    description: `List the event names tracked in the Mixpanel project. Schema discovery for event_name filters.

WORKFLOW:
- Use type='general' for all tracked events, 'average' for events with numeric properties, 'unique' for unique-by-user counts.
- Use the returned event names with mixpanel_query_events / mixpanel_get_event_properties.

RETURNS:
- JSON with ok, summary, count, data (string array of event names).`,
    annotations: readOnlyAnnotations,
    inputSchema: listEventNamesSchema,
  },
  async (input) =>
    textResult(await withErrorHandling(() => mixpanelListEventNames(getClient(), input))),
);

server.registerTool(
  'mixpanel_get_event_properties',
  {
    title: 'Get Mixpanel event property values',
    description: `List distinct values seen for a single property on a single event.

WORKFLOW:
- Use mixpanel_list_event_names to find event_name.
- Use this to discover what values a property takes (e.g. distinct country_code values seen on Signup events).
- Returns up to 255 distinct values by default.

RETURNS:
- JSON with ok, summary, count, data (array of distinct values).`,
    annotations: readOnlyAnnotations,
    inputSchema: getEventPropertiesSchema,
  },
  async (input) =>
    textResult(await withErrorHandling(() => mixpanelGetEventProperties(getClient(), input))),
);

server.registerTool(
  'mixpanel_list_cohorts',
  {
    title: 'List Mixpanel cohorts',
    description: `List saved Mixpanel cohorts (user segments) in the project.

WORKFLOW:
- Use this to discover available cohorts before scoping a retention analysis.
- The returned cohort IDs can be passed as cohort_id to mixpanel_get_retention.
- Use name_contains to narrow by case-insensitive substring (e.g. "trial" or "paid"). Filtering happens client-side after the fetch.

RETURNS:
- JSON with ok, summary (first 10, plus name_filter when supplied), count, data (filtered cohort list).`,
    annotations: readOnlyAnnotations,
    inputSchema: listCohortsSchema,
  },
  async (input) =>
    textResult(await withErrorHandling(() => mixpanelListCohorts(getClient(), input))),
);

server.registerTool(
  'mixpanel_get_retention',
  {
    title: 'Get Mixpanel retention report',
    description: `Run a retention analysis: of users who did event A, how many also did event B in each subsequent period?

WORKFLOW:
- event_name = the cohort-defining ("born") event (e.g. "Signup").
- retention_event_name = the return event (defaults to event_name for self-retention).
- interval = day | week | month bucket size.
- Optional cohort_id scopes the analysis to a saved Mixpanel cohort.
- Window must be ≤ 90 days.

RETURNS:
- JSON with ok, summary (cohort count, avg first-period retention %), data (per-cohort retention curves as percentages).`,
    annotations: readOnlyAnnotations,
    inputSchema: getRetentionSchema,
  },
  async (input) =>
    textResult(await withErrorHandling(() => mixpanelGetRetention(getClient(), input))),
);

server.registerTool(
  'mixpanel_list_insights',
  {
    title: 'List Mixpanel saved insights',
    description: `List saved Mixpanel insights (reports / bookmarks) in the project.

WORKFLOW:
- Use this to discover available saved reports and find a funnel_id for mixpanel_get_funnel or a bookmark_id for mixpanel_get_insight.
- Optionally scope by workspace_id or bookmark_id.
- Use name_contains to narrow by case-insensitive substring (e.g. "average points" or "activation"). Filtering happens client-side after the fetch.

RETURNS:
- JSON with ok, summary (first 20, plus name_filter when supplied), count, data.`,
    annotations: readOnlyAnnotations,
    inputSchema: listInsightsSchema,
  },
  async (input) =>
    textResult(await withErrorHandling(() => mixpanelListInsights(getClient(), input))),
);

server.registerTool(
  'mixpanel_get_insight',
  {
    title: 'Get Mixpanel saved insight result',
    description: `Run a saved Mixpanel insight (bookmark / report) and return its computed series.

WORKFLOW:
- bookmark_id is required. Find it with mixpanel_list_insights (use name_contains to search by name) or from the Mixpanel UI URL.
- Optional from_date / to_date override the insight's saved window. Window must be ≤ 90 days when both are set.
- Use this for saved metrics that aren't funnels — e.g. "Average Points Per User", "Weekly DAU", "Trial conversion %".

RELATED TOOLS:
- mixpanel_list_insights to discover bookmark IDs by name.
- mixpanel_get_funnel for saved funnels specifically (richer per-step summary).

RETURNS:
- JSON with ok, summary (top series totals + latest values), data (raw Mixpanel response).`,
    annotations: readOnlyAnnotations,
    inputSchema: getInsightSchema,
  },
  async (input) =>
    textResult(await withErrorHandling(() => mixpanelGetInsight(getClient(), input))),
);

server.registerTool(
  'mixpanel_get_funnel',
  {
    title: 'Get Mixpanel funnel result',
    description: `Run a saved Mixpanel funnel for a date range and return per-step conversion.

WORKFLOW:
- funnel_id is required. Find it via mixpanel_list_insights or copy from the Mixpanel UI URL.
- Window must be ≤ 90 days.
- Use interval (day/week/month) for the funnel time series.

RETURNS:
- JSON with ok, summary (period count, overall conversion %), data (raw Mixpanel funnel response).`,
    annotations: readOnlyAnnotations,
    inputSchema: getFunnelSchema,
  },
  async (input) =>
    textResult(await withErrorHandling(() => mixpanelGetFunnel(getClient(), input))),
);

server.registerTool(
  'mixpanel_get_user_profile',
  {
    title: 'Get Mixpanel user profile',
    description: `Fetch a Mixpanel Engage (People) profile by distinct_id or email.

WORKFLOW:
- Provide distinct_id (preferred) or email. If both, distinct_id wins.
- Returns a one-line summary (name, email, last seen) plus the full profile properties.

RELATED TOOLS:
- mixpanel_list_events_for_user for the user's event history.

RETURNS:
- JSON with ok, summary, count, data, plus no_match:true when no profile is found.`,
    annotations: readOnlyAnnotations,
    inputSchema: getUserProfileSchema,
  },
  async (input) =>
    textResult(await withErrorHandling(() => mixpanelGetUserProfile(getClient(), input))),
);

const transport = new StdioServerTransport();
server
  .connect(transport)
  .then(() => {
    console.error('[Mixpanel] Server started');
  })
  .catch((err) => {
    console.error('[Mixpanel] Failed to start', err);
    process.exit(1);
  });
