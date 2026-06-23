/**
 * Plugin Context
 *
 * Provides the current plugin's ID to all hooks within a plugin component tree.
 * Used by usePluginStorage (and future per-plugin hooks) to automatically
 * namespace operations to the correct plugin.
 *
 * @see docs/plans/260322_plugin_extension_system.md (W3-4)
 */

import { createContext, useContext } from 'react';

interface PluginContextValue {
  pluginId: string;
}

export const PluginContext = createContext<PluginContextValue | null>(null);

export function usePluginId(): string {
  const ctx = useContext(PluginContext);
  if (!ctx) {
    throw new Error('usePluginId must be used within a PluginContext provider');
  }
  return ctx.pluginId;
}
