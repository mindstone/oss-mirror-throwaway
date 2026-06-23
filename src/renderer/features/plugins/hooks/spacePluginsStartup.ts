/**
 * App-level singleton for Space plugin scanning and activation.
 *
 * App.tsx owns the lifecycle: `startSharedSpacePluginsController()` on mount,
 * `stopSharedSpacePluginsController()` on unmount. PluginsTab and other consumers
 * call `getSharedSpacePluginsController()` to subscribe and `refresh()`, but
 * never start/stop.
 */
import { useCallback, useEffect, useState } from 'react';
import { createDefaultSpacePluginsController, type SpacePluginsController, type UseSpacePluginsResult } from './useSpacePlugins';

let sharedController: SpacePluginsController | null = null;

/**
 * Lazily creates and returns the shared controller singleton.
 * Safe to call multiple times — returns the same instance.
 */
export function getSharedSpacePluginsController(): SpacePluginsController {
  if (!sharedController) {
    sharedController = createDefaultSpacePluginsController();
  }
  return sharedController;
}

/**
 * Called by App.tsx on mount. Creates the controller (if needed) and starts scanning.
 */
export function startSharedSpacePluginsController(): void {
  getSharedSpacePluginsController().start();
}

/**
 * Called by App.tsx on unmount. Stops the watcher and cleans up.
 */
export function stopSharedSpacePluginsController(): void {
  if (sharedController) {
    sharedController.stop();
  }
}

/**
 * React hook for consumers (e.g. PluginsTab) that subscribes to the shared
 * controller's state. Returns the same shape as `useSpacePlugins()` but does
 * NOT own the controller lifecycle — App.tsx does.
 */
export function useSharedSpacePlugins(): UseSpacePluginsResult {
  const controller = getSharedSpacePluginsController();
  const [state, setState] = useState(() => controller.getState());

  useEffect(() => {
    // Sync immediately in case state changed between render and effect
    setState(controller.getState());
    return controller.subscribe(() => {
      setState(controller.getState());
    });
  }, [controller]);

  const refresh = useCallback(() => {
    void controller.refresh();
  }, [controller]);

  return {
    ...state,
    refresh,
  };
}

// ---- Test helpers (not for production use) ----

/** @internal Reset the singleton — only for tests */
export function resetSharedControllerForTest(): void {
  if (sharedController) {
    sharedController.stop();
  }
  sharedController = null;
}

/** @internal Inject a custom controller — only for tests */
export function setSharedControllerForTest(controller: SpacePluginsController): void {
  sharedController = controller;
}
