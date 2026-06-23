import type {
  Breadcrumb,
  CaptureContext,
  Event,
  TransportMakeRequestResponse,
} from '@sentry/core';
import * as SentryElectronMain from '@sentry/electron/main';
import { IPCMode } from '@sentry/electron/main';
import { collectCommonSentryOptions, describeSentryDsnForLog, resolveSentryDsnForBuild } from '@shared/telemetry/sentryConfig';
import type { ErrorReporterMessageCaptureContext } from '@core/errorReporter';
import { getSettings } from '@core/services/settingsStore';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { redactSensitiveString, redactObjectDeep, redactSentryEvent } from '@shared/utils/sentryRedaction';
import { ensureWellFormedDeep, summarizeWellFormedReplacementPaths } from '@shared/utils/wellFormedUnicode';
import { redactSensitiveData } from './utils/logRedaction';
import { getRecentLogs, type LogBufferEntry } from './logBuffer';
import { getBuildChannel } from './utils/buildChannel';
import { getPlatformConfig } from '@core/platform';
import { redactLogBreadcrumbData } from '@core/utils/logFieldFilter';
import { attachLogBreadcrumbData } from '@shared/utils/safeTelemetryBreadcrumbData';
/* eslint-disable no-console -- Sentry init: runs before structured logger */

let initialized = false;
let initAttempted = false;
let sentryEnabled = false;

/**
 * Why the main-process Sentry client is disabled (null while enabled or before
 * init). Drives truthful user-facing messaging: 'no-dsn' means this build
 * shipped without a DSN (e.g. packaged build missing the build-time injection —
 * NOT a dev-mode situation), 'env-disabled' means SENTRY_ENABLED turned it off
 * (the dev default / explicit opt-out).
 */
export type MainSentryDisabledReason = 'no-dsn' | 'env-disabled';
let disabledReason: MainSentryDisabledReason | null = null;
const isTestEnv = process.env.VITEST === 'true';

type SentryMainModule = typeof SentryElectronMain;

export interface SentrySendOutcome {
  eventId: string;
  statusCode?: number;
  recordedAt: number;
  /**
   * Parsed `Retry-After` from the transport response, in seconds, when present.
   * Sentry returns this on 429 / rate-limit responses. The bug-report outbox
   * circuit breaker reads it to pause draining for at least this long instead
   * of guessing with plain backoff. Absent when the header was missing or
   * unparseable; `0` is a valid "retry immediately" hint and is preserved.
   */
  retryAfterSeconds?: number;
}

/**
 * Parse a `Retry-After` header value (HTTP delta-seconds form only — Sentry
 * sends seconds, not an HTTP-date). Returns a non-negative integer count of
 * seconds, or undefined when the header is missing/unparseable.
 */
const parseRetryAfterSeconds = (value: string | null | undefined): number | undefined => {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const seconds = Number(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.floor(seconds);
};

const SEND_OUTCOME_LIMIT = 50;
const sendOutcomes = new Map<string, SentrySendOutcome>();

export const recordSendOutcome = (
  event: Event,
  sendResponse: TransportMakeRequestResponse
): void => {
  const eventId = event.event_id;
  if (!eventId) {
    return;
  }

  if (sendOutcomes.has(eventId)) {
    sendOutcomes.delete(eventId);
  }

  sendOutcomes.set(eventId, {
    eventId,
    statusCode: sendResponse.statusCode,
    recordedAt: Date.now(),
    retryAfterSeconds: parseRetryAfterSeconds(sendResponse.headers?.['retry-after']),
  });

  while (sendOutcomes.size > SEND_OUTCOME_LIMIT) {
    const oldestEventId = sendOutcomes.keys().next().value;
    if (!oldestEventId) {
      break;
    }
    sendOutcomes.delete(oldestEventId);
  }
};

export const clearSendOutcomesForTest = () => sendOutcomes.clear();

export const getSendOutcomeCountForTest = () => sendOutcomes.size;

const sweepSentryPayloadWellFormedness = <T>(value: T, eventType: 'error' | 'transaction'): T => {
  const wellFormed = ensureWellFormedDeep(value);
  if (wellFormed.replacementCount > 0) {
    const replacementSummary = summarizeWellFormedReplacementPaths(wellFormed.replacementPaths);
    console.warn(
      `[Sentry:Main] Replaced lone surrogates in outgoing ${eventType} event`,
      {
        replacementCount: wellFormed.replacementCount,
        replacementPaths: replacementSummary.replacementPaths,
        omittedPathCount: replacementSummary.omittedPathCount,
      }
    );
  }
  return wellFormed.value;
};

const SENTRY_EVENT_ITEM_HARD_CAP_BYTES = 1_000_000;
export const SENTRY_EVENT_OVERSIZE_PROBE_THRESHOLD_BYTES = 700_000;
const OVERSIZE_SECTION_LIMIT = 6;
const EXTRA_KEY_SECTION_MAX_LENGTH = 64;

export interface OversizedEventSectionSize {
  section: string;
  sizeBytes: number;
}

export interface OversizedMainEventSummary {
  eventSizeBytes: number;
  thresholdBytes: number;
  topSections: OversizedEventSectionSize[];
}

const safeJsonStringify = (value: unknown): string | null => {
  try {
    return JSON.stringify(value);
  } catch (error) {
    // Intentional fail-soft: an unserializable event simply skips the oversize
    // probe (beforeSend must never throw).
    ignoreBestEffortCleanup(error, {
      operation: 'sentry-main-oversize-probe-stringify',
      reason: 'unserializable event skips the oversize probe; beforeSend must never throw',
    });
    return null;
  }
};

const byteLengthUtf8 = (text: string): number => Buffer.byteLength(text, 'utf8');

const normalizeExtraKeySection = (key: string): string => {
  const normalized = key.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, EXTRA_KEY_SECTION_MAX_LENGTH);
  if (normalized.length === 0) {
    return 'extra.unknown_key';
  }
  return `extra.${normalized}`;
};

const collectOversizeSections = (event: Record<string, unknown>): OversizedEventSectionSize[] => {
  const sections: OversizedEventSectionSize[] = [];

  const breadcrumbsSerialized = safeJsonStringify(event.breadcrumbs ?? []);
  if (breadcrumbsSerialized) {
    sections.push({
      section: 'breadcrumbs',
      sizeBytes: byteLengthUtf8(breadcrumbsSerialized),
    });
  }

  const contextsSerialized = safeJsonStringify(event.contexts ?? {});
  if (contextsSerialized) {
    sections.push({
      section: 'contexts',
      sizeBytes: byteLengthUtf8(contextsSerialized),
    });
  }

  const extra = event.extra;
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra as Record<string, unknown>)) {
      const entrySerialized = safeJsonStringify({ [key]: value });
      if (!entrySerialized) {
        continue;
      }
      sections.push({
        section: normalizeExtraKeySection(key),
        // Strip the surrounding `{}` so this represents a single object entry.
        sizeBytes: Math.max(0, byteLengthUtf8(entrySerialized) - 2),
      });
    }
  }

  return sections.sort((a, b) => b.sizeBytes - a.sizeBytes).slice(0, OVERSIZE_SECTION_LIMIT);
};

export const summarizeMainOversizedEvent = (
  event: Record<string, unknown>,
  thresholdBytes = SENTRY_EVENT_OVERSIZE_PROBE_THRESHOLD_BYTES,
): OversizedMainEventSummary | null => {
  const serialized = safeJsonStringify(event);
  if (!serialized) {
    return null;
  }
  const eventSizeBytes = byteLengthUtf8(serialized);
  if (eventSizeBytes <= thresholdBytes) {
    return null;
  }
  return {
    eventSizeBytes,
    thresholdBytes,
    topSections: collectOversizeSections(event),
  };
};

// NB: under the registry-wide KNOWN_CONDITION_WRAPPER_DISABLED=1 kill switch the
// wrapper's pass-through mints a real (small) Sentry event from inside beforeSend —
// re-entrant but safe; it inverts the "never mint an event about oversize" intent
// only while that switch is on.
const reportOversizedMainEvent = (summary: OversizedMainEventSummary): void => {
  const condition = 'sentry_oversized_event_detected' as const;
  const extra = {
    eventSizeBytes: summary.eventSizeBytes,
    thresholdBytes: summary.thresholdBytes,
    sentryHardCapBytes: SENTRY_EVENT_ITEM_HARD_CAP_BYTES,
    topSections: summary.topSections,
  };
  console.warn('[Sentry:Main] Oversized outgoing event detected', {
    condition,
    ...extra,
  });
  captureKnownCondition(
    'sentry_oversized_event_detected',
    { extra },
    new Error('Outgoing Sentry event exceeded oversize probe threshold'),
  );
};

const createStubSentryMain = (): SentryMainModule =>
  ({
    addBreadcrumb: () => {},
    captureException: () => undefined,
    captureMessage: () => undefined,
    setTag: () => {},
    setContext: () => {},
    setUser: () => {},
    flush: async () => true,
    getClient: () => ({ on: () => () => {} }),
    init: () => {},
    withScope: (callback: (scope: { addAttachment: () => void; setExtra: () => void }) => void) => {
      callback({ addAttachment: () => {}, setExtra: () => {} });
    }
  } as unknown as SentryMainModule);

// Use stub in test environment, real module otherwise
const SentryMain: SentryMainModule = isTestEnv ? createStubSentryMain() : SentryElectronMain;

const safeAppVersion = () => {
  try {
    return getPlatformConfig().version;
  } catch {
    return undefined;
  }
};

const resolveEnvironment = () => {
  // Explicit override takes precedence
  const env = process.env.SENTRY_ENVIRONMENT;
  if (env && env.trim()) {
    return env.trim();
  }

  // Detect CI/E2E test environment to separate test noise from production
  // - CI: Standard env var set by most CI systems
  // - GITHUB_ACTIONS: Set by GitHub Actions runners
  // - REBEL_E2E_TEST_MODE: Set by our E2E test harness (tests/e2e/test-utils.ts)
  // - REBEL_TEST_USER_DATA_DIR: Set when running E2E tests with isolated user data
  const isCI = Boolean(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.REBEL_E2E_TEST_MODE === '1' ||
    process.env.REBEL_TEST_USER_DATA_DIR
  );

  if (isCI) {
    return 'ci-e2e';
  }

  return getPlatformConfig().isPackaged ? 'production' : 'development';
};

/**
 * Resolve the Sentry DSN under the OSS no-phone-home gate (B6.a).
 *
 * OSS build: read the user-supplied DSN from `settings.telemetry` ONLY — never
 * env / app-config — and only when telemetry is explicitly enabled. Enterprise:
 * `undefined` override → `collectCommonSentryOptions` reads `SENTRY_DSN` env as
 * before. This runs BEFORE `collectCommonSentryOptions`/`SentryMain.init`.
 */
const resolveGatedDsn = (): string | undefined => {
  const isOss = getPlatformConfig().isOss;
  if (!isOss) {
    // Enterprise: undefined override → collectCommonSentryOptions reads env.
    return undefined;
  }
  let telemetry: { enabled?: boolean; sentryDsn?: string } | undefined;
  try {
    telemetry = getSettings().telemetry;
  } catch {
    // Settings store not wired yet (early boot / test) → no user creds → off.
    telemetry = undefined;
  }
  return resolveSentryDsnForBuild(true, telemetry);
};

/**
 * Self-referential noise guard: the logger/transport itself failed to WRITE a
 * log line because the disk is full (ENOSPC) or file descriptors are exhausted
 * (EMFILE/ENFILE). Reporting "we couldn't write a log" to Sentry is pure
 * self-reference, and the condition is environmental (the user's disk / FD
 * limit) — keep the breadcrumb, drop the event. Scoped to logger/transport
 * frames so a genuine resource-exhaustion error in a data-write path (e.g. a
 * StorageFullError from the asset/content stores, or a storeFactory write) still
 * surfaces. REBEL-15G / REBEL-660 / REBEL-69M class.
 */
const RESOURCE_EXHAUSTION_MESSAGE = /^(ENOSPC|EMFILE|ENFILE):/;
const matchesLoggerTransportFrame = (frameField: string | undefined): boolean => {
  if (!frameField) return false;
  return /core[\\/]logger\b/.test(frameField)
    || frameField.includes('logBuffer')
    || frameField.includes('pino')
    || frameField.includes('sonic-boom')
    || frameField.includes('thread-stream');
};
// Data-write / store paths whose resource-exhaustion failures are REAL signal
// (potential data loss) and must always surface — never treated as logger noise,
// even if a logger frame is also present in the stack (review F3).
const matchesDataStoreFrame = (frameField: string | undefined): boolean => {
  if (!frameField) return false;
  return /storeFactory|settingsStore|assetStore|contentStore|secureTokenStore|sourceMetadataStore|fileIndexService/i.test(frameField);
};
const frameFields = (f: { filename?: string; module?: string; abs_path?: string; function?: string }): Array<string | undefined> =>
  [f.filename, f.module, f.abs_path, f.function];
export const isLoggerWriteResourceExhaustionEvent = (event: Event): boolean => {
  const values = event.exception?.values;
  if (!values || values.length === 0) return false;
  return values.some((e) => {
    if (!e.value || !RESOURCE_EXHAUSTION_MESSAGE.test(e.value)) return false;
    const frames = e.stacktrace?.frames;
    if (!frames || frames.length === 0) return false;
    const hasLoggerFrame = frames.some((f) => frameFields(f).some(matchesLoggerTransportFrame));
    if (!hasLoggerFrame) return false;
    // If a data-store/data-write frame is anywhere in the stack, this is (or
    // includes) a real data-write failure worth surfacing — don't drop it.
    const hasDataStoreFrame = frames.some((f) => frameFields(f).some(matchesDataStoreFrame));
    return !hasDataStoreFrame;
  });
};

/**
 * True when an event is a user-submitted bug report (tagged `source: 'user-bug-report'`
 * by the bug-report handler). Such events must be EXEMPT from `beforeSend`'s
 * message-content drop filters: a user reporting a bug frequently pastes the exact
 * backend error they're seeing (e.g. `Failed query: insert into "rebel"`), and a
 * content-substring filter would otherwise silently filter the very report we need.
 * (Stage 2 of docs/plans/260622_feedback-bug-robustness — "submitted but not in Sentry".)
 */
export const isUserBugReportEvent = (event: Event): boolean =>
  event.tags?.source === 'user-bug-report';

const ensureInitialized = () => {
  if (initAttempted) {
    return;
  }
  initAttempted = true;

  const isOss = getPlatformConfig().isOss;
  // OSS no-phone-home gate: in an OSS build, the DSN comes EXCLUSIVELY from the
  // user's settings.telemetry (and only when enabled). Resolved before
  // collectCommonSentryOptions so the env SENTRY_DSN never leaks into an OSS
  // build, and before any SentryMain.init call.
  const dsnOverride = isOss ? resolveGatedDsn() : undefined;

  const {
    dsn,
    release,
    environment,
    enabled,
    tracesSampleRate,
    profilesSampleRate
  } = collectCommonSentryOptions({
    releaseVersion: safeAppVersion(),
    environment: resolveEnvironment(),
    isPackaged: getPlatformConfig().isPackaged,
    channel: getBuildChannel(),
    ...(isOss ? { dsnOverride } : {})
  });

  if (!dsn) {
    sentryEnabled = false;
    disabledReason = 'no-dsn';
    console.info('[Sentry:Main] Disabled', {
      surface: 'main',
      reason: 'SENTRY_DSN env var not set',
    });
    return;
  }

  if (!enabled) {
    sentryEnabled = false;
    disabledReason = 'env-disabled';
    console.info('[Sentry:Main] Disabled', {
      surface: 'main',
      reason: 'SENTRY_ENABLED disabled Sentry',
    });
    return;
  }

  SentryMain.init({
    autoSessionTracking: true,
    dsn,
    release,
    environment,
    enabled,
    tracesSampleRate,
    profilesSampleRate,
    // PRIVACY (MF-1): do NOT attach `server_name` (defaults to os.hostname(),
    // typically the user's real name on personal machines). This is gated
    // separately from sendDefaultPii. redactSentryEvent also deletes it as a
    // backstop. See docs/plans/260606_bug-report-data-quality.
    includeServerName: false,
    // Use Classic IPC mode to avoid conflict with app's registerSchemesAsPrivileged call
    // Protocol mode (default) requires registerSchemesAsPrivileged which can only be called once
    // See: https://github.com/getsentry/sentry-electron/issues/661
    ipcMode: IPCMode.Classic,
    enableUnresponsive: true,
    enableNative: true,
    shutdownTimeout: 2000,
    maxBreadcrumbs: 200,
    debug: process.env.SENTRY_DEBUG === '1' || Boolean(process.env.MAIN_VITE_SENTRY_DEBUG),
    // Note: preloadInjectionIntegration() is NOT used because it fails with bundled main process.
    // Instead, we manually call hookupIpc() in src/preload/index.ts
    beforeBreadcrumb(breadcrumb) {
      // Redact sensitive data from breadcrumb messages and data
      if (breadcrumb.message) {
        breadcrumb.message = redactSensitiveString(breadcrumb.message);
      }
      if (breadcrumb.data) {
        // PRIVACY (MF-2): log breadcrumbs carry log-binding `data` that pattern
        // redaction alone doesn't fully scrub (content under benign keys). Route
        // them through the same deny-by-default allowlist as the filtered-logs
        // attachment; other breadcrumb categories keep pattern redaction.
        if (breadcrumb.category === 'log') {
          attachLogBreadcrumbData(
            breadcrumb,
            redactLogBreadcrumbData(breadcrumb.data as Record<string, unknown>),
          );
        } else {
          breadcrumb.data = redactObjectDeep(breadcrumb.data) as Record<string, unknown>;
        }
      }
      return breadcrumb;
    },
    beforeSend(event) {
      // Filter out noise: CI-only native crashes that aren't actionable
      // These are Chromium/V8/Node internal crashes in test environment
      if (environment === 'ci-e2e') {
        const isNativeCrash = event.platform === 'native' ||
          event.tags?.['event.environment'] === 'native' ||
          event.exception?.values?.some(e =>
            e.stacktrace?.frames?.some(f =>
              f.function?.includes('v8impl::') ||
              f.function?.includes('partition_alloc') ||
              f.function?.includes('RaiseException') ||
              f.function?.includes('__pthread_kill')
            )
          );
        if (isNativeCrash) {
          return null; // Drop the event
        }
      }

      // EXEMPT user bug reports from the message-content drop(s) below. A user
      // reporting a bug often pastes the exact backend error they're seeing, so a
      // content-substring filter would silently filter the very report we need.
      // (Redaction + oversize handling further down still run for bug reports.)
      const isBugReport = isUserBugReportEvent(event);

      // Filter out server-side errors that shouldn't be in client project
      // These are backend DB errors leaking into client Sentry
      if (!isBugReport && event.message?.includes('Failed query: insert into "rebel"')) {
        return null;
      }

      // Drop self-referential log-write failures (logger/transport hit
      // ENOSPC/EMFILE/ENFILE writing a log line). Environmental + self-referential;
      // breadcrumb retained, event dropped. Scoped to logger frames so genuine
      // resource-exhaustion in data-write paths still surfaces. (REBEL-15G/660/69M)
      if (isLoggerWriteResourceExhaustionEvent(event)) {
        return null;
      }

      const redactedEvent = redactSentryEvent(event as unknown as Record<string, unknown>, {
        onWellFormedFix: ({ replacementCount, replacementPaths, omittedPathCount }) => {
          console.warn('[Sentry:Main] Replaced lone surrogates in outgoing error event', {
            replacementCount,
            replacementPaths,
            omittedPathCount,
          });
        },
      }) as Event;

      const oversizeSummary = summarizeMainOversizedEvent(redactedEvent as unknown as Record<string, unknown>);
      if (oversizeSummary) {
        reportOversizedMainEvent(oversizeSummary);
      }

      return redactedEvent;
    },
    beforeSendTransaction(transaction) {
      // Sweep-only: transactions get UTF-16 well-formedness hardening, no
      // additional redaction semantics. This covers JS error events +
      // transactions on main/renderer; sessions/native paths are separate.
      return sweepSentryPayloadWellFormedness(transaction, 'transaction') as Event;
    }
  } as Parameters<typeof SentryMain.init>[0]);

  SentryMain.getClient()?.on('afterSendEvent', recordSendOutcome);

  SentryMain.setTag('process', 'main');
  SentryMain.setContext('app', {
    version: safeAppVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch
  });

  sentryEnabled = enabled;

  console.info('[Sentry:Main] Enabled', {
    surface: 'main',
    environment,
    release,
    dsnHost: describeSentryDsnForLog(dsn),
  });

  // Log init config in dev for diagnostics (helps debug IPC transport issues)
  if (!getPlatformConfig().isPackaged) {
    console.log('[Sentry:Main] Init:', {
      enabled,
      environment,
      release,
      isPackaged: getPlatformConfig().isPackaged,
      dsnHost: describeSentryDsnForLog(dsn),
    });
  }

  initialized = true;
};

export const initMainSentry = () => {
  ensureInitialized();
};

/**
 * Return the recorded transport outcome for a Sentry event ID.
 *
 * Callers should treat this as a one-shot lookup for a specific event ID after
 * `flush()` completes, rather than polling indefinitely. The accessor
 * intentionally uses touch-on-read (delete + reinsert) instead of consume-and-
 * delete so a slow flush followed by a slow outcome lookup refreshes the LRU
 * slot and does not lose the entry to unrelated send traffic in the meantime.
 */
export const getSendOutcome = (eventId: string | undefined): SentrySendOutcome | undefined => {
  if (!eventId) {
    return undefined;
  }

  const outcome = sendOutcomes.get(eventId);
  if (!outcome) {
    return undefined;
  }

  sendOutcomes.delete(eventId);
  sendOutcomes.set(eventId, outcome);
  return outcome;
};

// Health context updater - set by systemHealthService to avoid circular deps
let healthContextUpdater: (() => Promise<void>) | null = null;

// Rate limiting for health context updates to prevent cascade when errors occur rapidly.
// Without this, each error triggers a health check, which can cause logging, which can
// trigger more errors (e.g., SonicBoom destroyed), creating a performance-killing loop.
let lastHealthContextUpdate = 0;
const HEALTH_CONTEXT_MIN_INTERVAL_MS = 60_000; // 1 minute

export const setHealthContextUpdater = (updater: () => Promise<void>) => {
  healthContextUpdater = updater;
};

const shouldUpdateHealthContext = (): boolean => {
  const now = Date.now();
  if (now - lastHealthContextUpdate > HEALTH_CONTEXT_MIN_INTERVAL_MS) {
    lastHealthContextUpdate = now;
    return true;
  }
  return false;
};

// Maximum size for log attachment (100KB to stay well under Sentry limits)
const MAX_LOG_ATTACHMENT_SIZE = 100_000;

/**
 * Format recent logs as redacted NDJSON for Sentry attachment.
 */
const formatLogsForAttachment = (logs: LogBufferEntry[]): string => {
  const redactedLogs = logs.map((entry) => ({
    ...entry,
    message: redactSensitiveData(entry.message),
    data: entry.data ? redactObjectDeep(entry.data) : undefined
  }));

  let logsText = redactedLogs.map((e) => JSON.stringify(e)).join('\n');

  // Truncate if too large, keeping most recent entries
  if (logsText.length > MAX_LOG_ATTACHMENT_SIZE) {
    logsText = logsText.slice(-MAX_LOG_ATTACHMENT_SIZE);
    // Find first complete line after truncation
    const firstNewline = logsText.indexOf('\n');
    if (firstNewline > 0) {
      logsText = logsText.slice(firstNewline + 1);
    }
  }

  return logsText;
};

const NON_ERROR_EXCEPTION_FALLBACK_MESSAGE = 'Non-error exception captured';
const NON_ERROR_MESSAGE_FIELDS = [
  'message',
  'error_description',
  'description',
  'detail',
  'reason',
] as const;

const extractNonErrorExceptionMessage = (
  value: unknown,
  seen = new Set<object>(),
): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const field of NON_ERROR_MESSAGE_FIELDS) {
    const message = extractNonErrorExceptionMessage(record[field], seen);
    if (message) {
      return message;
    }
  }

  const nestedErrorMessage = extractNonErrorExceptionMessage(record.error, seen);
  if (nestedErrorMessage) {
    return nestedErrorMessage;
  }

  return undefined;
};

export const normalizeErrorForSentryCapture = (
  error: unknown,
): { errorToCapture: Error; isNonError: boolean } => {
  if (error instanceof Error) {
    return { errorToCapture: error, isNonError: false };
  }

  const errorToCapture = new Error(
    extractNonErrorExceptionMessage(error) ?? NON_ERROR_EXCEPTION_FALLBACK_MESSAGE,
  );
  errorToCapture.name = 'NonErrorException';
  return { errorToCapture, isNonError: true };
};

export const captureMainException = (
  error: unknown,
  context?: CaptureContext
): string | undefined => {
  ensureInitialized();
  if (!sentryEnabled) {
    return undefined;
  }

  // Telemetry must NEVER throw into product/lifecycle code. This function is
  // now called from crash handlers (render-process-gone / did-fail-load), where
  // an escaping throw could suppress the very capture it's adding (or destabilise
  // an already-unhealthy app). Belt-and-braces: attachment formatting is tolerant
  // (a bad buffered entry — e.g. a BigInt that breaks JSON.stringify — must not
  // suppress the error capture), and the whole body fails open.
  try {
    // Fire-and-forget health context update for next error (rate-limited)
    // (this error may not have fresh context, but subsequent ones will)
    if (healthContextUpdater && shouldUpdateHealthContext()) {
      healthContextUpdater().catch((e) =>
        ignoreBestEffortCleanup(e, {
          operation: 'captureMainException.healthContextUpdater',
          reason: 'Background health refresh for the NEXT event is best-effort; failure must not affect this capture',
        }),
      );
    }

    // Get recent logs and format as attachment (tolerant: never blocks the capture)
    let logsAttachment: string | null = null;
    try {
      const recentLogs = getRecentLogs();
      logsAttachment = recentLogs.length > 0 ? formatLogsForAttachment(recentLogs) : null;
    } catch (attachErr) {
      ignoreBestEffortCleanup(attachErr, {
        operation: 'captureMainException.formatLogsForAttachment',
        reason: 'Log-attachment formatting must never suppress the error capture itself',
      });
    }

    const { errorToCapture, isNonError } = normalizeErrorForSentryCapture(error);

    // Use withScope to attach logs
    let eventId: string | undefined;
    SentryMain.withScope((scope) => {
      if (logsAttachment) {
        scope.addAttachment({
          filename: 'recent-logs.ndjson',
          data: logsAttachment,
          contentType: 'application/x-ndjson'
        });
      }
      if (isNonError) {
        scope.setExtra('originalNonErrorException', error);
      }
      eventId = SentryMain.captureException(errorToCapture, context);
    });

    return eventId;
  } catch (captureErr) {
    ignoreBestEffortCleanup(captureErr, {
      operation: 'captureMainException',
      reason: 'Telemetry capture must never throw into product or lifecycle (crash) handlers',
    });
    return undefined;
  }
};

/** Capture exception with fresh health context (awaits health check first) */
export const captureMainExceptionWithHealth = async (
  error: unknown,
  context?: CaptureContext
): Promise<string | undefined> => {
  ensureInitialized();
  if (!sentryEnabled) {
    return undefined;
  }

  // Update health context before capturing (rate-limited)
  if (healthContextUpdater && shouldUpdateHealthContext()) {
    try {
      await healthContextUpdater();
    } catch (e) {
      // Health check failed - continue with capture anyway (best-effort context).
      ignoreBestEffortCleanup(e, {
        operation: 'captureMainExceptionWithHealth.healthContextUpdater',
        reason: 'Fresh health context is best-effort; continue capturing without it rather than dropping the event',
      });
    }
  }

  // Tolerant attachment + fail-open capture (see captureMainException above).
  try {
    let logsAttachment: string | null = null;
    try {
      const recentLogs = getRecentLogs();
      logsAttachment = recentLogs.length > 0 ? formatLogsForAttachment(recentLogs) : null;
    } catch (attachErr) {
      ignoreBestEffortCleanup(attachErr, {
        operation: 'captureMainExceptionWithHealth.formatLogsForAttachment',
        reason: 'Log-attachment formatting must never suppress the error capture itself',
      });
    }

    const { errorToCapture, isNonError } = normalizeErrorForSentryCapture(error);

    // Use withScope to attach logs
    let eventId: string | undefined;
    SentryMain.withScope((scope) => {
      if (logsAttachment) {
        scope.addAttachment({
          filename: 'recent-logs.ndjson',
          data: logsAttachment,
          contentType: 'application/x-ndjson'
        });
      }
      if (isNonError) {
        scope.setExtra('originalNonErrorException', error);
      }
      eventId = SentryMain.captureException(errorToCapture, context);
    });

    return eventId;
  } catch (captureErr) {
    ignoreBestEffortCleanup(captureErr, {
      operation: 'captureMainExceptionWithHealth',
      reason: 'Telemetry capture must never throw into product or lifecycle (crash) handlers',
    });
    return undefined;
  }
};

/**
 * Context for raw message captures. Reuses the platform-agnostic
 * `ErrorReporterMessageCaptureContext` (src/core/errorReporter.ts):
 * `level` is REQUIRED and excludes `'info'` — raw info-level message captures
 * are forbidden at compile time, and a level-less capture (which Sentry
 * silently defaults to `'info'`) is equally impossible. Info telemetry goes
 * through `captureKnownCondition` (registry sink policy) or breadcrumbs/the
 * diagnostic ledger. Stages 5–6 of docs/plans/260610_improve-sentry-noise/PLAN.md.
 */
export type MainMessageCaptureContext = ErrorReporterMessageCaptureContext;

export const captureMainMessage = (message: string, context: MainMessageCaptureContext) => {
  ensureInitialized();
  if (!sentryEnabled) {
    return undefined;
  }
  return SentryMain.captureMessage(message, context as CaptureContext);
};

/**
 * Bounded, fail-open flush of queued Sentry events. For pre-exit telemetry
 * (e.g. the fsevents leak-sweep capture in `finalExit.ts`): a capture fired
 * microtasks before `app.exit()` is otherwise mostly lost — the transport's
 * in-flight HTTP request is aborted at process death and the offline queue
 * only persists *failed* sends, not aborted ones. Resolves `false` (never
 * throws) on timeout/failure; callers must treat delivery as best-effort.
 */
export const flushMainSentry = async (timeoutMs = 1500): Promise<boolean> => {
  ensureInitialized();
  if (!sentryEnabled) {
    return true;
  }
  try {
    return await SentryMain.flush(timeoutMs);
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'flushMainSentry',
      reason: 'Pre-exit telemetry flush is best-effort; a flush failure must never block or break the exit path',
    });
    return false;
  }
};

/**
 * Capture a message to Sentry with a log attachment.
 * Used for crash recovery reports where we want to attach pre-crash logs
 * read from disk (as opposed to the in-memory log buffer).
 */
export const captureMainMessageWithLogs = (
  message: string,
  logsContent: string,
  context: MainMessageCaptureContext
): string | undefined => {
  ensureInitialized();
  if (!sentryEnabled) {
    return undefined;
  }

  let eventId: string | undefined;
  SentryMain.withScope((scope) => {
    if (logsContent.length > 0) {
      // Truncate if needed, keeping most recent entries (tail)
      let truncated = logsContent;
      if (truncated.length > MAX_LOG_ATTACHMENT_SIZE) {
        truncated = truncated.slice(-MAX_LOG_ATTACHMENT_SIZE);
        // Find first complete line after truncation to avoid partial NDJSON
        const firstNewline = truncated.indexOf('\n');
        if (firstNewline > 0) {
          truncated = truncated.slice(firstNewline + 1);
        }
      }

      scope.addAttachment({
        filename: 'pre-crash-logs.ndjson',
        data: truncated,
        contentType: 'application/x-ndjson',
      });
    }
    eventId = SentryMain.captureMessage(message, context as CaptureContext);
  });

  return eventId;
};

export const recordMainBreadcrumb = (breadcrumb: Breadcrumb) => {
  ensureInitialized();
  if (!sentryEnabled) {
    return;
  }
  try {
    SentryMain.addBreadcrumb(breadcrumb);
  } catch (error) {
    ignoreBestEffortCleanup(error, {
      operation: 'recordMainBreadcrumb',
      reason: 'Telemetry sink failure must not propagate to product code; breadcrumb is best-effort observability',
    });
  }
};

export const setSentryUser = (user: { id?: string; email?: string | null }) => {
  ensureInitialized();
  if (!sentryEnabled) {
    return;
  }
  const sentryUser: { id?: string; email?: string } = {};
  if (user.id) {
    sentryUser.id = user.id;
  }
  if (user.email) {
    sentryUser.email = user.email;
  }
  if (Object.keys(sentryUser).length > 0) {
    SentryMain.setUser(sentryUser);
  }
};

export const isSentryInitialized = () => initialized;

/** Whether the main-process Sentry client is both initialized and enabled (sending events). */
export const isMainSentryEnabled = (): boolean => {
  ensureInitialized();
  return sentryEnabled;
};

/**
 * Why the main-process Sentry client is disabled, or null when it is enabled.
 * Used to show a truthful message when a bug report can't be sent (a packaged
 * build missing its DSN is not "development mode").
 */
export const getMainSentryDisabledReason = (): MainSentryDisabledReason | null => {
  ensureInitialized();
  return disabledReason;
};

export interface HealthContextSummary {
  status: 'healthy' | 'degraded' | 'critical';
  failedChecks: string[];
  warnChecks: string[];
  mcpMode: string;
  superMcpRunning: boolean;
  hasBundledServers: boolean;
  /** Privacy-safe details from failing/warning health checks (per-check allowlist filtered) */
  safeCheckDetails?: Record<string, Record<string, unknown>>;
  /** Tool counts per safe base server name (e.g. { GoogleWorkspace: 12, Slack: 5 }) */
  toolIndexByServer?: Record<string, number>;
}

export const setHealthContext = (summary: HealthContextSummary) => {
  ensureInitialized();
  if (!sentryEnabled) {
    return;
  }
  SentryMain.setContext('systemHealth', {
    status: summary.status,
    failedChecks: summary.failedChecks,
    warnChecks: summary.warnChecks,
    mcpMode: summary.mcpMode,
    superMcpRunning: summary.superMcpRunning,
    hasBundledServers: summary.hasBundledServers,
    ...(summary.safeCheckDetails && { safeCheckDetails: summary.safeCheckDetails }),
    ...(summary.toolIndexByServer && { toolIndexByServer: summary.toolIndexByServer }),
    capturedAt: new Date().toISOString(),
  });
};

export interface FeatureGatesContext {
  meetingBotUnlocked: boolean | undefined;
  managedCloudEnabled: boolean | undefined;
  mcpServerEnabled: boolean | undefined;
  onboardingCompleted: boolean | undefined;
  indexingEnabled: boolean | undefined;
  capturedAt: string;
}

export const setFeatureGatesContext = (gates: FeatureGatesContext) => {
  ensureInitialized();
  if (!sentryEnabled) {
    return;
  }
  SentryMain.setContext('featureGates', {
    meetingBotUnlocked: gates.meetingBotUnlocked,
    managedCloudEnabled: gates.managedCloudEnabled,
    mcpServerEnabled: gates.mcpServerEnabled,
    onboardingCompleted: gates.onboardingCompleted,
    indexingEnabled: gates.indexingEnabled,
    capturedAt: gates.capturedAt,
  });
};
