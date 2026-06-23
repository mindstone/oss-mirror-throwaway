/**
 * queueBackgroundDrain tests.
 *
 * Focus: the `mapSummaryToFetchResult` mapping rules and the
 * `runBackgroundDrain` wrapper (connectivity pre-check, cold-start init,
 * mapping). The OS task registration path is thin glue and is covered by
 * manual verification on-device.
 */

jest.mock('expo-task-manager', () => ({
  __esModule: true,
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
}));

jest.mock('expo-background-fetch', () => ({
  __esModule: true,
  BackgroundFetchResult: { NoData: 1, NewData: 2, Failed: 3 },
  BackgroundFetchStatus: { Denied: 1, Restricted: 2, Available: 3 },
  getStatusAsync: jest.fn(),
  registerTaskAsync: jest.fn(),
  unregisterTaskAsync: jest.fn(),
}));

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { fetch: jest.fn() },
}));

jest.mock('../utils/sentry', () => ({
  __esModule: true,
  captureSentryMessage: jest.fn(),
  mobileErrorReporter: { captureException: jest.fn() },
}));

jest.mock('../utils/continuityBreadcrumbs', () => ({
  __esModule: true,
  recordContinuityBreadcrumb: jest.fn(),
}));

jest.mock('@rebel/cloud-client', () => ({
  __esModule: true,
  useAuthStore: { getState: jest.fn() },
  useOfflineQueueStore: { getState: jest.fn() },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  hashForBreadcrumb: (value: string) => `hashed-${value}`,
}));

import * as BackgroundFetch from 'expo-background-fetch';
import NetInfo from '@react-native-community/netinfo';
import type { DrainSummary, QueueItem } from '@rebel/cloud-client';
import {
  __resetNoProgressSentryThrottle,
  mapSummaryToFetchResult,
  runBackgroundDrain,
} from '../services/queueBackgroundDrain';
import { useAuthStore, useOfflineQueueStore } from '@rebel/cloud-client';
import { captureSentryMessage } from '../utils/sentry';
import { recordContinuityBreadcrumb } from '../utils/continuityBreadcrumbs';

function mkSummary(overrides: Partial<DrainSummary> = {}): DrainSummary {
  return {
    attempted: 0,
    drained: 0,
    failed: 0,
    skipped: 0,
    terminalized: 0,
    authFailures: 0,
    authBlocked: false,
    durationMs: 0,
    budgetExceeded: false,
    skippedAlreadyDraining: false,
    skippedOffline: false,
    ...overrides,
  };
}

function mkQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'item-1',
    type: 'text-message',
    status: 'pending',
    enqueuedAt: Date.now(),
    attempts: 0,
    nextRetryAt: 0,
    isPermanentFailure: false,
    metadata: {},
    ...overrides,
  };
}

function setOnline(online: boolean): void {
  (NetInfo.fetch as jest.Mock).mockResolvedValue({
    isConnected: online,
    isInternetReachable: online,
  });
}

describe('mapSummaryToFetchResult', () => {
  it('returns NoData when offline', () => {
    expect(mapSummaryToFetchResult(mkSummary({ skippedOffline: true }))).toBe(
      BackgroundFetch.BackgroundFetchResult.NoData,
    );
  });

  it('returns NoData when a drain was already in flight', () => {
    expect(mapSummaryToFetchResult(mkSummary({ skippedAlreadyDraining: true }))).toBe(
      BackgroundFetch.BackgroundFetchResult.NoData,
    );
  });

  it('returns NoData when nothing was attempted', () => {
    expect(mapSummaryToFetchResult(mkSummary({ attempted: 0 }))).toBe(
      BackgroundFetch.BackgroundFetchResult.NoData,
    );
  });

  it('returns NoData when auth is blocked', () => {
    expect(mapSummaryToFetchResult(mkSummary({ authBlocked: true, attempted: 3 }))).toBe(
      BackgroundFetch.BackgroundFetchResult.NoData,
    );
  });

  it('returns NewData when at least one item drained', () => {
    expect(mapSummaryToFetchResult(mkSummary({ attempted: 2, drained: 1, failed: 1 }))).toBe(
      BackgroundFetch.BackgroundFetchResult.NewData,
    );
  });

  it('returns NewData when items were terminalized (forward progress)', () => {
    expect(
      mapSummaryToFetchResult(mkSummary({ attempted: 2, failed: 2, terminalized: 2 })),
    ).toBe(BackgroundFetch.BackgroundFetchResult.NewData);
  });

  it('returns NewData when stale sweep terminalized items before attempts', () => {
    expect(
      mapSummaryToFetchResult(mkSummary({ attempted: 0, terminalized: 1 })),
    ).toBe(BackgroundFetch.BackgroundFetchResult.NewData);
  });

  it('returns Failed when all attempted items failed transiently', () => {
    expect(
      mapSummaryToFetchResult(mkSummary({ attempted: 3, failed: 3, drained: 0 })),
    ).toBe(BackgroundFetch.BackgroundFetchResult.Failed);
  });

  it('returns NoData when every failure was auth (OS backoff is wrong signal)', () => {
    expect(
      mapSummaryToFetchResult(
        mkSummary({ attempted: 2, failed: 2, authFailures: 2, drained: 0 }),
      ),
    ).toBe(BackgroundFetch.BackgroundFetchResult.NoData);
  });
});

describe('runBackgroundDrain', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    setOnline(true);
    __resetNoProgressSentryThrottle();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('emits item-stuck-ack breadcrumb for stale ack-missing items', async () => {
    const now = Date.now();
    jest.setSystemTime(now);

    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockReturnValue({
      items: [
        mkQueueItem({
          id: 'stuck-ack-item',
          type: 'text-message',
          attempts: 3,
          errorCategory: 'temporary',
          lastError: 'Persistence acknowledgement missing',
          processingStartedAt: now - 10 * 60 * 1000 - 1_000,
        }),
      ],
      init: jest.fn().mockResolvedValue(undefined),
      bindAuthIdentity: jest.fn(),
      drain: jest.fn().mockResolvedValue(mkSummary()),
    });

    await runBackgroundDrain();

    expect(recordContinuityBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        family: 'outbox',
        message: 'item-stuck-ack',
        level: 'warning',
        data: expect.objectContaining({
          attempts: 3,
          errorCategory: 'timeout',
          itemKindHashed: 'hashed-text-message',
        }),
      }),
    );
    const emittedEvent = (recordContinuityBreadcrumb as jest.Mock).mock.calls[0][0];
    expect(emittedEvent.data.ageMs).toBeGreaterThan(10 * 60 * 1000);
  });

  it('does not spam item-stuck-ack on repeated background ticks for the same item', async () => {
    const now = Date.now();
    jest.setSystemTime(now);

    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockReturnValue({
      items: [
        mkQueueItem({
          id: 'stuck-ack-item',
          type: 'voice-transcription',
          attempts: 2,
          errorCategory: 'temporary',
          lastError: 'Persistence acknowledgement missing',
          processingStartedAt: now - 11 * 60 * 1000,
        }),
      ],
      init: jest.fn().mockResolvedValue(undefined),
      bindAuthIdentity: jest.fn(),
      drain: jest.fn().mockResolvedValue(mkSummary()),
    });

    await runBackgroundDrain();
    await runBackgroundDrain();

    expect(recordContinuityBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it('does not emit item-stuck-ack when item age is within 10 minutes', async () => {
    const now = Date.now();
    jest.setSystemTime(now);

    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockReturnValue({
      items: [
        mkQueueItem({
          id: 'recent-ack-item',
          attempts: 1,
          errorCategory: 'temporary',
          lastError: 'Persistence acknowledgement missing',
          processingStartedAt: now - 9 * 60 * 1000,
        }),
      ],
      init: jest.fn().mockResolvedValue(undefined),
      bindAuthIdentity: jest.fn(),
      drain: jest.fn().mockResolvedValue(mkSummary()),
    });

    await runBackgroundDrain();
    expect(recordContinuityBreadcrumb).not.toHaveBeenCalled();
  });

  it('does not emit item-stuck-ack for non-ack failures', async () => {
    const now = Date.now();
    jest.setSystemTime(now);

    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockReturnValue({
      items: [
        mkQueueItem({
          id: 'network-failure-item',
          attempts: 4,
          errorCategory: 'network',
          lastError: 'Network timeout',
          processingStartedAt: now - 20 * 60 * 1000,
        }),
      ],
      init: jest.fn().mockResolvedValue(undefined),
      bindAuthIdentity: jest.fn(),
      drain: jest.fn().mockResolvedValue(mkSummary()),
    });

    await runBackgroundDrain();
    expect(recordContinuityBreadcrumb).not.toHaveBeenCalled();
  });

  it('does not emit item-stuck-ack for non-failed items', async () => {
    const now = Date.now();
    jest.setSystemTime(now);

    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockReturnValue({
      items: [
        mkQueueItem({
          id: 'fresh-item',
          attempts: 0,
          errorCategory: undefined,
          lastError: undefined,
          processingStartedAt: undefined,
        }),
      ],
      init: jest.fn().mockResolvedValue(undefined),
      bindAuthIdentity: jest.fn(),
      drain: jest.fn().mockResolvedValue(mkSummary()),
    });

    await runBackgroundDrain();
    expect(recordContinuityBreadcrumb).not.toHaveBeenCalled();
  });

  it('returns NoData when not paired', async () => {
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: false,
      cloudUrl: null,
    });

    const result = await runBackgroundDrain();
    expect(result).toBe(BackgroundFetch.BackgroundFetchResult.NoData);
  });

  it('returns NoData when the device is offline during wake', async () => {
    setOnline(false);
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });

    const result = await runBackgroundDrain();
    expect(result).toBe(BackgroundFetch.BackgroundFetchResult.NoData);
    // Drain must not even be attempted.
    expect(useOfflineQueueStore.getState).not.toHaveBeenCalled();
  });

  it('calls init() before drain (cold-start safety)', async () => {
    const order: string[] = [];
    const initSpy = jest.fn().mockImplementation(async () => {
      order.push('init');
    });
    const drainSpy = jest.fn().mockImplementation(async () => {
      order.push('drain');
      return mkSummary({ attempted: 1, drained: 1 });
    });
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockReturnValue({
      init: initSpy,
      bindAuthIdentity: jest.fn(),
      drain: drainSpy,
    });

    await runBackgroundDrain();
    expect(initSpy).toHaveBeenCalled();
    expect(order).toEqual(['init', 'drain']);
  });

  it('calls drain with idempotent-item-types filter + budget', async () => {
    const drainSpy = jest.fn().mockResolvedValue(mkSummary({ attempted: 1, drained: 1 }));
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockReturnValue({
      init: jest.fn().mockResolvedValue(undefined),
      bindAuthIdentity: jest.fn(),
      drain: drainSpy,
    });

    const result = await runBackgroundDrain();

    expect(drainSpy).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        maxDurationMs: expect.any(Number),
        processingTimeoutMs: expect.any(Number),
        itemTypes: ['meeting-chunk'],
      }),
    );
    expect(result).toBe(BackgroundFetch.BackgroundFetchResult.NewData);
  });

  it('returns Failed + reports to Sentry when drain throws', async () => {
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockReturnValue({
      init: jest.fn().mockResolvedValue(undefined),
      bindAuthIdentity: jest.fn(),
      drain: jest.fn().mockRejectedValue(new Error('drain exploded')),
    });

    const result = await runBackgroundDrain();
    expect(result).toBe(BackgroundFetch.BackgroundFetchResult.Failed);
    expect(captureSentryMessage).toHaveBeenCalledWith(
      'queue background drain: drain threw',
      'error',
      expect.any(Object),
    );
  });

  it('returns Failed + reports to Sentry when init() fails', async () => {
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockReturnValue({
      init: jest.fn().mockRejectedValue(new Error('disk full')),
      bindAuthIdentity: jest.fn(),
      drain: jest.fn(),
    });

    const result = await runBackgroundDrain();
    expect(result).toBe(BackgroundFetch.BackgroundFetchResult.Failed);
    expect(captureSentryMessage).toHaveBeenCalledWith(
      'queue background drain: init failed',
      'error',
      expect.any(Object),
    );
  });

  it('returns NoData + warns Sentry when the queue store is not initialised', async () => {
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockImplementation(() => {
      throw new Error('not initialised');
    });

    const result = await runBackgroundDrain();
    expect(result).toBe(BackgroundFetch.BackgroundFetchResult.NoData);
    expect(captureSentryMessage).toHaveBeenCalledWith(
      'queue background drain: store not initialised',
      'warning',
      expect.any(Object),
    );
  });

  it('warns Sentry when the drain made no forward progress (transient)', async () => {
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockReturnValue({
      init: jest.fn().mockResolvedValue(undefined),
      bindAuthIdentity: jest.fn(),
      drain: jest.fn().mockResolvedValue(
        mkSummary({ attempted: 2, failed: 2, drained: 0, terminalized: 0 }),
      ),
    });

    await runBackgroundDrain();
    expect(captureSentryMessage).toHaveBeenCalledWith(
      'queue background drain: no forward progress',
      'warning',
      expect.any(Object),
    );
  });

  it('suppresses the no-progress warning when every failure was auth', async () => {
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockReturnValue({
      init: jest.fn().mockResolvedValue(undefined),
      bindAuthIdentity: jest.fn(),
      drain: jest.fn().mockResolvedValue(
        mkSummary({ attempted: 2, failed: 2, authFailures: 2, drained: 0 }),
      ),
    });

    await runBackgroundDrain();
    expect(captureSentryMessage).not.toHaveBeenCalledWith(
      'queue background drain: no forward progress',
      expect.anything(),
      expect.anything(),
    );
  });

  it('throttles the no-progress warning to once per window', async () => {
    const drainSpy = jest.fn().mockResolvedValue(
      mkSummary({ attempted: 1, failed: 1, drained: 0, terminalized: 0 }),
    );
    (useAuthStore.getState as jest.Mock).mockReturnValue({
      loadCredentials: jest.fn().mockResolvedValue(undefined),
      isPaired: true,
      cloudUrl: 'https://example.com',
    });
    (useOfflineQueueStore.getState as jest.Mock).mockReturnValue({
      init: jest.fn().mockResolvedValue(undefined),
      bindAuthIdentity: jest.fn(),
      drain: drainSpy,
    });

    await runBackgroundDrain();
    await runBackgroundDrain();
    await runBackgroundDrain();

    const noProgressCalls = (captureSentryMessage as jest.Mock).mock.calls.filter(
      ([message]) => message === 'queue background drain: no forward progress',
    );
    expect(noProgressCalls).toHaveLength(1);
  });
});
