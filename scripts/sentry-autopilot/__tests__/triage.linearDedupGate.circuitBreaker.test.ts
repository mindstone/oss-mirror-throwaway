import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import type { PolledIssue } from '../poller.ts';

const mocks = vi.hoisted(() => ({
  emitCounter: vi.fn(),
}));

vi.mock('../metrics.ts', () => ({
  emitCounter: mocks.emitCounter,
}));

import {
  linearDedupGate,
  resetLinearDedupCircuitBreakerForTests,
} from '../triage/linearDedupGate.ts';

function makeConfig(overrides: Partial<AutopilotConfig> = {}): AutopilotConfig {
  return {
    sentryAuthToken: 'sentry-token',
    sentryOrg: 'mindstone',
    sentryProject: 'rebel',
    linearApiKey: 'linear-token',
    slackWebhook: undefined,
    phase: 'shadow',
    verifyMode: 'disabled',
    pushMode: 'disabled',
    pendingMode: 'enforce',
    stateDir: '/tmp/sentry-autopilot-linear-dedup-circuit-breaker-tests',
    maxConcurrent: 1,
    maxHourly: 1,
    maxDaily: 1,
    maxRetries: 2,
    sessionTimeoutSeconds: 60,
    bootstrapLookbackHours: 24,
    repoRoot: '/tmp/repo',
    cli: 'droid',
    cursorModel: 'composer-2.5',
    claudeModel: 'claude-opus-4-8',
    linearDedupEnabled: true,
    linearDedupStatuses: ['Done', 'Cancelled', 'Duplicate'],
    ...overrides,
  };
}

function makeIssue(sentryId = 'SENTRY-LINEAR-CIRCUIT'): PolledIssue {
  return {
    sentryId,
    sentryUrl: `https://sentry.io/issues/${sentryId}`,
    title: 'Linear circuit-breaker fixture',
    errorType: 'exception',
    isUserReported: false,
    occurrences: 10,
    users: 3,
    level: 'error',
    firstSeen: '2026-06-07T00:00:00Z',
    lastSeen: '2026-06-07T00:00:00Z',
  };
}

function linearResponse(nodes: Array<{ id: string; identifier: string; state: { name: string } }>): Response {
  return new Response(JSON.stringify({ data: { issues: { nodes } } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  resetLinearDedupCircuitBreakerForTests();
  mocks.emitCounter.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('linearDedupGate circuit breaker', () => {
  it('short-circuits the fourth invocation after three consecutive Linear failures', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('linear unavailable');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchSpy);

    await expect(linearDedupGate(makeIssue('SENTRY-LINEAR-CIRCUIT-1'), { config: makeConfig() })).resolves.toEqual({
      decision: 'dispatch',
    });
    await expect(linearDedupGate(makeIssue('SENTRY-LINEAR-CIRCUIT-2'), { config: makeConfig() })).resolves.toEqual({
      decision: 'dispatch',
    });
    await expect(linearDedupGate(makeIssue('SENTRY-LINEAR-CIRCUIT-3'), { config: makeConfig() })).resolves.toEqual({
      decision: 'dispatch',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    await expect(linearDedupGate(makeIssue('SENTRY-LINEAR-CIRCUIT-4'), { config: makeConfig() })).resolves.toEqual({
      decision: 'dispatch',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Linear dedup gate circuit-breaker engaged after 3 consecutive failures'),
    );
  });

  it('resets the failure counter after a Linear success', async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockRejectedValueOnce(new Error('second failure'))
      .mockResolvedValueOnce(linearResponse([
        { id: 'uuid-success', identifier: 'REBEL-SUCCESS', state: { name: 'Done' } },
      ]))
      .mockResolvedValueOnce(linearResponse([
        { id: 'uuid-after-reset', identifier: 'REBEL-AFTER-RESET', state: { name: 'Done' } },
      ]));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(linearDedupGate(makeIssue('SENTRY-LINEAR-RESET-1'), { config: makeConfig() })).resolves.toEqual({
      decision: 'dispatch',
    });
    await expect(linearDedupGate(makeIssue('SENTRY-LINEAR-RESET-2'), { config: makeConfig() })).resolves.toEqual({
      decision: 'dispatch',
    });
    await expect(linearDedupGate(makeIssue('SENTRY-LINEAR-RESET-3'), { config: makeConfig() })).resolves.toMatchObject({
      decision: 'skip',
      reason: 'linear-already-fixed:REBEL-SUCCESS',
    });

    await expect(linearDedupGate(makeIssue('SENTRY-LINEAR-RESET-4'), { config: makeConfig() })).resolves.toMatchObject({
      decision: 'skip',
      reason: 'linear-already-fixed:REBEL-AFTER-RESET',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });

  it('emits failure and circuit-breaker counters with structured tags', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('linear unavailable');
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchSpy);

    await linearDedupGate(makeIssue('SENTRY-LINEAR-METRIC-1'), { config: makeConfig() });
    await linearDedupGate(makeIssue('SENTRY-LINEAR-METRIC-2'), { config: makeConfig() });
    await linearDedupGate(makeIssue('SENTRY-LINEAR-METRIC-3'), { config: makeConfig() });
    await linearDedupGate(makeIssue('SENTRY-LINEAR-METRIC-4'), { config: makeConfig() });

    expect(mocks.emitCounter).toHaveBeenCalledWith('reporter.linear_dedup.failure', {
      sentryId: 'SENTRY-LINEAR-METRIC-1',
      axis: 'by-id',
      consecutiveFailures: 1,
    });
    expect(mocks.emitCounter).toHaveBeenCalledWith('reporter.linear_dedup.failure', {
      sentryId: 'SENTRY-LINEAR-METRIC-3',
      axis: 'by-id',
      consecutiveFailures: 3,
    });
    expect(mocks.emitCounter).toHaveBeenCalledWith('reporter.linear_dedup.circuit_breaker_engaged', {
      sentryId: 'SENTRY-LINEAR-METRIC-4',
      consecutiveFailures: 3,
    });
  });
});
