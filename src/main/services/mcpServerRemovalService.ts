/**
 * MCP Server Removal Service
 *
 * Centralized service for removing MCP servers with full cleanup.
 * All MCP removal paths should use this service to ensure consistent cleanup:
 * - Remove MCP server entry from config
 * - Remove tool usage statistics (prevents ghost tools in Frequent Tools)
 * - Invalidate connected packages cache
 * - Refresh semantic tool index
 * - Reconfigure Super-MCP
 * - Clean up OAuth credentials (revoke tokens, delete local files)
 *
 * This service exists separately from mcpConfigManager to:
 * 1. Avoid circular imports (needs toolUsageStore, mcpService, etc.)
 * 2. Keep mcpConfigManager focused on config file CRUD
 * 3. Provide a single source of truth for removal + cleanup logic
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { configure as configureCloudClient, request as cloudRequest } from '@rebel/cloud-client/cloudClient';
import { hashTeamId } from '@shared/utils/teamIdHash';
import { buildMcpServerRemovalRestartContext } from '@shared/utils/mcpRestartContexts';
import { getSuperMcpOAuthTokensDir } from '../utils/testIsolation';
import { removeMcpServerEntry, getMcpServerEntry } from './mcpConfigManager';
import { clearForSlug as clearOAuthRefreshFailureForSlug, extractProviderBaseName } from './oauthRefreshFailureStore';
import { removeToolsForServer } from './toolUsageStore';
import { getSettings, updateSettings } from '../settingsStore';
import { reconfigureSuperMcpWithCacheRefreshAndAwaitExecution } from './mcpService';
import { findCatalogEntryById } from './connectorCatalogService';

// Import cleanup functions from auth services
import { removeGoogleAccount } from './googleWorkspaceAuthService';
import { removeSlackWorkspace } from './slackAuthService';
import { removeHubSpotAccount } from './hubspotAuthService';
import { removeSalesforceAccount } from './salesforceAuthService';
import { removeMicrosoftAccount } from './microsoftAuthService';
import { INTERNAL_MCP_SERVER_NAMES } from './bundledMcpManager';

const log = createScopedLogger({ service: 'mcpServerRemoval' });

interface SlackListenerCleanupDeps {
  getSettings: typeof getSettings;
  updateSettings: typeof updateSettings;
  configureCloudClient: typeof configureCloudClient;
  deleteSlackWorkspace: () => Promise<void>;
}

let slackListenerCleanupDepsForTesting: Partial<SlackListenerCleanupDeps> | null = null;

function slackListenerCleanupDeps(): SlackListenerCleanupDeps {
  return {
    getSettings: slackListenerCleanupDepsForTesting?.getSettings ?? getSettings,
    updateSettings: slackListenerCleanupDepsForTesting?.updateSettings ?? updateSettings,
    configureCloudClient: slackListenerCleanupDepsForTesting?.configureCloudClient ?? configureCloudClient,
    deleteSlackWorkspace: slackListenerCleanupDepsForTesting?.deleteSlackWorkspace ?? (async () => {
      await cloudRequest('DELETE', '/api/integrations/slack/workspace');
    }),
  };
}

export function __setSlackListenerCleanupDepsForTesting(overrides: Partial<SlackListenerCleanupDeps> | null): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    slackListenerCleanupDepsForTesting = overrides;
  }
}

export interface RemovalResult {
  backupPath: string | null;
  toolsRemoved: number;
  serverName: string;
}

/**
 * Options for server removal operations.
 */
export interface RemovalOptions {
  /**
   * If true, skip Super-MCP reconfigure and tool index refresh.
   * Useful when removing multiple servers in a batch - caller can do these once at the end.
   */
  skipPostCleanup?: boolean;
}

// =============================================================================
// Credential Cleanup Registry
// =============================================================================

/**
 * Cleanup handler for OAuth credentials.
 * Called with server name and the account identifier (email or workspace ID).
 * Best-effort: should not throw - log errors and continue.
 */
type CredentialCleanupHandler = (accountIdentifier: string) => Promise<void>;

/**
 * Registry mapping catalogId to credential cleanup function.
 * Each handler is responsible for:
 * - Revoking OAuth tokens with the provider (best-effort)
 * - Deleting local credential/token files
 * 
 * Handlers are called AFTER config deletion with the email/workspace from the deleted entry.
 */
const CREDENTIAL_CLEANUP_HANDLERS: Record<string, CredentialCleanupHandler> = {
  'bundled-google': removeGoogleAccount,
  'bundled-slack': removeSlackWorkspace,
  'bundled-hubspot': removeHubSpotAccount,
  'bundled-salesforce': removeSalesforceAccount,
  // Microsoft uses email as identifier. Note: can only delete locally, no API revocation.
  'bundled-microsoft-mail': removeMicrosoftAccount,
  'bundled-microsoft-calendar': removeMicrosoftAccount,
  'bundled-microsoft-files': removeMicrosoftAccount,
  'bundled-microsoft-teams': removeMicrosoftAccount,
  'bundled-microsoft-sharepoint': removeMicrosoftAccount,
};

/**
 * Check if a catalogId corresponds to a direct OAuth connector.
 * Direct OAuth connectors have provider='direct' and mcpConfig.oauth=true in the catalog.
 * These store tokens via Super-MCP in ~/.super-mcp/oauth-tokens/.
 */
function isDirectOAuthConnector(catalogId: string): boolean {
  const entry = findCatalogEntryById(catalogId);
  if (!entry) return false;
  return entry.provider === 'direct' && entry.mcpConfig?.oauth === true;
}

function isSlackApiConnector(catalogId: string | undefined): boolean {
  if (!catalogId) return false;
  const entry = findCatalogEntryById(catalogId);
  return entry?.bundledConfig?.authApi === 'slackApi';
}

async function autoStopCloudSlackListenerOnConnectorRemoval(args: {
  catalogId: string | undefined;
  slackTeamId: string | undefined;
}): Promise<void> {
  if (!isSlackApiConnector(args.catalogId) || !args.slackTeamId) {
    return;
  }
  const deps = slackListenerCleanupDeps();
  const settings = deps.getSettings();
  const cloudWorkspace = settings.experimental?.cloudSlackWorkspace;
  if (!cloudWorkspace || cloudWorkspace.teamId !== args.slackTeamId || cloudWorkspace.status === 'disconnected') {
    return;
  }
  const cloudInstance = settings.cloudInstance;
  if (cloudInstance?.mode !== 'cloud' || !cloudInstance.cloudUrl || !cloudInstance.cloudToken) {
    log.warn({
      teamIdHash: hashTeamId(args.slackTeamId),
      source: 'connector-removed',
      reason: 'cloud-not-configured',
    }, 'slack_listener_auto_stop_on_connector_disconnect_failed');
    return;
  }

  try {
    deps.configureCloudClient({ cloudUrl: cloudInstance.cloudUrl, token: cloudInstance.cloudToken });
    await deps.deleteSlackWorkspace();
    deps.updateSettings({
      experimental: {
        ...settings.experimental,
        slackCloudWebhookEnabled: false,
        cloudSlackWorkspace: {
          ...cloudWorkspace,
          status: 'disconnected',
          occurredAt: Date.now(),
        },
      },
    });
    log.info({
      teamIdHash: hashTeamId(args.slackTeamId),
      source: 'connector-removed',
    }, 'slack_listener_auto_stopped_on_connector_disconnect');
  } catch (error) {
    log.warn({
      err: error,
      teamIdHash: hashTeamId(args.slackTeamId),
      source: 'connector-removed',
    }, 'slack_listener_auto_stop_on_connector_disconnect_failed');
  }
}

/**
 * Remove Super-MCP OAuth credentials for a direct OAuth connector.
 * These connectors store tokens in ~/.super-mcp/oauth-tokens/ using the serverName as packageId.
 *
 * @param serverName - The server name which is used as packageId for token storage
 */
async function removeDirectOAuthCredentials(serverName: string): Promise<void> {
  const tokenDir = getSuperMcpOAuthTokensDir();

  // Super-MCP stores two files per packageId:
  // - {packageId}_tokens.json - OAuth tokens
  // - {packageId}_client.json - Client registration info
  const tokenFiles = [
    path.join(tokenDir, `${serverName}_tokens.json`),
    path.join(tokenDir, `${serverName}_client.json`),
  ];

  for (const filePath of tokenFiles) {
    try {
      await fs.unlink(filePath);
      log.info({ serverName, filePath }, 'Removed Super-MCP OAuth credential file');
    } catch (err) {
      // File might not exist (e.g., auth was never completed) - that's fine
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn({ err, serverName, filePath }, 'Failed to remove Super-MCP OAuth credential file');
      }
    }
  }
}

/**
 * Run credential cleanup for a server based on its catalogId.
 * Best-effort: logs errors but doesn't throw.
 *
 * Supports two types of connectors:
 * 1. Bundled connectors with custom cleanup handlers (Google, Slack, etc.)
 * 2. Direct OAuth connectors that use Super-MCP's token storage (Notion, Linear, etc.)
 */
async function runCredentialCleanup(
  catalogId: string | undefined,
  email: string | undefined,
  slackTeamId: string | undefined,
  serverName: string
): Promise<void> {
  if (!catalogId) {
    log.debug({ serverName }, 'No catalogId - skipping credential cleanup');
    return;
  }

  // Check for bundled connector with custom handler
  const handler = CREDENTIAL_CLEANUP_HANDLERS[catalogId];
  if (handler) {
    // Determine the account identifier based on connector type
    // Slack uses teamId (from env.SLACK_TEAM_ID), others use email
    const identifier = catalogId === 'bundled-slack' ? slackTeamId : email;

    if (!identifier) {
      log.debug({ serverName, catalogId }, 'No account identifier - skipping bundled credential cleanup');
    } else {
      try {
        log.info({ serverName, catalogId }, 'Running bundled credential cleanup');
        await handler(identifier);
        log.info({ serverName, catalogId }, 'Bundled credential cleanup completed');
      } catch (err) {
        // Best-effort - log and continue
        log.warn({ err, serverName, catalogId }, 'Bundled credential cleanup failed (non-fatal)');
      }
    }
    return;
  }

  // Check for direct OAuth connector (Notion, Linear, GitHub, etc.)
  // These have provider='direct' and mcpConfig.oauth=true in the catalog
  if (isDirectOAuthConnector(catalogId)) {
    try {
      log.info({ serverName, catalogId }, 'Running direct OAuth credential cleanup');
      await removeDirectOAuthCredentials(serverName);
      log.info({ serverName, catalogId }, 'Direct OAuth credential cleanup completed');
    } catch (err) {
      // Best-effort - log and continue
      log.warn({ err, serverName, catalogId }, 'Direct OAuth credential cleanup failed (non-fatal)');
    }
    return;
  }

  log.debug({ serverName, catalogId }, 'No credential cleanup handler for catalogId');
}

/**
 * Remove a single MCP server with full cleanup.
 *
 * Cleanup sequence:
 * 0. Read server config BEFORE deletion (to get catalogId, email/workspace for cleanup)
 * 1. Remove MCP server entry from config
 *    1b. Clear the persisted OAuth needs-reconnect latch for this server
 * 2. Remove tool usage stats for this package
 * 3. Run credential cleanup (revoke tokens, delete local files)
 * 4. Invalidate connected packages cache
 * 5. Reconfigure Super-MCP (best-effort, non-blocking: fire-and-forget — the
 *    restart can be deferred up to 30 min while agent turns drain, and the
 *    returned promise must not block on it; see comment at the call site)
 * 6. Refresh semantic tool index (best-effort, non-blocking)
 *
 * This function is idempotent - safe to call even if server already removed.
 *
 * @param configPath - Path to the MCP config file
 * @param serverName - Name/ID of the server to remove (e.g., "Slack-mindstone")
 * @param options - Optional settings for the removal operation
 * @returns Result with backup path and tools removed count
 */
export const removeMcpServerWithCleanup = async (
  configPath: string,
  serverName: string,
  options: RemovalOptions = {}
): Promise<RemovalResult> => {
  const { skipPostCleanup = false } = options;

  // Guard: Prevent removal of internal MCP servers (auto-loaded system components)
  if (INTERNAL_MCP_SERVER_NAMES.includes(serverName as typeof INTERNAL_MCP_SERVER_NAMES[number])) {
    log.warn({ serverName }, 'Attempted to remove internal MCP server - blocked');
    throw new Error(`Cannot remove internal MCP server: ${serverName}. Internal servers are required for Rebel to function.`);
  }

  log.info({ serverName, configPath }, 'Removing MCP server with cleanup');

  // 0. Read server config BEFORE deletion to get catalogId and account info for cleanup
  // CRITICAL: Must happen before removeMcpServerEntry or we lose this information
  const serverEntry = await getMcpServerEntry(configPath, serverName);
  const { catalogId, email, slackTeamId } = serverEntry ?? {};

  // 1. Remove MCP server entry from config (idempotent)
  const { backupPath } = await removeMcpServerEntry(configPath, serverName);
  log.debug({ serverName, backupPath }, 'MCP server entry removed');

  // 1b. Clear any persisted OAuth needs-reconnect latch for this server
  // (Stage 2, 260611_calendar-cache-attention [RS-F8]). For instance-based
  // connectors the serverName IS the failure-store slug. Synchronous and
  // idempotent; deliberately NOT gated behind the best-effort credential
  // cleanup or the fire-and-forget Super-MCP reconfigure below — the latch
  // describes the config entry just removed and must die with it.
  const latchCleared = clearOAuthRefreshFailureForSlug(serverName);
  if (!latchCleared) {
    // Privacy: never log the slug (slugified email) — provider base name only.
    log.warn(
      { provider: extractProviderBaseName(serverName) },
      'Failed to clear OAuth refresh latch on server removal (latch may linger until the orphan sweep)',
    );
  }

  // 2. Remove tool usage stats for this server (idempotent)
  const toolsRemoved = removeToolsForServer(serverName);
  if (toolsRemoved > 0) {
    log.info({ serverName, toolsRemoved }, 'Removed frequent tools for disconnected server');
  } else {
    log.debug({ serverName }, 'No frequent tools found for package');
  }

  // 3. Run credential cleanup (revoke tokens, delete local files) - best-effort
  await runCredentialCleanup(catalogId, email, slackTeamId, serverName);
  await autoStopCloudSlackListenerOnConnectorRemoval({ catalogId, slackTeamId });

  if (!skipPostCleanup) {
    // Fire-and-forget — deliberately NOT awaited. The Super-MCP restart is
    // deferred (up to 30 min) while agent turns are active; awaiting here pinned
    // the user-facing "Disconnecting…" IPC on that deferral (see
    // docs/plans/260610_gworkspace-mcp-error-disconnect-hang/PLAN.md). All
    // user-visible cleanup (config entry, tokens, accounts) is already complete
    // above. Deliberate behavior change: a restart failure no longer fails the
    // disconnect IPC — it stays observed via this catch plus the manager's own
    // restart-error logging. Pre-existing (unchanged): until the deferred restart
    // fires, the stale router may still expose the removed server's tools, but
    // tokens are already deleted so those calls fail with auth errors.
    // The context string must stay byte-identical: renderer deferred-op matching
    // (UnifiedConnectionsPanel) exact-matches on it.
    // The try/catch future-proofs a synchronous throw before a promise is
    // returned (unreachable while the fn stays async) — the rejection contract
    // above must hold for every failure shape.
    try {
      void reconfigureSuperMcpWithCacheRefreshAndAwaitExecution(configPath, {
        context: buildMcpServerRemovalRestartContext(serverName),
      }).catch((err) => {
        log.warn({ err, serverName, configPath }, 'Super-MCP reconfigure after removal failed (restart may be needed)');
      });
    } catch (err) {
      log.warn({ err, serverName, configPath }, 'Super-MCP reconfigure after removal failed (restart may be needed)');
    }
  }

  log.info({ serverName, toolsRemoved }, 'MCP server removal complete');

  return { backupPath, toolsRemoved, serverName };
};

/**
 * Perform post-cleanup operations after batch server removal.
 *
 * Use this when removing multiple servers with `skipPostCleanup: true`,
 * then call this once at the end.
 *
 * Resolves as soon as the Super-MCP reconfigure has been REQUESTED, not when
 * the restart completes (it can be deferred while agent turns drain) — see
 * the fire-and-forget rationale in removeMcpServerWithCleanup.
 *
 * @param configPath - Path to the MCP config file
 */
export const performPostRemovalCleanup = async (configPath: string): Promise<void> => {
  log.debug({ configPath }, 'Performing post-removal cleanup');
  // Fire-and-forget (same rationale as removeMcpServerWithCleanup): callers'
  // IPC responses must not block on the deferred restart. Context string must
  // stay byte-identical for renderer deferred-op matching. The try/catch
  // future-proofs a synchronous throw before a promise is returned
  // (unreachable while the fn stays async).
  try {
    void reconfigureSuperMcpWithCacheRefreshAndAwaitExecution(configPath, { context: 'mcp-post-removal-cleanup' }).catch((err) => {
      log.warn({ err, configPath }, 'Super-MCP reconfigure after post-removal cleanup failed (restart may be needed)');
    });
  } catch (err) {
    log.warn({ err, configPath }, 'Super-MCP reconfigure after post-removal cleanup failed (restart may be needed)');
  }
};
