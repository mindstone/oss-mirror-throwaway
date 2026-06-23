import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '__fixtures__',
  'sentry-outcome-monitor',
);

async function loadChecks() {
  return import('../lib/outcomeMonitorChecks.mjs');
}

function loadJsonFixture(name: string) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

function buildHourlyIntervals(hours: number, startIso = '2026-06-01T00:00:00Z'): string[] {
  const startMs = Date.parse(startIso);
  return Array.from({ length: hours }, (_, index) => new Date(startMs + (index * 60 * 60 * 1000)).toISOString());
}

describe('sentry outcome monitor checks', () => {
  it('check A pages once when cron drift stretches the 3-hourly gap (3h15m apart)', async () => {
    const checks = await loadChecks();

    const eventTimestampMs = Date.parse('2026-06-11T09:17:00Z');
    const trackedEvents = [
      checks.makeEventRecord('evt_gap', new Date(eventTimestampMs).toISOString()),
    ];

    // Run cadence is 3-hourly (MONITOR_RUN_INTERVAL_HOURS); page window = 3
    // hour-buckets, ages [3, 6). Bucket age 2 at run 1 -> not yet expired.
    const run1NowMs = eventTimestampMs + (1.92 * 60 * 60 * 1000);
    const run1 = checks.evaluateCheckA({
      nowMs: run1NowMs,
      trackedEvents,
      indexedEvents: [],
    });
    expect(run1.newlyExpiredMissingIds).toEqual([]);

    // Drifted next run: 3h15m later -> bucket age 5, still inside [3, 6) -> pages exactly once.
    const run2NowMs = run1NowMs + ((3 * 60 + 15) * 60 * 1000);
    const run2 = checks.evaluateCheckA({
      nowMs: run2NowMs,
      trackedEvents,
      indexedEvents: [],
    });
    expect(run2.newlyExpiredMissingIds).toEqual(['evt_gap']);

    // Following run on cadence -> bucket age >= 6 -> never re-pages.
    const run3 = checks.evaluateCheckA({
      nowMs: run2NowMs + (3 * 60 * 60 * 1000),
      trackedEvents,
      indexedEvents: [],
    });
    expect(run3.newlyExpiredMissingIds).toEqual([]);
  });

  it('check A pages once when the next 3-hourly run arrives early (2h40m apart)', async () => {
    const checks = await loadChecks();

    const eventTimestampMs = Date.parse('2026-06-11T09:17:00Z');
    const trackedEvents = [
      checks.makeEventRecord('evt_double', new Date(eventTimestampMs).toISOString()),
    ];

    // Bucket age 3 at run 1 -> pages.
    const run1NowMs = eventTimestampMs + (3.17 * 60 * 60 * 1000);
    const run1 = checks.evaluateCheckA({
      nowMs: run1NowMs,
      trackedEvents,
      indexedEvents: [],
    });
    expect(run1.newlyExpiredMissingIds).toEqual(['evt_double']);

    // Early next run (2h40m): bucket age 6 -> outside [3, 6) -> no double-page.
    const run2NowMs = run1NowMs + ((2 * 60 + 40) * 60 * 1000);
    const run2 = checks.evaluateCheckA({
      nowMs: run2NowMs,
      trackedEvents,
      indexedEvents: [],
    });
    expect(run2.newlyExpiredMissingIds).toEqual([]);

    const run3 = checks.evaluateCheckA({
      nowMs: run2NowMs + (3 * 60 * 60 * 1000),
      trackedEvents,
      indexedEvents: [],
    });
    expect(run3.newlyExpiredMissingIds).toEqual([]);
  });

  it('check A reports BLIND and ACTIVE coverage states correctly', async () => {
    const checks = await loadChecks();
    const nowMs = Date.parse('2026-06-11T16:00:00Z');

    const blind = checks.evaluateCheckA({
      nowMs,
      trackedEvents: [],
      indexedEvents: [],
    });
    expect(blind.coverageState).toContain('BLIND');

    const active = checks.evaluateCheckA({
      nowMs,
      trackedEvents: [checks.makeEventRecord('evt1', '2026-06-10T20:00:00Z')],
      indexedEvents: [],
    });
    expect(active.coverageState).toContain('ACTIVE');
  });

  it('check C only fires on the new-reason edge and dedups the next hour', async () => {
    const checks = await loadChecks();

    const intervals = buildHourlyIntervals(194);
    const series = new Array(194).fill(0);
    series[192] = 1;
    series[193] = 1;

    const combinedSeriesByPair = {
      'invalid/new_reason_code': {
        outcome: 'invalid',
        reason: 'new_reason_code',
        hourly: series,
      },
    };

    const firstFire = checks.evaluateCheckC({
      intervals,
      combinedSeriesByPair,
      index: 192,
    });
    expect(firstFire.notices.map((notice: { pairKey: string }) => notice.pairKey)).toEqual(['invalid/new_reason_code']);

    const secondRun = checks.evaluateCheckC({
      intervals,
      combinedSeriesByPair,
      index: 193,
    });
    expect(secondRun.notices).toHaveLength(0);
  });

  it('partial-bucket spike is evaluated on the next run and never swallowed', async () => {
    const checks = await loadChecks();
    const pairKey = 'invalid/invalid_json';
    const newReasonKey = 'invalid/new_reason_code';

    const runNIntervals = buildHourlyIntervals(194);
    const runNPlus1Intervals = buildHourlyIntervals(195);
    const runNPlus2Intervals = buildHourlyIntervals(196);

    const checkBRunN = checks.evaluateCheckB({
      intervals: runNIntervals,
      errorSeriesByPair: {
        [pairKey]: {
          outcome: 'invalid',
          reason: 'invalid_json',
          hourly: new Array(194).fill(0),
        },
      },
    });
    expect(checkBRunN.alerts).toHaveLength(0);

    const checkBRunNPlus1Series = new Array(195).fill(0);
    checkBRunNPlus1Series[193] = 12;
    const checkBRunNPlus1 = checks.evaluateCheckB({
      intervals: runNPlus1Intervals,
      errorSeriesByPair: {
        [pairKey]: {
          outcome: 'invalid',
          reason: 'invalid_json',
          hourly: checkBRunNPlus1Series,
        },
      },
    });
    expect(checkBRunNPlus1.alerts.map((alert: { pairKey: string }) => alert.pairKey)).toEqual([pairKey]);

    const checkBRunNPlus2Series = new Array(196).fill(0);
    checkBRunNPlus2Series[193] = 12;
    const checkBRunNPlus2 = checks.evaluateCheckB({
      intervals: runNPlus2Intervals,
      errorSeriesByPair: {
        [pairKey]: {
          outcome: 'invalid',
          reason: 'invalid_json',
          hourly: checkBRunNPlus2Series,
        },
      },
    });
    expect(checkBRunNPlus2.alerts).toHaveLength(0);

    const checkCRunN = checks.evaluateCheckC({
      intervals: runNIntervals,
      combinedSeriesByPair: {
        [newReasonKey]: {
          outcome: 'invalid',
          reason: 'new_reason_code',
          hourly: new Array(194).fill(0),
        },
      },
    });
    expect(checkCRunN.notices).toHaveLength(0);

    const checkCRunNPlus1Series = new Array(195).fill(0);
    checkCRunNPlus1Series[193] = 1;
    const checkCRunNPlus1 = checks.evaluateCheckC({
      intervals: runNPlus1Intervals,
      combinedSeriesByPair: {
        [newReasonKey]: {
          outcome: 'invalid',
          reason: 'new_reason_code',
          hourly: checkCRunNPlus1Series,
        },
      },
    });
    expect(checkCRunNPlus1.notices.map((notice: { pairKey: string }) => notice.pairKey)).toEqual([newReasonKey]);

    const checkCRunNPlus2Series = new Array(196).fill(0);
    checkCRunNPlus2Series[193] = 1;
    const checkCRunNPlus2 = checks.evaluateCheckC({
      intervals: runNPlus2Intervals,
      combinedSeriesByPair: {
        [newReasonKey]: {
          outcome: 'invalid',
          reason: 'new_reason_code',
          hourly: checkCRunNPlus2Series,
        },
      },
    });
    expect(checkCRunNPlus2.notices).toHaveLength(0);
  });

  it('daily digest includes counts, reverse diff, coverage line, and missing list', async () => {
    const checks = await loadChecks();

    const nowMs = Date.parse('2026-06-11T16:00:00Z');
    const checkA = checks.evaluateCheckA({
      nowMs,
      trackedEvents: [checks.makeEventRecord('tracked-1', '2026-06-11T13:00:00Z')],
      indexedEvents: [
        checks.makeEventRecord('tracked-1', '2026-06-11T13:20:00Z'),
        checks.makeEventRecord('legacy-index-only', '2026-06-11T12:00:00Z'),
      ],
    });

    const digest = checks.buildDigestMessage({
      nowMs,
      checkA,
      checkB: {
        trends: [
          { family: 'invalid', mode: 'alert', current24: 12, previous24: 4, delta24: 8 },
        ],
        alerts: [],
      },
      checkC: { notices: [] },
      statsTotals: {
        error24h: 42,
        attachment24h: 1024,
        errorPrev24h: 20,
        attachmentPrev24h: 512,
      },
    });

    expect(digest).toContain('check A coverage: ACTIVE');
    expect(digest).toContain('check A counts: tracked 24h=1, tracked 7d=1, indexed 24h=2');
    expect(digest).toContain('reverse diff');
    expect(digest).toContain('legacy-index-only');
    expect(digest).toContain('cumulative missing ids');
    expect(digest).toContain('check B family trends');
  });

  it('check B backtest stays within holdout budget and still fires on known incidents', async () => {
    const checks = await loadChecks();

    const errorTrain = loadJsonFixture('error-train-30d.json');
    const attachmentTrain = loadJsonFixture('attachment-train-30d.json');
    const errorHoldout = loadJsonFixture('error-holdout-30d.json');
    const attachmentHoldout = loadJsonFixture('attachment-holdout-30d.json');

    const trainIndex = checks.buildOutcomeSeriesIndex({
      errorStats: errorTrain,
      attachmentStats: attachmentTrain,
    });
    const holdoutIndex = checks.buildOutcomeSeriesIndex({
      errorStats: errorHoldout,
      attachmentStats: attachmentHoldout,
    });

    const trainFires = checks.collectCheckBFireEdges({
      intervals: trainIndex.intervals,
      errorSeriesByPair: trainIndex.errorSeriesByPair,
    });
    const holdoutFires = checks.collectCheckBFireEdges({
      intervals: holdoutIndex.intervals,
      errorSeriesByPair: holdoutIndex.errorSeriesByPair,
    });
    const loosenedTrainFires = checks.collectCheckBFireEdges({
      intervals: trainIndex.intervals,
      errorSeriesByPair: trainIndex.errorSeriesByPair,
      familyPolicy: {
        ...checks.CHECK_B_FAMILY_POLICY,
        invalid: { mode: 'alert', multiplier: 1, floor: 1 },
      },
    });

    expect(trainFires.length).toBeLessThanOrEqual(2);
    expect(trainFires.some((fire: { pairKey: string }) => fire.pairKey === 'invalid/too_large:event')).toBe(true);
    expect(trainFires.some((fire: { pairKey: string }) => fire.pairKey === 'invalid/invalid_json')).toBe(true);
    expect(trainFires.every((fire: { pairKey: string }) => !fire.pairKey.startsWith('rate_limited/'))).toBe(true);
    // Observed backtest result on the captured real holdout month was exactly 0
    // fires (recorded in PLAN Decision Log); pin it so threshold drift can't
    // hide behind the <=2/30d budget.
    expect(holdoutFires.length).toBe(0);
    expect(loosenedTrainFires.length).toBeGreaterThan(2);
  });

  it('check B suppresses synthetic 429 storm pages for chronic rate-limited families', async () => {
    const checks = await loadChecks();

    const intervals = buildHourlyIntervals(193);
    const mostlyZero = new Array(193).fill(0);
    const keyQuotaStorm = [...mostlyZero];
    for (let i = 168; i < 193; i += 1) {
      keyQuotaStorm[i] = i % 2 === 0 ? 200 : 320;
    }

    const result = checks.evaluateCheckB({
      intervals,
      errorSeriesByPair: {
        'rate_limited/key_quota': {
          outcome: 'rate_limited',
          reason: 'key_quota',
          hourly: keyQuotaStorm,
        },
      },
      index: 192,
    });

    expect(result.alerts).toHaveLength(0);
    expect(result.trends.find((trend: { family: string }) => trend.family === 'rate_limited')).toBeDefined();
  });
});

describe('check E — telemetry-delivery canary', () => {
  it('would-have-fired (dark-fleet): accepted collapses while liveness holds', async () => {
    const checks = await loadChecks();
    const intervals = buildHourlyIntervals(200);
    const index = intervals.length - 2;
    const windowHours = checks.CHECK_E_WINDOW_HOURS;

    const livenessHourly = new Array(200).fill(30);
    const acceptedHourly = new Array(200).fill(50);
    for (let i = index - windowHours + 1; i <= index; i += 1) {
      acceptedHourly[i] = 0;
    }

    const result = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly,
      index,
    });

    expect(result.verdict).toBe('dark-fleet');
    expect(result.shouldPage).toBe(true);
  });

  it('benign — joint lull: both accepted and liveness drop together', async () => {
    const checks = await loadChecks();
    const intervals = buildHourlyIntervals(200);
    const index = intervals.length - 2;
    const windowHours = checks.CHECK_E_WINDOW_HOURS;

    const livenessHourly = new Array(200).fill(30);
    const acceptedHourly = new Array(200).fill(50);
    for (let i = index - windowHours + 1; i <= index; i += 1) {
      acceptedHourly[i] = 0;
      livenessHourly[i] = 3;
    }

    const result = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly,
      index,
    });

    expect(result.verdict).toBe('fleet-lull');
    expect(result.shouldPage).toBe(false);
  });

  it('benign — noisy-low accepted: accepted stays above floor while liveness holds', async () => {
    const checks = await loadChecks();
    const intervals = buildHourlyIntervals(200);
    const index = intervals.length - 2;
    const windowHours = checks.CHECK_E_WINDOW_HOURS;

    const livenessHourly = new Array(200).fill(30);
    const acceptedHourly = new Array(200).fill(50);
    for (let i = index - windowHours + 1; i <= index; i += 1) {
      acceptedHourly[i] = 1;
    }

    const result = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly,
      index,
    });

    expect(result.verdict).toBe('healthy');
    expect(result.shouldPage).toBe(false);
  });

  it('inconclusive — liveness also dark: accepted 0, liveness 0, substantial baseline', async () => {
    const checks = await loadChecks();
    const intervals = buildHourlyIntervals(200);
    const index = intervals.length - 2;
    const windowHours = checks.CHECK_E_WINDOW_HOURS;

    const livenessHourly = new Array(200).fill(30);
    const acceptedHourly = new Array(200).fill(50);
    for (let i = index - windowHours + 1; i <= index; i += 1) {
      acceptedHourly[i] = 0;
      livenessHourly[i] = 0;
    }

    const result = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly,
      index,
    });

    expect(result.verdict).toBe('inconclusive');
    expect(result.shouldPage).toBe(false);
    expect(result.debug.reason).toBe('liveness_also_dark');
  });

  it('inconclusive — thin baseline: liveness baseline below minimum', async () => {
    const checks = await loadChecks();
    // Full 7d baseline hours are required; thin_baseline is about volume, not span.
    const intervals = buildHourlyIntervals(200);
    const index = intervals.length - 2;
    const windowHours = checks.CHECK_E_WINDOW_HOURS;
    const windowStart = index - windowHours + 1;
    const baselineEnd = windowStart;
    const baselineStart = baselineEnd - checks.CHECK_E_LIVENESS_BASELINE_HOURS;

    const livenessHourly = new Array(200).fill(0);
    // 15 events across the full baseline window — enough hours, too little volume.
    for (let i = baselineStart; i < baselineEnd; i += 12) {
      livenessHourly[i] = 1;
    }
    const acceptedHourly = new Array(200).fill(0);

    const result = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly,
      index,
    });

    expect(result.verdict).toBe('inconclusive');
    expect(result.shouldPage).toBe(false);
    expect(result.debug.reason).toBe('thin_baseline');
  });

  it('inconclusive — truncated baseline: history shorter than 7d liveness window', async () => {
    const checks = await loadChecks();
    const intervals = buildHourlyIntervals(60);
    const index = intervals.length - 2;

    const livenessHourly = new Array(60).fill(30);
    const acceptedHourly = new Array(60).fill(0);

    const result = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly,
      index,
    });

    expect(result.verdict).toBe('inconclusive');
    expect(result.shouldPage).toBe(false);
    expect(result.debug.reason).toBe('truncated_baseline');
  });

  it('inconclusive — liveness also dark with small-but-non-thin baseline', async () => {
    const checks = await loadChecks();
    const intervals = buildHourlyIntervals(200);
    const index = intervals.length - 2;
    const windowHours = checks.CHECK_E_WINDOW_HOURS;
    const windowStart = index - windowHours + 1;
    const baselineEnd = windowStart;
    const baselineStart = baselineEnd - checks.CHECK_E_LIVENESS_BASELINE_HOURS;

    const livenessHourly = new Array(200).fill(0);
    // Baseline total 30 (>= livenessMinBaseline) but scaled per-window expected ~1.07 (< 20).
    for (let i = baselineStart; i < baselineEnd; i += 6) {
      livenessHourly[i] = 1;
    }
    const acceptedHourly = new Array(200).fill(50);
    for (let i = windowStart; i <= index; i += 1) {
      acceptedHourly[i] = 0;
      livenessHourly[i] = 0;
    }

    const result = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly,
      index,
    });

    expect(result.verdict).toBe('inconclusive');
    expect(result.shouldPage).toBe(false);
    expect(result.debug.reason).toBe('liveness_also_dark');
  });

  it('edge-dedup: sustained dark window pages exactly once', async () => {
    const checks = await loadChecks();
    const intervals = buildHourlyIntervals(205);
    const windowHours = checks.CHECK_E_WINDOW_HOURS;
    const pageWindowHours = checks.MONITOR_RUN_INTERVAL_HOURS;

    const livenessHourly = new Array(205).fill(30);
    const acceptedHourly = new Array(205).fill(50);
    const darkStart = 192;
    for (let i = darkStart; i < 205; i += 1) {
      acceptedHourly[i] = 0;
    }

    const firstFireIndex = darkStart + windowHours - 1;
    const firstFire = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly,
      index: firstFireIndex,
    });
    expect(firstFire.verdict).toBe('dark-fleet');
    expect(firstFire.shouldPage).toBe(true);

    const sustainedDark = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly,
      index: firstFireIndex + pageWindowHours,
    });
    expect(sustainedDark.verdict).toBe('dark-fleet');
    expect(sustainedDark.shouldPage).toBe(false);
  });

  it('edge-dedup: run-owned span pages when transition predates latest bucket (3-hourly cron)', async () => {
    const checks = await loadChecks();
    const pageWindowHours = checks.MONITOR_RUN_INTERVAL_HOURS;
    const windowHours = checks.CHECK_E_WINDOW_HOURS;
    const intervals = buildHourlyIntervals(210);
    const index = 205;

    const livenessHourly = new Array(210).fill(30);
    const acceptedHourly = new Array(210).fill(50);

    // Fresh non-dark→dark transition at index-1; index itself is sustained dark.
    const darkAcceptedStart = index - windowHours;
    acceptedHourly[darkAcceptedStart - 1] = 50;
    for (let i = darkAcceptedStart; i < 210; i += 1) {
      acceptedHourly[i] = 0;
    }

    const transitionIndex = index - 1;
    const atTransition = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly,
      index: transitionIndex,
    });
    expect(atTransition.verdict).toBe('dark-fleet');

    const runAtLatestBucket = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly,
      index,
    });
    expect(runAtLatestBucket.verdict).toBe('dark-fleet');
    expect(runAtLatestBucket.debug.prevVerdict).toBe('dark-fleet');
    expect(runAtLatestBucket.shouldPage).toBe(true);

    const nextRunIndex = index + pageWindowHours;
    const runAfterCadence = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly,
      index: nextRunIndex,
    });
    expect(runAfterCadence.verdict).toBe('dark-fleet');
    expect(runAfterCadence.shouldPage).toBe(false);
  });

  it('null liveness (PostHog unavailable): inconclusive, never pages', async () => {
    const checks = await loadChecks();
    const intervals = buildHourlyIntervals(200);
    const index = intervals.length - 2;

    const acceptedHourly = new Array(200).fill(0);

    const result = checks.evaluateCheckE({
      intervals,
      acceptedHourly,
      livenessHourly: null,
      index,
      livenessUnavailable: true,
    });

    expect(result.verdict).toBe('inconclusive');
    expect(result.shouldPage).toBe(false);
    expect(result.debug.reason).toBe('liveness_unavailable');
  });
});

describe('check F — permanent-failure surge', () => {
  it('surge → pages: current >= floor, baseline below floor (fresh edge)', async () => {
    const checks = await loadChecks();
    const floor = checks.PERMFAIL_DISTINCT_USER_FLOOR;

    const result = checks.evaluateCheckF({
      current: { distinctUsers: floor, events: 12 },
      baseline: { distinctUsers: floor - 1, events: 9 },
    });

    expect(result.verdict).toBe('surge');
    expect(result.shouldPage).toBe(true);
    expect(result.distinctUsers).toBe(floor);
    expect(result.events).toBe(12);
  });

  it('sustained surge → no re-page (F1 interval-offset edge dedup)', async () => {
    const checks = await loadChecks();
    const floor = checks.PERMFAIL_DISTINCT_USER_FLOOR;

    const result = checks.evaluateCheckF({
      current: { distinctUsers: floor + 2, events: 30 },
      baseline: { distinctUsers: floor + 1, events: 25 },
    });

    expect(result.verdict).toBe('surge');
    expect(result.shouldPage).toBe(false);
  });

  it('below floor → quiet', async () => {
    const checks = await loadChecks();
    const floor = checks.PERMFAIL_DISTINCT_USER_FLOOR;

    const result = checks.evaluateCheckF({
      current: { distinctUsers: floor - 1, events: 4 },
      baseline: { distinctUsers: 0, events: 0 },
    });

    expect(result.verdict).toBe('quiet');
    expect(result.shouldPage).toBe(false);
  });

  it('fail-loud — current unavailable: verdict unavailable, never pages', async () => {
    const checks = await loadChecks();

    const result = checks.evaluateCheckF({
      current: null,
      baseline: { distinctUsers: 0, events: 0 },
    });

    expect(result.verdict).toBe('unavailable');
    expect(result.shouldPage).toBe(false);
    expect(result.debug.reason).toBeTruthy();
    expect(result.debug.reason).toBe('current_unavailable');
  });

  it('fail-loud — BASELINE unavailable (F2): a missing baseline must NOT produce a false fresh-edge page', async () => {
    const checks = await loadChecks();
    const floor = checks.PERMFAIL_DISTINCT_USER_FLOOR;

    const result = checks.evaluateCheckF({
      current: { distinctUsers: floor + 1, events: 20 },
      baseline: null,
    });

    expect(result.verdict).toBe('unavailable');
    expect(result.shouldPage).toBe(false);
    expect(result.debug.reason).toBe('baseline_unavailable');
  });

  it('raw event count is NOT the trigger: one device, many events → quiet (throttle-dampening insight)', async () => {
    const checks = await loadChecks();

    const result = checks.evaluateCheckF({
      current: { distinctUsers: 1, events: 50 },
      baseline: { distinctUsers: 0, events: 0 },
      floor: checks.PERMFAIL_DISTINCT_USER_FLOOR,
    });

    expect(result.verdict).toBe('quiet');
    expect(result.shouldPage).toBe(false);
  });

  it('constants are exported (not magic numbers)', async () => {
    const checks = await loadChecks();
    expect(checks.PERMFAIL_DISTINCT_USER_FLOOR).toBe(3);
    expect(checks.PERMFAIL_DETECTION_WINDOW_HOURS).toBe(6);
  });

  it('formatCheckFAlert output contains the distinct-user count and window (Claude polish)', async () => {
    const checks = await loadChecks();
    const text = checks.formatCheckFAlert({
      checkF: { verdict: 'surge', distinctUsers: 4, events: 17, shouldPage: true, debug: {} },
    });
    expect(text).toContain('distinct affected users=4');
    expect(text).toContain(`window=${checks.PERMFAIL_DETECTION_WINDOW_HOURS}h`);
  });
});

describe('check H — safety-eval billing-degradation SUSTAINED-RATE (reasonKind:billing)', () => {
  // Defaults: threshold 10 distinct billing users/day, sustained 3 consecutive days.
  // Backtest steady state ~6/day (24h=6, 7d=12, 30d=22) must NEVER page.
  it('sustained (all M trailing days >= threshold, guard day below) → pages', async () => {
    const checks = await loadChecks();
    const t = checks.SAFETY_DEGRADED_DAILY_USER_THRESHOLD;
    // oldest→newest: guard day below threshold, then 3 elevated days.
    const result = checks.evaluateCheckH({
      dailyDistinctUsers: [t - 1, t, t + 2, t + 5],
    });

    expect(result.verdict).toBe('sustained-surge');
    expect(result.shouldPage).toBe(true);
    expect(result.peakDay).toBe(t + 5);
  });

  it('below-threshold steady state (~6/day baseline) → does NOT page', async () => {
    const checks = await loadChecks();
    // The real ~6/day background — well below the 10/day threshold.
    const result = checks.evaluateCheckH({
      dailyDistinctUsers: [6, 6, 7, 6],
    });

    expect(result.verdict).toBe('quiet');
    expect(result.shouldPage).toBe(false);
  });

  it('one spike day among normal days → does NOT page (not SUSTAINED)', async () => {
    const checks = await loadChecks();
    const t = checks.SAFETY_DEGRADED_DAILY_USER_THRESHOLD;
    // A single big day; the other trailing days are normal → not all elevated.
    const result = checks.evaluateCheckH({
      dailyDistinctUsers: [6, 6, t + 20, 6],
    });

    expect(result.verdict).toBe('quiet');
    expect(result.shouldPage).toBe(false);
  });

  it('already-elevated (guard day also >= threshold) → sustained-elevated, no re-page', async () => {
    const checks = await loadChecks();
    const t = checks.SAFETY_DEGRADED_DAILY_USER_THRESHOLD;
    // Guard day ALSO elevated → already elevated before this window → already paged →
    // do not re-page (digest-only).
    const result = checks.evaluateCheckH({
      dailyDistinctUsers: [t + 1, t + 2, t + 1, t + 3],
    });

    expect(result.verdict).toBe('sustained-elevated');
    expect(result.shouldPage).toBe(false);
  });

  it('first observation with no guard day (exactly M days) → pages once (fresh)', async () => {
    const checks = await loadChecks();
    const t = checks.SAFETY_DEGRADED_DAILY_USER_THRESHOLD;
    const days = checks.SAFETY_DEGRADED_SUSTAINED_DAYS;
    // Exactly M elevated days, no pre-window guard → unknown guard treated as fresh → page.
    const result = checks.evaluateCheckH({
      dailyDistinctUsers: Array.from({ length: days }, () => t + 1),
    });

    expect(result.verdict).toBe('sustained-surge');
    expect(result.shouldPage).toBe(true);
  });

  it('fail-loud — a malformed read INSIDE the trailing window → unavailable, never pages', async () => {
    const checks = await loadChecks();
    const t = checks.SAFETY_DEGRADED_DAILY_USER_THRESHOLD;
    // A null (malformed/rejected day) within the M trailing days → can't tell.
    const result = checks.evaluateCheckH({
      dailyDistinctUsers: [t - 1, t, null, t + 5],
    });

    expect(result.verdict).toBe('unavailable');
    expect(result.shouldPage).toBe(false);
    expect(result.debug.reason).toBe('malformed_day_in_window');
  });

  it('legitimate-zero days → quiet (a zero is below threshold, NOT unavailable)', async () => {
    const checks = await loadChecks();
    const result = checks.evaluateCheckH({
      dailyDistinctUsers: [0, 0, 0, 0],
    });

    expect(result.verdict).toBe('quiet');
    expect(result.shouldPage).toBe(false);
  });

  it('insufficient days (< M) → unavailable, never pages', async () => {
    const checks = await loadChecks();
    const t = checks.SAFETY_DEGRADED_DAILY_USER_THRESHOLD;
    const result = checks.evaluateCheckH({
      dailyDistinctUsers: [t + 1, t + 1],
    });

    expect(result.verdict).toBe('unavailable');
    expect(result.shouldPage).toBe(false);
    expect(result.debug.reason).toBe('insufficient_days');
  });

  it('a malformed read OUTSIDE the trailing window (older than guard) does not gate the verdict', async () => {
    const checks = await loadChecks();
    const t = checks.SAFETY_DEGRADED_DAILY_USER_THRESHOLD;
    // null is the oldest entry; guard day (index 1) below threshold; trailing M elevated.
    const result = checks.evaluateCheckH({
      dailyDistinctUsers: [null, t - 1, t, t + 1, t + 2],
    });

    expect(result.verdict).toBe('sustained-surge');
    expect(result.shouldPage).toBe(true);
  });

  it('constants are exported (threshold 10/day, sustained 3 days, 24h day window)', async () => {
    const checks = await loadChecks();
    expect(checks.SAFETY_DEGRADED_DAILY_USER_THRESHOLD).toBe(10);
    expect(checks.SAFETY_DEGRADED_SUSTAINED_DAYS).toBe(3);
    expect(checks.SAFETY_DEGRADED_DAY_WINDOW_HOURS).toBe(24);
    // Backtest steady-state sanity: ~6/day must be below the threshold.
    expect(6).toBeLessThan(checks.SAFETY_DEGRADED_DAILY_USER_THRESHOLD);
  });

  it('formatCheckHAlert names the rate, days, trend-not-spike framing, and #check-h runbook', async () => {
    const checks = await loadChecks();
    const text = checks.formatCheckHAlert({
      checkH: {
        verdict: 'sustained-surge',
        peakDay: 14,
        shouldPage: true,
        debug: { threshold: 10, minConsecutiveDays: 3 },
      },
    });
    expect(text).toContain('>= 10 distinct users/day for 3 days');
    expect(text).toContain('billing');
    expect(text).toContain('Trend, not a spike.');
    expect(text).toContain('docs/project/SENTRY_TRIAGE.md#check-h');
  });

  it('reuses parsePermanentFailureAggregateRow row handling (legitimate-zero vs malformed)', async () => {
    const checks = await loadChecks();
    // data:[] → legitimate zero (NOT null) so an empty day reads as 0 (below threshold).
    expect(checks.parsePermanentFailureAggregateRow({ data: [] })).toEqual({
      distinctUsers: 0,
      events: 0,
    });
    // malformed body → null → caller maps to unavailable + degrades self-health.
    expect(checks.parsePermanentFailureAggregateRow({})).toBeNull();
  });
});

describe('parsePermanentFailureAggregateRow — legitimate-zero vs malformed (GPT-F1)', () => {
  it('populated row → value', async () => {
    const checks = await loadChecks();
    const result = checks.parsePermanentFailureAggregateRow({
      data: [{ 'count_unique(user)': 4, 'count()': 17 }],
    });
    expect(result).toEqual({ distinctUsers: 4, events: 17 });
  });

  it('parses string counts (Sentry can return numeric-as-string)', async () => {
    const checks = await loadChecks();
    const result = checks.parsePermanentFailureAggregateRow({
      data: [{ 'count_unique(user)': '0', 'count()': '0' }],
    });
    expect(result).toEqual({ distinctUsers: 0, events: 0 });
  });

  it('zero row → zeros, NOT null (the common healthy case)', async () => {
    const checks = await loadChecks();
    const result = checks.parsePermanentFailureAggregateRow({
      data: [{ 'count_unique(user)': 0, 'count()': 0 }],
    });
    expect(result).toEqual({ distinctUsers: 0, events: 0 });
  });

  it('empty data array (data:[]) → zeros, NOT null (legitimate "no matching events")', async () => {
    const checks = await loadChecks();
    const result = checks.parsePermanentFailureAggregateRow({ data: [] });
    expect(result).toEqual({ distinctUsers: 0, events: 0 });
  });

  it('missing data array → null (structurally malformed)', async () => {
    const checks = await loadChecks();
    expect(checks.parsePermanentFailureAggregateRow({})).toBeNull();
    expect(checks.parsePermanentFailureAggregateRow(null)).toBeNull();
  });

  it('missing/non-numeric count fields → null (malformed, not a clean zero)', async () => {
    const checks = await loadChecks();
    expect(
      checks.parsePermanentFailureAggregateRow({ data: [{ 'count()': 3 }] }),
    ).toBeNull();
    expect(
      checks.parsePermanentFailureAggregateRow({
        data: [{ 'count_unique(user)': 'nope', 'count()': 3 }],
      }),
    ).toBeNull();
  });

  it('nullish/empty/coercible-to-zero values → null (malformed, must NOT read as a healthy zero)', async () => {
    const checks = await loadChecks();
    // Each of these coerces to 0 under permissive Number(...) but is a MALFORMED
    // field, not a legitimate zero — must reject so it cannot pass as quiet/non-degraded.
    for (const bad of [null, undefined, '', false, true, [], {}, NaN, -1, '-1', 'abc', '  ']) {
      expect(
        checks.parsePermanentFailureAggregateRow({
          data: [{ 'count_unique(user)': bad, 'count()': 5 }],
        }),
      ).toBeNull();
      expect(
        checks.parsePermanentFailureAggregateRow({
          data: [{ 'count_unique(user)': 5, 'count()': bad }],
        }),
      ).toBeNull();
    }
  });

  it('numeric 0 and string "0" → legitimate zero (NOT null)', async () => {
    const checks = await loadChecks();
    expect(
      checks.parsePermanentFailureAggregateRow({
        data: [{ 'count_unique(user)': 0, 'count()': 0 }],
      }),
    ).toEqual({ distinctUsers: 0, events: 0 });
    expect(
      checks.parsePermanentFailureAggregateRow({
        data: [{ 'count_unique(user)': '0', 'count()': '0' }],
      }),
    ).toEqual({ distinctUsers: 0, events: 0 });
    // Mixed: a real zero in one field, a real positive in the other.
    expect(
      checks.parsePermanentFailureAggregateRow({
        data: [{ 'count_unique(user)': 0, 'count()': '12' }],
      }),
    ).toEqual({ distinctUsers: 0, events: 12 });
  });

  it('non-decimal numeric-string coercions → null (Sentry never emits hex/exponent/Infinity; F1)', async () => {
    const checks = await loadChecks();
    // Bare Number(...) would coerce these to finite non-negatives a Sentry aggregate
    // never emits ('0x10'→16, '1e3'→1000). The /^\d+$/ guard must reject them as malformed.
    for (const bad of ['0x10', '1e3', 'Infinity', '1abc', '  ', '1.5', '+1']) {
      expect(
        checks.parsePermanentFailureAggregateRow({
          data: [{ 'count_unique(user)': bad, 'count()': 7 }],
        }),
      ).toBeNull();
      expect(
        checks.parsePermanentFailureAggregateRow({
          data: [{ 'count_unique(user)': 7, 'count()': bad }],
        }),
      ).toBeNull();
    }
    // Plain decimal-integer strings and numbers still parse (legitimate zero/value).
    expect(
      checks.parsePermanentFailureAggregateRow({
        data: [{ 'count_unique(user)': '0', 'count()': '12' }],
      }),
    ).toEqual({ distinctUsers: 0, events: 12 });
    expect(
      checks.parsePermanentFailureAggregateRow({
        data: [{ 'count_unique(user)': 0, 'count()': 5 }],
      }),
    ).toEqual({ distinctUsers: 0, events: 5 });
  });
});

describe('deriveCheckFRead — self-health read-status mapping (GPT-F1/F3)', () => {
  it('rejected → degraded + null', async () => {
    const checks = await loadChecks();
    const result = checks.deriveCheckFRead({ status: 'rejected', reason: new Error('boom') });
    expect(result).toEqual({ value: null, degraded: true });
  });

  it('fulfilled-null (malformed) → degraded + null', async () => {
    const checks = await loadChecks();
    const result = checks.deriveCheckFRead({ status: 'fulfilled', value: null });
    expect(result).toEqual({ value: null, degraded: true });
  });

  it('fulfilled-zero (legitimate zero) → NOT degraded + zeros', async () => {
    const checks = await loadChecks();
    const result = checks.deriveCheckFRead({
      status: 'fulfilled',
      value: { distinctUsers: 0, events: 0 },
    });
    expect(result).toEqual({ value: { distinctUsers: 0, events: 0 }, degraded: false });
  });

  it('fulfilled-populated → NOT degraded + value', async () => {
    const checks = await loadChecks();
    const value = { distinctUsers: 5, events: 40 };
    const result = checks.deriveCheckFRead({ status: 'fulfilled', value });
    expect(result).toEqual({ value, degraded: false });
  });
});

describe('monitor self-health — chronic degradation', () => {
  it('would-fire (260618 week-blind shape): prior at threshold-1 + degraded run escalates on fresh crossing', async () => {
    const checks = await loadChecks();
    const threshold = checks.SELF_HEALTH_ESCALATION_THRESHOLD;

    const result = checks.evaluateMonitorSelfHealth({
      dependencies: [
        { name: 'sentry_stats', status: 'fail' },
        { name: 'sentry_events', status: 'fail' },
        { name: 'posthog_liveness', status: 'ok' },
        { name: 'posthog_tracked', status: 'ok' },
      ],
      priorState: { consecutiveDegradedRuns: threshold - 1 },
      threshold,
    });

    expect(result.shouldEscalate).toBe(true);
    expect(result.escalationKind).toBe('fresh');
    expect(result.consecutiveDegradedRuns).toBe(threshold);
    expect(result.nextState.consecutiveDegradedRuns).toBe(threshold);
    expect(result.failedDependencies).toEqual(['sentry_stats', 'sentry_events']);
    expect(result.blindDependencies).toEqual([]);
  });

  it('single transient blip does NOT escalate', async () => {
    const checks = await loadChecks();
    const threshold = checks.SELF_HEALTH_ESCALATION_THRESHOLD;

    const result = checks.evaluateMonitorSelfHealth({
      dependencies: [{ name: 'sentry_stats', status: 'fail' }],
      priorState: { consecutiveDegradedRuns: 0 },
      threshold,
    });

    expect(result.consecutiveDegradedRuns).toBe(1);
    expect(result.shouldEscalate).toBe(false);
    expect(result.escalationKind).toBe('none');
  });

  it('heal resets consecutive counter', async () => {
    const checks = await loadChecks();

    const result = checks.evaluateMonitorSelfHealth({
      dependencies: [
        { name: 'sentry_stats', status: 'ok' },
        { name: 'sentry_events', status: 'ok' },
        { name: 'posthog_liveness', status: 'ok' },
        { name: 'posthog_tracked', status: 'ok' },
      ],
      priorState: { consecutiveDegradedRuns: 5 },
    });

    expect(result.consecutiveDegradedRuns).toBe(0);
    expect(result.shouldEscalate).toBe(false);
    expect(result.degraded).toBe(false);
  });

  it('no double-escalation while streak continues past threshold', async () => {
    const checks = await loadChecks();
    const threshold = checks.SELF_HEALTH_ESCALATION_THRESHOLD;

    const result = checks.evaluateMonitorSelfHealth({
      dependencies: [{ name: 'sentry_stats', status: 'fail' }],
      priorState: { consecutiveDegradedRuns: threshold },
      threshold,
    });

    expect(result.consecutiveDegradedRuns).toBe(threshold + 1);
    expect(result.shouldEscalate).toBe(false);
    expect(result.escalationKind).toBe('none');
  });

  it('missing/malformed state fails open and never throws', async () => {
    const checks = await loadChecks();

    expect(checks.parseSelfHealthState('')).toEqual({
      consecutiveDegradedRuns: 0,
      lastDegradedDependencies: [],
    });
    expect(checks.parseSelfHealthState('{bad json')).toEqual({
      consecutiveDegradedRuns: 0,
      lastDegradedDependencies: [],
    });

    const degraded = checks.evaluateMonitorSelfHealth({
      dependencies: [{ name: 'sentry_stats', status: 'fail' }],
    });
    expect(degraded.consecutiveDegradedRuns).toBe(1);
    expect(degraded.shouldEscalate).toBe(false);
  });

  it('blind vs fail distinction: posthog blind is degraded but not failed', async () => {
    const checks = await loadChecks();
    const threshold = checks.SELF_HEALTH_ESCALATION_THRESHOLD;

    const result = checks.evaluateMonitorSelfHealth({
      dependencies: [
        { name: 'sentry_stats', status: 'ok' },
        { name: 'sentry_events', status: 'ok' },
        { name: 'posthog_liveness', status: 'blind' },
        { name: 'posthog_tracked', status: 'blind' },
      ],
      priorState: { consecutiveDegradedRuns: threshold - 1 },
      threshold,
    });

    expect(result.degraded).toBe(true);
    expect(result.blindDependencies).toEqual(['posthog_liveness', 'posthog_tracked']);
    expect(result.failedDependencies).toEqual([]);
    expect(result.shouldEscalate).toBe(true);

    const message = checks.formatSelfHealthEscalation({ selfHealth: result });
    expect(message).toContain('blind: posthog_liveness, posthog_tracked');
    expect(message).not.toContain('failed:');
  });

  it('evaluateMonitorSelfHealth with omitted dependencies defaults to healthy', async () => {
    const checks = await loadChecks();
    const result = checks.evaluateMonitorSelfHealth({});
    expect(result.degraded).toBe(false);
    expect(result.shouldEscalate).toBe(false);
    expect(result.consecutiveDegradedRuns).toBe(0);
  });
});

describe('self-health escalation persist gating', () => {
  it('posts Slack escalation only when shouldEscalate and state persisted on a real run', async () => {
    const checks = await loadChecks();

    expect(checks.shouldPostSelfHealthEscalation({
      shouldEscalate: true,
      persisted: true,
      dryRun: false,
    })).toBe(true);

    expect(checks.shouldPostSelfHealthEscalation({
      shouldEscalate: true,
      persisted: false,
      dryRun: false,
    })).toBe(false);

    expect(checks.shouldPostSelfHealthEscalation({
      shouldEscalate: false,
      persisted: true,
      dryRun: false,
    })).toBe(false);
  });

  it('dry-run never posts Slack even when shouldEscalate (intentional non-persist)', async () => {
    const checks = await loadChecks();

    expect(checks.shouldPostSelfHealthEscalation({
      shouldEscalate: true,
      persisted: false,
      dryRun: true,
    })).toBe(false);

    expect(checks.shouldWarnSelfHealthEscalationSuppressed({
      shouldEscalate: true,
      persisted: false,
      dryRun: true,
    })).toBe(false);
  });

  it('suppresses Slack and surfaces warning when shouldEscalate but persist failed on real run', async () => {
    const checks = await loadChecks();
    const threshold = checks.SELF_HEALTH_ESCALATION_THRESHOLD;

    const selfHealth = checks.evaluateMonitorSelfHealth({
      dependencies: [{ name: 'sentry_stats', status: 'fail' }],
      priorState: { consecutiveDegradedRuns: threshold - 1 },
      threshold,
    });
    expect(selfHealth.shouldEscalate).toBe(true);

    expect(checks.shouldWarnSelfHealthEscalationSuppressed({
      shouldEscalate: selfHealth.shouldEscalate,
      persisted: false,
      dryRun: false,
    })).toBe(true);
    expect(checks.shouldPostSelfHealthEscalation({
      shouldEscalate: selfHealth.shouldEscalate,
      persisted: false,
      dryRun: false,
    })).toBe(false);

    const warning = checks.formatSelfHealthEscalationPersistFailureWarning({ selfHealth });
    expect(warning).toContain('WARNING self-health escalation suppressed');
    expect(warning).toContain('double-paging');
    expect(warning).toContain('failed=[sentry_stats]');
  });
});

describe('classifySentryHttpError', () => {
  // Regression-pinning test for the actual bug: a 403 on the org-read endpoints
  // must produce a self-diagnosing message that names the missing org:read scope
  // and must NOT prescribe event:read (these org-level endpoints don't use it).
  it('classifies 403 as an under-scoped token needing org:read (not event:read)', async () => {
    const { classifySentryHttpError } = await loadChecks();
    const result = classifySentryHttpError(
      403,
      'Forbidden',
      '{"detail":"You do not have permission to perform this action."}',
    );
    expect(result.kind).toBe('auth_underscoped');
    expect(result.message).toContain('org:read');
    expect(result.message.toLowerCase()).toContain('permission');
    expect(result.message).not.toContain('event:read');
    // default context surfaces the org + region so a wrong-target cause isn't missed
    expect(result.message).toContain('mindstone');
    expect(result.message).toContain('us.sentry.io');
    // original body is preserved for context
    expect(result.message).toContain('do not have permission');
  });

  it('honors a custom org/region context in the 403 message', async () => {
    const { classifySentryHttpError } = await loadChecks();
    const result = classifySentryHttpError(403, 'Forbidden', 'denied', {
      org: 'acme',
      region: 'de.sentry.io',
    });
    expect(result.message).toContain("org ('acme')");
    expect(result.message).toContain('de.sentry.io');
  });

  it('classifies 401 as an invalid/expired token to rotate', async () => {
    const { classifySentryHttpError } = await loadChecks();
    const result = classifySentryHttpError(401, 'Unauthorized', '{"detail":"Invalid token"}');
    expect(result.kind).toBe('auth_invalid');
    expect(result.message.toLowerCase()).toMatch(/invalid|expired/);
    expect(result.message.toLowerCase()).toContain('rotate');
  });

  it('classifies 404 as a wrong org slug / region', async () => {
    const { classifySentryHttpError } = await loadChecks();
    const result = classifySentryHttpError(404, 'Not Found', 'nope', { org: 'mindstone' });
    expect(result.kind).toBe('wrong_target');
    expect(result.message).toContain('mindstone');
    expect(result.message).toContain('us.sentry.io');
  });

  it('falls through to the raw body for unclassified statuses (no swallowing)', async () => {
    const { classifySentryHttpError } = await loadChecks();
    const result = classifySentryHttpError(500, 'Internal Server Error', 'HEAD_boom');
    expect(result.kind).toBe('unknown');
    expect(result.message).toContain('Sentry API 500 Internal Server Error');
    expect(result.message).toContain('HEAD_boom');
    // does not pretend it's a scope problem
    expect(result.message).not.toContain('org:read');
  });

  it('truncates the response body to 300 chars (no log flooding)', async () => {
    const { classifySentryHttpError } = await loadChecks();
    const body = `HEAD_${'x'.repeat(400)}_TAILMARKER`;
    const result = classifySentryHttpError(500, 'Internal Server Error', body);
    expect(result.message).toContain('HEAD_');
    expect(result.message).not.toContain('_TAILMARKER');
  });
});

describe('resolveSentryToken', () => {
  it('prefers the dedicated SENTRY_MONITOR_AUTH_TOKEN over the shared token', async () => {
    const { resolveSentryToken } = await loadChecks();
    const result = resolveSentryToken({
      SENTRY_MONITOR_AUTH_TOKEN: 'monitor-token',
      SENTRY_AUTH_TOKEN: 'shared-token',
    });
    expect(result).toEqual({ token: 'monitor-token', source: 'SENTRY_MONITOR_AUTH_TOKEN', usedFallback: false });
  });

  it('falls back to SENTRY_AUTH_TOKEN when the dedicated token is absent', async () => {
    const { resolveSentryToken } = await loadChecks();
    const result = resolveSentryToken({ SENTRY_AUTH_TOKEN: 'shared-token' });
    expect(result).toEqual({ token: 'shared-token', source: 'SENTRY_AUTH_TOKEN', usedFallback: true });
  });

  it('does NOT let an empty/whitespace dedicated token shadow the fallback', async () => {
    const { resolveSentryToken } = await loadChecks();
    expect(resolveSentryToken({ SENTRY_MONITOR_AUTH_TOKEN: '', SENTRY_AUTH_TOKEN: 'shared' }).token).toBe('shared');
    expect(resolveSentryToken({ SENTRY_MONITOR_AUTH_TOKEN: '   ', SENTRY_AUTH_TOKEN: 'shared' }).usedFallback).toBe(true);
  });

  it('trims surrounding whitespace from the resolved token', async () => {
    const { resolveSentryToken } = await loadChecks();
    expect(resolveSentryToken({ SENTRY_MONITOR_AUTH_TOKEN: '  tok  ' }).token).toBe('tok');
  });

  it('returns a null token when neither variable is set', async () => {
    const { resolveSentryToken } = await loadChecks();
    expect(resolveSentryToken({}).token).toBeNull();
  });
});

describe('describeSentryTokenSource', () => {
  it('names the dedicated token without a fallback nudge', async () => {
    const { describeSentryTokenSource } = await loadChecks();
    const note = describeSentryTokenSource({ source: 'SENTRY_MONITOR_AUTH_TOKEN', usedFallback: false });
    expect(note).toContain('SENTRY_MONITOR_AUTH_TOKEN');
    expect(note).not.toContain('fallback');
  });

  it('flags the fallback case and nudges to set the dedicated token', async () => {
    const { describeSentryTokenSource } = await loadChecks();
    const note = describeSentryTokenSource({ source: 'SENTRY_AUTH_TOKEN', usedFallback: true });
    expect(note).toContain('fallback');
    expect(note).toContain('SENTRY_MONITOR_AUTH_TOKEN');
    expect(note).toContain('org:read');
  });

  it('returns an empty note when there is no token source', async () => {
    const { describeSentryTokenSource } = await loadChecks();
    expect(describeSentryTokenSource({ source: null, usedFallback: false })).toBe('');
    expect(describeSentryTokenSource({})).toBe('');
  });
});

describe('check G — bug-report delivery reconciliation', () => {
  it('pages on a material shortfall (Sentry well below PostHog submissions)', async () => {
    const { evaluateCheckG } = await loadChecks();
    // 20 submitted, only 5 indexed: below the 50% floor (expected >= 10) AND missing
    // 15 >= the absolute-miss floor → shortfall, page.
    const checkG = evaluateCheckG({ posthogSubmitted: 20, sentryIndexed: 5 });
    expect(checkG.verdict).toBe('shortfall');
    expect(checkG.shouldPage).toBe(true);
    expect(checkG.missing).toBe(15);
  });

  it('stays healthy when Sentry meets or exceeds the expected floor', async () => {
    const { evaluateCheckG } = await loadChecks();
    // 20 submitted, 18 indexed: above the 50% floor; missing 2 is below the absolute floor.
    const checkG = evaluateCheckG({ posthogSubmitted: 20, sentryIndexed: 18 });
    expect(checkG.verdict).toBe('healthy');
    expect(checkG.shouldPage).toBe(false);
  });

  it('does NOT page on a tiny absolute miss (window-edge skew tolerance)', async () => {
    const { evaluateCheckG } = await loadChecks();
    // 6 submitted, 4 indexed: above the 50% floor (expected >= 3) and missing only 2,
    // below MIN_ABSOLUTE_MISS — never page on edge-of-window timing skew.
    const checkG = evaluateCheckG({ posthogSubmitted: 6, sentryIndexed: 4 });
    expect(checkG.shouldPage).toBe(false);
    expect(checkG.verdict).toBe('healthy');
  });

  it('is inconclusive (never pages) on a thin PostHog sample', async () => {
    const { evaluateCheckG } = await loadChecks();
    // 3 submitted (< MIN_POSTHOG_SUBMISSIONS=5), 0 indexed: too small to reason about.
    const checkG = evaluateCheckG({ posthogSubmitted: 3, sentryIndexed: 0 });
    expect(checkG.verdict).toBe('inconclusive');
    expect(checkG.shouldPage).toBe(false);
  });

  it('is unavailable (never a false healthy) when either read is missing', async () => {
    const { evaluateCheckG } = await loadChecks();
    expect(evaluateCheckG({ posthogSubmitted: null, sentryIndexed: 10 }).verdict).toBe('unavailable');
    expect(evaluateCheckG({ posthogSubmitted: 20, sentryIndexed: null }).verdict).toBe('unavailable');
    expect(evaluateCheckG({ posthogSubmitted: null, sentryIndexed: null }).shouldPage).toBe(false);
  });

  it('does not treat Sentry-above-PostHog as a shortfall', async () => {
    const { evaluateCheckG } = await loadChecks();
    // Sentry has MORE than PostHog (desktop reports without a PostHog id) — not a shortfall.
    const checkG = evaluateCheckG({ posthogSubmitted: 10, sentryIndexed: 25 });
    expect(checkG.verdict).toBe('healthy');
    expect(checkG.missing).toBe(0);
  });
});

describe('parseSentryEventCountRow', () => {
  it('reads count() from an aggregate row', async () => {
    const { parseSentryEventCountRow } = await loadChecks();
    expect(parseSentryEventCountRow({ data: [{ 'count()': 42 }] })).toBe(42);
    expect(parseSentryEventCountRow({ data: [{ 'count()': '7' }] })).toBe(7);
  });

  it('treats an empty data array as a legitimate zero', async () => {
    const { parseSentryEventCountRow } = await loadChecks();
    expect(parseSentryEventCountRow({ data: [] })).toBe(0);
  });

  it('returns null on a malformed body (no data array, or unparseable count)', async () => {
    const { parseSentryEventCountRow } = await loadChecks();
    expect(parseSentryEventCountRow({})).toBeNull();
    expect(parseSentryEventCountRow({ data: [{ 'count()': 'NaN' }] })).toBeNull();
    expect(parseSentryEventCountRow({ data: [{ 'count()': null }] })).toBeNull();
  });
});

describe('check G digest + alert formatting', () => {
  it('includes a check G line and shortfall note in the digest', async () => {
    const { buildDigestMessage, evaluateCheckG } = await loadChecks();
    const checkG = evaluateCheckG({ posthogSubmitted: 20, sentryIndexed: 5 });
    const text = buildDigestMessage({
      nowMs: Date.parse('2026-06-22T15:00:00Z'),
      checkA: { coverageState: 'x', tracked24hCount: 0, tracked7dCount: 0, indexed24hCount: 0, reverseDiffIds: [], missingIds: [] },
      checkB: { trends: [] },
      checkC: { notices: [] },
      checkE: null,
      checkF: null,
      checkG,
      statsTotals: null,
      selfHealth: null,
    });
    expect(text).toContain('check G delivery reconciliation');
    expect(text).toContain('verdict=shortfall');
    expect(text).toContain('check G NOTE: shortfall');
  });

  it('formats a check G alert naming the drop signal', async () => {
    const { formatCheckGAlert, evaluateCheckG } = await loadChecks();
    const checkG = evaluateCheckG({ posthogSubmitted: 20, sentryIndexed: 5 });
    const text = formatCheckGAlert({ checkG });
    expect(text).toContain('check G (bug-report delivery shortfall)');
    expect(text).toContain('PostHog submissions=20');
    expect(text).toContain('Sentry user-bug-report events=5');
  });
});
