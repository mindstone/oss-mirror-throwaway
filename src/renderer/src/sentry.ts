import * as ElectronSentry from '@sentry/electron/renderer';
import * as SentryReact from '@sentry/react';
import type {
  Breadcrumb,
  CaptureContext,
  ErrorEvent,
  Event,
  EventHint,
  Integration,
  TransactionEvent,
} from '@sentry/core';
import { collectCommonSentryOptions, describeSentryDsnForLog, resolveSentryDsnForBuild, type SentryChannel } from '@shared/telemetry/sentryConfig';
import { rendererIsOss } from './rendererIsOss';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { redactSensitiveString, redactObjectDeep, redactSentryEvent } from '@shared/utils/sentryRedaction';
import { getRecentRendererLogs, type RendererLogBufferEntry } from './rendererLogBuffer';
import { ensureWellFormedDeep, summarizeWellFormedReplacementPaths } from '@shared/utils/wellFormedUnicode';
/* eslint-disable no-console -- Sentry init: runs before structured logger */

let initialized = false;
let initAttempted = false;
let sentryEnabled = false;
let sentryEnvironment = '';

const resolveReleaseVersion = (): string | null => {
  const fromPreload = window.electronEnv?.appVersion;
  if (fromPreload && fromPreload.trim()) {
    return fromPreload.trim();
  }
  return null;
};

const isPackagedBuild = (): boolean => window.location.protocol === 'file:';

/**
 * Runtime suppression bridge: true when main passed `--rebel-sentry-disabled`
 * (SENTRY_ENABLED explicitly false-ish at runtime, e.g. CI packaged-app
 * launches) and preload exposed it as `electronEnv.sentryDisabled`. Renderer
 * enablement is otherwise build-inlined, so without this bridge a runtime
 * opt-out would suppress only the main process. Wins over everything —
 * including the build-inlined DSN and OSS settings-driven telemetry — because
 * it only appears when the host process was explicitly disabled at runtime.
 * Exported for unit testing.
 */
export const isRendererSentrySuppressedByHost = (
  env: { sentryDisabled?: unknown } | null | undefined
): boolean => env?.sentryDisabled === true;

/**
 * Read the user's OSS telemetry creds from the preload bridge
 * (`electronEnv.telemetryConfig`, LOCAL_ONLY). Used ONLY on the OSS path.
 */
const readOssTelemetryConfig = (): { enabled?: boolean; sentryDsn?: string } | undefined => {
  const raw = typeof window !== 'undefined' ? window.electronEnv?.telemetryConfig : null;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  return {
    enabled: obj.enabled === true,
    sentryDsn: typeof obj.sentryDsn === 'string' ? obj.sentryDsn : undefined
  };
};

/**
 * OSS no-phone-home gate for the renderer Sentry DSN.
 *
 * OSS build: returns the user DSN from `electronEnv.telemetryConfig` ONLY when
 * telemetry is enabled — NEVER falls back to env. Enterprise: `undefined`
 * override → `collectCommonSentryOptions` reads `SENTRY_DSN` env as before.
 * Resolved BEFORE any ElectronSentry/SentryReact init below.
 */
const resolveRendererDsnOverride = (isOss: boolean): string | undefined =>
  isOss ? resolveSentryDsnForBuild(true, readOssTelemetryConfig()) : undefined;

/**
 * Detect build channel from the buildChannel exposed via electronEnv.
 * Falls back to parsing appName for backwards compatibility.
 */
const resolveBuildChannel = (): SentryChannel | undefined => {
  // Prefer buildChannel directly from preload
  const buildChannel = window.electronEnv?.buildChannel;
  if (buildChannel) return buildChannel;
  
  // Fallback to parsing appName for backwards compatibility
  const appName = window.electronEnv?.appName?.toLowerCase();
  if (!appName) return undefined;
  if (appName.includes('beta')) return 'beta';
  return 'stable';
};

const buildAdditionalIntegrations = (enabled: boolean) => {
  const integrations: unknown[] = [];
  // Only register browserTracingIntegration when Sentry is enabled —
  // it attaches DOM observers that add overhead even when disabled.
  if (enabled && typeof ElectronSentry.browserTracingIntegration === 'function') {
    integrations.push(ElectronSentry.browserTracingIntegration());
  }
  // Session Replay integration removed - rrweb-based DOM mutation tracking
  // causes significant UI lag on Windows during streaming chat.
  // Sample rates are also set to 0 in sentryConfig.ts.
  // To re-enable for debugging, set SENTRY_REPLAYS_SESSION_SAMPLE_RATE > 0
  // and uncomment this block:
  // if (typeof ElectronSentry.replayIntegration === 'function') {
  //   integrations.push(ElectronSentry.replayIntegration({
  //     maskAllText: true,
  //     maskAllInputs: true,
  //     blockAllMedia: true,
  //   }));
  // }
  if (typeof ElectronSentry.feedbackIntegration === 'function') {
    // Enable feedback integration with autoInject: false since we'll use custom UI
    // This enables captureFeedback() API without injecting Sentry's default widget
    integrations.push(
      ElectronSentry.feedbackIntegration({
        autoInject: false
      })
    );
    if (import.meta.env.DEV) {
      console.log('[Sentry] feedbackIntegration configured successfully');
    }
  } else {
    console.warn('[Sentry] feedbackIntegration not available - user feedback will be disabled');
  }
  return integrations;
};

/**
 * Redact breadcrumb data before sending to Sentry.
 */
const beforeBreadcrumb = (breadcrumb: Breadcrumb): Breadcrumb | null => {
  if (breadcrumb.message) {
    breadcrumb.message = redactSensitiveString(breadcrumb.message);
  }
  if (breadcrumb.data) {
    if (breadcrumb.category === 'renderer.log') {
      // PRIVACY (MF-2 / renderer channel): renderer log breadcrumbs (from
      // App.tsx's renderer-log bridge) carry raw `payload.context` — the same
      // content-bearing shape as main/core pino log breadcrumbs, which the
      // allowlist closes. The deny-by-default log allowlist lives in @core
      // (`redactLogBreadcrumbData`/`filterLogEntry`) and pulling it into the
      // renderer bundle crosses the renderer↔core project boundary (tsconfig +
      // boundary guards). Rather than widen that boundary just for breadcrumb
      // bindings, DROP the data entirely: the (redacted) message preserves the
      // breadcrumb trail, and structured renderer state is not load-bearing for
      // triage. This is strictly privacy-safe (nothing under benign keys ships).
      delete breadcrumb.data;
    } else {
      breadcrumb.data = redactObjectDeep(breadcrumb.data) as Record<string, unknown>;
    }
  }
  return breadcrumb;
};

const sweepSentryPayloadWellFormedness = <T>(value: T, eventType: 'error' | 'transaction'): T => {
  const wellFormed = ensureWellFormedDeep(value);
  if (wellFormed.replacementCount > 0) {
    const replacementSummary = summarizeWellFormedReplacementPaths(wellFormed.replacementPaths);
    console.warn(
      `[Sentry:Renderer] Replaced lone surrogates in outgoing ${eventType} event`,
      {
        replacementCount: wellFormed.replacementCount,
        replacementPaths: replacementSummary.replacementPaths,
        omittedPathCount: replacementSummary.omittedPathCount,
      },
    );
  }
  return wellFormed.value;
};

/**
 * Expected CI/E2E test noise that should never reach Sentry.
 *
 * `AgentSessionError`s in `ci-e2e` are synthetic strings injected by the E2E
 * LLM mock (`tests/e2e/mocks/llm-mock.ts`) — "Model not found", "Context window
 * exceeded", "overloaded", etc. They are matched by exception **type**, because
 * the Sentry exception `value` carries the human message (which does NOT contain
 * the literal "AgentSessionError"); the previous value-substring check therefore
 * never matched and the mock errors leaked into the triage stream
 * (REBEL-184/183/185). Exported for unit testing.
 */
export const isExpectedCiE2eNoise = (event: Event): boolean => {
  const first = event.exception?.values?.[0];
  const errorValue = first?.value ?? event.message ?? '';
  const errorType = first?.type ?? '';
  return (
    errorValue.includes('Turn cancelled by user') ||
    errorValue.includes('AgentSessionError') ||
    errorType === 'AgentSessionError'
  );
};

/**
 * Redact event data before sending to Sentry.
 * Also filters out expected noise from CI/E2E test environments.
 */
const beforeSend = (event: Event): Event | null => {
  // Filter out expected E2E test errors that aren't actionable
  if (sentryEnvironment === 'ci-e2e' && isExpectedCiE2eNoise(event)) {
    return null;
  }

  return redactSentryEvent(event as unknown as Record<string, unknown>, {
    onWellFormedFix: (replacementSummary) => {
      console.warn(
        '[Sentry:Renderer] Replaced lone surrogates in outgoing error event',
        replacementSummary,
      );
    },
  }) as Event;
};

export const initRendererSentry = () => {
  if (initAttempted) {
    return;
  }
  initAttempted = true;

  // Runtime kill-switch from main — checked before ANY resolution (env, OSS
  // settings) so an explicit runtime opt-out always wins.
  if (isRendererSentrySuppressedByHost(window.electronEnv)) {
    sentryEnabled = false;
    console.info('[Sentry:Renderer] Disabled', {
      surface: 'renderer',
      reason: 'host disabled Sentry at runtime (--rebel-sentry-disabled)',
    });
    return;
  }

  const environmentOverride = import.meta.env.DEV ? 'development' : undefined;
  const isPackaged = isPackagedBuild();
  // OSS no-phone-home gate: in an OSS build the DSN comes EXCLUSIVELY from the
  // user's telemetryConfig bridge (and only when enabled). Resolved before
  // collectCommonSentryOptions, and before any ElectronSentry/SentryReact init.
  const isOss = rendererIsOss();
  const {
    dsn,
    release,
    environment,
    enabled,
    tracesSampleRate,
    profilesSampleRate,
    replaysSessionSampleRate,
    replaysOnErrorSampleRate
  } = collectCommonSentryOptions({
    releaseVersion: resolveReleaseVersion(),
    isPackaged,
    environment: environmentOverride,
    channel: resolveBuildChannel(),
    ...(isOss ? { dsnOverride: resolveRendererDsnOverride(true) } : {})
  });

  if (!dsn) {
    sentryEnabled = false;
    console.info('[Sentry:Renderer] Disabled', {
      surface: 'renderer',
      reason: 'SENTRY_DSN env var not set',
    });
    return;
  }

  if (!enabled) {
    sentryEnabled = false;
    console.info('[Sentry:Renderer] Disabled', {
      surface: 'renderer',
      reason: 'SENTRY_ENABLED disabled Sentry',
    });
    return;
  }

  // Build integrations once to avoid duplicates between Electron and React inits
  const additionalIntegrations = buildAdditionalIntegrations(enabled);

  ElectronSentry.init(
    {
      dsn,
      release,
      environment,
      enabled,
      tracesSampleRate,
      profilesSampleRate,
      replaysSessionSampleRate,
      replaysOnErrorSampleRate,
      debug: Boolean(import.meta.env.DEV && import.meta.env.VITE_SENTRY_DEBUG),
      beforeBreadcrumb,
      beforeSend: beforeSend as (event: ErrorEvent, hint: EventHint) => ErrorEvent | null,
      // Sweep-only: transactions get UTF-16 well-formedness hardening, no
      // additional redaction semantics. This covers JS error events +
      // transactions on main/renderer; sessions/native paths are separate.
      beforeSendTransaction: ((event: TransactionEvent, _hint: EventHint) =>
        sweepSentryPayloadWellFormedness(event, 'transaction')) as (
        event: TransactionEvent,
        hint: EventHint,
      ) => TransactionEvent | null,
      integrations: ((existing: Integration[] = []) => [...existing, ...additionalIntegrations]) as (integrations: Integration[]) => Integration[],
    },
    (reactOptions) =>
      SentryReact.init({
        ...reactOptions,
        enabled,
        dsn,
        release,
        environment,
        tracesSampleRate,
        profilesSampleRate,
        replaysSessionSampleRate,
        replaysOnErrorSampleRate,
        beforeBreadcrumb,
        beforeSend: beforeSend as (event: ErrorEvent, hint: EventHint) => ErrorEvent | null,
        beforeSendTransaction: ((event: TransactionEvent, _hint: EventHint) =>
          sweepSentryPayloadWellFormedness(event, 'transaction')) as (
          event: TransactionEvent,
          hint: EventHint,
        ) => TransactionEvent | null,
        // Don't add integrations again here - they're already in reactOptions from Electron init
      })
  );

  // Track environment for beforeSend filtering
  sentryEnvironment = environment;

  console.info('[Sentry:Renderer] Enabled', {
    surface: 'renderer',
    environment,
    release,
    dsnHost: describeSentryDsnForLog(dsn),
  });

  if (import.meta.env.DEV) {
    console.log('[Sentry] Init:', {
      enabled,
      environment,
      release,
      dsnHost: describeSentryDsnForLog(dsn),
    });
  }

  ElectronSentry.setTag('process', 'renderer');
  
  const anonymousId = window.electronEnv?.anonymousId;
  const preloadEmail = window.electronEnv?.userEmail;
  
  if (anonymousId || preloadEmail) {
    ElectronSentry.setUser({
      ...(anonymousId && { id: anonymousId }),
      ...(preloadEmail && { email: preloadEmail })
    });
  }

  // If email wasn't available via preload, try to fetch from settings
  // This handles the case where window was created before email was set
  if (anonymousId && !preloadEmail) {
    window.settingsApi?.get().then(settings => {
      if (settings?.userEmail) {
        ElectronSentry.setUser({
          id: anonymousId,
          email: settings.userEmail
        });
      }
    }).catch(() => {
      // Ignore errors - settings API may not be ready yet
    });
  }

  initialized = true;
  sentryEnabled = true;
};

// Stage 4 / Class B: hard cap on the emitted renderer-log attachment so it can
// never trip Sentry's `too_large` ingest drop — mirrors MAX_LOG_ATTACHMENT_SIZE
// in src/main/sentry.ts (100KB tail).
const MAX_RENDERER_LOG_ATTACHMENT_SIZE = 100_000;

/**
 * Format the recent renderer logs as a redacted NDJSON attachment string.
 *
 * Redaction parity: message via `redactSensitiveString`, context via
 * `redactObjectDeep` — the SAME @shared redactors the MAIN attachment path uses
 * (formatLogsForAttachment, src/main/sentry.ts). The stricter @core breadcrumb
 * allowlist is a separate path and is not what main's attachment uses either,
 * so this is parity, not a regression. Tail-capped at
 * MAX_RENDERER_LOG_ATTACHMENT_SIZE. Returns null when there's nothing to attach.
 */
const formatRendererLogsForAttachment = (logs: RendererLogBufferEntry[]): string | null => {
  if (logs.length === 0) {
    return null;
  }
  const redacted = logs.map((entry) => ({
    timestamp: entry.timestamp,
    level: entry.level,
    message: redactSensitiveString(entry.message),
    ...(entry.context ? { context: redactObjectDeep(entry.context) } : {}),
  }));

  let text = redacted.map((e) => JSON.stringify(e)).join('\n');
  if (text.length > MAX_RENDERER_LOG_ATTACHMENT_SIZE) {
    text = text.slice(-MAX_RENDERER_LOG_ATTACHMENT_SIZE);
    // Drop the partial first line after a tail-truncation.
    const firstNewline = text.indexOf('\n');
    if (firstNewline > 0) {
      text = text.slice(firstNewline + 1);
    }
  }
  return text;
};

/**
 * Run a capture inside a scope that carries the redacted recent-renderer-logs
 * attachment. Uses `withScope` + `scope.addAttachment` — the SAME mechanism the
 * main process uses (src/main/sentry.ts) and version-stable, rather than the
 * `captureException` hint argument (whose type disallows mixing a CaptureContext
 * with an EventHint in this SDK). Best-effort: attaching is wrapped so a buffer/
 * redaction failure can never suppress the capture itself.
 */
const captureWithRendererLogs = (capture: () => void): void => {
  // Fail-open at the OUTER boundary (review F2): a throw from withScope/the SDK
  // capture itself must never propagate into the production callers of
  // captureRendererException/Message (e.g. tracking.tools.connectionFailed,
  // toast error telemetry). Mirrors main's non-throwing crash-capture posture.
  try {
    ElectronSentry.withScope((scope) => {
      try {
        const logsText = formatRendererLogsForAttachment(getRecentRendererLogs());
        if (logsText) {
          scope.addAttachment({
            filename: 'recent-renderer-logs.ndjson',
            data: logsText,
            contentType: 'application/x-ndjson',
          });
        }
      } catch (error) {
        ignoreBestEffortCleanup(error, {
          operation: 'captureWithRendererLogs.addAttachment',
          reason: 'Renderer-log attachment is best-effort context; its failure must not suppress the capture',
        });
      }
      capture();
    });
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'captureWithRendererLogs.withScope',
      reason: 'Telemetry capture must never propagate into product code; the renderer is no worse off if the SDK throws',
    });
  }
};

export const captureRendererException = (
  error: unknown,
  context?: CaptureContext
) => {
  if (!sentryEnabled) {
    return undefined;
  }
  captureWithRendererLogs(() => {
    ElectronSentry.captureException(error, context);
  });
  return undefined;
};

export const captureRendererMessage = (message: string, context?: CaptureContext) => {
  if (!sentryEnabled) {
    return undefined;
  }
  captureWithRendererLogs(() => {
    ElectronSentry.captureMessage(message, context);
  });
  return undefined;
};

export const recordRendererBreadcrumb = (breadcrumb: Breadcrumb) => {
  if (!sentryEnabled) {
    return;
  }
  try {
    ElectronSentry.addBreadcrumb(breadcrumb);
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'recordRendererBreadcrumb',
      reason: 'Telemetry sink failure must not propagate to product code; breadcrumb is best-effort observability',
    });
  }
};

export const SentryErrorBoundary = SentryReact.ErrorBoundary;

/**
 * Check if Sentry is initialized (for features that need to wait for init).
 */
export const isSentryInitialized = (): boolean => initialized;
