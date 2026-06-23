/**
 * usePluginStorage — per-plugin persistent key-value storage hook.
 *
 * Provides a useState-like API backed by IPC to the main process store.
 * Values persist across plugin unmount/remount and app restart.
 * Storage is namespaced per plugin (via PluginContext) with a 10MB quota.
 *
 * Uses Option A (two-phase init): starts with defaultValue, loads from IPC
 * on mount, updates state. The brief flash of default is acceptable for v1.
 *
 * On quota exceeded: reverts optimistic state to the previous value and
 * logs a warning. The Settings > Plugins UI shows per-plugin storage usage.
 *
 * @see docs/plans/260322_plugin_extension_system.md (W3-4)
 * @see docs/plans/260408_plugin_data_storage_robustness.md (Stage 3)
 * @see src/core/services/pluginStorageStore.ts — main process store
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePluginId } from './PluginContext';

export function usePluginStorage<T>(key: string, defaultValue: T): [T, (value: T) => void] {
  const pluginId = usePluginId();
  const [value, setValueState] = useState<T>(defaultValue);
  const latestValueRef = useRef<T>(defaultValue);

  // Load persisted value on mount
  useEffect(() => {
    let cancelled = false;

    if (typeof window !== 'undefined' && window.pluginsApi?.storageGet) {
      window.pluginsApi
        .storageGet({ pluginId, key })
        .then((result) => {
          if (cancelled) return;
          if (result.value !== undefined) {
            const loaded = result.value as T;
            latestValueRef.current = loaded;
            setValueState(loaded);
          }
        })
        .catch((err) => {
          console.error('[usePluginStorage] Failed to load value:', err);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [pluginId, key]);

  const setValue = useCallback(
    (newValue: T) => {
      // Save the previous value so we can revert on failure
      const previousValue = latestValueRef.current;

      // Optimistic update — set local state immediately
      latestValueRef.current = newValue;
      setValueState(newValue);

      // Persist via IPC
      if (typeof window !== 'undefined' && window.pluginsApi?.storageSet) {
        window.pluginsApi
          .storageSet({ pluginId, key, value: newValue })
          .then((result) => {
            if (!result.ok) {
              // Revert optimistic state to previous persisted value
              latestValueRef.current = previousValue;
              setValueState(previousValue);
              console.warn(
                `[usePluginStorage] Storage write failed for plugin "${pluginId}", key "${key}": ${result.error}. Reverted to previous value.`,
              );
            }
          })
          .catch((err) => {
            // Revert optimistic state on IPC error
            latestValueRef.current = previousValue;
            setValueState(previousValue);
            console.error('[usePluginStorage] IPC error:', err);
          });
      }
    },
    [pluginId, key],
  );

  return [value, setValue];
}
