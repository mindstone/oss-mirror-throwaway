// cloud-client/src/offlineQueue/useQueueStatus.ts
//
// Platform-neutral hook that derives a single queue status from connectivity
// inputs and offline queue store state. Consumers pass connectivity via
// arguments — no NetInfo or React Native imports.

import { useMemo } from 'react';
import { useOfflineQueueStore } from './offlineQueueStore';

export type QueueState =
  | 'online-live'       // online, queue empty, no failures
  | 'online-draining'   // online, queue has pending items
  | 'offline-queued'    // offline, queue has items
  | 'offline-empty'     // offline, queue empty
  | 'limited'           // "connected" but stuck-drain detection fired (captive portal-ish)
  | 'auth-expired'      // items marked with auth error for current identity
  | 'queue-full'        // queue hit cap recently; show explicit user-facing warning
  | 'has-failures'      // online, no pending items, but some items permanently failed
  | 'reconnecting';     // WS reconnecting (online but not fully connected)

export interface QueueStatusInputs {
  /** Whether the device has general network connectivity. */
  isOnline: boolean;
  /** Whether internet is confirmed reachable (NetInfo). `null` = unknown. */
  isInternetReachable: boolean | null;
  /** Whether the WebSocket is in reconnecting state. */
  wsReconnecting?: boolean;
}

export interface QueueStatus {
  state: QueueState;
  totalPending: number;
  totalFailed: number;
  oldestEnqueuedAt: number | null;
  lastErrorCategory: string | null;
  /** Derived convenience: should the banner show? */
  shouldShowBanner: boolean;
  /** Derived: is any item permanent-failed? (for Stage 4 UI) */
  hasPermanentFailures: boolean;
}

export function useQueueStatus(inputs: QueueStatusInputs): QueueStatus {
  const items = useOfflineQueueStore((s) => s.items);
  const limitedConnectivityAt = useOfflineQueueStore((s) => s.limitedConnectivityAt);
  const authExpiredAt = useOfflineQueueStore((s) => s.authExpiredAt);
  const queueFullAt = useOfflineQueueStore((s) => s.queueFullAt);
  const boundCloudUrl = useOfflineQueueStore((s) => s.boundCloudUrl);

  return useMemo(() => {
    // Filter items by current auth identity — dormant items bound to a different
    // cloudUrl don't inflate counts. Legacy items (no boundCloudUrl) are included.
    const itemsForCurrentIdentity = items.filter(
      (i) => !i.boundCloudUrl || i.boundCloudUrl === boundCloudUrl,
    );

    const pending = itemsForCurrentIdentity.filter((i) => !i.isPermanentFailure);
    const failed = itemsForCurrentIdentity.filter((i) => i.isPermanentFailure);
    const totalPending = pending.length;
    const totalFailed = failed.length;
    const oldestEnqueuedAt =
      pending.length > 0
        ? Math.min(...pending.map((i) => i.enqueuedAt))
        : null;
    const lastErrorCategory =
      itemsForCurrentIdentity.length > 0
        ? (itemsForCurrentIdentity
            .slice()
            .sort((a, b) => (b.enqueuedAt ?? 0) - (a.enqueuedAt ?? 0))
            .find((i) => i.errorCategory)?.errorCategory ?? null)
        : null;
    const hasPermanentFailures = failed.length > 0;

    const base = { totalPending, totalFailed, oldestEnqueuedAt, lastErrorCategory, hasPermanentFailures };

    // State priority (most critical first):
    // auth-expired > queue-full > reconnecting > limited > offline-queued > offline-empty > has-failures > online-draining > online-live

    if (authExpiredAt !== null) {
      return { ...base, state: 'auth-expired' as const, shouldShowBanner: true };
    }

    if (queueFullAt !== null) {
      return { ...base, state: 'queue-full' as const, shouldShowBanner: true };
    }

    if (inputs.wsReconnecting === true) {
      return { ...base, state: 'reconnecting' as const, shouldShowBanner: true };
    }

    if (limitedConnectivityAt !== null) {
      return { ...base, state: 'limited' as const, shouldShowBanner: true };
    }

    // offline
    if (!inputs.isOnline || inputs.isInternetReachable === false) {
      const state: QueueState = totalPending > 0 ? 'offline-queued' : 'offline-empty';
      return { ...base, state, shouldShowBanner: true };
    }

    // online states — banner stays visible while items are pending (no isDraining gate)
    if (totalPending > 0) {
      return { ...base, state: 'online-draining' as const, shouldShowBanner: true };
    }

    // Online, no pending items, but some items permanently failed
    if (totalFailed > 0) {
      return { ...base, state: 'has-failures' as const, shouldShowBanner: true };
    }

    return { ...base, state: 'online-live' as const, shouldShowBanner: false };
  }, [items, limitedConnectivityAt, authExpiredAt, queueFullAt, boundCloudUrl, inputs.isOnline, inputs.isInternetReachable, inputs.wsReconnecting]);
}
