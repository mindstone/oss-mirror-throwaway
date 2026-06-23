// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, flushAsync, renderHook } from '../../test-utils/hookTestHarness';
import { useHealthStatusPolling } from '../useHealthStatusPolling';

type TestCheck = {
  id: string;
  name: string;
  status: 'pass' | 'warn' | 'fail' | 'skip';
  message: string;
  remediation?: string;
  details?: Record<string, unknown>;
};

function makeCheck(
  id: string,
  status: TestCheck['status'],
  details?: Record<string, unknown>,
): TestCheck {
  return {
    id,
    name: id,
    status,
    message: `${id} ${status}`,
    remediation: `${id} remediation`,
    details,
  };
}

function makeReport(checks: TestCheck[]) {
  return {
    status: checks.some((check) => check.status === 'fail' || check.status === 'warn')
      ? 'degraded'
      : 'healthy',
    checks: Object.fromEntries(checks.map((check) => [check.id, check])),
  };
}

function installSystemHealthApi(reports: Array<ReturnType<typeof makeReport>>) {
  const healthCheck = vi.fn();
  for (const report of reports) {
    healthCheck.mockResolvedValueOnce(report);
  }
  Object.defineProperty(window, 'systemHealthApi', {
    configurable: true,
    value: { healthCheck },
  });
  return healthCheck;
}

async function runInitialPoll(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(10_000);
    await Promise.resolve();
  });
  await flushAsync();
}

async function runNextPoll(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(180_000);
    await Promise.resolve();
  });
  await flushAsync();
}

describe('useHealthStatusPolling apiCooldownHealth notification policy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { systemHealthApi?: unknown }).systemHealthApi;
  });

  it('contributes to glow but does not call the callback on first report', async () => {
    const onHealthDegraded = vi.fn();
    installSystemHealthApi([
      makeReport([
        makeCheck('apiCooldownHealth', 'warn', { scope: 'api', remainingMs: 60_000 }),
      ]),
    ]);

    const { result } = renderHook(() => useHealthStatusPolling({ onHealthDegraded }));

    await runInitialPoll();

    expect(result.current.healthIssueCount).toBe(1);
    expect(onHealthDegraded).not.toHaveBeenCalled();
  });

  it('does not call the callback for subsequent pass to warn apiCooldownHealth transitions', async () => {
    const onHealthDegraded = vi.fn();
    installSystemHealthApi([
      makeReport([makeCheck('apiCooldownHealth', 'pass')]),
      makeReport([makeCheck('apiCooldownHealth', 'warn', { scope: 'api', remainingMs: 60_000 })]),
    ]);

    renderHook(() => useHealthStatusPolling({ onHealthDegraded }));

    await runInitialPoll();
    await runNextPoll();

    expect(onHealthDegraded).not.toHaveBeenCalled();
  });

  it('filters apiCooldownHealth out while still notifying for other degraded checks', async () => {
    const onHealthDegraded = vi.fn();
    installSystemHealthApi([
      makeReport([
        makeCheck('apiCooldownHealth', 'pass'),
        makeCheck('oauthRefreshHealth', 'pass'),
      ]),
      makeReport([
        makeCheck('apiCooldownHealth', 'warn', { scope: 'api', remainingMs: 60_000 }),
        makeCheck('oauthRefreshHealth', 'warn', { providerCount: 1 }),
      ]),
    ]);

    renderHook(() => useHealthStatusPolling({ onHealthDegraded }));

    await runInitialPoll();
    await runNextPoll();

    expect(onHealthDegraded).toHaveBeenCalledOnce();
    expect(onHealthDegraded.mock.calls[0][0]).toHaveLength(1);
    expect(onHealthDegraded.mock.calls[0][0][0].id).toBe('oauthRefreshHealth');
  });

  it('keeps apiCooldownHealth quiet after recovery and subsequent re-degrade', async () => {
    const onHealthDegraded = vi.fn();
    installSystemHealthApi([
      makeReport([makeCheck('apiCooldownHealth', 'warn', { scope: 'api', remainingMs: 60_000 })]),
      makeReport([makeCheck('apiCooldownHealth', 'pass')]),
      makeReport([makeCheck('apiCooldownHealth', 'warn', { scope: 'api', remainingMs: 60_000 })]),
      makeReport([makeCheck('apiCooldownHealth', 'warn', { scope: 'api', remainingMs: 60_000 })]),
    ]);

    const { result } = renderHook(() => useHealthStatusPolling({ onHealthDegraded }));

    await runInitialPoll();
    expect(result.current.healthIssueCount).toBe(1);

    await runNextPoll();
    expect(result.current.healthIssueCount).toBe(0);

    await runNextPoll();
    expect(result.current.healthIssueCount).toBe(1);

    await runNextPoll();
    expect(onHealthDegraded).not.toHaveBeenCalled();
  });

  it('suppresses oauthRefreshHealth first-report toast while keeping it notified', async () => {
    const onHealthDegraded = vi.fn();
    installSystemHealthApi([
      makeReport([makeCheck('oauthRefreshHealth', 'warn', { providerCount: 1 })]),
      makeReport([makeCheck('oauthRefreshHealth', 'warn', { providerCount: 1 })]),
    ]);

    const { result } = renderHook(() => useHealthStatusPolling({ onHealthDegraded }));

    await runInitialPoll();
    expect(result.current.healthIssueCount).toBe(1);
    expect(onHealthDegraded).not.toHaveBeenCalled();

    await runNextPoll();
    expect(result.current.healthIssueCount).toBe(1);
    expect(onHealthDegraded).not.toHaveBeenCalled();
  });

  it.each([
    ['needs-reconnect class', { provider: 'GoogleWorkspace', accountCount: 1 }],
    ['lastSyncError class', { lastSyncError: 'sync failed' }],
    ['stale-cache class', { staleHours: 26 }],
  ])(
    'suppresses calendarCacheHealth first-report toast for any warn class (%s) while keeping it counted and notified',
    async (_label, details) => {
      const onHealthDegraded = vi.fn();
      installSystemHealthApi([
        makeReport([makeCheck('calendarCacheHealth', 'warn', details)]),
        makeReport([makeCheck('calendarCacheHealth', 'warn', details)]),
      ]);

      const { result } = renderHook(() => useHealthStatusPolling({ onHealthDegraded }));

      await runInitialPoll();
      // Still counts toward the glow/issue count...
      expect(result.current.healthIssueCount).toBe(1);
      // ...but no toast for pre-existing degraded state at cold start.
      expect(onHealthDegraded).not.toHaveBeenCalled();

      // Marked in notifiedChecks: poll #2 with the same warn must not re-toast.
      await runNextPoll();
      expect(result.current.healthIssueCount).toBe(1);
      expect(onHealthDegraded).not.toHaveBeenCalled();
    },
  );

  it('re-arms after recovery: suppressed first-report warn → pass → warn DOES toast (Stage 1 reviewer suggestion)', async () => {
    const onHealthDegraded = vi.fn();
    installSystemHealthApi([
      makeReport([makeCheck('calendarCacheHealth', 'warn', { lastSyncError: 'sync failed' })]),
      makeReport([makeCheck('calendarCacheHealth', 'pass')]),
      makeReport([makeCheck('calendarCacheHealth', 'warn', { lastSyncError: 'sync failed' })]),
    ]);

    const { result } = renderHook(() => useHealthStatusPolling({ onHealthDegraded }));

    // First report: suppressed (counts, no toast) but marked in notifiedChecks.
    await runInitialPoll();
    expect(result.current.healthIssueCount).toBe(1);
    expect(onHealthDegraded).not.toHaveBeenCalled();

    // Recovery to pass clears the notified marker (re-arm).
    await runNextPoll();
    expect(result.current.healthIssueCount).toBe(0);
    expect(onHealthDegraded).not.toHaveBeenCalled();

    // Re-degrade is a NEW in-session incident — it must toast.
    await runNextPoll();
    expect(result.current.healthIssueCount).toBe(1);
    expect(onHealthDegraded).toHaveBeenCalledOnce();
    expect(onHealthDegraded.mock.calls[0][0]).toHaveLength(1);
    expect(onHealthDegraded.mock.calls[0][0][0].id).toBe('calendarCacheHealth');
  });

  it('still toasts for a subsequent pass to warn calendarCacheHealth transition', async () => {
    const onHealthDegraded = vi.fn();
    installSystemHealthApi([
      makeReport([makeCheck('calendarCacheHealth', 'pass')]),
      makeReport([makeCheck('calendarCacheHealth', 'warn', { lastSyncError: 'sync failed' })]),
    ]);

    renderHook(() => useHealthStatusPolling({ onHealthDegraded }));

    await runInitialPoll();
    expect(onHealthDegraded).not.toHaveBeenCalled();

    await runNextPoll();
    expect(onHealthDegraded).toHaveBeenCalledOnce();
    expect(onHealthDegraded.mock.calls[0][0]).toHaveLength(1);
    expect(onHealthDegraded.mock.calls[0][0][0].id).toBe('calendarCacheHealth');
  });

  it('notifies once for default on-degrade checks that transition from pass to warn', async () => {
    const onHealthDegraded = vi.fn();
    installSystemHealthApi([
      makeReport([makeCheck('claudeApiKeyValid', 'pass')]),
      makeReport([makeCheck('claudeApiKeyValid', 'warn')]),
      makeReport([makeCheck('claudeApiKeyValid', 'warn')]),
    ]);

    renderHook(() => useHealthStatusPolling({ onHealthDegraded }));

    await runInitialPoll();
    await runNextPoll();
    await runNextPoll();

    expect(onHealthDegraded).toHaveBeenCalledOnce();
    expect(onHealthDegraded.mock.calls[0][0]).toHaveLength(1);
    expect(onHealthDegraded.mock.calls[0][0][0].id).toBe('claudeApiKeyValid');
  });
});
