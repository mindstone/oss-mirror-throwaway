import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AutopilotConfig } from '../config.ts';
import type { PolledIssue } from '../poller.ts';
import { fingerprintLooseHash } from '../triage/fingerprint.ts';
import { linearDedupGate, resetLinearDedupCircuitBreakerForTests } from '../triage/linearDedupGate.ts';

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
    stateDir: '/tmp/sentry-autopilot-linear-dedup-tests',
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

function makeIssue(): PolledIssue {
  return {
    sentryId: 'SENTRY-LINEAR-DEDUP',
    sentryUrl: 'https://sentry.io/issues/SENTRY-LINEAR-DEDUP',
    title: 'Linear dedup fixture',
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

function sentryDetailResponse(): Response {
  return new Response(
    JSON.stringify({
      latestEvent: {
        entries: [
          {
            data: {
              values: [
                {
                  stacktrace: {
                    frames: [
                      { filename: '/app/src/main.ts', function: 'handleError', lineno: 10 },
                      { filename: '/app/src/worker.ts', function: 'runWorker', lineno: 20 },
                      { filename: '/app/src/index.ts', function: 'main', lineno: 30 },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

afterEach(() => {
  resetLinearDedupCircuitBreakerForTests();
  vi.unstubAllGlobals();
});

describe('linearDedupGate', () => {
  it('passes when the gate is disabled', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      linearDedupGate(makeIssue(), { config: makeConfig({ linearDedupEnabled: false }) }),
    ).resolves.toEqual({ decision: 'dispatch' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips when a by-id match has an allowed status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => linearResponse([
      { id: 'uuid-123', identifier: 'REBEL-123', state: { name: 'Done' } },
    ])));

    await expect(linearDedupGate(makeIssue(), { config: makeConfig() })).resolves.toEqual({
      decision: 'skip',
      gate: 'linear-dedup',
      reason: 'linear-already-fixed:REBEL-123',
      metadata: {
        matchedLinearId: 'REBEL-123',
        matchedLinearStatus: 'Done',
      },
    });
  });

  it('skips when a by-fingerprint match has an allowed status', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(linearResponse([]))
      .mockResolvedValueOnce(sentryDetailResponse())
      .mockResolvedValueOnce(linearResponse([
        { id: 'uuid-456', identifier: 'REBEL-456', state: { name: 'Cancelled' } },
      ]));
    vi.stubGlobal('fetch', fetchSpy);
    const hash = fingerprintLooseHash([
      { filename: '/app/src/main.ts', function: 'handleError', lineno: 10 },
      { filename: '/app/src/worker.ts', function: 'runWorker', lineno: 20 },
      { filename: '/app/src/index.ts', function: 'main', lineno: 30 },
    ]);

    await expect(linearDedupGate(makeIssue(), { config: makeConfig() })).resolves.toEqual({
      decision: 'skip',
      gate: 'linear-dedup',
      reason: `linear-fingerprint-match:${hash}:REBEL-456`,
      metadata: {
        matchedLinearId: 'REBEL-456',
        matchedLinearStatus: 'Cancelled',
        fingerprint: hash,
      },
    });

    const fingerprintRequestBody = JSON.parse(String(fetchSpy.mock.calls[2][1]?.body));
    expect(fingerprintRequestBody.variables.term).toBe(`autopilot-fingerprint: ${hash}`);
  });

  it('passes when matches have statuses outside the allowed list', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(linearResponse([
          { id: 'uuid-789', identifier: 'REBEL-789', state: { name: 'In Progress' } },
        ]))
        .mockResolvedValueOnce(new Response(JSON.stringify({ latestEvent: { entries: [] } }), { status: 200 })),
    );

    await expect(linearDedupGate(makeIssue(), { config: makeConfig() })).resolves.toEqual({
      decision: 'dispatch',
    });
  });

  it('passes when no matches are found', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(linearResponse([]))
        .mockResolvedValueOnce(new Response(JSON.stringify({ latestEvent: { entries: [] } }), { status: 200 })),
    );

    await expect(linearDedupGate(makeIssue(), { config: makeConfig() })).resolves.toEqual({
      decision: 'dispatch',
    });
  });

  it('fails open when Linear throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    await expect(linearDedupGate(makeIssue(), { config: makeConfig() })).resolves.toEqual({
      decision: 'dispatch',
    });
  });

  it('fails open when a Linear query trips the broad-match circuit breaker', async () => {
    const tooMany = Array.from({ length: 51 }, (_, index) => ({
      id: `uuid-${index}`,
      identifier: `REBEL-${index}`,
      state: { name: 'Done' },
    }));
    vi.stubGlobal('fetch', vi.fn(async () => linearResponse(tooMany)));

    await expect(linearDedupGate(makeIssue(), { config: makeConfig() })).resolves.toEqual({
      decision: 'dispatch',
    });
  });
});
