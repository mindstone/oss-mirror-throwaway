/**
 * HTTP/WS cloud entrypoint that enforces protocol boundaries while delegating
 * business decisions to shared handlers and stores wired in bootstrap.
 *
 * @see ../../docs/project/CLOUD_ARCHITECTURE.md — protocol surface and deployment context
 * @see ../../docs/project/ARCHITECTURE_IPC.md — shared channel contract model
 * @see ../../src/shared/cloudChannelPolicies.ts — desktop-forwarded channel policy map
 */

// installGracefulFs MUST be the very first import. It calls `gracefulify(fs)`
// so every subsequent fs op gets EMFILE/ENFILE retry resilience. Leaf module —
// no heavy deps. See docs/plans/260428_graceful_fs_emfile_fix.md Stage 2.
import './installGracefulFs';

// Platform config MUST be initialized before any module that calls getPlatformConfig().
// This import is a leaf module with no heavy deps, so ESM evaluates it first.
import './platformInit';

// Decouple outbound DNS from the libuv threadpool BEFORE importing ./bootstrap
// (whose static-import graph may perform top-level outbound fetches). A leaf
// side-effect import guarantees install ordering under ESM evaluation; the call
// is idempotent so bootstrap()'s own call is a harmless no-op. See
// docs/plans/260617_meeting-bot-dns-starvation/PLAN.md.
import './installDnsDecouple';

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { bootstrap, stopGracefulFsObservability } from './bootstrap';
import { shutdownCloudDiagnosticEventsLedger } from './services/cloudDiagnosticEventsLedger';
import { cloudRollingTranscript } from './services/cloudRollingTranscript';
import { cloudEventBroadcaster } from './cloudEventBroadcaster';
import { log, sendJson, parsePath, sendRouteError, RouteError } from './httpUtils';
import { authorize } from './auth';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { handleMeetingTranscriptSegmentReceive } from './utils/hmacV2';
import { serveWebApp, serveWebAppWithOgTags } from './webAppServing';
import { runAllCloudChecks } from './health/checks';
import { sampleCloudPressure } from './health/pressureSampler';
import {
  handleSessions,
  handleSettings,
  handleCodexTokens,
  handleOpenRouterManagedKey,
  handleAgentStop,
  handleAgentTurnWs,
  handleLibrary,
  handleDataUploadArchive,
  handleDataReconcile,
  handleMcpConfig,
  handleAuthRelay,
  handleAuthRelayPull,
  handleGenericIpc,
  handleEventChannelWs,
  handlePush,
  handleContinuity,
  handleVoiceTranscribe,
  handleVoiceTts,
  handleFeedback,
  handleAdmin,
  handleSharedConversation,
  handleAppOpen,
  handleMeetingFallbackAnalysis,
  handleMeetingRecordingUpload,
  handleMeetingRecordingStatus,
  handleMeetingSessionCreate,
  handleMeetingSessionChunkUpload,
  handleMeetingSessionStatus,
  handleMeetingSessionFinalize,
  handleMeetingSessionCoachActivate,
  handleMeetingSessionCoachDeactivate,
} from './routes';
import { handleSlackWebhook } from './routes/slackWebhook';
import {
  handleSlackOAuthCallback,
  handleSlackOAuthStartByok,
  handleSlackOAuthStartManaged,
  handleSlackWorkspaceDelete,
  handleSlackWorkspaceGet,
} from './routes/slackOAuth';
import {
  handleSlackManagedInbound,
  handleSlackManagedProvisionTokens,
} from './routes/slackManaged';
import {
  handleSlackRecentSenders,
  handleSlackRecentSendersClearAll,
} from './routes/slackRecentSenders';
import {
  handleDiagnostics,
  handleDiagnosticsLogFilePaths,
  handleDiagnosticsRecentEvents,
  handleDiagnosticsRecentLogs,
  handleDiagnosticsSelf,
} from './routes/diagnostics';
import { handleStorageUsage } from './routes/storage';
import { getSharePreviewData } from '@core/services/shareLinksService';
import { getErrorReporter } from '@core/errorReporter';
// Node-portable analytics client, shared with desktop (see bootstrap.ts). The
// cloud→main import is sanctioned (analytics.ts has zero Electron deps).
import { flushMainAnalytics } from '../../src/main/analytics';
import * as Sentry from '@sentry/node';
import { handleSharedConversationUnlock, handleSharedFileDownload, handleSharesList, handleFileShare } from './routes/share';
import { startStaleBusyReaper, stopStaleBusyReaper } from './services/staleBusyReaper';
import { createMeetingUploadSessionStore, type MeetingUploadSessionCloudDeps } from './services/meetingUploadSessionStoreFactory';
import { submitAgentTurnInternal } from './services/agentTurnSubmissionService';
import { createMeetingQuestionTriggerService } from './services/meetingQuestionTriggerService';
import {
  getRollingTranscript,
  onSegmentAppended,
  onTranscriptionSessionCleanup,
} from './services/meetingTranscriptionEngine';
import { checkFfmpegAvailable, checkFfprobeAvailable } from '@core/services/audioChunking';
import { getCloudCapabilities } from './capabilities';
import { applyCommonResponseHeaders } from './serverHeaders';
import { createLastKnownGoodImageTagStore } from './services/lastKnownGoodImageTagStore';
import { createBootStateStore } from './services/bootStateStore';
import { computeCloudUpdateStatus } from './services/cloudUpdateStatus';
import {
  scheduleBootSuccessMarker,
  DEFAULT_BOOT_GRACE_MS,
  type BootSuccessMarkerHandle,
} from './services/bootSuccessMarker';
import { computeSchemaFingerprint } from '@core/services/schemaFingerprint';
import { ALL_STORE_VERSIONS } from '@core/constants';
import type { CloudPressureBasic } from '@shared/types/cloudHealth';
import { maybeInstallForcedBootCrash } from './services/forcedBootCrash';
import { derivePolicy } from '@core/services/turnPolicy';
import { cloudBootstrapWarmup } from './services/cloudBootstrapWarmup';
import { isCloudE2eTestModeEnabled } from './e2eTestMode';
import { handleE2eFixtures } from './routes/e2eFixtures';

declare const __BUILD_COMMIT__: string | undefined;

const PORT = parseInt(process.env.PORT || '8080', 10);

// F2 (Stage 6a) — upper bound on the analytics flush during shutdown. The
// RudderStack client has no axios timeout, so its HTTP flush can wait on
// retries; this keeps shutdown cleanup deterministic independent of the 5s exit
// timer.
const SHUTDOWN_FLUSH_TIMEOUT_MS = 2000;

// F1 (Stage 6a) — process-level capture + FAIL-FAST. Desktop captures
// uncaughtException / unhandledRejection via captureMainException
// (src/main/index.ts:1926/1935); cloud previously only registered SIGTERM/SIGINT
// shutdown handlers, so a fatal uncaught error or rejected promise produced no
// Sentry event. We mirror the desktop capture here, routing through the wired
// ErrorReporter (Sentry) tagged { surface:'cloud', area:'process' }. Registered
// once at module load.
//
// CRITICAL: installing ANY `uncaughtException` or `unhandledRejection` listener
// SUPPRESSES Node's default fatal-exit behaviour — the process keeps running in
// an undefined state (proven via Node 24 smoke checks: a returning handler
// leaves the process alive, while no handler exits code 1). For a STATELESS
// cloud HTTP server that is the wrong policy: the right behaviour is FAIL-FAST so
// Fly tears down the bad machine and starts a fresh one. We therefore capture,
// do a BOUNDED Sentry flush (so the event isn't lost when the SDK transport is
// torn down by exit), then `process.exit(1)` — restoring Node's default fatal
// semantics for BOTH events (Node 24's default for unhandledRejection is also to
// terminate). The flush is bounded and the exit lives in a `finally` so a hung
// transport can never keep the bad machine alive.
//
// Re-entrancy guard: if a SECOND fatal fires while we're already tearing down
// (e.g. an exception thrown inside this handler's async tail), we skip the second
// capture/flush and let the in-flight exit win — no double-exit, no recursion.
let fatalExitInProgress = false;

async function handleFatalProcessError(
  error: Error,
  kind: 'uncaughtException' | 'unhandledRejection',
  level: 'fatal' | 'error',
): Promise<void> {
  const message = error.message;
  const stack = error.stack ?? '';
  console.error(`[fatal] ${kind}: ${message}`);
  if (stack) console.error(stack);
  log({ level: 'fatal', msg: `Fatal ${kind}`, error: message, stack });

  // Re-entrancy: a fatal during teardown must not re-run capture/flush or queue
  // a second exit. The original exit (below) is already on its way.
  if (fatalExitInProgress) return;
  fatalExitInProgress = true;

  try {
    getErrorReporter().captureException(error, {
      level,
      tags: { surface: 'cloud', area: 'process', kind },
    });
    // Bounded flush so a hung Sentry transport can't keep the bad machine alive.
    await Sentry.flush(2000);
  } catch (captureError) {
    // Capture/flush must never prevent the exit (the fatal is already on stderr).
    ignoreBestEffortCleanup(captureError, {
      operation: 'cloud.process.fatal.capture',
      reason: 'Sentry capture/flush inside fatal handler failed; fatal already logged to stderr',
    });
  } finally {
    // Fail-fast: restore Node's default fatal exit so Fly restarts the machine.
    process.exit(1);
  }
}

process.on('uncaughtException', (error) => {
  fireAndForget(
    handleFatalProcessError(
      error instanceof Error ? error : new Error(String(error)),
      'uncaughtException',
      'fatal',
    ),
    'cloud.process.uncaughtException',
  );
});

process.on('unhandledRejection', (reason: unknown) => {
  fireAndForget(
    handleFatalProcessError(
      reason instanceof Error ? reason : new Error(String(reason)),
      'unhandledRejection',
      'error',
    ),
    'cloud.process.unhandledRejection',
  );
});

/**
 * F2 (Stage 6a) — capture UNEXPECTED HTTP route failures in Sentry.
 *
 * Generic route catches previously only logged + returned a 500, so server-side
 * 5xx failures were invisible to error monitoring (only one ad-hoc capture at
 * the health endpoint existed). This helper generalizes that.
 *
 * Noise control (mirrors selfUpdateScheduler.ts:108/178):
 * - SKIPS expected `RouteError` 4xx — those are normal client-side outcomes
 *   (auth, validation, not-found) and must NOT become Sentry issues. Only
 *   unexpected 5xx (RouteError 5xx or any non-RouteError throw) is captured.
 * - Templates the path into a low-cardinality, secret-free route FAMILY (see
 *   `toRouteFamily`) — only the family + method are recorded. The raw route
 *   never reaches Sentry: it can carry a share token (`/api/shared/{token}`)
 *   or resource ids (session/meeting/conversation), both of which would leak
 *   into tags/fingerprint (which `redactSentryEvent`/`beforeSend` does NOT
 *   scrub) and blow up issue cardinality.
 * - Uses a stable per-route-family fingerprint so all instances/requests hitting
 *   the same failing route group into a single issue.
 * - Throttles to once-per-route-family-per-process so a hot failing route can't
 *   spam the issue stream (the grouped issue's event count still reflects scope
 *   across instances — one event per route-family per process).
 */
const capturedRouteFamilies = new Set<string>();

/**
 * Hard cap on distinct route families tracked by the throttle Set. `toRouteFamily`
 * already bounds the family space (dynamic segments collapse to `:id`), so this is
 * a belt-and-braces backstop against a templating miss letting an unexpected
 * high-cardinality segment through — it prevents the Set from growing without
 * limit under hostile/scanning traffic.
 */
const MAX_CAPTURED_ROUTE_FAMILIES = 256;

/**
 * Collapse a raw request path into a bounded, secret-free route FAMILY suitable
 * for a Sentry tag/fingerprint/throttle key. Two transforms:
 *  1. Redact the share token (`/api/shared/{token}` → `/api/shared/:token`) — the
 *     token is a secret (the sibling log line redacts it the same way).
 *  2. Collapse dynamic id-bearing segments to `:id` so per-resource paths
 *     (`/api/agent/sessions/abc123/...`) map to one family
 *     (`/api/agent/sessions/:id/...`). A segment is treated as a dynamic id when
 *     it looks opaque: long (>=16 chars), purely numeric, UUID-shaped, or
 *     otherwise not a plain lowercase api-noun. This keeps the family set FINITE
 *     regardless of input — no secrets or PII survive into the family string.
 */
export function toRouteFamily(route: string): string {
  // Strip any query string defensively (callers pass parsed `route`, but never
  // trust it — req.url-derived input may carry a bearer token in the query).
  const pathOnly = route.split('?')[0] || route;

  // Share token: redact regardless of segment shape (the token is always a secret).
  if (pathOnly === '/api/shared' || pathOnly.startsWith('/api/shared/')) {
    const rest = pathOnly.slice('/api/shared'.length); // '' | '/{token}' | '/{token}/download'
    const tail = rest.split('/').slice(2).join('/'); // segments AFTER the token, if any
    return tail ? `/api/shared/:token/${tail}` : pathOnly === '/api/shared' ? '/api/shared' : '/api/shared/:token';
  }

  const segments = pathOnly.split('/');
  const templated = segments.map((seg) => (looksLikeDynamicId(seg) ? ':id' : seg));
  return templated.join('/') || pathOnly;
}

/**
 * Heuristic: does a path segment look like a dynamic resource id (vs a static
 * route noun)? Static api nouns are short, lowercase, PURELY ALPHABETIC words
 * (only `[a-z-]`). Anything else — containing a digit, numeric, UUID-shaped,
 * mixed-case/with separators, or simply long — is treated as an id so it
 * collapses to a placeholder. Bounded by construction.
 *
 * F3 (Phase 7): a digit anywhere in a segment is treated as id-shaped. Short
 * lowercase-alphanumeric segments like `abc123` previously survived into
 * tags/fingerprints; "contains a digit ⇒ likely id" closes that leak so the
 * family set stays finite/secret-free. Pure `[a-z-]` api nouns are unaffected.
 */
function looksLikeDynamicId(seg: string): boolean {
  if (seg.length === 0) return false; // leading/trailing empties from split
  if (/^[a-z][a-z-]*$/.test(seg) && seg.length < 16) return false; // plain api noun e.g. 'sessions', 'download'
  if (/\d/.test(seg)) return true; // contains a digit → id-shaped (covers numeric ids and `abc123`)
  if (seg.length >= 16) return true; // long opaque token/id
  if (/[A-Z]/.test(seg) || /[_]/.test(seg)) return true; // mixed-case / underscored → id-like, not an api noun
  return false;
}

export function captureRouteError(
  err: unknown,
  req: http.IncomingMessage,
  meta: { route: string; phase: string },
): void {
  // Noise control: expected client errors (4xx RouteError) are not issues.
  if (err instanceof RouteError && err.status < 500) return;

  const status = err instanceof RouteError ? err.status : 500;
  const code = err instanceof RouteError ? err.code : 'INTERNAL_ERROR';
  // Route FAMILY: a bounded, secret-free template of the path. The raw route may
  // carry a share token or resource ids — both must be redacted/collapsed BEFORE
  // they reach the tag/fingerprint/throttle key (tags + fingerprint are NOT
  // scrubbed by beforeSend). Never include req.url — it may carry query secrets.
  const routeFamily = toRouteFamily(meta.route);
  const method = req.method ?? 'UNKNOWN';

  // Throttle once per route-family per process.
  const throttleKey = `${method} ${routeFamily}`;
  if (capturedRouteFamilies.has(throttleKey)) return;
  // Backstop against a templating miss: stop tracking new families past the cap
  // so the Set can't grow without bound. Capture still fires (so we don't lose a
  // genuine new failure), it just isn't throttled once the cap is hit.
  if (capturedRouteFamilies.size < MAX_CAPTURED_ROUTE_FAMILIES) {
    capturedRouteFamilies.add(throttleKey);
  }

  try {
    getErrorReporter().captureException(err, {
      level: 'error',
      fingerprint: ['cloud.http.route_error', method, routeFamily, code],
      tags: {
        surface: 'cloud',
        area: 'http',
        route: routeFamily,
        method,
        status,
        phase: meta.phase,
      },
    });
  } catch (captureError) {
    // A capture failure must not escalate a route error into a process crash.
    ignoreBestEffortCleanup(captureError, {
      operation: 'cloud.captureRouteError',
      reason: 'Sentry capture of an unexpected route 5xx failed; route already logged + 500ed',
    });
  }
}

/** Test-only reset of the F2 route-error throttle so tests start fresh. */
export function __resetCapturedRouteFamiliesForTests(): void {
  capturedRouteFamilies.clear();
}

/**
 * Test-only accessor for the F1 fatal-process handler so a unit test can assert
 * the capture + bounded flush + fail-fast exit behaviour without installing a
 * real process listener. Also resets the re-entrancy guard so each test runs the
 * full path.
 */
export function __handleFatalProcessErrorForTests(
  error: Error,
  kind: 'uncaughtException' | 'unhandledRejection',
  level: 'fatal' | 'error',
): Promise<void> {
  fatalExitInProgress = false;
  return handleFatalProcessError(error, kind, level);
}

/**
 * Test-only accessor for the shared analytics flush that `shutdown()` awaits
 * (Stage 5). Lets a unit test confirm server.ts depends on the shared
 * `@main/analytics` client's flush without booting the whole service.
 */
export function __flushMainAnalyticsForTests(): Promise<unknown> {
  return flushMainAnalytics();
}

function maybeScheduleBootSuccessMarker(): BootSuccessMarkerHandle | null {
  const imageTag = process.env.FLY_IMAGE_REF;
  if (!imageTag) return null;
  const dataDir = process.env.REBEL_USER_DATA || '/data';
  const buildCommit = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown';
  let schemaFingerprint: string;
  try {
    schemaFingerprint = computeSchemaFingerprint(ALL_STORE_VERSIONS);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log({ level: 'warn', msg: 'Boot-success marker skipped: schema fingerprint failed', error: message });
    return null;
  }
  const graceMs = (() => {
    const raw = process.env.REBEL_BOOT_GRACE_MS;
    if (!raw) return DEFAULT_BOOT_GRACE_MS;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_BOOT_GRACE_MS;
  })();
  const lkgStore = createLastKnownGoodImageTagStore({ dataPath: dataDir });
  const bootStateStore = createBootStateStore({ dataPath: dataDir });
  return scheduleBootSuccessMarker({
    imageTag,
    buildCommit,
    schemaFingerprint,
    lkgStore,
    bootStateStore,
    graceMs,
    log: (event) => log({ level: 'info', msg: 'boot-success-marker', event }),
  });
}

async function main(): Promise<void> {
  log({ level: 'info', msg: 'Starting Rebel Cloud Service', port: PORT });

  const deps = await bootstrap();

  // Check ffmpeg/ffprobe availability for audio chunking and duration detection.
  // Non-blocking: warn if unavailable (voice transcription of short clips still works without it).
  const [ffmpegOk, ffprobeOk] = await Promise.all([
    checkFfmpegAvailable(),
    checkFfprobeAvailable(),
  ]);
  log({ level: 'info', msg: 'Audio tool availability check', ffmpeg: ffmpegOk, ffprobe: ffprobeOk });
  if (!ffmpegOk) {
    log({ level: 'warn', msg: 'ffmpeg not available — meeting recording chunking will not work' });
  }

  startStaleBusyReaper({
    listSessions: deps.listSessions,
    getSession: deps.getSession,
    upsertSession: deps.upsertSession,
    getActiveTurnController: deps.getActiveTurnController,
  });

  // Meeting fallback analysis deps — uses the same headless agent turn
  // pattern as memory updates and automations in bootstrap.ts.
  // Stage 5: Extended with getSession/upsertSession for companion session cleanup.
  const meetingAnalysisDeps: MeetingUploadSessionCloudDeps = {
    executeAgentTurn: async (turnId, prompt, options) => {
      deps.setEventListener(turnId, options.onEvent);
      const policy = options.policy ?? derivePolicy(undefined);
      try {
        await deps.agentTurnServiceDeps.executeAgentTurn(null, turnId, prompt, {
          sessionId: options.sessionId,
          resetConversation: options.resetConversation,
          bypassToolSafety: options.bypassToolSafety,
          policy,
        });
      } finally {
        // Clean up event listener after turn completes
        deps.setEventListener(turnId, () => {});
      }
    },
    getSettings: () => ({
      coreDirectory: deps.getSettings().coreDirectory ?? undefined,
    }),
    getSession: deps.getSession,
    upsertSession: deps.upsertSession,
  };
  const meetingUploadSessionStore = createMeetingUploadSessionStore(meetingAnalysisDeps);
  const meetingQuestionTriggerService = createMeetingQuestionTriggerService({
    submitCompanionTurn: async (request) => {
      const submission = await submitAgentTurnInternal({
        deps,
        request,
      });

      return {
        turnId: submission.turnId,
        completion: submission.completion,
      };
    },
    getCompanionSessionId: (meetingSessionId) => meetingUploadSessionStore.getCompanionSessionId(meetingSessionId),
    getRollingTranscript,
    getTriggerPhrase: () => deps.getSettings().meetingBot?.triggerPhrase ?? null,
    getOwnerName: () => deps.getSettings().userFirstName ?? 'User',
    // dynamic-broadcast-reviewed: meeting-question-trigger service DI seam — forwards the `channel`
    // the service emits (meeting:* channels declared at their own emit-sites); adds no channel itself.
    broadcast: (channel, payload) => cloudEventBroadcaster.broadcast(channel, payload),
  });
  const unsubscribeMeetingSegmentAppended = onSegmentAppended((payload) => {
    meetingQuestionTriggerService.onSegmentAppended(payload);
  });
  const unsubscribeTranscriptionCleanup = onTranscriptionSessionCleanup((sessionId) => {
    fireAndForget(
      meetingQuestionTriggerService.onSessionEnded(sessionId, 'session-ended'),
      'cloud.meetingQuestionTriggerService.onSessionEnded',
    );
  });

  const server = http.createServer((req, res) => {
    fireAndForget((async () => {
    applyCommonResponseHeaders(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const segments = parsePath(req.url);
    const route = `/${segments.join('/')}`;
    const reqStart = Date.now();
    // Redact share IDs from logged paths to prevent token leakage
    const logPath = route.startsWith('/api/shared/') ? '/api/shared/[redacted]' : route;
    cloudBootstrapWarmup.observeRequest(req.method ?? 'GET', logPath, route === '/api/health');

    // Log completed requests (skip health checks and static assets to avoid noise)
    if (segments[0] === 'api' && route !== '/api/health') {
      res.on('finish', () => {
        const contentLengthHeader = res.getHeader('Content-Length');
        const responseBytes = typeof contentLengthHeader === 'number'
          ? contentLengthHeader
          : typeof contentLengthHeader === 'string' && /^\d+$/.test(contentLengthHeader)
            ? Number(contentLengthHeader)
            : undefined;
        log({
          level: 'info',
          msg: 'route_timing',
          method: req.method,
          path: logPath,
          latencyMs: Date.now() - reqStart,
          statusCode: res.statusCode,
        });
        if (
          req.method === 'POST'
          && segments[0] === 'api'
          && segments[1] === 'sessions'
          && Boolean(segments[2])
          && segments[3] === 'events'
          && segments.length === 4
        ) {
          log({
            level: 'info',
            msg: 'delta_push_response_size',
            method: req.method,
            path: '/api/sessions/:id/events',
            statusCode: res.statusCode,
            ...(responseBytes !== undefined ? { responseBytes } : {}),
          });
        }
      });
    }

    // Shared conversation page: inject OG metadata for social previews when available.
    // Falls back to normal SPA serving if share is invalid/unavailable.
    if (segments[0] === 'app' && segments[1] === 'shared' && segments[2]) {
      const previewData = await getSharePreviewData(segments[2], { getSession: deps.getSession, getSettings: deps.getSettings });
      if (previewData) {
        return serveWebAppWithOgTags(req, res, previewData);
      }
    }

    // Cross-surface deep-link launcher. Public, no auth — recipients of a
    // shared `https://.../app/open?u=<rebel://...>` URL click through here,
    // the page attempts the OS protocol handoff, then falls back to the
    // "Get Rebel" landing page. Must run BEFORE the SPA fallback below.
    // See docs/plans/260416_centralize_cross_surface_links.md — Stage F.
    if (segments[0] === 'app' && segments[1] === 'open' && segments.length === 2) {
      return await handleAppOpen(req, res);
    }

    // Serve web companion SPA (no auth required — SPA handles auth client-side)
    if (segments[0] === 'app' || req.url === '/') {
      return serveWebApp(req, res);
    }

    // Health check (no auth for basic, auth required for detailed)
    if (route === '/api/health') {
      const url = new URL(req.url || '', 'http://localhost');
      const detailed = url.searchParams.get('detailed') === 'true';
      let sampledPressure: Awaited<ReturnType<typeof sampleCloudPressure>> | null = null;
      let basicPressure: CloudPressureBasic = {
        state: 'unknown' as const,
        oomRecent: false,
        recentRestart: false,
      };
      try {
        sampledPressure = await sampleCloudPressure();
        basicPressure = {
          state: sampledPressure.state,
          oomRecent: sampledPressure.oomRecent,
          recentRestart: sampledPressure.recentRestart,
        };
      } catch (error) {
        getErrorReporter().captureException(error, {
          level: 'error',
          tags: {
            surface: 'cloud',
            endpoint: '/api/health',
            service: 'pressureSampler',
          },
          extra: {
            detailed,
          },
        });
      }

      const base = {
        status: 'ok' as string,
        version: process.env.REBEL_VERSION || __REBEL_VERSION__,
        buildCommit: typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : 'unknown',
        buildDate: typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : 'unknown',
        uptime: process.uptime(),
        capabilities: getCloudCapabilities(),
        pressure: basicPressure,
        // Update/rollback status so the desktop reconciler (and the user) can
        // see when the watchdog auto-rolled-back a bad image. Reads tiny on-disk
        // quarantine/LKG state best-effort; defaults to 'ok' on any read error.
        cloudUpdate: computeCloudUpdateStatus({ dataDir: process.env.REBEL_USER_DATA || '/data' }),
      };

      if (!detailed) return sendJson(res, 200, base, req);

      // Detailed health requires auth
      if (!authorize(req)) return sendRouteError(res, undefined, new RouteError('UNAUTHORIZED', { status: 401, message: 'Detailed health requires auth' }));

      // DETAILED is NON-GATING by design: it always returns HTTP 200 (below),
      // and `base.status` ('critical'|'degraded'|'ok') is consumed only by
      // operator-facing readers — desktop monitoring (`checks/cloud.ts`, lists
      // failing checks + remediation) and `cloud:check-update`
      // (`src/main/ipc/cloudHandlers.ts:1619-1625`, which reads `version` when
      // the response is HTTP `ok`, so a `critical` body stays non-gating). The
      // BASIC endpoint above (the Fly/Docker/CI/provisioning liveness gate) never
      // reflects these checks — keep it that way (see checkCriticalPrompts()).
      const checks = await runAllCloudChecks();
      const hasFailure = checks.some(c => c.status === 'fail');
      const hasWarning = checks.some(c => c.status === 'warn');
      base.status = hasFailure ? 'critical' : hasWarning ? 'degraded' : 'ok';

      if (sampledPressure) {
        return sendJson(res, 200, { ...base, checks, pressure: sampledPressure }, req);
      }

      const { pressure: _ignoredPressure, ...withoutPressure } = base;
      return sendJson(res, 200, { ...withoutPressure, checks }, req);
    }

    // Shared conversation/file routes (no auth — wrapped in error handler)
    if (segments[0] === 'api' && segments[1] === 'shared' && segments[2]) {
      try {
        if (segments[3] === 'download' && segments.length === 4) {
          return await handleSharedFileDownload(req, res, segments[2], deps);
        }
        if (segments[3] === 'unlock' && segments.length === 4) {
          return await handleSharedConversationUnlock(req, res, segments[2], deps);
        }
        if (segments.length === 3) {
          return await handleSharedConversation(req, res, segments[2], deps);
        }
      } catch (err) {
        if (err instanceof RouteError) {
          return sendRouteError(res, req, err);
        }
        log({ level: 'error', msg: 'Shared route error', method: req.method, path: logPath, error: (err as Error).message });
        captureRouteError(err, req, { route, phase: 'shared-route' });
        if (!res.headersSent) return sendRouteError(res, undefined, new RouteError('INTERNAL_ERROR', { status: 500, message: 'An unexpected error occurred' }));
      }
    }

    // Slack webhook (no auth - verifies its own HMAC)
    if (segments[0] === 'api' && segments[1] === 'integrations' && segments[2] === 'slack' && segments[3] === 'events') {
      return await handleSlackWebhook(req, res);
    }

    // Slack OAuth callback (no bearer auth — protected by single-use state).
    if (segments[0] === 'api' && segments[1] === 'integrations' && segments[2] === 'slack' && segments[3] === 'oauth' && segments[4] === 'callback') {
      return await handleSlackOAuthCallback(req, res);
    }

    // Meeting transcript segment ingest (HMAC-v2 auth, no bearer — must be before bearer auth gate)
    if (segments[0] === 'api' && segments[1] === 'meeting' && segments[2] === 'transcript-segment') {
      return await handleMeetingTranscriptSegmentReceive(req, res, {
        rollingTranscript: cloudRollingTranscript,
        receiveEnabled: process.env.CLOUD_TRANSCRIPT_RECEIVE_ENABLED === 'true',
        hmacSecret: process.env.MINDSTONE_TRANSCRIPT_HMAC_SECRET,
      });
    }

    // Meeting fallback analysis (HMAC auth, not bearer — must be before bearer auth gate)
    if (segments[0] === 'api' && segments[1] === 'meeting' && segments[2] === 'fallback-analysis') {
      return await handleMeetingFallbackAnalysis(req, res, meetingAnalysisDeps);
    }

    if (segments[0] === '__e2e') {
      if (!isCloudE2eTestModeEnabled()) {
        return sendRouteError(res, undefined, new RouteError('NOT_FOUND', { status: 404, message: 'Not found' }));
      }
      return await handleE2eFixtures(req, res, segments, deps);
    }

    // Auth check
    if (!authorize(req)) {
      return sendRouteError(res, undefined, new RouteError('UNAUTHORIZED', { status: 401, message: 'Invalid or missing bearer token' }));
    }

    try {
      // Share links list (authenticated)
      if (segments[0] === 'api' && segments[1] === 'shares' && segments.length === 2) {
        return await handleSharesList(req, res);
      }

      // File shares management (authenticated)
      if (segments[0] === 'api' && segments[1] === 'file-shares' && segments.length === 2) {
        return await handleFileShare(req, res, deps);
      }

      // Sessions
      if (segments[0] === 'api' && segments[1] === 'sessions') {
        return await handleSessions(req, res, segments, deps);
      }

      // Settings
      if (route === '/api/settings') {
        return await handleSettings(req, res, deps);
      }

      // Slack OAuth / workspace management (authenticated).
      if (segments[0] === 'api' && segments[1] === 'integrations' && segments[2] === 'slack' && segments[3] === 'oauth' && segments[4] === 'start') {
        if (segments[5] === 'managed') return await handleSlackOAuthStartManaged(req, res);
        if (segments[5] === 'byok' || segments.length === 5) return await handleSlackOAuthStartByok(req, res);
        throw new RouteError('NOT_FOUND', { status: 404, message: 'Not Found' });
      }
      if (segments[0] === 'api' && segments[1] === 'integrations' && segments[2] === 'slack' && segments[3] === 'workspace') {
        if (req.method === 'GET') return await handleSlackWorkspaceGet(req, res);
        if (req.method === 'DELETE') return await handleSlackWorkspaceDelete(req, res);
        throw new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Method Not Allowed' });
      }
      if (segments[0] === 'api' && segments[1] === 'integrations' && segments[2] === 'slack' && segments[3] === 'managed' && segments[4] === 'provision-tokens') {
        return await handleSlackManagedProvisionTokens(req, res);
      }
      if (segments[0] === 'api' && segments[1] === 'integrations' && segments[2] === 'slack' && segments[3] === 'managed' && segments[4] === 'inbound') {
        return await handleSlackManagedInbound(req, res);
      }

      if (segments[0] === 'api' && segments[1] === 'slack' && segments[2] === 'recent-senders' && segments.length === 3) {
        return await handleSlackRecentSenders(req, res);
      }
      if (
        segments[0] === 'api'
        && segments[1] === 'slack'
        && segments[2] === 'recent-senders'
        && segments[3] === 'clear-all'
        && segments.length === 4
      ) {
        return await handleSlackRecentSendersClearAll(req, res);
      }

      // Codex OAuth token sync (desktop → cloud). See routes/codexTokens.ts.
      if (route === '/api/codex/tokens') {
        return await handleCodexTokens(req, res);
      }

      // Managed Mindstone-subscription OpenRouter key sync (desktop → cloud).
      // See routes/openRouterManagedKey.ts. Lets cloud serve `activeProvider:
      // 'mindstone'` turns (Layer 3 / DI-05 parity).
      if (route === '/api/openrouter/managed-key') {
        return await handleOpenRouterManagedKey(req, res);
      }

      // Agent stop
      if (route === '/api/agent/stop') {
        return await handleAgentStop(req, res);
      }

      // Library
      if (segments[0] === 'api' && segments[1] === 'library') {
        return await handleLibrary(req, res, segments, deps);
      }

      // Data archive upload (streaming tar.gz)
      if (segments[0] === 'api' && segments[1] === 'data' && segments[2] === 'upload-archive') {
        return await handleDataUploadArchive(req, res);
      }

      // Reconcile partial / orphaned extract (called by desktop on startup
      // when a prior `cloud:migrate` never completed — see planning doc
      // Stage 6).
      if (segments[0] === 'api' && segments[1] === 'data' && segments[2] === 'reconcile' && segments.length === 3) {
        return await handleDataReconcile(req, res);
      }

      // Push notification token registration
      if (segments[0] === 'api' && segments[1] === 'push') {
        return await handlePush(req, res, segments);
      }

      // Continuity state map (desktop pushes, mobile/web reads)
      if (segments[0] === 'api' && segments[1] === 'continuity') {
        return await handleContinuity(req, res, segments, deps);
      }

      // Voice transcription (binary POST)
      if (segments[0] === 'api' && segments[1] === 'voice' && segments[2] === 'transcribe') {
        return await handleVoiceTranscribe(req, res);
      }

      // Voice text-to-speech (JSON POST)
      if (segments[0] === 'api' && segments[1] === 'voice' && segments[2] === 'tts') {
        return await handleVoiceTts(req, res);
      }

      // Meeting recording upload (binary POST, bearer auth)
      if (segments[0] === 'api' && segments[1] === 'meeting' && segments[2] === 'recording-upload') {
        return await handleMeetingRecordingUpload(req, res, meetingAnalysisDeps);
      }

      // Meeting recording status poll
      if (segments[0] === 'api' && segments[1] === 'meeting' && segments[2] === 'recording-status' && segments[3]) {
        return await handleMeetingRecordingStatus(req, res, segments[3]);
      }

      // Meeting chunk-session lifecycle
      if (segments[0] === 'api' && segments[1] === 'meeting' && segments[2] === 'session') {
        if (segments[3] === 'create' && segments.length === 4) {
          return await handleMeetingSessionCreate(req, res, meetingUploadSessionStore);
        }
        if (segments[3] && segments[4] === 'chunk' && segments.length === 5) {
          return await handleMeetingSessionChunkUpload(req, res, segments[3], meetingUploadSessionStore);
        }
        if (segments[3] && segments[4] === 'status' && segments.length === 5) {
          return await handleMeetingSessionStatus(req, res, segments[3], meetingUploadSessionStore);
        }
        if (segments[3] && segments[4] === 'finalize' && segments.length === 5) {
          return await handleMeetingSessionFinalize(req, res, segments[3], meetingUploadSessionStore);
        }
        // Coaching activation/deactivation: POST/DELETE /api/meeting/session/:id/coach
        if (segments[3] && segments[4] === 'coach' && segments.length === 5) {
          if (req.method === 'POST') {
            return await handleMeetingSessionCoachActivate(req, res, segments[3], meetingUploadSessionStore);
          }
          if (req.method === 'DELETE') {
            return await handleMeetingSessionCoachDeactivate(req, res, segments[3], meetingUploadSessionStore);
          }
          return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST and DELETE are allowed' }));
        }
      }

      // User feedback (submitted to Sentry)
      if (route === '/api/feedback') {
        return await handleFeedback(req, res);
      }

      // MCP config
      if (segments[0] === 'api' && segments[1] === 'mcp' && segments[2] === 'config') {
        return await handleMcpConfig(req, res);
      }

      // Auth relay
      if (route === '/api/auth/relay') {
        return await handleAuthRelay(req, res);
      }
      if (route.startsWith('/api/auth/relay/')) {
        return await handleAuthRelayPull(req, res);
      }

      // Admin (self-update, DNS cleanup)
      if (segments[0] === 'api' && segments[1] === 'admin') {
        return await handleAdmin(req, res, segments);
      }

      // Diagnostics (authenticated)
      if (route === '/api/diagnostics') {
        return await handleDiagnostics(req, res, { listSessions: deps.listSessions });
      }

      if (route === '/api/diagnostics/self') {
        return await handleDiagnosticsSelf(req, res, { listSessions: deps.listSessions });
      }

      if (route === '/api/diagnostics/recent-events') {
        return await handleDiagnosticsRecentEvents(req, res);
      }

      if (route === '/api/diagnostics/recent-logs') {
        return await handleDiagnosticsRecentLogs(req, res);
      }

      if (route === '/api/diagnostics/log-file-paths') {
        return await handleDiagnosticsLogFilePaths(req, res);
      }

      if (route === '/api/storage/usage') {
        return await handleStorageUsage(req, res);
      }

      // Generic IPC forwarding
      if (segments[0] === 'api' && segments[1] === 'ipc' && segments[2]) {
        return await handleGenericIpc(req, res, segments, deps);
      }

      return sendRouteError(res, undefined, new RouteError('NOT_FOUND', { status: 404, message: `No route for ${req.method} ${route}` }));
    } catch (err) {
      if (err instanceof RouteError) {
        return sendRouteError(res, req, err);
      }
      log({ level: 'error', msg: 'Unhandled route error', error: (err as Error).message, route: logPath });
      captureRouteError(err, req, { route, phase: 'authenticated' });
      return sendRouteError(res, undefined, new RouteError('INTERNAL_ERROR', { status: 500, message: 'An unexpected error occurred' }));
    }
    })().catch((err: unknown) => {
      if (err instanceof RouteError) {
        return sendRouteError(res, req, err);
      }
      log({ level: 'error', msg: 'Unhandled route error', error: (err as Error).message, path: req.url });
      // `route` is scoped inside the async IIFE above and not visible here, so
      // recompute the query-free route family from the parsed path (never pass
      // req.url, which may carry a bearer token in its query string).
      const outerRoute = `/${parsePath(req.url).join('/')}`;
      if (!res.headersSent) {
        captureRouteError(err, req, { route: outerRoute, phase: 'async-outer' });
        return sendRouteError(res, undefined, new RouteError('INTERNAL_ERROR', { status: 500, message: 'An unexpected error occurred' }));
      }
      // Response already started — can't deliver an error body. Error is logged
      // above; record the intentional best-effort swallow for observability.
      captureRouteError(err, req, { route: outerRoute, phase: 'async-outer-headers-sent' });
      ignoreBestEffortCleanup(err, {
        operation: 'cloud.httpRequest',
        reason: 'response headers already sent; cannot deliver error response',
      });
      return undefined;
    }), 'cloud.httpRequest');
  });

  // WebSocket server for agent turns and persistent event channel
  // Increase payload limit to 10MB to support file attachments in turns
  const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    // SECURITY: Do not log `req.url` — it may contain the bearer token as a query parameter.
    const segments = parsePath(req.url);
    const route = `/${segments.join('/')}`;
    const isWarmupEligibleUpgradeRoute = route === '/api/agent/turn' || route === '/api/events';

    if (isWarmupEligibleUpgradeRoute) {
      cloudBootstrapWarmup.observeRequest('UPGRADE', route, false);
    }

    if (!isWarmupEligibleUpgradeRoute) {
      socket.destroy();
      return;
    }

    // React Native's WebSocket does not support custom headers. Allow clients to pass
    // the bearer token as `?token=<bearer>` and inject it into the Authorization header
    // so the existing `authorize()` function works unchanged. Only applies when no
    // Authorization header is already present (desktop clients send the header directly).
    if (!req.headers.authorization) {
      const url = new URL(req.url || '', 'http://localhost');
      const queryToken = url.searchParams.get('token');
      if (queryToken) {
        req.headers.authorization = `Bearer ${queryToken}`;
      }
    }

    if (!authorize(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (route === '/api/agent/turn') {
        handleAgentTurnWs(ws, deps);
      } else {
        handleEventChannelWs(ws);
      }
    });
  });

  // Allow long-running requests (workspace archive uploads can be 4GB+).
  // Node.js defaults requestTimeout to 300s (5min) which kills large uploads.
  server.requestTimeout = 0;   // no limit — client-side timeout controls abort
  server.headersTimeout = 0;
  server.timeout = 0;

  let bootSuccessMarkerHandle: BootSuccessMarkerHandle | null = null;

  server.listen(PORT, () => {
    log({ level: 'info', msg: `Rebel Cloud Service listening on port ${PORT}` });
    // Synchronous stderr sentinel so the message is observable in `docker logs`
    // and `fly logs`. The pino logger writes to a rotating file via the
    // pino-roll transport (see src/core/logger.ts) — its output never reaches
    // stdout/stderr in production. Mirrors the `[fatal]` sentinel pattern in
    // main().catch below and gives the Stage A1 smoke test a deterministic
    // boot-success marker visible from outside the container.
    console.error(`[ready] Rebel Cloud Service listening on port ${PORT}`);
    // Stage C1 of docs/plans/260510_cloud_image_rollback_defense_in_depth.md:
    // schedule the post-grace boot-success marker. Skipped when FLY_IMAGE_REF
    // is absent (dev / VM / smoke without Fly env) — the watchdog in Stage C2
    // is also Fly-only.
    bootSuccessMarkerHandle = maybeScheduleBootSuccessMarker();
    // Stage C3 regression fixture: only fires when BOTH
    // REBEL_FORCE_BOOT_CRASH=1 and IS_CI_SMOKE_TEST=1 are set. Cannot trip
    // in production. Crashes 100ms after listen so the watchdog can be
    // tested end-to-end on the next boot.
    maybeInstallForcedBootCrash();
  });

  // Graceful shutdown
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    log({ level: 'info', msg: 'Shutting down...' });
    const exitTimer = setTimeout(() => process.exit(1), 5000);
    exitTimer.unref?.();
    void (async () => {
      // Stop graceful-fs queue sampler (releases the unref'd setInterval).
      try { stopGracefulFsObservability(); } catch { /* swallow on shutdown */ }
      // Stop cloud data hygiene scheduler (cancels pending startup/interval timers).
      await import('./services/cloudHygieneScheduler').then(({ getCloudHygieneSchedulerHandle }) => {
        getCloudHygieneSchedulerHandle()?.stop();
      }).catch(() => { /* ignore — may not be loaded */ });
      // Stage 5: flush buffered analytics before exit. The RudderStack Node
      // client buffers (flushAt:20 / flushInterval:5000ms), so events emitted in
      // the final window (e.g. a burst of `Cost Incurred`) would be lost on a Fly
      // SIGTERM/image-swap without this. The RudderStack client has NO axios
      // timeout (src/main/analytics.ts:260), so its HTTP flush can wait on
      // retries — F2 bounds it with an independent 2s race so shutdown cleanup
      // stays deterministic regardless of the 5s exit timer. Swallow rejections
      // (matches the existing shutdown discipline) so a flush failure or timeout
      // never blocks the rest of cleanup.
      try {
        await Promise.race([
          flushMainAnalytics(),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS);
            t.unref?.();
          }),
        ]);
      } catch (flushError) {
        ignoreBestEffortCleanup(flushError, {
          operation: 'cloud.shutdown.flushAnalytics',
          reason: 'analytics flush on shutdown failed; must not block shutdown cleanup',
        });
      }
      stopStaleBusyReaper();
      bootSuccessMarkerHandle?.cancel();
      unsubscribeMeetingSegmentAppended();
      unsubscribeTranscriptionCleanup();
      await meetingQuestionTriggerService?.dispose();
      meetingUploadSessionStore.stop();
      await deps.cleanup?.();
      cloudEventBroadcaster.closeAll();
      wss.clients.forEach((ws) => ws.close(1001, 'Server shutting down'));
      await shutdownCloudDiagnosticEventsLedger();
      server.close(() => {
        clearTimeout(exitTimer);
        log({ level: 'info', msg: 'Server closed' });
        process.exit(0);
      });
    })().catch((err) => {
      log({ level: 'error', msg: 'Shutdown failed', error: err instanceof Error ? err.message : String(err) });
      process.exit(1);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(async (err) => {
  // Use synchronous stderr write before process.exit. Pino's transport may
  // not flush its stdout buffer before the process terminates, which would
  // make boot failures completely silent on Fly (no log line visible — only
  // `Main child exited normally with code: 1`). console.error writes
  // synchronously to stderr and is captured by Fly logs.
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error && err.stack ? err.stack : '';
  console.error(`[fatal] Failed to start cloud service: ${message}`);
  if (stack) console.error(stack);
  log({ level: 'fatal', msg: 'Failed to start', error: message, stack });
  // F1 (Stage 6a) — bootstrap failures must reach Sentry. `main().catch`
  // converts the bootstrap promise rejection into a handled error before any
  // default Sentry-Node integration could see it, so we capture explicitly and
  // do a BOUNDED flush before exit (the buffered event is otherwise lost when
  // process.exit terminates the SDK transport). Tagged area:'bootstrap'.
  try {
    getErrorReporter().captureException(err, {
      level: 'fatal',
      tags: { surface: 'cloud', area: 'bootstrap' },
    });
    // Bounded flush so a hung Sentry transport can't block the exit.
    await Sentry.flush(2000);
  } catch (captureError) {
    // Best-effort: the fatal is already logged to stderr above. A capture/flush
    // failure must not prevent the exit.
    ignoreBestEffortCleanup(captureError, {
      operation: 'cloud.bootstrap.captureFatal',
      reason: 'Sentry capture/flush of a bootstrap failure failed; fatal already logged to stderr',
    });
  } finally {
    process.exit(1);
  }
});
