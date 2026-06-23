/**
 * OpenRouter IPC Handlers
 *
 * Handles openRouter:* IPC channels for OAuth setup and disconnection.
 */

import type { IpcMainInvokeEvent } from 'electron';
import { openRouterChannels } from '@shared/ipc/channels/openRouter';
import { createScopedLogger } from '@core/logger';
import {
  setupOpenRouterToken,
  cancelOpenRouterSetup,
  disconnectOpenRouter,
} from '../services/openRouterSetupService';
import { registerHandler } from './utils/registerHandler';

const log = createScopedLogger({ ipc: 'openRouter' });

export function registerOpenRouterHandlers(): void {
  registerHandler(
    openRouterChannels['openRouter:setup-token'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        return await setupOpenRouterToken();
      } catch (error) {
        log.error({ error }, 'Failed to run OpenRouter token setup');
        return {
          outcome: 'error' as const,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    },
  );

  registerHandler(
    openRouterChannels['openRouter:cancel-setup'].channel,
    async (_event: IpcMainInvokeEvent) => {
      cancelOpenRouterSetup();
    },
  );

  registerHandler(
    openRouterChannels['openRouter:disconnect'].channel,
    async (_event: IpcMainInvokeEvent) => {
      disconnectOpenRouter();
    },
  );

  log.info('OpenRouter IPC handlers registered');
}
