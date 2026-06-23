import { captureRendererMessage, captureRendererException } from './sentry';
import { rendererIsOss } from './rendererIsOss';
import type { AnalyticsAttributionProperties } from '@shared/trackingTypes';
/* eslint-disable no-console -- analytics init: runs before structured logger */

const DISABLED_SENTINEL = 'DISABLED';

// =============================================================================
// RudderStack client surface (local structural types)
// =============================================================================
//
// The `@rudderstack/analytics-js` package (Elastic-2.0) is NOT imported at the
// top level — not even as `import type`. A top-level `import type { … } from
// '@rudderstack/analytics-js'` is flagged build-breaking by the mirror-mode
// parity check's static-import regex (see Decision Log 2026-06-18 15:30), and a
// value import would statically pin the Elastic-2.0 code into every renderer
// bundle. Instead we declare a LOCAL structural interface covering exactly the
// methods this module calls, and load the real constructor via a guarded,
// brace-nested dynamic import (commercial only — the OSS cred gate returns
// first; OSS Vite aliases the specifier to a no-op stub). The package specifier
// therefore appears ONLY inside the brace-nested dynamic-import call in
// loadRudderConstructor() below, which mirror-mode treats as an informational
// (allowed) reference rather than a build-breaking static/top-level import.
//
// Keep this surface in lockstep with `src/renderer/src/oss/rudderstack-analytics-stub.ts`.
interface RudderAnalyticsClient {
  load(writeKey: string, dataPlaneUrl: string, options?: unknown): void;
  ready(callback: () => void): void;
  track(...args: unknown[]): void;
  identify(...args: unknown[]): void;
  alias(newId: string, previousId?: string): void;
  setAnonymousId(id: string): void;
}

type RudderAnalyticsCtor = new () => RudderAnalyticsClient;

// =============================================================================
// Health State Machine
// =============================================================================

const READY_TIMEOUT_MS = 30_000;

let analyticsHealth: { state: 'disabled' | 'pending' | 'healthy' | 'error'; error: string | null } = {
  state: 'disabled',
  error: null,
};
let readyTimeoutId: ReturnType<typeof setTimeout> | undefined;

/** Set of error class keys already reported to Sentry (rate-limit: one per class). */
const reportedErrorClasses = new Set<string>();

// Get the ID and email from the preload bridge (guarded for SSR/test environments)
const MAIN_PROCESS_ANONYMOUS_ID =
  typeof window !== 'undefined' ? window.electronEnv?.anonymousId ?? null : null;
const PRELOAD_USER_EMAIL =
  typeof window !== 'undefined' ? window.electronEnv?.userEmail ?? null : null;

let initialized = false;
let enabled = false;
let rudderClient: RudderAnalyticsClient | null = null;
let identifiedEmail: string | null = null;
let hasAliased = false;
let accountContext: AnalyticsAttributionProperties = {};

// Cached RudderStack constructor + the in-flight load promise. The Elastic-2.0
// SDK is code-split behind a guarded dynamic import() so it never enters the
// renderer's STATIC graph (and is aliased to a no-op stub in OSS builds). The
// import runs at most once; concurrent/repeat init() calls share `initPromise`
// (single-flight), so this loader is only ever invoked once per process anyway.
let RudderAnalyticsCtor: RudderAnalyticsCtor | null = null;

async function loadRudderConstructor(): Promise<void> {
  if (RudderAnalyticsCtor) {
    return;
  }
  // Brace-nested dynamic import (NOT top-level): mirror-mode parity treats this
  // as informational, and it only runs AFTER the cred gate passes in init().
  const mod = await import('@rudderstack/analytics-js');
  RudderAnalyticsCtor = mod.RudderAnalytics as unknown as RudderAnalyticsCtor;
}

// Single-flight init promise (F2). Concurrent/repeat init() calls share this one
// promise so the dynamic import + new ctor() + load() happen at most once.
let initPromise: Promise<void> | null = null;

// `enabling` is set synchronously in the commercial path AFTER the cred gate
// passes but BEFORE the `await import()` — so track() calls made synchronously
// after init() (e.g. main.tsx's `track('Renderer Boot')`) are buffered rather
// than dropped while the SDK loads. In OSS / disabled builds the cred gate
// returns first, `enabling` is never set, and behaviour is an unchanged no-op.
let enabling = false;

// Bounded pre-ready buffer for track() ONLY (decided 90/10 — the only
// synchronous-after-init caller is main.tsx's boot event). identify()/alias()
// have no synchronous-before-settle caller and buffering them would entangle the
// hasAliased / identifiedEmail ordering, so they keep today's `!enabled`
// early-return (unbuffered). Bounded + drop-oldest so a wedged import can't grow
// it without limit (modelled on mobile/src/analytics/analytics.ts).
const PENDING_TRACK_CAP = 50;
let pendingTrackEvents: Array<() => void> = [];

function dropPendingTrackEvents(): void {
  pendingTrackEvents = [];
}

/**
 * Capture an analytics error to Sentry, rate-limited to the first occurrence
 * of each error class (context + error constructor name).
 */
function captureAnalyticsError(error: unknown, context: string): void {
  const key = `${context}:${error instanceof Error ? error.constructor.name : 'unknown'}`;
  if (reportedErrorClasses.has(key)) return;
  reportedErrorClasses.add(key);
  captureRendererException(error instanceof Error ? error : new Error(String(error)), {
    tags: { analyticsContext: context },
  });
}

/**
 * Push the current renderer analytics health to the main process via IPC.
 * Fire-and-forget — errors are silently swallowed.
 */
function pushHealthToMain(): void {
  try {
    window.miscApi?.rendererHealth?.(getRendererAnalyticsHealth());
  } catch {
    // Ignore — IPC may not be ready yet during early init
  }
}

/**
 * Get the current renderer analytics health state for diagnostics.
 */
export function getRendererAnalyticsHealth(): {
  state: 'disabled' | 'pending' | 'healthy' | 'error';
  enabled: boolean;
  error: string | null;
  hasKnownUserId: boolean;
} {
  return {
    state: analyticsHealth.state,
    enabled,
    error: analyticsHealth.error,
    hasKnownUserId: identifiedEmail !== null,
  };
}

const isRealValue = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== DISABLED_SENTINEL;
};

// Normalize email for consistent identity across platforms
// Only apply to emails, not arbitrary userIds (to avoid changing anonymousId format)
const normalizeEmail = (email: string | null | undefined): string | null => {
  if (!email) return null;
  return email.toLowerCase().trim();
};

const lookupRuntimeConfig = (keys: string[]): unknown => {
  let current: unknown = window.electronEnv?.runtimeConfig ?? null;
  for (const key of keys) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current ?? undefined;
};

const resolveSecret = (keys: string[]): string | undefined => {
  const candidate = lookupRuntimeConfig(keys);
  return isRealValue(candidate) ? candidate : undefined;
};

/**
 * Resolve RudderStack creds under the OSS no-phone-home gate (B6.a).
 *
 * - Enterprise (`rendererIsOss() === false`): read from `runtimeConfig`
 *   (app-config / env) exactly as before via `resolveSecret`.
 * - OSS build: read EXCLUSIVELY from the LOCAL_ONLY `electronEnv.telemetryConfig`
 *   bridge, and ONLY when telemetry is enabled — NEVER from `runtimeConfig`/env.
 *   Returns `{}` when off/absent so `init()` short-circuits BEFORE
 *   `new RudderAnalytics()` / `client.load()` / the ready() timeout.
 */
const resolveRudderCreds = (): { writeKey?: string; dataPlaneUrl?: string } => {
  if (!rendererIsOss()) {
    return {
      writeKey: resolveSecret(['analytics', 'rudderstack', 'writeKey']),
      dataPlaneUrl: resolveSecret(['analytics', 'rudderstack', 'dataPlaneUrl'])
    };
  }
  const raw = typeof window !== 'undefined' ? window.electronEnv?.telemetryConfig : null;
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  if (obj.enabled !== true) {
    return {};
  }
  const writeKey = typeof obj.rudderWriteKey === 'string' ? obj.rudderWriteKey.trim() : '';
  const dataPlaneUrl = typeof obj.rudderDataPlaneUrl === 'string' ? obj.rudderDataPlaneUrl.trim() : '';
  return {
    writeKey: writeKey ? writeKey : undefined,
    dataPlaneUrl: dataPlaneUrl ? dataPlaneUrl : undefined
  };
};

// Synchronous (invariant #5): reads the already-loaded, cached ctor. Only ever
// reached AFTER init()'s `await loadRudderConstructor()` has populated it (the
// commercial enabled path), so the `!RudderAnalyticsCtor` branch is defensive.
const getRudderClient = (): RudderAnalyticsClient => {
  if (!RudderAnalyticsCtor) {
    throw new Error('RudderStack constructor not loaded — getRudderClient() called before init() resolved');
  }
  if (!rudderClient) {
    rudderClient = new RudderAnalyticsCtor();
  }
  return rudderClient;
};

export const analytics = {
  /**
   * Initialise the renderer RudderStack analytics. Single-flight (F2):
   * concurrent/repeat calls share one in-flight promise so the dynamic SDK
   * import + ctor + load happen at most once. Returns `Promise<void>` (was
   * `void`); the sole call site (main.tsx) leaves it fire-and-forget. NEVER
   * rejects — `doInit()` swallows failures into health=error.
   */
  init: (): Promise<void> => {
    if (!initPromise) {
      initPromise = doInit();
    }
    return initPromise;
  },

  getIdentifiedEmail: (): string | null => identifiedEmail,

  setAccountContext: (context: AnalyticsAttributionProperties) => {
    accountContext = { ...context };
  },

  track: (event: string, properties: Record<string, unknown> = {}) => {
    // Snapshot accountContext at CALL time so a buffered (deferred) send reflects
    // the context as it was when track() was invoked, matching synchronous emit.
    const enrichedProperties = {
      ...accountContext,
      ...properties,
    };
    const send = (): void => {
      try {
        const client = getRudderClient();
        const appVersion = window.electronEnv?.appVersion;
        // RudderStack overloads are strict — cast through generic interface at SDK boundary
        const trackFn = client.track.bind(client) as (...args: unknown[]) => void;
        if (appVersion) {
          trackFn(event, enrichedProperties, { app: { version: appVersion } });
        } else {
          trackFn(event, enrichedProperties);
        }
      } catch (error) {
        console.warn('[analytics] track() failed:', error instanceof Error ? error.message : error);
        captureAnalyticsError(error, 'track');
      }
    };

    if (enabled) {
      send();
      return;
    }
    // Commercial init in flight (cred gate passed, SDK still loading): buffer the
    // event so a synchronous-after-init track() (e.g. main.tsx's boot event) is
    // flushed once `enabled` flips — instead of being silently dropped by the
    // async init. Bounded + drop-oldest. In OSS / disabled, `enabling` is never
    // set, so this is an unchanged no-op.
    if (enabling) {
      if (pendingTrackEvents.length >= PENDING_TRACK_CAP) {
        pendingTrackEvents.shift();
      }
      pendingTrackEvents.push(send);
    }
  },

  // identify()/alias() are NOT buffered (unlike track()): they have no
  // synchronous-before-settle caller, and buffering them would entangle the
  // hasAliased / identifiedEmail ordering that doInit()'s identity sequence
  // relies on. They keep today's `!enabled` early-return.
  identify: (userId: string, traits: Record<string, unknown> = {}) => {
    if (!enabled) {
      return;
    }
    try {
      const client = getRudderClient();
      const appVersion = window.electronEnv?.appVersion;
      // RudderStack overloads are strict — cast through generic interface at SDK boundary
      const identifyFn = client.identify.bind(client) as (...args: unknown[]) => void;
      if (appVersion) {
        identifyFn(userId, traits, { app: { version: appVersion } });
      } else {
        identifyFn(userId, traits);
      }

      if (window.electronEnv?.syncAnalyticsIdentity) {
        window.electronEnv.syncAnalyticsIdentity({ userId, traits });
      }
    } catch (error) {
      console.warn('[analytics] identify() failed:', error instanceof Error ? error.message : error);
      captureAnalyticsError(error, 'identify');
    }
  },

  alias: (newUserId: string, previousUserId: string) => {
    if (!enabled || hasAliased) {
      return;
    }
    try {
      const client = getRudderClient();
      client.alias(newUserId, previousUserId);
      hasAliased = true;
    } catch (error) {
      console.warn('[analytics] alias() failed:', error instanceof Error ? error.message : error);
      captureAnalyticsError(error, 'alias');
    }
  },

  identifyEmail: (email: string, options: { userId?: string; traits?: Record<string, unknown> } = {}) => {
    if (!enabled || !email) {
      return;
    }

    // Normalize email for consistent identity across analytics destinations.
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
      return;
    }

    // Link anonymous profile to email-identified profile (only once)
    const anonymousId = MAIN_PROCESS_ANONYMOUS_ID;
    if (anonymousId && !hasAliased) {
      analytics.alias(normalizedEmail, anonymousId);
    }

    identifiedEmail = normalizedEmail;

    const mergedTraits = {
      email: normalizedEmail,
      ...(options.traits ?? {})
    };

    analytics.identify(options.userId ?? normalizedEmail, mergedTraits);
  }
};

/**
 * The actual init work. Runs the EXISTING gates UNCHANGED and FIRST, then loads
 * the SDK via a guarded dynamic import strictly AFTER the cred gate passes. Wraps
 * the import + `new ctor()` + `client.load()` in one try/catch and NEVER rejects
 * (main.tsx calls `analytics.init()` fire-and-forget, so a rejection would be an
 * unhandled promise rejection). The pending-track buffer is flushed at the very
 * END — after the identifyEmail / email-listener identity sequence — so the
 * commercial boot event lands in the same order as today (F1).
 *
 * Declared AFTER the `analytics` singleton so the identity-sequence references
 * below (`analytics.identifyEmail`) are after-definition; `analytics.init` can
 * still reference this because function declarations hoist and it is only
 * invoked at runtime, long after both are defined.
 */
async function doInit(): Promise<void> {
  if (initialized) {
    return;
  }

  // Check if analytics is disabled via environment variable (passed from main process)
  if (window.electronEnv?.analyticsDisabled) {
    console.info('[analytics] Analytics disabled via DISABLE_ANALYTICS environment variable');
    initialized = true;
    enabled = false;
    analyticsHealth = { state: 'disabled', error: null };
    pushHealthToMain();
    return;
  }

  // OSS no-phone-home gate: OSS reads creds EXCLUSIVELY from the LOCAL_ONLY
  // telemetryConfig bridge (only when enabled); enterprise reads runtimeConfig.
  // Resolved BEFORE the dynamic import()/getRudderClient()/client.load()/the
  // ready() timeout below, so the Elastic-2.0 SDK module is never even imported
  // (let alone constructed) in an OSS-off / disabled build.
  const { writeKey, dataPlaneUrl } = resolveRudderCreds();

  if (!writeKey || !dataPlaneUrl) {
    console.info(
      '[analytics] RudderStack analytics disabled (missing credentials)',
      { hasWriteKey: Boolean(writeKey), hasDataPlaneUrl: Boolean(dataPlaneUrl) }
    );
    initialized = true;
    enabled = false;
    analyticsHealth = { state: 'disabled', error: null };
    pushHealthToMain();
    return;
  }

  // Cred gate passed → analytics IS enabled (commercial path). Set `enabling`
  // synchronously BEFORE the await so track() calls made synchronously after
  // init() are buffered (not dropped) while the SDK loads.
  enabling = true;

  let client: RudderAnalyticsClient;
  try {
    // The SDK module is loaded ONLY here — strictly after the cred gate — so the
    // no-phone-home invariant (#2) holds: no import, no `new ctor()`, no load()
    // in OSS-off / disabled builds.
    await loadRudderConstructor();
    client = getRudderClient();

    analyticsHealth = { state: 'pending', error: null };

    client.load(writeKey, dataPlaneUrl, {
      setAnonymousId: false
    } as Parameters<typeof client.load>[2]);

    // Register ready() callback — transitions pending → healthy
    client.ready(() => {
      if (readyTimeoutId !== undefined) {
        clearTimeout(readyTimeoutId);
        readyTimeoutId = undefined;
      }
      analyticsHealth = { state: 'healthy', error: null };
      console.info('[analytics] RudderStack SDK ready — analytics healthy');
      pushHealthToMain();
    });

    // Set a timeout — if ready() hasn't fired in 30s, transition to error
    // (possible network blocking, ad-blocker, or CDN issue)
    readyTimeoutId = setTimeout(() => {
      readyTimeoutId = undefined;
      if (analyticsHealth.state === 'pending') {
        const errorMsg = 'RudderStack SDK ready() did not fire within 30s — possible network blocking';
        analyticsHealth = { state: 'error', error: errorMsg };
        console.warn('[analytics]', errorMsg);
        captureRendererMessage(errorMsg, { tags: { analyticsContext: 'init-timeout' } });
        pushHealthToMain();
      }
    }, READY_TIMEOUT_MS);
  } catch (error) {
    // Failure-safe (F2): the dynamic import, `new ctor()`, or load() failed. Set
    // health=error, clear `enabling`, DROP the pending buffer, push health, and
    // RESOLVE (never throw — init() is fire-and-forget at main.tsx).
    const errorMsg = error instanceof Error ? error.message : String(error);
    analyticsHealth = { state: 'error', error: errorMsg };
    console.warn('[analytics] RudderStack load() failed:', errorMsg);
    captureAnalyticsError(error, 'init-load');
    initialized = true;
    enabling = false;
    dropPendingTrackEvents();
    pushHealthToMain();
    return;
  }

  if (MAIN_PROCESS_ANONYMOUS_ID) {
    client.setAnonymousId(MAIN_PROCESS_ANONYMOUS_ID);
  } else {
    // Log when anonymousId is missing - helps diagnose identity issues
    // RudderStack will generate its own UUIDv7 in this case
    console.warn(
      '[analytics] anonymousId not found in preload args - RudderStack will generate its own ID.',
      'This may cause identity fragmentation in analytics reports.',
      'electronEnv:', typeof window !== 'undefined' ? !!window.electronEnv : 'N/A'
    );
  }

  initialized = true;
  enabled = true;
  enabling = false;

  pushHealthToMain();

  // Auto-identify with email if available from preload (for existing users)
  if (PRELOAD_USER_EMAIL) {
    analytics.identifyEmail(PRELOAD_USER_EMAIL);
  }

  // Listen for email identification from background retry (race condition fix)
  // Note: No cleanup needed - this singleton lives for the app's lifetime
  if (window.api?.onUserEmailIdentified) {
    window.api.onUserEmailIdentified(({ email }) => {
      if (email && !identifiedEmail) {
        analytics.identifyEmail(email);
      }
    });
  }

  // Flush buffered track() events LAST (F1 — load-bearing ordering): today's
  // synchronous init had the call order load() → identifyEmail(PRELOAD) →
  // register listener → main.tsx track('Renderer Boot'). Flushing here, AFTER
  // the identity sequence above, keeps the boot event behind the identify/alias
  // it followed under the old synchronous init (not at the moment `enabled`
  // flips, which would move it ahead of identity).
  flushPendingTrackEvents();
}

function flushPendingTrackEvents(): void {
  if (pendingTrackEvents.length === 0) {
    return;
  }
  const pending = pendingTrackEvents;
  pendingTrackEvents = [];
  for (const send of pending) {
    send();
  }
}
