/**
 * Sentry Integration for Mobile
 *
 * Initializes @sentry/react-native and provides an ErrorReporter-compatible
 * interface for the cloud-client SDK.
 *
 * --- Crash / rejection capture verification (manual, requires a real build) ---
 *
 * `@sentry/react-native` v7 captures native crashes AND unhandled JS promise
 * rejections BY DEFAULT, and this app does not disable them (no
 * `enableNativeCrashHandling: false`, no `enableUnhandledRejectionTracking:
 * false`). We therefore deliberately do NOT add our own global rejection /
 * native-crash handlers — duplicate handlers cause double-reports. The existing
 * `ErrorUtils.setGlobalHandler` in `mobile/app/_layout.tsx` only re-routes JS
 * errors to the SAME Sentry client (no second report) and re-throws fatals to
 * the default handler.
 *
 * Because this capture path can only be exercised on a device/simulator under
 * Hermes (RN 0.81 + new arch), confirm it manually on a dev build before
 * relying on it (cannot be unit-tested here):
 *
 *   1. Build + run a dev client: `cd mobile && npx expo run:ios`
 *      (or `run:android`) with `EXPO_PUBLIC_SENTRY_DSN` set to a real DSN.
 *   2. (a) Unhandled promise rejection — add a throwaway button that runs
 *          `Promise.reject(new Error('QA: unhandled rejection'))` with NO
 *          `.catch`. Tap it. Confirm an event titled "QA: unhandled rejection"
 *          reaches the Sentry project (mechanism: Hermes
 *          `enableUnhandledRejectionTracking`, on by default in v7).
 *      (b) Thrown JS error — a button that synchronously `throw new Error('QA:
 *          thrown JS error')` from an event handler. Confirm it arrives. (Our
 *          `ErrorUtils.setGlobalHandler` routes it; verify it is reported ONCE,
 *          not twice — the key duplicate-handler regression to watch for.)
 *      (c) Forced native crash — call `Sentry.nativeCrash()` from a button.
 *          Confirm a native crash event arrives (will be unsymbolicated until
 *          Stage A3 wires symbol upload; presence is what matters here).
 *   3. For each, verify in Sentry that the event carries the `mobileHealth`
 *      context and (when paired with a desktop that set an email) a `user.email`.
 *
 * If — and only if — step 2(a) proves Sentry MISSES unhandled rejections under
 * Hermes, add an explicit rejection hook guarded against double-reporting with
 * the existing `ErrorUtils.setGlobalHandler`. Do not add it pre-emptively.
 */

import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import { attachLogBreadcrumbData } from '@shared/utils/safeTelemetryBreadcrumbData';
import { redactLogBreadcrumbData, sanitizeLogMessage } from './logFilter';
import { redactSentryEvent } from '@shared/utils/sentryRedaction';
import { telemetryHash } from './telemetryHash';

function resolveSentryDsn(): string | undefined {
  const dsn = process.env.EXPO_PUBLIC_SENTRY_DSN?.trim();
  return dsn || undefined;
}

function describeSentryDsnForLog(dsn: string): string {
  try {
    return new URL(dsn).host;
  } catch {
    return 'configured-dsn';
  }
}

let _initialized = false;
let _initAttempted = false;
let _sentryEnabled = false;

function resolveRuntimeVersionString(): string | undefined {
  const rv = Constants.expoConfig?.runtimeVersion;
  if (rv == null) return undefined;
  if (typeof rv === 'string') return rv;
  if (typeof rv === 'object' && 'policy' in rv && rv.policy === 'appVersion') {
    return Constants.expoConfig?.version ?? undefined;
  }
  return JSON.stringify(rv);
}

export function initSentry(): void {
  if (_initAttempted) return;
  _initAttempted = true;

  const dsn = resolveSentryDsn();
  if (!dsn) {
    _initialized = false;
    _sentryEnabled = false;
    console.info('[Sentry:Mobile] Disabled', {
      surface: 'mobile',
      reason: 'EXPO_PUBLIC_SENTRY_DSN env var not set',
    });
    return;
  }

  Sentry.init({
    dsn,
    environment: __DEV__ ? 'development' : 'production',
    release: `mindstone-rebel-mobile@${Constants.expoConfig?.version || '0.0.0'}`,
    dist: resolveRuntimeVersionString(),
    tracesSampleRate: 0,
    enableAutoSessionTracking: true,
    attachStacktrace: true,
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.message) {
        try {
          breadcrumb.message = sanitizeLogMessage(breadcrumb.message);
        } catch {
          // Never throw from Sentry's breadcrumb hook.
        }
      }
      if (breadcrumb.data) {
        if (
          breadcrumb.category === 'log' ||
          breadcrumb.category?.startsWith('log.') ||
          breadcrumb.category === 'renderer.log' ||
          breadcrumb.category?.startsWith('renderer.log.')
        ) {
          try {
            attachLogBreadcrumbData(
              breadcrumb,
              redactLogBreadcrumbData(breadcrumb.data as Record<string, unknown>),
            );
          } catch {
            delete breadcrumb.data;
          }
        }
      }
      return breadcrumb;
    },
    beforeSend(event) {
      return redactSentryEvent(event as unknown as Record<string, unknown>, {
        onWellFormedFix: (replacementSummary) => {
          console.warn('[Sentry:Mobile] Replaced lone surrogates in outgoing error event', replacementSummary);
        },
      }) as unknown as typeof event;
    },
  });

  _initialized = true;
  _sentryEnabled = true;
  console.info('[Sentry:Mobile] Enabled', {
    surface: 'mobile',
    dsnHost: describeSentryDsnForLog(dsn),
  });
}

export function setSentryCloudContext(cloudUrl: string): void {
  if (!_sentryEnabled) return;
  Sentry.setTag('platform', 'mobile');
  Sentry.setTag('cloudUrl', telemetryHash(cloudUrl));
  Sentry.setTag('appVersion', Constants.expoConfig?.version || 'unknown');
}

/**
 * Identify the current user for error monitoring, mirroring desktop's
 * `setSentryUser` (`src/main/sentry.ts`). Email is the SDK-managed PII channel —
 * it is sent via Sentry's dedicated user object, NOT as an event property/tag,
 * and the shared `redactSentryEvent` redaction is intentionally left to treat
 * the user channel as the sanctioned home for it. Passing an empty/absent email
 * is a no-op (the user stays null) so callers can degrade gracefully.
 */
export function setSentryUser(user: { id?: string; email?: string | null }): void {
  if (!_sentryEnabled) return;
  const sentryUser: { id?: string; email?: string } = {};
  if (user.id) {
    sentryUser.id = user.id;
  }
  if (user.email) {
    sentryUser.email = user.email;
  }
  if (Object.keys(sentryUser).length > 0) {
    Sentry.setUser(sentryUser);
  }
}

/**
 * Slim startup/health context, mirroring desktop's `setHealthContext`
 * (`src/main/sentry.ts`) with the values meaningful on mobile. Reuses values
 * already resolved in `_layout.tsx` / Expo app config — does not introduce new
 * sources. Set as a Sentry context (not tags) so it travels with every event
 * without inflating the tag cardinality.
 */
export function setSentryHealthContext(health: {
  paired: boolean;
  online?: boolean | null;
}): void {
  if (!_sentryEnabled) return;
  Sentry.setContext('mobileHealth', {
    appVersion: Constants.expoConfig?.version || 'unknown',
    runtimeVersion: resolveRuntimeVersionString() || 'unknown',
    paired: health.paired,
    online: health.online ?? null,
    capturedAt: new Date().toISOString(),
  });
}

export function clearSentryContext(): void {
  if (!_sentryEnabled) return;
  Sentry.setUser(null);
}

export function captureSentryMessage(
  message: string,
  level: Sentry.SeverityLevel = 'warning',
  context?: Record<string, unknown>,
): void {
  if (!_sentryEnabled) return;
  Sentry.captureMessage(message, {
    level,
    extra: context,
  });
}

export function captureSentryBreadcrumb(category: string, message: string, level?: Sentry.SeverityLevel): void {
  if (!_sentryEnabled) return;
  Sentry.addBreadcrumb({ category, message, level: level || 'info' });
}

export const wrapWithSentry: typeof Sentry.wrap = (component) => {
  return _sentryEnabled ? Sentry.wrap(component) : component;
};

export function isSentryEnabled(): boolean {
  return _sentryEnabled;
}

/**
 * Maps the `ErrorReporter` breadcrumb level strings (`info`/`warning`/`error`/
 * `fatal`/`debug`) to Sentry's SeverityLevel. Accepts an unknown string so
 * callers can pass `breadcrumb.level` without a cast.
 */
function toSeverityLevel(level: string | undefined): Sentry.SeverityLevel {
  switch (level) {
    case 'fatal':
    case 'error':
    case 'warning':
    case 'info':
    case 'debug':
      return level;
    case 'warn':
      return 'warning';
    default:
      return 'info';
  }
}

/**
 * Sentry-backed `ErrorReporter` implementation suitable for use with
 * `src/core/errorReporter.ts` (`setErrorReporter`) and with
 * `cloud-client`'s logger bridge (`setLogErrorReporter`). Registered at
 * app startup in `mobile/app/_layout.tsx` once `initSentry()` has run.
 *
 * Deliberately typed structurally — we avoid importing `ErrorReporter` from
 * `@core/errorReporter` here because mobile does not depend on the desktop
 * boundary module yet, and the logger bridge only requires `addBreadcrumb`.
 */
export const mobileErrorReporter = {
  captureException(error: unknown, context?: Record<string, unknown>): void {
    if (!_sentryEnabled) return;
    try {
      Sentry.captureException(error, context as Parameters<typeof Sentry.captureException>[1]);
    } catch (sentryErr) {
      // Never throw from an error reporter — but make transport failures observable.
      console.warn('[mobileErrorReporter] capture failed', sentryErr);
    }
  },
  captureMessage(message: string, context?: Record<string, unknown>): void {
    if (!_sentryEnabled) return;
    try {
      Sentry.captureMessage(message, context as Parameters<typeof Sentry.captureMessage>[1]);
    } catch {
      // Never throw from an error reporter.
    }
  },
  addBreadcrumb(breadcrumb: { category: string; message: string; level?: string; data?: Record<string, unknown> }): void {
    if (!_sentryEnabled) return;
    try {
      Sentry.addBreadcrumb({
        category: breadcrumb.category,
        message: breadcrumb.message,
        level: toSeverityLevel(breadcrumb.level),
        data: breadcrumb.data,
        timestamp: Date.now() / 1000,
      });
    } catch {
      // Never throw from an error reporter.
    }
  },
};
