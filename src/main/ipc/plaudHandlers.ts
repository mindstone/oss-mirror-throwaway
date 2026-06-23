/**
 * Plaud IPC Handlers
 *
 * Handles all plaud:* IPC channels for Plaud voice recorder integration.
 * Uses OAuth 2.0 with Cloudflare Worker redirect (Plaud doesn't support localhost).
 */

import type { IpcMainInvokeEvent } from 'electron';
import { plaudChannels } from '@shared/ipc/contracts';
import { registerHandler } from './utils/registerHandler';
import {
  getPlaudAccount,
  startPlaudAuth,
  disconnectPlaud,
  cancelPlaudAuth,
} from '../services/plaud';
import {
  triggerManualSync,
  isSyncInProgress,
  getLastSyncTime,
  retranscribePlaudMeeting,
} from '../services/plaud';
import { logger } from '@core/logger';
import { resolvePlaudCredentials } from '../services/oauthCredentials';
import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';

/**
 * Register all Plaud IPC handlers
 */
export function registerPlaudHandlers(): void {
  registerHandler(
    plaudChannels['plaud:get-connection-state'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        const account = await getPlaudAccount();
        const lastSyncTime = await getLastSyncTime();

        return {
          connected: account !== null,
          account: account ?? undefined,
          lastSyncTime,
          syncInProgress: isSyncInProgress(),
        };
      } catch (error) {
        logger.error({ err: error }, 'Failed to get Plaud connection state');
        return {
          connected: false,
          lastSyncTime: null,
          syncInProgress: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  registerHandler(
    plaudChannels['plaud:start-auth'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        const credentials = resolvePlaudCredentials();
        if (!credentials) {
          const guidance = describeMissingOAuthCredentials('plaud');
          return {
            success: false,
            error: guidance.message,
            setupGuidance: guidance,
          };
        }

        const { completion } = startPlaudAuth(credentials.clientId, credentials.clientSecret);
        const { email } = await completion;

        return { success: true, email };
      } catch (error) {
        logger.error({ err: error }, 'Failed to start Plaud OAuth');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'OAuth failed',
        };
      }
    }
  );

  registerHandler(
    plaudChannels['plaud:disconnect'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        await disconnectPlaud();
        return { success: true };
      } catch (error) {
        logger.error({ err: error }, 'Failed to disconnect Plaud');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Disconnect failed',
        };
      }
    }
  );

  registerHandler(
    plaudChannels['plaud:trigger-sync'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        const result = await triggerManualSync();
        return {
          success: true,
          synced: result.synced,
          errors: result.errors,
        };
      } catch (error) {
        logger.error({ err: error }, 'Failed to trigger Plaud sync');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Sync failed',
        };
      }
    }
  );

  registerHandler(plaudChannels['plaud:cancel-auth'].channel, async (_event: IpcMainInvokeEvent) => {
    cancelPlaudAuth();
  });

  registerHandler(
    plaudChannels['plaud:retranscribe'].channel,
    async (_event: IpcMainInvokeEvent, { filePath }: { filePath: string }) => {
      try {
        const result = await retranscribePlaudMeeting(filePath);
        return result;
      } catch (error) {
        logger.error({ err: error, filePath }, 'Failed to retranscribe Plaud meeting');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Retranscription failed',
        };
      }
    }
  );
}
