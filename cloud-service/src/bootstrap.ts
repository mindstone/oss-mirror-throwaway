/**
 * Cloud bootstrap boundary that wires Node implementations of core interfaces
 * so cloud execution reuses the same business logic contracts as desktop.
 *
 * @see ../../docs/project/CLOUD_ARCHITECTURE.md — service architecture and ops
 * @see ../../docs/project/CROSS_SURFACE_PARITY_CHECKLIST.md — parity constraints
 * @see ../../docs/tutorials/260220_cloud_refactoring_de_electronification.html — boundary split rationale
 */

import path from 'node:path';
import fs from 'node:fs';

// PlatformConfig is initialized by server.ts via './platformInit' BEFORE this
// module loads. Do NOT call setPlatformConfig() here — ESM static imports are
// evaluated before the module body, so any setPlatformConfig() call here would
// run AFTER transitive imports that already need getPlatformConfig().

// Wire all core boundary interfaces before importing any service modules.
import { setErrorReporter, getErrorReporter } from '@core/errorReporter';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { setFeedbackReporter } from '@core/feedbackReporter';
import { installGracefulFsObservability } from '@core/utils/gracefulFsObservability';
import { installGlobalUndiciDnsDecouple } from '@core/utils/dnsThreadpoolDecouple';
import { setStoreFactory } from '@core/storeFactory';
import { setSchedulerFactory } from '@core/scheduler';
import { setAssetStore } from '@core/assetStore';
import { setContentStore } from '@core/contentStore';
import { setCloudCapabilityProbe } from '@core/cloudCapabilityProbe';
import { setSecureTokenStoreFactory } from '@core/secureTokenStore';
import { setProcessSpawnerFactory } from '@core/processSpawner';
import { setPushNotificationSinkFactory } from '@core/pushNotificationSink';
import { setPowerSaveBlockerFactory } from '@core/powerSaveBlocker';
import { setPreTurnWorkerFactory } from '@core/preTurnWorker';
import { setCurrentUserProviderFactory } from '@core/currentUserProvider';
import { setEmbeddingGeneratorFactory } from '@core/embeddingGenerator';
import { setDockBadgeFactory } from '@core/dockBadge';
import { setDesktopNotificationSinkFactory } from '@core/desktopNotificationSink';
import { getWorkspaceFileSystem, setWorkspaceFileSystemFactory } from '@core/workspaceFileSystem';
import { setTracker } from '@core/tracking';
import { getLicenseTier } from '@core/featureGating';
import { buildAnalyticsAttributionProperties } from '@shared/trackingTypes';
// Node-portable analytics client, shared with desktop. The cloud→main import is
// sanctioned (analytics.ts has zero Electron deps; see PLAN.md Refactor Assessment).
import {
  initAnalytics,
  trackMainEvent,
  identifyMainUser,
  getOrGenerateAnonymousId,
  analyticsClientAvailable,
  setAnalyticsContextProvider,
} from '../../src/main/analytics';
import { createScopedLogger } from '@core/logger';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { setIntentionalSwallowSinks } from '@shared/utils/intentionalSwallow';
import { setLiveMeetingTranscriptProvider } from '@core/rebelCore/tools/liveMeetingTranscriptTool';
import { setBroadcastService } from '@core/broadcastService';
import { getCodexAuthProvider, setCodexAuthProvider } from '@core/codexAuth';
import { NULL_REBEL_AUTH_PROVIDER, setRebelAuthProvider } from '@core/rebelAuth';
import { setTokenSyncCoordinator } from '@core/setTokenSyncCoordinator';
import { setTokenSyncTransport } from '@core/setTokenSyncTransport';
import { setCrossProcessLease } from '@core/setCrossProcessLease';
import { setOAuthToolResolver } from '@core/setOAuthToolResolver';
import { TokenSyncCoordinator } from '@core/services/tokenSync/TokenSyncCoordinator';
import { DEFAULT_CODEX_AUTH_PROVIDER } from '@core/services/defaultCodexAuthProvider';
import {
  setDiagnosticEventsLedgerReader,
  setDiagnosticEventsLedgerWriter,
  setDiagnosticEventsSurface,
} from '@core/services/diagnosticEventsLedger';
import { setHandlerRegistry, getHandlerRegistry } from '@core/handlerRegistry';
import { setSafetyEvaluationService } from '@core/safetyEvaluationService';
import { setLicenseTier, type LicenseTier } from '@core/featureGating';
import { getDataPath } from '@core/utils/dataPaths';
import { createSessionLockManager, defaultIsProcessAlive } from '@core/utils/sessionFileLock';
import { resolveMcpConfigPath } from '@core/services/mcp/mcpConfigResolver';
import { resolveProviderBasePath } from '@shared/authRelayConfig';
import { setLogErrorReporter as setCloudClientLogErrorReporter } from '@rebel/cloud-client';
import { validateProviderCredentials } from '@core/utils/validateProviderCredentials';
import { MapHandlerRegistry } from './mapHandlerRegistry';
import { createCloudFeedbackReporter } from './sentryFeedbackReporter';
import type { EventWindow } from '@core/types';
import { upsertSessionsWithLocks } from '@core/services/lockedSessionPersistence';
import { CloudSecureTokenStore } from './services/cloudSecureTokenStore';
import { CloudAssetStore } from './services/assetStoreCloud';
import { CloudContentStore } from './services/contentStoreCloud';
import { getCloudCapabilities } from './capabilities';
import { cloudEventBroadcaster } from './cloudEventBroadcaster';
import { isCloudE2eTestModeEnabled } from './e2eTestMode';
import {
  DEFAULT_E2E_TITLE,
  ensureE2eSession,
  finiteNumber,
  FIXED_E2E_TIMESTAMP,
  isPlainRecord,
  nonEmptyString,
} from './e2eFixturesShared';
import { assertTestDataRootSafe } from './testDataRootGuard';
import { CloudWorkspaceFileSystem } from './services/cloudWorkspaceFileSystem';
import { CloudProcessSpawner } from './services/mcp/cloudProcessSpawner';
import { CloudScheduler } from './services/scheduler/cloudScheduler';
import { CloudPushNotificationSink } from './services/agentTurnSubmissionService';
import { CloudPowerSaveBlocker } from './services/cloudPowerSaveBlocker';
import { CloudPreTurnWorker } from './services/cloudPreTurnWorker';
import { CloudCurrentUserProvider } from './services/cloudCurrentUserProvider';
import { CloudEmbeddingGenerator } from './services/cloudEmbeddingGenerator';
import { CloudDockBadge } from './services/cloudDockBadge';
import { CloudDesktopNotificationSink } from './services/cloudDesktopNotificationSink';
import { CloudFileLockLease } from './services/crossProcessLeaseImpl';
import { CloudOAuthToolResolver } from './services/oauthToolResolverImpl';
import { CloudTokenSyncTransport } from './services/tokenSyncTransportImpl';
import { cloudRollingTranscript } from './services/cloudRollingTranscript';

process.env.REBEL_SURFACE = 'cloud';

import * as Sentry from '@sentry/node';
import { makeNodeTransport } from '@sentry/node';
import { makeOfflineTransport } from '@sentry/core';
import { createCloudSentryOfflineStore } from './sentryOfflineStore';
import { redactObjectDeep, redactSensitiveString, redactSentryEvent } from './services/sentryRedaction';
import { redactLogBreadcrumbData } from '@core/utils/logFieldFilter';
import { attachLogBreadcrumbData } from '@shared/utils/safeTelemetryBreadcrumbData';
import { truncateWellFormed } from '@shared/utils/wellFormedUnicode';
import {
  shouldEnableSentry,
  DEFAULT_TRACES_SAMPLE_RATE,
} from '@shared/telemetry/sentryConfig';

const CLOUD_SENTRY_DSN = process.env.SENTRY_DSN?.trim() || undefined;
// F6 (PLAN Stage 6b): honour the shared Sentry env knobs so cloud has a real
// kill-switch and release/trace overrides instead of hard-coding enabled:true.
// `shouldEnableSentry` is the same parser desktop uses (src/main/sentry.ts):
//   - no DSN              → disabled (unchanged from before)
//   - DSN + SENTRY_ENABLED unset/true → enabled
//   - DSN + SENTRY_ENABLED=0/false/no/off → DISABLED (kill-switch; none existed before)
// `environment: 'cloud'` is intentionally NOT taken from the shared resolver —
// it stays the canonical cloud surface filter (R3 / Decision Log 2026-06-12 16:38).
const cloudSentryEnabled = shouldEnableSentry({ dsn: CLOUD_SENTRY_DSN });
const FLY_INTERNAL_API_BASE = 'https://_api.internal:4280';
export let cloudBootstrapCompletedAtMs: number | null = null;

export function isCloudSentryEnabled(): boolean {
  return cloudSentryEnabled;
}

function describeCloudSentryDsnForLog(dsn: string): string {
  try {
    return new URL(dsn).host;
  } catch {
    return 'configured-dsn';
  }
}

type FetchLike = typeof fetch;

export async function assertSingleFlyMachineRunning(fetchImpl: FetchLike = fetch): Promise<void> {
  if (!process.env.FLY_MACHINE_ID) return;

  const token = process.env.FLY_API_TOKEN;
  if (!token) {
    console.warn(JSON.stringify({ level: 'warn', event: 'fly-self-check-skipped', reason: 'no-token' }));
    return;
  }

  const appName = process.env.FLY_APP_NAME;
  if (!appName) {
    console.warn(JSON.stringify({ level: 'warn', event: 'fly-self-check-skipped', reason: 'no-app-name' }));
    return;
  }

  const ownMachineId = process.env.FLY_MACHINE_ID;

  // Network/API failures must NOT kill boot. The volume-level single-attach
  // guarantee is enforced by Fly itself; this self-check is defense-in-depth.
  // If the internal API is unreachable (DNS, TLS, transient 5xx) or the call
  // throws, downgrade to a soft warning so the service can still start. A hard
  // fail here would crash-loop the machine before the HTTP server can listen,
  // making the failure invisible (Fly's logs only show "Main child exited").
  let machines: Array<{ id?: string; state?: string }>;
  try {
    const response = await fetchImpl(`${FLY_INTERNAL_API_BASE}/v1/apps/${appName}/machines`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      console.warn(JSON.stringify({
        level: 'warn',
        event: 'fly-self-check-skipped',
        reason: 'api-non-2xx',
        status: response.status,
      }));
      return;
    }
    machines = await response.json() as Array<{ id?: string; state?: string }>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'fly-self-check-skipped',
      reason: 'api-error',
      error: message,
    }));
    return;
  }

  const startedMachines = machines.filter((machine) => machine.state === 'started');
  if (startedMachines.length === 0) {
    // Boot race: this machine may not yet be marked `started` when bootstrap
    // runs (Fly transitions through `starting` before the init reports ready).
    // Soft-warn rather than throw — the volume single-attach invariant still
    // holds and a real split-brain would be caught by the next branch on a
    // later boot when state has settled.
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'fly-self-check-skipped',
      reason: 'no-started-machines-yet',
      ownMachineId,
    }));
    return;
  }

  // Single-writer is enforced per-volume by Fly (volumes are single-attach).
  // We tolerate N >= 1 started machines as long as our own machine is among
  // them, which keeps `fly deploy` rolling/in-place strategies working — they
  // transiently run old + new in `started` state before the old machine is
  // stopped. Bailing at runningCount !== 1 caused crash-restart loops on every
  // rolling deploy. See docs/plans/260509_session_event_delta_sync.md Stage 2.
  const ownMachineStarted = startedMachines.some((machine) => machine.id === ownMachineId);
  if (!ownMachineStarted) {
    // Boot race: own machine state may still be `starting` at the time of
    // this fetch even though other started machines exist (rolling deploy
    // shutting down the previous machine). This is NOT a split-brain — it's
    // a transient view of state. Soft-warn instead of throwing so the service
    // can finish booting; the volume single-attach invariant still applies.
    console.warn(JSON.stringify({
      level: 'warn',
      event: 'fly-self-check-skipped',
      reason: 'own-machine-not-yet-started',
      ownMachineId,
      startedCount: startedMachines.length,
    }));
  }
}

// F6 (PLAN Stage 6b): release honours an explicit `SENTRY_RELEASE` env via the
// shared `buildSentryRelease`; absent that, keep the cloud-specific default
// `mindstone-rebel-cloud@<version>` (the shared builder has no 'cloud' channel,
// so we pass the cloud version and only let the env override short-circuit it).
const cloudResolvedVersion =
  process.env.REBEL_VERSION
  || (typeof __REBEL_VERSION__ !== 'undefined' ? __REBEL_VERSION__ : 'unknown');
const cloudSentryRelease =
  process.env.SENTRY_RELEASE?.trim()
  || `mindstone-rebel-cloud@${cloudResolvedVersion}`;

// F6: honour an explicit `SENTRY_TRACES_SAMPLE_RATE` env override while keeping
// cloud's deliberate no-tracing default (0). DEFAULT_TRACES_SAMPLE_RATE is the
// shared parser's result (env-or-0.1); cloud only adopts it when the operator
// set the env explicitly, otherwise stays at 0.
const cloudTracesSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE?.trim()
  ? DEFAULT_TRACES_SAMPLE_RATE
  : 0;

if (cloudSentryEnabled) {
  Sentry.init({
    dsn: CLOUD_SENTRY_DSN,
    // F6: gate on the shared `shouldEnableSentry` result (folded into
    // `cloudSentryEnabled`) so `SENTRY_ENABLED=0` is a true kill-switch.
    enabled: true,
    environment: 'cloud',
    release: cloudSentryRelease,
    tracesSampleRate: cloudTracesSampleRate,
    // C3 (Stage 5): disk-backed offline transport on the Fly `/data` volume.
    // Without it, a cloud instance that can't reach Sentry — the moment a
    // connectivity bug happens — dropped its events permanently (the lossy
    // asymmetry vs desktop main / mobile, both of which persist offline). The
    // store is bounded (≤200 envelopes / ≤20MB, oldest-evicted) so an outage
    // can't fill the volume. `flushAtStartup` replays anything queued from a
    // prior crash/outage as soon as the process comes back. The offline-only
    // options (createStore/flushAtStartup) are injected by wrapping the
    // transport factory, because `init.transportOptions` is typed as the base
    // NodeTransportOptions and doesn't carry the offline fields.
    transport: (nodeTransportOptions) =>
      makeOfflineTransport(makeNodeTransport)({
        ...nodeTransportOptions,
        createStore: createCloudSentryOfflineStore,
        flushAtStartup: true,
      }),
    // PRIVACY (F-parity src/main/sentry.ts:354): do NOT attach `server_name`
    // (defaults to os.hostname()). redactSentryEvent also deletes it as a
    // backstop; this is belt-and-suspenders parity with desktop main.
    includeServerName: false,
    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.message) {
        breadcrumb.message = redactSensitiveString(breadcrumb.message);
      }
      if (breadcrumb.data) {
        // PRIVACY (PM 260607): log breadcrumbs carry logger-binding `data` that
        // pattern redaction alone doesn't fully scrub (content under benign keys).
        // Route them through the same deny-by-default allowlist as desktop main
        // (redactLogBreadcrumbData); other breadcrumb categories keep pattern
        // redaction. Enforced by scripts/check-sentry-breadcrumb-scrub.ts.
        if (breadcrumb.category === 'log' || breadcrumb.category?.startsWith('log.')) {
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
      return redactSentryEvent(event as unknown as Record<string, unknown>, {
        onWellFormedFix: ({ replacementCount, replacementPaths, omittedPathCount }) => {
          console.warn(JSON.stringify({
            level: 'warn',
            event: 'sentry-event-wellformed-normalized',
            replacementCount,
            replacementPaths,
            omittedPathCount,
          }));
        },
      }) as unknown as typeof event;
    },
  });

  // F4 (PLAN Stage 6b): set global, low-cardinality, NON-SECRET scope tags +
  // app/cloud context once after init (desktop parity src/main/sentry.ts:438).
  // These ride every cloud event so the surface/process and deploy coordinates
  // are always present without per-capture wiring. No secrets, no PII.
  Sentry.setTag('surface', 'cloud');
  Sentry.setTag('process', 'cloud-service');
  Sentry.setContext('app', {
    version: cloudResolvedVersion,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  });
  Sentry.setContext('cloud', {
    // Fly deploy coordinates — low-cardinality operational identifiers, not
    // secrets. FLY_IMAGE_REF doubles as the build/commit signal.
    flyAppName: process.env.FLY_APP_NAME ?? null,
    flyMachineId: process.env.FLY_MACHINE_ID ?? null,
    flyRegion: process.env.FLY_REGION ?? null,
    flyImageRef: process.env.FLY_IMAGE_REF ?? null,
  });

  console.info(JSON.stringify({
    level: 'info',
    surface: 'cloud',
    event: 'sentry-enabled',
    environment: 'cloud',
    release: cloudSentryRelease,
    dsnHost: CLOUD_SENTRY_DSN ? describeCloudSentryDsnForLog(CLOUD_SENTRY_DSN) : 'configured-dsn',
  }));
} else {
  console.info(JSON.stringify({
    level: 'info',
    surface: 'cloud',
    event: 'sentry-disabled',
    // Distinguish the two disabled paths so the F6 kill-switch is observable.
    reason: CLOUD_SENTRY_DSN
      ? 'SENTRY_ENABLED env var disabled Sentry'
      : 'SENTRY_DSN env var not set',
  }));
}

function isSentryBreadcrumbLevel(level: string | undefined): level is Sentry.SeverityLevel {
  return level === 'fatal'
    || level === 'error'
    || level === 'warning'
    || level === 'log'
    || level === 'info'
    || level === 'debug';
}

function addSentryBreadcrumb(breadcrumb: {
  category: string;
  message: string;
  level?: string;
  data?: Record<string, unknown>;
}): void {
  if (!cloudSentryEnabled) {
    return;
  }
  const { level, ...rest } = breadcrumb;
  if (isSentryBreadcrumbLevel(level)) {
    Sentry.addBreadcrumb({ ...rest, level });
    return;
  }
  Sentry.addBreadcrumb(rest);
}

/** Upper bound on a scrubbed error string to limit Sentry payload blast radius. */
const MAX_SCRUBBED_ERROR_LENGTH = 2000;

/**
 * Scrub a free-text Super-MCP startup error before it reaches Sentry.
 *
 * Defense-in-depth, applied in this order:
 *  1. Run the SHARED redactor (`redactSensitiveString`) FIRST so secret/token/
 *     email/API-key shapes and HOME-dir paths are normalized regardless of the
 *     Sentry `beforeSend` hook (which a given capture path might bypass). Doing
 *     this first means the structural path scrub below cannot accidentally
 *     "swallow" a secret in a way that defeats secret-shape redaction.
 *  2. Strip identifiers the shared redactor does NOT handle: loopback / host:port
 *     pairs — IPv4 (`127.0.0.1:3100`) AND bracketed IPv6 (`[::1]:3100`,
 *     `[fe80::1]:8080`) — plus non-home absolute filesystem paths (`/data/mcp/...`).
 *  3. Truncate to a bounded length to cap payload size / blast radius.
 *
 * NOTE: paths containing spaces are only partially scrubbed. This is acceptable
 * — cloud paths (`/data/...`) are space-free and HOME dirs are already
 * normalized to `~` in step 1; documenting as a known, low-risk gap.
 */
function scrubSuperMcpErrorText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  let result = redactSensitiveString(text);
  result = result
    // Bracketed IPv6 host:port (port optional). Lookahead requires an inner
    // colon so plain bracketed words like `[abc123]` are not matched.
    .replace(/\[[0-9a-fA-F]*(?::[0-9a-fA-F]*)+\](?::\d+)?/g, '<host:port>')
    // IPv4 host:port (covers 127.0.0.1:3100, 10.x:8080, etc.)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}:\d+\b/g, '<host:port>')
    // localhost:port / 127.0.0.1:port (named loopback or any residual)
    .replace(/\b(?:localhost|127\.0\.0\.1):\d+\b/gi, '<host:port>')
    // absolute filesystem paths with 2+ segments (POSIX), leaving single-segment
    // URL paths like `/mcp` intact since they carry no PII.
    .replace(/\/[^\s:/]+(?:\/[^\s:/]+)+/g, '<path>')
    // Windows absolute paths (C:\...).
    .replace(/[A-Za-z]:\\[^\s]+/g, '<path>');

  if (result.length > MAX_SCRUBBED_ERROR_LENGTH) {
    result = `${truncateWellFormed(result, MAX_SCRUBBED_ERROR_LENGTH)}…[truncated]`;
  }
  return result;
}

/**
 * Part A of REBEL-5ZR: when Super-MCP fails to start, the headless runtime
 * returns no `superMcpUrl` but exposes a `superMcpStartupError`. Super-MCP's
 * own retry-exhaustion capture is gated to contexts that exclude
 * `headless-runtime`, so without this the genuine startup failure is invisible
 * to cloud Sentry. Capture it ONCE here with a DISTINCT fingerprint/tags from
 * the warmup telemetry, with error strings scrubbed of host:port/paths.
 */
function reportSuperMcpStartupFailure(info: SuperMcpStartupErrorInfo): void {
  if (!cloudSentryEnabled) {
    return;
  }
  const scrubbedLastError = scrubSuperMcpErrorText(info.lastError);
  const scrubbedAttemptErrors = (info.attemptErrors ?? []).map((entry) => ({
    attempt: entry.attempt,
    phase: entry.phase,
    error: scrubSuperMcpErrorText(entry.error),
  }));

  const error = new Error(`Super-MCP startup failed: ${scrubbedLastError}`);
  error.name = 'SuperMcpStartupError';

  try {
    Sentry.captureException(error, {
      level: 'error',
      tags: {
        area: 'startup',
        component: 'super-mcp',
        surface: 'cloud',
        startup_context: 'headless-runtime',
        event: 'cloud.super_mcp.startup_failed',
      },
      fingerprint: ['cloud', 'super-mcp', 'startup-failed'],
      extra: {
        attempts: info.attempts,
        portBase: info.portBase,
        portRange: info.portRange,
        lastError: scrubbedLastError,
        attemptErrors: scrubbedAttemptErrors,
      },
    });
  } catch (captureError) {
    console.warn('[bootstrap] Failed to report Super-MCP startup failure', captureError);
  }
}

/**
 * Anomaly capture for the `!superMcpUrl && !superMcpStartupError` case.
 *
 * A missing `superMcpUrl` WITHOUT a `superMcpStartupError` only happens under
 * `skipMcp` in the headless runtime — and cloud NEVER sets `skipMcp`. So on
 * cloud this combination is anomalous and, absent this capture, BOTH the
 * bootstrap startup-failure capture and the (downgraded, non-exception) warmup
 * skip would be effectively silent. Emit a distinct message so the condition
 * can never disappear entirely from cloud Sentry.
 */
function reportSuperMcpUrlMissingWithoutError(): void {
  if (!cloudSentryEnabled) {
    return;
  }
  try {
    Sentry.captureMessage('Super-MCP URL unavailable with no startup error (unexpected on cloud)', {
      level: 'error',
      tags: {
        area: 'startup',
        component: 'super-mcp',
        surface: 'cloud',
        startup_context: 'headless-runtime',
        event: 'cloud.super_mcp.url_missing_no_error',
      },
      fingerprint: ['cloud', 'super-mcp', 'url-missing-no-error'],
    });
  } catch (captureError) {
    console.warn('[bootstrap] Failed to report Super-MCP missing-URL anomaly', captureError);
  }
}

setErrorReporter({
  captureException: (err, ctx) => cloudSentryEnabled
    ? Sentry.captureException(err, ctx as Parameters<typeof Sentry.captureException>[1])
    : undefined,
  captureMessage: (msg, ctx) => cloudSentryEnabled
    ? Sentry.captureMessage(msg, ctx as Parameters<typeof Sentry.captureMessage>[1])
    : undefined,
  addBreadcrumb: addSentryBreadcrumb,
  captureExceptionWithScope: (error, mutate) => {
    if (!cloudSentryEnabled) {
      return;
    }
    Sentry.withScope((scope) => {
      try { mutate(scope); } catch { /* never fail capture on tag errors */ }
      Sentry.captureException(error);
    });
  },
});
setFeedbackReporter(createCloudFeedbackReporter());

// graceful-fs queue observability — drains bootstrap install-failure stash
// and starts the high-frequency queue sampler. Exposed as
// `stopGracefulFsObservability` so server.ts's shutdown() can invoke it.
// See docs/plans/260428_graceful_fs_emfile_fix.md Stage 3.
export const stopGracefulFsObservability = installGracefulFsObservability(
  getErrorReporter(),
  { surface: 'cloud' },
);

// Bridge cloud-client's tag logger (used by modules that also run on mobile)
// to this process's Sentry scope so warn/error lines surface as breadcrumbs.
// Stage 0.3/0.4, docs/plans/260418_cloud_continuity_robustness_and_observability.md.
setCloudClientLogErrorReporter({
  addBreadcrumb: addSentryBreadcrumb,
});

// Wire the intentional-swallow observability sinks for cloud (mirrors
// src/main/bootstrap.ts). Without this, ignoreBestEffortCleanup() — the
// sanctioned alternative the no-silent-swallow lint steers developers toward —
// would degrade to console.debug on cloud (no structured log, no Sentry
// breadcrumb). Must be wired before/with enabling the rule on cloud-service.
// See docs/plans/260531_silent_swallow_lint_surface_coverage.md A-F4.
const intentionalSwallowLog = createScopedLogger({ service: 'intentional-swallow' });
setIntentionalSwallowSinks({
  log: (level, message, context) => {
    if (level === 'warn') {
      intentionalSwallowLog.warn(context, message);
      return;
    }
    intentionalSwallowLog.debug(context, message);
  },
  breadcrumb: (message, context) => {
    addSentryBreadcrumb({
      category: 'silent_fallback',
      level: context.severity === 'warn' ? 'warning' : 'debug',
      message,
      data: context,
    });
  },
});

// JSON-file-based store factory -- reuses the cloud shim's Store class.
import CloudStore from './electronStoreShim';
setStoreFactory((opts) => new CloudStore(opts as any) as any);
setSchedulerFactory(() => new CloudScheduler());
setSecureTokenStoreFactory(() => new CloudSecureTokenStore());
setWorkspaceFileSystemFactory(() => new CloudWorkspaceFileSystem());
setProcessSpawnerFactory(() => new CloudProcessSpawner());
setPushNotificationSinkFactory(() => new CloudPushNotificationSink());
setPowerSaveBlockerFactory(() => new CloudPowerSaveBlocker());
setPreTurnWorkerFactory(() => new CloudPreTurnWorker());
setCurrentUserProviderFactory(() => new CloudCurrentUserProvider());
setEmbeddingGeneratorFactory(() => new CloudEmbeddingGenerator());
setDockBadgeFactory(() => new CloudDockBadge());
setDesktopNotificationSinkFactory(() => new CloudDesktopNotificationSink());
// Real Codex auth provider — cloud/mobile use the SAME implementation as
// desktop. Refresh + getters are pure HTTP. The interactive OAuth login flow
// still runs on desktop only; the resulting tokens reach cloud via
// POST /api/codex/tokens (desktop → cloud sync).
setCodexAuthProvider(DEFAULT_CODEX_AUTH_PROVIDER);
setRebelAuthProvider(NULL_REBEL_AUTH_PROVIDER);
const stage2CrossProcessLease = new CloudFileLockLease();
const stage2OAuthToolResolver = new CloudOAuthToolResolver();
const stage2TokenSyncTransport = new CloudTokenSyncTransport();
const TOKEN_SYNC_PROVIDER_TO_RELAY_PROVIDER = {
  google: 'google-workspace',
  slack: 'slack',
  hubspot: 'hubspot',
  microsoft: 'microsoft',
} as const;

const stage2TokenSyncCoordinator = new TokenSyncCoordinator({
  surface: 'cloud',
  transport: stage2TokenSyncTransport,
  lease: stage2CrossProcessLease,
  logger: createScopedLogger({ service: 'token-sync-coordinator' }),
  tokenRootResolver: (provider) => {
    const relayProvider =
      TOKEN_SYNC_PROVIDER_TO_RELAY_PROVIDER[
        provider as keyof typeof TOKEN_SYNC_PROVIDER_TO_RELAY_PROVIDER
      ];
    if (!relayProvider) return '';
    return resolveProviderBasePath(relayProvider, getDataPath(), '');
  },
});

setTokenSyncCoordinator(stage2TokenSyncCoordinator);
setTokenSyncTransport(stage2TokenSyncTransport);
setCrossProcessLease(stage2CrossProcessLease);
setOAuthToolResolver(stage2OAuthToolResolver);

// Real RudderStack tracker over the shared Node analytics client (mirrors
// desktop's wiring in src/main/index.ts:914-927). The adapter may wire here at
// module-top, but `initAnalytics()` + `setAnalyticsContextProvider()` are
// deferred into bootstrap() (after setLicenseTier + settings normalization) so
// the context provider reads license/settings at call time, not wire time.
setTracker({
  track: (event, props) => trackMainEvent({
    anonymousId: getOrGenerateAnonymousId(),
    event,
    properties: props as Parameters<typeof trackMainEvent>[0]['properties'],
  }),
  identify: (userId, traits) => identifyMainUser({
    anonymousId: getOrGenerateAnonymousId(),
    userId,
    traits: traits as Parameters<typeof identifyMainUser>[0]['traits'],
  }),
  getAnonymousId: () => getOrGenerateAnonymousId(),
  isAvailable: () => analyticsClientAvailable(),
});
import {
  cloudDiagnosticEventsLedgerReader,
  cloudDiagnosticEventsLedgerWriter,
} from './services/cloudDiagnosticEventsLedger';
// dynamic-broadcast-reviewed: the cloud-side BroadcastService adapter — wires
// `sendToAllWindows`/`sendToFocusedWindow` to the cloud→desktop WS fan-out. It forwards whatever
// `channel` core/cloud code emits (each declared at its own literal/resolved-constant emit-site);
// the desktop CLOUD_PUSH_ALLOWLIST fail-closes the receive end, so this seam adds no channel itself.
setBroadcastService({
  sendToAllWindows: (channel, ...args) => cloudEventBroadcaster.broadcast(channel, ...args),
  // dynamic-broadcast-reviewed: sibling forwarder of the adapter above — same channel-passthrough contract.
  sendToFocusedWindow: (channel, ...args) => cloudEventBroadcaster.broadcast(channel, ...args),
});
setHandlerRegistry(new MapHandlerRegistry());
setDiagnosticEventsLedgerWriter(cloudDiagnosticEventsLedgerWriter);
setDiagnosticEventsLedgerReader(cloudDiagnosticEventsLedgerReader);
setDiagnosticEventsSurface('cloud');

import type { AppSettings, AgentSession, AgentEvent, AgentTurnRequest, AgentSessionSummary } from '@shared/types';
import { ensureNormalizedSettings, getSettings, settingsStore, updateSettings, runCodexProviderHealAtBoot } from '@core/services/settingsStore/index';
import { hasCodexTokens } from '@core/services/codexTokenStorage';
import { getManagedKeyAvailability, registerManagedKeyAvailability } from '@core/rebelCore/managedKeyAvailability';
// Layer 3 (DI-05 cloud parity): cloud serves the Mindstone managed subscription
// by reading the relayed managed key out of the SAME `createStore`-backed store
// the proxy resolves it from (`localModelProxyServer` → `loadManagedOpenRouterKey`,
// already running on cloud). Mirrors desktop's `behindTheScenesClient.ts:29`.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- allowlisted in scripts/check-cross-surface-imports.ts
import { hasManagedOpenRouterKey } from '@main/services/openRouterTokenStorage';
import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import { createBtsSafetyEvalService } from '@core/services/safety/btsSafetyEvalService';
import { getSystemSettingsPath } from '@core/services/systemSettingsSync';
import { configurePromptFileService, warmAllPrompts } from '@core/services/promptFileService';

// Wire the Electron-shim-backed settings store into the core adapter so @core
// modules can access settings without depending on electron-store directly.
// IMPORTANT: getSettings/updateSettings come from the canonical
// @core/services/settingsStore/index implementation, NOT from
// @core/services/settingsStore (which is the adapter wrapper that delegates
// to this adapter — importing from there would create infinite recursion).
//
// `updateSettingsAtomic`: cloud is the authoritative store for its surface, so
// `options.sync` is a no-op (no further dual-write is required). The
// functional updater runs synchronously under the single-threaded event loop
// so two callers can safely race their atomic updates.
//
// See docs/plans/260503_unify_learned_limits_into_profiles.md — Auto-Create
// Policy → Storage boundary (Findings Q, R).
setSettingsStoreAdapter({
  getSettings,
  updateSettings,
  updateSettingsAtomic: (updater, _options) => {
    const partial = updater(getSettings());
    if (Object.keys(partial).length === 0) return;
    updateSettings(partial);
  },
  onSettingsChange: (callback) => {
    if (settingsStore.onDidAnyChange) {
      return settingsStore.onDidAnyChange((newSettings) => {
        if (newSettings) callback(newSettings);
      });
    }
    return () => {};
  }
});
// Codex-backed safety models route through the cloud Codex auth provider wired above.
// See: docs/plans/260428_safety_eval_unavailable_codex_token_corruption.md (Stage 3)
setSafetyEvaluationService(createBtsSafetyEvalService());

// ── Cloud analytics identity (Stage 3) ────────────────────────────────────────
// Identify the cloud owner in RudderStack from the real owner email
// (`settings.userEmail`, which dual-writes desktop→cloud via cloudChannelPolicies
// 'settings:update'). Mirrors desktop's email-keyed identify
// (src/main/services/userProfileService.ts:37-45 — lowercase, identify). When no
// email is known we deliberately do NOT identify — but the degraded state is
// OBSERVABLE (one-time WARN + Sentry `identity` tag), not silent (repo principle:
// silent degradation is a bug; PLAN A1/DA3). Placed below the settings-store +
// @main/analytics imports so all referenced bindings are already in scope.
const cloudAnalyticsIdentityLog = createScopedLogger({ component: 'cloud-analytics-identity' });
const bootstrapLog = createScopedLogger({ service: 'cloud-bootstrap' });

// Basic email shape check — mirrors userProfileService.ts:23.
const CLOUD_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// One-time-per-state guards so neither the WARN nor the identify spams on every
// settings change / re-evaluation. `null` = not yet evaluated this process.
let cloudAnalyticsIdentityState: 'identified' | 'anon-only' | null = null;
let cloudAnalyticsIdentifiedEmail: string | null = null;

/**
 * Set (or flip) the Sentry `identity` tag so the anon-only degraded state is
 * visible in error monitoring. Guarded on `cloudSentryEnabled` — never throws.
 */
function setCloudIdentitySentryTag(value: 'identified' | 'anon-only'): void {
  if (!cloudSentryEnabled) return;
  try {
    Sentry.setTag('identity', value);
  } catch (err) {
    // Best-effort: a Sentry tag failure must never break analytics identity.
    // Recorded via the intentional-swallow sink so it stays observable.
    ignoreBestEffortCleanup(err, {
      operation: 'cloud-analytics-identity:set-sentry-tag',
      reason: 'Sentry tag set is non-fatal; identity already applied to analytics',
    });
  }
}

/**
 * F3 (Stage 6a) — set the Sentry user scope so error events carry the cloud
 * owner attribution, mirroring desktop's `setSentryUser` (src/main/sentry.ts:790,
 * called from src/main/index.ts:7452). Shares the SAME `settings.userEmail`
 * identity source as analytics identify (Stage 3), so the anon-only→identified
 * flip ALSO updates the Sentry user. When anon-only, we still set `id` (the
 * stable, non-secret analytics anon-id) with no email. Guarded on
 * `cloudSentryEnabled`; never throws.
 */
function setCloudSentryUser(email: string | null): void {
  if (!cloudSentryEnabled) return;
  try {
    const sentryUser: { id?: string; email?: string } = {};
    // Stable, non-secret per-instance id (also feeds analytics anon-id).
    const anonId = getOrGenerateAnonymousId();
    if (anonId) sentryUser.id = anonId;
    if (email) sentryUser.email = email;
    if (Object.keys(sentryUser).length > 0) {
      Sentry.setUser(sentryUser);
    }
  } catch (err) {
    // Best-effort: a Sentry user-scope failure must never break analytics identity.
    ignoreBestEffortCleanup(err, {
      operation: 'cloud-analytics-identity:set-sentry-user',
      reason: 'Sentry setUser is non-fatal; identity already applied to analytics',
    });
  }
}

/**
 * Evaluate `settings.userEmail` and either identify the cloud owner in analytics
 * (surface-tagged traits — MA3) or fall back to anon-id-only with an OBSERVABLE
 * one-time WARN + Sentry `identity:'anon-only'` tag (DA3). Safe to call on boot
 * and on every settings change; transitions are de-duped so logs don't spam.
 */
export function applyCloudAnalyticsIdentity(): void {
  const rawEmail = getSettings().userEmail?.trim();
  const email = rawEmail ? rawEmail.toLowerCase() : '';
  const hasValidEmail = email.length > 0 && CLOUD_EMAIL_REGEX.test(email);

  if (hasValidEmail) {
    // Re-identify only when the email is new (covers: anon-only→identified, and
    // an owner-email change). identifyMainUser is itself idempotent on the alias,
    // but we avoid redundant identify calls per settings change.
    if (cloudAnalyticsIdentityState === 'identified' && cloudAnalyticsIdentifiedEmail === email) {
      return;
    }
    // MA3: route surface into the identify traits explicitly. The
    // setAnalyticsContextProvider chokepoint feeds trackMainEvent but NOT
    // identifyMainUser, so identify traits would otherwise be surface-untagged.
    identifyMainUser({
      anonymousId: getOrGenerateAnonymousId(),
      userId: email,
      traits: { email, surface: process.env.REBEL_SURFACE ?? 'cloud' },
    });
    cloudAnalyticsIdentityState = 'identified';
    cloudAnalyticsIdentifiedEmail = email;
    setCloudIdentitySentryTag('identified');
    // F3: fold the owner email into the Sentry user scope (same source).
    setCloudSentryUser(email);
    cloudAnalyticsIdentityLog.info(
      { event: 'cloud.analytics.identified', surface: process.env.REBEL_SURFACE ?? 'cloud' },
      'Cloud analytics identified owner by email',
    );
    return;
  }

  // No valid owner email yet → anon-id-only. Emit a one-time WARN per state so
  // the degraded identity is observable but not spammy (DA3).
  if (cloudAnalyticsIdentityState !== 'anon-only') {
    cloudAnalyticsIdentityState = 'anon-only';
    cloudAnalyticsIdentifiedEmail = null;
    setCloudIdentitySentryTag('anon-only');
    // F3: anon-only → Sentry user carries just the stable anon id, no email.
    setCloudSentryUser(null);
    cloudAnalyticsIdentityLog.warn(
      { event: 'cloud.analytics.identify_anon_only', reason: 'no_user_email' },
      'Cloud analytics running anon-id-only — no owner email synced yet; events carry surface:cloud but no identify',
    );
  }
}

/**
 * Test-only reset of the one-time identity guards so each test starts from the
 * "not yet evaluated" state.
 */
export function __resetCloudAnalyticsIdentityForTests(): void {
  cloudAnalyticsIdentityState = null;
  cloudAnalyticsIdentifiedEmail = null;
}
import { getIncrementalSessionStore } from '@core/services/incrementalSessionStore';
import type { SessionDeleteOptions } from '@core/services/incrementalSessionStore';
import type { AgentTurnServiceDeps, StartAgentTurnResult } from '@core/services/agentTurnService';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { executeAgentTurn } from '@core/services/turnPipeline/agentTurnExecute';
import { derivePolicy } from '@core/services/turnPolicy';
import { dispatchAgentEvent } from '@core/services/agentEventDispatcher';
import { runRecoveryPipeline } from '@core/services/recovery/recoveryPipeline';
import type { AgentLoopOptions } from '@core/services/recovery/recoveryAdapter';
import type { RecoveryContext, RecoveryPhase } from '@core/services/recovery/recoveryStateMachine';
import { createCloudRecoveryAdapter } from './services/cloudRecoveryAdapter';
import { createHeadlessRuntime, type SuperMcpStartupErrorInfo } from '@core/services/headlessRuntime';
import type { MemoryUpdateDeps } from '@core/services/memoryUpdateService';
import { createMemoryWriteHook } from '../../src/main/services/safety';
import { createMcpDenyHook } from '@core/services/safety/mcpDenyHook';
import { resolveMemoryBtsTurnOverride } from '@shared/utils/memoryBtsTurnOverride';
import { clearServerClockSession, seedServerClock, stampCloudUpdatedAt } from '@core/services/continuity/serverClock';
import { getMaxSeqFromSession, getSessionSeqIndex } from '@core/services/continuity/sessionSeqIndex';
import { getOutboxStallMonitor } from '@core/services/continuity/outboxStallMonitor';
import { getSessionTombstoneStore } from '@core/services/continuity/sessionTombstoneStore';
import { createCleanupLeakedSessionDeletedCallback } from './services/cleanupLeakedSessionsBridge';
import { initExternalConversationService } from './services/externalConversationServiceFactory';
import { cloudBootstrapWarmup } from './services/cloudBootstrapWarmup';
import { recordCloudBootHistory } from './health/pressureSampler';
import type { CloudBootRecord } from '@shared/types/cloudHealth';

export interface CloudServiceDeps {
  startAgentTurn: (
    deps: AgentTurnServiceDeps,
    request: AgentTurnRequest,
    win: EventWindow | null,
  ) => StartAgentTurnResult;
  getActiveTurnController: (turnId: string) => AbortController | undefined;
  /** Get the Query.close() callback for force-kill escalation */
  getTurnCloseCallback: (turnId: string) => (() => void) | undefined;
  setEventListener: (turnId: string, listener: (event: AgentEvent) => void) => void;
  subscribeTurnEvents: (turnId: string, listener: (event: AgentEvent) => void) => () => void;
  agentTurnServiceDeps: AgentTurnServiceDeps;
  loadSessions: () => Promise<AgentSession[]>;
  listSessions: () => AgentSessionSummary[];
  getSession: (id: string) => Promise<AgentSession | null>;
  upsertSession: (session: AgentSession) => Promise<void>;
  /** Stage 3: pass-through deps wiring — carries the calling route's REQUIRED delete intent. */
  deleteSession: (id: string, options: SessionDeleteOptions) => Promise<void>;
  /**
   * Stage 3 test-reset seam: clears the store's hard-delete ledger so E2E
   * `resetSessions` can reseed previously-deleted fixture ids (e.g.
   * DEFAULT_E2E_SESSION_ID) without silent drops. E2E-test-mode only.
   */
  clearHardDeleteLedgerForTestReset?: () => void;
  getSettings: () => AppSettings;
  updateSettings: (partial: Partial<AppSettings>) => void;
  /**
   * Re-evaluate cloud analytics owner identity after an inbound settings update
   * has been applied. The cloud `settingsStore` shim has no change-event seam
   * (`onDidAnyChange` is unimplemented), so this route-level hook is how a
   * desktop→cloud `userEmail` dual-write flips anon-only → identified without a
   * restart. Points at `applyCloudAnalyticsIdentity` (idempotent on same email).
   */
  refreshAnalyticsIdentity: () => void;
  listFiles: () => Promise<unknown>;
  readFile: (target: string) => Promise<string>;
  writeFile: (payload: { path: string; content: string }) => Promise<{ success: boolean }>;
  e2eSeed?: CloudE2eSeedOps;
  cleanup?: () => Promise<void>;
}

export type CloudE2eSeedInput = Record<string, unknown>;

export interface CloudE2eSeedOps {
  seedToolApproval(input: CloudE2eSeedInput): Promise<{ toolUseID: string; sessionId: string }>;
  seedStagedFileConflict(input: CloudE2eSeedInput): Promise<{ sessionId: string; destinationPath: string }>;
  resetSafetyFixtures(): Promise<{
    clearedToolApprovals: number;
    clearedMemoryApprovals: number;
    clearedStagedFiles: number;
  }>;
}

type CloudErrorRecoveryDeps = {
  executeAgentTurn: (
    turnId: string,
    prompt: string,
    options: {
      sessionId: string;
      bypassToolSafety?: boolean;
      readOnlyHook?: AgentLoopOptions['memoryWriteHook'];
      onEvent: (event: AgentEvent) => void;
    },
  ) => Promise<void>;
  getSettings: () => AppSettings;
  notifyRenderer?: (state: unknown) => void;
};

function resolveCloudBootKind(): CloudBootRecord['kind'] {
  // Stage E has not yet wired a self-update marker into boot-history writes.
  // Until selfUpdateScheduler (or equivalent) emits that signal, boots remain
  // in the normal/unknown bucket and never claim the reserved 'self-update' kind.
  return 'unknown';
}

async function createCloudE2eSeedOps(
  deps: Pick<CloudServiceDeps, 'getSession' | 'upsertSession' | 'writeFile'>,
): Promise<CloudE2eSeedOps> {
  const pendingApprovalsStore = await import('@main/services/safety/pendingApprovalsStore');
  const cosPendingService = await import('@main/services/safety/cosPendingService');

  return {
    async seedToolApproval(input) {
      const sessionId = nonEmptyString(input.sessionId) ?? 'e2e-tool-approval-session';
      await ensureE2eSession(deps, sessionId, nonEmptyString(input.title) ?? DEFAULT_E2E_TITLE);

      const toolName = nonEmptyString(input.toolName) ?? 'send_email';
      const toolUseID = nonEmptyString(input.toolUseID) ?? nonEmptyString(input.toolUseId) ?? 'e2e-tool-approval-1';
      // Principle-option determinism is intentionally out of scope for this
      // seed seam; mobile generates those options later through
      // safety-prompt:generate-options.
      const request = {
        toolUseID,
        turnId: nonEmptyString(input.turnId) ?? `${sessionId}-turn-tool-approval`,
        sessionId,
        toolName,
        input: isPlainRecord(input.input)
          ? input.input
          : {
              to: 'alex@example.com',
              subject: 'Quarterly plan',
              body: 'Here is the plan.',
            },
        reason: nonEmptyString(input.reason) ?? 'Safety Rules blocked: Sending email needs your approval.',
        timestamp: finiteNumber(input.timestamp) ?? FIXED_E2E_TIMESTAMP + 10,
        allowPermanentTrust: true,
        effectiveToolId: nonEmptyString(input.effectiveToolId) ?? toolName,
        blockedBy: 'safety_prompt' as const,
        riskLevel: 'high',
        packageName: nonEmptyString(input.packageName) ?? 'Email',
        conversationTitle: nonEmptyString(input.conversationTitle) ?? DEFAULT_E2E_TITLE,
      };

      pendingApprovalsStore.addPendingApproval(request);
      cloudEventBroadcaster.broadcast('tool-safety:approval-request', request);
      return { toolUseID, sessionId };
    },

    async seedStagedFileConflict(input) {
      const sessionId = nonEmptyString(input.sessionId) ?? 'e2e-staged-conflict-session';
      await ensureE2eSession(deps, sessionId, nonEmptyString(input.title) ?? DEFAULT_E2E_TITLE);

      const destinationPath = nonEmptyString(input.destinationPath) ?? 'E2E/staged-conflict.md';
      const baseContent = nonEmptyString(input.baseContent) ?? '# E2E conflict\n\nOriginal workspace version.\n';
      const stagedContent = nonEmptyString(input.stagedContent) ?? '# E2E conflict\n\nRebel staged version.\n';
      const remoteContent = nonEmptyString(input.remoteContent)
        ?? '# E2E conflict\n\nChanged on disk after staging.\n';

      const baseWrite = await deps.writeFile({ path: destinationPath, content: baseContent });
      if (!baseWrite.success) {
        throw new Error('Failed to write E2E staged-file conflict base content');
      }

      const pendingFile = await cosPendingService.writeToPending({
        destinationPath,
        content: stagedContent,
        sessionId,
        summary: nonEmptyString(input.summary) ?? 'E2E staged file conflict',
        spaceName: nonEmptyString(input.spaceName) ?? 'E2E',
        blockedBy: 'safety_prompt',
        approvalKind: 'memory_write',
        toolUseId: nonEmptyString(input.toolUseId) ?? 'e2e-staged-conflict-tool-1',
      });

      if (!pendingFile) {
        throw new Error('Failed to seed E2E staged-file conflict pending file');
      }

      const divergentWrite = await deps.writeFile({ path: destinationPath, content: remoteContent });
      if (!divergentWrite.success) {
        throw new Error('Failed to write E2E staged-file conflict divergent content');
      }

      cloudEventBroadcaster.broadcast('memory:staged-files-changed', {});
      return { sessionId, destinationPath };
    },

    async resetSafetyFixtures() {
      const clearedToolApprovals = pendingApprovalsStore.getPendingApprovals().length;
      const clearedMemoryApprovals = pendingApprovalsStore.getPendingMemoryApprovals().length;
      const stagedFiles = await cosPendingService.listPendingFiles();

      pendingApprovalsStore.clearAllPendingApprovals();
      pendingApprovalsStore.clearAllPendingMemoryApprovals();
      for (const file of stagedFiles) {
        await cosPendingService.deletePendingFile(file.id);
      }
      if (stagedFiles.length > 0) {
        cloudEventBroadcaster.broadcast('memory:staged-files-changed', {});
      }

      return {
        clearedToolApprovals,
        clearedMemoryApprovals,
        clearedStagedFiles: stagedFiles.length,
      };
    },
  };
}

export async function bootstrap(): Promise<CloudServiceDeps> {
  process.env.REBEL_SURFACE = 'cloud';
  const bootstrapStart = Date.now();

  // Decouple outbound DNS from the libuv threadpool BEFORE any outbound HTTP.
  // assertSingleFlyMachineRunning() below is the first outbound fetch, so this
  // must run first. Same root cause/fix as desktop boot — see
  // docs/plans/260617_meeting-bot-dns-starvation/PLAN.md.
  installGlobalUndiciDnsDecouple();

  setAssetStore(new CloudAssetStore());
  setContentStore(new CloudContentStore());
  // Cloud is its own server, so the probe always reports its own capability
  // list. This is what producers running inside cloud-service consult.
  setCloudCapabilityProbe(() => getCloudCapabilities());

  await assertSingleFlyMachineRunning();

  const dataPath = process.env.REBEL_USER_DATA || '/data';
  if (isCloudE2eTestModeEnabled()) {
    assertTestDataRootSafe(process.env.REBEL_USER_DATA, { label: 'cloud bootstrap REBEL_USER_DATA' });
  }
  recordCloudBootHistory(resolveCloudBootKind());
  const licenseTier: LicenseTier = process.env.REBEL_LICENSE_TIER === 'teams' ? 'teams' : 'free';
  setLicenseTier(licenseTier);
  console.log(`[bootstrap] License tier set to ${licenseTier}`);

  for (const dir of ['sessions', 'workspace', 'logs', 'mcp']) {
    const fullPath = path.join(dataPath, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }

  ensureNormalizedSettings();

  // FOX-3494 (F1 follow-up — cloud-startup codex provider heal). Symmetric with
  // the desktop boot heal (src/main/index.ts → runCodexProviderHealAtBoot). A
  // cloud/mobile-primary user whose codex tokens are ALREADY present but whose
  // `activeProvider` drifted off 'codex' (e.g. to 'anthropic'/undefined) has no
  // other heal trigger: the cloud token-POST heal (routes/codexTokens.ts) only
  // fires when desktop re-POSTs a token, and a desktop that never refreshes
  // leaves them stranded indefinitely. This one-shot, version-gated startup heal
  // closes that gap using the SAME core helper + verdict as desktop boot.
  //
  // MUST run AFTER ensureNormalizedSettings() (so the normalized
  // `activeProvider` / legacy-OpenRouter shape is read). `hasCodexTokens()` is
  // already wired at module-top via setStoreFactory + setSecureTokenStoreFactory.
  // The managed-key seam is wired immediately below, BEFORE this heal reads it,
  // so the heal reads a properly-wired seam rather than tripping the leaf
  // module's `managed-key-availability-unwired` error marker on every boot.
  // (Previously this registration lived in the BTS block lower down, which runs
  // AFTER the heal — leaving the seam unwired at heal time.)
  //
  // Layer 3 (DI-05 cloud parity) is now LIVE: cloud reads the live store via
  // `hasManagedOpenRouterKey()` — the SAME provider desktop wires in
  // `behindTheScenesClient.ts:29`. The managed key is relayed here by desktop
  // (`POST /api/openrouter/managed-key`, Stage L3b) and resolved out-of-band by
  // the proxy that runs on cloud, so a present key makes `mindstone` turns
  // dispatchable instead of collapsing to `missing-mindstone`. This is real
  // cross-surface parity (no more constant `() => false` stub / parity-gate
  // exemption). The store is plaintext base64 at rest on cloud (no safeStorage);
  // accepted per the 2026-06-23 user decision (relay the same desktop key,
  // unconditional, no `managedCloudEnabled` gate).
  registerManagedKeyAvailability(() => hasManagedOpenRouterKey());
  try {
    runCodexProviderHealAtBoot({
      codexConnected: hasCodexTokens(),
      hasManagedKey: getManagedKeyAvailability(),
      logger: bootstrapLog,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    bootstrapLog.error(
      { event: 'cloud.codex_provider_heal.failed', reason },
      'Cloud codex provider heal at startup failed — continuing boot',
    );
  }

  const settings = getSettings();
  if (!settings.coreDirectory) {
    const workspacePath = path.join(dataPath, 'workspace');
    updateSettings({ coreDirectory: workspacePath });
    console.log(`[bootstrap] Set coreDirectory to ${workspacePath}`);
  }

  // ── Configure + warm externalized prompt files (cross-surface parity with
  //    desktop coreStartup §4b). Pins the prompts root to
  //    `getSystemSettingsPath()/prompts` (resolves to /app/rebel-system/prompts
  //    in the Fly image — IS_CLOUD_SERVICE=1 → dev-mode path → WORKDIR /app) and
  //    pre-reads every registered prompt so the first safety/title/memory turn
  //    isn't a cold read. This removes the once-per-boot lazy-fallback warn the
  //    `ensureConfigured()` default emits when cloud reads a prompt unwired.
  //
  //    MUST be non-fatal. In production PlatformConfig is wired by
  //    server.ts → './platformInit' BEFORE bootstrap() runs, so
  //    getSystemSettingsPath() resolves cleanly. But the cloud bootstrap test
  //    harnesses invoke bootstrap() WITHOUT setPlatformConfig() (deliberately —
  //    see bootstrap.headlessRuntime.test.ts regression guard), and
  //    getSystemSettingsPath() → isPackaged()/getAppRoot() read
  //    getPlatformConfig() (throws 'PlatformConfig not initialized' when
  //    unwired). The same try/catch posture as the analytics init guard below
  //    keeps boot resolving. This is NOT a silent swallow: the catch splits BY
  //    ERROR REASON (not test-env coupling) — an unwired-PlatformConfig throw is
  //    the EXPECTED harness state and logs at WARN, while ANY OTHER error (e.g. a
  //    missing `critical:true` safety prompt, on which warmAllPrompts() throws)
  //    is a genuine warm failure and stays LOUD at error level so it isn't
  //    masked. NOTE: critical-prompt failure stays non-fatal until the
  //    deferred boot-semantics product decision lands (refuse-boot /
  //    readiness-fail vs warn — mirrors desktop's current non-fatal behaviour).
  try {
    const promptsPath = path.join(getSystemSettingsPath(), 'prompts');
    configurePromptFileService(promptsPath);
    await warmAllPrompts();
    console.log('[bootstrap] Prompt file service configured and warmed');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Distinguish BY ERROR REASON (F3), not by test-env coupling: an UNWIRED
    // PlatformConfig ('PlatformConfig not initialized') is the EXPECTED state in
    // the cloud bootstrap test harnesses (they run bootstrap() without
    // setPlatformConfig()) — log it at WARN (a real prod platformInit break
    // would surface loud through the many other bootstrap paths that read
    // PlatformConfig anyway). Any OTHER error — e.g. warmAllPrompts() throwing on
    // a missing `critical: true` safety prompt — is a genuine warm failure and
    // stays at ERROR so it isn't masked.
    if (reason.includes('PlatformConfig not initialized')) {
      bootstrapLog.warn(
        { event: 'cloud.prompt_warm.skipped_unwired', reason },
        'Cloud prompt configure/warm skipped — PlatformConfig not wired (expected in unwired bootstrap; prompts will lazily resolve on first read)',
      );
    } else {
      bootstrapLog.error(
        { event: 'cloud.prompt_warm.failed', reason },
        'Cloud prompt configure/warm failed — continuing boot (prompts will lazily resolve on first read)',
      );
    }
  }

  // PRIVACY CONVENTION (MA4 / R6, PLAN Stage 7) — cloud analytics property
  // discipline. Every `getTracker().track(event, props)` site that fires on
  // cloud MUST pass ONLY categorical / metric / boolean / opaque-id values:
  // event names, enum-like statuses, counts, durations, surface/tier tags,
  // hashed/anon ids. NEVER free text, user content, file contents, message
  // bodies, prompts, emails (the lone identity exception is the SDK-managed
  // `identify()` trait — see applyCloudAnalyticsIdentity), or any PII. Payloads
  // are categorical today; this rule keeps them that way. The same redaction
  // posture cloud Sentry enforces applies here, but analytics has NO beforeSend
  // scrubber — the property shape IS the privacy boundary. When adding a cloud
  // track site, prefer a normalized enum over a raw string and review the
  // property keys against this rule. See trackingTypes.ts for the shared
  // attribution shape and docs/plans/260612_cloud-analytics-monitoring/PLAN.md.
  //
  // Analytics: wire the surface-tag context provider, then start the RudderStack
  // client. MUST run here — after setLicenseTier() + ensureNormalizedSettings()
  // and BEFORE any scheduler/request can emit (A1 boot-ordering constraint).
  // The closure reads licenseTier + settings AT CALL TIME (cloud wires
  // NULL_REBEL_AUTH_PROVIDER and license/settings resolve inside bootstrap()),
  // so values are never captured stale at wire time. This single chokepoint
  // tags every track event with client_surface:'cloud' + licenseTier +
  // attribution (mirrors desktop src/main/index.ts client_surface:'desktop').
  // NOTE: the key is `client_surface` (NOT `surface`), to avoid colliding with
  // the per-event `surface` property used for chat_checkpoint / nps_survey. The
  // separate Sentry `setTag('surface','cloud')` is a different namespace and is
  // intentionally left untouched.
  setAnalyticsContextProvider(() => {
    const currentSettings = getSettings();
    const companyName = currentSettings.companyName ?? null;
    return {
      client_surface: process.env.REBEL_SURFACE ?? 'cloud',
      ...buildAnalyticsAttributionProperties({
        companyName,
        source: companyName ? 'settings.companyName' : null,
      }),
      licenseTier: getLicenseTier(),
    };
  });
  // Analytics/telemetry init must NEVER crash the cloud server boot. The
  // shared `initAnalytics()` → `resolveRudderCreds()` reads
  // `getPlatformConfig().isOss` unconditionally (src/main/analytics.ts:108),
  // which THROWS 'PlatformConfig not initialized' if platform config is not
  // wired. On desktop platform config is always wired; on cloud (and in
  // cloud bootstrap tests that exercise the real `bootstrap()` without a
  // `setPlatformConfig()` harness) it may not be. A telemetry init failure is
  // never fatal — guard it so boot continues with analytics simply
  // unavailable (`isAvailable()` stays false). This is NOT a silent swallow:
  // a genuine prod wiring regression is logged LOUD at error level so it
  // isn't masked.
  try {
    initAnalytics();
    console.log('[bootstrap] Analytics initialized');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    bootstrapLog.error(
      { event: 'cloud.analytics.init_failed', reason },
      'Cloud analytics init failed — continuing boot with analytics unavailable',
    );
  }

  // Stage 3: identify the cloud owner from settings.userEmail (anon-only
  // fallback is observable — DA3). Runs once now that settings are normalized.
  // Live recovery (a later desktop→cloud userEmail dual-write flipping
  // anon-only → identified without a restart) is NOT driven from a
  // settingsStore change event: the cloud `electronStoreShim` has no
  // `onDidAnyChange` seam (it's optional on `KeyValueStore` and unimplemented
  // here), so any such subscription would be permanently dead. Instead the
  // inbound dual-write chokepoint — `routes/settings.ts` after
  // `deps.updateSettings()` — calls `deps.refreshAnalyticsIdentity`
  // (= `applyCloudAnalyticsIdentity`, idempotent on same email). See the
  // Stage 3 review fix in subagent_reports.
  // Same resilience posture as initAnalytics() above: identity application
  // routes through `identifyMainUser()` and may transitively touch platform
  // config; a failure here must not abort boot. Logged LOUD (error level) so
  // a real regression isn't masked; analytics simply stays anon/unavailable.
  try {
    applyCloudAnalyticsIdentity();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    bootstrapLog.error(
      { event: 'cloud.analytics.identity_failed', reason },
      'Cloud analytics identity application failed — continuing boot',
    );
  }

  // Stage 2: fold legacy `rebel-core-learned-model-limits` data onto profiles
  // and disambiguate registry-stamped legacy `contextWindow` values. Idempotent
  // (each part is gated on its own timestamp inside `localModel`). Runs after
  // settings store + storeFactory wiring (set at module top-level above), but
  // before any HTTP request can fire a context-overflow callback.
  // See docs/plans/260503_unify_learned_limits_into_profiles.md.
  try {
    const { migrateLearnedLimitsIfNeeded } = await import('@core/rebelCore/learnedLimitsMigration');
    migrateLearnedLimitsIfNeeded();
  } catch (err) {
    console.error('[bootstrap] learned-limits migration failed; will retry on next boot:', err);
  }

  // Router config path — needed by createHeadlessRuntime and Super-MCP.
  const mcpDir = path.join(dataPath, 'mcp');
  const preferredRouterConfigPath = path.join(mcpDir, 'super-mcp-router.json');
  const currentRouterConfigPath = resolveMcpConfigPath(getSettings());
  const routerConfigPath = preferredRouterConfigPath;

  // Point settings at the cloud router config (overwrite any migrated local path)
  if (currentRouterConfigPath !== preferredRouterConfigPath) {
    updateSettings({ mcpConfigFile: preferredRouterConfigPath });
    console.log(`[bootstrap] Set mcpConfigFile to ${preferredRouterConfigPath}`);
  }

  // Repair already-migrated cloud configs that still carry desktop-resolved
  // sandbox env values (e.g. `RUNWAY_ALLOWED_ROOT=/Users/<desktop_user>/...`).
  // Runs BEFORE `createHeadlessRuntime` so Super-MCP picks up the scrubbed
  // config on its initial spawn — no restart required. Pre-configures
  // `bundledMcpManager` here; `initCoreServices` (called by
  // `createHeadlessRuntime`) re-runs the same configure call idempotently.
  // Plan: SF-7 in docs/plans/260520_runway_sandbox_central_trusted_roots.md.
  try {
    const cloudResourcesDir = path.resolve(process.cwd(), 'resources');
    const { configureBundledMcpManager } = await import('@main/services/bundledMcpManager');
    configureBundledMcpManager({
      userDataDir: dataPath,
      resourcesDir: cloudResourcesDir,
      isPackaged: false,
    });
    const { backfillCatalogEnvForExistingServers } = await import(
      '@main/services/catalogEnvBackfillMigration'
    );
    if (fs.existsSync(routerConfigPath)) {
      const backfillResult = await backfillCatalogEnvForExistingServers(routerConfigPath, {
        scrubStaleDefaultOnlyEnvKeys: true,
      });
      if (backfillResult.repaired.length > 0) {
        console.log(
          '[bootstrap] catalog-env backfill repaired entries',
          JSON.stringify({
            repaired: backfillResult.repaired.length,
            scrubbedSandboxKeysByEntry: backfillResult.repaired
              .filter((r) => r.scrubbedSandboxEnvKeys && r.scrubbedSandboxEnvKeys.length > 0)
              .map((r) => ({ serverName: r.serverName, scrubbed: r.scrubbedSandboxEnvKeys })),
          }),
        );
      }
    }
  } catch (err) {
    console.warn('[bootstrap] catalog-env backfill (cloud SF-7) failed (non-fatal):', err);
  }

  // Register BTS proxy URL/auth providers so Codex-routed BTS calls
  // (auto-title, safety eval, compaction, memory update) can reach
  // the local Codex proxy on cloud. Mirrors src/main/index.ts:5412-5423.
  // Must run before any boundary that could trigger a BTS call (i.e. before
  // createHeadlessRuntime, which wires memoryUpdate/errorRecovery executors).
  // See docs-private/investigations/260514_cloud_bts_codex_proxy_unwired_auto_title.md
  {
    const { registerBtsProxyProviders } =
      await import('@core/services/behindTheScenesClient');
    const { proxyManager: btsProxyManager } =
      await import('../../src/main/services/localModelProxyServer');
    // NOTE: the managed-key availability seam (`registerManagedKeyAvailability`)
    // is wired earlier — just before the startup codex provider heal reads it —
    // so the heal never trips the `managed-key-availability-unwired` marker.
    // It now reads the live store (`() => hasManagedOpenRouterKey()`), the same
    // as desktop, since Layer 3 (DI-05 cloud parity) relays the managed key here.
    registerBtsProxyProviders({
      url: async () => {
        if (!btsProxyManager.isRunning()) {
          await btsProxyManager.ensureRunningForBts();
        }
        return btsProxyManager.getUrl();
      },
      auth: () => btsProxyManager.getAuthToken(),
    });
  }

  const cloudExecuteAgentTurn = process.env.REBEL_MOCK_AGENT_TURNS === '1'
    ? (() => {
        console.warn('[bootstrap] ⚠ REBEL_MOCK_AGENT_TURNS=1 — using mock agent executor (test-only)');
        return async (win: EventWindow | null, turnId: string, prompt: string, options?: unknown) => {
          const { mockExecuteAgentTurn } = await import('./mockAgentTurnExecutor');
          await mockExecuteAgentTurn(
            win,
            turnId,
            prompt,
            options as Parameters<typeof mockExecuteAgentTurn>[3],
          );
        };
      })()
    : async (win: EventWindow | null, turnId: string, prompt: string, options?: unknown) => {
        await executeAgentTurn(
          win,
          turnId,
          prompt,
          options as Parameters<typeof executeAgentTurn>[3],
        );
      };

  const cloudExecuteAgentTurnWithRecovery = async (
    win: EventWindow | null,
    turnId: string,
    prompt: string,
    options: AgentLoopOptions,
  ): Promise<void> => {
    const adapter = createCloudRecoveryAdapter({
      win,
      executeAgentTurn: cloudExecuteAgentTurn,
      getSettings,
    });
    const phase: RecoveryPhase = 'post_activity';
    const enableRecovery = true;
    const abortSignal =
      options.existingAbortController?.signal
      ?? agentTurnRegistry.getActiveTurnController(turnId)?.signal
      ?? new AbortController().signal;
    const ctx: RecoveryContext = {
      phase,
      depth: 0,
      attempt: 0,
      longContextFallbackAttempted: false,
      skeletonAttempted: false,
      isRecoveryModelAttempt: false,
      enableRecovery,
      sessionId: options.sessionId,
      turnId,
      originalSessionId: options.sessionId,
      originalPrompt: prompt,
      abortSignal,
    };

    await runRecoveryPipeline({
      phase,
      prompt,
      agentLoopOptions: options,
      enableRecovery,
      ctx,
      adapter,
      abortSignal,
    });
  };

  const memoryUpdateDeps: MemoryUpdateDeps = {
    executeAgentTurn: async (turnId, prompt, options) => {
      const settings = getSettings();
      const coreDirectory = settings.coreDirectory ?? '';
      const memoryWriteHook = coreDirectory ? createMemoryWriteHook({
        turnId,
        sessionId: options.sessionId,
        originalTurnId: options.originalTurnId,
        originalSessionId: options.originalSessionId,
        coreDirectory,
        privateMode: options.privateMode,
      }) : undefined;

      const memoryTurnOverride = resolveMemoryBtsTurnOverride(settings);
      if (memoryTurnOverride.source === 'profile-decode-fallback') {
        console.warn(
          '[memory] Profile-based BTS override could not be decoded for memory update turns, using fallback',
          { memoryBts: memoryTurnOverride.memoryBts, fallback: memoryTurnOverride.modelOverride },
        );
      }
      console.log(
        '[memory] Memory update turn model pinned',
        {
          modelOverride: memoryTurnOverride.modelOverride,
          workingProfileOverrideId: memoryTurnOverride.workingProfileOverrideId,
          source: memoryTurnOverride.source,
        },
      );

      agentTurnRegistry.setEventListener(turnId, options.onEvent);
      try {
        await cloudExecuteAgentTurn(null, turnId, prompt, {
          sessionId: options.sessionId,
          resetConversation: true,
          bypassToolSafety: true,
          memoryWriteHook,
          mcpDenyHook: createMcpDenyHook(),
          modelOverride: memoryTurnOverride.modelOverride,
          ...(memoryTurnOverride.workingProfileOverrideId
            ? { workingProfileOverrideId: memoryTurnOverride.workingProfileOverrideId }
            : {}),
          thinkingModelOverride: '',  // Suppress thinking model for BTS memory turns
        });
      } finally {
        agentTurnRegistry.deleteEventListener(turnId);
      }
    },
    getSettings,
    broadcastMemoryUpdateStatus: (status) =>
      cloudEventBroadcaster.broadcast('memory:update-status', status),
  };

  const errorRecoveryDeps: CloudErrorRecoveryDeps = {
    executeAgentTurn: async (turnId, prompt, options) => {
      agentTurnRegistry.setEventListener(turnId, options.onEvent);
      try {
        await cloudExecuteAgentTurn(null, turnId, prompt, {
          sessionId: options.sessionId,
          resetConversation: true,
          bypassToolSafety: options.bypassToolSafety,
          memoryWriteHook: options.readOnlyHook,
        });
      } finally {
        agentTurnRegistry.deleteEventListener(turnId);
      }
    },
    getSettings,
    notifyRenderer: (state) =>
      cloudEventBroadcaster.broadcast('error-recovery:state', state),
  };

  process.env.REBEL_WORKSPACE_PATH = getSettings().coreDirectory || '';
  const runtime = await createHeadlessRuntime({
    userDataDir: dataPath,
    resourcesDir: path.resolve(process.cwd(), 'resources'),
    isPackaged: false,
    routerConfigPath,
    getSettings,
    updateSettings,
    win: cloudEventBroadcaster.virtualWindow,
    loadAgentSessions: () => getIncrementalSessionStore().loadSync(),
    executeAgentTurn: cloudExecuteAgentTurn,
    executeAgentTurnWithRecovery: cloudExecuteAgentTurnWithRecovery,
    preOAuthCallHook: async () => {
      await DEFAULT_CODEX_AUTH_PROVIDER.getAccessToken();
    },
    superMcpPortBase: 3100,
    superMcpPortRange: 25,
    superMcpTimeoutMs: 30_000,
    memoryUpdateDeps,
    errorRecoveryDeps,
  });
  console.log('[bootstrap] Headless runtime initialized');

  const superMcpUrl = runtime.superMcpUrl;

  // Part A (REBEL-5ZR): preserve visibility into genuine Super-MCP startup
  // failures BEFORE the warmup guard is downgraded to a non-exception skip.
  // Without this capture the failure would be silent on cloud (Super-MCP's own
  // capture excludes the 'headless-runtime' context). If the URL is missing but
  // no startup error was captured, that is anomalous on cloud (only `skipMcp`
  // produces it, and cloud never sets `skipMcp`) — emit a distinct anomaly
  // message so the missing-URL condition can never be fully silent.
  if (!superMcpUrl) {
    if (runtime.superMcpStartupError) {
      reportSuperMcpStartupFailure(runtime.superMcpStartupError);
    } else {
      reportSuperMcpUrlMissingWithoutError();
    }
  }

  cloudBootstrapWarmup.configure({ superMcpUrl });

  // Initialize external conversation service
  try {
    initExternalConversationService();
    console.log('[bootstrap] External conversation service initialized');
  } catch (err) {
    console.error('[bootstrap] Failed to initialize external conversation service:', err);
  }

  const store = getIncrementalSessionStore();
  const sessionSeqIndex = getSessionSeqIndex();
  getOutboxStallMonitor().start();

  try {
    const persistedSessions = await store.load();
    sessionSeqIndex.hydrateFromSessions(persistedSessions);
    for (const session of persistedSessions) {
      seedServerClock(session.id, session.cloudUpdatedAt);
    }
    console.log(`[bootstrap] Hydrated ordering indices for ${persistedSessions.length} sessions`);
  } catch (error) {
    console.error('[bootstrap] Failed to hydrate ordering indices:', error);
  }

  const agentTurnServiceDeps: AgentTurnServiceDeps = {
    executeAgentTurn: cloudExecuteAgentTurn,
    executeAgentTurnWithRecovery: cloudExecuteAgentTurnWithRecovery,
    dispatchAgentEvent,
    deleteRendererSessionByTurn: (turnId: string) => agentTurnRegistry.deleteRendererSession(turnId),
    cancelExistingTurnForSession: (sessionId: string) =>
      agentTurnRegistry.cancelExistingTurnForSession(sessionId),
    getActiveTurnForSession: (sessionId: string) =>
      agentTurnRegistry.getActiveTurnForSession(sessionId),
    isActiveTurnId: (turnId: string) => agentTurnRegistry.getActiveTurnController(turnId) !== undefined,
    loadAgentSessions: () => store.loadSync(),
  };

  let cloudSchedulerStop: (() => void | Promise<void>) | null = null;
  let selfUpdateSchedulerStop: (() => void | Promise<void>) | null = null;
  let cleanupPromise: Promise<void> | null = null;

  const deps: CloudServiceDeps = {
    startAgentTurn: (_deps, request, win) => runtime.startAgentTurn(request, win),
    getActiveTurnController: (turnId: string) => agentTurnRegistry.getActiveTurnController(turnId),
    getTurnCloseCallback: (turnId: string) => agentTurnRegistry.getTurnCloseCallback(turnId),
    setEventListener: (turnId: string, listener: (event: AgentEvent) => void) => {
      agentTurnRegistry.setEventListener(turnId, listener);
    },
    subscribeTurnEvents: (turnId, listener) => agentTurnRegistry.subscribeTurnEvents(turnId, listener),
    agentTurnServiceDeps,
    loadSessions: () => store.load(),
    listSessions: () => store.listSessions(),
    getSession: (id: string) => store.getSession(id),
    upsertSession: async (session: AgentSession) => {
      const existing = await store.getSession(session.id);
      const mergedForOrdering: AgentSession = existing
        ? {
            ...existing,
            ...session,
            // Never trust client-provided cloudUpdatedAt; keep persisted baseline.
            cloudUpdatedAt: existing.cloudUpdatedAt,
          }
        : session;
      const persistedMaxSeq = getMaxSeqFromSession(mergedForOrdering);
      sessionSeqIndex.setSeqFromStorage(mergedForOrdering.id, persistedMaxSeq);
      const indexedMaxSeq = sessionSeqIndex.getCurrentSeq(mergedForOrdering.id);
      const maxSeq = Math.max(persistedMaxSeq, indexedMaxSeq);
      const withOrderingMeta: AgentSession = maxSeq > 0
        ? { ...mergedForOrdering, maxSeq }
        : mergedForOrdering;
      const stamped = stampCloudUpdatedAt(withOrderingMeta);
      await store.upsertSession(stamped);
    },
    // Stage 3: pass-through (classification table) — deps wiring carries the
    // calling route's intent; the intent itself is declared at each call site
    // (merge service, continuity GC, e2e reset).
    deleteSession: async (id: string, options: SessionDeleteOptions) => {
      await store.deleteSession(id, options);
      sessionSeqIndex.deleteSession(id);
      clearServerClockSession(id);
    },
    clearHardDeleteLedgerForTestReset: () => store.clearHardDeleteLedgerForTestReset(),
    getSettings,
    updateSettings,
    refreshAnalyticsIdentity: applyCloudAnalyticsIdentity,
    // Cloud uses a SHALLOW single-level listing (NOT the recursive desktop
    // `buildFileTree`), so it is intentionally NOT migrated to the bounded
    // `{ nodes, metadata }` wrapper — it can't OOM (one readdir, no recursion).
    // It DOES distinguish "no workspace configured" (empty, complete) from a
    // listing FAILURE: a failure throws so the `/files` route surfaces it as an
    // error rather than presenting an empty directory as a complete answer
    // (Bug-2 critique F6 — no silent catch→[]).
    listFiles: async () => {
      const workspacePath = getSettings().coreDirectory;
      if (!workspacePath) return [];
      const files = await getWorkspaceFileSystem().listDirectory(workspacePath, '.');
      return files.map((f) => ({ name: f.name, isDirectory: f.isDirectory }));
    },
    readFile: async (target: string) => {
      const workspacePath = getSettings().coreDirectory;
      return getWorkspaceFileSystem().readFile(workspacePath ?? '', target);
    },
    writeFile: async (payload: { path: string; content: string }) => {
      const workspacePath = getSettings().coreDirectory;
      await getWorkspaceFileSystem().writeFile(workspacePath ?? '', payload.path, payload.content);
      return { success: true };
    },
    cleanup: () => {
      cleanupPromise ??= (async () => {
        // Order: stop scheduler (no new turns) → runtime.cleanup (drain in-flight) → Sentry.flush (dispatch buffered events before exit).
        cloudBootstrapWarmup.cleanup();
        await cloudSchedulerStop?.();
        await selfUpdateSchedulerStop?.();
        await runtime.cleanup();
        await Sentry.flush(2000);
      })();
      return cleanupPromise;
    },
  };

  if (isCloudE2eTestModeEnabled()) {
    deps.e2eSeed = await createCloudE2eSeedOps(deps);
  }

  // Register IPC handlers so the generic /api/ipc/:channel endpoint works.
  // The MapHandlerRegistry stores handlers in a plain Map; handler files call
  // registerHandler() which delegates to getHandlerRegistry().register().
  // This is the key piece that makes the cloud service a real "brain" —
  // existing handlers work without changes.
  // Track the cloud automation store adapter so we can wire the scheduler after handler registration
  let cloudAutomationStoreRef: import('./cloudAutomationStore').CloudAutomationStoreAdapter | null = null;

  try {
    const result = await registerCloudIpcHandlers(deps);
    cloudAutomationStoreRef = result.cloudAutomationStore;
    console.log('[bootstrap] IPC handlers registered for cloud mode');
  } catch (err) {
    console.error('[bootstrap] Failed to register IPC handlers (generic IPC will not work):', err);
  }

  // Wire inbox state changes to broadcast (same pattern as desktop main/index.ts)
  try {
    const { onInboxStateChange } = await import('@core/services/inboxStore');
    const { getBroadcastService } = await import('@core/broadcastService');
    onInboxStateChange((state) => {
      getBroadcastService().sendToAllWindows('inbox:state', state);
      getBroadcastService().sendToAllWindows('inbox:changed', {});
    });
    console.log('[bootstrap] Inbox state broadcast wired');
  } catch (err) {
    console.error('[bootstrap] Failed to wire inbox state broadcast:', err);
  }

  // Start cloud automation scheduler for `executeIn: 'cloud'` automations
  if (cloudAutomationStoreRef) {
    try {
      const { CloudAutomationScheduler } = await import('./services/cloudAutomationScheduler');
      const cloudScheduler = new CloudAutomationScheduler({
        getDefinitions: () => cloudAutomationStoreRef!.getState().definitions,
        getProviderCredentialState: () => {
          const settings = deps.getSettings?.();
          const hasReadinessInputs = settings
            && (Object.prototype.hasOwnProperty.call(settings, 'activeProvider')
              || Object.prototype.hasOwnProperty.call(settings, 'providerKeys')
              || Object.prototype.hasOwnProperty.call(settings, 'openRouter'));
          if (!settings || !hasReadinessInputs) {
            return null;
          }

          let codexConnected = false;
          try {
            codexConnected = getCodexAuthProvider().isConnected();
          } catch {
            codexConnected = false;
          }

          return validateProviderCredentials(settings, codexConnected);
        },
        executeAgentTurn: async (turnId, prompt, options) => {
          agentTurnRegistry.setEventListener(turnId, options.onEvent);
          const policy = options.policy ?? derivePolicy('automation');
          try {
            await executeAgentTurn(null, turnId, prompt, {
              sessionId: options.sessionId,
              resetConversation: true,
              sessionType: 'automation',
              policy,
              modelOverride: options.modelOverride,
              thinkingModelOverride: options.thinkingModelOverride,
            });
          } finally {
            agentTurnRegistry.deleteEventListener(turnId);
          }
        },
        store: cloudAutomationStoreRef,
      });

      // Wire definition change notifications to the scheduler
      cloudAutomationStoreRef.setOnDefinitionChange((definitions) => {
        cloudScheduler.onDefinitionsChanged(definitions);
      });

      // Slim delta channel: emits per-run / per-next-run-update events so
      // connected desktops can mirror cloud-executed runs into their automation
      // state without overwriting their local-mode runs[]. See BUG 1+11 in
      // docs-private/investigations/260515_cloud_automation_bugs.md.
      cloudAutomationStoreRef.setOnDelta((delta) => {
        cloudEventBroadcaster.broadcast('automation:cloud-delta', delta);
      });

      cloudScheduler.start();
      cloudSchedulerStop = () => cloudScheduler.stop();
      console.log('[bootstrap] Cloud automation scheduler started');
    } catch (err) {
      console.error('[bootstrap] Failed to start cloud automation scheduler:', err);
    }
  }

  // Start self-update scheduler (checks GHCR for newer image tags)
  try {
    const { startSelfUpdateScheduler, stopSelfUpdateScheduler } = await import('./selfUpdateScheduler');
    startSelfUpdateScheduler({ getSettings });
    selfUpdateSchedulerStop = stopSelfUpdateScheduler;
    console.log('[bootstrap] Self-update scheduler started');
  } catch (err) {
    console.error('[bootstrap] Failed to start self-update scheduler:', err);
    // Highest-level "this cloud will never self-update" failure: if the
    // scheduler never starts, none of its in-scheduler capture sites can fire,
    // so this is the only place we'd learn of it. Post-Sentry-init, so capture
    // it (warning, stable fingerprint). Best-effort — never block boot.
    try {
      getErrorReporter().captureMessage('cloud.self_update.scheduler_start_failed', {
        level: 'warning',
        fingerprint: ['cloud.self_update.scheduler_start_failed'],
        tags: { event: 'cloud.self_update.scheduler_start_failed', surface: 'cloud' },
        extra: { error: err instanceof Error ? err.message : String(err) },
      });
    } catch (captureErr) {
      ignoreBestEffortCleanup(captureErr, {
        operation: 'cloud.selfUpdateSchedulerStartCapture',
        reason: 'telemetry capture of scheduler-start failure must not block bootstrap',
      });
    }
  }

  // Rollback visibility: the pre-bootstrap watchdog runs before Sentry exists,
  // so a successful image rollback is invisible. Now that Sentry is wired,
  // report (once, deduped) any rollback the watchdog performed before this
  // healthy boot, so the team learns a bad image shipped and was auto-recovered.
  try {
    const { reportRollbackIfNew } = await import('./services/cloudUpdateStatus');
    reportRollbackIfNew({ dataDir: dataPath });
  } catch (err) {
    // reportRollbackIfNew is internally fail-safe; this guards only the dynamic
    // import. Rollback visibility is best-effort telemetry — never block boot.
    ignoreBestEffortCleanup(err, {
      operation: 'cloud.rollbackVisibility',
      reason: 'rollback-visibility report is best-effort; must not block bootstrap',
    });
  }

  // Start cloud data hygiene scheduler (runs at startup + every 6 hours).
  // Composes purgeDeletedSessions, removeLegacyFiles, cleanupSessionLogs,
  // cleanupOldTranscripts.
  try {
    const { startCloudHygieneScheduler } = await import('./services/cloudHygieneScheduler');
    startCloudHygieneScheduler({ dataPath });
    console.log('[bootstrap] Cloud data hygiene scheduler started');
  } catch (err) {
    console.error('[bootstrap] Failed to start cloud data hygiene scheduler:', err);
  }

  cloudBootstrapCompletedAtMs = Date.now();
  console.log('[bootstrap] Cloud service initialized');
  cloudBootstrapWarmup.scheduleIdleTimerAndWatchdog(cloudBootstrapCompletedAtMs - bootstrapStart);

  return deps;
}

function isToolSafetyResponseRequest(value: unknown): value is {
  toolUseID: string;
  approved: boolean;
  input: Record<string, unknown>;
} {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.toolUseID === 'string'
    && record.toolUseID.length > 0
    && typeof record.approved === 'boolean'
    && !!record.input
    && typeof record.input === 'object'
    && !Array.isArray(record.input);
}

/**
 * Register IPC handlers that are safe to run in headless cloud mode.
 * Uses the same register*Handlers() functions from src/main/ipc/ that the
 * desktop app uses. The HandlerRegistry (MapHandlerRegistry in cloud,
 * ElectronHandlerRegistry in desktop) stores them for dispatch.
 *
 * Only handlers that:
 * - Don't require BrowserWindow for core functionality
 * - Don't use desktop-only APIs (dialog, shell, etc.)
 * - Have deps that can be satisfied with cloud-compatible implementations
 *
 * Handler domains intentionally excluded from cloud:
 *
 * | Domain              | Reason                                        |
 * |---------------------|-----------------------------------------------|
 * | Emergency           | Electron app.relaunch/quit                    |
 * | App                 | shell, dialog, clipboard, Notification        |
 * | Export              | BrowserWindow + save dialogs                  |
 * | Voice               | app.getPath, shell, BrowserWindow streaming   |
 * | Agent               | BrowserWindow events (turn handled via WS)    |
 * | Permissions         | systemPreferences, shell                      |
 * | Demo                | Not needed in cloud (single-user)             |
 * | System Health       | shell.openPath, trace viewer                  |
 * | Auth (all OAuth)    | Desktop OAuth flows (7 providers)             |
 * | Todoist             | Token storage + desktop API flow              |
 * | Meeting Bot         | Desktop SDK + local recording                 |
 * | Local STT           | BrowserWindow model manager                   |
 * | Physical Recording  | BLE hardware                                  |
 * | Plaud               | OAuth + sync                                  |
 * | MCP Apps            | Could add (uses superMcpHttpManager), deferred |
 * | Version             | Desktop update banner                         |
 * | Inbound Trigger     | Could add, deferred                           |
 * | Cloud               | Desktop cloud management UI                   |
 *
 * Handlers marked "deferred" are cloud-safe but not yet needed.
 * Add them when their IPC channels appear in CLOUD_CHANNEL_POLICIES.
 */
async function registerCloudIpcHandlers(deps: CloudServiceDeps): Promise<{
  cloudAutomationStore: import('./cloudAutomationStore').CloudAutomationStoreAdapter;
}> {
  // Import handler registration functions
  const {
    registerLibraryHandlers,
    registerSettingsHandlers,
    registerSessionsHandlers,
    registerInboxHandlers,
    registerAutomationsHandlers,
    registerDashboardHandlers,
    registerUserTasksHandlers,
    registerScratchpadHandlers,
    registerSkillsHandlers,
    registerUseCaseLibraryHandlers,
    registerFileConversationHandlers,
    registerSafetyHandlers,
    registerSafetyActivityLogHandlers,
    registerSafetyPromptHandlers,
    registerSearchHandlers,
    registerFeedbackHandlers,
    registerDiagnosticsHandlers,
    registerMemoryHandlers,
    registerCommunityHandlers,
    registerMiscHandlers,
    registerCalendarHandlers,
    registerErrorRecoveryHandlers,
    registerUsageHandlers,
  } = await import('../../src/main/ipc/cloudIpcHandlers');

  setLiveMeetingTranscriptProvider(cloudRollingTranscript);
  if (process.env.NODE_ENV !== 'test') {
    const { registerCloudOnlyBuiltins } = await import('@core/rebelCore/builtinTools');
    registerCloudOnlyBuiltins();
  }

  // Library — uses settings for coreDirectory
  registerLibraryHandlers({
    getSettings: deps.getSettings,
    getSettingsStore: () => settingsStore,
  });

  let pendingVoiceActivationHotkey: string | null = null;
  // Settings — core get/update
  registerSettingsHandlers({
    getSettings: deps.getSettings,
    getSettingsStore: () => settingsStore,
    ensureNormalizedSettings,
    applyVoiceActivationHotkey: () => ({
      success: false,
      error: 'Voice activation hotkeys are not available in the cloud service',
    }),
    getPendingVoiceActivationHotkey: () => pendingVoiceActivationHotkey,
    setPendingVoiceActivationHotkey: (hotkey) => {
      pendingVoiceActivationHotkey = hotkey;
    },
    broadcastDiagnosticsUpdate: () => {},
    scheduleDiagnosticsExpiry: () => {},
    getWindowForEvent: () => null,
  });

  // Sessions
  const cloudSessionLockManager = createSessionLockManager({
    locksDirectory: path.join(getDataPath(), 'sessions-locks'),
    isProcessAlive: defaultIsProcessAlive,
    now: Date.now,
  });
  registerSessionsHandlers({
    loadAgentSessions: () => getIncrementalSessionStore().loadSync(),
    saveAgentSessions: async (sessions) => {
      // Awaits and returns the store's discriminated outcome (merge graft,
      // 260612 delete-wins collision): the sessions:save handler fires
      // embedding hooks ONLY for sessions that actually persisted. On failure
      // we swallow (pre-existing cloud behavior) and return void — the handler
      // then keeps its pre-Stage-3 hook behavior; drops remain protected by
      // construction at the store chokepoints either way.
      try {
        return await upsertSessionsWithLocks({
          sessions,
          store: getIncrementalSessionStore(),
          lockManager: cloudSessionLockManager,
          ownerKind: 'cloud',
        });
      } catch (error: unknown) {
        console.error('[bootstrap] Failed to save sessions from cloud IPC:', error);
        return undefined;
      }
    },
    upsertAgentSession: (session) => upsertSessionsWithLocks({
      sessions: [session],
      store: getIncrementalSessionStore(),
      lockManager: cloudSessionLockManager,
      ownerKind: 'cloud',
    }),
    sessionLockManager: cloudSessionLockManager,
    sessionLockOwnerKind: 'cloud',
    onSessionDeletedLocally: createCleanupLeakedSessionDeletedCallback({
      tombstoneStore: getSessionTombstoneStore(),
    }),
  });

  // Inbox (no deps required)
  registerInboxHandlers();

  // Automations — create cloud-side store adapter that satisfies the handler interface
  const { CloudAutomationStoreAdapter } = await import('./cloudAutomationStore');
  const cloudAutomationStore = new CloudAutomationStoreAdapter();
  registerAutomationsHandlers({
    getScheduler: () => cloudAutomationStore as any,
  });

  // Dashboard
  registerDashboardHandlers({
    getSettings: deps.getSettings,
  });

  // User tasks (no required deps)
  registerUserTasksHandlers();

  // Scratchpad
  registerScratchpadHandlers({
    getSettings: deps.getSettings,
  });

  // Skills (no deps)
  registerSkillsHandlers();

  // Use case library (no deps)
  registerUseCaseLibraryHandlers();

  // File conversation (no deps)
  registerFileConversationHandlers();

  // Safety (no required deps)
  registerSafetyHandlers();
  registerSafetyActivityLogHandlers();
  registerSafetyPromptHandlers();

  // Diagnostics — read channel for the in-app Diagnostics surface (Wave 4).
  // Reads via the cloud-side ledger reader wired earlier via
  // setDiagnosticEventsLedgerReader, so mobile clients calling
  // /api/ipc/diagnostics:get-recent-context get cloud-surface events.
  registerDiagnosticsHandlers();

  // Tool approval responses from the local UI — the desktop app dual-writes this
  // so cloud's toolSafetyService knows a tool was approved before the continuation
  // turn arrives. Without this, the cloud agent still thinks the tool is pending.
  {
    const { handleApprovalResponse } = await import('@core/services/safety/toolSafetyService');
    getHandlerRegistry().register('agent:tool-safety-response', async (
      _event: unknown,
      request: unknown,
    ) => {
      if (!isToolSafetyResponseRequest(request)) return { success: false, clearedCount: 0 };
      handleApprovalResponse(request.toolUseID, request.approved, request.input);
      return { success: true, clearedCount: 0 };
    });
  }

  // User question response handler — used by mobile to submit answers to
  // AskUserQuestion batches that paused a turn. Returns the continuation
  // message; the client (mobile) then calls startTurn(..., isSystemContinuation)
  // to resume. See docs/plans/260420_user_question_cross_surface_resilience.md.
  {
    const {
      findPersistedUserQuestionProvenance,
      registerUserQuestionResponseHandler,
      setUserQuestionAnsweredPersister,
      setUserQuestionProvenanceResolver,
    } = await import(
      '@core/services/userQuestionResponseHandler'
    );
    registerUserQuestionResponseHandler();
    setUserQuestionProvenanceResolver(async (sessionId, turnId, batchId) => {
      const session = await deps.getSession(sessionId);
      const turnEvents = session?.eventsByTurn?.[turnId] ?? [];
      return findPersistedUserQuestionProvenance(turnEvents, sessionId, batchId);
    });

    // Stage 7: persist `user_question_answered` events into the session's
    // eventsByTurn so mobile / cloud-client can rehydrate the answered
    // state after a force-quit (cross-session). Desktop doesn't need this
    // (renderer's session store persists via `agent:event`), so this hook
    // is only wired on cloud. See postmortem "Known limitations":
    //   docs-private/postmortems/260420_empty_result_anomaly_askuserquestion_deny_postmortem.md
    const { getSessionMutex } = await import('@core/services/sessionMutex');
    const persistMutex = getSessionMutex();
    setUserQuestionAnsweredPersister(async (sessionId, turnId, event) => {
      // Run under the shared session mutex so we don't race with the
      // concurrent turn listener persisting result/error events on the
      // original turn. The merge pattern mirrors the one in
      // cloud-service/src/routes/agent.ts::turn listener.
      await persistMutex.withLock(sessionId, async () => {
        const fresh = await deps.getSession(sessionId);
        if (!fresh) {
          // Session vanished between the answer and the persist — this
          // should only happen if it was deleted concurrently. Nothing
          // to persist; the client's optimistic state is the fallback.
          return;
        }
        const existingEvents = fresh.eventsByTurn ?? {};
        const turnEvents = existingEvents[turnId] ?? [];
        // Guard against duplicate persist (idempotency cache replay could
        // fire this twice if a client retries a lost response).
        const alreadyPresent = turnEvents.some(
          (e) => e.type === 'user_question_answered' && e.batchId === event.batchId,
        );
        if (alreadyPresent) return;
        const merged: AgentSession = {
          ...fresh,
          eventsByTurn: {
            ...existingEvents,
            [turnId]: [...turnEvents, event],
          },
        };
        await deps.upsertSession(merged);
      });
    });
  }

  // Search (no deps — tool search only, not semantic)
  registerSearchHandlers();

  // Feedback (no deps)
  registerFeedbackHandlers();

  // Memory — Stage B (260417_approval_consolidation_closeout): per-process
  // ConflictCapabilityService. Secret lives in closure; never persisted
  // or logged. Cloud instance mints and validates its own tokens; they
  // don't sync to desktop, which is intentional.
  const { createConflictCapabilityService } = await import(
    '@core/services/safety/conflictCapabilityService'
  );
  // Stage C (260417_approval_consolidation_closeout): per-process IPC
  // dedup cache so cloud-client's fetchWithRetry replay of a lost-
  // response POST replays the original response instead of re-running
  // the staging mutation. Cache lives only in this process; a restart
  // clears it, which is fine because the UI simply retries.
  const { createIpcDedupService } = await import(
    '@core/services/safety/ipcDedupService'
  );
  registerMemoryHandlers({
    getWorkspacePath: () => deps.getSettings().coreDirectory ?? undefined,
    sessionLockManager: cloudSessionLockManager,
    sessionLockOwnerKind: 'cloud',
    conflictCapabilityService: createConflictCapabilityService(),
    ipcDedupService: createIpcDedupService(),
  });

  // Community
  registerCommunityHandlers({
    getCommunityHighlightsService: () => { throw new Error('Community highlights not available in cloud'); },
    getSettings: deps.getSettings,
    getSession: (id: string) => deps.getSession(id),
  });

  // Misc — for conversation:generate-title
  registerMiscHandlers({
    getSettings: deps.getSettings,
    ensureNormalizedSettings,
    loadRuntimeConfig: () => {
      const userData = process.env.REBEL_USER_DATA || '/data';
      return {
        appVersion: process.env.REBEL_VERSION || __REBEL_VERSION__,
        platform: 'cloud',
        isPackaged: true,
        userData,
        logsPath: path.join(userData, 'logs'),
      };
    },
  });

  // Calendar
  registerCalendarHandlers({
    getSettings: deps.getSettings,
  });

  // Error recovery
  registerErrorRecoveryHandlers({
    getSettings: deps.getSettings,
    getMainWindow: () => null,
  });

  // Usage — cost summary and insights (pure ledger reads + session titles)
  registerUsageHandlers({
    listSessionSummaries: () => deps.listSessions(),
  });

  // Stage 2 parity with desktop startup: one-shot cleanup for leaked
  // delete-eligible sessions (memory-update/meeting-qa/calendar-sync).
  // Fire-and-forget; IncrementalSessionStore logs aggregate completion.
  // Mirror DELETE /api/sessions side-effects so cleanup creates cloud tombstones.
  const tombstoneStore = getSessionTombstoneStore();
  fireAndForget(
    getIncrementalSessionStore().cleanupLeakedSessions({
      onSessionDeletedLocally: createCleanupLeakedSessionDeletedCallback({ tombstoneStore }),
    }),
    'cloud.bootstrap.cleanupLeakedSessions',
  );

  return { cloudAutomationStore };
}
