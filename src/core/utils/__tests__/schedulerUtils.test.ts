import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForInteractiveIdle, scheduleWithMaxTimeout, MAX_TIMEOUT_MS, DEFERRAL_DEFAULTS } from '../schedulerUtils';

describe('schedulerUtils', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('waitForInteractiveIdle', () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    it('returns quickly when no active turn (after grace period)', async () => {
      const promise = waitForInteractiveIdle({
        hasInteractiveTurn: () => false,
        isShuttingDown: () => false,
        logger: mockLogger,
        entityId: 'test-id',
        entityType: 'automation'
      });

      // Advance past the grace period
      await vi.advanceTimersByTimeAsync(DEFERRAL_DEFAULTS.GRACE_MS + 100);

      const result = await promise;

      expect(result.deferred).toBe(true);
      expect(result.shuttingDown).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.deferredMs).toBeLessThanOrEqual(DEFERRAL_DEFAULTS.GRACE_MS + 200);
    });

    it('defers and returns after interactive turn clears and grace period elapses', async () => {
      let isInteractive = true;
      const shuttingDown = false;

      const promise = waitForInteractiveIdle({
        hasInteractiveTurn: () => isInteractive,
        isShuttingDown: () => shuttingDown,
        logger: mockLogger,
        entityId: 'test-id',
        entityType: 'role'
      });

      // Advance past first poll
      await vi.advanceTimersByTimeAsync(DEFERRAL_DEFAULTS.POLL_INTERVAL_MS);

      // Clear the interactive turn
      isInteractive = false;
      
      // Advance to trigger grace period, then another poll, then second grace period
      await vi.advanceTimersByTimeAsync(DEFERRAL_DEFAULTS.GRACE_MS * 2 + DEFERRAL_DEFAULTS.POLL_INTERVAL_MS * 2);

      const result = await promise;

      expect(result.shuttingDown).toBe(false);
      expect(result.timedOut).toBe(false);
      expect(result.deferredMs).toBeGreaterThan(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({ roleId: 'test-id' }),
        expect.stringContaining('Interactive turn cleared, resuming role')
      );
    });

    it('times out after MAX_DEFERRAL_MS', async () => {
      const promise = waitForInteractiveIdle({
        hasInteractiveTurn: () => true, // Never clears
        isShuttingDown: () => false,
        logger: mockLogger,
        entityId: 'test-id',
        entityType: 'automation'
      });

      // Advance by max deferral
      await vi.advanceTimersByTimeAsync(DEFERRAL_DEFAULTS.MAX_DEFERRAL_MS + 100);

      const result = await promise;

      expect(result.timedOut).toBe(true);
      expect(result.shuttingDown).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ automationId: 'test-id' }),
        expect.stringContaining('deferral timed out, proceeding anyway')
      );
    });

    it('detects shutdown during deferral', async () => {
      let isShuttingDown = false;

      const promise = waitForInteractiveIdle({
        hasInteractiveTurn: () => true,
        isShuttingDown: () => isShuttingDown,
        logger: mockLogger,
        entityId: 'test-id',
        entityType: 'role'
      });

      await vi.advanceTimersByTimeAsync(DEFERRAL_DEFAULTS.POLL_INTERVAL_MS);

      isShuttingDown = true;

      await vi.advanceTimersByTimeAsync(DEFERRAL_DEFAULTS.POLL_INTERVAL_MS);

      const result = await promise;

      expect(result.shuttingDown).toBe(true);
      expect(result.timedOut).toBe(false);
    });
  });

  describe('scheduleWithMaxTimeout', () => {
    it('schedules with direct setTimeout for short delay', () => {
      const callback = vi.fn();
      scheduleWithMaxTimeout(callback, 1000);

      vi.advanceTimersByTime(1000);
      expect(callback).toHaveBeenCalled();
    });

    it('uses intermediate timer for delay > MAX_TIMEOUT_MS', () => {
      const callback = vi.fn();
      const onReEvaluate = vi.fn();
      
      scheduleWithMaxTimeout(callback, MAX_TIMEOUT_MS + 10000, onReEvaluate);

      vi.advanceTimersByTime(MAX_TIMEOUT_MS);
      expect(callback).not.toHaveBeenCalled();
      expect(onReEvaluate).toHaveBeenCalled();
    });

    it('handles zero or negative delay', () => {
      const callback = vi.fn();
      scheduleWithMaxTimeout(callback, -500);

      vi.advanceTimersByTime(0); // setTimeout 0 resolves on next tick
      expect(callback).toHaveBeenCalled();
    });
  });
});
