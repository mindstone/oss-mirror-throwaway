import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';
import { flushPromises } from './helpers';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface LayoutHarnessOptions {
  sessionHydratePromise?: Promise<void>;
  inboxHydratePromise?: Promise<void>;
  unpairPromise?: Promise<void>;
}

function setupLayoutHarness(options: LayoutHarnessOptions = {}) {
  jest.resetModules();
  jest.doMock('react', () => React);
  // A sibling test (Test 2b) `jest.doMock('react-native', ...)` with a stripped
  // stub; that registration persists across `resetModules()`. Ensure the real
  // jest-expo react-native (with `useColorScheme` etc.) is used when rendering
  // RootLayout from this harness, regardless of test ordering.
  jest.dontMock('react-native');

  const order: string[] = [];
  let unauthorizedHandler: (() => void) | null = null;
  let widgetSyncSubscribed = false;

  const mockLoadCredentials = jest.fn().mockResolvedValue(undefined);
  const mockSessionHydrate = jest.fn(() => options.sessionHydratePromise ?? Promise.resolve());
  const mockInboxHydrate = jest.fn(() => options.inboxHydratePromise ?? Promise.resolve());
  const mockSubscriberWrite = jest.fn(() => {
    order.push('subscriberWrite');
  });

  const mockUnpair = jest.fn(async () => {
    order.push('unpair');
    await (options.unpairPromise ?? Promise.resolve());
  });

  const mockClearWidgetData = jest.fn(() => {
    order.push('clearWidgetData');
  });

  const mockInitWidgetDataSync = jest.fn(() => {
    order.push('initWidgetDataSync');
    widgetSyncSubscribed = true;
    return () => {
      order.push('unsubscribeWidgetSync');
      widgetSyncSubscribed = false;
    };
  });

  const mockUnregisterWidgetBackgroundRefresh = jest.fn(async () => {
    order.push('unregisterWidgetBackgroundRefresh');
  });

  const authStoreState = {
    isPaired: true,
    cloudUrl: 'https://cloud.example.test',
    token: 'token-123',
    unpair: mockUnpair,
  };

  const sessionStoreState = {
    hydrate: mockSessionHydrate,
    resetStore: jest.fn(() => {
      order.push('resetSessionStore');
    }),
    forceEventReconnect: jest.fn(),
    fetchSessions: jest.fn(),
    fetchSession: jest.fn(),
    currentSession: null as { id: string } | null,
    _lastFetchOptions: undefined as unknown,
  };

  const inboxStoreState = {
    hydrate: mockInboxHydrate,
    resetStore: jest.fn(() => {
      order.push('resetStore');
      if (widgetSyncSubscribed) {
        mockSubscriberWrite();
      }
    }),
    fetchInbox: jest.fn(),
    items: [] as unknown[],
  };

  const stagedFilesStoreState = {
    resetStore: jest.fn(),
    fetchStagedFiles: jest.fn(),
  };

  const approvalStoreState = {
    resetStore: jest.fn(),
  };

  const activeRecordingStoreState = {
    clearRecording: jest.fn(),
  };
  const mockRehydrateActiveRecordingIds = jest.fn().mockResolvedValue(undefined);

  const offlineQueueStoreState = {
    init: jest.fn().mockResolvedValue(undefined),
    bindAuthIdentity: jest.fn(),
    clearAll: jest.fn().mockResolvedValue(undefined),
    drain: jest.fn().mockResolvedValue(undefined),
    items: [] as unknown[],
    queueFullAt: null as number | null,
    limitedConnectivityAt: null as number | null,
    authExpiredAt: null as number | null,
    boundCloudUrl: null as string | null,
  };

  const useAuthStore = Object.assign(
    jest.fn(() => ({
      isPaired: authStoreState.isPaired,
      loadCredentials: mockLoadCredentials,
    })),
    {
      getState: () => authStoreState,
    },
  );

  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };

  jest.doMock('@rebel/cloud-client', () => ({
    useAuthStore,
    useSessionStore: { getState: () => sessionStoreState },
    useInboxStore: { getState: () => inboxStoreState },
    useStagedFilesStore: { getState: () => stagedFilesStoreState },
    useApprovalStore: { getState: () => approvalStoreState },
    initAuthStore: jest.fn(),
    EventBridge: () => null,
    onUnauthorized: jest.fn((callback: () => void) => {
      unauthorizedHandler = callback;
    }),
    initOfflineQueueStore: jest.fn(),
    useOfflineQueueStore: { getState: () => offlineQueueStoreState },
    // A1 (analytics/error-monitoring): the paired-effect fetches cloud settings
    // to identify the Sentry user by email. Fire-and-forget, so it must not
    // perturb the pair/unpair/cold-start ordering these tests pin.
    getSettings: jest.fn().mockResolvedValue({ userEmail: 'tester@example.com' }),
    createLogger: jest.fn(() => mockLogger),
    setLogPersistCallback: jest.fn(),
    setLogErrorReporter: jest.fn(),
    initPersistence: jest.fn(),
    flushPending: jest.fn(),
    clearKeysForPrefix: jest.fn().mockResolvedValue(undefined),
    buildCacheKeyPrefix: jest.fn((cloudUrl: string) => `cache:${cloudUrl}`),
    setSessionContinuityRecorder: jest.fn(),
  }));

  jest.doMock('../../src/services/widgetDataSync', () => ({
    initWidgetDataSync: mockInitWidgetDataSync,
    clearWidgetData: mockClearWidgetData,
  }));

  jest.doMock('../../src/services/widgetBackgroundRefresh', () => ({
    registerWidgetBackgroundRefresh: jest.fn().mockResolvedValue(undefined),
    unregisterWidgetBackgroundRefresh: mockUnregisterWidgetBackgroundRefresh,
  }));

  jest.doMock('../../src/services/queueBackgroundDrain', () => ({
    registerQueueBackgroundDrain: jest.fn().mockResolvedValue(undefined),
    unregisterQueueBackgroundDrain: jest.fn().mockResolvedValue(undefined),
  }));

  jest.doMock('../../src/stores/activeRecordingStore', () => ({
    useActiveRecordingStore: { getState: () => activeRecordingStoreState },
    rehydrateActiveRecordingIds: (...args: unknown[]) => mockRehydrateActiveRecordingIds(...args),
  }));

  jest.doMock('../../src/storage/secureTokenStorage', () => ({
    secureTokenStorage: {},
  }));

  jest.doMock('../../src/storage/offlineQueueStorage', () => ({
    ExpoFileSystemQueueStorage: class ExpoFileSystemQueueStorage {},
  }));

  jest.doMock('../../src/storage/asyncStoragePersistence', () => ({
    asyncStoragePersistence: {},
  }));

  jest.doMock('../../src/hooks/useRoutingQueueConsumer', () => ({
    createRoutingConsumer: jest.fn(() => jest.fn()),
  }));

  jest.doMock('../../src/hooks/useMeetingChunkConsumer', () => ({
    recoverMissingMeetingChunksFromManifests: jest.fn().mockResolvedValue(0),
  }));

  jest.doMock('../../src/utils/meetingManifest', () => ({
    listMeetingManifests: jest.fn().mockResolvedValue([]),
    deleteMeetingSession: jest.fn().mockResolvedValue(undefined),
  }));

  jest.doMock('../../src/screens/PairScreen', () => ({
    PairScreen: () => null,
  }));

  jest.doMock('../../src/components/ErrorBoundary', () => ({
    ErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
  }));

  jest.doMock('../../src/components/SilentErrorBoundary', () => ({
    SilentErrorBoundary: ({ children }: { children: React.ReactNode }) => children,
  }));

  jest.doMock('../../src/components/ConnectivityBannerConnected', () => ({
    ConnectivityBannerConnected: () => null,
  }));

  jest.doMock('../../src/components/approval/ApprovalSheetProvider', () => ({
    ApprovalSheetProvider: ({ children }: { children: React.ReactNode }) => children,
  }));

  jest.doMock('../../src/context/MeetingRecordingContext', () => ({
    MeetingRecordingProvider: ({ children }: { children: React.ReactNode }) => children,
  }));

  jest.doMock('../../src/hooks/useNetworkState', () => ({
    useNetworkState: () => ({ isOnline: true, isInternetReachable: true, isConnected: true }),
  }));

  jest.doMock('../../src/context/NetworkContext', () => {
    const ReactLib = require('react') as typeof React;
    return {
      NetworkContext: ReactLib.createContext({
        isOnline: true,
        isInternetReachable: true,
        isConnected: true,
      }),
    };
  });

  jest.doMock('../../src/theme/colors', () => ({
    useColors: () => ({ background: '#111111', accent: '#ffffff' }),
  }));

  jest.doMock('@expo-google-fonts/figtree', () => ({
    useFonts: () => [true, null],
    Figtree_400Regular: {},
    Figtree_500Medium: {},
    Figtree_600SemiBold: {},
    Figtree_700Bold: {},
  }));

  jest.doMock('../../src/utils/sentry', () => ({
    initSentry: jest.fn(),
    setSentryCloudContext: jest.fn(),
    clearSentryContext: jest.fn(),
    setSentryHealthContext: jest.fn(),
    setSentryUser: jest.fn(),
    captureSentryBreadcrumb: jest.fn(),
    wrapWithSentry: <T,>(Component: T) => Component,
    mobileErrorReporter: { captureException: jest.fn() },
  }));

  jest.doMock('../../src/utils/fileLogSink', () => ({
    fileLogWriter: jest.fn(),
    flushLogs: jest.fn(() => Promise.resolve()),
    purgeFileLogs: jest.fn(() => Promise.resolve()),
    startLifecycleFlush: jest.fn(() => () => {}),
    readRecentLogs: jest.fn(() => Promise.resolve('')),
  }));

  jest.doMock('../../src/utils/pushNotifications', () => ({
    registerForPushNotifications: jest.fn(),
    unregisterPushNotifications: jest.fn(),
    setupNotificationListeners: jest.fn(() => jest.fn()),
  }));

  jest.doMock('../../src/utils/queueBreadcrumbs', () => ({
    recordQueueBreadcrumb: jest.fn(),
  }));

  jest.doMock('../../src/utils/continuityBreadcrumbs', () => ({
    recordContinuityBreadcrumb: jest.fn(),
  }));

  jest.doMock('../../src/utils/queueLifecycleContinuity', () => ({
    buildQueueDrainLifecycleBreadcrumb: jest.fn(() => ({})),
    didDeviceRebootSince: jest.fn(() => false),
    estimateBootTimeMs: jest.fn(() => Date.now()),
    shouldRecordLifecycleBreadcrumb: jest.fn(() => false),
  }));

  jest.doMock('../../src/utils/queueMetrics', () => ({
    startQueueMetrics: jest.fn(() => ({ stop: jest.fn() })),
  }));

  jest.doMock('react-native-gesture-handler', () => ({
    GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
  }));

  jest.doMock('expo-status-bar', () => ({
    StatusBar: () => null,
  }));

  jest.doMock('expo-router', () => {
    const ReactLib = require('react') as typeof React;
    const Stack = ({ children }: { children: React.ReactNode }) => (
      ReactLib.createElement(ReactLib.Fragment, null, children)
    );
    (Stack as unknown as { Screen?: React.ComponentType }).Screen = () => null;
    return { Stack, useSegments: () => ['(tabs)'] };
  });

  // B3 analytics: mock the gated singleton + typed taxonomy so _layout's
  // init/identify/reset/screen-view/lifecycle wiring is observable without
  // pulling in the RudderStack native SDK. `isAnalyticsPermitted` returns true
  // so the post-pair `init()` path runs.
  const mockAnalyticsInit = jest.fn().mockResolvedValue(undefined);
  const mockAnalyticsFlush = jest.fn();
  jest.doMock('../../src/analytics/analytics', () => ({
    analytics: {
      init: (...args: unknown[]) => mockAnalyticsInit(...args),
      // whenReady resolves immediately so the post-pair identity sync proceeds
      // (the real singleton serialises identify behind init — GPT F2).
      whenReady: () => Promise.resolve(),
      flush: (...args: unknown[]) => mockAnalyticsFlush(...args),
      track: jest.fn(),
      identify: jest.fn(),
      reset: jest.fn(),
      isAvailable: () => true,
    },
    isAnalyticsPermitted: () => true,
  }));

  const mockTrackingAppOpened = jest.fn();
  const mockTrackingScreenViewed = jest.fn();
  const mockTrackingUnpaired = jest.fn();
  const mockIdentifyByEmail = jest.fn();
  const mockResetIdentity = jest.fn();
  jest.doMock('../../src/analytics/tracking', () => ({
    tracking: {
      appOpened: (...args: unknown[]) => mockTrackingAppOpened(...args),
      appBackgrounded: jest.fn(),
      screenViewed: (...args: unknown[]) => mockTrackingScreenViewed(...args),
      pair: {
        started: jest.fn(),
        succeeded: jest.fn(),
        failed: jest.fn(),
        unpaired: (...args: unknown[]) => mockTrackingUnpaired(...args),
      },
      messageSent: jest.fn(),
      voiceRecordingCompleted: jest.fn(),
      approvalResolved: jest.fn(),
      inboxActionTapped: jest.fn(),
    },
    identifyByEmail: (...args: unknown[]) => mockIdentifyByEmail(...args),
    resetIdentity: (...args: unknown[]) => mockResetIdentity(...args),
  }));

  const { default: RootLayout } = require('../../app/_layout');

  return {
    RootLayout: RootLayout as React.ComponentType,
    order,
    mockInitWidgetDataSync,
    mockClearWidgetData,
    mockUnregisterWidgetBackgroundRefresh,
    mockSubscriberWrite,
    mockSessionHydrate,
    mockInboxHydrate,
    mockRehydrateActiveRecordingIds,
    offlineQueueStoreState,
    getUnauthorizedHandler: () => unauthorizedHandler,
    // B3 analytics observability
    mockAnalyticsInit,
    mockAnalyticsFlush,
    mockTrackingAppOpened,
    mockTrackingScreenViewed,
    mockTrackingUnpaired,
    mockIdentifyByEmail,
    mockResetIdentity,
  };
}

type MockInboxItem = {
  id: string;
  title: string;
  archived: boolean;
  urgent?: boolean;
};

describe('widget lifecycle hardening (Stage 1)', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('Test 1a: 401 cleanup unbinds but does not clear queue or widget data before unpair completes', async () => {
    const unpairDeferred = createDeferred<void>();
    const harness = setupLayoutHarness({ unpairPromise: unpairDeferred.promise });

    render(React.createElement(harness.RootLayout));

    await act(async () => {
      await flushPromises();
    });

    const unauthorized = harness.getUnauthorizedHandler();
    expect(unauthorized).toBeTruthy();

    act(() => {
      unauthorized?.();
    });

    expect(harness.offlineQueueStoreState.bindAuthIdentity).toHaveBeenCalledWith(null);
    expect(harness.offlineQueueStoreState.clearAll).not.toHaveBeenCalled();
    expect(harness.mockClearWidgetData).not.toHaveBeenCalled();

    await act(async () => {
      await flushPromises();
    });

    expect(harness.mockClearWidgetData).not.toHaveBeenCalled();

    await act(async () => {
      unpairDeferred.resolve();
      await flushPromises();
    });

    await waitFor(() => {
      expect(harness.mockClearWidgetData).toHaveBeenCalledTimes(1);
      expect(harness.mockUnregisterWidgetBackgroundRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it('Test 1b: unsubscribes widget sync before inbox reset so no subscriber write happens during unpair', async () => {
    const harness = setupLayoutHarness();

    render(React.createElement(harness.RootLayout));

    await waitFor(() => {
      expect(harness.mockInitWidgetDataSync).toHaveBeenCalledTimes(1);
    });

    const unauthorized = harness.getUnauthorizedHandler();
    expect(unauthorized).toBeTruthy();

    act(() => {
      unauthorized?.();
    });

    await waitFor(() => {
      expect(harness.mockClearWidgetData).toHaveBeenCalledTimes(1);
    });

    expect(harness.order).toContain('unsubscribeWidgetSync');
    expect(harness.order).toContain('resetStore');
    expect(harness.order).toContain('clearWidgetData');
    expect(harness.mockSubscriberWrite).not.toHaveBeenCalled();
    expect(harness.order.indexOf('unsubscribeWidgetSync')).toBeLessThan(harness.order.indexOf('resetStore'));
    expect(harness.order.indexOf('resetStore')).toBeLessThan(harness.order.indexOf('clearWidgetData'));
  });

  it('Test 2a: initWidgetDataSync is not invoked until both hydrate calls resolve', async () => {
    const sessionHydrateDeferred = createDeferred<void>();
    const inboxHydrateDeferred = createDeferred<void>();
    const harness = setupLayoutHarness({
      sessionHydratePromise: sessionHydrateDeferred.promise,
      inboxHydratePromise: inboxHydrateDeferred.promise,
    });

    render(React.createElement(harness.RootLayout));

    await act(async () => {
      await flushPromises();
    });

    expect(harness.mockSessionHydrate).toHaveBeenCalledTimes(1);
    expect(harness.mockInboxHydrate).toHaveBeenCalledTimes(1);
    expect(harness.mockInitWidgetDataSync).not.toHaveBeenCalled();

    await act(async () => {
      sessionHydrateDeferred.resolve();
      await flushPromises();
    });

    expect(harness.mockInitWidgetDataSync).not.toHaveBeenCalled();

    await act(async () => {
      inboxHydrateDeferred.resolve();
      await flushPromises();
    });

    await waitFor(() => {
      expect(harness.mockInitWidgetDataSync).toHaveBeenCalledTimes(1);
    });
  });

  it('calls rehydrateActiveRecordingIds during root cold-start boot', async () => {
    const harness = setupLayoutHarness();

    render(React.createElement(harness.RootLayout));

    await act(async () => {
      await flushPromises();
    });

    expect(harness.mockRehydrateActiveRecordingIds).toHaveBeenCalledTimes(1);
  });

  it('Test 2b: initWidgetDataSync does not do a spurious initial write when snapshot is unchanged', () => {
    jest.resetModules();

    const storageSet = jest.fn();
    let inboxItems: MockInboxItem[] = [];
    let subscriber: ((state: { items: MockInboxItem[] }) => void) | null = null;

    jest.doMock('react-native', () => ({
      Platform: { OS: 'ios' },
    }));

    jest.doMock('@bacons/apple-targets', () => {
      class ExtensionStorage {
        constructor(_suiteName: string) {}

        set(key: string, value: unknown): void {
          storageSet(key, value);
        }

        static reloadWidget(_kind: string): void {
          // no-op in tests
        }
      }

      return { ExtensionStorage };
    });

    jest.doMock('@rebel/cloud-client', () => ({
      useInboxStore: {
        getState: () => ({ items: inboxItems }),
        subscribe: jest.fn((callback: (state: { items: MockInboxItem[] }) => void) => {
          subscriber = callback;
          return jest.fn();
        }),
      },
      classifyInboxTier: jest.fn(() => 'act'),
      groupByTemporal: jest.fn((items: MockInboxItem[]) => new Map([['due-today', items]])),
      sortInboxItems: jest.fn((items: MockInboxItem[]) => items),
      createLogger: jest.fn(() => ({
        info: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        error: jest.fn(),
      })),
    }));

    jest.dontMock('../services/widgetDataSync');
    const widgetDataSync = require('../services/widgetDataSync');
    const unsubscribe = widgetDataSync.initWidgetDataSync();

    expect(typeof unsubscribe).toBe('function');
    expect(subscriber).toBeTruthy();
    expect(storageSet).not.toHaveBeenCalled();

    (subscriber as ((state: { items: MockInboxItem[] }) => void) | null)?.({ items: [] });
    expect(storageSet).not.toHaveBeenCalled();

    const changedItems: MockInboxItem[] = [
      {
        id: 'item-1',
        title: 'Review Q2 metrics',
        archived: false,
        urgent: true,
      },
    ];
    inboxItems = changedItems;
    (subscriber as ((state: { items: MockInboxItem[] }) => void) | null)?.({ items: changedItems });

    expect(storageSet).toHaveBeenCalledWith('actionItems', [
      {
        id: 'item-1',
        title: 'Review Q2 metrics',
        urgent: true,
      },
    ]);
    expect(storageSet).toHaveBeenCalledWith('lastUpdated', expect.any(String));
  });
});

describe('analytics wiring (Stage B3)', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('initialises analytics at launch and identifies by email from the SAME cloud-settings fetch', async () => {
    const harness = setupLayoutHarness();
    render(React.createElement(harness.RootLayout));
    await act(async () => {
      await flushPromises();
    });

    // init() runs at app LAUNCH (always-on; gated only on isAnalyticsPermitted()
    // === true in the harness) — NOT on pairing. Pairing governs identity only.
    expect(harness.mockAnalyticsInit).toHaveBeenCalled();
    // identify uses the email from getSettings() (mocked as tester@example.com),
    // the SAME fetch that feeds Sentry — proving fetch-once, feed-both.
    await waitFor(() => {
      expect(harness.mockIdentifyByEmail).toHaveBeenCalledWith('tester@example.com');
    });
  });

  it('emits App Opened on mount and Screen Viewed once for the current route (no per-render churn)', async () => {
    const harness = setupLayoutHarness();
    render(React.createElement(harness.RootLayout));
    await act(async () => {
      await flushPromises();
    });

    expect(harness.mockTrackingAppOpened).toHaveBeenCalled();
    // useSegments() is mocked to ['(tabs)'] → joined route name.
    expect(harness.mockTrackingScreenViewed).toHaveBeenCalledWith('(tabs)');
    // The screen-view effect keys on the joined route NAME, not the segments
    // array reference, so it fires once per real route despite re-renders
    // (loading→paired) handing back fresh arrays.
    expect(harness.mockTrackingScreenViewed).toHaveBeenCalledTimes(1);
  });
});
