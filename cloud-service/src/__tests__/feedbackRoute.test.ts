/**
 * Tests for the feedback route handler (POST /api/feedback).
 *
 * Tests Zod validation, rate limiting, error responses, and successful submission.
 * Mocks sentryFeedback to isolate the route handler logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import { EventEmitter } from 'node:events';

vi.mock('../sentryFeedback', () => ({
  // Default: Sentry configured, report delivered. Individual tests override for
  // the not-configured (skipped) and transport-failure paths.
  submitFeedback: vi.fn().mockResolvedValue({ outcome: 'delivered' }),
}));

import { handleFeedback } from '../routes/feedback';
import { submitFeedback } from '../sentryFeedback';

// Mirror cloud-client's `isTransientError` set (cloud-client/src/cloudClient.ts) so
// these tests assert the route's status composes with the client's retry policy
// WITHOUT a cross-package import. Kept in lockstep deliberately (Phase 7 MUST-2).
const CLOUD_CLIENT_TRANSIENT_STATUSES = new Set([408, 429, 502, 503, 504]);
const isTransientStatus = (status: number): boolean => CLOUD_CLIENT_TRANSIENT_STATUSES.has(status);

let tokenCounter = 0;

function createMockReq(
  body: unknown,
  method = 'POST',
  token = `test-token-${++tokenCounter}`,
): http.IncomingMessage {
  const req = new EventEmitter() as http.IncomingMessage;
  req.method = method;
  req.headers = { authorization: `Bearer ${token}` };

  // Simulate body stream
  process.nextTick(() => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    req.emit('data', Buffer.from(data));
    req.emit('end');
  });

  return req;
}

type MockResShape = { _status: number; _body: string };

function createMockRes(): http.ServerResponse & { _status: number; _body: string } {
  const res = {
    _status: 0,
    _body: '',
    writeHead(this: MockResShape, status: number, headers: Record<string, string>) {
      this._status = status;
      void headers;
    },
    end(this: MockResShape, body: string) {
      this._body = body;
    },
  } as unknown as http.ServerResponse & { _status: number; _body: string };
  return res;
}

function validPayload<T extends Record<string, unknown> = Record<string, never>>(
  overrides?: T,
): {
  feedbackType: string;
  urgency: string;
  message: string;
  platform: string;
} & T {
  return {
    feedbackType: 'bug',
    urgency: 'medium',
    message: 'Something broke',
    platform: 'web',
    ...(overrides ?? ({} as T)),
  };
}

describe('handleFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 200 with delivered:true when Sentry delivered the report', async () => {
    const req = createMockReq(validPayload());
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(200);
    expect(JSON.parse(res._body)).toEqual({ success: true, delivered: true });
    expect(submitFeedback).toHaveBeenCalledOnce();
  });

  // PLAN Stage 6 / R3: when Sentry is not configured the report is NOT delivered.
  // The route must answer honestly (non-2xx) instead of the old unconditional
  // `{ success: true }` / 200 that silently dropped the report.
  // MUST-2 (Phase 7, GPT F2): Sentry-unconfigured is a STATIC config failure. It
  // must return a NON-transient status so the shared cloud-client `request()` path
  // surfaces it immediately instead of retrying 3× (which would only burn the
  // route's per-token rate limit). 422 is a 4xx NOT in cloud-client's
  // `isTransientError` (408/429/502/503/504), so the client throws on the first
  // attempt — no retry.
  it('returns 422 (non-retrying) honest not-delivered when Sentry reporting is unavailable (skipped)', async () => {
    vi.mocked(submitFeedback).mockResolvedValueOnce({ outcome: 'skipped', reason: 'reporting-unavailable' });

    const req = createMockReq(validPayload());
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(422);
    // 422 is intentionally NOT a cloud-client transient status → no client retry.
    expect(isTransientStatus(res._status)).toBe(false);
    const body = JSON.parse(res._body);
    expect(body.error.code).toBe('FEEDBACK_FAILED');
    // Honest, machine-readable not-delivered signal — never claims success.
    expect(body).toMatchObject({ delivered: false, reason: 'reporting-unavailable' });
    expect(body.success).toBeUndefined();
    expect(submitFeedback).toHaveBeenCalledOnce();
  });

  // MUST-1 (Phase 7, GPT F1 + Native F1): Sentry IS configured but the flush timed
  // out (events still buffered) → the report did not leave the transport. The route
  // must NOT report success. A flush timeout MIGHT be a transient transport blip, so
  // we deliberately use 503 (a cloud-client transient status) so it keeps its normal
  // retry budget — distinct from the static `skipped` config failure (422).
  it('returns 503 (retryable) and does NOT report success when the Sentry flush times out (failed)', async () => {
    vi.mocked(submitFeedback).mockResolvedValueOnce({ outcome: 'failed', reason: 'flush-timeout' });

    const req = createMockReq(validPayload());
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(503);
    // 503 is a cloud-client transient status → it keeps its retry budget.
    expect(isTransientStatus(res._status)).toBe(true);
    const body = JSON.parse(res._body);
    expect(body.error.code).toBe('FEEDBACK_FAILED');
    expect(body).toMatchObject({ delivered: false, reason: 'flush-timeout' });
    expect(body.success).toBeUndefined();
    expect(submitFeedback).toHaveBeenCalledOnce();
  });

  it('passes all fields to submitFeedback including bug-only fields', async () => {
    const payload = validPayload({
      stepsToReproduce: '1. Click button',
      expectedBehavior: 'Should not crash',
      appVersion: '1.2.3',
    });
    const req = createMockReq(payload);
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        stepsToReproduce: '1. Click button',
        expectedBehavior: 'Should not crash',
        appVersion: '1.2.3',
      }),
    );
  });

  // Mobile offline feedback queue (Stage A): the client-minted idempotency keys
  // are forwarded verbatim to the relay so it can set the Sentry event_id (dedup
  // on retry) and per-report fingerprint entropy (each report its own issue).
  it('forwards client-minted clientReportId + eventId to submitFeedback', async () => {
    const payload = validPayload({
      clientReportId: 'report-abc-123',
      eventId: 'abcdef0123456789abcdef0123456789', // 32-char lowercase hex
    });
    const req = createMockReq(payload);
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(200);
    expect(submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        clientReportId: 'report-abc-123',
        eventId: 'abcdef0123456789abcdef0123456789',
      }),
    );
  });

  it('rejects a malformed eventId (not 32-char hex) with 400 and does not call submitFeedback', async () => {
    const payload = validPayload({ eventId: 'not-a-valid-hex-event-id' });
    const req = createMockReq(payload);
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error.code).toBe('VALIDATION_ERROR');
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it('accepts a submission with neither idempotency key (backwards-compat)', async () => {
    const req = createMockReq(validPayload());
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(200);
    expect(submitFeedback).toHaveBeenCalledWith(
      expect.not.objectContaining({ eventId: expect.anything() }),
    );
  });

  it('accepts enriched diagnostics and serverContext payload', async () => {
    const payload = validPayload({
      platform: 'ios',
      diagnostics: {
        deviceInfo: { platform: 'ios', appVersion: '1.2.3' },
        filteredLogs: '{"level":30,"msg":"ok"}',
        logLineCount: 1,
        queueSnapshot: {
          pendingCount: 1,
          processingCount: 0,
          countsByType: { 'text-message': 1 },
          countsByErrorCategory: {},
          maxAttempts: 2,
          oldestAgeMs: 250,
          queueFull: false,
          limitedConnectivity: false,
          authExpired: false,
        },
        continuityState: {
          connectionState: 'connected',
          knownSessionCount: 2,
          appliedSeqSessionCount: 1,
          lastTombstoneSyncAt: null,
        },
        catchUpHistory: [{ sessionIdHash: 'abc123', appliedSeq: 5 }],
      },
      serverContext: JSON.stringify({ manifest: { source: 'cloud' } }),
    });
    const req = createMockReq(payload);
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(200);
    expect(submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        serverContext: payload.serverContext,
        diagnostics: expect.objectContaining({
          queueSnapshot: expect.objectContaining({ pendingCount: 1 }),
          continuityState: expect.objectContaining({ connectionState: 'connected' }),
        }),
      }),
    );
  });

  it('accepts diagnostic section toggles in the feedback body', async () => {
    const payload = validPayload({
      diagnosticSections: {
        settings_drift: false,
        recent_logs: true,
      },
    });
    const req = createMockReq(payload);
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(200);
    expect(submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        diagnosticSections: {
          settings_drift: false,
          recent_logs: true,
        },
      }),
    );
  });

  it('rejects invalid diagnostic section ids at the boundary', async () => {
    const req = createMockReq(validPayload({
      diagnosticSections: {
        definitely_not_a_section: true,
      },
    }));
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 405 for non-POST methods', async () => {
    const req = createMockReq(validPayload(), 'GET');
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(405);
    expect(JSON.parse(res._body)).toEqual({
      error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is allowed' },
    });
  });

  it('returns 400 for malformed JSON', async () => {
    const req = createMockReq('not-json');
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error.code).toBe('INVALID_BODY');
  });

  it('returns 400 for missing required fields', async () => {
    const req = createMockReq({ feedbackType: 'bug' });
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid feedbackType enum', async () => {
    const req = createMockReq(validPayload({ feedbackType: 'complaint' }));
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(400);
    expect(JSON.parse(res._body).error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for empty message', async () => {
    const req = createMockReq(validPayload({ message: '' }));
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(400);
  });

  it('returns 400 for message exceeding 5000 chars', async () => {
    const req = createMockReq(validPayload({ message: 'x'.repeat(5001) }));
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(400);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    const token = `rate-limit-test-${Date.now()}`;

    for (let i = 0; i < 5; i++) {
      const req = createMockReq(validPayload(), 'POST', token);
      const res = createMockRes();
      await handleFeedback(req, res);
      expect(res._status).toBe(200);
    }

    // 6th request should be rate limited
    const req = createMockReq(validPayload(), 'POST', token);
    const res = createMockRes();
    await handleFeedback(req, res);

    expect(res._status).toBe(429);
    expect(JSON.parse(res._body).error.code).toBe('RATE_LIMITED');
  });

  it('returns 500 when Sentry submission fails', async () => {
    vi.mocked(submitFeedback).mockRejectedValueOnce(new Error('Sentry down'));

    const req = createMockReq(validPayload());
    const res = createMockRes();

    await handleFeedback(req, res);

    expect(res._status).toBe(500);
    expect(JSON.parse(res._body).error.code).toBe('FEEDBACK_FAILED');
  });
});
