// @vitest-environment happy-dom
 

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import type { DailySpark } from '@core/dailySparkTypes';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const trackingMocks = vi.hoisted(() => ({
  dailySparkShown: vi.fn(),
  dailySparkHiddenToday: vi.fn(),
  dailySparkLessLikeThis: vi.fn(),
  dailySparkSettingsOpened: vi.fn(),
}));

vi.mock('@renderer/src/tracking', () => ({
  tracking: {
    homepage: trackingMocks,
  },
}));

const navigateMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@renderer/contexts/NavigationContext', () => ({
  useNavigationSafe: () => ({
    navigate: navigateMock,
  }),
}));

vi.mock('@shared/utils/fireAndForget', () => ({
  fireAndForget: (promise: Promise<unknown>) => {
    void promise.catch(() => {});
  },
}));

import { useDailySpark } from '../useDailySpark';

interface WindowApiMocks {
  getToday: ReturnType<typeof vi.fn>;
  dismissToday: ReturnType<typeof vi.fn>;
  feedbackLessLikeThis: ReturnType<typeof vi.fn>;
  generateNow: ReturnType<typeof vi.fn>;
  settingsGet: ReturnType<typeof vi.fn>;
  sessionsList: ReturnType<typeof vi.fn>;
  memoryHistoryCount: ReturnType<typeof vi.fn>;
  onDailySparkUpdated: ReturnType<typeof vi.fn>;
}

function installWindowApis(): {
  mocks: WindowApiMocks;
  fireBroadcast: () => void;
} {
  let broadcastCb: (() => void) | null = null;
  const mocks: WindowApiMocks = {
    getToday: vi.fn(async () => ({ spark: null, isFirstAppearance: false, toneGauge: null })),
    dismissToday: vi.fn(async () => ({ ok: true })),
    feedbackLessLikeThis: vi.fn(async () => ({ ok: true })),
    generateNow: vi.fn(async () => ({ batch: null })),
    settingsGet: vi.fn(async () => ({
      dailySparkMode: 'on',
      onboardingFirstCompletedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    })),
    sessionsList: vi.fn(async () => Array.from({ length: 10 }, (_, i) => ({ id: `s-${i}` }))),
    memoryHistoryCount: vi.fn(async () => ({ count: 20 })),
    onDailySparkUpdated: vi.fn((cb: () => void) => {
      broadcastCb = cb;
      return () => {
        if (broadcastCb === cb) broadcastCb = null;
      };
    }),
  };

  Object.assign(window, {
    dailySparkApi: {
      getToday: mocks.getToday,
      dismissToday: mocks.dismissToday,
      feedbackLessLikeThis: mocks.feedbackLessLikeThis,
      generateNow: mocks.generateNow,
    },
    settingsApi: {
      get: mocks.settingsGet,
    },
    sessionsApi: {
      list: mocks.sessionsList,
    },
    memoryApi: {
      getHistoryCount: mocks.memoryHistoryCount,
    },
    api: {
      onDailySparkUpdated: mocks.onDailySparkUpdated,
    },
  });

  return {
    mocks,
    fireBroadcast: () => {
      broadcastCb?.();
    },
  };
}

function makeSpark(overrides: Partial<DailySpark> = {}): DailySpark {
  return {
    id: 'spark-1',
    weekStartIso: '2026-05-11',
    dayIso: '2026-05-12',
    format: 'haiku',
    layout: 'poem',
    body: 'three soft lines\nstacked\nfor today',
    ...overrides,
  };
}

interface HookHarness {
  result: { current: ReturnType<typeof useDailySpark> | null };
  rerender: () => Promise<void>;
  unmount: () => void;
}

function renderHook(): HookHarness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const result: HookHarness['result'] = { current: null };

  function HookProbe(): null {
    result.current = useDailySpark();
    return null;
  }

  act(() => {
    root.render(React.createElement(HookProbe));
  });

  return {
    result,
    rerender: async () => {
      await act(async () => {
        root.render(React.createElement(HookProbe));
        await Promise.resolve();
      });
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useDailySpark', () => {
  let harness: HookHarness | null = null;
  let installed: ReturnType<typeof installWindowApis>;

  beforeEach(() => {
    installed = installWindowApis();
    Object.values(trackingMocks).forEach((m) => m.mockReset());
    navigateMock.mockReset();
  });

  afterEach(() => {
    harness?.unmount();
    harness = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('returns null when mode is off (even with a spark in the batch)', async () => {
    installed.mocks.settingsGet.mockResolvedValue({
      dailySparkMode: 'off',
      onboardingFirstCompletedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    });
    installed.mocks.getToday.mockResolvedValue({
      spark: makeSpark(),
      isFirstAppearance: false,
      toneGauge: 'normal',
    });

    harness = renderHook();
    await flushAsync();

    expect(harness.result.current?.spark).toBeNull();
    expect(harness.result.current?.mode).toBe('off');
  });

  it('returns null when onboardingFirstCompletedAt is missing', async () => {
    installed.mocks.settingsGet.mockResolvedValue({
      dailySparkMode: 'on',
      onboardingFirstCompletedAt: null,
    });
    installed.mocks.getToday.mockResolvedValue({
      spark: makeSpark(),
      isFirstAppearance: false,
      toneGauge: 'normal',
    });

    harness = renderHook();
    await flushAsync();

    expect(harness.result.current?.spark).toBeNull();
  });

  it('returns null until 3 calendar days have passed since onboarding', async () => {
    installed.mocks.settingsGet.mockResolvedValue({
      dailySparkMode: 'on',
      onboardingFirstCompletedAt: Date.now() - 1 * 24 * 60 * 60 * 1000,
    });
    installed.mocks.getToday.mockResolvedValue({
      spark: makeSpark(),
      isFirstAppearance: false,
      toneGauge: 'normal',
    });

    harness = renderHook();
    await flushAsync();

    expect(harness.result.current?.spark).toBeNull();
  });

  it('returns null when activity baseline is not met (low sessions + low memory)', async () => {
    installed.mocks.settingsGet.mockResolvedValue({
      dailySparkMode: 'on',
      onboardingFirstCompletedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    });
    installed.mocks.sessionsList.mockResolvedValue(Array.from({ length: 2 }, (_, i) => ({ id: `s-${i}` })));
    installed.mocks.memoryHistoryCount.mockResolvedValue({ count: 4 });
    installed.mocks.getToday.mockResolvedValue({
      spark: makeSpark(),
      isFirstAppearance: false,
      toneGauge: 'normal',
    });

    harness = renderHook();
    await flushAsync();

    expect(harness.result.current?.spark).toBeNull();
  });

  it('returns the spark when activity is met via session count alone', async () => {
    installed.mocks.settingsGet.mockResolvedValue({
      dailySparkMode: 'on',
      onboardingFirstCompletedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    });
    installed.mocks.sessionsList.mockResolvedValue(Array.from({ length: 5 }, (_, i) => ({ id: `s-${i}` })));
    installed.mocks.memoryHistoryCount.mockResolvedValue({ count: 0 });
    installed.mocks.getToday.mockResolvedValue({
      spark: makeSpark({ id: 'session-baseline' }),
      isFirstAppearance: false,
      toneGauge: 'normal',
    });

    harness = renderHook();
    await flushAsync();

    expect(harness.result.current?.spark?.id).toBe('session-baseline');
  });

  it('returns the spark when activity is met via memory entries alone', async () => {
    installed.mocks.settingsGet.mockResolvedValue({
      dailySparkMode: 'on',
      onboardingFirstCompletedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    });
    installed.mocks.sessionsList.mockResolvedValue([]);
    installed.mocks.memoryHistoryCount.mockResolvedValue({ count: 10 });
    installed.mocks.getToday.mockResolvedValue({
      spark: makeSpark({ id: 'memory-baseline' }),
      isFirstAppearance: false,
      toneGauge: 'normal',
    });

    harness = renderHook();
    await flushAsync();

    expect(harness.result.current?.spark?.id).toBe('memory-baseline');
  });

  it('returns null when subtle mode and today is not Monday', async () => {
    vi.useFakeTimers();
    // 2026-05-12 is a Tuesday in any TZ.
    vi.setSystemTime(new Date('2026-05-12T15:00:00Z'));
    try {
      installed.mocks.settingsGet.mockResolvedValue({
        dailySparkMode: 'subtle',
        onboardingFirstCompletedAt: new Date('2026-04-01T00:00:00Z').getTime(),
      });
      installed.mocks.getToday.mockResolvedValue({
        spark: makeSpark(),
        isFirstAppearance: false,
        toneGauge: 'normal',
      });

      harness = renderHook();
      await flushAsync();

      expect(harness.result.current?.spark).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns the spark when subtle mode and today is Monday in UTC', async () => {
    vi.useFakeTimers();
    // 2026-05-11 is a Monday.
    vi.setSystemTime(new Date('2026-05-11T15:00:00Z'));
    try {
      installed.mocks.settingsGet.mockResolvedValue({
        dailySparkMode: 'subtle',
        onboardingFirstCompletedAt: new Date('2026-04-01T00:00:00Z').getTime(),
      });
      installed.mocks.getToday.mockResolvedValue({
        spark: makeSpark({ id: 'monday-subtle' }),
        isFirstAppearance: false,
        toneGauge: 'normal',
      });

      harness = renderHook();
      await flushAsync();

      expect(harness.result.current?.spark?.id).toBe('monday-subtle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fires dailySparkShown tracking only once per unique sparkId across re-renders', async () => {
    installed.mocks.settingsGet.mockResolvedValue({
      dailySparkMode: 'on',
      onboardingFirstCompletedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    });
    installed.mocks.getToday.mockResolvedValue({
      spark: makeSpark({ id: 'shown-once', format: 'haiku' }),
      isFirstAppearance: false,
      toneGauge: 'normal',
    });

    harness = renderHook();
    await flushAsync();
    await harness.rerender();
    await harness.rerender();

    expect(trackingMocks.dailySparkShown).toHaveBeenCalledTimes(1);
    expect(trackingMocks.dailySparkShown).toHaveBeenCalledWith('haiku');
  });

  it('dismiss() calls IPC and tracking with the format', async () => {
    installed.mocks.settingsGet.mockResolvedValue({
      dailySparkMode: 'on',
      onboardingFirstCompletedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    });
    installed.mocks.getToday.mockResolvedValue({
      spark: makeSpark({ id: 'to-dismiss', format: 'limerick' }),
      isFirstAppearance: false,
      toneGauge: 'normal',
    });

    harness = renderHook();
    await flushAsync();

    await act(async () => {
      harness?.result.current?.dismiss();
      await Promise.resolve();
    });

    expect(installed.mocks.dismissToday).toHaveBeenCalledWith({ sparkId: 'to-dismiss' });
    expect(trackingMocks.dailySparkHiddenToday).toHaveBeenCalledWith('limerick');
    expect(harness.result.current?.spark).toBeNull();
  });

  it('feedback() calls IPC and tracking with the format', async () => {
    installed.mocks.settingsGet.mockResolvedValue({
      dailySparkMode: 'on',
      onboardingFirstCompletedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    });
    installed.mocks.getToday.mockResolvedValue({
      spark: makeSpark({ id: 'to-feedback', format: 'sommelier_note' }),
      isFirstAppearance: false,
      toneGauge: 'normal',
    });

    harness = renderHook();
    await flushAsync();

    await act(async () => {
      harness?.result.current?.feedback();
      await Promise.resolve();
    });

    expect(installed.mocks.feedbackLessLikeThis).toHaveBeenCalledWith({ sparkId: 'to-feedback' });
    expect(trackingMocks.dailySparkLessLikeThis).toHaveBeenCalledWith('sommelier_note');
    expect(harness.result.current?.spark).toBeNull();
  });

  it('openSettings() navigates and fires the settings-opened tracking event', async () => {
    installed.mocks.settingsGet.mockResolvedValue({
      dailySparkMode: 'on',
      onboardingFirstCompletedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    });
    installed.mocks.getToday.mockResolvedValue({
      spark: makeSpark({ id: 'opens-settings' }),
      isFirstAppearance: false,
      toneGauge: 'normal',
    });

    harness = renderHook();
    await flushAsync();

    await act(async () => {
      harness?.result.current?.openSettings();
      await Promise.resolve();
    });

    expect(trackingMocks.dailySparkSettingsOpened).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith({ type: 'settings', tab: 'agents', section: 'dailySparkMode' });
  });

  it('re-fetches the spark when the daily-spark broadcast fires', async () => {
    installed.mocks.settingsGet.mockResolvedValue({
      dailySparkMode: 'on',
      onboardingFirstCompletedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
    });
    installed.mocks.getToday.mockResolvedValue({
      spark: makeSpark({ id: 'broadcast-test' }),
      isFirstAppearance: false,
      toneGauge: 'normal',
    });

    harness = renderHook();
    await flushAsync();

    expect(installed.mocks.getToday).toHaveBeenCalledTimes(1);

    await act(async () => {
      installed.fireBroadcast();
      await Promise.resolve();
    });
    await flushAsync();

    expect(installed.mocks.getToday).toHaveBeenCalledTimes(2);
  });
});
