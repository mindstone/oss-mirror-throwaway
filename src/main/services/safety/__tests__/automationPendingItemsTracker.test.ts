import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  trackItem,
  resolveItem,
  markRunComplete,
  onAllResolved,
  getStatus,
  clearAutomation,
  _resetForTesting,
} from '../automationPendingItemsTracker';

describe('automationPendingItemsTracker', () => {
  beforeEach(() => {
    _resetForTesting();
  });

  // ===========================================================================
  // trackItem + resolveItem lifecycle
  // ===========================================================================

  describe('trackItem + resolveItem lifecycle', () => {
    it('fires onAllResolved with correct counts when all items approved', () => {
      const callback = vi.fn();
      onAllResolved('auto-1', callback);

      trackItem('auto-1', 'item-1', 'staged-tool', { toolName: 'gmail:send' });
      trackItem('auto-1', 'item-2', 'memory-write', { toolName: 'create_file' });
      markRunComplete('auto-1');

      resolveItem('auto-1', 'item-1', 'approved');
      expect(callback).not.toHaveBeenCalled();

      resolveItem('auto-1', 'item-2', 'approved');
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({
        automationId: 'auto-1',
        approved: expect.arrayContaining([
          expect.objectContaining({ itemId: 'item-1', resolution: 'approved' }),
          expect.objectContaining({ itemId: 'item-2', resolution: 'approved' }),
        ]),
        rejected: [],
      });
    });

    it('fires onAllResolved with mixed approved/rejected counts', () => {
      const callback = vi.fn();
      onAllResolved('auto-1', callback);

      trackItem('auto-1', 'item-1', 'staged-tool');
      trackItem('auto-1', 'item-2', 'deny-retry');
      markRunComplete('auto-1');

      resolveItem('auto-1', 'item-1', 'approved');
      resolveItem('auto-1', 'item-2', 'rejected');

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith({
        automationId: 'auto-1',
        approved: [expect.objectContaining({ itemId: 'item-1', resolution: 'approved' })],
        rejected: [expect.objectContaining({ itemId: 'item-2', resolution: 'rejected' })],
      });
    });

    it('does NOT fire onAllResolved when only some items are resolved', () => {
      const callback = vi.fn();
      onAllResolved('auto-1', callback);

      trackItem('auto-1', 'item-1', 'staged-tool');
      trackItem('auto-1', 'item-2', 'staged-tool');
      trackItem('auto-1', 'item-3', 'staged-tool');
      markRunComplete('auto-1');

      resolveItem('auto-1', 'item-1', 'approved');
      resolveItem('auto-1', 'item-2', 'rejected');

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // markRunComplete ordering
  // ===========================================================================

  describe('markRunComplete ordering', () => {
    it('fires onAllResolved when items resolved BEFORE markRunComplete', () => {
      const callback = vi.fn();
      onAllResolved('auto-1', callback);

      trackItem('auto-1', 'item-1', 'staged-tool');
      resolveItem('auto-1', 'item-1', 'approved');

      expect(callback).not.toHaveBeenCalled();

      markRunComplete('auto-1');
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('fires onAllResolved when items resolved AFTER markRunComplete', () => {
      const callback = vi.fn();
      onAllResolved('auto-1', callback);

      trackItem('auto-1', 'item-1', 'staged-tool');
      markRunComplete('auto-1');

      expect(callback).not.toHaveBeenCalled();

      resolveItem('auto-1', 'item-1', 'approved');
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire onAllResolved when markRunComplete called with no items', () => {
      const callback = vi.fn();
      onAllResolved('auto-1', callback);

      markRunComplete('auto-1');
      expect(callback).not.toHaveBeenCalled();
    });

    it('ignores markRunComplete for unknown automation', () => {
      // Should not throw
      markRunComplete('unknown-auto');
    });
  });

  // ===========================================================================
  // clearAutomation
  // ===========================================================================

  describe('clearAutomation', () => {
    it('prevents callback from firing after clear', () => {
      const callback = vi.fn();
      onAllResolved('auto-1', callback);

      trackItem('auto-1', 'item-1', 'staged-tool');
      markRunComplete('auto-1');

      clearAutomation('auto-1');

      // Resolve after clear — should be a no-op (no tracking data)
      resolveItem('auto-1', 'item-1', 'approved');
      expect(callback).not.toHaveBeenCalled();
    });

    it('cleans up callback map', () => {
      const callback = vi.fn();
      onAllResolved('auto-1', callback);

      trackItem('auto-1', 'item-1', 'staged-tool');
      clearAutomation('auto-1');

      // Re-track and resolve — old callback should not fire
      trackItem('auto-1', 'item-2', 'staged-tool');
      markRunComplete('auto-1');
      resolveItem('auto-1', 'item-2', 'approved');
      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // getStatus
  // ===========================================================================

  describe('getStatus', () => {
    it('returns correct counts for pending/approved/rejected', () => {
      trackItem('auto-1', 'item-1', 'staged-tool');
      trackItem('auto-1', 'item-2', 'memory-write');
      trackItem('auto-1', 'item-3', 'deny-retry');

      resolveItem('auto-1', 'item-1', 'approved');
      resolveItem('auto-1', 'item-2', 'rejected');

      const status = getStatus('auto-1');
      expect(status).toEqual({
        pending: 1,
        approved: 1,
        rejected: 1,
        allResolved: false,
      });
    });

    it('returns allResolved true when all items resolved', () => {
      trackItem('auto-1', 'item-1', 'staged-tool');
      resolveItem('auto-1', 'item-1', 'approved');

      // Note: getStatus doesn't consider runComplete, only item resolution
      const status = getStatus('auto-1');
      expect(status).toEqual({
        pending: 0,
        approved: 1,
        rejected: 0,
        allResolved: true,
      });
    });

    it('returns zeros for unknown automationId', () => {
      const status = getStatus('nonexistent');
      expect(status).toEqual({
        pending: 0,
        approved: 0,
        rejected: 0,
        allResolved: false,
      });
    });
  });

  // ===========================================================================
  // Multiple callbacks
  // ===========================================================================

  describe('multiple callbacks', () => {
    it('fires all registered callbacks', () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();
      onAllResolved('auto-1', callback1);
      onAllResolved('auto-1', callback2);

      trackItem('auto-1', 'item-1', 'staged-tool');
      markRunComplete('auto-1');
      resolveItem('auto-1', 'item-1', 'approved');

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Error isolation
  // ===========================================================================

  describe('error isolation', () => {
    it('fires second callback even when first throws', () => {
      const callback1 = vi.fn().mockImplementation(() => {
        throw new Error('callback1 failed');
      });
      const callback2 = vi.fn();

      onAllResolved('auto-1', callback1);
      onAllResolved('auto-1', callback2);

      trackItem('auto-1', 'item-1', 'staged-tool');
      markRunComplete('auto-1');
      resolveItem('auto-1', 'item-1', 'approved');

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('ignores resolveItem for unknown automation', () => {
      // Should not throw
      resolveItem('unknown', 'item-1', 'approved');
    });

    it('ignores resolveItem for unknown item', () => {
      trackItem('auto-1', 'item-1', 'staged-tool');
      // Should not throw
      resolveItem('auto-1', 'unknown-item', 'approved');
    });

    it('stores metadata on tracked items', () => {
      trackItem('auto-1', 'item-1', 'staged-tool', {
        toolName: 'gmail:send',
        inputSummary: '{"to":"user@example.com"}',
      });

      const status = getStatus('auto-1');
      expect(status.pending).toBe(1);
    });

    it('cleans up tracking data after onAllResolved fires', () => {
      const callback = vi.fn();
      onAllResolved('auto-1', callback);

      trackItem('auto-1', 'item-1', 'staged-tool');
      markRunComplete('auto-1');
      resolveItem('auto-1', 'item-1', 'approved');

      // After firing, tracking data should be cleaned up
      const status = getStatus('auto-1');
      expect(status).toEqual({
        pending: 0,
        approved: 0,
        rejected: 0,
        allResolved: false,
      });
    });
  });
});
