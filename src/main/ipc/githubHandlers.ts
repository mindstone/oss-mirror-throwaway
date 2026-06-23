/**
 * GitHub IPC Handlers
 *
 * Handles github:* IPC channels for GitHub OAuth account management.
 */

import type { IpcMainInvokeEvent } from 'electron';
import { githubChannels } from '@shared/ipc/contracts';
import { createScopedLogger } from '@core/logger';
import {
  getGitHubStatus,
  removeGitHubAccount,
  startGitHubAuth,
} from '../services/githubAuthService';
import {
  resolveOAuthCredentials,
  githubCredentialSource,
} from '../services/oauthCredentials';
import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
import { registerHandler } from './utils/registerHandler';

const log = createScopedLogger({ ipc: 'github' });

export function registerGitHubHandlers(): void {
  registerHandler(
    githubChannels['github:start-auth'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        // Classify the not-configured case BEFORE calling startGitHubAuth(): the service's
        // getGitHubCredentialsOrThrow() throws an ad-hoc string we'd otherwise surface as a
        // generic error. Resolving here lets us return the structured setupGuidance instead,
        // while leaving the service's throw contract intact as the internal safety net.
        const credentials = resolveOAuthCredentials(githubCredentialSource);
        if (!credentials) {
          const guidance = describeMissingOAuthCredentials('github');
          return {
            success: false,
            error: guidance.message,
            setupGuidance: guidance,
          };
        }

        await startGitHubAuth();
        return { success: true };
      } catch (error) {
        log.error({ error }, 'Failed to start GitHub auth');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  registerHandler(
    githubChannels['github:get-status'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        return await getGitHubStatus();
      } catch (error) {
        log.error({ error }, 'Failed to get GitHub status');
        return { connected: false };
      }
    }
  );

  registerHandler(
    githubChannels['github:remove-account'].channel,
    async (_event: IpcMainInvokeEvent) => {
      try {
        await removeGitHubAccount();
        return { success: true };
      } catch (error) {
        log.error({ error }, 'Failed to remove GitHub account');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    }
  );

  log.info('GitHub IPC handlers registered');
}
