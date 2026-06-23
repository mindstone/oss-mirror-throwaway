/**
 * 260618 quit-save lock-contention fix — Phase-7 review F2 (GPT-5.5-high + Cursor
 * both flagged the gap): the save-sync cloud forwarder defers the immediate
 * outbox drain until LOCAL session persistence has settled, because the outbox
 * re-reads `store.getSession(id)` from disk at drain time — draining before a
 * DEFERRED local quit-save lands would deliver stale state. The gating lives in
 * `CloudRouter.waitForSaveSyncLocalDrain`, a bounded async poll on
 * `hasPendingLocalSessionDrain()`. This locks its contract:
 *   - resolves `true` (proceed to drain) once local persistence clears, and
 *   - resolves `false` (skip the immediate drain; the durable outbox entry
 *     retries later) if the drain stays pending past the 5s budget — WITHOUT
 *     blocking the event loop (it uses `setTimeout`, never `Atomics.wait`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pendingDrainMock = vi.hoisted(() => vi.fn<() => boolean>());

// cloudRouter imports ONLY `hasPendingLocalSessionDrain` from this module;
// partial-mock so the rest of the (real) module is untouched for any transitive
// importer while we control the predicate.
vi.mock('@core/services/lockedSessionPersistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@core/services/lockedSessionPersistence')>()),
  hasPendingLocalSessionDrain: () => pendingDrainMock(),
}));

vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: vi.fn(),
  recordKnownConditionLedgerOnly: vi.fn(),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    isLevelEnabled: vi.fn(() => false),
  }),
}));

import { CloudRouter } from '../cloudRouter';

type DrainWaiter = { waitForSaveSyncLocalDrain(maxWaitMs?: number): Promise<boolean> };

describe('CloudRouter.waitForSaveSyncLocalDrain (save-sync drain gating, review F2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pendingDrainMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resolves true immediately when no local drain is pending (fast path)', async () => {
    pendingDrainMock.mockReturnValue(false);
    const router = new CloudRouter() as unknown as DrainWaiter;
    await expect(router.waitForSaveSyncLocalDrain()).resolves.toBe(true);
  });

  it('waits, then resolves true once the deferred local drain clears', async () => {
    // Pending for the first two polls, then settles.
    pendingDrainMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const router = new CloudRouter() as unknown as DrainWaiter;
    const result = router.waitForSaveSyncLocalDrain();
    // Drive the 20ms poll loop past two iterations.
    await vi.advanceTimersByTimeAsync(60);
    await expect(result).resolves.toBe(true);
  });

  it('resolves false (skip immediate drain) when the drain stays pending past the 5s budget', async () => {
    pendingDrainMock.mockReturnValue(true);
    const router = new CloudRouter() as unknown as DrainWaiter;
    const result = router.waitForSaveSyncLocalDrain();
    // Cross the 5s deadline; the bounded wait gives up rather than blocking.
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(result).resolves.toBe(false);
  });

  it('honours a custom budget (returns false after the shorter deadline)', async () => {
    pendingDrainMock.mockReturnValue(true);
    const router = new CloudRouter() as unknown as DrainWaiter;
    const result = router.waitForSaveSyncLocalDrain(200);
    await vi.advanceTimersByTimeAsync(201);
    await expect(result).resolves.toBe(false);
  });
});
