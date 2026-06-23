/**
 * Sentry Feedback Module
 *
 * Lazily initializes a dedicated Sentry client for submitting user feedback
 * from cloud clients (web companion, mobile app).
 *
 * Sentry import rule for the cloud bundle (build.mjs aliases):
 *   - Capture / init / scope APIs come from '@sentry/node' (externalized, real).
 *   - '@sentry/core' is NOT aliased: its transport/envelope primitives
 *     (makeOfflineTransport / serializeEnvelope / parseEnvelope) are real and
 *     usable — bundled for the cloud offline transport.
 *   - Only '@sentry/electron' / '@sentry/electron/main' are shimmed to no-ops
 *     (they pull Electron at import time, the cloud import-time hazard). A
 *     VALUE import from those WILL silently swallow calls — use '@sentry/node'.
 */

import * as Sentry from '@sentry/node';
import type { DiagnosticSections } from '@shared/diagnostics/diagnosticBundleSections';
import { truncateWellFormed } from '@shared/utils/wellFormedUnicode';
import { shouldEnableSentry } from '@shared/telemetry/sentryConfig';
import { log } from './httpUtils';

// F4 (Phase 7): use the SAME enablement predicate bootstrap.ts uses
// (`shouldEnableSentry({ dsn })`) so the `SENTRY_ENABLED` kill-switch applies
// here too. Previously this checked only `SENTRY_DSN`, so with
// `SENTRY_ENABLED=0` the Sentry client was never initialized yet feedback would
// still log "Feedback submitted to Sentry" — inconsistent operator semantics
// (claiming submitted while disabled). `dsn` is passed verbatim to match the
// key-presence semantics bootstrap relies on.
function isSentryConfigured(): boolean {
  return shouldEnableSentry({ dsn: process.env.SENTRY_DSN?.trim() || undefined });
}

export interface FeedbackData {
  feedbackType: string;
  urgency: string;
  message: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  platform: string;
  appVersion?: string;
  /**
   * Client-minted idempotency keys (mobile offline feedback queue). Both optional
   * for backwards-compat — older mobile builds / the web companion omit them.
   *   - `clientReportId`: per-report fingerprint entropy so each distinct report
   *     is its own Sentry issue (Sentry→Linear fires per report; desktop Stage 3).
   *   - `eventId`: 32-char hex reused across the queue's retries → set as the
   *     Sentry `event_id` so a retried-after-delivery report dedups server-side
   *     instead of creating a duplicate issue (desktop fixed-event_id idempotency).
   */
  clientReportId?: string;
  eventId?: string;
  diagnosticSections?: DiagnosticSections;
  diagnostics?: {
    deviceInfo: Record<string, string>;
    filteredLogs?: string;
    logLineCount?: number;
    queueSnapshot?: {
      pendingCount: number;
      processingCount: number;
      queueFull: boolean;
      limitedConnectivity: boolean;
      authExpired: boolean;
      maxAttempts: number;
    };
    continuityState?: {
      connectionState: 'connected' | 'reconnecting' | 'disconnected';
      knownSessionCount: number;
      appliedSeqSessionCount: number;
      lastTombstoneSyncAt: number | null;
      queueBoundCloudUrlHash?: string;
    };
    catchUpHistory?: Array<{
      sessionIdHash: string;
      appliedSeq: number;
    }>;
  };
  serverContext?: string;
}

/**
 * Outcome of a feedback submission, so the route can answer HONESTLY instead of
 * always claiming success (PLAN Stage 6 / R3). Discriminates:
 *   - `delivered` — the event was captured and flushed to Sentry transport.
 *   - `skipped`   — Sentry is not configured (no DSN / `SENTRY_ENABLED=0`), so the
 *     report was NOT delivered. Previously this path logged + returned void and the
 *     route still returned `{ success: true }` — a silent drop dressed as success,
 *     the exact class this task exists to kill.
 * A genuine transport throw is NOT represented here — it propagates so the route's
 * existing catch maps it to FEEDBACK_FAILED (500).
 *
 *   - `failed` — Sentry IS configured, but `Sentry.flush()` did not confirm the
 *     event left the transport within the timeout (returned `false`: events still
 *     buffered). Previously this still returned `delivered` → HTTP 200, the exact
 *     "success dressed around non-delivery" class this task kills. Mirrors desktop,
 *     which gates delivery on the flush outcome. Distinct from `skipped` (a static
 *     config failure) because a flush timeout MIGHT be a transient transport blip
 *     (see the route for the retry-classification choice).
 */
export type FeedbackSubmitResult =
  | { outcome: 'delivered' }
  | { outcome: 'skipped'; reason: 'reporting-unavailable' }
  | { outcome: 'failed'; reason: 'flush-timeout' };

/**
 * Submit user feedback to Sentry.
 *
 * Tags include metadata only — the user's message is sent as the feedback body
 * but never logged server-side.
 *
 * Returns a discriminated {@link FeedbackSubmitResult} so the caller can reflect
 * non-delivery honestly. Throws only on a genuine transport/capture failure.
 */
export async function submitFeedback(feedback: FeedbackData): Promise<FeedbackSubmitResult> {
  if (!isSentryConfigured()) {
    // Loud-but-not-fatal: this is a DEGRADED state (the report did not reach the
    // team), surfaced to the operator here and to the user via the route's
    // honest non-2xx response — NOT a swallowed success.
    log({
      level: 'warn',
      msg: 'Feedback NOT delivered: Sentry is disabled (no DSN or SENTRY_ENABLED=0) — returning not-delivered to the client',
      feedbackType: feedback.feedbackType,
      urgency: feedback.urgency,
      platform: feedback.platform,
    });
    return { outcome: 'skipped', reason: 'reporting-unavailable' };
  }

  const serverVersion = process.env.REBEL_VERSION || __REBEL_VERSION__;

  // Compose full message including bug-detail fields so nothing is silently dropped
  const parts = [feedback.message];
  if (feedback.stepsToReproduce) parts.push(`\n\nSteps to reproduce:\n${feedback.stepsToReproduce}`);
  if (feedback.expectedBehavior) parts.push(`\n\nExpected behavior:\n${feedback.expectedBehavior}`);

  const tags: Record<string, string> = {
    feedbackType: feedback.feedbackType,
    urgency: feedback.urgency,
    platform: feedback.platform,
    serverVersion,
    source: 'cloud-feedback',
    ...(feedback.appVersion ? { appVersion: feedback.appVersion } : {}),
  };

  // Add device info tags and diagnostic attachment when diagnostics are present
  if (feedback.diagnostics) {
    tags.hasDiagnostics = 'true';
    for (const [key, value] of Object.entries(feedback.diagnostics.deviceInfo)) {
      tags[`device.${key}`] = value;
    }
    if (feedback.diagnostics.logLineCount !== undefined) {
      tags.logLineCount = String(feedback.diagnostics.logLineCount);
    }
    if (feedback.diagnostics.queueSnapshot) {
      tags.queuePending = String(feedback.diagnostics.queueSnapshot.pendingCount);
      tags.queueProcessing = String(feedback.diagnostics.queueSnapshot.processingCount);
      tags.queueMaxAttempts = String(feedback.diagnostics.queueSnapshot.maxAttempts);
      tags.queueAuthExpired = String(feedback.diagnostics.queueSnapshot.authExpired);
    }
    if (feedback.diagnostics.continuityState) {
      tags.continuityConnection = feedback.diagnostics.continuityState.connectionState;
      tags.continuitySessions = String(feedback.diagnostics.continuityState.knownSessionCount);
    }
  }

  // Use captureMessage (not captureFeedback) to match desktop behavior:
  // desktop bugReportHandlers.ts uses SentryMain.captureMessage() with level 'error',
  // which creates Issue events in Sentry. captureFeedback() creates Feedback events
  // that only appear in the Feedback tab, not Issues.
  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(tags)) {
      scope.setTag(key, value);
    }

    // PRIVACY (F7 audit, PLAN Stage 6b): the attachment payloads below
    // (`filteredLogs`, `diagnostics`, `diagnosticSections`, `serverContext`) are
    // PRE-REDACTED AT SOURCE on the submitting client, NOT here. `/api/feedback`
    // is a relay endpoint: the client builds the diagnostic bundle through the
    // same deny-by-default allowlist + secret/PII redaction the desktop bug
    // report uses (mobile: mobile/src/utils/logFilter.ts `filterLogEntries`
    // produces `filteredLogs`; the diagnostic bundle service runs
    // `redactSensitiveData` before serialising sections — src/core/services/
    // diagnostics/diagnosticBundleService.ts). The Zod schema in routes/
    // feedback.ts enforces shape/size only. We therefore attach verbatim; do NOT
    // pass raw, unredacted free text through this path. If a future client
    // submits an attachment field that is NOT redacted at source, redact it here
    // before addAttachment rather than relying on this invariant.
    // Attach filtered logs as an NDJSON file when diagnostics are present
    if (feedback.diagnostics?.filteredLogs) {
      scope.addAttachment({
        filename: 'filtered-logs.ndjson',
        data: feedback.diagnostics.filteredLogs,
        contentType: 'application/x-ndjson',
      });
    }

    if (feedback.diagnostics) {
      scope.addAttachment({
        filename: 'mobile-diagnostics.json',
        data: JSON.stringify(feedback.diagnostics, null, 2),
        contentType: 'application/json',
      });
    }

    if (feedback.diagnosticSections) {
      scope.addAttachment({
        filename: 'diagnostic-sections.json',
        data: JSON.stringify(feedback.diagnosticSections, null, 2),
        contentType: 'application/json',
      });
    }

    if (feedback.serverContext) {
      scope.addAttachment({
        filename: 'server-context.json',
        data: feedback.serverContext,
        contentType: 'application/json',
      });
    }

    scope.setLevel('error');
    // Per-report fingerprint entropy (desktop Stage 3 parity): when the client
    // supplies a stable `clientReportId`, each distinct report becomes its own
    // Sentry issue, so the external Sentry→Linear automation fires per report.
    // Without it (older mobile / web companion), fall back to the first message
    // line — the legacy title-based grouping (which collapses distinct reports
    // with similar first lines into one issue). The `clientReportId` is also
    // surfaced as a tag for triage cross-referencing.
    const title = truncateWellFormed(feedback.message.trim().split('\n')[0], 120);
    if (feedback.clientReportId) {
      scope.setTag('clientReportId', feedback.clientReportId);
    }
    scope.setFingerprint(['cloud-feedback', feedback.feedbackType, feedback.clientReportId ?? title]);
    // Idempotency: when the client supplies a stable 32-hex `eventId` (reused
    // across the mobile offline queue's retries), set it as the Sentry
    // `event_id` so a retried-after-delivery report dedups server-side rather
    // than creating a duplicate issue. The SCOPED `scope.captureMessage(msg,
    // level, { event_id })` form is the only one that honors a preset event_id
    // (the top-level `Sentry.captureMessage(msg)` ignores it — verified against
    // @sentry/core prepareEvent; mirrors desktop bugReportHandlers.ts). Absent
    // `eventId`, keep the top-level call (the SDK mints a fresh id).
    if (feedback.eventId) {
      scope.captureMessage(parts.join(''), 'error', { event_id: feedback.eventId });
    } else {
      Sentry.captureMessage(parts.join(''));
    }
  });

  // Log metadata only — never log user message content
  log({
    level: 'info',
    msg: 'Feedback submitted to Sentry',
    feedbackType: feedback.feedbackType,
    urgency: feedback.urgency,
    platform: feedback.platform,
  });

  // Flush to improve delivery reliability before the response is sent.
  // NOTE (residual, PLAN Stage 4): a successful flush is transport-accept, not
  // server-side processing confirmation — Sentry can still drop oversize/filtered
  // events. We report `delivered` only on flush success (best client-side signal);
  // the Check G PostHog↔Sentry reconciliation monitor is the standing backstop for
  // the accept-but-dropped residual.
  //
  // MUST-1 (Phase 7, GPT F1 + Native F1): honour the boolean `Sentry.flush()`
  // returns. `false` means the timeout elapsed with events still buffered — the
  // report did NOT leave the transport, so reporting it as `delivered`/200 would
  // be the success-around-non-delivery lie we are fixing. Return an honest
  // `failed` outcome the route maps to a non-2xx.
  const flushed = await Sentry.flush(2000);
  if (!flushed) {
    log({
      level: 'warn',
      msg: 'Feedback NOT confirmed delivered: Sentry.flush() timed out with events still buffered — returning not-delivered to the client',
      feedbackType: feedback.feedbackType,
      urgency: feedback.urgency,
      platform: feedback.platform,
    });
    return { outcome: 'failed', reason: 'flush-timeout' };
  }

  return { outcome: 'delivered' };
}
