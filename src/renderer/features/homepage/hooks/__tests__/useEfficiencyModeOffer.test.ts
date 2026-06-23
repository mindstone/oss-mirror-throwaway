// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, flushAsync } from '../../../../test-utils/hookTestHarness';
import type { AppSettings } from '@shared/types';
import {
  useEfficiencyModeOffer,
  EFFICIENCY_MODE_OFFER_ID,
} from '../useEfficiencyModeOffer';

vi.mock('../../../../src/tracking', () => ({
  tracking: {
    settings: {
      efficiencyModeToggled: vi.fn(),
      efficiencyModeOfferDismissed: vi.fn(),
    },
  },
}));

type MutableDeviceMemory = Navigator & { deviceMemory?: number };

const ORIGINAL_DEVICE_MEMORY = (navigator as MutableDeviceMemory).deviceMemory;

function setDeviceMemory(value: number | undefined): void {
  Object.defineProperty(navigator, 'deviceMemory', {
    configurable: true,
    get: () => value,
  });
}

function makeSettings(overrides: Partial<AppSettings>): AppSettings {
  return {
    onboardingCompleted: true,
    efficiencyMode: 'off',
    dismissedAnnouncements: {},
    ...overrides,
  } as AppSettings;
}

describe('useEfficiencyModeOffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin "now" past the 30-minute uptime threshold so mountTimeRef + 30min is
    // satisfied immediately. Individual tests can override by advancing timers.
    vi.setSystemTime(new Date('2026-05-24T12:00:00Z'));
    setDeviceMemory(4);
  });

  afterEach(() => {
    vi.useRealTimers();
    setDeviceMemory(ORIGINAL_DEVICE_MEMORY);
    vi.clearAllMocks();
  });

  const renderOffer = (
    settings: AppSettings | null,
    saveSettingsWith = vi.fn().mockResolvedValue(undefined),
  ) =>
    renderHook(() => useEfficiencyModeOffer({ settings, saveSettingsWith }));

  it('does not offer when settings are null', () => {
    const { result } = renderOffer(null);
    expect(result.current.showOffer).toBe(false);
  });

  it('does not offer when onboarding is incomplete', async () => {
    const { result } = renderOffer(makeSettings({ onboardingCompleted: false }));
    await act(async () => {
      vi.advanceTimersByTime(31 * 60 * 1000);
      await flushAsync();
    });
    expect(result.current.showOffer).toBe(false);
  });

  it('does not offer when efficiencyMode is already on', async () => {
    const { result } = renderOffer(makeSettings({ efficiencyMode: 'on' }));
    await act(async () => {
      vi.advanceTimersByTime(31 * 60 * 1000);
      await flushAsync();
    });
    expect(result.current.showOffer).toBe(false);
  });

  it('does not offer when already dismissed', async () => {
    const { result } = renderOffer(
      makeSettings({ dismissedAnnouncements: { [EFFICIENCY_MODE_OFFER_ID]: true } }),
    );
    await act(async () => {
      vi.advanceTimersByTime(31 * 60 * 1000);
      await flushAsync();
    });
    expect(result.current.showOffer).toBe(false);
  });

  it('does not offer when deviceMemory is above the low-RAM threshold', async () => {
    setDeviceMemory(8);
    const { result } = renderOffer(makeSettings({}));
    await act(async () => {
      vi.advanceTimersByTime(31 * 60 * 1000);
      await flushAsync();
    });
    expect(result.current.showOffer).toBe(false);
  });

  it('does not offer when deviceMemory is unavailable', async () => {
    setDeviceMemory(undefined);
    const { result } = renderOffer(makeSettings({}));
    await act(async () => {
      vi.advanceTimersByTime(31 * 60 * 1000);
      await flushAsync();
    });
    expect(result.current.showOffer).toBe(false);
  });

  it('does not offer before the minimum uptime threshold', () => {
    const { result } = renderOffer(makeSettings({}));
    expect(result.current.showOffer).toBe(false);
  });

  it('offers once the uptime threshold elapses, RAM is low, and the user is onboarded', async () => {
    const { result } = renderOffer(makeSettings({}));
    expect(result.current.showOffer).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(31 * 60 * 1000);
      await flushAsync();
    });
    expect(result.current.showOffer).toBe(true);
  });

  it('handleEnable persists efficiencyMode=on and records dismissal', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderOffer(makeSettings({}), save);
    await act(async () => {
      vi.advanceTimersByTime(31 * 60 * 1000);
      await flushAsync();
    });
    await act(async () => {
      await result.current.handleEnable();
    });
    expect(save).toHaveBeenCalledTimes(1);
    const updater = save.mock.calls[0]![0] as (s: AppSettings) => AppSettings;
    const next = updater(makeSettings({}));
    expect(next.efficiencyMode).toBe('on');
    expect(next.dismissedAnnouncements?.[EFFICIENCY_MODE_OFFER_ID]).toBe(true);
  });

  it('handleDismiss records dismissal without enabling efficiency mode', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result } = renderOffer(makeSettings({}), save);
    await act(async () => {
      vi.advanceTimersByTime(31 * 60 * 1000);
      await flushAsync();
    });
    await act(async () => {
      await result.current.handleDismiss();
    });
    expect(save).toHaveBeenCalledTimes(1);
    const updater = save.mock.calls[0]![0] as (s: AppSettings) => AppSettings;
    const next = updater(makeSettings({}));
    expect(next.efficiencyMode).toBe('off');
    expect(next.dismissedAnnouncements?.[EFFICIENCY_MODE_OFFER_ID]).toBe(true);
  });
});
