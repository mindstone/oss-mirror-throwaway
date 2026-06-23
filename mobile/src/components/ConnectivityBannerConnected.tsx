// mobile/src/components/ConnectivityBannerConnected.tsx
//
// Thin wrapper that wires the presentation-only ConnectivityBanner
// to store state. Reads connectivity from NetworkContext, connection
// state from sessionStore, and passes derived QueueStatus to the banner.
//
// Separated so ConnectivityBanner remains testable without mocking stores.

import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useAuthStore, useSessionStore, useQueueStatus, createLogger } from '@rebel/cloud-client';
import { useNetworkContext } from '../context/NetworkContext';
import { ConnectivityBanner } from './ConnectivityBanner';

const log = createLogger('ConnectivityBannerConnected');

export function ConnectivityBannerConnected() {
  const { isOnline, isInternetReachable } = useNetworkContext();
  const connectionState = useSessionStore((s) => s.connectionState);
  const router = useRouter();

  const status = useQueueStatus({
    isOnline,
    isInternetReachable,
    wsReconnecting: connectionState === 'reconnecting',
  });

  const handleSignIn = useCallback(() => {
    // Unpair triggers PairScreen render in _layout.tsx (conditional on !isPaired).
    // Does NOT clear queue — per Stage 1, queue is preserved across auth expiry.
    void useAuthStore.getState().unpair();
  }, []);

  const handleFailuresTap = useCallback(() => {
    log.info('User tapped failure banner', { totalFailed: status.totalFailed });
    // Navigate to conversations tab so user can review failed items.
    // Deep-linking to specific sessions is deferred to a follow-up.
    router.push('/(tabs)/conversations');
  }, [status.totalFailed, router]);

  return (
    <ConnectivityBanner
      status={status}
      onSignIn={handleSignIn}
      onFailuresTap={handleFailuresTap}
    />
  );
}
