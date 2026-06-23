import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getManagedAllowedModelIds,
  type ManagedDefaultModels,
  type ManagedProviderInfo,
} from '@shared/types/managedProvider';

type AuthApiWithConfigEvents = Window['authApi'] & {
  onAuthConfigReceived?: (callback: () => void) => () => void;
};

export interface ManagedDefaultsState {
  /** Subset of model IDs the managed key permits. Empty when no managed defaults are configured. */
  managedAllowedModels: string[];
  /** Raw default-models mapping from /config (role → model id). Undefined when not configured. */
  defaultModels: ManagedDefaultModels | undefined;
  /** True when a managed provider is provisioned (mindstone-managed-key path is available). */
  hasManagedKey: boolean;
  /** Convenience: returns true when an allow-list is configured (use with `activeProvider === 'mindstone'`). */
  hasManagedAllowList: boolean;
  /** Raw managed provider info (credit fields, resetsAt, etc.). Undefined when not provisioned. */
  managedProvider: ManagedProviderInfo | undefined;
  /** Manually re-fetch the managed-provider snapshot from /config. */
  refresh: () => Promise<void>;
  /** Request a debounced server /config refresh (round-trip), then broadcast-driven cache update. */
  requestServerRefresh: () => Promise<void>;
}

/**
 * Subscribes to /config managed-provider data and returns the current
 * managed-tier default model allow-list. Used by the renderer model picker
 * (Stage G1) to lock dropdowns when activeProvider === 'mindstone', and by the
 * snap-to-default utility on tier changes (Stage G5).
 *
 * Mirrors the auth-config subscription pattern used by useFeatureGate.
 */
export function useManagedDefaults(): ManagedDefaultsState {
  const [managedProvider, setManagedProvider] = useState<ManagedProviderInfo | undefined>(undefined);
  const [hasManagedKey, setHasManagedKey] = useState<boolean>(false);
  const isMountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const config = await window.authApi?.getConfig();
      if (!isMountedRef.current) return;
      setManagedProvider(config?.managedProvider as ManagedProviderInfo | undefined);
      setHasManagedKey(Boolean(config?.hasManagedKey));
    } catch {
      if (!isMountedRef.current) return;
      setManagedProvider(undefined);
      setHasManagedKey(false);
    }
  }, []);

  const requestServerRefresh = useCallback(async () => {
    try {
      await window.authApi?.refreshConfig();
    } catch {
      // Best-effort refresh request. Existing cached config remains usable.
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    void refresh();

    const authApiWithConfigEvents = window.authApi as AuthApiWithConfigEvents | undefined;
    const subscribe =
      authApiWithConfigEvents && typeof authApiWithConfigEvents.onAuthConfigReceived === 'function'
        ? authApiWithConfigEvents.onAuthConfigReceived.bind(authApiWithConfigEvents)
        : window.api?.onAuthConfigReceived?.bind(window.api);

    const unsubscribe = subscribe
      ? subscribe(() => {
          void refresh();
        })
      : () => {};

    return () => {
      isMountedRef.current = false;
      unsubscribe();
    };
  }, [refresh]);

  return useMemo(() => {
    const managedAllowedModels = getManagedAllowedModelIds(managedProvider);
    return {
      managedAllowedModels,
      defaultModels: managedProvider?.defaultModels,
      hasManagedKey,
      hasManagedAllowList: managedAllowedModels.length > 0,
      managedProvider,
      refresh,
      requestServerRefresh,
    };
  }, [hasManagedKey, managedProvider, refresh, requestServerRefresh]);
}
