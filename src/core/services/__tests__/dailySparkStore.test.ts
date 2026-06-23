import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  DailySparkFormat,
  DailySparkWeeklyBatch,
  DailySpark,
} from '@core/dailySparkTypes';

let storeData: Record<string, unknown> = {};

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(key: string) { return storeData[key]; },
    set(keyOrObj: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrObj === 'string') {
        storeData[keyOrObj] = value;
      } else {
        Object.assign(storeData, keyOrObj);
      }
    },
    has(key: string) { return key in storeData; },
    delete(key: string) { delete storeData[key]; },
    clear() { storeData = {}; },
    get store() { return storeData; },
    set store(val: Record<string, unknown>) { storeData = val; },
    path: '/mock/path',
  })),
}));

import {
  addBatch,
  dismissToday,
  getCurrentBatch,
  getFormatFeedback,
  getTodaySpark,
  markRevealed,
  recordLessLikeThis,
  _resetStore,
} from '../dailySparkStore';

function makeSpark(overrides: Partial<DailySpark> & { dayIso: string }): DailySpark {
  return {
    id: `s-${overrides.dayIso}-${overrides.format ?? 'haiku'}`,
    weekStartIso: '2026-05-11',
    format: 'haiku',
    layout: 'poem',
    body: 'spark body — never logged',
    ...overrides,
  };
}

function makeBatch(overrides?: Partial<DailySparkWeeklyBatch>): DailySparkWeeklyBatch {
  const weekStartIso = overrides?.weekStartIso ?? '2026-05-11';
  const days = ['2026-05-11', '2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15', '2026-05-16', '2026-05-17'];
  const defaultSparks: DailySpark[] = days.map((dayIso, i) => makeSpark({
    dayIso,
    weekStartIso,
    format: (['haiku', 'dry_one_liner', 'personal_proverb'] as DailySparkFormat[])[i % 3],
    id: `s-${weekStartIso}-${i}`,
  }));
  return {
    weekStartIso,
    generatedAt: Date.now(),
    toneGauge: 'normal',
    sparks: defaultSparks,
    sourceModel: 'claude-haiku-4-5',
    promptVersion: 'v1.0',
    isFirstAppearanceWeek: false,
    ...overrides,
  };
}

describe('dailySparkStore', () => {
  beforeEach(() => {
    storeData = { batches: [], formatFeedback: {} };
    _resetStore();
  });

  describe('addBatch / getCurrentBatch', () => {
    it('returns null when no batches stored', () => {
      expect(getCurrentBatch()).toBeNull();
    });

    it('prepends a new batch and returns it as current', () => {
      const batch = makeBatch();
      addBatch(batch);
      expect(getCurrentBatch()?.weekStartIso).toBe('2026-05-11');
    });

    it('replaces an existing batch with the same weekStartIso', () => {
      addBatch(makeBatch({ weekStartIso: '2026-05-11', sourceModel: 'first' }));
      addBatch(makeBatch({ weekStartIso: '2026-05-11', sourceModel: 'second' }));
      const batches = storeData.batches as DailySparkWeeklyBatch[];
      expect(batches.length).toBe(1);
      expect(getCurrentBatch()?.sourceModel).toBe('second');
    });

    it('caps at MAX_DAILY_SPARK_BATCHES (4)', () => {
      addBatch(makeBatch({ weekStartIso: '2026-04-13' }));
      addBatch(makeBatch({ weekStartIso: '2026-04-20' }));
      addBatch(makeBatch({ weekStartIso: '2026-04-27' }));
      addBatch(makeBatch({ weekStartIso: '2026-05-04' }));
      addBatch(makeBatch({ weekStartIso: '2026-05-11' }));
      const batches = storeData.batches as DailySparkWeeklyBatch[];
      expect(batches.length).toBe(4);
      expect(batches[0].weekStartIso).toBe('2026-05-11');
      expect(batches[3].weekStartIso).toBe('2026-04-20');
    });
  });

  describe('getTodaySpark', () => {
    it('returns null when no batches stored', () => {
      const result = getTodaySpark(new Date('2026-05-11T12:00:00Z'), 'UTC');
      expect(result.spark).toBeNull();
      expect(result.isFirstAppearance).toBe(false);
    });

    it('returns the matching day spark from the current batch', () => {
      addBatch(makeBatch());
      const result = getTodaySpark(new Date('2026-05-13T12:00:00Z'), 'UTC');
      expect(result.spark?.dayIso).toBe('2026-05-13');
    });

    it('returns null when the current batch is for a different week', () => {
      addBatch(makeBatch({ weekStartIso: '2026-05-04' }));
      const result = getTodaySpark(new Date('2026-05-13T12:00:00Z'), 'UTC');
      expect(result.spark).toBeNull();
    });

    it('skips dismissed sparks', () => {
      const batch = makeBatch();
      addBatch(batch);
      const sparkId = batch.sparks[2].id;
      dismissToday(sparkId);
      const result = getTodaySpark(new Date('2026-05-13T12:00:00Z'), 'UTC');
      expect(result.spark).toBeNull();
    });

    it('propagates the first-appearance flag', () => {
      addBatch(makeBatch({ isFirstAppearanceWeek: true }));
      const result = getTodaySpark(new Date('2026-05-11T12:00:00Z'), 'UTC');
      expect(result.isFirstAppearance).toBe(true);
    });
  });

  describe('markRevealed', () => {
    it('stamps revealedAt on the matching spark', () => {
      const batch = makeBatch();
      addBatch(batch);
      const sparkId = batch.sparks[0].id;

      markRevealed(sparkId);

      const stored = (storeData.batches as DailySparkWeeklyBatch[])[0];
      expect(stored.sparks[0].revealedAt).toEqual(expect.any(Number));
    });

    it('is idempotent — second call keeps the original timestamp', () => {
      const batch = makeBatch();
      addBatch(batch);
      const sparkId = batch.sparks[0].id;

      markRevealed(sparkId);
      const first = (storeData.batches as DailySparkWeeklyBatch[])[0].sparks[0].revealedAt;
      markRevealed(sparkId);
      const second = (storeData.batches as DailySparkWeeklyBatch[])[0].sparks[0].revealedAt;
      expect(first).toBe(second);
    });
  });

  describe('dismissToday', () => {
    it('stamps dismissedAt on the matching spark', () => {
      const batch = makeBatch();
      addBatch(batch);
      const sparkId = batch.sparks[0].id;

      const ok = dismissToday(sparkId);
      expect(ok).toBe(true);
      const stored = (storeData.batches as DailySparkWeeklyBatch[])[0];
      expect(stored.sparks[0].dismissedAt).toEqual(expect.any(Number));
    });

    it('returns false for unknown sparkId', () => {
      addBatch(makeBatch());
      expect(dismissToday('does-not-exist')).toBe(false);
    });
  });

  describe('recordLessLikeThis', () => {
    it('marks feedback on the spark and increments the format counter', () => {
      const batch = makeBatch({
        sparks: [
          makeSpark({ id: 'a', dayIso: '2026-05-11', format: 'limerick' }),
          makeSpark({ id: 'b', dayIso: '2026-05-12', format: 'haiku' }),
        ],
      });
      addBatch(batch);

      expect(recordLessLikeThis('a')).toBe(true);
      const stored = (storeData.batches as DailySparkWeeklyBatch[])[0];
      expect(stored.sparks[0].feedback).toBe('less_like_this');
      expect(getFormatFeedback()).toEqual({ limerick: 1 });
    });

    it('increments existing format counts cumulatively across batches', () => {
      const week1 = makeBatch({
        weekStartIso: '2026-05-04',
        sparks: [makeSpark({ id: 'w1-mon', dayIso: '2026-05-04', format: 'limerick' })],
      });
      const week2 = makeBatch({
        weekStartIso: '2026-05-11',
        sparks: [makeSpark({ id: 'w2-mon', dayIso: '2026-05-11', format: 'limerick' })],
      });
      addBatch(week1);
      // Mark feedback on week 1 BEFORE rolling to week 2 (only current batch is mutable for feedback).
      recordLessLikeThis('w1-mon');
      addBatch(week2);
      recordLessLikeThis('w2-mon');

      expect(getFormatFeedback()).toEqual({ limerick: 2 });
    });

    it('does not double-count when called twice for the same spark', () => {
      const batch = makeBatch({
        sparks: [makeSpark({ id: 'a', dayIso: '2026-05-11', format: 'haiku' })],
      });
      addBatch(batch);

      expect(recordLessLikeThis('a')).toBe(true);
      expect(recordLessLikeThis('a')).toBe(false);
      expect(getFormatFeedback()).toEqual({ haiku: 1 });
    });

    it('returns false for unknown sparkId', () => {
      addBatch(makeBatch());
      expect(recordLessLikeThis('does-not-exist')).toBe(false);
      expect(getFormatFeedback()).toEqual({});
    });
  });
});
