// NOTE: Node-portable module intentionally shared with `cloud-service` (which
// imports it from `../../src/main/analytics`). It has zero hard Electron deps —
// the `src/main/` location is historical, not a layering boundary. The
// cloud→main import here is sanctioned (see docs/plans/260612_cloud-analytics-monitoring/PLAN.md
// Refactor Assessment), not a violation. Do NOT add Electron/RN-only imports —
// the RudderStack Node SDK must never leak into the mobile/RN bundle graph.
import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { randomUUID } from 'node:crypto';
import Analytics from '@rudderstack/rudder-sdk-node';
import { resolveConfigSecret } from './runtimeConfig';
import { getAppVersion } from './utils/dataPaths';
import type { AnalyticsConfigState, AnalyticsStatusPayload } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { getPlatformConfig } from '@core/platform';
import { getSettings } from '@core/services/settingsStore';
/* eslint-disable no-console -- analytics init: runs before structured logger */

const log = createScopedLogger({ component: 'analytics' });

/**
 * Check if analytics is disabled via DISABLE_ANALYTICS environment variable.
 * Accepts 'true' or '1' (case-insensitive).
 * This check takes precedence over RudderStack credentials.
 */
export const isAnalyticsDisabledByEnv = (): boolean => {
  const value = process.env.DISABLE_ANALYTICS?.trim().toLowerCase();
  if (!value) return false;
  return value === 'true' || value === '1';
};

let _analyticsStore: KeyValueStore<{ anonymousId: string }> | null = null;
const getAnalyticsStore = () => _analyticsStore ??= createStore<{ anonymousId: string }>({
  name: 'analytics-storage',
  defaults: { anonymousId: '' }
});

/**
 * Whether telemetry (and therefore the analytics anonymous-ID identity
 * side-effect) is permitted on this build (B6.a / Stage 3a — Ambient Behaviors:
 * "identity side-effects must NOT start in OSS-off").
 *
 * - Enterprise (`isOss === false`): always permitted — behaviour byte-for-byte
 *   unchanged from before the gate.
 * - OSS build: permitted ONLY when the user has explicitly opted in
 *   (`settings.telemetry.enabled === true`). This is the same gate decision
 *   `resolveRudderCreds()` uses, so the anon-ID lifecycle tracks RudderStack
 *   init: no client in OSS-off ⇒ no anon-ID created/persisted.
 *
 * Fails closed (returns `false`) if platform config / settings are not yet
 * wired — the safe direction for a privacy gate.
 */
const isTelemetryPermitted = (): boolean => {
  let isOss = false;
  try {
    isOss = getPlatformConfig().isOss;
  } catch {
    return false;
  }
  if (!isOss) {
    return true;
  }
  try {
    return getSettings().telemetry?.enabled === true;
  } catch {
    return false;
  }
};

/**
 * Resolve the analytics anonymous ID, creating + persisting one on first use.
 *
 * In an OSS build with telemetry opt-in OFF this returns `''` and creates /
 * persists NOTHING — the identity side-effect (anonymous-ID generation +
 * `analytics-storage` write) never starts, per the no-phone-home invariant.
 * Every consumer either feeds the value into a telemetry event (dropped when no
 * client exists in OSS-off) or treats an empty/absent ID as "no ID"; no
 * non-telemetry consumer relies on the ID existing. Enterprise behaviour is
 * unchanged (always permitted ⇒ always generates/persists as before).
 */
export function getOrGenerateAnonymousId(): string {
  if (!isTelemetryPermitted()) {
    return '';
  }
  let id = getAnalyticsStore().get('anonymousId');
  if (!id) {
    id = randomUUID();
    getAnalyticsStore().set('anonymousId', id);
  }
  return id;
}

/**
 * Resolve RudderStack credentials under the OSS no-phone-home gate (B6.a).
 *
 * - Enterprise (`isOss === false`): read env / app-config exactly as before via
 *   `resolveConfigSecret`.
 * - OSS build: read EXCLUSIVELY from `settings.telemetry`, and ONLY when
 *   telemetry is explicitly enabled. Never falls back to env / app-config —
 *   an OSS build never phones home to Mindstone's RudderStack. When telemetry
 *   is off or creds are absent, returns `{}` so `initAnalytics()` short-circuits
 *   BEFORE `new Analytics(...)` / `performConfigCheckProbe()`.
 *
 * Called at `initAnalytics()` time (not module-eval) so the platform config +
 * settings store are wired.
 */
const resolveRudderCreds = (): { writeKey?: string; dataPlaneUrl?: string } => {
  const isOss = getPlatformConfig().isOss;
  if (!isOss) {
    return {
      writeKey: resolveConfigSecret({
        path: ['analytics', 'rudderstack', 'writeKey'],
        envVar: 'RUDDERSTACK_WRITE_KEY'
      }),
      dataPlaneUrl: resolveConfigSecret({
        path: ['analytics', 'rudderstack', 'dataPlaneUrl'],
        envVar: 'RUDDERSTACK_DATA_PLANE_URL'
      })
    };
  }
  let telemetry: { enabled?: boolean; rudderWriteKey?: string; rudderDataPlaneUrl?: string } | undefined;
  try {
    telemetry = getSettings().telemetry;
  } catch {
    telemetry = undefined;
  }
  if (!telemetry?.enabled) {
    return {};
  }
  const writeKey = telemetry.rudderWriteKey?.trim();
  const dataPlaneUrl = telemetry.rudderDataPlaneUrl?.trim();
  return {
    writeKey: writeKey ? writeKey : undefined,
    dataPlaneUrl: dataPlaneUrl ? dataPlaneUrl : undefined
  };
};

let analyticsState: AnalyticsConfigState = 'disabled';
let analyticsError: string | null = null;
let analyticsClient: Analytics | null = null;
let analyticsContextProvider: (() => Record<string, unknown>) | null = null;

export function setAnalyticsContextProvider(provider: (() => Record<string, unknown>) | null): void {
  analyticsContextProvider = provider;
}

// Retry configuration for config check probe
const MAX_PROBE_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 5000; // 5 seconds
let probeRetryCount = 0;
let probeRetryTimer: NodeJS.Timeout | null = null;

/**
 * Perform the config check probe with retry logic.
 * On failure, retries with exponential backoff up to MAX_PROBE_RETRIES times.
 * The client is kept alive during retries so events can still be queued.
 */
function performConfigCheckProbe(): void {
  if (!analyticsClient) return;

  const testPayload: Parameters<Analytics['track']>[0] = {
    anonymousId: getOrGenerateAnonymousId(),
    event: 'RudderStack Config Check',
    properties: {
      source: 'main-process',
      category: 'diagnostics',
      retryAttempt: probeRetryCount
    }
  };

  try {
    analyticsClient.track(testPayload, (error?: Error) => {
      if (error) {
        analyticsError = error.message || 'Unknown RudderStack error';

        if (probeRetryCount < MAX_PROBE_RETRIES) {
          // Schedule retry with exponential backoff
          const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, probeRetryCount);
          probeRetryCount++;
          log.warn(
            { error: error.message, attempt: probeRetryCount, maxAttempts: MAX_PROBE_RETRIES, nextRetryMs: delayMs },
            'RudderStack config check failed - will retry'
          );
          analyticsState = 'pending'; // Keep in pending state during retries
          probeRetryTimer = setTimeout(performConfigCheckProbe, delayMs);
        } else {
          // Max retries exceeded - mark as error but DON'T null out the client
          // This allows events to still be queued and potentially delivered
          log.error(
            { error: error.message, attempts: probeRetryCount + 1 },
            'RudderStack config check failed after max retries - analytics degraded but client kept alive'
          );
          analyticsState = 'error';
          // Note: We intentionally do NOT set analyticsClient = null here
          // Events will still be queued and may succeed if the issue is transient
        }
        return;
      }

      // Success!
      log.info({ attempts: probeRetryCount + 1 }, 'RudderStack config check passed - analytics healthy');
      analyticsState = 'healthy';
      analyticsError = null;
      probeRetryCount = 0;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    if (probeRetryCount < MAX_PROBE_RETRIES) {
      const delayMs = INITIAL_RETRY_DELAY_MS * Math.pow(2, probeRetryCount);
      probeRetryCount++;
      log.warn(
        { error: message, attempt: probeRetryCount, maxAttempts: MAX_PROBE_RETRIES, nextRetryMs: delayMs },
        'RudderStack config check threw exception - will retry'
      );
      analyticsState = 'pending';
      probeRetryTimer = setTimeout(performConfigCheckProbe, delayMs);
    } else {
      log.error(
        { error: message, stack, attempts: probeRetryCount + 1 },
        'RudderStack config check threw exception after max retries - analytics degraded'
      );
      analyticsState = 'error';
      analyticsError = message;
      // Note: We intentionally do NOT set analyticsClient = null here
    }
  }
}

// Analytics initialization deferred to initAnalytics() to ensure StoreFactory
// is wired before getOrGenerateAnonymousId() is called.
let _analyticsInitialized = false;

/**
 * Initialize analytics client. Must be called AFTER setStoreFactory() has run.
 * Safe to call multiple times (idempotent).
 */
export function initAnalytics(): void {
  if (_analyticsInitialized) return;
  _analyticsInitialized = true;

  // OSS no-phone-home gate: in an OSS build, creds come EXCLUSIVELY from
  // settings.telemetry (and only when enabled); enterprise reads env/app-config.
  // Resolved BEFORE `new Analytics(...)` / performConfigCheckProbe() so neither
  // the client nor the probe is ever constructed in an OSS-off build.
  const { writeKey: WRITE_KEY, dataPlaneUrl: DATA_PLANE_URL } = resolveRudderCreds();

  // Check DISABLE_ANALYTICS environment variable FIRST (takes precedence)
  if (isAnalyticsDisabledByEnv()) {
    log.info('Analytics disabled via DISABLE_ANALYTICS environment variable');
    analyticsState = 'disabled';
  } else if (WRITE_KEY && DATA_PLANE_URL) {
    log.info({ dataPlaneUrl: DATA_PLANE_URL }, 'Initializing RudderStack analytics');
    analyticsState = 'pending';
    // Defensive: the v2 constructor never threw on invalid config, and our v3.0.5
    // spike confirmed the same (queues events, fails on flush). But a future v3
    // patch could tighten validation — fail closed rather than crash app startup.
    try {
      analyticsClient = new Analytics(WRITE_KEY, {
        dataPlaneUrl: DATA_PLANE_URL,
        flushAt: 20,
        flushInterval: 5000,
        errorHandler: (error: Error) => {
          log.warn({ error: error?.message, stack: error?.stack }, 'RudderStack SDK error');
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      log.error(
        { error: message, stack },
        'RudderStack constructor threw - analytics permanently disabled for this session'
      );
      analyticsState = 'error';
      analyticsError = message;
      analyticsClient = null;
      return;
    }

    // Start the config check probe (with retry logic)
    performConfigCheckProbe();
  } else {
    log.info(
      { hasWriteKey: Boolean(WRITE_KEY), hasDataPlaneUrl: Boolean(DATA_PLANE_URL) },
      'RudderStack analytics disabled (missing credentials)'
    );
  }
}

type TrackPayload = Parameters<Analytics['track']>[0];
type IdentifyPayload = Parameters<Analytics['identify']>[0];

// Identity management - cache known userId for inclusion in track events
let knownUserId: string | null = null;
// Track whether we've already aliased this session (alias permanently merges profiles)
let hasAliased = false;

export const analyticsEnabled = (): boolean => analyticsState === 'healthy' && Boolean(analyticsClient);

/**
 * Whether the analytics client exists and can queue events.
 * Unlike analyticsEnabled(), this returns true during 'pending' and 'error' states
 * (where the client is alive and events will be queued for delivery).
 * Use this for fire-and-forget services that run at startup before the config
 * check probe completes.
 */
export const analyticsClientAvailable = (): boolean => Boolean(analyticsClient);

export const getAnalyticsStatus = (): AnalyticsStatusPayload => ({
  state: analyticsState,
  enabled: analyticsState === 'healthy',
  error: analyticsError
});

/**
 * Track an event in the main process.
 * Automatically includes cached userId and appVersion, unless caller provides them explicitly.
 * Events are sent if client exists, even during 'pending' or 'error' state (client stays alive for retry).
 */
export const trackMainEvent = (payload: TrackPayload): void => {
  if (!analyticsClient) {
    // Log dropped events at debug level
    log.debug({ event: payload.event, state: analyticsState }, 'Event dropped - analytics client unavailable');
    return;
  }
  // Auto-include userId if we have one cached, but don't override explicit caller-provided userId
  // Also include appVersion on all events for reliable version tracking (identify can fail silently)
  // Deep merge context to preserve any existing context fields while adding app.version
  const baseContext = (payload.context ?? {}) as Record<string, unknown>;
  const accountContext = analyticsContextProvider?.() ?? {};
  const enrichedPayload: TrackPayload = {
    ...payload,
    ...(knownUserId && !payload.userId ? { userId: knownUserId } : {}),
    // Always include anonymousId as fallback — RudderStack requires either anonymousId or userId (REBEL-V2)
    ...(!payload.anonymousId ? { anonymousId: getOrGenerateAnonymousId() } : {}),
    properties: {
      appVersion: getAppVersion(),
      ...accountContext,
      ...payload.properties // Caller can override if needed
    },
    context: {
      ...baseContext,
      app: { ...(baseContext.app as Record<string, unknown> ?? {}), version: getAppVersion() }
    }
  };

  // Warn if neither userId nor anonymousId is available (should not happen after the fallback above)
  if (!enrichedPayload.userId && !enrichedPayload.anonymousId) {
    log.warn({ event: payload.event }, 'Analytics event has no userId or anonymousId — dropping');
    return;
  }

  // Debug logging for identity verification (non-production only)
  if (process.env.NODE_ENV !== 'production' && process.env.DEBUG_ANALYTICS) {
    console.log('[analytics] track:', {
      event: enrichedPayload.event,
      anonymousId: enrichedPayload.anonymousId,
      userId: enrichedPayload.userId ?? '(none)',
      appVersion: enrichedPayload.properties?.appVersion
    });
  }

  analyticsClient.track(enrichedPayload);
};

/**
 * Identify a user in the main process. This is the single choke-point for identity management:
 * 1. Normalizes userId to lowercase
 * 2. Caches userId for subsequent track calls
 * 3. Calls alias() if not already aliased (permanently links anonymousId to userId)
 * 4. Calls underlying analytics.identify()
 */
export const identifyMainUser = (payload: IdentifyPayload): void => {
  if (!analyticsClient) {
    log.debug({ userId: payload.userId }, 'identifyMainUser skipped - no client');
    return;
  }

  // Normalize userId: trim whitespace, lowercase, treat empty string as absent
  const rawUserId = payload.userId?.trim();
  const normalizedUserId = rawUserId ? rawUserId.toLowerCase() : undefined;
  // Deep merge context to preserve any existing context fields while adding app.version
  const baseContext = (payload.context ?? {}) as Record<string, unknown>;
  const normalizedPayload = {
    ...payload,
    userId: normalizedUserId,
    context: {
      ...baseContext,
      app: { ...(baseContext.app as Record<string, unknown> ?? {}), version: getAppVersion() }
    }
  } as IdentifyPayload;

  // Extract appVersion for logging (if present in traits)
  const appVersion = (payload.traits as Record<string, unknown>)?.appVersion;

  // Cache the userId for use in subsequent track calls
  if (normalizedUserId) {
    knownUserId = normalizedUserId;

    // Alias anonymousId to userId if not already done (one-time operation per session)
    // This permanently merges the anonymous profile with the authenticated user profile
    // Only mark hasAliased=true on successful enqueue (callback without error)
    if (!hasAliased) {
      const anonymousId = getOrGenerateAnonymousId();

      // Debug logging for identity verification (non-production only)
      if (process.env.NODE_ENV !== 'production' && process.env.DEBUG_ANALYTICS) {
        console.log('[analytics] alias:', { previousId: anonymousId, userId: normalizedUserId });
      }

      analyticsClient.alias({ previousId: anonymousId, userId: normalizedUserId }, (err?: Error) => {
        if (!err) {
          hasAliased = true;
        } else {
          log.warn({ error: err.message, userId: normalizedUserId }, 'alias call failed');
        }
      });
    }
  }

  log.debug({ userId: normalizedUserId, appVersion }, 'Sending identify to RudderStack');

  analyticsClient.identify(normalizedPayload, (err?: Error) => {
    if (err) {
      log.warn({ error: err.message, userId: normalizedUserId, appVersion }, 'identify call failed');
    }
  });
};

/**
 * Clear cached userId on logout.
 * Note: Does NOT reset hasAliased - profiles are permanently merged and shouldn't re-alias.
 */
export const clearKnownUserId = (): void => {
  knownUserId = null;
};

/**
 * Get the currently cached userId (for debugging/testing).
 */
export const getKnownUserId = (): string | null => knownUserId;

export const flushMainAnalytics = async (): Promise<void> => {
  // Cancel any pending retry timer
  if (probeRetryTimer) {
    clearTimeout(probeRetryTimer);
    probeRetryTimer = null;
  }

  if (!analyticsClient) {
    return;
  }
  await analyticsClient.flush();
};