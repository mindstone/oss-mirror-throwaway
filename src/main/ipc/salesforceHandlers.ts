/**
 * Salesforce IPC Handlers
 *
 * Handles IPC calls for Salesforce account management.
 */

import { createScopedLogger } from '@core/logger';
import {
  getSalesforceAccounts,
  startSalesforceAuth,
  removeSalesforceAccount,
  cancelSalesforceAuth,
} from '../services/salesforceAuthService';
import {
  resolveSalesforceCredentials,
  salesforceCredentialSource,
} from '../services/oauthCredentials';
import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
import { registerHandler } from './utils/registerHandler';

const log = createScopedLogger({ ipc: 'salesforce' });

export function registerSalesforceHandlers(): void {
  registerHandler('salesforce:get-accounts', async () => {
    try {
      const accounts = await getSalesforceAccounts();
      return { accounts };
    } catch (error) {
      log.error({ error }, 'Failed to get Salesforce accounts');
      return { accounts: [] };
    }
  });

  registerHandler('salesforce:start-auth', async () => {
    try {
      const credentials = resolveSalesforceCredentials(salesforceCredentialSource);
      if (!credentials) {
        const guidance = describeMissingOAuthCredentials('salesforce');
        return {
          success: false,
          error: guidance.message,
          setupGuidance: guidance,
        };
      }

      const username = await startSalesforceAuth(credentials.clientId, credentials.clientSecret);
      return { success: true, username };
    } catch (error) {
      log.error({ error }, 'Failed to start Salesforce auth');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  registerHandler(
    'salesforce:remove-account',
    async (_event: unknown, args: { username: string }) => {
      try {
        await removeSalesforceAccount(args.username);
        return { success: true };
      } catch (error) {
        log.error({ error }, 'Failed to remove Salesforce account');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  registerHandler('salesforce:cancel-auth', () => {
    cancelSalesforceAuth();
  });

  log.info('Salesforce IPC handlers registered');
}
