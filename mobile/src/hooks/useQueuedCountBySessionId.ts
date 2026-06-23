// mobile/src/hooks/useQueuedCountBySessionId.ts
//
// Returns the count of non-permanently-failed queued items targeting a given
// session. Used to show "Queued (N)" badges on conversation list rows.
//
// Uses a safe-access pattern (try/catch around useOfflineQueueStore) because
// the store may not be initialized in tests or early app lifecycle.

import { useState, useEffect } from 'react';
import type { QueueItem, OfflineQueueState } from '@rebel/cloud-client';

/**
 * Return the number of queued (non-permanently-failed) items for a given session.
 * Returns 0 if the offline queue store is not initialized.
 */
export function useQueuedCountBySessionId(sessionId: string): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    try {
      // Dynamic require — store may not exist yet
      const { useOfflineQueueStore } = require('@rebel/cloud-client') as {
        useOfflineQueueStore: {
          getState: () => OfflineQueueState;
          subscribe: (listener: (state: OfflineQueueState) => void) => () => void;
        };
      };

      const derive = (items: QueueItem[]) =>
        items.filter((item) => {
          if (item.isPermanentFailure) return false;
          const meta = item.metadata as { sessionId?: string | null };
          return meta.sessionId === sessionId;
        }).length;

      // Initial value
      try {
        setCount(derive(useOfflineQueueStore.getState().items));
      } catch { /* store not ready */ }

      const unsub = useOfflineQueueStore.subscribe((state: OfflineQueueState) => {
        setCount(derive(state.items));
      });

      return unsub;
    } catch {
      setCount(0);
      return undefined;
    }
  }, [sessionId]);

  return count;
}
