// mobile/app/_layout.tsx
// @device-scoped: queue lifecycle drain timestamps throttle local background work, not account data.

import { useEffect, useRef, useState, useMemo } from 'react';
import { View, ActivityIndicator, StyleSheet, useColorScheme, AppState, LogBox } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  useAuthStore,
  useSessionStore,
  useInboxStore,
  useStagedFilesStore,
  initAuthStore,
  EventBridge,
  onUnauthorized,
  initOfflineQueueStore,
  useOfflineQueueStore,
  createLogger,
  setLogPersistCallback,
  setLogErrorReporter,
  initPersistence,
  flushPending,
  setSessionContinuityRecorder,
} from '@rebel/cloud-client';
import { rehydrateActiveRecordingIds } from '../src/stores/activeRecordingStore';
import { secureTokenStorage } from '../src/storage/secureTokenStorage';
import { ExpoFileSystemQueueStorage } from '../src/storage/offlineQueueStorage';
import { asyncStoragePersistence } from '../src/storage/asyncStoragePersistence';
import { createRoutingConsumer } from '../src/hooks/useRoutingQueueConsumer';
import { recoverMissingMeetingChunksFromManifests } from '../src/hooks/useMeetingChunkConsumer';
import { initWidgetDataSync } from '../src/services/widgetDataSync';
import { registerWidgetBackgroundRefresh, unregisterWidgetBackgroundRefresh } from '../src/services/widgetBackgroundRefresh';
import { registerQueueBackgroundDrain, unregisterQueueBackgroundDrain } from '../src/services/queueBackgroundDrain';
import { wipeAllAccountScopedState } from '../src/services/accountScopedStateTeardown';
import { PairScreen } from '../src/screens/PairScreen';
import { ErrorBoundary } from '../src/components/ErrorBoundary';
import { SilentErrorBoundary } from '../src/components/SilentErrorBoundary';
import { ConnectivityBannerConnected } from '../src/components/ConnectivityBannerConnected';
import { ApprovalSheetProvider } from '../src/components/approval/ApprovalSheetProvider';
import NetInfo from '@react-native-community/netinfo';
import { useNetworkState } from '../src/hooks/useNetworkState';
import { NetworkContext } from '../src/context/NetworkContext';
import { MeetingRecordingProvider } from '../src/context/MeetingRecordingContext';
import { useColors, type ColorTokens } from '../src/theme/colors';
import {
  useFonts,
  Figtree_400Regular,
  Figtree_500Medium,
  Figtree_600SemiBold,
  Figtree_700Bold,
} from '@expo-google-fonts/figtree';
import { initSentry, setSentryCloudContext, setSentryUser, setSentryHealthContext, clearSentryContext, captureSentryBreadcrumb, wrapWithSentry, mobileErrorReporter } from '../src/utils/sentry';
import { getSettings } from '@rebel/cloud-client';
import { analytics, isAnalyticsPermitted } from '../src/analytics/analytics';
import { tracking, identifyByEmail, resetIdentity } from '../src/analytics/tracking';
import { syncIdentityAfterPair, clearTelemetryIdentity } from '../src/analytics/identitySync';
import { resolveAnonymousId } from '../src/analytics/anonymousId';
import { fileLogWriter, startLifecycleFlush } from '../src/utils/fileLogSink';
import { registerForPushNotifications, unregisterPushNotifications, setupNotificationListeners } from '../src/utils/pushNotifications';
import { recordQueueBreadcrumb } from '../src/utils/queueBreadcrumbs';
import { recordContinuityBreadcrumb } from '../src/utils/continuityBreadcrumbs';
import {
  buildQueueDrainLifecycleBreadcrumb,
  didDeviceRebootSince,
  estimateBootTimeMs,
  shouldRecordLifecycleBreadcrumb,
} from '../src/utils/queueLifecycleContinuity';
import { startQueueMetrics, type QueueMetricsSample } from '../src/utils/queueMetrics';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

// E2E only: in __DEV__ (Metro) builds React Native renders the LogBox warning
// notification ("! Open debugger to view warnings.") as a transparent overlay
// pinned to the bottom of the screen — directly on top of the custom tab bar.
// That overlay absorbs every touch in the tab-bar region, so automated taps
// (Maestro / XCUITest) on the mic / Type / tab buttons silently never fire
// their onPress. Release/e2e-profile builds have __DEV__ === false and no
// LogBox at all, so this is a no-op there; gating on the E2E flag keeps the
// normal dev experience (visible warnings) untouched for human developers.
if (process.env.EXPO_PUBLIC_REBEL_E2E === '1') {
  LogBox.ignoreAllLogs(true);
}

const QUEUE_LIFECYCLE_LAST_DRAIN_AT_KEY = 'rebel.queue.lifecycle.lastDrainAt';

// Initialize Sentry before anything else
initSentry();

// Bridge cloud-client's tag logger to Sentry via mobileErrorReporter.
// Must happen AFTER initSentry() and BEFORE any createLogger() call emits
// warn/error lines we want captured as breadcrumbs.
// Stage 0.4, docs/plans/260418_cloud_continuity_robustness_and_observability.md.
setLogErrorReporter(mobileErrorReporter);

// Wire file-based log persistence + lifecycle flush (background/inactive → immediate write)
setLogPersistCallback(fileLogWriter);
startLifecycleFlush();

// Initialise auth store with platform-specific secure storage
initAuthStore(secureTokenStorage);

// Initialise offline queue store with expo-file-system storage adapter
// and the real queue consumers.
const queueLog = createLogger('offlineQueueInit');

try {
  initOfflineQueueStore(new ExpoFileSystemQueueStorage(), createRoutingConsumer(), {
    jitterMs: 2000,
    onTransition: recordQueueBreadcrumb,
  });
} catch (err) {
  // Graceful degradation: if queue init fails, online voice still works
  queueLog.error('Failed to initialise offline queue store', {
    error: err instanceof Error ? err.message : String(err),
  });
}

// Initialise persistence adapter for cloud-client stores
initPersistence(asyncStoragePersistence);

// Bridge cloud-client session continuity transitions to the mobile breadcrumb recorder.
if (typeof setSessionContinuityRecorder === 'function') {
  setSessionContinuityRecorder(recordContinuityBreadcrumb);
}

// Global safety net for JS-level errors. This cannot prevent native SIGABRT
// crashes (those are mitigated by deferred cleanup in useAgentTurn/useEventChannel),
// but catches uncaught JS exceptions and reports non-fatal ones to Sentry
// instead of showing the red error screen.
interface RNErrorUtils {
  getGlobalHandler: () => (error: Error, isFatal: boolean) => void;
  setGlobalHandler: (handler: (error: Error, isFatal: boolean) => void) => void;
}
const errorUtils = (global as unknown as { ErrorUtils?: RNErrorUtils }).ErrorUtils;
if (errorUtils?.getGlobalHandler && errorUtils?.setGlobalHandler) {
  const defaultHandler = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error: Error, isFatal: boolean) => {
    mobileErrorReporter.captureException(error, { extra: { isFatal, source: 'globalErrorHandler' } });
    if (!isFatal) return;
    defaultHandler(error, isFatal);
  });
}

function createStyles(colors: ColorTokens) {
  return StyleSheet.create({
    container: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background },
  });
}

function RootLayout() {
  const { isPaired, credentialsResolved, loadCredentials } = useAuthStore();
  const [isLoading, setIsLoading] = useState(true);
  const widgetSyncUnsubscribeRef = useRef<(() => void) | null>(null);
  // Tracks the previous paired state so analytics emits Unpaired ONLY on a real
  // pair→unpair transition, never on the initial unpaired mount.
  const prevPairedRef = useRef<boolean | null>(null);
  // Monotonic pairing generation. Bumped on every pair/unpair transition so the
  // async identify continuation can detect that auth state changed mid-fetch
  // (e.g. a 401/unpair landed while getSettings() was in flight) and bail before
  // applying a stale identity. Guards GPT F2.
  const pairGenerationRef = useRef(0);
  const colors = useColors();
  const colorScheme = useColorScheme();
  const ls = useMemo(() => createStyles(colors), [colors]);
  const statusBarStyle = colorScheme === 'light' ? 'dark' : 'light';
  const { isOnline, isInternetReachable, isConnected } = useNetworkState();
  const networkContextValue = useMemo(() => ({ isOnline, isInternetReachable, isConnected }), [isOnline, isInternetReachable, isConnected]);
  // Current expo-router segments — read once here (referenced by the analytics
  // screen-view effect and the e2e-route gate below).
  const routeSegments = useSegments();

  // Load Figtree font family (matching desktop). Falls back to system fonts
  // (San Francisco / Roboto) if loading fails, so the app remains fully usable.
  const [fontsLoaded, fontError] = useFonts({
    Figtree_400Regular,
    Figtree_500Medium,
    Figtree_600SemiBold,
    Figtree_700Bold,
  });

  // Report font loading errors but don't block the app
  useEffect(() => {
    if (fontError) {
      mobileErrorReporter.captureException(fontError, { extra: { source: 'fontLoading' } });
    }
  }, [fontError]);

  // Initialise the offline queue (load persisted items, recover stale processing items).
  // Recovery sweep is deferred until after bindAuthIdentity in loadCredentialsAndHydrateStores.
  useEffect(() => {
    try {
      useOfflineQueueStore.getState().init().catch((err) => {
        queueLog.error('Queue init failed at startup', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch {
      // Store not initialised (graceful degradation)
    }
  }, []);

  // Crash recovery for active meeting recording IDs.
  useEffect(() => {
    void rehydrateActiveRecordingIds();
  }, []);

  useEffect(() => {
    // Auto-unpair on 401 from any API call — store creds before unpair clears them.
    // NOTE: We intentionally do NOT clear the offline queue here. Queued items are
    // tagged with boundCloudUrl so they cannot drain against a different account.
    // When the user re-pairs to the same cloudUrl, items resume automatically.
    onUnauthorized(() => {
      const { cloudUrl, token } = useAuthStore.getState();
      if (cloudUrl && token) unregisterPushNotifications(cloudUrl, token);
      // Telemetry-identity teardown is NOT done here. Account teardown below
      // flips `isPaired` to false, and the unified `[isPaired]` effect runs the
      // SINGLE ordered chokepoint: emit `Unpaired` (guarded by prevPairedRef so
      // it fires once, only on a real pair→unpair) then
      // clearTelemetryIdentity({ clearSentryContext, resetIdentity }). Clearing
      // Sentry directly here would clear it out of order (before `Unpaired`,
      // before analytics resetIdentity) AND double-clear when the effect runs —
      // exactly the set/clear drift DA #1 exists to prevent (GPT F1).

      const clearPersistenceAndUnpair = async () => {
        await wipeAllAccountScopedState(cloudUrl, {
          reason: 'unauthorized',
          clearOfflineQueue: false,
          widgetSyncUnsubscribe: () => {
            widgetSyncUnsubscribeRef.current?.();
            widgetSyncUnsubscribeRef.current = null;
          },
        });
      };
      void clearPersistenceAndUnpair();
    });

    const loadCredentialsAndHydrateStores = async () => {
      await loadCredentials();

      const { isPaired: paired, cloudUrl } = useAuthStore.getState();
      if (!paired || !cloudUrl) return;

      // Bind auth identity so queued items for this account can drain
      try {
        useOfflineQueueStore.getState().bindAuthIdentity(cloudUrl);
      } catch {
        // Store not initialised — will bind later
      }

      await Promise.all([
        useSessionStore.getState().hydrate(cloudUrl),
        useInboxStore.getState().hydrate(cloudUrl),
      ]);

      widgetSyncUnsubscribeRef.current?.();
      widgetSyncUnsubscribeRef.current = initWidgetDataSync() ?? null;

      // Recovery sweep AFTER bindAuthIdentity — recovered chunks get correct auth identity
      try {
        const recovered = await recoverMissingMeetingChunksFromManifests();
        if (recovered > 0) {
          queueLog.info('Recovered meeting chunks after auth bind', { recoveredCount: recovered });
        }
        // Trigger drain with reachability-aware connectivity check
        const netState = await NetInfo.fetch().catch(() => null);
        const startupIsOnline = (netState?.isConnected ?? true) && (netState?.isInternetReachable ?? true);
        const now = Date.now();
        const previousDrainAtRaw = await AsyncStorage.getItem(QUEUE_LIFECYCLE_LAST_DRAIN_AT_KEY).catch(() => null);
        const previousDrainAt = previousDrainAtRaw ? Number(previousDrainAtRaw) : null;
        const bootTimeMs = estimateBootTimeMs(now);
        if (
          didDeviceRebootSince(Number.isFinite(previousDrainAt) ? previousDrainAt : null, bootTimeMs)
          && shouldRecordLifecycleBreadcrumb({
            reason: 'lifecycle-resume-post-reboot',
            cloudUrl,
            now,
          })
        ) {
          recordContinuityBreadcrumb(
            buildQueueDrainLifecycleBreadcrumb({
              reason: 'lifecycle-resume-post-reboot',
              direction: 'mobile-startup',
              cloudUrl,
              online: startupIsOnline,
            }),
          );
        }
        await AsyncStorage.setItem(QUEUE_LIFECYCLE_LAST_DRAIN_AT_KEY, String(now)).catch(() => {});
        await useOfflineQueueStore.getState().drain(startupIsOnline);
      } catch (err) {
        queueLog.warn('Meeting chunk recovery sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };

    loadCredentialsAndHydrateStores().finally(() => setIsLoading(false));
  }, [loadCredentials]);

  // Analytics: initialise at APP LAUNCH (not on pairing), gated only on the
  // always-on `isAnalyticsPermitted()` chokepoint (creds present + kill-switch
  // off). Analytics is always-on and emits anonymously (the shared
  // rebel_client_id anonymousId) from launch; PAIRING governs IDENTITY ONLY.
  // Initialising here — before pairing — is what lets the pairing funnel
  // (Pair Started/Succeeded/Failed, emitted in PairScreen while still unpaired)
  // actually reach the SDK rather than being eaten by a post-pair gate.
  // `init()` is idempotent + memoised, so this fires at most one real setup.
  // Fire-and-forget is fine here; the paired-identity effect awaits init()
  // before identifying (the only ordering that matters).
  useEffect(() => {
    if (isAnalyticsPermitted()) {
      void analytics.init();
    }
  }, []);

  // Set Sentry context, register push token, and bind auth identity when paired
  useEffect(() => {
    // Bump the pairing generation on every paired/unpaired transition. The
    // async identity continuation captures the value at its start and re-checks
    // it before applying identity, so any later transition (incl. a 401/unpair)
    // invalidates an in-flight identity apply (GPT F2).
    pairGenerationRef.current += 1;
    if (isPaired) {
      const { cloudUrl, token } = useAuthStore.getState();
      if (cloudUrl) {
        setSentryCloudContext(cloudUrl);
        setSentryHealthContext({ paired: true, online: isOnline });
        // Capture the pairing generation for THIS paired transition. The async
        // identity continuation below re-reads it before applying identity and
        // bails if it changed (a 401/unpair landed mid-fetch) — see GPT F2.
        const generationAtPair = pairGenerationRef.current;
        // Identified error monitoring + analytics identity (both match desktop).
        // Email is fetched ONCE from the already-available cloud settings and fed
        // to BOTH Sentry's PII-managed user channel AND analytics identify —
        // never logged at info level, never put in analytics event props/tags
        // (the singleton's identify uses email as the userId, not a track prop).
        // Graceful degradation: if the desktop hasn't set an email yet, Sentry
        // user stays null and analytics stays anonymousId-only; we record an
        // observable breadcrumb (silent-failure rule).
        // Serialise behind analytics init (so identify isn't dropped by the
        // `enabled` gate) and guard against a stale generation (so a 401/unpair
        // mid-fetch can't apply the wrong identity). Logic lives in the
        // unit-tested `syncIdentityAfterPair` helper (GPT F2).
        void syncIdentityAfterPair({
          whenReady: analytics.whenReady,
          getSettings,
          // Resolve the shared rebel_client_id so Sentry always has an anon `id`
          // fallback (matching desktop + analytics' anonymousId) even without an
          // email (GPT F4).
          resolveAnonId: () => resolveAnonymousId(),
          currentGeneration: () => pairGenerationRef.current,
          capturedGeneration: generationAtPair,
          setSentryUser,
          identifyByEmail,
          breadcrumb: captureSentryBreadcrumb,
        });
        if (token) registerForPushNotifications(cloudUrl, token);
        // Bind auth identity on pair so queued items resume draining
        try {
          useOfflineQueueStore.getState().bindAuthIdentity(cloudUrl);
          // Re-trigger drain so items resume immediately on re-pair
          void useOfflineQueueStore.getState().drain(isOnline);
        } catch {
          // Store not initialised
        }
      }
    } else {
      // Analytics: emit Unpaired only on a real pair→unpair transition (not on
      // the initial unpaired mount), while still identified — BEFORE the identity
      // clear below.
      if (prevPairedRef.current === true) {
        tracking.pair.unpaired();
      }
      // Single telemetry-identity CLEAR chokepoint (DA #1): fans the clear out to
      // BOTH Sentry and analytics so the set path (syncIdentityAfterPair) and the
      // clear path can't drift. Analytics REMAINS enabled and keeps emitting
      // ANONYMOUSLY (always-on) — reset() preserves the shared rebel_client_id
      // anonymousId. We do NOT disable analytics on unpair.
      clearTelemetryIdentity({ clearSentryContext, resetIdentity });
      setSentryHealthContext({ paired: false, online: isOnline });
      const { cloudUrl, token } = useAuthStore.getState();
      if (cloudUrl && token) unregisterPushNotifications(cloudUrl, token);
      // Unbind auth identity on unpair
      try {
        useOfflineQueueStore.getState().bindAuthIdentity(null);
      } catch {
        // Store not initialised
      }
    }
    prevPairedRef.current = isPaired;
  }, [isPaired]);

  // Cleanup widget sync subscription when auth is cleared. Initial subscription
  // starts at the end of loadCredentialsAndHydrateStores, after hydration resolves.
  useEffect(() => {
    if (isPaired) return;
    widgetSyncUnsubscribeRef.current?.();
    widgetSyncUnsubscribeRef.current = null;
  }, [isPaired]);

  // Register iOS background refresh so the widget stays current without the
  // user opening the app. iOS schedules BGAppRefreshTask at its discretion
  // (typically 15-60 min). See docs/plans/260414_widget_background_refresh.md.
  useEffect(() => {
    if (!isPaired) return;
    void registerWidgetBackgroundRefresh();
    return () => { void unregisterWidgetBackgroundRefresh(); };
  }, [isPaired]);

  // Register background drain for the offline queue (I-NBU, Stage 3).
  // Wakes us periodically to flush idempotent `meeting-chunk` items that
  // were queued while offline. See docs/plans/260417_mobile_offline_deferred_followups.md.
  useEffect(() => {
    if (!isPaired) return;
    void registerQueueBackgroundDrain();
    return () => { void unregisterQueueBackgroundDrain(); };
  }, [isPaired]);

  // Handle notification taps
  useEffect(() => {
    return setupNotificationListeners();
  }, []);

  // Analytics: emit App Opened once on cold start. Subsequent
  // background→foreground transitions are emitted by the AppState listener
  // above. Analytics inits at launch (always-on), so this lands once setup
  // completes; if creds are absent the gate drops it (acceptable).
  useEffect(() => {
    tracking.appOpened();
  }, []);

  // Analytics: single screen-view emitter at the router level (not per-screen).
  // Emits Screen Viewed on each route change with a non-PII route NAME (the
  // joined expo-router segments, e.g. "(tabs)/inbox"), never route params or
  // content. Depends on the joined NAME (a string), not the segments array
  // reference, so it fires once per real route change rather than on every
  // re-render (expo-router may hand back a fresh array each render). Emits once
  // analytics initialises at launch (always-on).
  const routeName = routeSegments.join('/');
  useEffect(() => {
    if (routeName) {
      tracking.screenViewed(routeName);
    }
  }, [routeName]);

  // Refresh sessions, inbox, and current session when app returns to foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'background' || nextState === 'inactive') {
        void flushPending();
        // Analytics: hand-emitted lifecycle (RudderStack auto lifecycle events
        // are disabled). Emit App Backgrounded and flush the analytics batch so
        // a cold kill doesn't drop queued events. Both are no-ops until enabled.
        tracking.appBackgrounded();
        analytics.flush();
        return;
      }
      if (nextState !== 'active') return;
      // Analytics: app returned to the foreground. App Opened on cold start is
      // emitted by the mount effect below; this covers background→foreground.
      tracking.appOpened();
      // If secure storage was transiently unavailable on cold start (e.g. iOS
      // Keychain right after an app update), credentialsResolved stays false
      // and the user sees the splash. Retry now that the app is foregrounded
      // so we can produce a definitive answer instead of silently dropping
      // them into the pairing flow.
      if (!useAuthStore.getState().credentialsResolved) {
        void useAuthStore.getState().loadCredentials();
        return;
      }
      if (!useAuthStore.getState().isPaired) return;
      // Force-reconnect event channel on foreground to minimize stale-data window
      useSessionStore.getState().forceEventReconnect?.();
      const store = useSessionStore.getState();
      store.fetchSessions(store._lastFetchOptions);
      if (store.currentSession) {
        store.fetchSession(store.currentSession.id);
      }
      useInboxStore.getState().fetchInbox();
      useStagedFilesStore.getState().fetchStagedFiles();
      // Trigger offline queue drain on foreground (connectivity may have restored while backgrounded)
      try {
        const cloudUrl = useAuthStore.getState().cloudUrl;
        const now = Date.now();
        if (shouldRecordLifecycleBreadcrumb({ reason: 'lifecycle-drain-foreground', cloudUrl, now })) {
          recordContinuityBreadcrumb(
            buildQueueDrainLifecycleBreadcrumb({
              reason: 'lifecycle-drain-foreground',
              direction: 'mobile-foreground',
              cloudUrl,
              online: isOnline,
            }),
          );
        }
        void AsyncStorage.setItem(QUEUE_LIFECYCLE_LAST_DRAIN_AT_KEY, String(now)).catch(() => {});
        useOfflineQueueStore.getState().drain(isOnline);
      } catch {
        // Store not initialised — skip drain
      }
    });
    return () => sub.remove();
  }, [isOnline]);

  // Force-reconnect event channel and drain offline queue when network connectivity is restored
  const prevOnlineRef = useRef(isOnline);
  useEffect(() => {
    if (isOnline && !prevOnlineRef.current) {
      // Connectivity restored — force immediate event channel reconnect
      useSessionStore.getState().forceEventReconnect?.();
      // Refresh all data on reconnect (matches foreground handler)
      const store = useSessionStore.getState();
      store.fetchSessions(store._lastFetchOptions);
      if (store.currentSession) {
        store.fetchSession(store.currentSession.id);
      }
      useInboxStore.getState().fetchInbox();
      useStagedFilesStore.getState().fetchStagedFiles();
      // Drain offline queue now that we're back online
      try {
        useOfflineQueueStore.getState().drain(true);
      } catch {
        // Store not initialised — skip drain
      }
    }
    prevOnlineRef.current = isOnline;
  }, [isOnline]);

  // Periodic drain timer (60s): triggers drain when online AND queue has items.
  // Acts as a safety net for items that failed transiently and are due for retry.
  useEffect(() => {
    if (!isOnline) return;

    const PERIODIC_DRAIN_INTERVAL_MS = 60_000;
    const timer = setInterval(() => {
      try {
        const state = useOfflineQueueStore.getState();
        if (state.items.length > 0) {
          state.drain(true);
        }
      } catch {
        // Store not initialised — skip drain
      }
    }, PERIODIC_DRAIN_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [isOnline]);

  // Queue metrics: emit a structured log sample every 60s while the queue
  // is non-idle and the app is foregrounded. Silent when idle or backgrounded.
  // This is operational observability — dashboards tail these logs to answer
  // questions like "how long are items sitting in the queue right now?".
  useEffect(() => {
    const metricsLog = createLogger('queueMetrics');
    const emit = (sample: QueueMetricsSample) => {
      metricsLog.info('queue_metrics_sample', sample as unknown as Record<string, unknown>);
    };
    const metrics = startQueueMetrics({
      getSnapshot: () => {
        try {
          const s = useOfflineQueueStore.getState();
          return {
            items: s.items,
            queueFullAt: s.queueFullAt ?? null,
            limitedConnectivityAt: s.limitedConnectivityAt ?? null,
            authExpiredAt: s.authExpiredAt ?? null,
            boundCloudUrl: s.boundCloudUrl ?? null,
          };
        } catch {
          return undefined;
        }
      },
      getAppState: () => AppState.currentState,
      intervalMs: 60_000,
      emit,
    });
    // eslint-disable-next-line rebel-native-cleanup/no-undeferred-native-cleanup -- metrics.stop() is a pure clearInterval (JS timer), not a native/TurboModule teardown, so it is safe synchronously in cleanup.
    return () => metrics.stop();
  }, []);

  // E2E-only escape hatch: when the test-mode flag is on AND the active route is
  // the `(e2e)` group (e.g. the `rebel://e2e/pair` deep link mapped to
  // `/(e2e)/pair`), let the router outlet render even while unpaired — otherwise
  // the `!isPaired` branch below returns <PairScreen/> and the e2e pairing route
  // can never mount (the very state it exists to leave). Inert in production:
  // `EXPO_PUBLIC_REBEL_E2E` is only '1' in the e2e build profile.
  // (`routeSegments` is declared at the top of the component.)
  const isE2eRoute =
    process.env.EXPO_PUBLIC_REBEL_E2E === '1' && routeSegments[0] === '(e2e)';

  // Show loading state while auth credentials or fonts are being loaded,
  // or while secure storage has not yet given a definitive answer about
  // whether credentials exist (e.g. transient iOS Keychain unavailability
  // immediately after an app update). Treating "unknown" as "not paired"
  // would silently surface the pairing flow to an already-paired user.
  // Font errors are non-blocking — the app falls back to system fonts.
  // GestureHandlerRootView must wrap EVERY branch, not just the paired tree.
  // react-native-gesture-handler throws "must be used as a descendant of
  // GestureHandlerRootView" if any gesture component mounts outside it
  // (REBEL-170). The loading + unpaired (PairScreen) branches previously
  // rendered outside the root, so a gesture component on those screens crashed
  // pre-pair. Hoisting the root here makes the invariant hold by construction.
  if (isLoading || !credentialsResolved || (!fontsLoaded && !fontError)) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <NetworkContext.Provider value={networkContextValue}>
          <View style={ls.container}>
            <StatusBar style={statusBarStyle} />
            <ActivityIndicator color={colors.accent} size="large" />
          </View>
        </NetworkContext.Provider>
      </GestureHandlerRootView>
    );
  }

  if (!isPaired) {
    return (
      <GestureHandlerRootView style={{ flex: 1 }}>
        <NetworkContext.Provider value={networkContextValue}>
          <>
            <StatusBar style={statusBarStyle} />
            {isE2eRoute ? (
              // Let the (e2e)/pair route mount + drive pairing; once it calls
              // pair() successfully, isPaired flips and the real app renders.
              <Stack screenOptions={{ headerShown: false }} />
            ) : (
              <PairScreen />
            )}
          </>
        </NetworkContext.Provider>
      </GestureHandlerRootView>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <NetworkContext.Provider value={networkContextValue}>
        <>
          <StatusBar style={statusBarStyle} />
          <EventBridge />
          {/* Silent boundary: banner never crashes the app shell. */}
          <SilentErrorBoundary boundaryName="ConnectivityBanner">
            <ConnectivityBannerConnected />
          </SilentErrorBoundary>
          <ErrorBoundary>
            <MeetingRecordingProvider>
              {/* F-D-R2-8 — ApprovalSheetProvider lives at root so
                  descendants (inbox, conversation banner, etc.) can open
                  approval detail sheets via `useApprovalSheet()`. */}
              <ApprovalSheetProvider>
                <Stack screenOptions={{ headerShown: false }}>
                  <Stack.Screen name="(tabs)" />
                  <Stack.Screen
                    name="conversation/[id]"
                    options={{
                      presentation: 'card',
                      animation: 'fade_from_bottom',
                    }}
                  />
                  <Stack.Screen name="meeting-recording" options={{ presentation: 'card', headerShown: false }} />
                </Stack>
              </ApprovalSheetProvider>
            </MeetingRecordingProvider>
          </ErrorBoundary>
        </>
      </NetworkContext.Provider>
    </GestureHandlerRootView>
  );
}

export default wrapWithSentry(RootLayout);
