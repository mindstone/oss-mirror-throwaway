/**
 * usePluginRoute Hook
 *
 * React hook that returns the current plugin's route info (pluginId, tabId, params).
 * Reads from the plugin route store using `useSyncExternalStore` for efficient
 * re-rendering — only fires when the store changes.
 *
 * Usage in plugins:
 * ```ts
 * import { usePluginRoute } from '@rebel/plugin-api';
 * const { pluginId, tabId, params } = usePluginRoute();
 * // params.path, params.meetingId, etc.
 * ```
 *
 * @see src/renderer/features/plugins/api/pluginRouteStore.ts — backing store
 * @see docs/plans/260327_plugin_open_with_params.md — planning doc
 */

import { useSyncExternalStore } from 'react';
import { usePluginId } from './PluginContext';
import { getPluginRoute, subscribeToPluginRouteStore } from './pluginRouteStore';
import type { PluginRouteInfo } from './types';

export function usePluginRoute(): PluginRouteInfo {
  const pluginId = usePluginId();
  const route = useSyncExternalStore(
    subscribeToPluginRouteStore,
    () => getPluginRoute(pluginId),
    () => getPluginRoute(pluginId),
  );
  return { pluginId, tabId: route.tabId, params: route.params };
}
