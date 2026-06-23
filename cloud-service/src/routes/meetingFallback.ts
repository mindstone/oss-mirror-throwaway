/**
 * Meeting fallback analysis route handler.
 *
 * POST /api/meeting/fallback-analysis
 *
 * Receives a transcript from the meeting bot worker when the user's desktop
 * was offline during a meeting. Verifies HMAC signature, saves transcript,
 * and runs headless agent analysis to create an inbox item.
 */

import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readRawBody, sendJson, log, sendRouteError, RouteError } from '../httpUtils';
import {
  runFallbackAnalysis,
  type FallbackAnalysisPayload,
  type CloudMeetingAnalysisDeps,
} from '../services/cloudMeetingAnalysis';

/**
 * Shared HMAC secret for worker → cloud webhook authentication.
 * Same secret the worker uses (env.MINDSTONE_AUTH_SECRET) to sign payloads.
 */
const HMAC_SECRET = process.env.MINDSTONE_AUTH_SECRET || '';

/**
 * Verify HMAC-SHA256 signature of a request body.
 * The worker signs with crypto.subtle.sign('HMAC', key, body) and base64-encodes the result.
 */
function verifyHmacSignature(rawBody: Buffer, signature: string): boolean {
  if (!HMAC_SECRET) {
    log({ level: 'error', msg: 'MINDSTONE_AUTH_SECRET not configured — rejecting webhook' });
    return false;
  }

  const expected = createHmac('sha256', HMAC_SECRET)
    .update(rawBody)
    .digest('base64');

  // Timing-safe comparison to prevent timing attacks
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Validate the fallback analysis payload shape.
 */
function validatePayload(body: unknown): body is FallbackAnalysisPayload {
  if (!body || typeof body !== 'object') return false;
  const obj = body as Record<string, unknown>;
  return (
    typeof obj.botId === 'string' &&
    typeof obj.userId === 'string' &&
    typeof obj.meetingTitle === 'string' &&
    typeof obj.transcript === 'string' &&
    Array.isArray(obj.participants) &&
    (obj.meetingStartTime === null || typeof obj.meetingStartTime === 'number')
  );
}

export async function handleMeetingFallbackAnalysis(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CloudMeetingAnalysisDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    return sendRouteError(res, undefined, new RouteError('METHOD_NOT_ALLOWED', { status: 405, message: 'Only POST is allowed' }));
  }

  // Verify HMAC signature
  const signature = req.headers['x-webhook-signature'];
  if (!signature || typeof signature !== 'string') {
    return sendRouteError(res, undefined, new RouteError('UNAUTHORIZED', { status: 401, message: 'Missing X-Webhook-Signature header' }));
  }

  let rawBody: Buffer;
  let parsed: unknown;
  try {
    const result = await readRawBody(req);
    rawBody = result.raw;
    parsed = result.parsed;
  } catch (err) {
    return sendRouteError(res, undefined, new RouteError('INVALID_BODY', { status: 400, message: err instanceof Error ? err.message : 'Invalid request body' }));
  }

  if (!verifyHmacSignature(rawBody, signature)) {
    return sendRouteError(res, undefined, new RouteError('UNAUTHORIZED', { status: 401, message: 'Invalid webhook signature' }));
  }

  // Validate payload
  if (!validatePayload(parsed)) {
    return sendRouteError(res, undefined, new RouteError('INVALID_PAYLOAD', { status: 400, message: 'Missing or invalid fields: botId, userId, meetingTitle, transcript, participants, meetingStartTime' }));
  }

  const { botId } = parsed;
  log({ level: 'info', msg: 'Received meeting fallback analysis request', botId });

  // Respond 202 immediately, run analysis in the background
  sendJson(res, 202, { accepted: true, botId });

  // Fire-and-forget analysis (errors are logged internally)
  runFallbackAnalysis(parsed, deps).catch((err) => {
    log({
      level: 'error',
      msg: 'Cloud fallback analysis failed (fire-and-forget)',
      botId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
