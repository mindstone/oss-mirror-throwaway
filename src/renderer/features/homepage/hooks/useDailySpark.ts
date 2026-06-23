/**
 * useDailySpark — gating-aware reader for the Daily Spark slot on Home.
 *
 * Subscribes to `daily-spark:updated` for live refreshes and resolves the
 * visible spark by composing four signals:
 *   1. user setting (`dailySparkMode`)
 *   2. onboarding maturity (≥ 3 calendar days since `onboardingFirstCompletedAt`)
 *   3. activity baseline (≥ 5 sessions OR ≥ 10 memory-history entries)
 *   4. today's spark on the current batch (after dismissals / silent weeks)
 *
 * Privacy invariant: this hook never logs `spark.body` or `spark.captionOverride`.
 * Callbacks pass only `sparkId` (and a `format` label) to IPC + tracking.
 *
 * Pattern follows useHeroChoice.ts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { useNavigationSafe } from '@renderer/contexts/NavigationContext';
import { tracking } from '@renderer/src/tracking';
import {
  DEFAULT_DAILY_SPARK_MODE,
  isMonday,
  type DailySpark,
  type DailySparkMode,
} from '@core/dailySparkTypes';

export interface UseDailySparkReturn {
  spark: DailySpark | null;
  isFirstAppearance: boolean;
  mode: DailySparkMode;
  dismiss: () => void;
  feedback: () => void;
  openSettings: () => void;
}

interface DailySparkState {
  spark: DailySpark | null;
  isFirstAppearance: boolean;
}

interface ActivitySignals {
  sessionCount: number | null;
  memoryCount: number | null;
}

const INITIAL_STATE: DailySparkState = { spark: null, isFirstAppearance: false };
const INITIAL_ACTIVITY: ActivitySignals = { sessionCount: null, memoryCount: null };

const ACTIVITY_SESSIONS_THRESHOLD = 5;
const ACTIVITY_MEMORY_THRESHOLD = 10;
const ONBOARDING_MATURITY_DAYS = 3;

function diffCalendarDays(now: Date, since: Date): number {
  const utcNow = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const utcSince = Date.UTC(since.getFullYear(), since.getMonth(), since.getDate());
  return Math.floor((utcNow - utcSince) / (24 * 60 * 60 * 1000));
}

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function useDailySpark(): UseDailySparkReturn {
  const navigation = useNavigationSafe();

  const [state, setState] = useState<DailySparkState>(INITIAL_STATE);
  const [mode, setMode] = useState<DailySparkMode>(DEFAULT_DAILY_SPARK_MODE);
  const [onboardingAt, setOnboardingAt] = useState<number | null>(null);
  const [activity, setActivity] = useState<ActivitySignals>(INITIAL_ACTIVITY);

  const shownSparkIdsRef = useRef<Set<string>>(new Set());

  const fetchSpark = useCallback(async () => {
    try {
      const result = await window.dailySparkApi.getToday({});
      setState({ spark: result.spark, isFirstAppearance: result.isFirstAppearance });
    } catch (err) {
      console.warn('[DailySpark] Failed to fetch today\'s spark:', err);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const settings = await window.settingsApi.get();
      setMode(settings.dailySparkMode ?? DEFAULT_DAILY_SPARK_MODE);
      setOnboardingAt(settings.onboardingFirstCompletedAt ?? null);
    } catch (err) {
      console.warn('[DailySpark] Failed to load settings:', err);
    }
  }, []);

  const fetchActivity = useCallback(async () => {
    try {
      const [summaries, memoryCount] = await Promise.all([
        window.sessionsApi.list().catch(() => []),
        window.memoryApi
          .getHistoryCount({})
          .then((r) => r.count)
          .catch(() => 0),
      ]);
      setActivity({
        sessionCount: Array.isArray(summaries) ? summaries.length : 0,
        memoryCount,
      });
    } catch (err) {
      console.warn('[DailySpark] Failed to load activity signals:', err);
      setActivity({ sessionCount: 0, memoryCount: 0 });
    }
  }, []);

  useEffect(() => {
    void fetchSpark();
    void fetchSettings();
    void fetchActivity();

    const cleanup = window.api.onDailySparkUpdated?.(() => {
      void fetchSpark();
    });
    return cleanup;
  }, [fetchSpark, fetchSettings, fetchActivity]);

  const visibleSpark: DailySpark | null = useMemo(() => {
    if (mode === 'off') return null;
    if (onboardingAt === null) return null;

    const now = new Date();
    if (diffCalendarDays(now, new Date(onboardingAt)) < ONBOARDING_MATURITY_DAYS) {
      return null;
    }

    if (activity.sessionCount === null || activity.memoryCount === null) {
      return null;
    }
    const meetsActivity =
      activity.sessionCount >= ACTIVITY_SESSIONS_THRESHOLD ||
      activity.memoryCount >= ACTIVITY_MEMORY_THRESHOLD;
    if (!meetsActivity) return null;

    if (mode === 'subtle') {
      const tz = resolveTimeZone();
      if (!isMonday(now, tz)) return null;
    }

    return state.spark;
  }, [mode, onboardingAt, activity, state.spark]);

  useEffect(() => {
    if (!visibleSpark) return;
    if (shownSparkIdsRef.current.has(visibleSpark.id)) return;
    shownSparkIdsRef.current.add(visibleSpark.id);
    tracking.homepage.dailySparkShown(visibleSpark.format);
  }, [visibleSpark]);

  const dismiss = useCallback(() => {
    const target = visibleSpark;
    if (!target) return;
    setState((prev) => (prev.spark?.id === target.id ? { ...prev, spark: null } : prev));
    tracking.homepage.dailySparkHiddenToday(target.format);
    void window.dailySparkApi.dismissToday({ sparkId: target.id }).catch((err) => {
      console.warn('[DailySpark] Failed to dismiss today\'s spark:', err);
    });
  }, [visibleSpark]);

  const feedback = useCallback(() => {
    const target = visibleSpark;
    if (!target) return;
    setState((prev) => (prev.spark?.id === target.id ? { ...prev, spark: null } : prev));
    tracking.homepage.dailySparkLessLikeThis(target.format);
    void window.dailySparkApi
      .feedbackLessLikeThis({ sparkId: target.id })
      .catch((err) => {
        console.warn('[DailySpark] Failed to record less-like-this feedback:', err);
      });
  }, [visibleSpark]);

  const openSettings = useCallback(() => {
    tracking.homepage.dailySparkSettingsOpened();
    if (navigation) {
      fireAndForget(
        navigation.navigate({ type: 'settings', tab: 'agents', section: 'dailySparkMode' }),
        'navigateToDailySparkSettings',
      );
    }
  }, [navigation]);

  return {
    spark: visibleSpark,
    isFirstAppearance: visibleSpark ? state.isFirstAppearance : false,
    mode,
    dismiss,
    feedback,
    openSettings,
  };
}
