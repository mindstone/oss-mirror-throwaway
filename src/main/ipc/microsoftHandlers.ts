/**
 * Microsoft 365 IPC Handlers
 *
 * Handles IPC calls for Microsoft 365 account management.
 *
 * Multi-Instance Support:
 * Each Microsoft account gets instance-specific MCP server entries
 * (e.g., "Microsoft365Mail-hlatky-outlook-com") to support multiple accounts.
 * Legacy static entries ("Microsoft365Mail") are migrated on connect.
 */

import { ipcMain } from 'electron';
import { createScopedLogger } from '@core/logger';
import {
  getMicrosoftAccounts,
  getMicrosoftConfigDir,
  startMicrosoftAuth,
  removeMicrosoftAccount,
  cancelMicrosoftAuth,
  isMicrosoftConnected,
  getExtraScopesForAccount,
  MICROSOFT_SHAREPOINT_SCOPES,
} from '../services/microsoftAuthService';
import {
  resolveMicrosoftClientId,
  microsoftCredentialSource,
} from '../services/oauthCredentials';
import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
import { upsertMcpServerEntry, removeMcpServerEntry, getMcpServerNames } from '../services/mcpConfigManager';
import {
  removeMcpServerWithCleanup,
  performPostRemovalCleanup,
} from '../services/mcpServerRemovalService';
import {
  buildMicrosoft365MailPayload,
  buildMicrosoft365CalendarPayload,
  buildMicrosoft365FilesPayload,
  buildMicrosoft365TeamsPayload,
  buildMicrosoft365SharePointPayload,
  MICROSOFT_SERVER_BASE_NAMES,
} from '../services/bundledMcpManager';
import { generateInstanceId } from '@shared/utils/mcpInstanceUtils';
import { resolveMcpConfigPath, reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral } from '../services/mcpService';
import {
  MCP_RESTART_CONTEXT_MICROSOFT_CONNECT,
  MCP_RESTART_CONTEXT_MICROSOFT_SHAREPOINT_CONNECT,
} from '@shared/utils/mcpRestartContexts';
import { getSettings } from '../settingsStore';

const log = createScopedLogger({ ipc: 'microsoft' });

/**
 * Remove legacy static Microsoft MCP entries (e.g., "Microsoft365Mail") that were
 * created before multi-instance support. Only removes if instance entries exist.
 * Safe to call multiple times (idempotent).
 */
export async function cleanupLegacyMicrosoftEntries(configPath: string): Promise<void> {
  try {
    const serverNames = await getMcpServerNames(configPath);
    for (const baseName of MICROSOFT_SERVER_BASE_NAMES) {
      if (!serverNames.includes(baseName)) continue;
      // Only remove if at least one instance entry exists for this base name
      const hasInstance = serverNames.some(
        (n) => n.startsWith(`${baseName}-`) && n.length > baseName.length + 1,
      );
      if (hasInstance) {
        await removeMcpServerEntry(configPath, baseName);
        log.info({ baseName }, 'Removed legacy static Microsoft MCP entry (instance entries exist)');
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to cleanup legacy Microsoft MCP entries');
  }
}

export function registerMicrosoftHandlers(): void {
  // Get all connected Microsoft accounts
  ipcMain.handle('microsoft:get-accounts', async () => {
    try {
      const accounts = await getMicrosoftAccounts();
      return { accounts };
    } catch (error) {
      log.error({ error }, 'Failed to get Microsoft accounts');
      return { accounts: [] };
    }
  });

  // Start OAuth flow
  ipcMain.handle('microsoft:start-auth', async () => {
    try {
      const clientId = resolveMicrosoftClientId(microsoftCredentialSource);
      if (!clientId) {
        const guidance = describeMissingOAuthCredentials('microsoft');
        return {
          success: false,
          error: guidance.message,
          setupGuidance: guidance,
        };
      }

      // On reconnection, preserve previously-granted scopes (e.g. Sites.Read.All)
      // to prevent scope regression from org/SharePoint back to personal OneDrive only.
      // Check active accounts first, then fall back to any existing account (e.g. expired tokens).
      const accounts = await getMicrosoftAccounts();
      const existingAccount = accounts.find((a) => a.status === 'active') ?? accounts[0];
      let additionalScopes: string[] | undefined;
      let loginHint: string | undefined;
      if (existingAccount) {
        const extras = await getExtraScopesForAccount(existingAccount.email);
        if (extras.length > 0) {
          additionalScopes = extras;
          loginHint = existingAccount.email;
          log.info({ email: existingAccount.email, extraScopes: extras }, 'Reconnecting with preserved scopes');
        }
      }

      const email = await startMicrosoftAuth(clientId, additionalScopes, loginHint);

      // Register Microsoft MCPs after successful auth
      try {
        const settings = getSettings();
        const resolvedPath = resolveMcpConfigPath(settings);
        if (resolvedPath) {
          const configDir = getMicrosoftConfigDir();
          const microsoftConfig = { clientId, configDir, email };

          await upsertMcpServerEntry(resolvedPath, buildMicrosoft365MailPayload(microsoftConfig));
          await upsertMcpServerEntry(resolvedPath, buildMicrosoft365CalendarPayload(microsoftConfig));
          await upsertMcpServerEntry(resolvedPath, buildMicrosoft365FilesPayload(microsoftConfig));
          await upsertMcpServerEntry(resolvedPath, buildMicrosoft365TeamsPayload(microsoftConfig));
          await upsertMcpServerEntry(resolvedPath, buildMicrosoft365SharePointPayload(microsoftConfig));

          // Clean up legacy static entries now that instance entries exist
          await cleanupLegacyMicrosoftEntries(resolvedPath);

          log.info({ email }, 'Microsoft 365 MCPs registered after successful auth');

          // Hot-reload Super-MCP and refresh caches.
          // Resolve-on-deferral (Stage 4, 260610_gworkspace-mcp-error-disconnect-hang):
          // resolves promptly ({ queued: true }) when the restart is deferred
          // behind active agent turns; idle path still awaits the executed
          // restart. Context byte-identical (renderer deferred-op exact-match).
          try {
            const { queued } = await reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral(resolvedPath, { context: MCP_RESTART_CONTEXT_MICROSOFT_CONNECT });
            log.info({ email, queued }, 'Super-MCP reconfigure requested after Microsoft connect');
          } catch (reconfigError) {
            log.warn({ err: reconfigError }, 'Failed to hot-reload Super-MCP (restart may be needed)');
          }
        }
      } catch (mcpError) {
        log.warn({ err: mcpError }, 'Failed to register Microsoft MCPs after auth');
        // Don't fail the auth - MCPs can be registered on next startup
      }

      return { success: true, email };
    } catch (error) {
      log.error({ error }, 'Failed to start Microsoft auth');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Remove account
  ipcMain.handle('microsoft:remove-account', async (_event, args: { email: string }) => {
    try {
      await removeMicrosoftAccount(args.email);

      // Remove instance-specific MCP entries for this email
      try {
        const settings = getSettings();
        const resolvedPath = resolveMcpConfigPath(settings);
        if (resolvedPath) {
          const instanceNames = MICROSOFT_SERVER_BASE_NAMES.map(
            (base) => generateInstanceId(base, args.email),
          );

          for (const serverName of instanceNames) {
            await removeMcpServerWithCleanup(resolvedPath, serverName, { skipPostCleanup: true });
          }

          // Also remove legacy static entries if no accounts remain
          const stillConnected = await isMicrosoftConnected();
          if (!stillConnected) {
            for (const baseName of MICROSOFT_SERVER_BASE_NAMES) {
              await removeMcpServerWithCleanup(resolvedPath, baseName, { skipPostCleanup: true });
            }
          }

          await performPostRemovalCleanup(resolvedPath);
          log.info({ email: args.email, stillConnected }, 'Microsoft 365 MCPs removed for account');
        }
      } catch (mcpError) {
        log.warn({ err: mcpError }, 'Failed to remove Microsoft MCPs after account removal');
      }

      return { success: true };
    } catch (error) {
      log.error({ error }, 'Failed to remove Microsoft account');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Start incremental consent for SharePoint scopes
  ipcMain.handle('microsoft:start-auth-sharepoint', async () => {
    try {
      const clientId = resolveMicrosoftClientId(microsoftCredentialSource);
      if (!clientId) {
        // No Microsoft OAuth client configured: even though SharePoint is an incremental-consent
        // path, a null clientId means the connector is broken-by-default, so surface the same
        // structured guidance as microsoft:start-auth (Stage 3 refinement) rather than being the
        // odd Microsoft path that can only emit a bare string.
        const guidance = describeMissingOAuthCredentials('microsoft');
        return {
          success: false,
          error: guidance.message,
          setupGuidance: guidance,
        };
      }

      // Find the active Microsoft account email for login_hint
      const accounts = await getMicrosoftAccounts();
      const activeAccount = accounts.find((a) => a.status === 'active');
      if (!activeAccount) {
        return {
          success: false,
          error: 'No active Microsoft account found. Please connect a Microsoft account first.',
        };
      }

      const email = await startMicrosoftAuth(clientId, MICROSOFT_SHAREPOINT_SCOPES, activeAccount.email);

      // Register all Microsoft MCPs (including SharePoint) after successful auth
      try {
        const settings = getSettings();
        const resolvedPath = resolveMcpConfigPath(settings);
        if (resolvedPath) {
          const configDir = getMicrosoftConfigDir();
          const microsoftConfig = { clientId, configDir, email };

          await upsertMcpServerEntry(resolvedPath, buildMicrosoft365MailPayload(microsoftConfig));
          await upsertMcpServerEntry(resolvedPath, buildMicrosoft365CalendarPayload(microsoftConfig));
          await upsertMcpServerEntry(resolvedPath, buildMicrosoft365FilesPayload(microsoftConfig));
          await upsertMcpServerEntry(resolvedPath, buildMicrosoft365TeamsPayload(microsoftConfig));
          await upsertMcpServerEntry(resolvedPath, buildMicrosoft365SharePointPayload(microsoftConfig));

          await cleanupLegacyMicrosoftEntries(resolvedPath);

          log.info({ email }, 'Microsoft 365 MCPs (including SharePoint) registered after incremental consent');

          // Hot-reload Super-MCP and refresh caches.
          // Resolve-on-deferral — same rationale as microsoft:start-auth above.
          try {
            const { queued } = await reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral(resolvedPath, { context: MCP_RESTART_CONTEXT_MICROSOFT_SHAREPOINT_CONNECT });
            log.info({ email, queued }, 'Super-MCP reconfigure requested after Microsoft SharePoint consent');
          } catch (reconfigError) {
            log.warn({ err: reconfigError }, 'Failed to hot-reload Super-MCP (restart may be needed)');
          }
        }
      } catch (mcpError) {
        log.warn({ err: mcpError }, 'Failed to register Microsoft MCPs after SharePoint auth');
      }

      return { success: true, email };
    } catch (error) {
      log.error({ error }, 'Failed to start Microsoft SharePoint auth');
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  });

  // Cancel pending auth
  ipcMain.handle('microsoft:cancel-auth', () => {
    cancelMicrosoftAuth();
  });

  // Check if connected
  ipcMain.handle('microsoft:is-connected', async () => {
    try {
      const connected = await isMicrosoftConnected();
      return { connected };
    } catch (error) {
      log.error({ error }, 'Failed to check Microsoft connection');
      return { connected: false };
    }
  });

  log.info('Microsoft IPC handlers registered');
}
