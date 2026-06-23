/**
 * queueMetrics tests.
 *
 * Covers the "emit-while-active, quiet-when-idle" policy plus the sample
 * shape (counts by type + errorCategory, oldestAgeMs, flags).
 */

import type { QueueItem, QueueStateSnapshot } from '@rebel/cloud-client';
import { buildQueueMetricsSample, shouldEmit, startQueueMetrics } from '../utils/queueMetrics';

function mkItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: overrides.id ?? 'i1',
    type: overrides.type ?? 'text-message',
    status: overrides.status ?? 'pending',
    enqueuedAt: overrides.enqueuedAt ?? 1_000,
    attempts: overrides.attempts ?? 0,
    nextRetryAt: overrides.nextRetryAt ?? 0,
    isPermanentFailure: overrides.isPermanentFailure ?? false,
    metadata: overrides.metadata ?? {},
    ...overrides,
  };
}

function mkSnapshot(partial: Partial<QueueStateSnapshot> = {}): QueueStateSnapshot {
  return {
    items: partial.items ?? [],
    queueFullAt: partial.queueFullAt ?? null,
    limitedConnectivityAt: partial.limitedConnectivityAt ?? null,
    authExpiredAt: partial.authExpiredAt ?? null,
    boundCloudUrl: partial.boundCloudUrl ?? null,
  };
}

describe('shouldEmit', () => {
  it('returns false when backgrounded', () => {
    expect(shouldEmit(mkSnapshot({ items: [mkItem()] }), 'background')).toBe(false);
    expect(shouldEmit(mkSnapshot({ items: [mkItem()] }), 'inactive')).toBe(false);
  });

  it('returns false when everything is quiet', () => {
    expect(shouldEmit(mkSnapshot(), 'active')).toBe(false);
  });

  it('returns true when items are pending', () => {
    expect(shouldEmit(mkSnapshot({ items: [mkItem()] }), 'active')).toBe(true);
  });

  it('returns true when any flag is set (even with empty items)', () => {
    expect(shouldEmit(mkSnapshot({ queueFullAt: 123 }), 'active')).toBe(true);
    expect(shouldEmit(mkSnapshot({ limitedConnectivityAt: 123 }), 'active')).toBe(true);
    expect(shouldEmit(mkSnapshot({ authExpiredAt: 123 }), 'active')).toBe(true);
  });
});

describe('buildQueueMetricsSample', () => {
  it('returns zeros for an empty queue', () => {
    const sample = buildQueueMetricsSample(mkSnapshot(), 5_000);
    expect(sample.pendingCount).toBe(0);
    expect(sample.countsByType).toEqual({});
    expect(sample.readyCount).toBe(0);
    expect(sample.retryBackoffCount).toBe(0);
    expect(sample.maxAttempts).toBe(0);
    expect(sample.failedItemCount).toBe(0);
    expect(sample.countsByErrorCategory).toEqual({});
    expect(sample.oldestAgeMs).toBeNull();
    expect(sample.limitedConnectivity).toBe(false);
    expect(sample.authExpired).toBe(false);
    expect(sample.queueFull).toBe(false);
    expect(sample.timestamp).toBe(5_000);
  });

  it('aggregates counts by type and error category', () => {
    const sample = buildQueueMetricsSample(
      mkSnapshot({
        items: [
          mkItem({ id: 'a', type: 'text-message', errorCategory: 'network' }),
          mkItem({ id: 'b', type: 'text-message' }),
          mkItem({ id: 'c', type: 'meeting-chunk', errorCategory: 'network' }),
          mkItem({ id: 'd', type: 'meeting-chunk', errorCategory: 'auth' }),
        ],
      }),
      2_000,
    );
    expect(sample.pendingCount).toBe(4);
    expect(sample.countsByType).toEqual({ 'text-message': 2, 'meeting-chunk': 2 });
    expect(sample.countsByErrorCategory).toEqual({ network: 2, auth: 1 });
    expect(sample.failedItemCount).toBe(3);
  });

  it('classifies items by nextRetryAt vs now into ready/backoff', () => {
    const sample = buildQueueMetricsSample(
      mkSnapshot({
        items: [
          mkItem({ id: 'ready', nextRetryAt: 1_000 }),
          mkItem({ id: 'also-ready', nextRetryAt: 0 }),
          mkItem({ id: 'backoff', nextRetryAt: 10_000 }),
        ],
      }),
      2_000,
    );
    expect(sample.readyCount).toBe(2);
    expect(sample.retryBackoffCount).toBe(1);
  });

  it('tracks max attempts and oldest enqueuedAt', () => {
    const sample = buildQueueMetricsSample(
      mkSnapshot({
        items: [
          mkItem({ id: 'a', enqueuedAt: 500, attempts: 2 }),
          mkItem({ id: 'b', enqueuedAt: 2_000, attempts: 7 }),
          mkItem({ id: 'c', enqueuedAt: 1_000, attempts: 1 }),
        ],
      }),
      5_000,
    );
    expect(sample.maxAttempts).toBe(7);
    expect(sample.oldestAgeMs).toBe(4_500);
  });

  it('propagates queue-level flags', () => {
    const sample = buildQueueMetricsSample(
      mkSnapshot({
        items: [mkItem()],
        queueFullAt: 1,
        limitedConnectivityAt: 2,
        authExpiredAt: 3,
      }),
      10,
    );
    expect(sample.queueFull).toBe(true);
    expect(sample.limitedConnectivity).toBe(true);
    expect(sample.authExpired).toBe(true);
  });
});

describe('startQueueMetrics', () => {
  it('skips emission when snapshot is undefined or quiet', () => {
    const emit = jest.fn();
    const m = startQueueMetrics({
      getSnapshot: () => undefined,
      getAppState: () => 'active',
      emit,
    });
    expect(m.emitNow()).toBeNull();
    expect(emit).not.toHaveBeenCalled();

    const m2 = startQueueMetrics({
      getSnapshot: () => mkSnapshot(),
      getAppState: () => 'active',
      emit,
    });
    expect(m2.emitNow()).toBeNull();
    expect(emit).not.toHaveBeenCalled();

    m.stop();
    m2.stop();
  });

  it('emits a sample when active and non-idle', () => {
    const emit = jest.fn();
    const m = startQueueMetrics({
      getSnapshot: () => mkSnapshot({ items: [mkItem()] }),
      getAppState: () => 'active',
      emit,
      now: () => 12_345,
    });
    const sample = m.emitNow();
    expect(sample?.timestamp).toBe(12_345);
    expect(emit).toHaveBeenCalledWith(sample);
    m.stop();
  });
});
