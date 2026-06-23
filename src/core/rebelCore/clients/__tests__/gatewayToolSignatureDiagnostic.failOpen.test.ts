import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTracker, type Tracker } from '@core/tracking';

// F2: the catch path must be FULLY fail-open. When the analytics tracker throws,
// the diagnostic logs a best-effort warning — but if the LOGGER ITSELF throws
// (e.g. `createScopedLogger` absent / throwing under a partial `@core/logger`
// mock, or `.warn` throwing), that must NOT propagate into the turn path either.
//
// This file mocks `@core/logger` so `createScopedLogger().warn` throws, and pairs
// it with a throwing tracker, to drive the inner guard. It lives in its own file
// because the module-level logger mock would otherwise affect the other suites.
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    warn: () => {
      throw new Error('logger boom — must be swallowed');
    },
    info: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

const FAKE_SIG = 'CioKChIQ-FAKE-FAILOPEN-SIGNATURE-MUST-NEVER-LEAK';

const NOOP_TRACKER: Tracker = {
  track: () => {},
  identify: () => {},
  getAnonymousId: () => '',
  isAvailable: () => false,
};

afterEach(() => {
  setTracker(NOOP_TRACKER);
});

describe('emitGatewayToolSignatureObserved — fully fail-open (F2)', () => {
  beforeEach(() => {
    setTracker(NOOP_TRACKER);
  });

  it('does not propagate when BOTH the tracker AND the fallback logger throw', async () => {
    const { emitGatewayToolSignatureObserved, aggregateToolCallSignatures } = await import(
      '../gatewayToolSignatureDiagnostic'
    );

    setTracker({
      track: () => {
        throw new Error('tracker boom');
      },
      identify: () => {},
      getAnonymousId: () => '',
      isAvailable: () => true,
    });

    expect(() =>
      emitGatewayToolSignatureObserved({
        shouldEmit: true,
        providerType: 'other',
        provider: 'custom-gateway',
        modelId: 'gemini-2.5-pro',
        streaming: true,
        aggregate: aggregateToolCallSignatures([
          { id: 'call_1', extra_content: { google: { thought_signature: FAKE_SIG } } },
        ]),
      }),
    ).not.toThrow();
  });
});
