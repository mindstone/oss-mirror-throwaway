const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const CHECK_A_ALLOWANCE_HOURS = 2;
// Run cadence: the GH Actions cron fires every 3 hours ('17 */3 * * *'), so each
// run owns the 3 hour-buckets that crossed the allowance since the previous run
// — keeps the pages-exactly-once property under the wider interval (and under
// cron jitter, same hour-bucket arithmetic as before).
export const MONITOR_RUN_INTERVAL_HOURS = 3;
export const CHECK_A_PAGE_WINDOW_HOURS = MONITOR_RUN_INTERVAL_HOURS;
export const CHECK_A_LOOKBACK_HOURS = 26;
export const CHECK_B_ROLLING_HOURS = 24;
export const CHECK_B_BASELINE_HOURS = 7 * 24;

export const CHECK_E_WINDOW_HOURS = 6;
export const CHECK_E_LIVENESS_BASELINE_HOURS = 7 * 24;
export const CHECK_E_ACCEPTED_FLOOR = 5;
export const CHECK_E_LIVENESS_MIN_BASELINE = 20;
export const CHECK_E_LIVENESS_HOLD_RATIO = 0.5;

// Check F — mobile offline-queue permanent-failure surge (REBEL-6BJ / FOX-3516 class).
// Distinct affected users (= accounts) crossing the floor over the detection window
// pages, using a distinct-user count (NOT raw event volume) because the per-device
// 1/hr escalation throttle dampens raw `count()` ~5:1 and would hide a real surge.
// Calibrated 2026-06-21: live baseline = 8 events / 2 distinct users over 30d (all
// production) — floor 3 over a 6h window is comfortably above baseline.
export const PERMFAIL_DISTINCT_USER_FLOOR = 3;
export const PERMFAIL_DETECTION_WINDOW_HOURS = 6;

// Check H — safety-eval billing-degradation SUSTAINED-RATE alert split by reasonKind
// (260622 safety-eval connector-error postmortem, "opaque single-credential routing
// starvation" class). The producer emits a `Safety eval fail-closed` Sentry message
// tagged `reasonKind:billing` whenever a single-credential user's safety-eval model hits
// a plan cap and the eval fails CLOSED (blocking the action).
//
// DESIGN PIVOT (post-backtest): a 30d Sentry backtest showed billing safety-eval
// degradation is a STEADY background, NOT a rare incident — ~6 distinct users/day
// (24h=6, 7d=12, 30d=22). A 6h fresh-edge SPIKE detector at floor 2 would therefore page
// constantly. So Check H is a SUSTAINED-RATE alert instead: it pages only when the daily
// distinct-billing-user count stays ELEVATED above a threshold for several consecutive
// days — a persistent/worsening trend, not a busy afternoon.
//
// THRESHOLDS — tune from the Sentry dashboard. Backtest steady state ~6 users/day
// (24h=6, 7d=12, 30d=22), so the daily threshold is set clearly ABOVE that baseline so
// the ~6/day steady state never pages; pages only on a real worsening trend. Distinct-
// user (NOT raw `count()`) is the trigger — the producer's per-fingerprint 60s throttle
// dampens raw event volume.
export const SAFETY_DEGRADED_DAILY_USER_THRESHOLD = 10; // distinct billing users/day; clearly above the ~6/day steady state
export const SAFETY_DEGRADED_SUSTAINED_DAYS = 3; // consecutive days all >= threshold before paging
export const SAFETY_DEGRADED_DAY_WINDOW_HOURS = 24; // one daily distinct-user read per day

// Check G — bug-report delivery reconciliation (PLAN Stage 6, the meta-fix).
// Turns Greg's one-off "users submit but I don't see a user-bug-report in Sentry"
// investigation into a STANDING detector: over a window, compare the PostHog
// `Bug Report Submitted` submission count against the Sentry `source:user-bug-report`
// event volume. If Sentry is materially BELOW PostHog (beyond tolerance), the
// pipeline is dropping submitted reports — page.
//
// This is an AGGREGATE-VOLUME reconciliation, deliberately distinct from check A
// (which matches individual `sentry_event_id`s over a 26h lookback). Check A needs
// the event id to be tracked in PostHog AND indexed in Sentry; check G is a coarser,
// id-independent net that also catches reports whose id never made it into either
// index (e.g. desktop submissions before the id-tracking landed, or a whole class
// going dark). Both run; they fail in different ways on purpose.
//
// Tolerances (calibrated conservative — this pages humans):
//   - SHORTFALL_RATIO: Sentry must be at least (1 - ratio) of PostHog. 0.5 = "Sentry
//     has fewer than HALF the submissions" → a material, not-noise, gap.
//   - MIN_ABSOLUTE_MISS: ignore a shortfall smaller than this many events, so window-
//     edge timing skew (a submit at the very end of the window whose Sentry event lands
//     just after) and off-by-one rounding never page.
//   - MIN_POSTHOG_SUBMISSIONS: below this, the sample is too small to reason about a
//     ratio → `inconclusive`, never a page.
export const CHECK_G_WINDOW_HOURS = 24;
export const CHECK_G_SHORTFALL_RATIO = 0.5;
export const CHECK_G_MIN_ABSOLUTE_MISS = 3;
export const CHECK_G_MIN_POSTHOG_SUBMISSIONS = 5;

export const SELF_HEALTH_ESCALATION_THRESHOLD = 2; // consecutive degraded runs (>= ~6h at 3h cadence) before escalating

export const CHECK_B_FAMILY_POLICY = {
  invalid: { mode: 'alert', multiplier: 2, floor: 8 },
  filtered: { mode: 'alert', multiplier: 2, floor: 5 },
  rate_limited: { mode: 'digest' },
  client_discard: { mode: 'digest' },
};

/**
 * Turn a non-OK Sentry HTTP response into a loud, self-diagnosing error message.
 *
 * Both Sentry reads this monitor makes — `GET /organizations/{org}/stats_v2/` and
 * `GET /organizations/{org}/events/` — require an `org:read`-capable token (verified
 * against the current Sentry endpoint docs). Without this, an auth/scope failure
 * surfaces as an opaque `Sentry API 403 …` dump that hides the actual cause (it
 * literally hid this bug: the shared release token lacked `org:read`). Pure and
 * string-only so it is unit-testable with no network.
 *
 * The 403 message names the *most likely* cause (missing `org:read`) without
 * over-prescribing: it deliberately does NOT tell the operator to grant `event:read`
 * (these org-level endpoints don't use it) and asks them to also verify token type,
 * org, project, and region in case the real cause is elsewhere.
 *
 * @param {number} status     HTTP status code from the Sentry response.
 * @param {string} statusText HTTP status text.
 * @param {string} bodyText   Raw response body (sliced to 300 chars, preserving prior behavior).
 * @param {{ org?: string, region?: string }} [ctx]
 * @returns {{ kind: string, message: string }}
 */
export function classifySentryHttpError(status, statusText, bodyText, ctx = {}) {
  const org = ctx.org ?? 'mindstone';
  const region = ctx.region ?? 'us.sentry.io';
  const head = `Sentry API ${status} ${statusText}`;
  const body = String(bodyText ?? '').slice(0, 300);

  switch (status) {
    case 401:
      return {
        kind: 'auth_invalid',
        message:
          `${head}: token is invalid, expired, or revoked — rotate the monitor token ` +
          `(SENTRY_MONITOR_AUTH_TOKEN). ${body}`,
      };
    case 403:
      return {
        kind: 'auth_underscoped',
        message:
          `${head}: token authenticated but lacks permission for these organization-read endpoints. ` +
          `The monitor token needs org:read (or org:write / org:admin). ` +
          `Also verify token type, org ('${org}'), project access, and region (${region}). ` +
          `See docs/project/SENTRY_TRIAGE.md. ${body}`,
      };
    case 404:
      return {
        kind: 'wrong_target',
        message:
          `${head}: org slug ('${org}') or region (${region}) is likely wrong, ` +
          `or the project is not visible to this token. ${body}`,
      };
    default:
      return { kind: 'unknown', message: `${head}: ${body}` };
  }
}

/**
 * Resolve which token the monitor should use for Sentry reads, preferring a
 * dedicated least-privilege read token and falling back to the shared one.
 *
 * Pure (takes an env map) so it is unit-testable and so the side-effecting monitor
 * script can pass `process.env`. Uses trim-and-empty-to-null semantics deliberately:
 * an empty/whitespace `SENTRY_MONITOR_AUTH_TOKEN` (e.g. an unset GitHub secret that
 * still injects an empty string) must NOT shadow the fallback.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ token: string | null, source: string | null, usedFallback: boolean }}
 */
export function resolveSentryToken(env = {}) {
  const pick = (name) => {
    const raw = env[name];
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  };

  const dedicated = pick('SENTRY_MONITOR_AUTH_TOKEN');
  if (dedicated) {
    return { token: dedicated, source: 'SENTRY_MONITOR_AUTH_TOKEN', usedFallback: false };
  }
  const shared = pick('SENTRY_AUTH_TOKEN');
  if (shared) {
    return { token: shared, source: 'SENTRY_AUTH_TOKEN', usedFallback: true };
  }
  return { token: null, source: null, usedFallback: false };
}

/**
 * Render a short, human-readable note naming which Sentry token source was used,
 * for verify-setup result details (both PASS and FAIL). On a fallback it tells the
 * operator to provision the dedicated token — important on the FAIL path, where a
 * 403 from the known-under-scoped shared token is the exact silent-degradation the
 * fix targets. Pure so it's unit-testable.
 *
 * @param {{ source: string | null, usedFallback: boolean }} resolved
 * @returns {string} note (leading space) or '' when there is no token source.
 */
export function describeSentryTokenSource({ source, usedFallback } = {}) {
  if (!source) return '';
  return usedFallback
    ? ` [token: ${source} fallback — set SENTRY_MONITOR_AUTH_TOKEN (org:read)]`
    : ` [token: ${source}]`;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function parseTimestampMs(value) {
  // PostHog/ClickHouse may serialize naive datetimes ('YYYY-MM-DD hh:mm:ss').
  // Date.parse would read those in the runner's local TZ (CI is UTC, but local
  // --dry-run debugging isn't) — normalize naive forms to explicit UTC first.
  const raw = String(value);
  const naive = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(raw);
  const ms = Date.parse(naive ? `${raw.replace(' ', 'T')}Z` : raw);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid timestamp: ${String(value)}`);
  }
  return ms;
}

function hourBucket(ms) {
  return Math.floor(ms / HOUR_MS);
}

/**
 * Sum hourly counts for every (outcome, reason) pair whose outcome matches `family`.
 *
 * @param {Record<string, { outcome: string, hourly: number[] }>} seriesByPair
 * @param {string} family
 * @param {number} intervalsLen
 * @returns {number[]}
 */
export function sumFamilyHourly(seriesByPair, family, intervalsLen) {
  const totals = new Array(intervalsLen).fill(0);
  for (const pairSeries of Object.values(seriesByPair)) {
    if (pairSeries.outcome !== family) continue;
    for (let i = 0; i < intervalsLen; i += 1) {
      totals[i] += pairSeries.hourly[i] ?? 0;
    }
  }
  return totals;
}

/**
 * Bucket PostHog/HogQL hour rows into an hourly series aligned to Sentry `intervals`.
 *
 * @param {{ hour: string, count: number }[]} rows
 * @param {string[]} intervals ISO hour strings (same shape as stats_v2 intervals)
 * @returns {number[]}
 */
export function alignHourlyRowsToIntervals(rows, intervals) {
  const intervalBucketByIndex = intervals.map((iso) => hourBucket(parseTimestampMs(iso)));
  const countsByBucket = new Map();
  for (const row of rows) {
    const bucket = hourBucket(parseTimestampMs(row.hour));
    countsByBucket.set(bucket, (countsByBucket.get(bucket) ?? 0) + toNumber(row.count));
  }
  return intervalBucketByIndex.map((bucket) => countsByBucket.get(bucket) ?? 0);
}

function sumRange(series, startInclusive, endExclusive) {
  let total = 0;
  for (let i = startInclusive; i < endExclusive; i += 1) {
    total += series[i] ?? 0;
  }
  return total;
}

function rollingWindowSeries(hourlySeries, hours) {
  const rolling = [];
  let acc = 0;
  for (let i = 0; i < hourlySeries.length; i += 1) {
    acc += hourlySeries[i] ?? 0;
    if (i >= hours) {
      acc -= hourlySeries[i - hours] ?? 0;
    }
    rolling.push(i >= hours - 1 ? acc : 0);
  }
  return rolling;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

function median(sorted) {
  return percentile(sorted, 0.5);
}

function medianAbsoluteDeviation(values, med) {
  const deviations = values.map((value) => Math.abs(value - med)).sort((a, b) => a - b);
  return median(deviations);
}

function compactIds(ids, limit = 15) {
  if (ids.length <= limit) {
    return ids;
  }
  return [...ids.slice(0, limit), `+${ids.length - limit} more`];
}

function keyForPair(outcome, reason) {
  return `${outcome}/${reason}`;
}

function readCategorySeries(statsPayload, category) {
  if (!statsPayload || typeof statsPayload !== 'object') {
    throw new Error(`Missing stats payload for category ${category}`);
  }
  const intervals = Array.isArray(statsPayload.intervals) ? statsPayload.intervals : null;
  const groups = Array.isArray(statsPayload.groups) ? statsPayload.groups : null;
  if (!intervals || !groups) {
    throw new Error(`Invalid stats payload shape for category ${category}`);
  }

  const seriesByPair = {};
  for (const group of groups) {
    const outcome = typeof group?.by?.outcome === 'string' ? group.by.outcome : 'unknown';
    const reason = typeof group?.by?.reason === 'string' ? group.by.reason : 'unknown';
    const rawSeries = group?.series?.['sum(quantity)'];
    if (!Array.isArray(rawSeries) || rawSeries.length !== intervals.length) {
      throw new Error(`Invalid series length for ${category}:${outcome}/${reason}`);
    }

    const numericSeries = rawSeries.map((value) => toNumber(value));
    seriesByPair[keyForPair(outcome, reason)] = {
      outcome,
      reason,
      hourly: numericSeries,
    };
  }

  return { intervals, seriesByPair };
}

export function buildOutcomeSeriesIndex({ errorStats, attachmentStats }) {
  const error = readCategorySeries(errorStats, 'error');
  const attachment = readCategorySeries(attachmentStats, 'attachment');

  if (error.intervals.length !== attachment.intervals.length) {
    throw new Error('error/attachment interval lengths differ');
  }
  for (let i = 0; i < error.intervals.length; i += 1) {
    if (error.intervals[i] !== attachment.intervals[i]) {
      throw new Error(`error/attachment intervals diverge at index ${i}`);
    }
  }

  const intervals = error.intervals;
  const combinedSeriesByPair = {};
  const errorFamilySeries = {};

  for (const [pairKey, pairSeries] of Object.entries(error.seriesByPair)) {
    combinedSeriesByPair[pairKey] = {
      outcome: pairSeries.outcome,
      reason: pairSeries.reason,
      hourly: [...pairSeries.hourly],
    };
    if (!errorFamilySeries[pairSeries.outcome]) {
      errorFamilySeries[pairSeries.outcome] = new Array(intervals.length).fill(0);
    }
    for (let i = 0; i < intervals.length; i += 1) {
      errorFamilySeries[pairSeries.outcome][i] += pairSeries.hourly[i];
    }
  }

  for (const [pairKey, pairSeries] of Object.entries(attachment.seriesByPair)) {
    if (!combinedSeriesByPair[pairKey]) {
      combinedSeriesByPair[pairKey] = {
        outcome: pairSeries.outcome,
        reason: pairSeries.reason,
        hourly: new Array(intervals.length).fill(0),
      };
    }
    for (let i = 0; i < intervals.length; i += 1) {
      combinedSeriesByPair[pairKey].hourly[i] += pairSeries.hourly[i];
    }
  }

  return {
    intervals,
    errorSeriesByPair: error.seriesByPair,
    combinedSeriesByPair,
    errorFamilySeries,
    totalsByCategory: {
      error: Object.values(error.seriesByPair).reduce(
        (series, pair) => series.map((value, index) => value + (pair.hourly[index] ?? 0)),
        new Array(intervals.length).fill(0),
      ),
      attachment: Object.values(attachment.seriesByPair).reduce(
        (series, pair) => series.map((value, index) => value + (pair.hourly[index] ?? 0)),
        new Array(intervals.length).fill(0),
      ),
    },
  };
}

function dedupeEventsById(events) {
  const byId = new Map();
  for (const event of events) {
    const eventId = typeof event?.eventId === 'string' ? event.eventId.trim() : '';
    if (!eventId) continue;

    const timestampMs = Number.isFinite(event.timestampMs)
      ? event.timestampMs
      : parseTimestampMs(event.timestamp);

    const existing = byId.get(eventId);
    if (!existing || timestampMs < existing.timestampMs) {
      byId.set(eventId, {
        eventId,
        timestampMs,
        appVersion: event?.appVersion ?? null,
        channel: event?.channel ?? null,
      });
    }
  }
  return [...byId.values()];
}

export function evaluateCheckA({
  nowMs,
  trackedEvents,
  indexedEvents,
  allowanceHours = CHECK_A_ALLOWANCE_HOURS,
  pageWindowHours = CHECK_A_PAGE_WINDOW_HOURS,
  lookbackHours = CHECK_A_LOOKBACK_HOURS,
}) {
  const tracked = dedupeEventsById(trackedEvents);
  const indexed = dedupeEventsById(indexedEvents);

  const tracked7dStart = nowMs - (7 * DAY_MS);
  const tracked24hStart = nowMs - DAY_MS;
  const trackedLookbackStart = nowMs - (lookbackHours * HOUR_MS);
  const indexed24hStart = nowMs - DAY_MS;

  const tracked7d = tracked.filter((event) => event.timestampMs >= tracked7dStart);
  const tracked24h = tracked7d.filter((event) => event.timestampMs >= tracked24hStart);
  const trackedLookback = tracked7d.filter((event) => event.timestampMs >= trackedLookbackStart);

  const indexed24h = indexed.filter((event) => event.timestampMs >= indexed24hStart);
  const indexedSet = new Set(indexed.map((event) => event.eventId));
  const tracked24hSet = new Set(tracked24h.map((event) => event.eventId));

  const missingTrackedEvents = trackedLookback
    .filter((event) => !indexedSet.has(event.eventId))
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const firstPageBucketAge = Math.floor(allowanceHours) + 1;
  const pageBucketSpan = Math.max(1, Math.ceil(pageWindowHours));
  const lastPageBucketAgeExclusive = firstPageBucketAge + pageBucketSpan;
  const newlyExpiredMissingIds = missingTrackedEvents
    .filter((event) => {
      const bucketAge = hourBucket(nowMs) - hourBucket(event.timestampMs);
      return bucketAge >= firstPageBucketAge && bucketAge < lastPageBucketAgeExclusive;
    })
    .map((event) => event.eventId);

  const indexedWithoutTrackedIds = indexed24h
    .map((event) => event.eventId)
    .filter((eventId) => !tracked24hSet.has(eventId));

  const coverageState = tracked7d.length > 0
    ? `ACTIVE (${tracked7d.length} tracked in 7d)`
    : 'BLIND — zero PostHog submissions in 7 d';

  return {
    tracked24hCount: tracked24h.length,
    tracked7dCount: tracked7d.length,
    trackedLookbackCount: trackedLookback.length,
    indexed24hCount: indexed24h.length,
    indexedLookbackCount: indexed.length,
    reverseDiffIds: indexedWithoutTrackedIds,
    missingIds: missingTrackedEvents.map((event) => event.eventId),
    newlyExpiredMissingIds,
    coverageState,
    shouldPage: newlyExpiredMissingIds.length > 0,
    debug: {
      trackedLookbackStartIso: new Date(trackedLookbackStart).toISOString(),
      allowanceHours,
      pageWindowHours,
      firstPageBucketAge,
      lastPageBucketAgeExclusive,
    },
  };
}

function getLastCompleteBucketIndex(intervals) {
  if (!Array.isArray(intervals) || intervals.length < 2) {
    throw new Error('Need at least two intervals to evaluate the last complete bucket');
  }
  return intervals.length - 2;
}

function evaluateCheckBForIndex({
  index,
  intervals,
  errorSeriesByPair,
  familyPolicy = CHECK_B_FAMILY_POLICY,
}) {
  const alerts = [];
  const trendByFamily = {};

  for (const [pairKey, pairSeries] of Object.entries(errorSeriesByPair)) {
    const family = pairSeries.outcome;
    const policy = familyPolicy[family];
    if (!policy) continue;

    const rolling24 = rollingWindowSeries(pairSeries.hourly, CHECK_B_ROLLING_HOURS);
    const current24 = rolling24[index] ?? 0;
    const previous24 = index > 0 ? (rolling24[index - 1] ?? 0) : 0;

    if (!trendByFamily[family]) {
      trendByFamily[family] = { current24: 0, previous24: 0 };
    }
    trendByFamily[family].current24 += current24;
    trendByFamily[family].previous24 += previous24;

    if (policy.mode !== 'alert') continue;

    const baselineStart = index - CHECK_B_BASELINE_HOURS;
    const baselineEnd = index;
    if (baselineStart < 0 || baselineEnd <= baselineStart) continue;

    const baselineSamples = rolling24.slice(baselineStart, baselineEnd);
    const sortedBaseline = [...baselineSamples].sort((a, b) => a - b);
    const p95 = percentile(sortedBaseline, 0.95);
    const med = median(sortedBaseline);
    const mad = medianAbsoluteDeviation(baselineSamples, med);
    const robustBaseline = Math.max(p95, med + (3 * mad), 1);
    const threshold = Math.max(policy.floor, robustBaseline * policy.multiplier);

    const baselineStartPrev = baselineStart - 1;
    const baselineEndPrev = baselineEnd - 1;
    if (baselineStartPrev < 0 || baselineEndPrev <= baselineStartPrev) continue;

    const baselineSamplesPrev = rolling24.slice(baselineStartPrev, baselineEndPrev);
    const sortedBaselinePrev = [...baselineSamplesPrev].sort((a, b) => a - b);
    const p95Prev = percentile(sortedBaselinePrev, 0.95);
    const medPrev = median(sortedBaselinePrev);
    const madPrev = medianAbsoluteDeviation(baselineSamplesPrev, medPrev);
    const robustBaselinePrev = Math.max(p95Prev, medPrev + (3 * madPrev), 1);
    const thresholdPrev = Math.max(policy.floor, robustBaselinePrev * policy.multiplier);

    const violatedNow = current24 > threshold;
    const violatedPrev = previous24 > thresholdPrev;

    if (violatedNow && !violatedPrev) {
      alerts.push({
        pairKey,
        outcome: pairSeries.outcome,
        reason: pairSeries.reason,
        current24,
        previous24,
        threshold,
        robustBaseline,
        floor: policy.floor,
        multiplier: policy.multiplier,
        interval: intervals[index],
      });
    }
  }

  const trends = Object.entries(trendByFamily)
    .map(([family, trend]) => ({
      family,
      current24: trend.current24,
      previous24: trend.previous24,
      delta24: trend.current24 - trend.previous24,
      mode: familyPolicy[family]?.mode ?? 'unknown',
    }))
    .sort((a, b) => b.current24 - a.current24);

  alerts.sort((a, b) => b.current24 - a.current24 || a.pairKey.localeCompare(b.pairKey));

  return { alerts, trends };
}

export function evaluateCheckB({
  intervals,
  errorSeriesByPair,
  familyPolicy = CHECK_B_FAMILY_POLICY,
  index,
}) {
  const resolvedIndex = Number.isInteger(index) ? index : getLastCompleteBucketIndex(intervals);
  return evaluateCheckBForIndex({ intervals, errorSeriesByPair, familyPolicy, index: resolvedIndex });
}

export function collectCheckBFireEdges({
  intervals,
  errorSeriesByPair,
  familyPolicy = CHECK_B_FAMILY_POLICY,
  startIndex = CHECK_B_ROLLING_HOURS + CHECK_B_BASELINE_HOURS - 1,
  endIndex = intervals.length - 1,
}) {
  const fires = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const result = evaluateCheckBForIndex({ intervals, errorSeriesByPair, familyPolicy, index });
    for (const alert of result.alerts) {
      fires.push({ ...alert, index });
    }
  }
  return fires;
}

function evaluateCheckCAtIndex({ index, combinedSeriesByPair, intervals }) {
  const notices = [];

  for (const [pairKey, pairSeries] of Object.entries(combinedSeriesByPair)) {
    const currentWindowStart = index - (CHECK_B_ROLLING_HOURS - 1);
    const priorWindowStart = currentWindowStart - CHECK_B_BASELINE_HOURS;
    const priorWindowEnd = currentWindowStart;
    if (priorWindowStart < 0) continue;

    const current24 = sumRange(pairSeries.hourly, currentWindowStart, index + 1);
    const prior7d = sumRange(pairSeries.hourly, priorWindowStart, priorWindowEnd);

    const prevIndex = index - 1;
    const prevCurrentWindowStart = prevIndex - (CHECK_B_ROLLING_HOURS - 1);
    const prevPriorWindowStart = prevCurrentWindowStart - CHECK_B_BASELINE_HOURS;
    const prevPriorWindowEnd = prevCurrentWindowStart;
    if (prevPriorWindowStart < 0) continue;

    const prev24 = sumRange(pairSeries.hourly, prevCurrentWindowStart, prevIndex + 1);
    const prevPrior7d = sumRange(pairSeries.hourly, prevPriorWindowStart, prevPriorWindowEnd);

    const isNewNow = current24 > 0 && prior7d === 0;
    const wasNewPrev = prev24 > 0 && prevPrior7d === 0;

    if (isNewNow && !wasNewPrev) {
      notices.push({
        pairKey,
        outcome: pairSeries.outcome,
        reason: pairSeries.reason,
        current24,
        interval: intervals[index],
      });
    }
  }

  notices.sort((a, b) => b.current24 - a.current24 || a.pairKey.localeCompare(b.pairKey));
  return { notices };
}

export function evaluateCheckC({
  intervals,
  combinedSeriesByPair,
  index,
}) {
  const resolvedIndex = Number.isInteger(index) ? index : getLastCompleteBucketIndex(intervals);
  return evaluateCheckCAtIndex({ index: resolvedIndex, combinedSeriesByPair, intervals });
}

function evaluateCheckEAtIndex({
  index,
  intervals,
  acceptedHourly,
  livenessHourly,
  windowHours = CHECK_E_WINDOW_HOURS,
  livenessBaselineHours = CHECK_E_LIVENESS_BASELINE_HOURS,
  acceptedFloor = CHECK_E_ACCEPTED_FLOOR,
  livenessMinBaseline = CHECK_E_LIVENESS_MIN_BASELINE,
  livenessHoldRatio = CHECK_E_LIVENESS_HOLD_RATIO,
  livenessUnavailable = false,
}) {
  const windowStart = Math.max(0, index - windowHours + 1);
  const acceptedInWindow = sumRange(acceptedHourly, windowStart, index + 1);

  if (livenessUnavailable || livenessHourly === null) {
    return {
      verdict: 'inconclusive',
      acceptedInWindow,
      livenessInWindow: null,
      livenessExpected: null,
      interval: intervals[index],
      debug: {
        windowHours,
        livenessBaselineHours,
        acceptedFloor,
        livenessMinBaseline,
        livenessHoldRatio,
        reason: 'liveness_unavailable',
      },
    };
  }

  const livenessInWindow = sumRange(livenessHourly, windowStart, index + 1);
  const baselineEnd = windowStart;
  const baselineStart = baselineEnd - livenessBaselineHours;
  const clampedBaselineStart = Math.max(0, baselineStart);
  const actualBaselineHours = baselineEnd - clampedBaselineStart;

  if (actualBaselineHours < livenessBaselineHours) {
    return {
      verdict: 'inconclusive',
      acceptedInWindow,
      livenessInWindow,
      livenessExpected: null,
      interval: intervals[index],
      debug: {
        windowHours,
        livenessBaselineHours,
        acceptedFloor,
        livenessMinBaseline,
        livenessHoldRatio,
        actualBaselineHours,
        reason: 'truncated_baseline',
      },
    };
  }

  const livenessBaselineTotal = sumRange(livenessHourly, clampedBaselineStart, baselineEnd);
  const livenessExpected = livenessBaselineTotal * (windowHours / livenessBaselineHours);
  const livenessHoldThreshold = livenessHoldRatio * livenessExpected;

  let verdict;
  let reason = null;

  if (livenessBaselineTotal < livenessMinBaseline) {
    verdict = 'inconclusive';
    reason = 'thin_baseline';
  } else if (acceptedInWindow > acceptedFloor) {
    verdict = 'healthy';
  } else if (livenessInWindow >= livenessHoldThreshold) {
    verdict = 'dark-fleet';
  } else if (livenessInWindow === 0) {
    verdict = 'inconclusive';
    reason = 'liveness_also_dark';
  } else {
    verdict = 'fleet-lull';
  }

  return {
    verdict,
    acceptedInWindow,
    livenessInWindow,
    livenessExpected,
    interval: intervals[index],
    debug: {
      windowHours,
      livenessBaselineHours,
      acceptedFloor,
      livenessMinBaseline,
      livenessHoldRatio,
      livenessBaselineTotal,
      livenessHoldThreshold,
      reason,
    },
  };
}

/**
 * Telemetry-delivery canary: detect accepted-error volume collapse while
 * PostHog `Application Opened` liveness holds (DSN-dark-fleet signature).
 *
 * Edge-dedup: pages only on a fresh transition into `dark-fleet`, not every
 * run while the dark window persists. Uses the run-owned span (see check A's
 * CHECK_A_PAGE_WINDOW_HOURS / pageWindowHours) so a 3-hourly cron still pages
 * when the transition hour is not the latest complete bucket.
 */
export function evaluateCheckE({
  intervals,
  acceptedHourly,
  livenessHourly,
  index,
  windowHours = CHECK_E_WINDOW_HOURS,
  livenessBaselineHours = CHECK_E_LIVENESS_BASELINE_HOURS,
  acceptedFloor = CHECK_E_ACCEPTED_FLOOR,
  livenessMinBaseline = CHECK_E_LIVENESS_MIN_BASELINE,
  livenessHoldRatio = CHECK_E_LIVENESS_HOLD_RATIO,
  livenessUnavailable = false,
  pageWindowHours = MONITOR_RUN_INTERVAL_HOURS,
}) {
  const resolvedIndex = Number.isInteger(index) ? index : getLastCompleteBucketIndex(intervals);
  const evalParams = {
    intervals,
    acceptedHourly,
    livenessHourly,
    windowHours,
    livenessBaselineHours,
    acceptedFloor,
    livenessMinBaseline,
    livenessHoldRatio,
    livenessUnavailable,
  };
  const evalAtIndex = (bucketIndex) => evaluateCheckEAtIndex({ index: bucketIndex, ...evalParams });

  const current = evalAtIndex(resolvedIndex);

  // Run-owned span (mirrors evaluateCheckA's firstPageBucketAge..lastPageBucketAgeExclusive
  // arithmetic): each MONITOR_RUN_INTERVAL_HOURS run scans the buckets it owns for a
  // fresh non-dark→dark edge, not only the immediately previous hour.
  const pageBucketSpan = Math.max(1, Math.ceil(pageWindowHours));
  const firstBucketInSpan = Math.max(1, resolvedIndex - pageBucketSpan + 1);
  const lastBucketInSpan = resolvedIndex;

  let shouldPage = false;
  for (let bucketIndex = firstBucketInSpan; bucketIndex <= lastBucketInSpan; bucketIndex += 1) {
    const verdictAtBucket = evalAtIndex(bucketIndex).verdict;
    const verdictAtPriorBucket = evalAtIndex(bucketIndex - 1).verdict;
    if (verdictAtBucket === 'dark-fleet' && verdictAtPriorBucket !== 'dark-fleet') {
      shouldPage = true;
      break;
    }
  }

  let prevVerdict = null;
  if (resolvedIndex > 0) {
    prevVerdict = evalAtIndex(resolvedIndex - 1).verdict;
  }

  return {
    ...current,
    shouldPage,
    debug: {
      ...current.debug,
      prevVerdict,
      pageWindowHours,
      firstBucketInSpan,
      lastBucketInSpan,
    },
  };
}

/**
 * Mobile offline-queue permanent-failure surge detector (Check F).
 *
 * Fleet-level signal for the REBEL-6BJ / FOX-3516 class: recordings/uploads
 * silently terminalized as `permanent` and never retried. The per-item Sentry
 * escalation is throttled 1/hr/device/category, so raw event volume is dampened
 * and misleading — the trigger is DISTINCT USERS (= accounts), never raw events.
 *
 * Pure two-read compare (zero network): both `current` and `baseline` are
 * pre-computed window-level `count_unique(user)` reads:
 *   - current  = [T - WINDOW, T]                        (the detection window)
 *   - baseline = [T - WINDOW - INTERVAL, T - INTERVAL]  (the prior run's window,
 *     offset by MONITOR_RUN_INTERVAL_HOURS = 3h)
 * The two windows overlap by 3h, which is exactly what distinguishes a FRESH
 * surge (appeared in the run-owned [T-3h, T] span) from a SUSTAINED one — the
 * same fresh-edge dedup that check E does per-bucket (see Amendment A1-F1).
 *
 * `count_unique(user)` is non-additive, so we NEVER sum distinct-user counts:
 * each of `current`/`baseline` is already a proper window-level distinct count.
 *
 * Fail-loud (Amendment A1-F2): a missing `current` OR `baseline` read yields
 * verdict=`unavailable` (never a false `quiet` or a false fresh-edge page).
 *
 * @param {object} args
 * @param {{ distinctUsers: number, events: number } | null} args.current
 * @param {{ distinctUsers: number, events: number } | null} args.baseline
 * @param {number} [args.floor]
 * @returns {{ verdict: 'surge'|'quiet'|'unavailable', distinctUsers: number, events: number, shouldPage: boolean, debug: object }}
 */
export function evaluateCheckF({ current, baseline, floor = PERMFAIL_DISTINCT_USER_FLOOR }) {
  if (current == null || baseline == null) {
    return {
      verdict: 'unavailable',
      distinctUsers: 0,
      events: 0,
      shouldPage: false,
      debug: {
        floor,
        windowHours: PERMFAIL_DETECTION_WINDOW_HOURS,
        reason: current == null ? 'current_unavailable' : 'baseline_unavailable',
      },
    };
  }

  const currentVerdict = current.distinctUsers >= floor ? 'surge' : 'quiet';
  const baselineVerdict = baseline.distinctUsers >= floor ? 'surge' : 'quiet';
  const shouldPage = currentVerdict === 'surge' && baselineVerdict !== 'surge';

  return {
    verdict: currentVerdict,
    distinctUsers: current.distinctUsers,
    events: current.events,
    shouldPage,
    debug: {
      floor,
      windowHours: PERMFAIL_DETECTION_WINDOW_HOURS,
      baselineDistinctUsers: baseline.distinctUsers,
      baselineVerdict,
    },
  };
}

/**
 * Safety-eval billing-degradation SUSTAINED-RATE detector (Check H), split by reasonKind.
 *
 * Fleet-level signal for the 260622 safety-eval connector-error class
 * ("opaque single-credential routing starvation"): the safety eval fails CLOSED because a
 * single-credential user's model hit a plan cap (`reasonKind:billing`), silently blocking
 * their action. The producer (`recordSafetyEvalFailed` in `src/core/safetyPromptLogic.ts`)
 * tags the `Safety eval fail-closed` Sentry message with `reasonKind`, so this monitor
 * queries `reasonKind:billing` DAILY distinct-user counts.
 *
 * SUSTAINED-RATE (not a 6h spike — see the constant block): a 30d backtest showed this is
 * a STEADY ~6 distinct users/day background. A spike detector would page constantly, so
 * Check H pages ONLY when the most recent `minConsecutiveDays` daily distinct-user counts
 * are ALL >= `threshold` — a persistent/worsening trend, not a busy afternoon.
 *
 * Re-page suppression (no Check F two-window precedent applies to a multi-day rate, so use
 * the equivalent fresh-edge idea on the daily series): page only on a FRESH crossing — the
 * trailing M days are all >= threshold AND the day immediately BEFORE that M-day window was
 * < threshold (or absent). While the elevated condition persists it does NOT re-page; it
 * stays a daily-digest line (verdict `sustained-elevated`) so it isn't a repeated page.
 *
 * Fail-loud: any of the trailing M daily reads being `null` (malformed / unavailable —
 * the caller passes `null` for a degraded read) yields verdict=`unavailable` and never
 * pages. A legitimate zero day is `0` (NOT null) and counts as below threshold.
 *
 * `dailyDistinctUsers` is ordered OLDEST→NEWEST; the last `minConsecutiveDays` entries are
 * the trailing window, and the entry before them is the pre-window guard day.
 *
 * @param {object} args
 * @param {Array<number | null>} args.dailyDistinctUsers oldest→newest daily distinct-user counts
 * @param {number} [args.threshold]
 * @param {number} [args.minConsecutiveDays]
 * @returns {{ verdict: 'sustained-surge'|'sustained-elevated'|'quiet'|'unavailable', dailyDistinctUsers: Array<number|null>, peakDay: number, shouldPage: boolean, debug: object }}
 */
export function evaluateCheckH({
  dailyDistinctUsers,
  threshold = SAFETY_DEGRADED_DAILY_USER_THRESHOLD,
  minConsecutiveDays = SAFETY_DEGRADED_SUSTAINED_DAYS,
}) {
  const series = Array.isArray(dailyDistinctUsers) ? dailyDistinctUsers : [];
  const baseDebug = {
    threshold,
    minConsecutiveDays,
    windowHours: SAFETY_DEGRADED_DAY_WINDOW_HOURS,
  };

  // The trailing M-day window is the page-relevant slice. Any malformed read INSIDE it →
  // can't tell → unavailable (never a false quiet/page). Reads outside the window don't
  // gate the verdict (a missing older day is fine).
  const windowStart = series.length - minConsecutiveDays;
  if (series.length < minConsecutiveDays) {
    return {
      verdict: 'unavailable',
      dailyDistinctUsers: series,
      peakDay: 0,
      shouldPage: false,
      debug: { ...baseDebug, reason: 'insufficient_days' },
    };
  }

  const trailing = series.slice(windowStart);
  if (trailing.some((value) => value == null)) {
    return {
      verdict: 'unavailable',
      dailyDistinctUsers: series,
      peakDay: 0,
      shouldPage: false,
      debug: { ...baseDebug, reason: 'malformed_day_in_window' },
    };
  }

  const peakDay = Math.max(...trailing);
  const allElevated = trailing.every((value) => value >= threshold);

  if (!allElevated) {
    return {
      verdict: 'quiet',
      dailyDistinctUsers: series,
      peakDay,
      shouldPage: false,
      debug: { ...baseDebug, trailing },
    };
  }

  // Sustained-elevated. Fresh-edge re-page suppression: only page if the pre-window guard
  // day was below threshold (or absent / malformed — treat an unknown guard as "fresh" so
  // a first observation still pages once). While the run keeps seeing the elevated
  // condition, the guard day is itself elevated → no re-page (digest line only).
  const guardDay = windowStart > 0 ? series[windowStart - 1] : null;
  const guardElevated = guardDay != null && guardDay >= threshold;
  const shouldPage = !guardElevated;

  return {
    verdict: shouldPage ? 'sustained-surge' : 'sustained-elevated',
    dailyDistinctUsers: series,
    peakDay,
    shouldPage,
    debug: { ...baseDebug, trailing, guardDay, guardElevated },
  };
}

/**
 * Parse a Sentry `/events/` aggregate response body into the Check F shape.
 *
 * Pure / network-free so the row-handling (and the legitimate-zero vs malformed
 * distinction the F1 self-health wiring depends on) is unit-testable.
 *
 * Critical distinction:
 *   - A LEGITIMATELY-ZERO read — a parseable row of zeros, OR an empty `data: []`
 *     array meaning "no matching permanent-failure events in this window" — is the
 *     COMMON HEALTHY case (most 6h windows have zero permanent failures). It maps to
 *     `{ distinctUsers: 0, events: 0 }` → verdict `quiet`. It must NOT be `null` /
 *     `unavailable`, otherwise the monitor would page itself on every healthy run.
 *   - A STRUCTURALLY-MALFORMED read — a present row whose `count_unique(user)` /
 *     `count()` fields are missing or non-finite (and not a clean zero) — is genuinely
 *     "can't tell" → returns `null` → caller maps to verdict `unavailable` + degrades
 *     the Sentry dependency for self-health (Amendment A1-F2).
 *
 * @param {unknown} json the parsed JSON body from the Sentry events aggregate read
 * @returns {{ distinctUsers: number, events: number } | null}
 */
export function parsePermanentFailureAggregateRow(json) {
  const rows = Array.isArray(json?.data) ? json.data : null;
  if (rows === null) {
    // No `data` array at all — the body shape is wrong (not a confirmed zero).
    return null;
  }
  if (rows.length === 0) {
    // `data: []` — Sentry's representation of "no matching events in this window".
    // This is a legitimate zero (the common healthy case), NOT malformed.
    return { distinctUsers: 0, events: 0 };
  }

  const row = rows[0];
  if (!row || typeof row !== 'object') {
    return null;
  }

  const distinctUsers = parseNonNegativeCountField(row['count_unique(user)']);
  const events = parseNonNegativeCountField(row['count()']);
  if (distinctUsers === null || events === null) {
    return null;
  }

  return { distinctUsers, events };
}

/**
 * Parse a Sentry `/events/` `count()`-aggregate response body into a single count
 * (Check G's Sentry side). Same legitimate-zero vs malformed distinction as
 * `parsePermanentFailureAggregateRow`: a parseable zero row OR `data: []` → 0 (a
 * window with no bug-report events is legitimate); a present-but-unparseable
 * `count()` → `null` → caller maps to `unavailable` + degrades self-health.
 *
 * @param {unknown} json the parsed JSON body from the Sentry events count aggregate
 * @returns {number | null}
 */
export function parseSentryEventCountRow(json) {
  const rows = Array.isArray(json?.data) ? json.data : null;
  if (rows === null) return null;
  if (rows.length === 0) return 0;

  const row = rows[0];
  if (!row || typeof row !== 'object') return null;

  return parseNonNegativeCountField(row['count()']);
}

/**
 * Parse a single aggregate count field strictly. Accepts ONLY a finite non-negative
 * number, or a plain non-negative decimal-integer string (`/^\d+$/`) — so a genuine
 * zero (`0` or `"0"`) is accepted while malformed/empty values, and JS numeric-string
 * syntaxes a Sentry aggregate never emits (hex `"0x10"`, exponent `"1e3"`, `"Infinity"`,
 * decimals, signs), are rejected.
 *
 * The strictness matters: a permissive `Number(...)` coerces `null` / `''` / `false` /
 * `[]` all to `0`, which would make a MALFORMED aggregate row read as a healthy zero
 * (`quiet`, non-degraded) and silently pass `--verify-setup` — re-opening the exact
 * "can't-parse → all-quiet" class the malformed-vs-zero distinction is meant to close.
 *
 * @param {unknown} value raw field value from the aggregate row
 * @returns {number | null} the non-negative number, or null when malformed
 */
function parseNonNegativeCountField(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    // Accept ONLY a plain non-negative decimal-integer string. Bare `Number(...)`
    // would coerce JS numeric syntaxes a Sentry aggregate never emits — `'0x10'`→16,
    // `'1e3'`→1000, `'Infinity'`→∞, `'1abc'`→NaN (rejected, but `'0x10'`/`'1e3'` would
    // wrongly pass) — masking a malformed read as a healthy count.
    if (!/^\d+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  // null / undefined / boolean / array / object → malformed.
  return null;
}

/**
 * Map a settled Check F window read (`Promise.allSettled` result) to its value +
 * whether it should degrade the Sentry dependency feeding self-health.
 *
 * Pure so the Stage 2 glue (where Amendment A1-F2 lives) is unit-testable without
 * real I/O. A read DEGRADES self-health when it REJECTS (HTTP/network failure) OR
 * is fulfilled-but-`null` (structurally malformed body) — both are "can't tell".
 * A fulfilled non-null value — INCLUDING a legitimate `{ distinctUsers: 0 }` zero —
 * does NOT degrade.
 *
 * @param {{ status: 'fulfilled', value: unknown } | { status: 'rejected', reason: unknown }} settledResult
 * @returns {{ value: { distinctUsers: number, events: number } | null, degraded: boolean }}
 */
export function deriveCheckFRead(settledResult) {
  if (!settledResult || settledResult.status !== 'fulfilled') {
    return { value: null, degraded: true };
  }
  const value = settledResult.value ?? null;
  return { value, degraded: value === null };
}

/**
 * Bug-report delivery reconciliation (Check G).
 *
 * Pure compare (zero network): both counts are pre-computed window-level totals.
 *   - `posthogSubmitted` = count of PostHog `Bug Report Submitted` events in the window.
 *   - `sentryIndexed`    = count of Sentry `source:user-bug-report` events in the window.
 * A `null` for EITHER means the read was unavailable/malformed → verdict `unavailable`
 * (never a false `healthy`); the caller also degrades the relevant dependency for
 * self-health so chronic blindness escalates.
 *
 * Verdicts:
 *   - `unavailable` — a read is missing (can't tell).
 *   - `inconclusive` — too few PostHog submissions (< MIN_POSTHOG_SUBMISSIONS) to reason
 *     about a ratio; not a page.
 *   - `shortfall` — Sentry materially below PostHog (below the ratio AND missing at least
 *     MIN_ABSOLUTE_MISS events) → page. This is the "users submit but reports don't land"
 *     signal that motivated the whole task.
 *   - `healthy` — Sentry meets/exceeds the expected floor (or the gap is within tolerance).
 *
 * Note: Sentry > PostHog is NOT a shortfall (desktop reports historically reached Sentry
 * without a PostHog `sentry_event_id`, and check A already watches the reverse-diff).
 *
 * @param {object} args
 * @param {number | null} args.posthogSubmitted
 * @param {number | null} args.sentryIndexed
 * @param {number} [args.shortfallRatio]
 * @param {number} [args.minAbsoluteMiss]
 * @param {number} [args.minPosthogSubmissions]
 * @returns {{ verdict: 'shortfall'|'healthy'|'inconclusive'|'unavailable', posthogSubmitted: number, sentryIndexed: number, missing: number, shouldPage: boolean, debug: object }}
 */
export function evaluateCheckG({
  posthogSubmitted,
  sentryIndexed,
  shortfallRatio = CHECK_G_SHORTFALL_RATIO,
  minAbsoluteMiss = CHECK_G_MIN_ABSOLUTE_MISS,
  minPosthogSubmissions = CHECK_G_MIN_POSTHOG_SUBMISSIONS,
}) {
  const baseDebug = {
    windowHours: CHECK_G_WINDOW_HOURS,
    shortfallRatio,
    minAbsoluteMiss,
    minPosthogSubmissions,
  };

  if (posthogSubmitted == null || sentryIndexed == null) {
    return {
      verdict: 'unavailable',
      posthogSubmitted: posthogSubmitted ?? 0,
      sentryIndexed: sentryIndexed ?? 0,
      missing: 0,
      shouldPage: false,
      debug: {
        ...baseDebug,
        reason: posthogSubmitted == null ? 'posthog_unavailable' : 'sentry_unavailable',
      },
    };
  }

  // Expected Sentry floor = the share of PostHog submissions we must see in Sentry.
  const expectedFloor = (1 - shortfallRatio) * posthogSubmitted;
  const missing = Math.max(0, posthogSubmitted - sentryIndexed);

  if (posthogSubmitted < minPosthogSubmissions) {
    return {
      verdict: 'inconclusive',
      posthogSubmitted,
      sentryIndexed,
      missing,
      shouldPage: false,
      debug: { ...baseDebug, reason: 'thin_sample', expectedFloor },
    };
  }

  const belowRatio = sentryIndexed < expectedFloor;
  const materialMiss = missing >= minAbsoluteMiss;
  const isShortfall = belowRatio && materialMiss;

  return {
    verdict: isShortfall ? 'shortfall' : 'healthy',
    posthogSubmitted,
    sentryIndexed,
    missing,
    shouldPage: isShortfall,
    debug: { ...baseDebug, expectedFloor, belowRatio, materialMiss },
  };
}

const DEFAULT_SELF_HEALTH_STATE = {
  consecutiveDegradedRuns: 0,
  lastDegradedDependencies: [],
};

/**
 * Parse persisted self-health state from JSON. Malformed/empty/missing input
 * returns the default (counter=0) — never throws (fail-open to non-escalation).
 *
 * @param {string} [raw]
 * @returns {{ consecutiveDegradedRuns: number, lastDegradedDependencies: string[] }}
 */
export function parseSelfHealthState(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ...DEFAULT_SELF_HEALTH_STATE };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_SELF_HEALTH_STATE };
    }
    const consecutiveDegradedRuns = Number.isFinite(parsed.consecutiveDegradedRuns)
      ? Math.max(0, Math.floor(parsed.consecutiveDegradedRuns))
      : 0;
    const lastDegradedDependencies = Array.isArray(parsed.lastDegradedDependencies)
      ? parsed.lastDegradedDependencies.filter((name) => typeof name === 'string')
      : [];
    return { consecutiveDegradedRuns, lastDegradedDependencies };
  } catch {
    return { ...DEFAULT_SELF_HEALTH_STATE };
  }
}

/**
 * Serialize self-health state deterministically for persistence.
 *
 * @param {{ consecutiveDegradedRuns?: number, lastDegradedDependencies?: string[] }} state
 * @returns {string}
 */
export function serializeSelfHealthState(state = {}) {
  const consecutiveDegradedRuns = Number.isFinite(state.consecutiveDegradedRuns)
    ? Math.max(0, Math.floor(state.consecutiveDegradedRuns))
    : 0;
  const lastDegradedDependencies = Array.isArray(state.lastDegradedDependencies)
    ? [...state.lastDegradedDependencies].filter((name) => typeof name === 'string').sort()
    : [];
  return JSON.stringify({ consecutiveDegradedRuns, lastDegradedDependencies });
}

/**
 * Chronic-degradation detector for the monitor's own read path.
 *
 * A run is degraded when ANY dependency is `blind` or `fail`. Escalation fires
 * only on the run that first crosses `threshold` consecutive degraded runs
 * (single escalation per streak; ongoing blindness relies on per-run BLIND
 * lines + digest thereafter).
 *
 * @param {object} args
 * @param {Array<{ name: string, status: 'ok'|'blind'|'fail', detail?: string }>} args.dependencies
 * @param {{ consecutiveDegradedRuns?: number, lastDegradedDependencies?: string[] }} [args.priorState]
 * @param {number} [args.threshold]
 */
export function evaluateMonitorSelfHealth({
  dependencies = [],
  priorState = {},
  threshold = SELF_HEALTH_ESCALATION_THRESHOLD,
}) {
  const blindDependencies = dependencies
    .filter((dep) => dep.status === 'blind')
    .map((dep) => dep.name);
  const failedDependencies = dependencies
    .filter((dep) => dep.status === 'fail')
    .map((dep) => dep.name);

  const degraded = blindDependencies.length > 0 || failedDependencies.length > 0;
  const priorCount = Number.isFinite(priorState.consecutiveDegradedRuns)
    ? Math.max(0, Math.floor(priorState.consecutiveDegradedRuns))
    : 0;

  let consecutiveDegradedRuns;
  let lastDegradedDependencies;

  if (degraded) {
    consecutiveDegradedRuns = priorCount + 1;
    lastDegradedDependencies = [...new Set([...blindDependencies, ...failedDependencies])].sort();
  } else {
    consecutiveDegradedRuns = 0;
    lastDegradedDependencies = [];
  }

  const nextState = { consecutiveDegradedRuns, lastDegradedDependencies };
  const shouldEscalate = degraded && (priorCount + 1 === threshold);
  const escalationKind = shouldEscalate ? 'fresh' : 'none';

  return {
    degraded,
    consecutiveDegradedRuns,
    shouldEscalate,
    escalationKind,
    blindDependencies,
    failedDependencies,
    nextState,
  };
}

/**
 * Whether to post a self-health escalation to Slack (not dry-run print).
 *
 * Escalation is gated on durable state persistence so a failed write cannot
 * leave the counter un-advanced and double-page on the next run.
 *
 * @param {{ shouldEscalate: boolean, persisted: boolean, dryRun: boolean }} args
 * @returns {boolean}
 */
export function shouldPostSelfHealthEscalation({ shouldEscalate, persisted, dryRun }) {
  if (!shouldEscalate) return false;
  if (dryRun) return false;
  return persisted;
}

/**
 * Whether a real-run escalation was suppressed because state could not be persisted.
 *
 * @param {{ shouldEscalate: boolean, persisted: boolean, dryRun: boolean }} args
 * @returns {boolean}
 */
export function shouldWarnSelfHealthEscalationSuppressed({ shouldEscalate, persisted, dryRun }) {
  return shouldEscalate && !dryRun && !persisted;
}

/**
 * Loud stdout warning when escalation is suppressed due to a persist failure.
 *
 * @param {object} args
 * @param {ReturnType<typeof evaluateMonitorSelfHealth>} args.selfHealth
 */
export function formatSelfHealthEscalationPersistFailureWarning({ selfHealth }) {
  const blindPart = selfHealth.blindDependencies.length > 0
    ? `blind=[${selfHealth.blindDependencies.join(', ')}]`
    : 'blind=[]';
  const failedPart = selfHealth.failedDependencies.length > 0
    ? `failed=[${selfHealth.failedDependencies.join(', ')}]`
    : 'failed=[]';
  return (
    'sentry-outcome-monitor: WARNING self-health escalation suppressed: degraded run would have '
    + `paged Slack (consecutive=${selfHealth.consecutiveDegradedRuns}, ${blindPart}, ${failedPart}) `
    + 'but self-health state could not be persisted — skipping Slack to avoid double-paging on the '
    + 'next run; per-run BLIND/FAIL stdout and digest remain the standing signal.'
  );
}

/**
 * Format a chronic self-health escalation Slack message.
 *
 * @param {object} args
 * @param {ReturnType<typeof evaluateMonitorSelfHealth>} args.selfHealth
 * @param {number} [args.runIntervalHours]
 * @param {string} [args.runbookPath]
 */
export function formatSelfHealthEscalation({
  selfHealth,
  runIntervalHours = MONITOR_RUN_INTERVAL_HOURS,
  runbookPath = 'docs/project/SENTRY_TRIAGE.md',
}) {
  const elapsedHours = selfHealth.consecutiveDegradedRuns * runIntervalHours;
  const parts = [];
  if (selfHealth.blindDependencies.length > 0) {
    parts.push(`blind: ${selfHealth.blindDependencies.join(', ')}`);
  }
  if (selfHealth.failedDependencies.length > 0) {
    parts.push(`failed: ${selfHealth.failedDependencies.join(', ')}`);
  }
  const dependencySummary = parts.length > 0 ? parts.join('; ') : 'none';

  return [
    ':rotating_light: Sentry outcome monitor — self-health escalation (chronic read-path degradation)',
    `consecutive degraded runs=${selfHealth.consecutiveDegradedRuns} (~${elapsedHours}h at ${runIntervalHours}h cadence)`,
    `dependencies: ${dependencySummary}`,
    `runbook: ${runbookPath} (postmortem 260618_sentry_outcome_monitor_403_underscoped_token — a 403 means the monitor token lacks org:read)`,
  ].join('\n');
}

export function buildDigestMessage({
  nowMs,
  checkA,
  checkB,
  checkC,
  checkE,
  checkF,
  checkG,
  checkH,
  statsTotals,
  selfHealth,
  runbookPath = 'docs/project/SENTRY_TRIAGE.md',
}) {
  const nowIso = new Date(nowMs).toISOString();
  const reverseDiffSummary = checkA.reverseDiffIds.length > 0
    ? compactIds(checkA.reverseDiffIds).join(', ')
    : 'none';
  const missingSummary = checkA.missingIds.length > 0
    ? compactIds(checkA.missingIds).join(', ')
    : 'none';

  const lines = [
    `Sentry outcome monitor digest — ${nowIso}`,
    `check A coverage: ${checkA.coverageState}`,
    `check A counts: tracked 24h=${checkA.tracked24hCount}, tracked 7d=${checkA.tracked7dCount}, indexed 24h=${checkA.indexed24hCount}`,
    `check A reverse diff (indexed without tracked, 24h): ${checkA.reverseDiffIds.length} [${reverseDiffSummary}]`,
    `check A cumulative missing ids (26h lookback): ${checkA.missingIds.length} [${missingSummary}]`,
    `check B family trends (rolling 24h vs previous 24h):`,
  ];

  for (const trend of checkB.trends) {
    lines.push(
      `- ${trend.family} (${trend.mode}): current24=${trend.current24}, prev24=${trend.previous24}, delta=${trend.delta24}`,
    );
  }

  if (statsTotals) {
    lines.push(
      `stats totals: error_24h=${statsTotals.error24h}, attachment_24h=${statsTotals.attachment24h}, error_prev24h=${statsTotals.errorPrev24h}, attachment_prev24h=${statsTotals.attachmentPrev24h}`,
    );
  }

  if (checkC.notices.length > 0) {
    const notices = compactIds(checkC.notices.map((notice) => notice.pairKey));
    lines.push(`check C new reasons (24h, first-seen edge): ${checkC.notices.length} [${notices.join(', ')}]`);
  } else {
    lines.push('check C new reasons (24h, first-seen edge): none');
  }

  if (checkE) {
    const livenessPart = checkE.livenessInWindow === null
      ? 'liveness=N/A'
      : `liveness=${checkE.livenessInWindow}/${checkE.livenessExpected?.toFixed(1) ?? '?'}`;
    lines.push(
      `check E telemetry canary (${CHECK_E_WINDOW_HOURS}h): verdict=${checkE.verdict}, accepted=${checkE.acceptedInWindow}, ${livenessPart}`,
    );
    if (checkE.verdict === 'inconclusive') {
      const noteReason = checkE.debug?.reason ?? 'unknown';
      lines.push(`check E NOTE: inconclusive (${noteReason}) — cannot confirm fleet liveness; do not treat as all-clear`);
    } else if (checkE.verdict === 'dark-fleet') {
      lines.push('check E NOTE: dark-fleet — accepted volume collapsed while liveness held');
    }
  }

  if (checkF) {
    lines.push(
      `check F permanent-failure surge (${PERMFAIL_DETECTION_WINDOW_HOURS}h): verdict=${checkF.verdict}, distinct_users=${checkF.distinctUsers} (floor ${PERMFAIL_DISTINCT_USER_FLOOR}), events=${checkF.events}`,
    );
    if (checkF.verdict === 'unavailable') {
      const noteReason = checkF.debug?.reason ?? 'unknown';
      lines.push(`check F NOTE: unavailable (${noteReason}) — could not read the permanent-failure aggregate; do not treat as all-clear`);
    } else if (checkF.verdict === 'surge') {
      lines.push('check F NOTE: surge — mobile offline-queue permanent failures crossed the fleet floor');
    }
  }

  if (checkG) {
    lines.push(
      `check G delivery reconciliation (${CHECK_G_WINDOW_HOURS}h): verdict=${checkG.verdict}, `
        + `posthog_submitted=${checkG.posthogSubmitted}, sentry_indexed=${checkG.sentryIndexed}, missing=${checkG.missing}`,
    );
    if (checkG.verdict === 'unavailable') {
      const noteReason = checkG.debug?.reason ?? 'unknown';
      lines.push(`check G NOTE: unavailable (${noteReason}) — could not reconcile PostHog vs Sentry; do not treat as all-clear`);
    } else if (checkG.verdict === 'shortfall') {
      lines.push('check G NOTE: shortfall — users submitted bug reports but materially fewer landed in Sentry');
    } else if (checkG.verdict === 'inconclusive') {
      lines.push(`check G NOTE: inconclusive (${checkG.debug?.reason ?? 'thin_sample'}) — too few submissions to reconcile`);
    }
  }

  if (checkH) {
    const daily = Array.isArray(checkH.dailyDistinctUsers)
      ? checkH.dailyDistinctUsers.map((value) => (value == null ? 'NA' : value)).join(',')
      : '';
    lines.push(
      `check H safety-eval billing degradation (sustained-rate, >=${SAFETY_DEGRADED_DAILY_USER_THRESHOLD}/day x ${SAFETY_DEGRADED_SUSTAINED_DAYS}d): `
        + `verdict=${checkH.verdict}, peak_day=${checkH.peakDay}, daily=[${daily}]`,
    );
    if (checkH.verdict === 'unavailable') {
      const noteReason = checkH.debug?.reason ?? 'unknown';
      lines.push(`check H NOTE: unavailable (${noteReason}) — could not read the safety-eval billing degradation aggregate; do not treat as all-clear`);
    } else if (checkH.verdict === 'sustained-surge') {
      lines.push('check H NOTE: sustained-surge — billing fail-closed degradation crossed the sustained-rate threshold (fresh page)');
    } else if (checkH.verdict === 'sustained-elevated') {
      lines.push('check H NOTE: sustained-elevated — billing fail-closed degradation STILL above threshold (already paged; digest-only, not re-paged)');
    }
  }

  if (selfHealth) {
    const degradedDeps = [...selfHealth.blindDependencies, ...selfHealth.failedDependencies];
    const statusPart = selfHealth.degraded
      ? `degraded [${degradedDeps.join(', ')}]`
      : 'healthy';
    lines.push(`self-health: consecutive_degraded_runs=${selfHealth.consecutiveDegradedRuns}, ${statusPart}`);
  }

  lines.push(`runbook: ${runbookPath}`);

  return lines.join('\n');
}

export function summarizeCategoryTotals({ totalsByCategory, index }) {
  const errorSeries = totalsByCategory.error ?? [];
  const attachmentSeries = totalsByCategory.attachment ?? [];
  const error24h = sumRange(errorSeries, Math.max(0, index - 23), index + 1);
  const attachment24h = sumRange(attachmentSeries, Math.max(0, index - 23), index + 1);
  const errorPrev24h = index > 0
    ? sumRange(errorSeries, Math.max(0, index - 24), index)
    : 0;
  const attachmentPrev24h = index > 0
    ? sumRange(attachmentSeries, Math.max(0, index - 24), index)
    : 0;

  return {
    error24h,
    attachment24h,
    errorPrev24h,
    attachmentPrev24h,
  };
}

export function formatCheckAAlert({ checkA, runbookPath = 'docs/project/SENTRY_TRIAGE.md' }) {
  const ids = compactIds(checkA.newlyExpiredMissingIds).join(', ');
  return [
    ':rotating_light: Sentry outcome monitor — check A (accepted bug reports missing from index)',
    `missing sentry_event_id(s): ${ids}`,
    `tracked 24h/7d=${checkA.tracked24hCount}/${checkA.tracked7dCount}, indexed 24h=${checkA.indexed24hCount}`,
    `runbook: ${runbookPath}`,
  ].join('\n');
}

export function formatCheckBAlert({ checkB, runbookPath = 'docs/project/SENTRY_TRIAGE.md' }) {
  const lines = [
    ':rotating_light: Sentry outcome monitor — check B (sensitive outcome delta)',
  ];
  for (const alert of checkB.alerts) {
    lines.push(
      `- ${alert.pairKey}: current24=${alert.current24}, threshold=${alert.threshold.toFixed(2)}, baseline=${alert.robustBaseline.toFixed(2)}`,
    );
  }
  lines.push(`runbook: ${runbookPath}`);
  return lines.join('\n');
}

export function formatCheckCNotice({ checkC, runbookPath = 'docs/project/SENTRY_TRIAGE.md' }) {
  const pairs = compactIds(checkC.notices.map((notice) => notice.pairKey)).join(', ');
  return [
    ':information_source: Sentry outcome monitor — check C (new outcome/reason pair)',
    `new pair(s) in last 24h with no prior 7d history: ${pairs}`,
    `runbook: ${runbookPath}`,
  ].join('\n');
}

export function formatCheckEAlert({ checkE, runbookPath = 'docs/project/SENTRY_TRIAGE.md' }) {
  const livenessPart = checkE.livenessInWindow === null
    ? 'liveness=N/A'
    : `liveness=${checkE.livenessInWindow} vs expected=${checkE.livenessExpected?.toFixed(1) ?? '?'}`;
  return [
    ':rotating_light: Sentry outcome monitor — check E (telemetry-delivery canary)',
    `verdict=${checkE.verdict}, accepted_in_window=${checkE.acceptedInWindow}, ${livenessPart}, window=${CHECK_E_WINDOW_HOURS}h`,
    `runbook: ${runbookPath}`,
  ].join('\n');
}

export function formatCheckFAlert({ checkF, runbookPath = 'docs/project/SENTRY_TRIAGE.md' }) {
  return [
    ':rotating_light: Sentry outcome monitor — check F (mobile offline-queue permanent-failure surge)',
    `distinct affected users=${checkF.distinctUsers} (>= floor ${PERMFAIL_DISTINCT_USER_FLOOR}), events=${checkF.events}, window=${PERMFAIL_DETECTION_WINDOW_HOURS}h`,
    'signal: queue_event:item-permanent-failure — recordings/uploads silently terminalized as permanent (REBEL-6BJ / FOX-3516 class)',
    `runbook: ${runbookPath}`,
  ].join('\n');
}

export function formatCheckGAlert({ checkG, runbookPath = 'docs/project/SENTRY_TRIAGE.md' }) {
  return [
    ':rotating_light: Sentry outcome monitor — check G (bug-report delivery shortfall)',
    `PostHog submissions=${checkG.posthogSubmitted} vs Sentry user-bug-report events=${checkG.sentryIndexed} `
      + `(missing ${checkG.missing}, window=${CHECK_G_WINDOW_HOURS}h, expected >= ${checkG.debug?.expectedFloor?.toFixed(1) ?? '?'})`,
    'signal: users submitted bug reports but materially fewer landed in Sentry — reports are being dropped in the pipeline',
    `runbook: ${runbookPath}`,
  ].join('\n');
}

export function formatCheckHAlert({ checkH, runbookPath = 'docs/project/SENTRY_TRIAGE.md' }) {
  const threshold = checkH.debug?.threshold ?? SAFETY_DEGRADED_DAILY_USER_THRESHOLD;
  const days = checkH.debug?.minConsecutiveDays ?? SAFETY_DEGRADED_SUSTAINED_DAYS;
  return [
    ':rotating_light: Sentry outcome monitor — check H (safety-eval billing degradation sustained)',
    `Safety-eval billing degradation sustained: >= ${threshold} distinct users/day for ${days} days `
      + `(peak day=${checkH.peakDay}; signal: "Safety eval fail-closed" reasonKind:billing)`,
    'likely users hitting AI-plan usage caps with no auto-recovery — the safety eval fails CLOSED and silently '
      + 'blocks their action. Trend, not a spike.',
    `runbook: ${runbookPath}#check-h`,
  ].join('\n');
}

// 15:00 UTC — must be an hour the 3-hourly cron actually fires (0,3,6,9,12,15,18,21).
// 16:00 (the hourly-era value) never occurs on this schedule.
export const DAILY_DIGEST_UTC_HOUR = 15;

export function isDailyDigestRun(nowMs) {
  const date = new Date(nowMs);
  return date.getUTCHours() === DAILY_DIGEST_UTC_HOUR;
}

export function makeEventRecord(eventId, timestamp, extra = {}) {
  return {
    eventId,
    timestamp,
    ...extra,
  };
}
