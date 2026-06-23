// mobile/src/hooks/useNetworkState.ts
// Exposes device network connectivity state with debouncing for rapid transitions.

import { useEffect, useRef, useState } from 'react';
import NetInfo from '@react-native-community/netinfo';

const DEBOUNCE_MS = 300;
/** Grace window: treat isInternetReachable=null as reachable for this duration. */
const REACHABILITY_GRACE_MS = 3_000;

export interface NetworkState {
  /** Composite: device is connected AND internet is reachable (with 3s grace for null). */
  isOnline: boolean;
  /** Raw NetInfo isInternetReachable value (null means unknown/still probing). */
  isInternetReachable: boolean | null;
  /** Raw NetInfo isConnected value. True if device has any network interface active. */
  isConnected: boolean;
}

/**
 * Returns the device's current network connectivity state.
 * Debounces rapid state changes (e.g., WiFi↔cellular transitions) to prevent
 * excessive reconnect triggers.
 *
 * `isOnline` is derived as `isConnected && (isInternetReachable ?? true)` with a
 * 3-second grace window: when `isInternetReachable` is `null` on a freshly-connected
 * device, we assume reachable for 3s. If still `null` after 3s, we treat as `false`.
 */
export function useNetworkState(): NetworkState {
  const [isConnected, setIsConnected] = useState(true);
  const [isInternetReachable, setIsInternetReachable] = useState<boolean | null>(null);
  const [graceExpired, setGraceExpired] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state.isConnected ?? true;
      const reachable = state.isInternetReachable ?? null;

      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }

      debounceRef.current = setTimeout(() => {
        setIsConnected(connected);
        setIsInternetReachable(reachable);

        // Start grace timer when reachable is null on a connected device
        if (graceTimerRef.current) {
          clearTimeout(graceTimerRef.current);
          graceTimerRef.current = null;
        }

        if (connected && reachable === null) {
          setGraceExpired(false);
          graceTimerRef.current = setTimeout(() => {
            setGraceExpired(true);
          }, REACHABILITY_GRACE_MS);
        } else {
          // Clear grace state when we get a definitive answer
          setGraceExpired(false);
        }
      }, DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
      }
    };
  }, []);

  // Derive isOnline:
  // - Not connected → offline
  // - Connected + reachable=true → online
  // - Connected + reachable=false → offline (captive portal)
  // - Connected + reachable=null + grace not expired → optimistic online
  // - Connected + reachable=null + grace expired → offline
  const isOnline = isConnected && (isInternetReachable === true || (isInternetReachable === null && !graceExpired));

  return { isOnline, isInternetReachable, isConnected };
}
