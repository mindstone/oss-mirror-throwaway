/**
 * F4 (Phase 7): `submitFeedback` enablement must honour the `SENTRY_ENABLED`
 * kill-switch, not just `SENTRY_DSN`. Previously it checked only the DSN, so
 * with `SENTRY_DSN` set + `SENTRY_ENABLED=0` (Sentry actually disabled in
 * bootstrap) feedback would still log "submitted" and call into the Sentry SDK.
 * It now uses the same `shouldEnableSentry({ dsn })` predicate as bootstrap.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { captureMessageMock, withScopeMock, flushMock } = vi.hoisted(() => ({
  captureMessageMock: vi.fn(() => 'evt-1'),
  withScopeMock: vi.fn(),
  flushMock: vi.fn(async () => true),
}));

vi.mock('@sentry/node', () => ({
  withScope: (cb: (scope: {
    setTag: () => void;
    addAttachment: () => void;
    setLevel: () => void;
    setFingerprint: () => void;
  }) => void) => {
    withScopeMock(cb);
    cb({ setTag: vi.fn(), addAttachment: vi.fn(), setLevel: vi.fn(), setFingerprint: vi.fn() });
  },
  captureMessage: captureMessageMock,
  flush: flushMock,
}));

// __REBEL_VERSION__ is an esbuild build-time define; not present under vitest.
(globalThis as Record<string, unknown>).__REBEL_VERSION__ = 'test';

import { submitFeedback, type FeedbackData } from '../sentryFeedback';

const payload = (): FeedbackData => ({
  feedbackType: 'bug',
  urgency: 'normal',
  message: 'Something broke',
  platform: 'linux',
});

describe('submitFeedback — F4 SENTRY_ENABLED kill-switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('submits and returns delivered when DSN present and SENTRY_ENABLED unset (default enabled)', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://example.invalid/1');
    const result = await submitFeedback(payload());
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    // PLAN Stage 6 / R3: configured → honest delivered outcome.
    expect(result).toEqual({ outcome: 'delivered' });
  });

  it('does NOT submit and returns honest skipped when DSN present but SENTRY_ENABLED=0 (kill-switch)', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://example.invalid/1');
    vi.stubEnv('SENTRY_ENABLED', '0');
    const result = await submitFeedback(payload());
    expect(captureMessageMock).not.toHaveBeenCalled();
    // Not a silent void: the caller learns the report was NOT delivered.
    expect(result).toEqual({ outcome: 'skipped', reason: 'reporting-unavailable' });
  });

  it('does NOT submit and returns honest skipped when no DSN (unchanged behaviour, now observable)', async () => {
    vi.stubEnv('SENTRY_DSN', '');
    const result = await submitFeedback(payload());
    expect(captureMessageMock).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'skipped', reason: 'reporting-unavailable' });
  });

  // MUST-1 (Phase 7, GPT F1 + Native F1): Sentry IS configured and the event is
  // captured, but `Sentry.flush()` returns false (timeout, events still buffered)
  // → the report did NOT leave the transport. The function must report `failed`,
  // NOT `delivered` — otherwise the route would answer 200 (success dressed around
  // non-delivery, the exact class this task kills). Mirrors desktop's flush gate.
  it('returns honest failed (flush-timeout) when configured but Sentry.flush() times out', async () => {
    vi.stubEnv('SENTRY_DSN', 'https://example.invalid/1');
    flushMock.mockResolvedValueOnce(false);
    const result = await submitFeedback(payload());
    // The event was captured (the only thing left undone is confirming flush).
    expect(captureMessageMock).toHaveBeenCalledTimes(1);
    // But we do NOT claim delivery on an unconfirmed flush.
    expect(result).toEqual({ outcome: 'failed', reason: 'flush-timeout' });
  });
});
