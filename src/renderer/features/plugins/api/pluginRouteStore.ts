/**
 * Plugin Route Store
 *
 * Module-level reactive store for plugin route state (tabId + URL params).
 * Plugins read route info via the `usePluginRoute()` hook, which subscribes
 * to this store using `useSyncExternalStore`.
 *
 * Route state is written by two entry points:
 * - Agent IPC broadcast (`plugins:navigate` → App.tsx listener)
 * - URL navigation (`rebel://plugin/...` → NavigationContext)
 *
 * Design decisions:
 * - Full replacement semantics: `setPluginRoute` replaces tabId + params entirely
 * - Frozen EMPTY_ROUTE constant: prevents unnecessary re-renders for plugins with no route
 * - `clearPluginRoute` no-ops if plugin has no stored route (avoids spurious emits)
 *
 * @see src/renderer/features/plugins/api/usePluginRoute.ts — React hook
 * @see docs/plans/260327_plugin_open_with_params.md — planning doc
 */

export type PluginRouteState = {
  tabId?: string;
  params: Record<string, string>;
};

/** Stable frozen reference returned for plugins with no stored route. */
const EMPTY_ROUTE: Readonly<PluginRouteState> = Object.freeze({ params: {} });

let routeMap = new Map<string, PluginRouteState>();
let listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) listener();
}

/**
 * Set route state for a plugin. Full replacement — never merges with previous state.
 * `params` defaults to `{}` when not provided.
 */
export function setPluginRoute(
  pluginId: string,
  route: { tabId?: string; params?: Record<string, string> },
): void {
  const next: PluginRouteState = {
    tabId: route.tabId,
    params: route.params ?? {},
  };
  routeMap.set(pluginId, next);
  emitChange();
}

/**
 * Get route state for a plugin. Returns the frozen EMPTY_ROUTE reference
 * when no route has been set — ensures referential stability for
 * `useSyncExternalStore` consumers.
 */
export function getPluginRoute(pluginId: string): Readonly<PluginRouteState> {
  return routeMap.get(pluginId) ?? EMPTY_ROUTE;
}

/**
 * Subscribe to route store changes. Used by `useSyncExternalStore` in `usePluginRoute`.
 * Returns an unsubscribe function.
 */
export function subscribeToPluginRouteStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Clear route state for a plugin. No-ops if plugin has no stored route
 * to avoid spurious listener notifications.
 */
export function clearPluginRoute(pluginId: string): void {
  if (!routeMap.has(pluginId)) return;
  routeMap.delete(pluginId);
  emitChange();
}

/** Reset all route store state (for testing). */
export function _resetRouteStore(): void {
  routeMap = new Map();
  listeners = new Set();
}
