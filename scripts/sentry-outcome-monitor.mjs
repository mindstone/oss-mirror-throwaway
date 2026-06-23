#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  alignHourlyRowsToIntervals,
  buildDigestMessage,
  buildOutcomeSeriesIndex,
  classifySentryHttpError,
  deriveCheckFRead,
  describeSentryTokenSource,
  evaluateCheckA,
  evaluateCheckB,
  evaluateCheckC,
  evaluateCheckE,
  evaluateCheckF,
  evaluateCheckG,
  evaluateCheckH,
  evaluateMonitorSelfHealth,
  formatCheckAAlert,
  formatCheckBAlert,
  formatCheckCNotice,
  formatCheckEAlert,
  formatCheckFAlert,
  formatCheckGAlert,
  formatCheckHAlert,
  formatSelfHealthEscalation,
  formatSelfHealthEscalationPersistFailureWarning,
  isDailyDigestRun,
  shouldPostSelfHealthEscalation,
  shouldWarnSelfHealthEscalationSuppressed,
  makeEventRecord,
  MONITOR_RUN_INTERVAL_HOURS,
  CHECK_G_WINDOW_HOURS,
  PERMFAIL_DETECTION_WINDOW_HOURS,
  SAFETY_DEGRADED_SUSTAINED_DAYS,
  SAFETY_DEGRADED_DAY_WINDOW_HOURS,
  parsePermanentFailureAggregateRow,
  parseSentryEventCountRow,
  parseSelfHealthState,
  resolveSentryToken,
  serializeSelfHealthState,
  sumFamilyHourly,
  summarizeCategoryTotals,
} from './lib/outcomeMonitorChecks.mjs';

const PROJECT_ID = '4510399226839040';
const SENTRY_ORG = 'mindstone';
const SENTRY_API_BASE_URL = 'https://us.sentry.io';
const POSTHOG_DEFAULT_HOST = 'https://eu.posthog.com';
const RUNBOOK_PATH = 'docs/project/SENTRY_TRIAGE.md';
const LOOKBACK_7D_MS = 7 * 24 * 60 * 60 * 1000;
const LOOKBACK_26H_MS = 26 * 60 * 60 * 1000;

const ENV_FILES = ['.env', '.env.local'];

function loadEnvFiles(projectRoot) {
  for (const envFile of ENV_FILES) {
    const envPath = path.join(projectRoot, envFile);
    if (!existsSync(envPath)) continue;

    const source = readFileSync(envPath, 'utf8');
    for (const rawLine of source.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const delimiter = line.indexOf('=');
      if (delimiter <= 0) continue;

      const key = line.slice(0, delimiter).trim();
      let value = line.slice(delimiter + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }

      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

function usage() {
  return [
    'Usage: node scripts/sentry-outcome-monitor.mjs [--dry-run] [--verify-setup] [--now <iso8601>]',
    '',
    'Modes:',
    '  --dry-run       Print messages instead of posting to Slack.',
    '  --verify-setup  Check dependency readiness (Sentry/PostHog/Slack) and exit.',
    '  --now           Override current timestamp (ISO-8601), for deterministic tests.',
  ].join('\n');
}

function optionalEnv(name) {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : null;
}

async function sentryApiGet(pathname, query, token) {
  const url = new URL(pathname, SENTRY_API_BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
    } else if (value !== undefined && value !== null) {
      url.searchParams.append(key, String(value));
    }
  }

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    const { message } = classifySentryHttpError(response.status, response.statusText, text, {
      org: SENTRY_ORG,
      region: new URL(SENTRY_API_BASE_URL).host,
    });
    throw new Error(message);
  }

  return {
    json: await response.json(),
    headers: response.headers,
  };
}

function parseSentryNextCursor(linkHeader) {
  if (!linkHeader) return null;
  const parts = linkHeader.split(',').map((part) => part.trim());
  for (const part of parts) {
    if (!part.includes('rel="next"') || !part.includes('results="true"')) {
      continue;
    }
    const match = part.match(/cursor="([^"]+)"/);
    if (match) {
      return match[1];
    }
  }
  return null;
}

async function fetchSentryOutcomeStats({ token, category }) {
  const { json } = await sentryApiGet(
    `/api/0/organizations/${encodeURIComponent(SENTRY_ORG)}/stats_v2/`,
    {
      project: PROJECT_ID,
      statsPeriod: '9d',
      interval: '1h',
      groupBy: ['outcome', 'reason'],
      field: 'sum(quantity)',
      category,
    },
    token,
  );
  return json;
}

async function fetchSentryIndexedBugReportEvents({ token, startIso, endIso }) {
  const events = [];
  let cursor = null;

  for (;;) {
    const query = {
      project: PROJECT_ID,
      // `dataset` is a required query param on the current Sentry org events
      // (Explore table) endpoint; these bug-report events are error events.
      // Omitting it makes the scheduled checks B/C fail with a 400 even once
      // the token scope is fixed — the classified error surfaces that loudly.
      dataset: 'errors',
      field: ['id', 'timestamp'],
      query: 'source:user-bug-report',
      sort: '-timestamp',
      start: startIso,
      end: endIso,
      per_page: 100,
    };
    if (cursor) {
      query.cursor = cursor;
    }

    const { json, headers } = await sentryApiGet(
      `/api/0/organizations/${encodeURIComponent(SENTRY_ORG)}/events/`,
      query,
      token,
    );

    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const row of rows) {
      const eventId = typeof row?.id === 'string' ? row.id : '';
      const timestamp = typeof row?.timestamp === 'string' ? row.timestamp : '';
      if (!eventId || !timestamp) continue;
      events.push(makeEventRecord(eventId, timestamp));
    }

    cursor = parseSentryNextCursor(headers.get('link'));
    if (!cursor) break;
  }

  return events;
}

// Check F (mobile offline-queue permanent-failure surge). Mirrors the
// fetchSentryIndexedBugReportEvents shape — same `/events/` errors-dataset endpoint,
// same `dataset='errors'` requirement, same classified-error-on-non-OK behaviour —
// but requests the server-side aggregate `count_unique(user)` / `count()` over a
// window instead of paging individual rows. Scoped to `environment:production`
// (Amendment A1-F3 — calibration confirmed all live permanent-failure events are
// production; this keeps future dev/simulator traffic from false-paging).
//
// Row handling is in the pure `parsePermanentFailureAggregateRow` helper:
//   - a parseable zero row OR an empty `data: []` → `{ distinctUsers: 0, events: 0 }`
//     (the COMMON HEALTHY zero case → verdict `quiet`; NOT `unavailable`);
//   - a present-but-unparseable body (missing/non-finite count fields, no `data`
//     array) → `null` → caller maps to verdict=`unavailable` AND degrades the Sentry
//     dependency for self-health (Amendment A1-F2: never silently `quiet`).
// A non-OK HTTP response still throws (classifier) so the rejected promise marks
// `sentry_events` degraded and verify-setup/self-health surface it loudly.
async function fetchSentryPermanentFailureAggregate({ token, startIso, endIso }) {
  const { json } = await sentryApiGet(
    `/api/0/organizations/${encodeURIComponent(SENTRY_ORG)}/events/`,
    {
      project: PROJECT_ID,
      dataset: 'errors',
      field: ['count_unique(user)', 'count()'],
      query: 'queue_event:item-permanent-failure environment:production',
      start: startIso,
      end: endIso,
      per_page: 1,
    },
    token,
  );

  return parsePermanentFailureAggregateRow(json);
}

// Check H (safety-eval degradation surge, reasonKind:billing). Mirrors
// fetchSentryPermanentFailureAggregate exactly — same `/events/` errors-dataset
// endpoint, same `count_unique(user)`/`count()` aggregate fields, same classified-
// error-on-non-OK behaviour, same `parsePermanentFailureAggregateRow` legitimate-zero
// vs malformed handling — but queries the safety-eval fail-closed message tagged
// `reasonKind:billing`. Scoped to `environment:production` so dev/simulator traffic
// can't false-page. The producer is `recordSafetyEvalFailed` (safetyPromptLogic.ts),
// which emits a `Safety eval fail-closed` Sentry message with a `reasonKind` tag.
async function fetchSentrySafetyEvalDegradedAggregate({ token, startIso, endIso }) {
  const { json } = await sentryApiGet(
    `/api/0/organizations/${encodeURIComponent(SENTRY_ORG)}/events/`,
    {
      project: PROJECT_ID,
      dataset: 'errors',
      field: ['count_unique(user)', 'count()'],
      query: 'message:"Safety eval fail-closed" reasonKind:billing environment:production',
      start: startIso,
      end: endIso,
      per_page: 1,
    },
    token,
  );

  return parsePermanentFailureAggregateRow(json);
}

// Check G (bug-report delivery reconciliation). Window-level COUNT of
// `source:user-bug-report` Sentry events — the Sentry side of the PostHog↔Sentry
// reconcile. Same `/events/` errors-dataset endpoint + classified-error-on-non-OK
// behaviour as the other reads. `parseSentryEventCountRow` makes the legitimate-zero
// vs malformed distinction (zero/`data:[]` → 0; unparseable → null → `unavailable`).
async function fetchSentryUserBugReportCount({ token, startIso, endIso }) {
  const { json } = await sentryApiGet(
    `/api/0/organizations/${encodeURIComponent(SENTRY_ORG)}/events/`,
    {
      project: PROJECT_ID,
      dataset: 'errors',
      field: ['count()'],
      query: 'source:user-bug-report',
      start: startIso,
      end: endIso,
      per_page: 1,
    },
    token,
  );
  return parseSentryEventCountRow(json);
}

async function posthogQuery({ host, projectId, apiKey, hogqlQuery }) {
  const url = new URL(`/api/projects/${encodeURIComponent(projectId)}/query/`, host);
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: {
        kind: 'HogQLQuery',
        query: hogqlQuery,
      },
    }),
  });

  const bodyText = await response.text();
  let parsedBody = null;
  try {
    parsedBody = JSON.parse(bodyText);
  } catch {
    parsedBody = null;
  }

  if (!response.ok) {
    const summary = parsedBody ? JSON.stringify(parsedBody).slice(0, 300) : bodyText.slice(0, 300);
    throw new Error(`PostHog API ${response.status} ${response.statusText}: ${summary}`);
  }

  return parsedBody;
}

function sqlQuote(value) {
  return String(value).replace(/'/g, "''");
}

function rowToObject(columns, row) {
  if (row && typeof row === 'object' && !Array.isArray(row)) {
    return row;
  }
  if (!Array.isArray(row)) {
    return {};
  }
  const out = {};
  for (let i = 0; i < columns.length; i += 1) {
    out[columns[i]] = row[i];
  }
  return out;
}

async function fetchPosthogTrackedBugReportEvents({ host, projectId, apiKey, startIso, endIso }) {
  const hogql = [
    "SELECT",
    "  properties.sentry_event_id AS sentry_event_id,",
    "  timestamp AS ts,",
    "  properties.app_version AS app_version,",
    "  properties.channel AS channel",
    "FROM events",
    "WHERE event = 'Bug Report Submitted'",
    `  AND timestamp >= toDateTime('${sqlQuote(startIso)}')`,
    `  AND timestamp <= toDateTime('${sqlQuote(endIso)}')`,
    "  AND properties.sentry_event_id IS NOT NULL",
    "  AND properties.sentry_event_id != ''",
    'ORDER BY timestamp DESC',
    'LIMIT 10000',
  ].join('\n');

  const payload = await posthogQuery({ host, projectId, apiKey, hogqlQuery: hogql });
  const columns = Array.isArray(payload?.columns) ? payload.columns : [];
  const results = Array.isArray(payload?.results) ? payload.results : [];

  const events = [];
  for (const result of results) {
    const row = rowToObject(columns, result);
    const eventId = typeof row.sentry_event_id === 'string' ? row.sentry_event_id.trim() : '';
    const timestamp = typeof row.ts === 'string' ? row.ts : '';
    if (!eventId || !timestamp) continue;

    events.push(
      makeEventRecord(eventId, timestamp, {
        appVersion: typeof row.app_version === 'string' ? row.app_version : null,
        channel: typeof row.channel === 'string' ? row.channel : null,
      }),
    );
  }

  return events;
}

// Check G — PostHog side: total `Bug Report Submitted` submissions in the window.
// Unlike fetchPosthogTrackedBugReportEvents (which requires a non-empty
// sentry_event_id, for the per-id check A), this counts ALL submissions — that is
// the honest "how many users said they submitted" denominator. Returns a number, or
// null when the response shape is unparseable (→ check G `unavailable`).
async function fetchPosthogBugReportSubmittedCount({ host, projectId, apiKey, startIso, endIso }) {
  const hogql = [
    'SELECT count() AS c',
    'FROM events',
    "WHERE event = 'Bug Report Submitted'",
    `  AND timestamp >= toDateTime('${sqlQuote(startIso)}')`,
    `  AND timestamp <= toDateTime('${sqlQuote(endIso)}')`,
  ].join('\n');

  const payload = await posthogQuery({ host, projectId, apiKey, hogqlQuery: hogql });
  const columns = Array.isArray(payload?.columns) ? payload.columns : [];
  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (results.length === 0) return 0;

  const row = rowToObject(columns, results[0]);
  const value = Number(row.c);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

async function fetchPosthogApplicationOpenedHourly({ host, projectId, apiKey, startIso, endIso }) {
  const hogql = [
    'SELECT',
    '  toStartOfHour(timestamp) AS hour,',
    '  count() AS c',
    'FROM events',
    "WHERE event = 'Application Opened'",
    `  AND timestamp >= toDateTime('${sqlQuote(startIso)}')`,
    `  AND timestamp <= toDateTime('${sqlQuote(endIso)}')`,
    'GROUP BY hour',
    'ORDER BY hour',
  ].join('\n');

  const payload = await posthogQuery({ host, projectId, apiKey, hogqlQuery: hogql });
  const columns = Array.isArray(payload?.columns) ? payload.columns : [];
  const results = Array.isArray(payload?.results) ? payload.results : [];

  const rows = [];
  for (const result of results) {
    const row = rowToObject(columns, result);
    const hour = typeof row.hour === 'string' ? row.hour : '';
    if (!hour) continue;
    rows.push({ hour, count: row.c });
  }

  return rows;
}

async function postSlackMessage({ webhook, text }) {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Slack webhook ${response.status} ${response.statusText}: ${body.slice(0, 300)}`);
  }
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function nowFromArgs(argValue) {
  if (!argValue) return Date.now();
  const parsed = Date.parse(argValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid --now value: ${argValue}`);
  }
  return parsed;
}

function printDryRunMessage(title, text) {
  process.stdout.write(`\n[dry-run] ${title}\n${text}\n`);
}

function setupResult(name, ok, detail) {
  return { name, ok, detail };
}

function resolveSelfHealthStatePath(projectRoot) {
  const fromEnv = optionalEnv('MONITOR_SELF_HEALTH_STATE_FILE');
  if (fromEnv) {
    return path.isAbsolute(fromEnv) ? fromEnv : path.join(projectRoot, fromEnv);
  }
  return path.join(projectRoot, '.monitor-state', 'self-health.json');
}

function readSelfHealthStateFile(statePath) {
  try {
    if (!existsSync(statePath)) {
      return parseSelfHealthState('');
    }
    return parseSelfHealthState(readFileSync(statePath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stdout.write(`sentry-outcome-monitor: WARNING failed to read self-health state (${reason}); using default.\n`);
    return parseSelfHealthState('');
  }
}

function writeSelfHealthStateFile(statePath, state, dryRun) {
  if (dryRun) return false;
  try {
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, serializeSelfHealthState(state), 'utf8');
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stdout.write(`sentry-outcome-monitor: WARNING failed to write self-health state (${reason}).\n`);
    return false;
  }
}

function settledErrorReason(result) {
  if (!result || result.status !== 'rejected') return null;
  const reason = result.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

function buildPosthogDependencyStatuses({
  posthogCredsPresent,
  trackedResult,
  livenessResult,
}) {
  if (!posthogCredsPresent) {
    return {
      posthogTrackedStatus: 'blind',
      posthogLivenessStatus: 'blind',
    };
  }

  return {
    posthogTrackedStatus: trackedResult?.status === 'fulfilled' ? 'ok' : 'fail',
    posthogLivenessStatus: livenessResult?.status === 'fulfilled' ? 'ok' : 'fail',
  };
}

function buildMonitorDependencies({
  sentryStatsStatus,
  sentryEventsStatus,
  posthogTrackedStatus,
  posthogLivenessStatus,
}) {
  return [
    { name: 'sentry_stats', status: sentryStatsStatus },
    { name: 'sentry_events', status: sentryEventsStatus },
    { name: 'posthog_liveness', status: posthogLivenessStatus },
    { name: 'posthog_tracked', status: posthogTrackedStatus },
  ];
}

async function runSelfHealthStep({
  projectRoot,
  dryRun,
  dependencies,
  slackWebhook,
}) {
  const statePath = resolveSelfHealthStatePath(projectRoot);
  const priorState = readSelfHealthStateFile(statePath);
  const selfHealth = evaluateMonitorSelfHealth({ dependencies, priorState });
  const persisted = writeSelfHealthStateFile(statePath, selfHealth.nextState, dryRun);

  process.stdout.write(
    `selfHealth: degraded=${selfHealth.degraded}, consecutive=${selfHealth.consecutiveDegradedRuns}, `
      + `shouldEscalate=${selfHealth.shouldEscalate}, escalationKind=${selfHealth.escalationKind}, `
      + `blind=[${selfHealth.blindDependencies.join(', ')}], failed=[${selfHealth.failedDependencies.join(', ')}]\n`,
  );

  const messages = [];
  if (selfHealth.shouldEscalate) {
    if (shouldWarnSelfHealthEscalationSuppressed({ shouldEscalate: true, persisted, dryRun })) {
      process.stdout.write(`${formatSelfHealthEscalationPersistFailureWarning({ selfHealth })}\n`);
    } else {
      messages.push({
        title: 'self-health-escalation',
        text: formatSelfHealthEscalation({
          selfHealth,
          runIntervalHours: MONITOR_RUN_INTERVAL_HOURS,
          runbookPath: RUNBOOK_PATH,
        }),
      });
    }
  }

  if (messages.length > 0) {
    for (const message of messages) {
      if (dryRun) {
        printDryRunMessage(message.title, message.text);
        continue;
      }
      if (!shouldPostSelfHealthEscalation({ shouldEscalate: true, persisted, dryRun })) {
        continue;
      }
      if (!slackWebhook) {
        throw new Error('Missing required environment variable: SLACK_WEBHOOK');
      }
      await postSlackMessage({ webhook: slackWebhook, text: message.text });
      process.stdout.write(`posted Slack message: ${message.title}\n`);
    }
  }

  return selfHealth;
}

async function runVerifySetup({ dryRun }) {
  const { token: sentryToken, source: sentryTokenSource, usedFallback } = resolveSentryToken(process.env);
  const posthogKey = optionalEnv('POSTHOG_PERSONAL_API_KEY');
  const posthogProjectId = optionalEnv('POSTHOG_PROJECT_ID');
  const posthogHost = optionalEnv('POSTHOG_HOST') ?? POSTHOG_DEFAULT_HOST;
  const slackWebhook = optionalEnv('SLACK_WEBHOOK');

  const results = [];

  // Make the chosen token source observable on BOTH pass and fail: a silent
  // fallback to the shared (release-scoped) token is exactly how this dependency
  // went blind. Naming it on the 403 FAIL line is the key operational signal.
  const tokenNote = describeSentryTokenSource({ source: sentryTokenSource, usedFallback });

  if (!sentryToken) {
    results.push(setupResult('sentry_read', false, 'missing SENTRY_MONITOR_AUTH_TOKEN and SENTRY_AUTH_TOKEN'));
    results.push(setupResult('sentry_events_read', false, 'missing SENTRY_MONITOR_AUTH_TOKEN and SENTRY_AUTH_TOKEN'));
  } else {
    try {
      await sentryApiGet(
        `/api/0/organizations/${encodeURIComponent(SENTRY_ORG)}/stats_v2/`,
        {
          project: PROJECT_ID,
          statsPeriod: '1d',
          interval: '1h',
          groupBy: ['outcome', 'reason'],
          field: 'sum(quantity)',
          category: 'error',
        },
        sentryToken,
      );
      results.push(setupResult('sentry_read', true, `stats_v2 query succeeded${tokenNote}`));
    } catch (error) {
      results.push(setupResult('sentry_read', false, `${error instanceof Error ? error.message : String(error)}${tokenNote}`));
    }

    // Probe the org events (Explore) endpoint too — the scheduled run depends on
    // it for checks B/C, but the original verify-setup only checked stats_v2, so
    // a scope gap or the required `dataset` param could pass setup and still fail
    // the real run.
    try {
      await sentryApiGet(
        `/api/0/organizations/${encodeURIComponent(SENTRY_ORG)}/events/`,
        {
          project: PROJECT_ID,
          dataset: 'errors',
          field: ['id', 'timestamp'],
          query: 'source:user-bug-report',
          statsPeriod: '1d',
          per_page: 1,
        },
        sentryToken,
      );
      results.push(setupResult('sentry_events_read', true, `events query succeeded${tokenNote}`));
    } catch (error) {
      results.push(setupResult('sentry_events_read', false, `${error instanceof Error ? error.message : String(error)}${tokenNote}`));
    }

    // Probe the EXACT check-F aggregate shape AND parse it (GPT-F2). Check F's
    // real-run reads differ from the bug-report read above by using aggregate field
    // aliases (count_unique(user)/count()) + a tag filter, so a scope/dataset/field-alias
    // gap specific to that shape must fail setup LOUDLY here. A bare 2xx is NOT enough:
    // a field-alias drift could 200 with an unparseable body and then silently degrade
    // the real run to `unavailable`. We reuse fetchSentryPermanentFailureAggregate over a
    // 30d window (calibration: 8 events / 2 users / 30d — known non-zero) and FAIL setup
    // only on `null` (malformed). A parseable row — including the known non-zero 30d row —
    // PASSES; this proves the field aliases parse, not just that the endpoint 200s.
    try {
      const endIso = toIso(Date.now());
      const startIso = toIso(Date.now() - (30 * 24 * 60 * 60 * 1000));
      const aggregate = await fetchSentryPermanentFailureAggregate({
        token: sentryToken,
        startIso,
        endIso,
      });
      if (aggregate === null) {
        results.push(setupResult(
          'sentry_permfail_aggregate_read',
          false,
          `permanent-failure aggregate response was unparseable (missing count_unique(user)/count() aliases?)${tokenNote}`,
        ));
      } else {
        results.push(setupResult(
          'sentry_permfail_aggregate_read',
          true,
          `permanent-failure aggregate parsed (distinctUsers=${aggregate.distinctUsers}, events=${aggregate.events}, 30d)${tokenNote}`,
        ));
      }
    } catch (error) {
      results.push(setupResult('sentry_permfail_aggregate_read', false, `${error instanceof Error ? error.message : String(error)}${tokenNote}`));
    }

    // Probe the EXACT check-G Sentry-count shape AND parse it: count() aggregate over
    // source:user-bug-report. A bare 2xx is not enough — a field-alias drift could 200
    // with an unparseable body and silently degrade the real run to `unavailable`. FAIL
    // setup only on null (malformed); a parseable count (incl. a legitimate 0) PASSES.
    try {
      const endIso = toIso(Date.now());
      const startIso = toIso(Date.now() - (CHECK_G_WINDOW_HOURS * 60 * 60 * 1000));
      const sentryCount = await fetchSentryUserBugReportCount({ token: sentryToken, startIso, endIso });
      if (sentryCount === null) {
        results.push(setupResult(
          'sentry_bug_report_count_read',
          false,
          `user-bug-report count response was unparseable (missing count() alias?)${tokenNote}`,
        ));
      } else {
        results.push(setupResult(
          'sentry_bug_report_count_read',
          true,
          `user-bug-report count parsed (events=${sentryCount}, ${CHECK_G_WINDOW_HOURS}h)${tokenNote}`,
        ));
      }
    } catch (error) {
      results.push(setupResult('sentry_bug_report_count_read', false, `${error instanceof Error ? error.message : String(error)}${tokenNote}`));
    }

    // Probe the EXACT check-H aggregate shape AND parse it. Check H's real-run reads
    // use the same count_unique(user)/count() aliases as check F but a DIFFERENT query
    // (`message:"Safety eval fail-closed" reasonKind:billing`), so a scope/dataset/
    // field-alias/query-syntax gap specific to that shape must fail setup LOUDLY here. A
    // bare 2xx is not enough: a drift could 200 with an unparseable body and silently
    // degrade the real run to `unavailable`. We reuse fetchSentrySafetyEvalDegradedAggregate
    // over a 30d window and FAIL setup only on `null` (malformed); a parseable row — incl. a
    // legitimate zero — PASSES, proving the field aliases + query parse, not just that the
    // endpoint 200s. (Backtest: ~22 distinct billing users over 30d, so the 30d probe row is
    // expected non-zero; both zero and non-zero are valid PASSes.)
    try {
      const endIso = toIso(Date.now());
      const startIso = toIso(Date.now() - (30 * 24 * 60 * 60 * 1000));
      const aggregate = await fetchSentrySafetyEvalDegradedAggregate({
        token: sentryToken,
        startIso,
        endIso,
      });
      if (aggregate === null) {
        results.push(setupResult(
          'sentry_safety_eval_degraded_read',
          false,
          `safety-eval degradation aggregate response was unparseable (missing count_unique(user)/count() aliases or bad query?)${tokenNote}`,
        ));
      } else {
        results.push(setupResult(
          'sentry_safety_eval_degraded_read',
          true,
          `safety-eval degradation aggregate parsed (distinctUsers=${aggregate.distinctUsers}, events=${aggregate.events}, 30d)${tokenNote}`,
        ));
      }
    } catch (error) {
      results.push(setupResult('sentry_safety_eval_degraded_read', false, `${error instanceof Error ? error.message : String(error)}${tokenNote}`));
    }
  }

  if (!posthogKey || !posthogProjectId) {
    results.push(setupResult('posthog_query', false, 'missing POSTHOG_PERSONAL_API_KEY or POSTHOG_PROJECT_ID'));
  } else {
    try {
      await posthogQuery({
        host: posthogHost,
        projectId: posthogProjectId,
        apiKey: posthogKey,
        hogqlQuery: 'SELECT 1 LIMIT 1',
      });
      results.push(setupResult('posthog_query', true, 'HogQL query endpoint responded'));
    } catch (error) {
      results.push(setupResult('posthog_query', false, error instanceof Error ? error.message : String(error)));
    }
  }

  if (!slackWebhook) {
    results.push(setupResult('slack_webhook', false, 'missing SLACK_WEBHOOK'));
  } else {
    try {
      const response = await fetch(slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Intentionally invalid payload so this stays a reachability check and does not send a real message.
        body: '{}',
      });
      const text = await response.text();
      const reachable = response.status === 200 || (response.status === 400 && /invalid_payload/i.test(text));
      if (reachable) {
        results.push(setupResult('slack_webhook', true, `reachable (${response.status})`));
      } else {
        results.push(setupResult('slack_webhook', false, `unexpected response ${response.status}: ${text.slice(0, 200)}`));
      }
    } catch (error) {
      results.push(setupResult('slack_webhook', false, error instanceof Error ? error.message : String(error)));
    }
  }

  const passed = results.filter((item) => item.ok).length;
  const failed = results.length - passed;
  process.stdout.write('sentry-outcome-monitor --verify-setup\n');
  for (const item of results) {
    const status = item.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`[${status}] ${item.name}: ${item.detail}\n`);
  }
  process.stdout.write(`summary: ${passed} passed, ${failed} failed\n`);

  if (dryRun) {
    process.stdout.write('[dry-run] verify-setup mode performs checks but does not post Slack messages.\n');
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function runMonitor({ dryRun, nowMs, projectRoot }) {
  const { token: sentryToken, source: sentryTokenSource, usedFallback } = resolveSentryToken(process.env);
  if (!sentryToken) {
    throw new Error('Missing required environment variable: SENTRY_MONITOR_AUTH_TOKEN or SENTRY_AUTH_TOKEN');
  }
  if (usedFallback) {
    // Observable, not silent: running on the shared release-scoped token is the
    // known-bad path that left this monitor blind. Warn loudly but proceed.
    process.stdout.write(
      `sentry-outcome-monitor: WARNING using ${sentryTokenSource} (fallback) for Sentry reads — `
        + 'set the dedicated SENTRY_MONITOR_AUTH_TOKEN (scope org:read) for least privilege.\n',
    );
  }
  const slackWebhook = optionalEnv('SLACK_WEBHOOK');

  const posthogKey = optionalEnv('POSTHOG_PERSONAL_API_KEY');
  const posthogProjectId = optionalEnv('POSTHOG_PROJECT_ID');
  const posthogHost = optionalEnv('POSTHOG_HOST') ?? POSTHOG_DEFAULT_HOST;
  const posthogCredsPresent = Boolean(posthogKey && posthogProjectId);

  if (!dryRun && !slackWebhook) {
    throw new Error('Missing required environment variable: SLACK_WEBHOOK');
  }

  const nowIso = toIso(nowMs);
  const start9dIso = toIso(nowMs - (9 * 24 * 60 * 60 * 1000));
  const start7dIso = toIso(nowMs - LOOKBACK_7D_MS);
  const start26hIso = toIso(nowMs - LOOKBACK_26H_MS);

  // Check F two-read windows (Amendment A1-F1). Derived ONLY from the exported
  // constants — current is the detection window ending at `now`; baseline is the
  // PRIOR run's window, offset by the run interval (NOT the full detection window),
  // so the two overlap by `WINDOW - INTERVAL`h and a fresh surge (one that appeared
  // in the run-owned [now-INTERVAL, now] span) is distinguishable from a sustained one.
  const permfailWindowMs = PERMFAIL_DETECTION_WINDOW_HOURS * 60 * 60 * 1000;
  const permfailIntervalMs = MONITOR_RUN_INTERVAL_HOURS * 60 * 60 * 1000;
  const permfailCurrentStartIso = toIso(nowMs - permfailWindowMs);
  const permfailCurrentEndIso = nowIso;
  const permfailBaselineStartIso = toIso(nowMs - permfailWindowMs - permfailIntervalMs);
  const permfailBaselineEndIso = toIso(nowMs - permfailIntervalMs);

  // Check H daily windows (sustained-rate). We read the trailing M days PLUS one
  // pre-window guard day (M+1 total), each a 24h distinct-billing-user count, ordered
  // OLDEST→NEWEST. evaluateCheckH pages only when the trailing M days are all elevated
  // AND the guard day was below threshold (fresh-edge re-page suppression). Day k counts
  // [now - (k+1)*24h, now - k*24h]; k=0 is the most recent full day window ending at now.
  const safetyDegradedDayMs = SAFETY_DEGRADED_DAY_WINDOW_HOURS * 60 * 60 * 1000;
  const safetyDegradedDayCount = SAFETY_DEGRADED_SUSTAINED_DAYS + 1; // M trailing days + 1 guard day
  const safetyDegradedDayWindows = [];
  for (let k = safetyDegradedDayCount - 1; k >= 0; k -= 1) {
    // Emit oldest→newest so the array matches evaluateCheckH's expected ordering.
    safetyDegradedDayWindows.push({
      startIso: toIso(nowMs - (k + 1) * safetyDegradedDayMs),
      endIso: toIso(nowMs - k * safetyDegradedDayMs),
    });
  }

  // Check G window — bug-report delivery reconciliation (PostHog submissions vs
  // Sentry user-bug-report volume over the same window).
  const checkGStartIso = toIso(nowMs - (CHECK_G_WINDOW_HOURS * 60 * 60 * 1000));

  const [
    errorStatsResult,
    attachmentStatsResult,
    indexedEventsResult,
    permfailCurrentResult,
    permfailBaselineResult,
    checkGSentryCountResult,
  ] = await Promise.allSettled([
    fetchSentryOutcomeStats({ token: sentryToken, category: 'error' }),
    fetchSentryOutcomeStats({ token: sentryToken, category: 'attachment' }),
    fetchSentryIndexedBugReportEvents({ token: sentryToken, startIso: start26hIso, endIso: nowIso }),
    fetchSentryPermanentFailureAggregate({
      token: sentryToken,
      startIso: permfailCurrentStartIso,
      endIso: permfailCurrentEndIso,
    }),
    fetchSentryPermanentFailureAggregate({
      token: sentryToken,
      startIso: permfailBaselineStartIso,
      endIso: permfailBaselineEndIso,
    }),
    fetchSentryUserBugReportCount({ token: sentryToken, startIso: checkGStartIso, endIso: nowIso }),
  ]);

  // Check H daily reads — one distinct-billing-user count per day window (M trailing days
  // + 1 guard day), settled independently so a single bad day doesn't sink the batch.
  // Same `/events/` endpoint + aggregate shape as Check F; reuses deriveCheckFRead so a
  // rejected/malformed day degrades self-health while a legitimate `data:[]` zero does not.
  const safetyDegradedDayResults = await Promise.allSettled(
    safetyDegradedDayWindows.map((window) => fetchSentrySafetyEvalDegradedAggregate({
      token: sentryToken,
      startIso: window.startIso,
      endIso: window.endIso,
    })),
  );
  const safetyDegradedDayReads = safetyDegradedDayResults.map((result) => deriveCheckFRead(result));
  // OLDEST→NEWEST distinct-user series for evaluateCheckH; a degraded (rejected/malformed)
  // day is `null` (→ unavailable if inside the trailing window), a legitimate zero is 0.
  const safetyDegradedDailyDistinctUsers = safetyDegradedDayReads.map(
    (read) => (read.value == null ? null : read.value.distinctUsers),
  );
  const safetyDegradedAnyDegraded = safetyDegradedDayReads.some((read) => read.degraded);

  const sentryStatsStatus = errorStatsResult.status === 'fulfilled'
    && attachmentStatsResult.status === 'fulfilled'
    ? 'ok'
    : 'fail';

  // Derive the check-F reads (value + whether they degrade self-health) BEFORE
  // computing sentryEventsStatus. A check-F read degrades when it REJECTS (HTTP)
  // OR is fulfilled-but-null (structurally malformed body) — both are "can't tell".
  // A fulfilled non-null value, INCLUDING a legitimate distinctUsers=0 zero (the
  // common healthy case), does NOT degrade (else the monitor pages itself every run).
  const permfailCurrentRead = deriveCheckFRead(permfailCurrentResult);
  const permfailBaselineRead = deriveCheckFRead(permfailBaselineResult);

  // sentry_events covers the indexed bug-report read (checks B/C/A), the check-F
  // permanent-failure aggregate reads, AND the check-H safety-eval billing-degradation
  // daily reads — all hit the same `/events/` endpoint on the same token. Each aggregate
  // portion degrades on a malformed (fulfilled-null) read too, not just an HTTP reject
  // (Amendment A1-F2 / GPT-F1): a malformed read feeds self-health — but a legitimate
  // zero must NOT.
  const sentryEventsStatus = indexedEventsResult.status === 'fulfilled'
    && !permfailCurrentRead.degraded
    && !permfailBaselineRead.degraded
    && !safetyDegradedAnyDegraded
    ? 'ok'
    : 'fail';

  let trackedResult = null;
  let livenessResult = null;
  let checkGPosthogCountResult = null;
  if (posthogCredsPresent) {
    [trackedResult, livenessResult, checkGPosthogCountResult] = await Promise.allSettled([
      fetchPosthogTrackedBugReportEvents({
        host: posthogHost,
        projectId: posthogProjectId,
        apiKey: posthogKey,
        startIso: start7dIso,
        endIso: nowIso,
      }),
      fetchPosthogApplicationOpenedHourly({
        host: posthogHost,
        projectId: posthogProjectId,
        apiKey: posthogKey,
        startIso: start9dIso,
        endIso: nowIso,
      }),
      fetchPosthogBugReportSubmittedCount({
        host: posthogHost,
        projectId: posthogProjectId,
        apiKey: posthogKey,
        startIso: checkGStartIso,
        endIso: nowIso,
      }),
    ]);
  }

  const { posthogTrackedStatus, posthogLivenessStatus } = buildPosthogDependencyStatuses({
    posthogCredsPresent,
    trackedResult,
    livenessResult,
  });
  const dependencies = buildMonitorDependencies({
    sentryStatsStatus,
    sentryEventsStatus,
    posthogTrackedStatus,
    posthogLivenessStatus,
  });

  // Self-health runs after all read dependencies are known. On a hard Sentry
  // failure we still advance the counter and escalate here, then re-throw below
  // so the workflow fails and the existing failure() Slack step fires.
  const selfHealth = await runSelfHealthStep({
    projectRoot,
    dryRun,
    dependencies,
    slackWebhook,
  });

  const sentryFatalError = settledErrorReason(errorStatsResult)
    ?? settledErrorReason(attachmentStatsResult)
    ?? settledErrorReason(indexedEventsResult);
  if (sentryFatalError) {
    throw sentryFatalError;
  }

  const errorStats = errorStatsResult.value;
  const attachmentStats = attachmentStatsResult.value;
  const indexedEvents = indexedEventsResult.value;

  const seriesIndex = buildOutcomeSeriesIndex({
    errorStats,
    attachmentStats,
  });
  const index = seriesIndex.intervals.length - 2;
  if (index < 0) {
    throw new Error('Sentry outcome stats require at least 2 hourly intervals');
  }

  const checkB = evaluateCheckB({
    intervals: seriesIndex.intervals,
    errorSeriesByPair: seriesIndex.errorSeriesByPair,
    index,
  });
  const checkC = evaluateCheckC({
    intervals: seriesIndex.intervals,
    combinedSeriesByPair: seriesIndex.combinedSeriesByPair,
    index,
  });

  const acceptedHourly = sumFamilyHourly(
    seriesIndex.errorSeriesByPair,
    'accepted',
    seriesIndex.intervals.length,
  );

  let trackedEvents = [];
  let livenessHourly = null;
  let checkELivenessUnavailable = false;
  let posthogAvailabilityNote = null;

  if (!posthogCredsPresent) {
    posthogAvailabilityNote = 'PostHog query credentials not present; check A is BLIND until a read-scoped key is configured.';
    checkELivenessUnavailable = true;
  } else {
    if (trackedResult?.status === 'fulfilled') {
      trackedEvents = trackedResult.value;
    } else {
      const reason = trackedResult?.reason instanceof Error
        ? trackedResult.reason.message
        : String(trackedResult?.reason ?? 'unknown');
      posthogAvailabilityNote = `PostHog query failed; check A is BLIND this run. ${reason}`;
    }

    if (livenessResult?.status === 'fulfilled') {
      livenessHourly = alignHourlyRowsToIntervals(livenessResult.value, seriesIndex.intervals);
    } else {
      checkELivenessUnavailable = true;
      const reason = livenessResult?.reason instanceof Error
        ? livenessResult.reason.message
        : String(livenessResult?.reason ?? 'unknown');
      const livenessNote = `PostHog Application Opened query failed; check E is inconclusive this run. ${reason}`;
      posthogAvailabilityNote = posthogAvailabilityNote
        ? `${posthogAvailabilityNote} ${livenessNote}`
        : livenessNote;
    }
  }

  const checkE = evaluateCheckE({
    intervals: seriesIndex.intervals,
    acceptedHourly,
    livenessHourly,
    index,
    livenessUnavailable: checkELivenessUnavailable,
  });

  const checkA = evaluateCheckA({
    nowMs,
    trackedEvents,
    indexedEvents,
  });

  // Check F — mobile offline-queue permanent-failure surge. Either window read
  // failing (rejected promise) or returning null (malformed body) yields
  // verdict=`unavailable` (Amendment A1-F2 — never a false `quiet`); both cases
  // already marked sentry_events degraded above via deriveCheckFRead. A check-F read
  // failure is deliberately NOT fatal (unlike the stats/indexed reads): the run
  // completes and the other checks still fire, while self-health carries the loud signal.
  const checkF = evaluateCheckF({
    current: permfailCurrentRead.value,
    baseline: permfailBaselineRead.value,
  });

  // Check H — safety-eval billing-degradation SUSTAINED-RATE alert (reasonKind:billing).
  // Pages only when the trailing M daily distinct-user counts are all >= threshold AND the
  // pre-window guard day was below it (fresh-edge re-page suppression). A malformed/rejected
  // day INSIDE the trailing window → verdict=`unavailable` (never a false quiet); already
  // marked sentry_events degraded via deriveCheckFRead. NOT fatal — the run completes and
  // the other checks still fire while self-health carries the loud signal.
  const checkH = evaluateCheckH({
    dailyDistinctUsers: safetyDegradedDailyDistinctUsers,
  });

  // Check G — bug-report delivery reconciliation. Best-effort like checks E/F: a
  // failed/malformed read on EITHER side yields verdict `unavailable` (never a
  // false `healthy`); we map a fulfilled-non-null value through, else null. We do
  // NOT throw on a check-G read failure — the run completes; the `unavailable`
  // verdict + the existing posthog/sentry dependency degradation carry the signal.
  const checkGPosthogSubmitted = checkGPosthogCountResult?.status === 'fulfilled'
    ? (checkGPosthogCountResult.value ?? null)
    : null;
  const checkGSentryIndexed = checkGSentryCountResult.status === 'fulfilled'
    ? (checkGSentryCountResult.value ?? null)
    : null;
  const checkG = evaluateCheckG({
    posthogSubmitted: checkGPosthogSubmitted,
    sentryIndexed: checkGSentryIndexed,
  });

  const totals = summarizeCategoryTotals({
    totalsByCategory: seriesIndex.totalsByCategory,
    index,
  });

  const messages = [];
  if (checkA.shouldPage) {
    messages.push({ title: 'check-a-alert', text: formatCheckAAlert({ checkA, runbookPath: RUNBOOK_PATH }) });
  }
  if (checkB.alerts.length > 0) {
    messages.push({ title: 'check-b-alert', text: formatCheckBAlert({ checkB, runbookPath: RUNBOOK_PATH }) });
  }
  if (checkC.notices.length > 0) {
    messages.push({ title: 'check-c-notice', text: formatCheckCNotice({ checkC, runbookPath: RUNBOOK_PATH }) });
  }
  if (checkE.shouldPage) {
    messages.push({ title: 'check-e-alert', text: formatCheckEAlert({ checkE, runbookPath: RUNBOOK_PATH }) });
  }
  if (checkF.shouldPage) {
    messages.push({ title: 'check-f-alert', text: formatCheckFAlert({ checkF, runbookPath: RUNBOOK_PATH }) });
  }
  if (checkG.shouldPage) {
    messages.push({ title: 'check-g-alert', text: formatCheckGAlert({ checkG, runbookPath: RUNBOOK_PATH }) });
  }
  if (checkH.shouldPage) {
    messages.push({ title: 'check-h-alert', text: formatCheckHAlert({ checkH, runbookPath: RUNBOOK_PATH }) });
  }

  if (isDailyDigestRun(nowMs)) {
    let digestText = buildDigestMessage({
      nowMs,
      checkA,
      checkB,
      checkC,
      checkE,
      checkF,
      checkG,
      checkH,
      statsTotals: totals,
      selfHealth,
      runbookPath: RUNBOOK_PATH,
    });
    if (posthogAvailabilityNote) {
      digestText += `\nposthog setup note: ${posthogAvailabilityNote}`;
    }
    messages.push({ title: 'daily-digest', text: digestText });
  }

  process.stdout.write(
    `sentry-outcome-monitor run complete: ${nowIso} (window_start=${start9dIso})\n`,
  );
  process.stdout.write(
    `checkA: tracked24h=${checkA.tracked24hCount}, tracked7d=${checkA.tracked7dCount}, indexed24h=${checkA.indexed24hCount}, coverage='${checkA.coverageState}', missing_now=${checkA.newlyExpiredMissingIds.length}\n`,
  );
  process.stdout.write(`checkB: alerts=${checkB.alerts.length}; checkC: notices=${checkC.notices.length}\n`);
  process.stdout.write(
    `checkE: verdict=${checkE.verdict}, shouldPage=${checkE.shouldPage}, accepted=${checkE.acceptedInWindow}, liveness=${checkE.livenessInWindow ?? 'N/A'}\n`,
  );
  process.stdout.write(
    `checkF: verdict=${checkF.verdict}, shouldPage=${checkF.shouldPage}, distinct_users=${checkF.distinctUsers}, events=${checkF.events} `
      + `(window=[${permfailCurrentStartIso}, ${permfailCurrentEndIso}], baseline=[${permfailBaselineStartIso}, ${permfailBaselineEndIso}])\n`,
  );
  process.stdout.write(
    `checkG: verdict=${checkG.verdict}, shouldPage=${checkG.shouldPage}, posthog_submitted=${checkG.posthogSubmitted}, `
      + `sentry_indexed=${checkG.sentryIndexed}, missing=${checkG.missing} (window=[${checkGStartIso}, ${nowIso}])\n`,
  );
  process.stdout.write(
    `checkH: verdict=${checkH.verdict}, shouldPage=${checkH.shouldPage}, peak_day=${checkH.peakDay}, `
      + `daily_distinct_users(oldest→newest)=[${safetyDegradedDailyDistinctUsers.map((value) => (value == null ? 'NA' : value)).join(',')}] `
      + `(threshold ${checkH.debug?.threshold}/day x ${checkH.debug?.minConsecutiveDays}d)\n`,
  );
  if (posthogAvailabilityNote) {
    process.stdout.write(`${posthogAvailabilityNote}\n`);
  }

  if (messages.length === 0) {
    process.stdout.write('No Slack notifications to send for this run.\n');
    return;
  }

  for (const message of messages) {
    if (dryRun) {
      printDryRunMessage(message.title, message.text);
      continue;
    }

    await postSlackMessage({
      webhook: slackWebhook,
      text: message.text,
    });
    process.stdout.write(`posted Slack message: ${message.title}\n`);
  }
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  loadEnvFiles(projectRoot);

  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      'verify-setup': { type: 'boolean', default: false },
      now: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const dryRun = values['dry-run'];
  const verifySetup = values['verify-setup'];

  if (verifySetup) {
    await runVerifySetup({ dryRun });
    return;
  }

  const nowMs = nowFromArgs(values.now);
  await runMonitor({
    dryRun,
    nowMs,
    projectRoot,
  });
}

main().catch((error) => {
  process.stderr.write(`sentry-outcome-monitor failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
