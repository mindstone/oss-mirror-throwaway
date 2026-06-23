import { describe, expect, it, vi } from 'vitest';

import type { PolledIssue } from '../poller.ts';
import { runTriageGates, type TriageGate } from '../triage/index.ts';

function makeIssue(overrides: Partial<PolledIssue> = {}): PolledIssue {
  return {
    sentryId: 'SENTRY-GATE',
    sentryUrl: 'https://sentry.io/issues/SENTRY-GATE',
    title: 'Ordinary error',
    errorType: 'exception',
    isUserReported: false,
    occurrences: 1,
    users: 1,
    level: 'error',
    firstSeen: '2026-05-22T00:00:00Z',
    lastSeen: '2026-05-22T00:00:00Z',
    ...overrides,
  };
}

describe('runTriageGates', () => {
  it('short-circuits when gate 0 returns skip', async () => {
    const extensionGate = vi.fn<TriageGate>(() => ({ decision: 'dispatch' }));

    const result = await runTriageGates(makeIssue(), { gates: [extensionGate] });

    expect(result).toEqual({
      decision: 'skip',
      gate: 'poller-triage',
      reason: 'legacy-triage-skip',
    });
    expect(extensionGate).not.toHaveBeenCalled();
  });

  it('dispatches when gate 0 dispatches and no extension gates are registered', async () => {
    const result = await runTriageGates(makeIssue({ occurrences: 10, users: 3 }));

    expect(result).toEqual({ decision: 'dispatch' });
  });

  it('lets an extension gate change the decision', async () => {
    const extensionGate = vi.fn<TriageGate>(() => ({
      decision: 'defer',
      gate: 'stub-extension',
      reason: 'covered by in-flight session',
    }));

    const result = await runTriageGates(makeIssue({ occurrences: 10, users: 3 }), { gates: [extensionGate] });

    expect(result).toEqual({
      decision: 'defer',
      gate: 'stub-extension',
      reason: 'covered by in-flight session',
    });
    expect(extensionGate).toHaveBeenCalledTimes(1);
  });
});
