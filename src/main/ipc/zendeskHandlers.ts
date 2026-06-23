/**
 * Zendesk IPC Handlers
 *
 * Handles IPC calls for Zendesk account management.
 */

import { ipcMain } from 'electron';
import { createScopedLogger } from '@core/logger';
import {
  getZendeskAccounts,
  removeZendeskAccount,
  addZendeskApiKeyAccount,
} from '../services/zendeskApiKeyAccountService';

const log = createScopedLogger({ ipc: 'zendesk' });

export function registerZendeskHandlers(): void {
  // Get all connected Zendesk accounts
  ipcMain.handle('zendesk:get-accounts', async () => {
    try {
      const accounts = await getZendeskAccounts();
      return { accounts };
    } catch (error) {
      log.error({ error }, 'Failed to get Zendesk accounts');
      return { accounts: [] };
    }
  });

  // Remove account
  ipcMain.handle('zendesk:remove-account', async (_event, args: { subdomain: string }) => {
    try {
      await removeZendeskAccount(args.subdomain);
      return { success: true };
    } catch (error) {
      log.error({ error }, 'Failed to remove Zendesk account');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Add account via API key (validates credentials, saves to accounts.json)
  ipcMain.handle('zendesk:add-api-key-account', async (_event, args: { subdomain: string; email: string; apiToken: string }) => {
    try {
      const result = await addZendeskApiKeyAccount(args.subdomain, args.email, args.apiToken);
      return { success: true, subdomain: result.subdomain, email: result.email };
    } catch (error) {
      log.error({ error }, 'Failed to add Zendesk API key account');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  log.info('Zendesk IPC handlers registered');
}
