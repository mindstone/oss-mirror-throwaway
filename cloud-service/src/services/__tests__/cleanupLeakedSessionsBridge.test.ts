import { describe, expect, it, vi } from 'vitest';
import type { SessionTombstoneStore } from '@core/services/continuity/sessionTombstoneStore';
import { createCleanupLeakedSessionDeletedCallback } from '../cleanupLeakedSessionsBridge';

describe('createCleanupLeakedSessionDeletedCallback', () => {
  it('creates tombstones for each leaked-session deletion and broadcasts delete events', () => {
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000);

    const addTombstone = vi.fn((sessionId: string, deletedBy: 'desktop' | 'mobile' | 'cloud', deletedAt: number) => ({
      sessionId,
      deletedBy,
      deletedAt,
      ttlExpiresAt: deletedAt + 30_000,
    }));
    const tombstoneStore: Pick<SessionTombstoneStore, 'addTombstone'> = { addTombstone };
    const broadcast = vi.fn();

    const onSessionDeletedLocally = createCleanupLeakedSessionDeletedCallback({
      tombstoneStore,
      now,
      broadcast,
    });

    onSessionDeletedLocally('memory-update-a');
    onSessionDeletedLocally('error-eval-b');

    expect(addTombstone).toHaveBeenNthCalledWith(1, 'memory-update-a', 'cloud', 1_000);
    expect(addTombstone).toHaveBeenNthCalledWith(2, 'error-eval-b', 'cloud', 2_000);
    expect(broadcast).toHaveBeenCalledTimes(4);
    expect(broadcast).toHaveBeenNthCalledWith(1, 'cloud:session-changed', {
      sessionId: 'memory-update-a',
      action: 'deleted',
    });
    expect(broadcast).toHaveBeenNthCalledWith(
      2,
      'cloud:session-tombstoned',
      expect.objectContaining({ sessionId: 'memory-update-a', deletedBy: 'cloud', deletedAt: 1_000 }),
    );
    expect(broadcast).toHaveBeenNthCalledWith(3, 'cloud:session-changed', {
      sessionId: 'error-eval-b',
      action: 'deleted',
    });
    expect(broadcast).toHaveBeenNthCalledWith(
      4,
      'cloud:session-tombstoned',
      expect.objectContaining({ sessionId: 'error-eval-b', deletedBy: 'cloud', deletedAt: 2_000 }),
    );
  });
});
