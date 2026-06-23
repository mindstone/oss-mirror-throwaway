export const MCP_RESTART_CONTEXT_SETTINGS_UPSERT_PREFIX = 'settings-upsert:';
export const MCP_RESTART_CONTEXT_SERVER_REMOVAL_PREFIX = 'mcp-server-removal:';
export const MCP_RESTART_CONTEXT_SERVER_TOGGLE_PREFIX = 'mcp-server-toggle:';

/**
 * Static contexts for the connect-leg Super-MCP restarts requested by the
 * OAuth connector IPC handlers (Stage 4,
 * docs/plans/260610_gworkspace-mcp-error-disconnect-hang). Values are
 * byte-identical to the historical handler literals: the renderer's
 * deferred-op matching (UnifiedConnectionsPanel) exact-matches broadcast
 * contexts against tracked operations, so any drift silently kills the
 * queued-state UX. Static (no serverId) — exact-match works without touching
 * the matcher.
 */
export const MCP_RESTART_CONTEXT_GOOGLE_WORKSPACE_CONNECT = 'google-workspace-connect';
export const MCP_RESTART_CONTEXT_MICROSOFT_CONNECT = 'microsoft-connect';
export const MCP_RESTART_CONTEXT_MICROSOFT_SHAREPOINT_CONNECT = 'microsoft-sharepoint-connect';
export const MCP_RESTART_CONTEXT_SLACK_CONNECT = 'slack-connect';
export const MCP_RESTART_CONTEXT_DISCOURSE_CONNECT = 'discourse-connect';

const RESOLVE_ON_DEFERRAL_CONNECT_CONTEXTS: ReadonlySet<string> = new Set([
  MCP_RESTART_CONTEXT_GOOGLE_WORKSPACE_CONNECT,
  MCP_RESTART_CONTEXT_MICROSOFT_CONNECT,
  MCP_RESTART_CONTEXT_MICROSOFT_SHAREPOINT_CONNECT,
  MCP_RESTART_CONTEXT_SLACK_CONNECT,
  MCP_RESTART_CONTEXT_DISCOURSE_CONNECT,
]);

/**
 * True for the connect contexts whose IPC resolves on deferral (Stage 4): a
 * tracked op carrying one of these contexts that was marked deferred means
 * "IPC resolved" does NOT imply tool routing applied, so the renderer must
 * skip the post-connect "Set up with Rebel" chat (DA F1 gate, Stage 5).
 * `settings-upsert:*` contexts deliberately return false — that leg AWAITS the
 * executed restart, so by the time its IPC resolves a once-deferred restart
 * has already applied and the setup chat is safe.
 */
export function isResolveOnDeferralConnectContext(context: string): boolean {
  return RESOLVE_ON_DEFERRAL_CONNECT_CONTEXTS.has(context);
}

export function buildSettingsUpsertRestartContext(serverName: string): string {
  return `${MCP_RESTART_CONTEXT_SETTINGS_UPSERT_PREFIX}${serverName}`;
}

export function buildMcpServerRemovalRestartContext(serverName: string): string {
  return `${MCP_RESTART_CONTEXT_SERVER_REMOVAL_PREFIX}${serverName}`;
}

/**
 * Context for the deferred Super-MCP restart requested by
 * `settings:mcp-toggle-server-enabled`. Carries the toggled serverId so the
 * renderer's deferred-op matching (UnifiedConnectionsPanel) can exact-match the
 * broadcast to the toggled card, mirroring the removal-context shape.
 */
export function buildMcpServerToggleRestartContext(serverId: string): string {
  return `${MCP_RESTART_CONTEXT_SERVER_TOGGLE_PREFIX}${serverId}`;
}
