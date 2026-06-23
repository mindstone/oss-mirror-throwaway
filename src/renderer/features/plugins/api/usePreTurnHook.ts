import { useEffect, useRef } from 'react';
import { getRegisteredPlugin } from '../manifest/pluginRegistry';
import { usePluginId } from './PluginContext';
import { getPluginContexts, registerPluginContext } from './pluginContextRegistry';
import type { UsePreTurnHookOptions } from './types';

let lastSyncedContexts = '';

async function syncPluginContextsToMainProcess(): Promise<void> {
  if (typeof window === 'undefined' || !window.pluginsApi?.getContexts) {
    return;
  }

  const contexts = getPluginContexts();
  const serialized = JSON.stringify(contexts);
  if (serialized === lastSyncedContexts) {
    return;
  }

  try {
    await window.pluginsApi.getContexts({ contexts });
    lastSyncedContexts = serialized;
  } catch {
    // Keep quiet and retry on the next render/effect cycle.
  }
}

export function usePreTurnHook(options: UsePreTurnHookOptions): void {
  const pluginId = usePluginId();
  const pluginName = getRegisteredPlugin(pluginId)?.manifest.name ?? pluginId;
  const getContextRef = useRef(options.getContext);
  getContextRef.current = options.getContext;

  const priority = options.priority ?? 0;

  useEffect(() => {
    const unregister = registerPluginContext(
      pluginId,
      pluginName,
      () => getContextRef.current(),
      priority,
    );

    void syncPluginContextsToMainProcess();

    return () => {
      unregister();
      void syncPluginContextsToMainProcess();
    };
  }, [pluginId, pluginName, priority]);

  // Sync after each render so context derived from changing plugin state stays fresh.
  useEffect(() => {
    void syncPluginContextsToMainProcess();
  });
}
