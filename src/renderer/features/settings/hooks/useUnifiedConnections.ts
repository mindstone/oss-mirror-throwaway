import { useMemo } from 'react';
import type {
  McpServerPreview,
  McpConfigSummary,
  ConnectorCatalog,
  ConnectorCatalogEntry,
  ConnectorProvider,
  AppSettings,
} from '@shared/types';
import { isBundledLikeProvider } from '@shared/types';
import { formatConnectorDisplayName } from '@shared/utils/formatConnectorDisplayName';
import {
  isConnectorSupportedOnPlatform,
  type ConnectorPlatform,
} from '@shared/utils/connectorPlatformSupport';
import catalogData from '../../../../../resources/connector-catalog.json';
import { CONNECTOR_CATEGORY_ORDER, CATEGORY_LABELS, type CategoryFilterId } from '../constants/connectorCategories';

/**
 * Best-effort read of the host OS platform from the preload bridge. Kept in
 * module scope so every `computeUnifiedConnectionsSnapshot` call picks up the
 * same value without paying a property lookup per connector.
 */
function detectCurrentPlatform(): ConnectorPlatform | null {
  if (typeof window === 'undefined') return null;
  const raw = window.electronEnv?.platform;
  if (raw === 'darwin' || raw === 'win32' || raw === 'linux') return raw;
  return null;
}

// Re-export for backward compatibility
export type { CategoryFilterId } from '../constants/connectorCategories';

const catalog = (catalogData as ConnectorCatalog) ?? { version: 1, connectors: [] };

/**
 * Check if a connector is enabled based on its settingsKey.
 * settingsKey is a dot-notation path like "googleWorkspace.enabled"
 * Returns true if:
 * - No settingsKey is defined (no feature flag)
 * - Setting path doesn't exist (feature flag not configured)
 * - Setting value is explicitly true
 * Returns false only if setting is explicitly false.
 */
const isConnectorEnabled = (entry: ConnectorCatalogEntry, settings?: AppSettings): boolean => {
  const settingsKey = entry.bundledConfig?.settingsKey;
  if (!settingsKey || !settings) return true;
  
  // Parse dot notation (e.g., "googleWorkspace.enabled")
  const parts = settingsKey.split('.');
  let value: unknown = settings;
  for (const part of parts) {
    if (value && typeof value === 'object' && part in value) {
      value = (value as Record<string, unknown>)[part];
    } else {
      return true; // Path doesn't exist, no active feature flag
    }
  }
  // Only hide if explicitly set to false
  return value !== false;
};

export type ConnectionStatus = 'connected' | 'needs-setup' | 'available' | 'error';

/** Instance info for multi-account connectors (email or workspace identity) */
export interface ConnectionInstance {
  serverName: string;
  /** Display label - email address or workspace name depending on accountIdentity */
  label: string;
  health?: 'ok' | 'error' | 'unavailable';
  /** Whether this instance is disabled (tools not available but config preserved) */
  disabled?: boolean;
  /** True when the connector expects identity metadata but the legacy entry is missing it */
  missingIdentity?: boolean;
  /**
   * This account's sign-in expired and the user must reconnect (persisted
   * OAuth needs-reconnect latch, overlaid onto `McpServerPreview` by the main
   * process). Distinct from `health === 'error'` ("server broken"): this is
   * routine and user-fixable via the per-account Reconnect affordance.
   */
  needsReconnect?: boolean;
}

export interface UnifiedConnection {
  id: string;
  name: string;
  description: string;
  icon: string;
  status: ConnectionStatus;
  provider: ConnectorProvider;
  catalogEntry?: ConnectorCatalogEntry;
  serverPreview?: McpServerPreview;
  health?: 'ok' | 'error' | 'unavailable';
  toolCount?: number | null;
  popular?: boolean;
  /** For multi-instance connectors: array of connected instances */
  instances?: ConnectionInstance[];
}

export type ConnectionAttentionState = 'healthy' | 'needs-attention' | 'inactive';

/**
 * Detect if a server is bundled by checking if its script path is in /resources/mcp/ or /resources/mcp-generated/
 * This is fully automatic - no hardcoded names needed.
 */
const isBundledServer = (server: McpServerPreview): boolean => {
  /**
   * Check if a path string contains a bundled MCP resource path.
   * Matches both:
   * - /resources/mcp/ and \resources\mcp\ (hand-written MCPs)
   * - /resources/mcp-generated/ and \resources\mcp-generated\ (generated bundles)
   */
  const containsBundledPath = (pathStr: string): boolean => {
    const lower = pathStr.toLowerCase();
    return (
      lower.includes('/resources/mcp/') ||
      lower.includes('\\resources\\mcp\\') ||
      lower.includes('/resources/mcp-generated/') ||
      lower.includes('\\resources\\mcp-generated\\')
    );
  };

  // Check args for bundled resource paths
  for (const arg of server.args ?? []) {
    if (typeof arg === 'string' && containsBundledPath(arg)) {
      return true;
    }
  }
  // Check command itself (for npx-style bundled servers)
  if (server.command && containsBundledPath(server.command)) {
    return true;
  }
  return false;
};

/**
 * Infer provider type from server properties. Fully automatic detection:
 * - bundled: script path contains /resources/mcp/ (ships with app)
 * - direct: HTTP transport with external URL (official MCP servers)
 * - community: everything else (user-added stdio servers)
 */
const inferProvider = (server: McpServerPreview): ConnectorProvider => {
  if (isBundledServer(server)) return 'bundled';
  if (server.transport === 'http' || server.url) return 'direct';
  return 'community';
};

const getStatusFromHealth = (health?: 'ok' | 'error' | 'unavailable'): ConnectionStatus => {
  if (!health) return 'connected';
  if (health === 'ok') return 'connected';
  if (health === 'error') return 'error';
  return 'needs-setup';
};

/**
 * Normalize a string for fuzzy ID matching.
 * Converts to lowercase and removes hyphens, underscores, and spaces.
 * Matches the normalization in connectorCatalogService.ts.
 */
const normalizeId = (s: string): string => s.toLowerCase().replace(/[-_\s]/g, '');

/**
 * Shared connector search predicate.
 * Both Settings (UnifiedConnectionsPanel) and Onboarding (ToolAuthStep) must use this
 * so search results stay consistent across surfaces. Do not duplicate this logic.
 */
export function matchesConnectorSearch(
  connection: { name: string; description: string },
  query: string,
): boolean {
  const q = query.toLowerCase();
  return connection.name.toLowerCase().includes(q) || connection.description.toLowerCase().includes(q);
}

/** Sort order for connections */
export type ConnectionSortBy = 'alphabetical' | 'recent';

export interface CategoryTab {
  id: CategoryFilterId;
  label: string;
  count: number;
}

export interface UseUnifiedConnectionsOptions {
  servers: McpServerPreview[];
  settings?: AppSettings;
  includeAvailable?: boolean;
  filterProvider?: ConnectorProvider;
  searchQuery?: string;
  /** Filter connections by category */
  categoryFilter?: CategoryFilterId;
  /** Sort order for connections. Default: 'alphabetical' */
  sortBy?: ConnectionSortBy;
  /**
   * Number of browser extensions currently paired with the local App Bridge.
   * When provided (and `> 0`) or when the bridge's MCP health is anything
   * other than `'ok'`, the `bundled-app-bridge` connector inherits the
   * normal health-derived status. When `appBridgePairedCount === 0` AND
   * the bridge is healthy, the connector flips to `'available'` so the
   * card moves into the marketplace pool and the standard
   * "Set up with Rebel" CTA renders from the `!isConnected` branch of
   * `ExpandedConnectionCard` (`isConnected === (status !== 'available')`).
   *
   * `null` / omitted means "don't override" — the connector keeps its
   * health-derived status (back-compat for callers that don't wire this).
   * Callers that surface Rebel Browser to users (e.g. Settings) should
   * always pass this; callers that don't surface it (e.g. onboarding's
   * `ToolAuthStep`, whose provider list does not include
   * `bundled-app-bridge`) may omit.
   *
   * See `useAppBridgePairedCount` for the producing hook and
   * `UnifiedConnectionsPanel.handleDisconnect` for why this exists
   * (revoking pair tokens does NOT change `server.health`).
   */
  appBridgePairedCount?: number | null;
  /**
   * Host OS platform for filtering platform-gated connectors out of the
   * "Available" list. Defaults to `window.electronEnv.platform`; tests can
   * override to exercise other platforms deterministically.
   */
  currentPlatform?: ConnectorPlatform | null;
}

export type UnifiedConnectionsSnapshot = {
  connections: UnifiedConnection[];
  connectedCount: number;
  disabledCount: number;
  availableCount: number;
  categoryTabs: CategoryTab[];
  /** After provider/search sort, before category filtering — for cheap config-only signals. */
  rawBeforeCategoryAccount: UnifiedConnection[];
};

/**
 * Check if a connection is fully disabled (no active instances).
 * For multi-instance connectors, all instances must be disabled.
 * For single-instance, checks the serverPreview.disabled flag.
 */
/**
 * Same server list shape as ToolsTab / UnifiedConnectionsPanel (editable + router upstream).
 * Use for sidebar attention counts and any other UI that must match the connectors panel universe.
 */
export function getMcpServersForConnectorsView(
  mcpSummary: McpConfigSummary | null | undefined,
): McpServerPreview[] {
  if (!mcpSummary) return [];
  const editable = mcpSummary.editableServers ?? mcpSummary.servers ?? [];
  const upstream = mcpSummary.router?.upstreamServers ?? [];
  return [...editable, ...upstream];
}

export function isConnectionFullyDisabled(connection: UnifiedConnection): boolean {
  if (connection.instances && connection.instances.length > 0) {
    return connection.instances.every(i => i.disabled === true);
  }
  return connection.serverPreview?.disabled === true;
}

export function getConnectionAttentionState(connection: UnifiedConnection): ConnectionAttentionState {
  if (isConnectionFullyDisabled(connection)) {
    return 'inactive';
  }

  const hasInstanceAttention = connection.instances?.some(
    (instance) =>
      instance.health === 'error' ||
      instance.health === 'unavailable' ||
      instance.missingIdentity ||
      instance.needsReconnect
  ) ?? false;

  if (hasInstanceAttention || connection.status === 'error' || connection.status === 'needs-setup') {
    return 'needs-attention';
  }

  return 'healthy';
}

/**
 * Pure unified connection list + tabs. Shared by `useUnifiedConnections` and attention counting.
 */
export function computeUnifiedConnectionsSnapshot({
  servers,
  settings,
  includeAvailable = true,
  filterProvider,
  searchQuery,
  categoryFilter = 'all',
  sortBy = 'alphabetical',
  appBridgePairedCount = null,
  currentPlatform,
}: UseUnifiedConnectionsOptions): UnifiedConnectionsSnapshot {
    const connections: UnifiedConnection[] = [];
    const connectedIds = new Set<string>();
    const connectors = catalog?.connectors ?? [];
    const hostPlatform = currentPlatform === undefined ? detectCurrentPlatform() : currentPlatform;

    // Group multi-instance servers by catalogId for email-based connectors
    // Key: catalogId, Value: array of instances
    const instancesByCatalogId = new Map<string, { server: McpServerPreview; catalogEntry: ConnectorCatalogEntry }[]>();

    // First pass: match servers to catalog entries and group multi-instance connectors
    for (const server of servers) {
      const provider = inferProvider(server);
      
      // Find matching catalog entry. Priority order:
      // 1. Explicit catalogId (most reliable - set during server creation)
      // 2. Exact match on bundled serverName (legacy servers)
      // 3. Normalized ID fallback
      const isBundled = isBundledLikeProvider(provider);
      
      // Step 1: Match by explicit catalogId (preferred - handles instance naming like Fathom-greg-work-com)
      let catalogEntry = server.catalogId
        ? connectors.find((c) => c.id === server.catalogId)
        : undefined;
      
      // Step 2: Exact match on bundled server names (legacy servers without catalogId)
      // We do NOT match on display name (c.name) to prevent custom servers from
      // hijacking catalog entries. This aligns with connectorCatalogService.ts.
      if (!catalogEntry) {
        catalogEntry = connectors.find((c) => {
          if (isBundled && isBundledLikeProvider(c.provider) && c.bundledConfig?.serverName === server.name) {
            return true;
          }
          return false;
        });
      }
      
      // Step 3: Normalized ID fallback (matches connectorCatalogService.ts strategy)
      if (!catalogEntry) {
        const normalizedServerName = normalizeId(server.name);
        catalogEntry = connectors.find((c) => normalizeId(c.id) === normalizedServerName);
      }
      
      // Step 4: Prefix match for community MCPs (e.g., "browser" matches "browser-mcp")
      // Only for non-bundled servers to avoid false positives
      if (!catalogEntry && !isBundled) {
        const normalizedServerName = normalizeId(server.name);
        catalogEntry = connectors.find((c) => {
          const normalizedCatalogId = normalizeId(c.id);
          // Server name must be a prefix of catalog ID (not the other way around)
          return normalizedCatalogId.startsWith(normalizedServerName) && 
                 normalizedServerName.length >= 3; // Minimum 3 chars to avoid false matches
        });
      }

      // For multi-instance connectors (email or workspace based), group instances by catalogId
      // Also handle servers that match a multi-instance catalog but are missing identity
      // (stale entries) - these are included in the group with a fallback label
      const accountIdentity = catalogEntry?.accountIdentity;
      const _identityValue = accountIdentity === 'email' ? server.email 
        : accountIdentity === 'workspace' ? server.workspace 
        : null;
      
      // Group if: has identity value, OR catalog expects identity but server is missing it
      // The latter case catches stale entries that need cleanup
      const shouldGroup = accountIdentity && (accountIdentity === 'email' || accountIdentity === 'workspace');
      if (shouldGroup && catalogEntry) {
        const existing = instancesByCatalogId.get(catalogEntry.id) ?? [];
        existing.push({ server, catalogEntry });
        instancesByCatalogId.set(catalogEntry.id, existing);
        continue; // Will be added as grouped connection below
      }

      // ID must be unique per instance. For catalog-matched servers, combine catalogId with
      // server name to handle multiple instances (e.g., two Fathom accounts).
      // Format: "catalog:bundled-fathom::Fathom-greg-work-com" or "server::CustomMcp"
      //
      // Rebel Browser override: the backing internal MCP server `RebelAppBridge`
      // is always running (and therefore `server.health === 'ok'`), so the
      // default health-derived status would leave the card stuck at "connected"
      // even after the user has revoked all paired browser extensions. When
      // a caller passes `appBridgePairedCount === 0` AND the bridge itself is
      // healthy, we flip the card to `'available'` so the connector moves to
      // the marketplace/available pool and the Install CTA becomes reachable
      // again. `'available'` (not `'needs-setup'`) is intentional: the
      // card's Install button lives in the `!isConnected` branch, and
      // `isConnected = status !== 'available'`.
      //
      // Health precedence: when `server.health === 'error'` we deliberately
      // do NOT flip to `'available'` because the bridge itself being broken
      // is a different failure mode than "user unpaired their browser", and
      // silently routing to Install would hide the real fault.
      //
      // `null`/omitted `appBridgePairedCount` means "no override" (preserves
      // back-compat for callers that don't wire the count — notably anywhere
      // outside the Settings panel).
      const isAppBridgeEntry = catalogEntry?.id === 'bundled-app-bridge';
      const bridgeHealthStatus = getStatusFromHealth(server.health);
      const appBridgeShouldBeAvailable =
        isAppBridgeEntry &&
        appBridgePairedCount !== null &&
        appBridgePairedCount !== undefined &&
        appBridgePairedCount <= 0 &&
        bridgeHealthStatus === 'connected'; // Only flip when the bridge is healthy
      const resolvedStatus: ConnectionStatus = appBridgeShouldBeAvailable
        ? 'available'
        : bridgeHealthStatus;
      const connection: UnifiedConnection = {
        id: catalogEntry ? `catalog:${catalogEntry.id}::${server.name}` : `server::${server.name}`,
        name: catalogEntry?.name || formatConnectorDisplayName(server.name),
        description: catalogEntry?.description || server.description || 'Custom MCP server',
        icon: catalogEntry?.icon || 'plug',
        status: resolvedStatus,
        provider: catalogEntry?.provider || provider,
        catalogEntry,
        serverPreview: server,
        health: server.health,
        toolCount: server.toolCount,
        popular: catalogEntry?.popular,
      };

      if (catalogEntry) {
        // Always mark the catalog entry as already-handled, even for the
        // Rebel Browser 'available' override, so the marketplace pass
        // later in this function doesn't create a duplicate card from
        // the catalog alone. The server-based connection we just built
        // is already in `connections[]` and (when flipped) correctly
        // reports status='available' — that's what puts it in the
        // Available section with the Install CTA.
        connectedIds.add(catalogEntry.id);
      }

      connections.push(connection);
    }

    // Second pass: create grouped connections for multi-instance email-based connectors
    for (const [catalogId, instanceList] of instancesByCatalogId) {
      const firstInstance = instanceList[0];
      const catalogEntry = firstInstance.catalogEntry;
      const isWorkspaceBased = catalogEntry.accountIdentity === 'workspace';
      
      // Build instances array sorted by label (email or workspace name)
      // Handle servers missing identity (stale entries) with fallback label
      const instances: ConnectionInstance[] = instanceList
        .map(({ server }) => {
          const identityLabel = isWorkspaceBased ? server.workspace : server.email;
          return {
            serverName: server.name,
            label: identityLabel || server.name, // Fallback to server name for stale entries
            health: server.health,
            disabled: server.disabled,
            missingIdentity: !identityLabel,
            needsReconnect: server.needsReconnect,
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label));
      
      // Use first server for preview (pick healthiest one)
      const healthyInstance = instanceList.find(i => i.server.health === 'ok') ?? firstInstance;
      
      // Aggregate tool count from all instances
      const totalToolCount = instanceList.reduce((sum, i) => {
        return sum + (i.server.toolCount ?? 0);
      }, 0);
      
      // Overall health: ok if any ok, error if all error, unavailable if any unavailable, else undefined (unknown)
      // When health is undefined (not yet fetched), we treat it as "connected" to avoid false warnings
      const hasOk = instanceList.some(i => i.server.health === 'ok');
      const allError = instanceList.length > 0 && instanceList.every(i => i.server.health === 'error');
      const hasUnavailable = instanceList.some(i => i.server.health === 'unavailable');
      const overallHealth: 'ok' | 'error' | 'unavailable' | undefined = 
        hasOk ? 'ok' : 
        allError ? 'error' : 
        hasUnavailable ? 'unavailable' : 
        undefined; // Unknown/not fetched - will show as connected

      const connection: UnifiedConnection = {
        id: `catalog:${catalogId}`,
        name: catalogEntry.name,
        description: catalogEntry.description,
        icon: catalogEntry.icon,
        status: getStatusFromHealth(overallHealth),
        provider: catalogEntry.provider,
        catalogEntry,
        serverPreview: healthyInstance.server,
        health: overallHealth,
        toolCount: totalToolCount > 0 ? totalToolCount : null,
        popular: catalogEntry.popular,
        instances,
      };

      connections.push(connection);
      // Add to connectedIds to remove duplicate "available" card
      connectedIds.add(catalogEntry.id);
    }

    // Then add available (not connected) from catalog
    if (includeAvailable) {
      for (const entry of connectors) {
        if (connectedIds.has(entry.id)) continue;

        // Skip hidden connectors (temporarily disabled connectors).
        // Stage 9 flipped `bundled-app-bridge` to `hidden: false`, so the
        // previous dev-flag carve-out is gone — any remaining hidden
        // entries are legitimately disabled.
        if (entry.hidden) {
          continue;
        }

        // Skip internal connectors (auto-loaded system MCPs, not user-installable)
        if (entry.isInternal) continue;
        
        // Skip bundled connectors that are gated by a feature flag
        if (isBundledLikeProvider(entry.provider) && !isConnectorEnabled(entry, settings)) continue;

        // Skip connectors that aren't supported on the current host platform.
        // (Connected connections are never filtered so users can disconnect
        //  stale/roaming state; see BaseConnectorEntry['platforms'] in mcp.ts.)
        if (!isConnectorSupportedOnPlatform(entry.platforms, hostPlatform)) continue;

        const connection: UnifiedConnection = {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          icon: entry.icon,
          status: 'available',
          provider: entry.provider,
          catalogEntry: entry,
          popular: entry.popular,
        };

        connections.push(connection);
      }
    }

    // Apply filters
    let filtered = connections;

    if (filterProvider) {
      filtered = filtered.filter((c) => c.provider === filterProvider);
    }

    if (searchQuery) {
      filtered = filtered.filter((c) => matchesConnectorSearch(c, searchQuery));
    }

    // Sort: connected first, then apply user-selected sort
    filtered.sort((a, b) => {
      // Connected always before available
      const aConnected = a.status !== 'available' ? 0 : 1;
      const bConnected = b.status !== 'available' ? 0 : 1;
      if (aConnected !== bConnected) return aConnected - bConnected;

      if (sortBy === 'recent') {
        // Sort by lastConnectedAt descending (undefined treated as -Infinity, sorts last)
        const aTime = a.serverPreview?.lastConnectedAt ?? -Infinity;
        const bTime = b.serverPreview?.lastConnectedAt ?? -Infinity;
        if (aTime !== bTime) return bTime - aTime; // Descending (newest first)
        // Tie-breaker: alphabetical
        return a.name.localeCompare(b.name);
      }

      // Default (alphabetical): popular first, then name
      const aPopular = a.popular ? 0 : 1;
      const bPopular = b.popular ? 0 : 1;
      if (aPopular !== bPopular) return aPopular - bPopular;

      return a.name.localeCompare(b.name);
    });

    const rawBeforeCategoryAccount = [...filtered];

    // Build category tabs from all connections (both connected and available)
    const categoryCounts = new Map<CategoryFilterId, number>();
    categoryCounts.set('all', connections.length);
    
    for (const conn of connections) {
      const category = (conn.catalogEntry?.category || 'other') as CategoryFilterId;
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    }
    
    // Build category tabs using shared constants (only include categories that have connections)
    const categoryTabs: CategoryTab[] = [
      { id: 'all', label: CATEGORY_LABELS.all, count: categoryCounts.get('all') ?? 0 },
    ];
    
    for (const cat of CONNECTOR_CATEGORY_ORDER) {
      const count = categoryCounts.get(cat);
      if (count && count > 0) {
        categoryTabs.push({ id: cat, label: CATEGORY_LABELS[cat], count });
      }
    }
    
    // Apply category filter
    if (categoryFilter !== 'all') {
      filtered = filtered.filter((c) => {
        const category = c.catalogEntry?.category || 'other';
        return category === categoryFilter;
      });
    }

    const allConnected = connections.filter((c) => c.status !== 'available');
    const disabledCount = allConnected.filter(isConnectionFullyDisabled).length;
    const connectedCount = allConnected.length - disabledCount;
    const availableCount = connections.filter((c) => c.status === 'available').length;

    return {
      connections: filtered,
      connectedCount,
      disabledCount,
      availableCount,
      categoryTabs,
      rawBeforeCategoryAccount,
    };
}

/**
 * Sidebar / rollup count: one per grouped connector card, same attention rules as the Connectors panel,
 * excluding fully inactive (all-disabled) connectors.
 */
export function countConnectorConfigAttentionSignals(
  servers: McpServerPreview[],
  settings?: AppSettings,
): number {
  const { rawBeforeCategoryAccount } = computeUnifiedConnectionsSnapshot({
    servers,
    settings,
    includeAvailable: false,
    categoryFilter: 'all',
    sortBy: 'alphabetical',
  });
  const connected = rawBeforeCategoryAccount.filter((c) => c.status !== 'available');
  let count = 0;
  for (const c of connected) {
    if (getConnectionAttentionState(c) === 'needs-attention') {
      count += 1;
    }
  }
  return count;
}

export function useUnifiedConnections({
  servers,
  settings,
  includeAvailable = true,
  filterProvider,
  searchQuery,
  categoryFilter = 'all',
  sortBy = 'alphabetical',
  appBridgePairedCount = null,
  currentPlatform,
}: UseUnifiedConnectionsOptions): {
  connections: UnifiedConnection[];
  connectedCount: number;
  disabledCount: number;
  availableCount: number;
  /** Category tabs for filtering all connections by category */
  categoryTabs: CategoryTab[];
} {
  return useMemo(() => {
    const snap = computeUnifiedConnectionsSnapshot({
      servers,
      settings,
      includeAvailable,
      filterProvider,
      searchQuery,
      categoryFilter,
      sortBy,
      appBridgePairedCount,
      currentPlatform,
    });
    const { rawBeforeCategoryAccount, ...rest } = snap;
    void rawBeforeCategoryAccount;
    return rest;
  }, [servers, settings, includeAvailable, filterProvider, searchQuery, categoryFilter, sortBy, appBridgePairedCount, currentPlatform]);
}
