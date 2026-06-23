/**
 * Mobile offline feedback queue (Stage A) — cloud-relay idempotency + per-report
 * fingerprint entropy.
 *
 * Two coupled parity gaps with desktop were closed here:
 *   - Idempotency: when the client supplies a stable 32-hex `eventId` (reused
 *     across the offline queue's retries), the relay must set it as the Sentry
 *     `event_id` via the SCOPED `scope.captureMessage(msg, level, { event_id })`
 *     form — the only form that honors a preset id — so a retried-after-delivery
 *     report dedups server-side instead of creating a duplicate issue.
 *   - Fingerprint entropy: when the client supplies `clientReportId`, each
 *     distinct report becomes its own Sentry issue (Sentry→Linear fires per
 *     report). Absent both, the relay falls back to the legacy top-level
 *     capture + title-based fingerprint (backwards-compat for older mobile / web).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { topLevelCaptureMock, scopeCaptureMock, setFingerprintMock, setTagMock, flushMock } = vi.hoisted(() => ({
  topLevelCaptureMock: vi.fn(() => 'evt-top'),
  scopeCaptureMock: vi.fn(() => 'evt-scoped'),
  setFingerprintMock: vi.fn(),
  setTagMock: vi.fn(),
  flushMock: vi.fn(async () => true),
}));

vi.mock('@sentry/node', () => ({
  withScope: (cb: (scope: Record<string, unknown>) => void) => {
    cb({
      setTag: setTagMock,
      addAttachment: vi.fn(),
      setLevel: vi.fn(),
      setFingerprint: setFingerprintMock,
      captureMessage: scopeCaptureMock,
    });
  },
  captureMessage: topLevelCaptureMock,
  flush: flushMock,
}));

(globalThis as Record<string, unknown>).__REBEL_VERSION__ = 'test';

import { submitFeedback, type FeedbackData } from '../sentryFeedback';

const HEX_EVENT_ID = 'abcdef0123456789abcdef0123456789';

const payload = (overrides?: Partial<FeedbackData>): FeedbackData => ({
  feedbackType: 'bug',
  urgency: 'medium',
  message: 'First line of the report\nmore detail',
  platform: 'ios',
  ...overrides,
});

describe('submitFeedback — idempotency + fingerprint entropy (Stage A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('SENTRY_DSN', 'https://example.invalid/1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sets the Sentry event_id from the client-supplied eventId via the scoped capture form', async () => {
    const result = await submitFeedback(payload({ eventId: HEX_EVENT_ID, clientReportId: 'report-1' }));

    // The scoped form (the only one that honors a preset event_id) is used...
    expect(scopeCaptureMock).toHaveBeenCalledTimes(1);
    expect(scopeCaptureMock).toHaveBeenCalledWith(
      expect.stringContaining('First line of the report'),
      'error',
      { event_id: HEX_EVENT_ID },
    );
    // ...and the top-level form (which would ignore event_id) is NOT used.
    expect(topLevelCaptureMock).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'delivered' });
  });

  it('fingerprints on clientReportId for per-report entropy (each report its own issue)', async () => {
    await submitFeedback(payload({ eventId: HEX_EVENT_ID, clientReportId: 'report-1' }));

    expect(setFingerprintMock).toHaveBeenCalledWith(['cloud-feedback', 'bug', 'report-1']);
    // clientReportId is also surfaced as a tag for triage cross-referencing.
    expect(setTagMock).toHaveBeenCalledWith('clientReportId', 'report-1');
  });

  it('falls back to top-level capture + title fingerprint when no idempotency keys (backwards-compat)', async () => {
    await submitFeedback(payload());

    // No eventId → legacy top-level capture (SDK mints its own id).
    expect(topLevelCaptureMock).toHaveBeenCalledTimes(1);
    expect(scopeCaptureMock).not.toHaveBeenCalled();
    // No clientReportId → legacy title-based fingerprint (first message line).
    expect(setFingerprintMock).toHaveBeenCalledWith(['cloud-feedback', 'bug', 'First line of the report']);
    expect(setTagMock).not.toHaveBeenCalledWith('clientReportId', expect.anything());
  });

  it('uses clientReportId fingerprint even without eventId (entropy independent of idempotency)', async () => {
    await submitFeedback(payload({ clientReportId: 'report-2' }));

    expect(setFingerprintMock).toHaveBeenCalledWith(['cloud-feedback', 'bug', 'report-2']);
    // Without an eventId we still use the top-level capture (no preset id to honor).
    expect(topLevelCaptureMock).toHaveBeenCalledTimes(1);
    expect(scopeCaptureMock).not.toHaveBeenCalled();
  });
});
