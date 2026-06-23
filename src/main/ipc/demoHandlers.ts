/**
 * Demo Domain IPC Handlers
 *
 * Handles demo mode entry/exit and status.
 */

import { type IpcMainInvokeEvent } from 'electron';
import { logger } from '@core/logger';
import { enterDemoMode, exitDemoMode, isDemoModeActive, type EnterDemoModeOptions } from '../services/demoModeService';
import { registerHandler } from './utils/registerHandler';

export interface DemoHandlerDeps {
  getActiveTurnCount: () => number;
  abortAllTurns: () => void;
  broadcastDemoModeChange: (active: boolean) => void;
}

export function registerDemoHandlers(deps: DemoHandlerDeps): void {
  const { getActiveTurnCount, abortAllTurns, broadcastDemoModeChange } = deps;

  registerHandler('demo:enter', async (_event: IpcMainInvokeEvent, options?: { keepApiKeys?: boolean; seedMockContent?: boolean; showOnboarding?: boolean }) => {
    // Force-abort any active turns - demo mode entry should always work
    const activeTurns = getActiveTurnCount();
    if (activeTurns > 0) {
      logger.info({ activeTurns }, 'Aborting active turns before entering demo mode');
      abortAllTurns();
      // Brief delay to let turns acknowledge abort before app restart
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    try {
      const enterOptions: EnterDemoModeOptions = {
        keepApiKeys: options?.keepApiKeys ?? false,
        seedMockContent: options?.seedMockContent ?? false,
        showOnboarding: options?.showOnboarding ?? false,
      };
      const result = await enterDemoMode(enterOptions);
      if (result.success) {
        broadcastDemoModeChange(true);
      }
      return result;
    } catch (error) {
      logger.error({ err: error }, 'Failed to enter demo mode');
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  registerHandler('demo:exit', async (_event: IpcMainInvokeEvent) => {
    // Force-abort any active turns - demo mode exit should always work
    const activeTurns = getActiveTurnCount();
    if (activeTurns > 0) {
      logger.info({ activeTurns }, 'Aborting active turns before exiting demo mode');
      abortAllTurns();
      // Brief delay to let turns acknowledge abort before app restart
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    try {
      const result = await exitDemoMode();
      if (result.success) {
        broadcastDemoModeChange(false);
      }
      return result;
    } catch (error) {
      logger.error({ err: error }, 'Failed to exit demo mode');
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  registerHandler('demo:status', (_event: IpcMainInvokeEvent) => {
    return {
      active: isDemoModeActive(),
      hasActiveTurns: getActiveTurnCount() > 0,
    };
  });
}
