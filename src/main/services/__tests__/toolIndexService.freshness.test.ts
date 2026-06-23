import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getToolIndexStatus,
  markToolIndexInvalidated,
  markToolIndexRefreshComplete,
  rollbackToolIndexInvalidation,
} from '../toolIndexService';

function resetFreshnessState(): void {
  const generation = markToolIndexInvalidated('test-reset');
  markToolIndexRefreshComplete(generation, { success: true });
}

afterEach(() => {
  resetFreshnessState();
});

beforeEach(() => {
  resetFreshnessState();
});

describe('toolIndexService stale generation gate', () => {
  it('marks stale state with generation metadata', () => {
    const generation = markToolIndexInvalidated('oauth-reconfigure');
    const status = getToolIndexStatus();

    expect(generation).toBeGreaterThan(0);
    expect(status.isStale).toBe(true);
    expect(status.staleGeneration).toBe(generation);
    expect(status.staleReason).toBe('oauth-reconfigure');
    expect(typeof status.staleSince).toBe('number');
  });

  it('clears stale only when latest generation refresh succeeds', () => {
    const firstGeneration = markToolIndexInvalidated('first-change');
    const latestGeneration = markToolIndexInvalidated('second-change');

    markToolIndexRefreshComplete(firstGeneration, { success: true });
    let status = getToolIndexStatus();
    expect(status.isStale).toBe(true);
    expect(status.staleGeneration).toBe(latestGeneration);

    markToolIndexRefreshComplete(latestGeneration, { success: true });
    status = getToolIndexStatus();
    expect(status.isStale).toBe(false);
    expect(status.staleGeneration).toBeNull();
    expect(status.staleReason).toBeNull();
  });

  it('keeps stale state and records error when refresh fails', () => {
    const generation = markToolIndexInvalidated('connector-update');

    markToolIndexRefreshComplete(generation, { success: false, error: 'refresh failed' });
    const status = getToolIndexStatus();

    expect(status.isStale).toBe(true);
    expect(status.staleGeneration).toBe(generation);
    expect(status.staleReason).toBe('connector-update');
    expect(status.lastRefreshError).toBe('refresh failed');
  });

  it('restores previous stale snapshot when invalidation is rolled back', () => {
    const initialGeneration = markToolIndexInvalidated('prior-change');
    markToolIndexRefreshComplete(initialGeneration, { success: false, error: 'prior refresh failed' });
    const beforeRollback = getToolIndexStatus();

    const failedReconfigureGeneration = markToolIndexInvalidated('failed-reconfigure');
    rollbackToolIndexInvalidation(failedReconfigureGeneration);
    const afterRollback = getToolIndexStatus();

    expect(afterRollback.isStale).toBe(true);
    expect(afterRollback.staleGeneration).toBe(beforeRollback.staleGeneration);
    expect(afterRollback.staleReason).toBe(beforeRollback.staleReason);
    expect(afterRollback.lastRefreshError).toBe(beforeRollback.lastRefreshError);
  });
});
