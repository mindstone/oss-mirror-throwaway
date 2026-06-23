/**
 * Feedback route handler.
 *
 * POST /api/feedback — accepts structured user feedback and forwards to Sentry.
 * Validates with Zod, rate-limits per bearer token, and never logs user message content.
 */

import http from 'node:http';
import { z } from 'zod';
import { readBody, sendJson, log, sendRouteError, RouteError } from '../httpUtils';
import { submitFeedback } from '../sentryFeedback';
import { DiagnosticSectionsSchema } from '@shared/diagnostics/diagnosticBundleSections';

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

const FeedbackSchema = z.object({
  feedbackType: z.enum(['bug', 'improvement', 'other']),
  urgency: z.enum(['low', 'medium', 'high', 'critical']),
  message: z.string().min(1).max(5000),
  stepsToReproduce: z.string().max(5000).optional(),
  expectedBehavior: z.string().max(5000).optional(),
  platform: z.enum(['web', 'ios', 'android']),
  appVersion: z.string().max(50).optional(),
  // Client-minted idempotency keys (mobile offline feedback queue). Optional for
  // backwards-compat: older mobile builds and the web companion omit them, and the
  // relay falls back to title-based grouping with a server-minted event_id.
  //   - `clientReportId`: stable per-report id → per-report fingerprint entropy so
  //     each distinct report is its own Sentry issue (Sentry→Linear fires per
  //     report). Mirrors desktop Stage 3.
  //   - `eventId`: stable 32-char lowercase hex reused across the queue's retries
  //     → set as the Sentry `event_id` so a retried-after-delivery report dedups
  //     server-side instead of creating a duplicate issue. Mirrors desktop's fixed
  //     event_id idempotency. Validated as hex (NOT a dashed UUID) so the SDK
  //     accepts it verbatim.
  clientReportId: z.string().min(1).max(64).optional(),
  eventId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
  diagnosticSections: DiagnosticSectionsSchema.optional(),
  diagnostics: z.object({
    deviceInfo: z.record(z.string(), z.string()),
    filteredLogs: z.string().max(100_000).optional(),
    logLineCount: z.number().int().nonnegative().optional(),
    queueSnapshot: z.object({
      pendingCount: z.number().int().nonnegative(),
      processingCount: z.number().int().nonnegative(),
      countsByType: z.record(z.string(), z.number().int().nonnegative()),
      countsByErrorCategory: z.record(z.string(), z.number().int().nonnegative()),
      maxAttempts: z.number().int().nonnegative(),
      oldestAgeMs: z.number().int().nonnegative().nullable(),
      queueFull: z.boolean(),
      limitedConnectivity: z.boolean(),
      authExpired: z.boolean(),
    }).optional(),
    continuityState: z.object({
      connectionState: z.enum(['connected', 'reconnecting', 'disconnected']),
      knownSessionCount: z.number().int().nonnegative(),
      appliedSeqSessionCount: z.number().int().nonnegative(),
      lastTombstoneSyncAt: z.number().int().nonnegative().nullable(),
      queueBoundCloudUrlHash: z.string().max(128).optional(),
    }).optional(),
    catchUpHistory: z.array(z.object({
      sessionIdHash: z.string().max(128),
      appliedSeq: z.number().int().positive(),
    })).max(100).optional(),
  }).optional(),
  serverContext: z.string().max(100_000).optional(),
});

// ---------------------------------------------------------------------------
// In-memory rate limiting (per bearer token, max 5 per minute)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimits = new Map<string, RateLimitEntry>();
const MAX_PER_MINUTE = 5;
const WINDOW_MS = 60_000;

function isRateLimited(token: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(token);

  if (!entry || now >= entry.resetAt) {
    rateLimits.set(token, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  if (entry.count >= MAX_PER_MINUTE) {
    return true;
  }

  entry.count++;
  return false;
}

// Periodically clean up expired entries to prevent unbounded growth
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now >= entry.resetAt) {
      rateLimits.delete(key);
    }
  }
}, WINDOW_MS);
cleanupTimer.unref();

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleFeedback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST is allowed' }));
  }

  // Rate limit by bearer token
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : 'anonymous';

  if (isRateLimited(token)) {
    return sendRouteError(res, undefined, new RouteError('RATE_LIMITED', { status: 429, message: 'Too many feedback submissions. Please try again later.' }));
  }

  // Parse body — return 400 on malformed JSON or oversized payload
  let rawBody: unknown;
  try {
    rawBody = await readBody(req);
  } catch {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: 'Request body must be valid JSON' }));
  }
  const result = FeedbackSchema.safeParse(rawBody);

  if (!result.success) {
    const firstIssue = result.error.issues[0];
    return sendRouteError(res, undefined, new RouteError('VALIDATION_ERROR', { status: 400, message: `${firstIssue.path.join('.')}: ${firstIssue.message}` }));
  }

  const feedback = result.data;

  // Log metadata only — never log user message content
  log({
    level: 'info',
    msg: 'Feedback received',
    feedbackType: feedback.feedbackType,
    urgency: feedback.urgency,
    platform: feedback.platform,
  });

  try {
    const result = await submitFeedback(feedback);
    if (result.outcome === 'skipped') {
      // HONEST not-delivered (PLAN Stage 6 / R3). Sentry is not configured, so the
      // report did NOT reach the team. We must not return 2xx here — that is the
      // silent-drop-dressed-as-success bug we are fixing.
      //
      // CONSUMER CONTRACT (verified inventory): the cloud-client callers are
      // web-companion/src/screens/HelpScreen.tsx (synchronous `submitFeedback`,
      // treats any resolve as success + ignores the body) and the mobile offline
      // feedback queue consumer (mobile/src/hooks/useFeedbackQueueConsumer.ts via
      // `submitFeedbackOnce`, which classifies the thrown status to decide
      // retry-vs-terminal). cloud-client request() THROWS CloudClientError on a
      // non-2xx status, so any non-2xx surfaces the web companion's "couldn't
      // send" catch and the mobile consumer's failure classification. (Mobile
      // help.tsx no longer calls submitFeedback directly — it enqueues.)
      //
      // MUST-2 (Phase 7, GPT F2): status choice composes with the shared client
      // RETRY policy. `cloud-client/src/cloudClient.ts` `isTransientError()` treats
      // 408/429/502/503/504 as transient and the default `request()` path retries
      // those up to MAX_RETRIES (3×) before the failure surfaces. Sentry being
      // unconfigured is a STATIC deploy condition — retrying it 3× only burns the
      // per-token feedback rate limit and delays the visible failure for no benefit.
      // So we use 422 (Unprocessable Entity): a 4xx that is NOT in `isTransientError`
      // → the client throws immediately on the first attempt (no retry). The honest
      // `{ delivered:false, reason }` body is preserved for any future body-reading
      // consumer.
      log({
        level: 'warn',
        msg: 'Feedback not delivered — Sentry reporting unavailable; returning 422 (non-retrying) to the client',
        feedbackType: feedback.feedbackType,
        urgency: feedback.urgency,
        platform: feedback.platform,
      });
      return sendRouteError(res, undefined, new RouteError('FEEDBACK_FAILED', {
        status: 422,
        message: 'Reporting is unavailable right now and your report was not delivered. Please try again later.',
        details: { delivered: false, reason: result.reason },
      }));
    }
    if (result.outcome === 'failed') {
      // MUST-1 (Phase 7): Sentry IS configured but the flush timed out with events
      // still buffered — the report did not leave the transport. Honest non-2xx (not
      // 200). Unlike the static `skipped` config failure, a flush timeout MIGHT be a
      // transient transport blip, so we DELIBERATELY use 503 here: `isTransientError`
      // treats it as transient, so the shared client gives it its normal retry
      // budget — exactly the right lever for a possibly-recoverable transport stall.
      log({
        level: 'warn',
        msg: 'Feedback not confirmed delivered — Sentry flush timed out; returning 503 (retryable) to the client',
        feedbackType: feedback.feedbackType,
        urgency: feedback.urgency,
        platform: feedback.platform,
      });
      return sendRouteError(res, undefined, new RouteError('FEEDBACK_FAILED', {
        status: 503,
        message: 'We could not confirm your report was delivered. Please try again.',
        details: { delivered: false, reason: result.reason },
      }));
    }
    return sendJson(res, 200, { success: true, delivered: true });
  } catch (err) {
    log({ level: 'error', msg: 'Failed to submit feedback to Sentry', error: (err as Error).message });
    return sendRouteError(res, undefined, new RouteError('FEEDBACK_FAILED', { status: 500, message: 'Failed to submit feedback. Please try again.' }));
  }
}
