/**
 * Google Workspace IPC Handlers
 *
 * Handles all google-workspace:* IPC channels for Google account management.
 * 
 * Note: Google Workspace MCP is disabled by default until Google OAuth verification completes.
 * Users can enable it in Settings if they have their own OAuth credentials.
 * Handlers fail gracefully with diagnostic logging when disabled.
 * 
 * Multi-Instance Support (v2 Architecture):
 * After successful OAuth, creates an instance-specific MCP server entry using the
 * GoogleWorkspace-{email-slug} naming convention. Credentials are immediately copied
 * to instance-specific directories for proper isolation. mcpServers is the single
 * source of truth - no separate ConnectorInstance metadata.
 */

import type { IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { app } from 'electron';
import { googleWorkspaceChannels } from '@shared/ipc/contracts';
import { atomicCredentialWrite } from '@core/utils/atomicCredentialWrite';
import { registerHandler } from './utils/registerHandler';
import {
  startGoogleAuth,
  removeGoogleAccount,
  cancelGoogleAuth,
  revokeGoogleToken,
} from '../services/googleWorkspaceAuthService';
import { logger } from '@core/logger';
import {
  resolveOAuthCredentials,
  googleCredentialSource,
} from '../services/oauthCredentials';
import { describeMissingOAuthCredentials } from '@core/services/oauthConnectorSetup';
import { getSettings } from '../settingsStore';
import { upsertMcpServerEntry, removeMcpServerEntry, getMcpServerNames } from '../services/mcpConfigManager';
import { clearForSlug as clearOAuthRefreshFailureForSlug } from '../services/oauthRefreshFailureStore';
import { removeMcpServerWithCleanup } from '../services/mcpServerRemovalService';
import { parseMultiInstanceServer, parseEmailFromSlug } from '@shared/utils/mcpInstanceUtils';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { 
  generateInstanceId, 
  buildGoogleWorkspaceInstancePayload,
  type GoogleWorkspaceInstanceConfig 
} from '../services/bundledMcpManager';
import { resolveMcpConfigPath, reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral } from '../services/mcpService';
import { MCP_RESTART_CONTEXT_GOOGLE_WORKSPACE_CONNECT } from '@shared/utils/mcpRestartContexts';

/** Get resolved MCP config path using current settings */
const getMcpConfigPath = (): string => {
  const settings = getSettings();
  const configPath = resolveMcpConfigPath(settings);
  if (!configPath) {
    throw new Error('MCP config path not configured');
  }
  return configPath;
};

/**
 * Clean up legacy generic "GoogleWorkspace" entry if instance entries exist.
 * 
 * The v2 architecture (Dec 2025) uses instance-based entries like "GoogleWorkspace-greg-work-com"
 * instead of a single "GoogleWorkspace" entry. If both exist, the legacy entry causes routing
 * confusion (credentials expected in different locations).
 * 
 * This function removes the generic entry ONLY if at least one instance entry exists.
 * Safe to call multiple times (idempotent).
 * 
 * @returns true if legacy entry was removed, false if no cleanup needed
 */
export async function cleanupLegacyGoogleWorkspaceEntry(configPath: string): Promise<boolean> {
  try {
    const serverNames = await getMcpServerNames(configPath);
    
    // Check if generic "GoogleWorkspace" entry exists
    const hasGeneric = serverNames.includes('GoogleWorkspace');
    if (!hasGeneric) {
      return false; // Nothing to clean up
    }
    
    // Check if any instance entries exist (GoogleWorkspace-*)
    const hasInstances = serverNames.some(name => {
      const parsed = parseMultiInstanceServer(name);
      return parsed.isInstance && parsed.baseName === 'GoogleWorkspace';
    });
    
    if (!hasInstances) {
      // Keep generic entry if no instances exist (user hasn't migrated yet)
      return false;
    }
    
    // Remove the legacy generic entry
    await removeMcpServerEntry(configPath, 'GoogleWorkspace');
    logger.info('Removed legacy generic GoogleWorkspace entry (instance entries exist)');
    return true;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to check/cleanup legacy GoogleWorkspace entry');
    return false;
  }
}



/**
 * Sanitize email for use in filename.
 * Matches the format used by googleWorkspaceAuthService for consistency.
 */
const sanitizeEmail = (email: string): string =>
  email.replace(/[^a-zA-Z0-9]/g, '-');

/** Get the shared (staging) config directory where auth service writes credentials */
const getSharedConfigDir = (): string =>
  path.join(app.getPath('userData'), 'google-workspace-mcp');

async function ensurePrivateDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(dirPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to use symlinked credential directory: ${dirPath}`);
  }
  await fs.chmod(dirPath, 0o700).catch(() => undefined);
}

async function assertNotSymlinkIfPresent(filePath: string): Promise<void> {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to read or write symlinked credential file: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
}

/**
 * Copy credentials from shared staging dir to instance-specific dir.
 * Creates a single-account accounts.json for the instance.
 */
async function copyCredentialsToInstanceDir(
  email: string,
  sharedDir: string,
  instanceDir: string
): Promise<void> {
  const sanitized = sanitizeEmail(email);
  
  // Create instance directories
  const instanceCredentialsDir = path.join(instanceDir, 'credentials');
  await ensurePrivateDirectory(instanceDir);
  await ensurePrivateDirectory(instanceCredentialsDir);
  
  // Copy token file from shared credentials dir to instance credentials dir
  const sharedTokenPath = path.join(sharedDir, 'credentials', `${sanitized}.token.json`);
  const instanceTokenPath = path.join(instanceCredentialsDir, `${sanitized}.token.json`);
  
  try {
    await assertNotSymlinkIfPresent(sharedTokenPath);
    await assertNotSymlinkIfPresent(instanceTokenPath);
    const tokenData = await fs.readFile(sharedTokenPath, 'utf8');
    await atomicCredentialWrite(instanceTokenPath, tokenData, { mode: 0o600 });
    await fs.chmod(instanceTokenPath, 0o600).catch(() => undefined);
    logger.debug({ email, from: sharedTokenPath, to: instanceTokenPath }, 'Copied token to instance dir');
  } catch (error) {
    // Token might not exist yet if OAuth just completed - this is fine
    logger.warn({ err: error, email }, 'Token file not found in shared dir (may still be writing)');
    throw new Error(`Failed to copy token for ${email}: credentials not found in staging directory`);
  }
  
  // Create single-account accounts.json for this instance
  const instanceAccountsPath = path.join(instanceDir, 'accounts.json');
  await assertNotSymlinkIfPresent(instanceAccountsPath);
  const accountsData = {
    accounts: [
      {
        email,
        category: 'personal',
        description: 'Connected via Rebel',
      },
    ],
  };
  await atomicCredentialWrite(instanceAccountsPath, JSON.stringify(accountsData, null, 2), { mode: 0o600 });
  await fs.chmod(instanceAccountsPath, 0o600).catch(() => undefined);
  logger.debug({ email, path: instanceAccountsPath }, 'Created instance accounts.json');
}

/**
 * Extract email from an MCP server description.
 * Expected format: "{email} - Calendar, Drive, Gmail, Contacts"
 * 
 * @returns email if found, null otherwise
 */
function parseEmailFromDescription(description: string | undefined): string | null {
  if (!description) return null;
  const match = description.match(/^([^\s]+@[^\s]+)\s*-/);
  return match?.[1] ?? null;
}

/**
 * Get Google Workspace accounts from mcpServers (single source of truth).
 * 
 * The v2 architecture uses mcpServers as the source of truth for connected accounts.
 * Each GoogleWorkspace-{email-slug} entry represents one connected account.
 * Email is extracted from the description field (more reliable than slug parsing).
 */
async function getGoogleAccountsFromMcpServers(): Promise<Array<{
  email: string;
  category: string;
  description: string;
  status: 'active' | 'expired' | 'error';
}>> {
  try {
    const configPath = getMcpConfigPath();
    
    // Read config once (not per server) for efficiency
    let configData: { mcpServers?: Record<string, { description?: string; email?: string; catalogId?: string }> } = {};
    try {
      const config = await fs.readFile(configPath, 'utf-8');
      configData = JSON.parse(config);
    } catch {
      logger.warn('Failed to read MCP config for account enumeration');
      return [];
    }
    
    const serverNames = Object.keys(configData.mcpServers ?? {});
    
    const accounts: Array<{
      email: string;
      category: string;
      description: string;
      status: 'active' | 'expired' | 'error';
    }> = [];
    
    for (const serverName of serverNames) {
      const parsed = parseMultiInstanceServer(serverName);
      if (!parsed.isInstance || parsed.baseName !== 'GoogleWorkspace') {
        continue; // Skip non-GoogleWorkspace entries
      }
      
      const serverEntry = configData.mcpServers?.[serverName];
      
      // Priority order for email extraction:
      // 1. Explicit email field (most reliable - set during creation)
      // 2. Parse from description (legacy format: "email@... - ...")
      // 3. Parse from server name slug (lossy but functional)
      let email = serverEntry?.email ?? null;
      
      if (!email) {
        email = parseEmailFromDescription(serverEntry?.description);
      }
      
      if (!email && parsed.emailSlug) {
        email = parseEmailFromSlug(parsed.emailSlug);
      }
      
      if (!email) {
        logger.warn({ serverName }, 'Could not extract email from GoogleWorkspace instance');
        continue;
      }
      
      // Check token status by looking in instance directory
      const sharedDir = getSharedConfigDir();
      const instanceDir = path.join(sharedDir, serverName);
      const tokenPath = path.join(instanceDir, 'credentials', `${sanitizeEmail(email)}.token.json`);
      
      let status: 'active' | 'expired' | 'error' = 'error';
      try {
        const tokenData = JSON.parse(await fs.readFile(tokenPath, 'utf-8'));
        // Validate expiry_date is a number before comparing
        if (typeof tokenData.expiry_date === 'number' && tokenData.expiry_date > Date.now()) {
          status = 'active';
        } else if (tokenData.refresh_token) {
          status = 'active'; // MCP will refresh
        } else {
          status = 'expired';
        }
      } catch {
        // Token not found or invalid
        status = 'error';
      }
      
      accounts.push({
        email,
        category: 'personal', // Default category
        description: `Connected via Rebel`,
        status,
      });
    }
    
    return accounts;
  } catch (error) {
    logger.error({ err: error }, 'Failed to get Google accounts from mcpServers');
    return [];
  }
}

/**
 * Register all Google Workspace IPC handlers
 */
export function registerGoogleWorkspaceHandlers(): void {
  registerHandler(
    googleWorkspaceChannels['google-workspace:get-accounts'].channel,
    async (_event: IpcMainInvokeEvent) => {
      // Use mcpServers as the single source of truth (v2 architecture)
      // This ensures account list stays accurate after legacy cleanup
      try {
        const accounts = await getGoogleAccountsFromMcpServers();
        return { accounts };
      } catch (error) {
        logger.error({ err: error }, 'Failed to get Google accounts');
        return { accounts: [] };
      }
    }
  );

  registerHandler(
    googleWorkspaceChannels['google-workspace:start-auth'].channel,
    async (_event: IpcMainInvokeEvent, request?: { targetEmail?: string }) => {
      // No feature flag check here - UI gates whether user can add.
      // If MCP exists, user should be able to auth regardless of flag state.
      try {
        const oauthCredentials = resolveOAuthCredentials(googleCredentialSource);
        if (!oauthCredentials) {
          const guidance = describeMissingOAuthCredentials('google');
          return {
            success: false,
            error: guidance.message,
            setupGuidance: guidance,
          };
        }

        // Run OAuth flow - credentials written to shared staging dir.
        // [GPT-F2] `targetEmail` scopes a per-account RECONNECT: the auth
        // service rejects the OAuth callback when the signed-in account does
        // not match, so the Reconnect CTA cannot silently re-auth the wrong
        // account. Omitted for plain "add account" flows.
        const email = await startGoogleAuth(oauthCredentials.clientId, oauthCredentials.clientSecret, {
          targetEmail: request?.targetEmail,
        });
        
        // Generate instance ID for this account
        const instanceId = generateInstanceId('GoogleWorkspace', email);
        const sharedDir = getSharedConfigDir();
        const instanceDir = path.join(sharedDir, instanceId);
        
        // Copy credentials from shared staging dir to instance-specific dir
        // This ensures proper isolation: each MCP instance reads only its own credentials
        await copyCredentialsToInstanceDir(email, sharedDir, instanceDir);
        
        // Build instance config with instance-specific paths
        const instanceConfig: GoogleWorkspaceInstanceConfig = {
          instanceId,
          email,
          description: `${email} - Calendar, Drive, Gmail, Contacts`,
          clientId: oauthCredentials.clientId,
          clientSecret: oauthCredentials.clientSecret,
          // Use instance-specific paths for credential isolation
          accountsPath: path.join(instanceDir, 'accounts.json'),
          credentialsPath: path.join(instanceDir, 'credentials'),
        };
        
        // Create MCP server entry for this instance
        // mcpServers is the single source of truth (no separate ConnectorInstance metadata)
        const configPath = getMcpConfigPath();
        const payload = buildGoogleWorkspaceInstancePayload(instanceConfig);
        await upsertMcpServerEntry(configPath, payload);
        
        logger.info({ instanceId, email, instanceDir }, 'Created Google Workspace instance with isolated credentials');

        // Connect/reconnect success: clear any persisted OAuth needs-reconnect
        // latch for this instance immediately (Stage 2,
        // 260611_calendar-cache-attention) instead of waiting up to 15 min for
        // the valid-token-path recordSuccess backstop. Reconnect reuses the
        // same deterministic instanceId, so this targets the right slug. Only
        // reachable on auth SUCCESS — a failed start-auth returns via the
        // catch below and must NOT green the panel [RS-F10].
        const latchCleared = clearOAuthRefreshFailureForSlug(instanceId);
        if (!latchCleared) {
          // Privacy: never log the instanceId (slugified email) — provider only.
          logger.warn(
            { provider: 'GoogleWorkspace' },
            'Failed to clear OAuth refresh latch after Google Workspace connect (will self-heal on next successful sync)',
          );
        }

        // Clean up legacy generic "GoogleWorkspace" entry if it exists
        // This prevents routing confusion between generic and instance-based entries
        const cleanedUp = await cleanupLegacyGoogleWorkspaceEntry(configPath);
        if (cleanedUp) {
          logger.info('Cleaned up legacy GoogleWorkspace entry during auth flow');
        }
        
        // Hot-reload Super-MCP to pick up the new instance immediately
        // This also invalidates caches and refreshes tool index.
        // Resolve-on-deferral, NOT Detached (merge synthesis of the
        // 260610_weekly-recs-drain API split with the
        // 260610_gworkspace-mcp-error-disconnect-hang connect-leg design):
        // the idle path still awaits the executed restart, preserving
        // "connect succeeded => tools usable" for the post-connect setup chat;
        // only the deferred path resolves promptly ({ queued: true }) instead
        // of pinning the connect IPC for up to 30 min. Context must stay
        // byte-identical (renderer deferred-op exact-match + launchRebel gate).
        try {
          const { queued } = await reconfigureSuperMcpWithCacheRefreshResolvingOnDeferral(configPath, { context: MCP_RESTART_CONTEXT_GOOGLE_WORKSPACE_CONNECT });
          logger.info({ instanceId, queued }, 'Super-MCP reconfigure requested after Google Workspace connect');
        } catch (reconfigError) {
          // Non-fatal: instance is created, just needs app restart to be available
          logger.warn({ err: reconfigError, instanceId }, 'Failed to hot-reload Super-MCP (restart may be needed)');
        }
        
        return { success: true, email };
      } catch (error) {
        logger.error({ err: error }, 'Failed to start Google OAuth');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'OAuth failed',
        };
      }
    }
  );

  // Handler gating policy for Google Workspace:
  // - get-accounts: Always works (read-only, needed for UI display)
  // - start-auth: Blocked when disabled (prevents new account creation)
  // - remove-account: Always works (allows cleanup of orphaned accounts)
  // - cancel-auth: Always works (cleanup operation)
  registerHandler(
    googleWorkspaceChannels['google-workspace:remove-account'].channel,
    async (_event: IpcMainInvokeEvent, request: { email: string }) => {
      try {
        const { email } = request;
        
        // Generate instance ID for this account
        const instanceId = generateInstanceId('GoogleWorkspace', email);
        
        // Get paths for cleanup
        const configPath = getMcpConfigPath();
        const sharedDir = getSharedConfigDir();
        const instanceDir = path.join(sharedDir, instanceId);
        
        // 1. Load token BEFORE any deletion (required for revocation)
        // Try instance directory first (v2 architecture), then shared dir (legacy)
        const instanceTokenPath = path.join(instanceDir, 'credentials', `${sanitizeEmail(email)}.token.json`);
        const sharedTokenPath = path.join(sharedDir, 'credentials', `${sanitizeEmail(email)}.token.json`);
        
        let tokenData = null;
        try {
          // Try instance dir first (v2 architecture)
          const data = await fs.readFile(instanceTokenPath, 'utf-8');
          tokenData = JSON.parse(data);
          logger.debug({ email }, 'Loaded token from instance directory for revocation');
        } catch {
          // Fall back to shared dir (legacy)
          try {
            const data = await fs.readFile(sharedTokenPath, 'utf-8');
            tokenData = JSON.parse(data);
            logger.debug({ email }, 'Loaded token from shared directory for revocation');
          } catch {
            logger.debug({ email }, 'No token found for revocation (may already be removed)');
          }
        }
        
        // 2. Best-effort revocation - fire and forget BEFORE deleting files
        if (tokenData) {
          fireAndForget(revokeGoogleToken(tokenData), 'googleWorkspaceHandlers.revokeGoogleToken');
        }
        
        // 3. Remove MCP server with full cleanup
        // (removes config entry, tool stats, refreshes caches and Super-MCP)
        await removeMcpServerWithCleanup(configPath, instanceId);
        logger.info({ instanceId, email }, 'Removed Google Workspace MCP instance with cleanup');
        
        // 4. Delete instance directory recursively (idempotent - force: true ignores missing)
        try {
          await fs.rm(instanceDir, { recursive: true, force: true });
          logger.info({ instanceDir, email }, 'Deleted Google Workspace instance directory');
        } catch (rmError) {
          // Log but don't fail - directory might already be gone
          logger.warn({ err: rmError, instanceDir }, 'Failed to delete instance directory (may not exist)');
        }
        
        // 5. Best-effort cleanup of shared staging dir (removeGoogleAccount handles accounts.json)
        try {
          await removeGoogleAccount(email);
          logger.debug({ email }, 'Cleaned up shared staging directory');
        } catch (cleanupError) {
          // Non-fatal: main cleanup (MCP entry + instance dir) already done
          logger.debug({ err: cleanupError, email }, 'Shared staging cleanup skipped (may not exist)');
        }
        
        return { success: true };
      } catch (error) {
        logger.error({ err: error }, 'Failed to remove Google account');
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Removal failed',
        };
      }
    }
  );

  registerHandler(
    googleWorkspaceChannels['google-workspace:cancel-auth'].channel,
    async (_event: IpcMainInvokeEvent) => {
      cancelGoogleAuth();
    }
  );
}
