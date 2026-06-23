/**
 * useRegisteredPlugins
 *
 * React hook that provides the list of registered plugins and reactively
 * updates when plugins are registered/unregistered.
 *
 * Uses useSyncExternalStore for tear-free reads from the plugin registry.
 *
 * @see docs/plans/260322_plugin_extension_system.md
 */

import { useSyncExternalStore } from 'react';
import {
  subscribeToPluginRegistry,
  getAllRegisteredPlugins,
  type RegisteredPlugin,
} from '../manifest/pluginRegistry';

export function useRegisteredPlugins(): RegisteredPlugin[] {
  return useSyncExternalStore(
    subscribeToPluginRegistry,
    getAllRegisteredPlugins,
    getAllRegisteredPlugins,
  );
}
