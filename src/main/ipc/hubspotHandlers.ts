/**
 * HubSpot IPC Handlers
 *
 * Handles IPC calls for HubSpot account management.
 */

import { ipcMain } from 'electron';
import { createScopedLogger } from '@core/logger';
import {
  getHubSpotAccounts,
  startHubSpotAuth,
  removeHubSpotAccount,
  cancelHubSpotAuth,
} from '../services/hubspotAuthService';
import {
  resolveOAuthCredentials,
  hubspotCredentialSource,
} from '../services/oauthCredentials';
import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';

const log = createScopedLogger({ ipc: 'hubspot' });

export function registerHubSpotHandlers(): void {
  // Get all connected HubSpot accounts
  ipcMain.handle('hubspot:get-accounts', async () => {
    try {
      const accounts = await getHubSpotAccounts();
      return { accounts };
    } catch (error) {
      log.error({ error }, 'Failed to get HubSpot accounts');
      return { accounts: [] };
    }
  });

  // Start OAuth flow
  ipcMain.handle('hubspot:start-auth', async (_event, args?: { scopeTier?: 'readonly' | 'full' }) => {
    try {
      const credentials = resolveOAuthCredentials(hubspotCredentialSource);
      if (!credentials) {
        const guidance = describeMissingOAuthCredentials('hubspot');
        return {
          success: false,
          error: guidance.message,
          setupGuidance: guidance,
        };
      }

      const scopeTier = args?.scopeTier ?? 'full';
      const email = await startHubSpotAuth(credentials.clientId, credentials.clientSecret, scopeTier);
      return { success: true, email };
    } catch (error) {
      log.error({ error }, 'Failed to start HubSpot auth');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Remove account
  ipcMain.handle('hubspot:remove-account', async (_event, args: { email: string }) => {
    try {
      await removeHubSpotAccount(args.email);
      return { success: true };
    } catch (error) {
      log.error({ error }, 'Failed to remove HubSpot account');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Cancel pending auth
  ipcMain.handle('hubspot:cancel-auth', () => {
    cancelHubSpotAuth();
  });

  log.info('HubSpot IPC handlers registered');
}
