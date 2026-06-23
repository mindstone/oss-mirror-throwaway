import fs from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppSettings, McpServerUpsertPayload, ProviderKeys, ProviderKeyId } from '@shared/types';
import { generateInstanceId, generateWorkspaceInstanceId, parseEmailFromSlug } from '@shared/utils/mcpInstanceUtils';
import { createScopedLogger } from '@core/logger';
import { atomicCredentialWrite } from '@core/utils/atomicCredentialWrite';
import { INTERNAL_ENV_KEYS } from '@core/mcpInternalEnvKeys';
import { getPlatformConfig } from '@core/platform';
import {
  SUPER_MCP_BRIDGE_STATE_ENV_KEYS,
  SUPER_MCP_SPAWN_ENV_KEYS,
} from '@core/rebelCore/superMcpContract';
import {
  getDeepestCommonAncestor,
  getMcpSandboxAncestorRoots,
} from '@core/services/workspace/trustedFilesystemRoots';
import { resolveMcpConfigPath } from './mcpService';
import { upsertMcpServerEntry, upsertMcpServersBatch } from './mcpConfigManager';
import { getSettings } from '@core/services/settingsStore';
import { findCatalogEntryById } from '@core/services/connectorCatalogService';
import { isManagedInstallEntry, resolveManagedInstallsRoot } from './managedMcpInstallService';
import { getManagedInstallsRoot } from './managedMcpInstallServiceInstance';
import { HubSpotAuthError, getStoredScopeTier, type HubSpotScopeTier } from './hubspotAuthService';
import { deriveHubSpotAccountHash, emitHubSpotTelemetry, getTelemetrySaltHex } from './hubspotTelemetry';
import { DEFAULT_ONLY_SANDBOX_ENV_KEYS } from './mcpSandboxEnvKeys';

const log = createScopedLogger({ service: 'bundledMcpManager' });

export type BundledWrapperMetadata = {
  sourcePath: string | null;
  version: number;
};

export interface BundledMcpManagerConfig {
  userDataDir: string;
  resourcesDir: string;
  isPackaged: boolean;
}

const _BUNDLED_SERVER_NAME = 'RebelInbox';
const AUTOMATIONS_SERVER_NAME = 'RebelAutomations';
const DIAGNOSTICS_SERVER_NAME = 'RebelDiagnostics';
const CANVAS_SERVER_NAME = 'RebelCanvas';
const MEETINGS_SERVER_NAME = 'RebelMeetings';
const INTERNAL_SERVER_NAME = 'RebelInternal';
const _GOOGLE_WORKSPACE_BASE_NAME = 'GoogleWorkspace'; // Base name for multi-instance naming
/**
 * Name of the stdio MCP server that relays `rebel_browser_*` tool calls
 * through the always-on App Bridge (Stage 4+). Exported so callers
 * (appBridgeManager, coreStartup, tests) all agree on the single server
 * name the catalog entry, the router config, and Super-MCP use.
 */
export const APP_BRIDGE_SERVER_NAME = 'RebelAppBridge';

// ============================================================
// Multi-Instance Support
// ============================================================

// Re-export from shared utils for backward compatibility
export { generateInstanceId } from '@shared/utils/mcpInstanceUtils';
const MICROSOFT_MAIL_SERVER_NAME = 'Microsoft365Mail';
const MICROSOFT_CALENDAR_SERVER_NAME = 'Microsoft365Calendar';
const MICROSOFT_FILES_SERVER_NAME = 'Microsoft365Files';
const MICROSOFT_TEAMS_SERVER_NAME = 'Microsoft365Teams';
const MICROSOFT_SHAREPOINT_SERVER_NAME = 'Microsoft365SharePoint';
const MICROSOFT_CONFIG_DIR_SEGMENT = 'microsoft-mcp';

// MICROSOFT_REBEL_OSS_DEFS no longer carries `packageSpec` — the connector
// catalog is the sole source of truth for OSS package pins (per
// docs/plans/260525_oss_release_automation.md v2). The `catalogId` mapping
// here is preserved because Microsoft's account-sharing logic uses these
// SERVER_NAME constants as keys to resolve the matching catalog entry; the
// `description` is retained for the per-instance payload description.
const MICROSOFT_REBEL_OSS_DEFS = {
  [MICROSOFT_MAIL_SERVER_NAME]: {
    catalogId: 'bundled-microsoft-mail',
    description: 'Outlook Mail - read, send, search emails',
  },
  [MICROSOFT_CALENDAR_SERVER_NAME]: {
    catalogId: 'bundled-microsoft-calendar',
    description: 'Outlook Calendar - events, scheduling, invites',
  },
  [MICROSOFT_FILES_SERVER_NAME]: {
    catalogId: 'bundled-microsoft-files',
    description: 'OneDrive - files, folders, search, sharing',
  },
  [MICROSOFT_TEAMS_SERVER_NAME]: {
    catalogId: 'bundled-microsoft-teams',
    description: 'Teams - chats, messages, presence',
  },
  [MICROSOFT_SHAREPOINT_SERVER_NAME]: {
    catalogId: 'bundled-microsoft-sharepoint',
    description: 'SharePoint - sites, document libraries, files',
  },
} as const;

const MICROSOFT_CATALOG_SERVER_BY_ID: Record<string, keyof typeof MICROSOFT_REBEL_OSS_DEFS> = {
  'bundled-microsoft-mail': MICROSOFT_MAIL_SERVER_NAME,
  'bundled-microsoft-calendar': MICROSOFT_CALENDAR_SERVER_NAME,
  'bundled-microsoft-files': MICROSOFT_FILES_SERVER_NAME,
  'bundled-microsoft-teams': MICROSOFT_TEAMS_SERVER_NAME,
  'bundled-microsoft-sharepoint': MICROSOFT_SHAREPOINT_SERVER_NAME,
};

let managerConfig: BundledMcpManagerConfig | null = null;

const requireConfig = (): BundledMcpManagerConfig => {
  if (!managerConfig) {
    throw new Error('Bundled MCP manager not configured');
  }
  return managerConfig;
};

const readJson = async (filePath: string): Promise<unknown> => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const ensureDirectory = async (targetFile: string): Promise<void> => {
  await fs.mkdir(path.dirname(targetFile), { recursive: true });
};

// ============================================================
// Path Resolution Helpers
// ============================================================

/**
 * Resolve path to a generated MCP server script (from mcp-generated/).
 * Generated MCPs are built from TypeScript via build-bundled-mcps.js.
 */
const resolveGeneratedMcpScript = (mcpName: string): string => {
  const config = requireConfig();
  const base = config.isPackaged ? config.resourcesDir : path.resolve(config.resourcesDir);
  return path.join(base, 'mcp-generated', mcpName, 'server.cjs');
};

export const resolveGeneratedMcpScriptPath = (mcpName: string): string => resolveGeneratedMcpScript(mcpName);

/**
 * Resolve path to node_modules for a generated MCP (deprecated - kept for NODE_PATH compatibility).
 * Generated MCPs bundle their dependencies, so this typically returns an empty or non-existent path.
 */
const resolveGeneratedMcpNodeModules = (mcpName: string): string => {
  const config = requireConfig();
  const base = config.isPackaged ? config.resourcesDir : path.resolve(config.resourcesDir);
  return path.join(base, 'mcp-generated', mcpName, 'node_modules');
};

// ============================================================
// Hand-written MCP Resolvers (resources/mcp/)
// ============================================================

/**
 * Resolve path to a hand-written MCP server script (from resources/mcp/).
 * Hand-written MCPs ship as plain `.cjs` files under their named directory.
 */
const resolveHandwrittenMcpScript = (mcpDirName: string): string => {
  const config = requireConfig();
  const base = config.isPackaged ? config.resourcesDir : path.resolve(config.resourcesDir);
  return path.join(base, 'mcp', mcpDirName, 'server.cjs');
};

const resolveInboxServerScript = (): string => resolveHandwrittenMcpScript('rebel-inbox');

const resolveAutomationsServerScript = (): string => resolveHandwrittenMcpScript('rebel-automations');

const resolveMeetingsServerScript = (): string => resolveHandwrittenMcpScript('rebel-meetings');

const resolveWorkspaceServerScript = (): string => resolveHandwrittenMcpScript('rebel-workspace');

const resolveSearchServerScript = (): string => resolveHandwrittenMcpScript('rebel-search');

/** @deprecated RebelInternal was split into 7 MCPs in v0.3.26. This path no longer exists. */
const resolveInternalServerScript = (): string => resolveHandwrittenMcpScript('rebel-internal');

// ============================================================
// Split MCP Server Script Resolvers (7 MCPs)
// ============================================================

const resolveSplitInboxServerScript = (): string => resolveHandwrittenMcpScript('rebel-inbox');

const resolveSplitMeetingsServerScript = (): string => resolveHandwrittenMcpScript('rebel-meetings');

const resolveSplitSearchAndConversationsServerScript = (): string =>
  resolveHandwrittenMcpScript('rebel-search-and-conversations');

const resolveSplitAutomationsServerScript = (): string => resolveHandwrittenMcpScript('rebel-automations');

const resolveSplitSpacesServerScript = (): string => resolveHandwrittenMcpScript('rebel-spaces');

const resolveSplitSettingsServerScript = (): string => resolveHandwrittenMcpScript('rebel-settings');

const resolveSplitMcpConnectorsServerScript = (): string => resolveHandwrittenMcpScript('rebel-mcp-connectors');

const resolveSplitRebelPluginsServerScript = (): string => resolveHandwrittenMcpScript('rebel-plugins');

export const resolveNodeModulesDir = (): string => {
  const config = requireConfig();
  if (config.isPackaged) {
    return path.join(config.resourcesDir, 'app.asar.unpacked', 'node_modules');
  }
  return path.join(process.cwd(), 'node_modules');
};

const bridgeStatePath = (): string => path.join(requireConfig().userDataDir, 'mcp', 'rebel-inbox-bridge.json');
let connectorCatalogPathOverride: string | null = null;

export const setConnectorCatalogPathOverride = (overridePath: string | null): void => {
  connectorCatalogPathOverride = overridePath;
};

/**
 * Returns BOTH bridge-state env keys: the new `MCP_HOST_BRIDGE_STATE` and the
 * legacy `MINDSTONE_REBEL_BRIDGE_STATE`. Both point to the same path.
 *
 * Why: in May 2026 the host renamed the env var from `MINDSTONE_REBEL_BRIDGE_STATE`
 * to `MCP_HOST_BRIDGE_STATE` (rename commits c5e7289c8 host + c111393c0 catalog),
 * but the bundled child scripts still read only the legacy name. After the rename,
 * fresh spawns received `undefined` for the bridge path, the bridge call silently
 * no-op'd, and super-mcp surfaced -33004 PACKAGE_UNAVAILABLE. Dual-writing here
 * is the host-side hotfix: every spawn payload reaches every child regardless of
 * which name it reads. Existing user configs are repaired on next launch via the
 * REPLACE-semantics `upsertMcpServersBatch` in `coreStartup.ts` rebuilding the
 * internal-MCP entries from these payload builders.
 *
 * To retire `MINDSTONE_REBEL_BRIDGE_STATE` and collapse this helper to a single
 * key, update every reader to prefer `MCP_HOST_BRIDGE_STATE` first, then fall
 * back to the legacy name (or drop legacy support after a release window):
 *   - resources/mcp/rebel-inbox/server.cjs
 *   - resources/mcp/rebel-automations/server.cjs
 *   - resources/mcp/rebel-meetings/server.cjs
 *   - resources/mcp/rebel-search-and-conversations/server.cjs
 *   - resources/mcp/rebel-spaces/server.cjs
 *   - resources/mcp/rebel-settings/server.cjs
 *   - resources/mcp/rebel-mcp-connectors/server.cjs
 *   - resources/mcp/rebel-plugins/server.cjs
 *   - resources/mcp/rebel-diagnostics/server.{cjs,mjs}
 *   - resources/mcp/microsoft-mail/src/index.ts
 *   - resources/mcp/microsoft-sharepoint/src/index.ts
 *   - resources/mcp-generated/{microsoft-mail,microsoft-sharepoint}/server.cjs (compiled)
 */
const bridgeStateEnv = (): Record<string, string> => {
  const statePath = bridgeStatePath();
  // These keys are written as LITERALS on purpose (not `Object.fromEntries` over
  // the contract array): scripts/check-bridge-state-readers.ts textually parses
  // this object to verify the host writer emits every *_BRIDGE_STATE key the
  // bundled child scripts read via `process.env.*` — those scripts are separate
  // resources that can't import the contract, so this textual writer⊇reader gate
  // (not the constant) is the real cross-process drift protection. See
  // docs-private/postmortems/260506_mcp_bridge_state_env_var_rename_incomplete_postmortem.md.
  // The `satisfies` below keeps the literal key set in lockstep with the contract
  // constant at compile time (add/rename a contract key → this fails to compile).
  return {
    MCP_HOST_BRIDGE_STATE: statePath,
    MINDSTONE_REBEL_BRIDGE_STATE: statePath,
  } satisfies Record<(typeof SUPER_MCP_BRIDGE_STATE_ENV_KEYS)[number], string>;
};

export const resolveConnectorCatalogPath = (): string => {
  if (connectorCatalogPathOverride) {
    return connectorCatalogPathOverride;
  }
  const config = requireConfig();
  const base = config.isPackaged ? config.resourcesDir : path.resolve(config.resourcesDir);
  return path.join(base, 'connector-catalog.json');
};

const resolveDiagnosticsServerScript = (): string => resolveHandwrittenMcpScript('rebel-diagnostics');

const resolveCanvasServerScript = (): string => resolveHandwrittenMcpScript('rebel-canvas');

/**
 * Resolve the absolute path to the RebelAppBridge MCP server script
 * (`resources/mcp/rebel-app-bridge/server.cjs`). Exported because tests
 * assert the path and the appBridgeManager uses it for build/verify.
 */
export const getAppBridgeMcpServerPath = (): string => {
  const config = requireConfig();
  const base = config.isPackaged ? config.resourcesDir : path.resolve(config.resourcesDir);
  return path.join(base, 'mcp', 'rebel-app-bridge', 'server.cjs');
};

export const configureBundledMcpManager = (config: BundledMcpManagerConfig): void => {
  managerConfig = {
    ...config,
    resourcesDir: config.resourcesDir || path.resolve(process.cwd(), 'resources')
  };
};

// ============================================================
// RebelInternal - DEPRECATED (v0.3.26)
// ============================================================
// RebelInternal was split into 7 domain-specific MCPs for better LLM tool discovery.
// This payload builder is kept only for migration compatibility.
// See: buildSplitRebel*Payload functions below for the current architecture.

/**
 * @deprecated RebelInternal was split into 7 MCPs in v0.3.26 (RebelInbox, RebelMeetings,
 * RebelSearch, RebelAutomations, RebelSpaces, RebelSettings, RebelMcpConnectors).
 * This payload points to a non-existent path and should not be used for new code.
 */
export const buildRebelInternalPayload = (): McpServerUpsertPayload => ({
  name: INTERNAL_SERVER_NAME,
  transport: 'stdio',
  command: 'node',
  args: [resolveInternalServerScript()],
  description: 'Internal Rebel tools: inbox management, automations, meetings, workspace config, file/source search',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv(),
    MINDSTONE_REBEL_CONNECTOR_CATALOG_PATH: resolveConnectorCatalogPath()
  }
});

// ============================================================
// Split MCP Payload Builders (7 MCPs)
// ============================================================
// These replace RebelInternal for the 7-MCP split architecture.

/**
 * Build payload for RebelInbox MCP.
 * Actions management: add, list, update, remove, query, feedback, stats, bulk, status, ready.
 */
export const buildSplitRebelInboxPayload = (): McpServerUpsertPayload => ({
  name: 'RebelInbox',
  transport: 'stdio',
  command: 'node',
  args: [resolveSplitInboxServerScript()],
  description: "Manage user's task inbox: add/update/remove tasks, list/query items, bulk archive/delete, check status/stats.",
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

/**
 * Build payload for RebelMeetings MCP (7 tools).
 * Meeting workflow: sync, list_today, save_prep, find_prep, history, missed, schedule_bot.
 */
export const buildSplitRebelMeetingsPayload = (): McpServerUpsertPayload => ({
  name: 'RebelMeetings',
  transport: 'stdio',
  command: 'node',
  args: [resolveSplitMeetingsServerScript()],
  description: "Meeting workflow: today's meetings, save/find prep notes, meeting history/missed, schedule recording bot.",
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

/**
 * Build payload for RebelSearchAndConversations MCP (9 tools).
 * Search files, sources, and entities (people/companies), browse/search/start past and new conversations.
 */
export const buildSplitRebelSearchAndConversationsPayload = (): McpServerUpsertPayload => ({
  name: 'RebelSearchAndConversations',
  transport: 'stdio',
  command: 'node',
  args: [resolveSplitSearchAndConversationsServerScript()],
  description: 'Search files, sources, and entities (people/companies), browse/search/start conversations. Semantic file search, meeting/email/slack source search, entity search/resolve, list/search/summarize/export conversation history, start new background conversations.',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

/**
 * Build payload for RebelAutomations MCP (6 tools).
 * Scheduled automations: list, create, update, delete, run, toggle.
 */
export const buildSplitRebelAutomationsPayload = (): McpServerUpsertPayload => ({
  name: 'RebelAutomations',
  transport: 'stdio',
  command: 'node',
  args: [resolveSplitAutomationsServerScript()],
  description: 'Scheduled automations: list/create/update/delete automations, run now, enable/disable.',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

/**
 * Build payload for RebelSpaces MCP (4 tools).
 * Memory space management: list, get_config, update_config, create.
 */
export const buildSplitRebelSpacesPayload = (): McpServerUpsertPayload => ({
  name: 'RebelSpaces',
  transport: 'stdio',
  command: 'node',
  args: [resolveSplitSpacesServerScript()],
  description: 'Memory Spaces: list/create spaces, get/update space config (description + associated accounts).',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

/**
 * Build payload for RebelSettings MCP (22 tools).
 * App configuration: settings, environment, vocabulary, use cases, safety prompt, user identity, Claude Max auth,
 * quality tiers, model roles, API keys, voice, model profiles, memory safety.
 */
export const buildSplitRebelSettingsPayload = (): McpServerUpsertPayload => ({
  name: 'RebelSettings',
  transport: 'stdio',
  command: 'node',
  args: [resolveSplitSettingsServerScript()],
  description: 'App configuration: get/update settings, environment info, STT vocabulary, use case library, Claude Max token storage, quality tiers, model roles, API keys, voice config, model profiles, memory safety.',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

/**
 * Build payload for RebelMcpConnectors MCP (9 tools).
 * MCP server management, tool control, authentication, and connector catalog.
 */
export const buildSplitRebelMcpConnectorsPayload = (): McpServerUpsertPayload => ({
  name: 'RebelMcpConnectors',
  transport: 'stdio',
  command: 'node',
  args: [resolveSplitMcpConnectorsServerScript()],
  description: 'Connectors & MCP admin: list/add/remove MCP servers, disable individual tools, validate config, restart router, authenticate, search connector catalog. Requires explicit user permission for remove/restart/disable.',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv(),
    MINDSTONE_REBEL_CONNECTOR_CATALOG_PATH: resolveConnectorCatalogPath()
  }
});

/**
 * Build payload for RebelPlugins MCP.
 * Plugin management: create/list/get-source/delete/open plugins.
 * (Bulk export is NOT here — it's the native super-mcp `bulk_export` meta-tool.)
 */
export const buildSplitRebelPluginsPayload = (): McpServerUpsertPayload => ({
  name: 'RebelPlugins',
  transport: 'stdio',
  command: 'node',
  args: [resolveSplitRebelPluginsServerScript()],
  description: 'Plugin management: create/list/get-source/delete/open UI plugins.',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

/**
 * List of old server names that were consolidated into RebelInternal.
 * Used by migrateToRebelInternal() to remove legacy entries.
 * Note: RebelSearch was renamed to RebelSearchAndConversations (Feb 2026).
 */
export const LEGACY_INTERNAL_SERVER_NAMES = [
  'RebelInbox',
  'RebelAutomations',
  'RebelMeetings',
  'RebelWorkspace',
  'RebelSearch', // Renamed to RebelSearchAndConversations
] as const;

/**
 * Internal MCP server names that are auto-loaded and cannot be removed by users.
 * Used by mcpServerRemovalService to prevent removal of system MCPs.
 * 
 * When adding a new internal MCP:
 * 1. Add the server name here
 * 2. Add catalog entry with `isInternal: true` in connector-catalog.json
 * 3. Register at startup in src/main/index.ts via upsertMcpServersBatch()
 */
export const INTERNAL_MCP_SERVER_NAMES = [
  'RebelInbox',
  'RebelMeetings',
  'RebelSearchAndConversations',
  'RebelAutomations',
  'RebelSpaces',
  'RebelSettings',
  'RebelMcpConnectors',
  'RebelDiagnostics',
  'RebelCanvas',
  'RebelsCommunity',
  'RebelPlugins',
  'RebelAppBridge',
] as const;

/**
 * Legacy internal servers that should be migrated to split MCPs.
 * Used by migrateRebelInternalToSplit() to remove old consolidated entry.
 */
export const LEGACY_INTERNAL_SERVERS = ['RebelInternal'] as const;

// ============================================================
// Deprecated payload builders - kept for reference
// ============================================================

/** @deprecated Use buildSplitRebelInboxPayload - this legacy payload points to non-existent paths */
export const buildRebelInboxPayload = (): McpServerUpsertPayload => ({
  name: 'RebelInbox',
  transport: 'stdio',
  command: 'node',
  args: [resolveInboxServerScript()],
  description: 'Save tasks, ideas, and items to inbox for later action - add, list, update, and remove inbox items',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

/** @deprecated Use buildSplitRebelAutomationsPayload - this legacy payload points to non-existent paths */
export const buildRebelAutomationsPayload = (): McpServerUpsertPayload => ({
  name: AUTOMATIONS_SERVER_NAME,
  transport: 'stdio',
  command: 'node',
  args: [resolveAutomationsServerScript()],
  description: 'Manage scheduled automations - create, list, update, delete, and run automations',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

/** @deprecated Use buildSplitRebelMeetingsPayload - this legacy payload points to non-existent paths */
export const buildRebelMeetingsPayload = (): McpServerUpsertPayload => ({
  name: MEETINGS_SERVER_NAME,
  transport: 'stdio',
  command: 'node',
  args: [resolveMeetingsServerScript()],
  description: "Meeting prep and today's schedule. Save prep for ANY future meeting. View today's meetings (24h cache).",
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

/** @deprecated Use buildRebelMeetingsPayload */
export const buildRebelCalendarPayload = buildRebelMeetingsPayload;

/** @deprecated RebelWorkspace was split into RebelSpaces and RebelSettings in v0.3.26 */
export const buildRebelWorkspacePayload = (): McpServerUpsertPayload => ({
  name: 'RebelWorkspace',
  transport: 'stdio',
  command: 'node',
  args: [resolveWorkspaceServerScript()],
  description: 'Get environment info (OS, paths, timezone), add/remove/list MCP server connections',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

/** @deprecated Use buildSplitRebelSearchAndConversationsPayload - this legacy payload points to non-existent paths */
export const buildRebelSearchPayload = (): McpServerUpsertPayload => ({
  name: 'RebelSearch',
  transport: 'stdio',
  command: 'node',
  args: [resolveSearchServerScript()],
  description: 'Search workspace files and captured sources (meeting transcripts, emails, slack threads) - hybrid semantic + keyword search with structured filters',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

export const buildRebelDiagnosticsPayload = (): McpServerUpsertPayload => ({
  name: DIAGNOSTICS_SERVER_NAME,
  transport: 'stdio',
  command: 'node',
  args: [resolveDiagnosticsServerScript()],
  description: 'Run system health checks, diagnose configuration issues, export debug reports for troubleshooting',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    ...bridgeStateEnv()
  }
});

const canvasStorePath = (): string => path.join(requireConfig().userDataDir, 'mcp', 'rebel-canvas-store.json');

export const buildRebelCanvasPayload = (): McpServerUpsertPayload => ({
  name: CANVAS_SERVER_NAME,
  transport: 'stdio',
  command: 'node',
  args: [resolveCanvasServerScript()],
  description: 'Interactive visualizations: charts, tables, options, HTML previews (inline, file, or folder), rendered in sandboxed views with Open in Browser support',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    REBEL_CANVAS_STORE_PATH: canvasStorePath()
  }
});

/**
 * State file path for the RebelAppBridge MCP server.
 * Mirrors `stateFilePath` on the {@link AppBridgeHandle} returned by
 * `createAppBridge()` so we can compute it before the bridge starts
 * (the router config needs the path baked into the env, not the handle).
 */
const appBridgeStatePath = (): string =>
  path.join(requireConfig().userDataDir, 'mcp', 'rebel-app-bridge', 'state.json');

/**
 * Build payload for the RebelAppBridge MCP server (Stage 4+).
 *
 * The bridge itself is started by {@link createAppBridgeManager} — this
 * payload only configures the stdio MCP that relays `rebel_browser_*`
 * tool calls through the running bridge. We never pass tokens in env
 * vars: the MCP reads `routerToken` from the state file at 0600, and
 * that's the only disk-shared secret.
 *
 * The catalog entry is `hidden: true` (Stage 5) — users enable the
 * connector through the browser-extension onboarding flow in a later
 * stage; the catalog entry exists only so the connector catalog lookup
 * keeps working.
 */
export const buildAppBridgePayload = (): McpServerUpsertPayload => ({
  name: APP_BRIDGE_SERVER_NAME,
  transport: 'stdio',
  command: 'node',
  args: [getAppBridgeMcpServerPath()],
  description:
    "Rebel's paired browser extension. Read the active tab, quote the user's selection, fill fields, and click in-page elements — only when the extension is paired and connected.",
  catalogId: 'bundled-app-bridge',
  env: {
    NODE_PATH: resolveNodeModulesDir(),
    REBEL_APP_BRIDGE_STATE: appBridgeStatePath(),
    ...(process.env.REBEL_APP_BRIDGE_EXTRA_BROWSER_PATHS ? { REBEL_APP_BRIDGE_EXTRA_BROWSER_PATHS: process.env.REBEL_APP_BRIDGE_EXTRA_BROWSER_PATHS } : {}),
  },
});

// ProfitSage MCP Server — Hospitality BI via ProfitSword Data Portal v3
// Generic, tenant-neutral: subdomain is supplied per install (e.g. "acmehotels").
const PROFITSAGE_SERVER_NAME = 'ProfitSage';
const resolveProfitSageServerScript = (): string => resolveGeneratedMcpScript('profitsage');
/** @deprecated Bundled MCP - node_modules no longer shipped. Kept for NODE_PATH compatibility. */
const resolveProfitSageNodeModules = (): string => resolveGeneratedMcpNodeModules('profitsage');
const MIXPANEL_SERVER_NAME = 'Mixpanel';
const resolveMixpanelServerScript = (): string => resolveGeneratedMcpScript('mixpanel');
const resolveMixpanelNodeModules = (): string => resolveGeneratedMcpNodeModules('mixpanel');


// ============================================================
// Multi-Instance Google Workspace Support
// ============================================================

/**
 * Configuration for a single Google Workspace instance (one account per instance).
 * Each instance has isolated credential storage and a unique instance ID.
 */
export interface GoogleWorkspaceInstanceConfig {
  /** Instance ID (e.g., "GoogleWorkspace-greg-work-com") - used as MCP server name */
  instanceId: string;
  /** Account email for this instance */
  email: string;
  /** User-friendly description (e.g., "[external-email] - Calendar, Drive, Gmail access") */
  description: string;
  /** OAuth Client ID from Google Cloud Console */
  clientId: string;
  /** OAuth Client Secret from Google Cloud Console */
  clientSecret: string;
  /** Path to accounts.json for this instance */
  accountsPath: string;
  /** Directory path for credential tokens for this instance */
  credentialsPath: string;
}

/**
 * Build MCP server payload for a single Google Workspace instance.
 * Uses the instance ID as the server name for disambiguation.
 *
 * @example
 * const payload = buildGoogleWorkspaceInstancePayload({
 *   instanceId: 'GoogleWorkspace-greg-work-com',
 *   email: '[external-email]',
 *   description: '[external-email] - Calendar, Drive, Gmail access',
 *   clientId: '...',
 *   clientSecret: '...',
 *   accountsPath: '/path/to/instance/accounts.json',
 *   credentialsPath: '/path/to/instance/credentials/'
 * });
 */
export const buildGoogleWorkspaceInstancePayload = (
  config: GoogleWorkspaceInstanceConfig
): McpServerUpsertPayload => {
  const catalogEntry = findCatalogEntryById('bundled-google');
  if (!catalogEntry?.mcpConfig?.args || catalogEntry.mcpConfig.args.length === 0) {
    throw new Error(
      'Catalog entry "bundled-google" missing mcpConfig.args. The connector catalog is the source of truth for OSS package pins; falling back to a hardcoded version is no longer supported (per docs/plans/260525_oss_release_automation.md v2). This indicates a P0 catalog-load issue.',
    );
  }
  const command = catalogEntry.mcpConfig.command ?? 'npx';
  const args = catalogEntry.mcpConfig.args;
  const catalogEnv = catalogEntry.mcpConfig.env ?? {};

  return {
    name: config.instanceId,
    transport: 'stdio',
    command,
    args: [...args],
    description: config.description,
    catalogId: 'bundled-google',
    email: config.email,
    env: {
      ...catalogEnv,
      GOOGLE_CLIENT_ID: config.clientId,
      GOOGLE_CLIENT_SECRET: config.clientSecret,
      ACCOUNTS_PATH: config.accountsPath,
      CREDENTIALS_PATH: config.credentialsPath,
      MCP_MODE: 'true',
      LOG_MODE: 'strict'
    }
  };
};

/**
 * Build multiple Google Workspace instance payloads from an array of configs.
 * Convenience wrapper for spawning multiple isolated instances.
 */
export const buildGoogleWorkspaceInstancePayloads = (
  configs: GoogleWorkspaceInstanceConfig[]
): McpServerUpsertPayload[] => configs.map(buildGoogleWorkspaceInstancePayload);

/**
 * Configuration for a single Slack workspace instance.
 */
export interface SlackInstanceConfig {
  /** Workspace team ID (e.g., "TKQ8HRFQ8") - used for token lookup */
  teamId: string;
  /** Workspace team name (e.g., "Mindstone") - used for display and instance naming */
  teamName: string;
  /** Bot token for this workspace */
  botToken: string;
  /** User token for this workspace (optional, for enhanced capabilities) */
  userToken?: string;
  /** Path to Slack config directory */
  configPath: string;
  /** OAuth client ID for token refresh (injected as env var for MCP server) */
  clientId?: string;
  /** OAuth client secret for token refresh (injected as env var for MCP server) */
  clientSecret?: string;
}

/**
 * Build MCP server payload for a single Slack workspace instance.
 * Uses the workspace name to generate a unique instance ID (e.g., "Slack-mindstone").
 * 
 * @example
 * const payload = buildSlackInstancePayload({
 *   teamId: 'TKQ8HRFQ8',
 *   teamName: 'Mindstone',
 *   botToken: 'xoxb-...',
 *   userToken: 'xoxp-...',
 *   configPath: '/path/to/slack/config'
 * });
 */
export const buildSlackInstancePayload = (config: SlackInstanceConfig): McpServerUpsertPayload => {
  const instanceId = generateWorkspaceInstanceId('Slack', config.teamName);
  const description = `${config.teamName} workspace - Team messaging and channel access`;

  // Slack is a rebel-oss connector since Stage 7 of the FOX-3319 npm-scope
  // migration. The npx spec lives in the connector catalog so the runtime
  // payload, the catalog-driven auto-upgrade reconciler, and the version
  // pin all agree without a second source of truth. As of 2026-05-25 (v2 of
  // the OSS release automation plan), the catalog is REQUIRED — the previous
  // hardcoded ?? fallback masked catalog-load failures.
  const catalogEntry = findCatalogEntryById('bundled-slack');
  if (!catalogEntry?.mcpConfig?.args || catalogEntry.mcpConfig.args.length === 0) {
    throw new Error(
      'Catalog entry "bundled-slack" missing mcpConfig.args. The connector catalog is the source of truth for OSS package pins; falling back to a hardcoded version is no longer supported (per docs/plans/260525_oss_release_automation.md v2). This indicates a P0 catalog-load issue.',
    );
  }
  const command = catalogEntry.mcpConfig.command ?? 'npx';
  const args = catalogEntry.mcpConfig.args;
  const catalogEnv = catalogEntry.mcpConfig.env ?? {};

  return {
    name: instanceId,
    transport: 'stdio',
    command,
    args: [...args],
    description,
    catalogId: 'bundled-slack',
    workspace: config.teamName,
    env: {
      ...catalogEnv,
      ...bridgeStateEnv(),
      SLACK_BOT_TOKEN: config.botToken,
      ...(config.userToken ? { SLACK_USER_TOKEN: config.userToken } : {}),
      SLACK_CONFIG_PATH: config.configPath,
      SLACK_TEAM_ID: config.teamId,
      SLACK_MCP_PACKAGE_ID: instanceId,
      ...(config.clientId ? { SLACK_CLIENT_ID: config.clientId } : {}),
      ...(config.clientSecret ? { SLACK_CLIENT_SECRET: config.clientSecret } : {}),
    },
    lastConnectedAt: Date.now(),
  };
};

export interface MicrosoftConfig {
  clientId?: string;
  configDir?: string;
  email?: string;
}

/**
 * Generate an instance-based MCP server name for a Microsoft 365 service.
 * If email is provided, creates a unique name like "Microsoft365Mail-hlatky-outlook-com".
 * Falls back to the static name when no email is available.
 */
const microsoftInstanceName = (baseName: string, email?: string): string =>
  email ? generateInstanceId(baseName, email) : baseName;

/**
 * Microsoft 365 base server names, exported for migration and removal logic.
 */
export const MICROSOFT_SERVER_BASE_NAMES = [
  MICROSOFT_MAIL_SERVER_NAME,
  MICROSOFT_CALENDAR_SERVER_NAME,
  MICROSOFT_FILES_SERVER_NAME,
  MICROSOFT_TEAMS_SERVER_NAME,
  MICROSOFT_SHAREPOINT_SERVER_NAME,
] as const;

const resolveMicrosoftConfigDirForPayload = (configuredDir?: string): string =>
  configuredDir?.trim() || path.join(requireConfig().userDataDir, MICROSOFT_CONFIG_DIR_SEGMENT);

const resolveMicrosoftClientIdForPayload = (configuredClientId?: string): string | undefined =>
  configuredClientId?.trim() || undefined;

const buildMicrosoftRebelOssPayload = (
  serverName: keyof typeof MICROSOFT_REBEL_OSS_DEFS,
  config: MicrosoftConfig,
): McpServerUpsertPayload => {
  const definition = MICROSOFT_REBEL_OSS_DEFS[serverName];
  const packageId = microsoftInstanceName(serverName, config.email);
  const catalogEntry = findCatalogEntryById(definition.catalogId);
  if (!catalogEntry?.mcpConfig?.args || catalogEntry.mcpConfig.args.length === 0) {
    throw new Error(
      `Catalog entry "${definition.catalogId}" missing mcpConfig.args. The connector catalog is the source of truth for OSS package pins; falling back to MICROSOFT_REBEL_OSS_DEFS.packageSpec is no longer supported (per docs/plans/260525_oss_release_automation.md v2). This indicates a P0 catalog-load issue.`,
    );
  }
  const command = catalogEntry.mcpConfig.command ?? 'npx';
  const args = catalogEntry.mcpConfig.args;
  const catalogEnv = catalogEntry.mcpConfig.env ?? {};
  const configDir = resolveMicrosoftConfigDirForPayload(config.configDir);
  const clientId = resolveMicrosoftClientIdForPayload(config.clientId);

  if (!clientId) {
    log.warn(
      { catalogId: definition.catalogId, instanceId: packageId },
      'Microsoft payload built without MS_CLIENT_ID; OAuth reconnect may fail until credentials are restored',
    );
  }

  return {
    name: packageId,
    transport: 'stdio',
    command,
    args: [...args],
    description: config.email ? `${config.email} - ${definition.description}` : definition.description,
    env: {
      ...catalogEnv,
      ...(clientId ? { MS_CLIENT_ID: clientId } : {}),
      MS_CONFIG_DIR: configDir,
      MS_MCP_PACKAGE_ID: packageId,
      ...(config.email ? { MS_ACCOUNT_EMAIL: config.email } : {}),
      LOG_MODE: 'strict',
    },
    catalogId: definition.catalogId,
    email: config.email ?? null,
    lastConnectedAt: Date.now(),
  };
};

export const buildMicrosoft365MailPayload = (config: MicrosoftConfig): McpServerUpsertPayload =>
  buildMicrosoftRebelOssPayload(MICROSOFT_MAIL_SERVER_NAME, config);

export const buildMicrosoft365CalendarPayload = (config: MicrosoftConfig): McpServerUpsertPayload => {
  return buildMicrosoftRebelOssPayload(MICROSOFT_CALENDAR_SERVER_NAME, config);
};

export const buildMicrosoft365FilesPayload = (config: MicrosoftConfig): McpServerUpsertPayload => {
  return buildMicrosoftRebelOssPayload(MICROSOFT_FILES_SERVER_NAME, config);
};

export const buildMicrosoft365TeamsPayload = (config: MicrosoftConfig): McpServerUpsertPayload => {
  return buildMicrosoftRebelOssPayload(MICROSOFT_TEAMS_SERVER_NAME, config);
};

export const buildMicrosoft365SharePointPayload = (config: MicrosoftConfig): McpServerUpsertPayload => {
  return buildMicrosoftRebelOssPayload(MICROSOFT_SHAREPOINT_SERVER_NAME, config);
};

// ============================================================
// Shared Subdomain Helpers (used by remaining bundled connectors)
// ============================================================

const SINGLE_LABEL_SUBDOMAIN_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const extractHostnameFromUserInput = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';

  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    // Fallback: best-effort stripping of scheme/path/port
    return trimmed
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .split('/')[0]
      .split('?')[0]
      .split('#')[0]
      .split(':')[0];
  }
};

const stripTrailingKnownSuffix = (hostname: string, suffix: string): string => {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  const normalizedSuffix = suffix.trim().toLowerCase().replace(/^\./, '');
  const dotSuffix = `.${normalizedSuffix}`;
  if (host.endsWith(dotSuffix)) {
    return host.slice(0, -dotSuffix.length);
  }
  return host;
};

export const normalizeSingleLabelSubdomainInput = (input: string, suffix: string, label: string): string => {
  const hostname = extractHostnameFromUserInput(input);
  const withoutSuffix = stripTrailingKnownSuffix(hostname, suffix);

  if (!withoutSuffix) {
    throw new Error(`${label} cannot be empty`);
  }
  if (withoutSuffix.includes('.')) {
    throw new Error(`Invalid ${label}: should be just the subdomain part (e.g., "acme" for acme.${suffix})`);
  }
  if (!SINGLE_LABEL_SUBDOMAIN_REGEX.test(withoutSuffix)) {
    throw new Error(`Invalid ${label}: must contain only letters, numbers, and hyphens`);
  }
  return withoutSuffix;
};

// Interactive Brokers MCP Server
const IBKR_SERVER_NAME = 'IBKR';

const resolveIbkrServerScript = (): string => resolveGeneratedMcpScript('ibkr');

/** @deprecated Bundled MCP - node_modules no longer shipped. Kept for NODE_PATH compatibility. */
const resolveIbkrNodeModules = (): string => resolveGeneratedMcpNodeModules('ibkr');

export interface IbkrConfig {
  host?: string;
  port?: number;
  clientId?: number;
  mode?: 'paper' | 'live';
}

export const buildIbkrPayload = (config: IbkrConfig = {}): McpServerUpsertPayload => ({
  name: IBKR_SERVER_NAME,
  transport: 'stdio',
  command: 'node',
  args: [resolveIbkrServerScript()],
  description: 'Interactive Brokers trading — positions, quotes, orders, scanners, news.',
  env: {
    NODE_PATH: resolveIbkrNodeModules(),
    IBKR_HOST: config.host || '127.0.0.1',
    IBKR_PORT: String(config.port || 4002),
    IBKR_CLIENT_ID: String(config.clientId || 1),
    IBKR_MODE: config.mode || 'paper',
    ...bridgeStateEnv(),
  },
});

// Discourse Community MCP - Rebel Community forum
const DISCOURSE_SERVER_NAME = 'RebelsCommunity';
const DISCOURSE_WRITE_SERVER_NAME = 'RebelsCommunityWrite';
const STANDALONE_DISCOURSE_SERVER_NAME = 'Discourse';
const DISCOURSE_SITE_URL = 'https://rebels.mindstone.com';

const resolveDiscourseServerScript = (): string => resolveGeneratedMcpScript('discourse');

// Read-only payload for auto-started internal RebelsCommunity (unchanged)
export const buildDiscoursePayload = (): McpServerUpsertPayload => ({
  name: DISCOURSE_SERVER_NAME,
  transport: 'stdio',
  command: 'node',
  args: [resolveDiscourseServerScript(), '--site', DISCOURSE_SITE_URL],
  description: 'Rebel Community Discourse forum - search posts, topics, and discussions'
});

// Profile-based auth helpers for write-enabled Discourse connectors
interface DiscourseProfileData {
  siteUrl: string;
  apiKey: string;
  apiUsername: string;
}

function getDiscourseProfilePath(profileName: string): string {
  const config = requireConfig();
  return path.join(config.userDataDir, 'mcp', profileName, 'profile.json');
}

export async function writeDiscourseProfile(profileName: string, data: DiscourseProfileData): Promise<string> {
  const profilePath = getDiscourseProfilePath(profileName);
  await ensureDirectory(profilePath);
  const profileData = {
    auth_pairs: [{
      site: data.siteUrl,
      api_key: data.apiKey,
      api_username: data.apiUsername,
    }],
    allow_writes: true,
    read_only: false,
    site: data.siteUrl,
  };
  await fs.writeFile(profilePath, JSON.stringify(profileData, null, 2), { mode: 0o600 });
  return profilePath;
}

interface DiscourseUserApiProfileData {
  siteUrl: string;
  userApiKey: string;
  userApiClientId: string;
}

export async function writeDiscourseUserApiProfile(profileName: string, data: DiscourseUserApiProfileData): Promise<string> {
  const profilePath = getDiscourseProfilePath(profileName);
  await ensureDirectory(profilePath);
  const profileData = {
    auth_pairs: [{
      site: data.siteUrl,
      user_api_key: data.userApiKey,
      user_api_client_id: data.userApiClientId,
    }],
    allow_writes: true,
    read_only: false,
    site: data.siteUrl,
  };
  await fs.writeFile(profilePath, JSON.stringify(profileData, null, 2), { mode: 0o600 });
  return profilePath;
}

export interface DiscourseWriteConfig {
  username?: string;
}

export const buildDiscourseWritePayload = (config: DiscourseWriteConfig = {}): McpServerUpsertPayload => ({
  name: DISCOURSE_WRITE_SERVER_NAME,
  transport: 'stdio',
  command: 'node',
  args: [resolveDiscourseServerScript(), '--profile', getDiscourseProfilePath('discourse-write')],
  description: config.username
    ? `Rebel Community Discourse forum (write-enabled) - search, read, create topics and posts as ${config.username}`
    : 'Rebel Community Discourse forum (write-enabled) - search, read, create topics and posts',
  catalogId: 'rebels-community-write',
  lastConnectedAt: Date.now(),
});

export interface StandaloneDiscourseConfig {
  siteUrl: string;
  apiKey: string;
  apiUsername: string;
}

export const buildStandaloneDiscoursePayload = (config: StandaloneDiscourseConfig): McpServerUpsertPayload => {
  let hostname: string;
  try {
    hostname = new URL(config.siteUrl).hostname;
  } catch {
    hostname = config.siteUrl;
  }
  return {
    name: STANDALONE_DISCOURSE_SERVER_NAME,
    transport: 'stdio',
    command: 'node',
    args: [resolveDiscourseServerScript(), '--profile', getDiscourseProfilePath(`discourse-${hostname}`)],
    description: `Discourse forum (${hostname}) - search, read, create topics and posts`,
    catalogId: 'discourse',
    lastConnectedAt: Date.now(),
  };
};

export const DISCOURSE_CUSTOM_SERVERS = [DISCOURSE_WRITE_SERVER_NAME, STANDALONE_DISCOURSE_SERVER_NAME] as const;

// ============================================================
// Unified Bundled MCP Catalog
// ============================================================
// All bundled MCPs are described declaratively here.
// They're added with empty credentials - MCPs self-configure via their tools.

interface BundledMcpCatalogEntry {
  name: string;
  description: string;
  /** Catalog ID for connector-catalog.json matching (e.g., 'bundled-ibkr') */
  catalogId: string;
  scriptResolver: () => string;
  nodeModulesResolver: () => string;
  /** Env vars that need empty string placeholders (API key credentials) */
  credentialEnvVars?: string[];
  /** Env vars that need computed paths (config directories) */
  configPathEnvVars?: { envVar: string; subPath: string }[];
  /** Static env vars (always same value) */
  staticEnv?: Record<string, string>;
  /** Whether this MCP needs the bridge state path */
  needsBridgeState?: boolean;
  /** OAuth credential resolver - returns clientId/clientSecret from env-only sources */
  oauthCredentialResolver?: () => { clientId: string; clientSecret: string } | null;
  /** Mapping of OAuth credentials to env var names */
  oauthEnvMapping?: { clientId: string; clientSecret?: string };
  /**
   * Map of env var name → provider key ID for shared API key resolution.
   * When set, buildBundledMcpPayload checks providerKeys before falling back to empty string.
   * E.g., { GEMINI_API_KEY: 'google' } means this MCP can use the shared Google API key.
   */
  providerKeyMapping?: Partial<Record<string, ProviderKeyId>>;
}

function getMcpConfigDir(mcpName: string): string {
  const config = requireConfig();
  return path.join(config.userDataDir, 'mcp', mcpName.toLowerCase());
}

function getGoogleWorkspaceDataDir(): string {
  const config = requireConfig();
  return path.join(config.userDataDir, 'google-workspace-mcp');
}

function getGoogleWorkspaceInstanceDir(instanceId: string): string {
  return path.join(getGoogleWorkspaceDataDir(), instanceId);
}

function hashGoogleMigrationEmail(email: string): string {
  return crypto.createHash('sha256').update(email).digest('hex').slice(0, 12);
}

// Credential resolvers for OAuth MCPs (imported here to avoid circular deps)
import {
  resolveOAuthCredentials,
  googleCredentialSource,
  resolveMicrosoftClientId,
  microsoftCredentialSource,
  hubspotCredentialSource,
} from './oauthCredentials';

const BUNDLED_MCP_CATALOG: Record<string, BundledMcpCatalogEntry> = {
  // ============================================================
  // API-key based MCPs - start with empty credentials, user provides via tools
  // ============================================================
  IBKR: {
    name: 'IBKR',
    description: 'Interactive Brokers trading — positions, quotes, orders, scanners, news.',
    catalogId: 'bundled-ibkr',
    scriptResolver: resolveIbkrServerScript,
    nodeModulesResolver: resolveIbkrNodeModules,
    staticEnv: {
      IBKR_HOST: '127.0.0.1',
      IBKR_PORT: '4002',
      IBKR_CLIENT_ID: '1',
      IBKR_MODE: 'paper',
    },
    needsBridgeState: true,
  },
  ProfitSage: {
    name: PROFITSAGE_SERVER_NAME,
    description: 'ProfitSage hospitality BI (ProfitSword Data Portal v3). List hotel sites, pull daily/monthly P&L, labor, GL ledger batches, sales bookings, and sales pace data (events/rooms/transient). Read-only.',
    catalogId: 'bundled-profitsage',
    scriptResolver: resolveProfitSageServerScript,
    nodeModulesResolver: resolveProfitSageNodeModules,
    credentialEnvVars: ['PROFITSAGE_SUBDOMAIN', 'PROFITSAGE_USERNAME', 'PROFITSAGE_PASSWORD'],
  },
  Mixpanel: {
    name: MIXPANEL_SERVER_NAME,
    description: 'Mixpanel product analytics: query events by user/date, list cohorts, run retention and funnel reports, fetch user profiles, browse saved insights. Read-only.',
    catalogId: 'bundled-mixpanel',
    scriptResolver: resolveMixpanelServerScript,
    nodeModulesResolver: resolveMixpanelNodeModules,
    credentialEnvVars: ['MIXPANEL_USERNAME', 'MIXPANEL_SECRET', 'MIXPANEL_PROJECT_ID', 'MIXPANEL_REGION'],
  },
  OpenAIImageGeneration: {
    name: 'OpenAIImageGeneration',
    description: 'Generate images from text descriptions using OpenAI gpt-image-2. Images are saved to Chief-of-Staff/generated-images/.',
    catalogId: 'openai-image-generation',
    scriptResolver: () => resolveGeneratedMcpScript('openai-image'),
    nodeModulesResolver: resolveNodeModulesDir,
    credentialEnvVars: ['OPENAI_API_KEY'],
    providerKeyMapping: { OPENAI_API_KEY: 'openai' },
  },
  // ============================================================
  // No-credentials MCPs - work without any user configuration
  // ============================================================
  RebelAppBridge: {
    name: APP_BRIDGE_SERVER_NAME,
    description:
      "Rebel's paired browser extension. Read the active tab, quote the user's selection, fill fields, and click in-page elements — only when the extension is paired and connected.",
    catalogId: 'bundled-app-bridge',
    scriptResolver: getAppBridgeMcpServerPath,
    nodeModulesResolver: resolveNodeModulesDir,
    // Router-internal token is read from the bridge state file at 0600 —
    // never passed through env vars. The bridge host writes the file to
    // userData/mcp/rebel-app-bridge/state.json on start and deletes on stop.
    configPathEnvVars: [{ envVar: 'REBEL_APP_BRIDGE_STATE', subPath: 'state.json' }],
  },
};

/**
 * Check if a server name is a bundled MCP.
 */
export const isBundledMcp = (serverName: string): boolean => {
  return serverName in BUNDLED_MCP_CATALOG;
};

/**
 * Options for building a bundled MCP payload.
 */
export interface BuildBundledMcpOptions {
  /** Account email for identity - if provided, generates instance name (e.g., "HubSpot-greg-acme-com") */
  email?: string;
  /** API key credential (for single-key API MCPs like ElevenLabs) */
  apiKey?: string;
  /** Named credentials map (for multi-key MCPs like IBKR: { host, port }) */
  credentials?: Record<string, string>;
  /** Scope tier for HubSpot - 'readonly' for free accounts, 'full' for paid */
  scopeTier?: 'readonly' | 'full';
  /** Shared provider API keys — used as fallback when no per-connector credential is provided */
  providerKeys?: ProviderKeys;
}

const isValidHubSpotScopeTier = (value: unknown): value is HubSpotScopeTier => (
  value === 'readonly' || value === 'full'
);

async function resolveHubSpotScopeTierWithFallback(options: {
  instanceId: string;
  source: 'buildBundledMcpPayload' | 'buildPayloadFromCatalog.bundled' | 'buildPayloadFromCatalog.rebel_oss';
  accountEmail?: string;
  fallbackScopeTier?: unknown;
}): Promise<HubSpotScopeTier | undefined> {
  const accountEmail = options.accountEmail?.trim();
  const fallbackScopeTier = isValidHubSpotScopeTier(options.fallbackScopeTier)
    ? options.fallbackScopeTier
    : undefined;
  const emitScopeTierFallbackTelemetry = (errorCode: string): void => {
    emitHubSpotTelemetry({
      event: 'hubspot.scope_tier.fallback',
      ...(accountEmail ? { accountEmail } : {}),
      instanceId: options.instanceId,
      errorCode,
    }).catch((err) => {
      log.error({ err }, 'hubspot.telemetry_emit_failed');
    });
  };

  if (accountEmail) {
    try {
      return await getStoredScopeTier(accountEmail);
    } catch (error) {
      const errorCode = error instanceof HubSpotAuthError
        ? error.code
        : 'scope_tier_lookup_failed';

      if (fallbackScopeTier) {
        log.warn(
          {
            source: options.source,
            instanceId: options.instanceId,
            errorCode,
            fallbackScopeTier,
          },
          'HubSpot scope tier lookup failed; using fallback scope tier',
        );
        emitScopeTierFallbackTelemetry(errorCode);
        return fallbackScopeTier;
      }

      throw error;
    }
  }

  if (fallbackScopeTier) {
    log.warn(
      {
        source: options.source,
        instanceId: options.instanceId,
        fallbackScopeTier,
      },
      'HubSpot scope tier fallback used because account email is unavailable',
    );
    emitScopeTierFallbackTelemetry('missing_account_email');
    return fallbackScopeTier;
  }

  return undefined;
}

/**
 * Build a payload for any bundled MCP from the catalog.
 * - API-key MCPs: Added with empty credentials, user provides via configure_* tools
 * - OAuth MCPs: Added with embedded app credentials, user authenticates via OAuth flow
 * 
 * @param serverName - The bundled MCP name (e.g., 'IBKR', 'ElevenLabs')
 * @param options - Optional configuration including email for instance naming
 */
export const buildBundledMcpPayload = async (
  serverName: string,
  options?: BuildBundledMcpOptions
): Promise<McpServerUpsertPayload> => {
  const entry = BUNDLED_MCP_CATALOG[serverName];
  if (!entry) {
    throw new Error(`Unknown bundled MCP: ${serverName}. Valid: ${Object.keys(BUNDLED_MCP_CATALOG).join(', ')}`);
  }

  // Normalize inputs — trim whitespace from credentials/email (pasted values often have trailing newlines)
  const trimmedApiKey = options?.apiKey?.trim() || undefined;
  const trimmedEmail = options?.email?.trim() || undefined;
  const trimmedCredentials: Record<string, string> | undefined = options?.credentials
    ? Object.fromEntries(Object.entries(options.credentials).map(([k, v]) => [k, v.trim()]))
    : undefined;

  const env: Record<string, string> = {
    NODE_PATH: entry.nodeModulesResolver(),
  };

  // Add credential env vars for API-key based MCPs
  // Priority: credentials > apiKey > providerKeys[mapping] > empty string (MCP will self-configure)
  for (const envVar of entry.credentialEnvVars || []) {
    // Check for named credential in credentials
    // Normalize both sides: remove underscores and compare case-insensitively
    // e.g., 'host' matches 'IBKR_HOST' (both normalize to 'host')
    const normalizeKey = (s: string) => s.toLowerCase().replace(/_/g, '');
    const credKey = Object.keys(trimmedCredentials ?? {}).find(
      k => normalizeKey(envVar).includes(normalizeKey(k))
    );
    if (credKey && trimmedCredentials?.[credKey]) {
      env[envVar] = trimmedCredentials[credKey];
    } else if (trimmedApiKey && entry.credentialEnvVars?.length === 1) {
      // Single credential MCP with apiKey provided
      env[envVar] = trimmedApiKey;
    } else {
      // Check for shared provider key mapping (e.g., GEMINI_API_KEY → google providerKey)
      const providerId = entry.providerKeyMapping?.[envVar];
      const providerKey = providerId ? options?.providerKeys?.[providerId]?.trim() : undefined;
      if (providerKey) {
        env[envVar] = providerKey;
      } else {
        // Empty - MCP will self-configure via its tools
        env[envVar] = '';
      }
    }
  }

  // Add OAuth credentials from embedded/configured sources (for OAuth MCPs)
  if (entry.oauthCredentialResolver && entry.oauthEnvMapping) {
    const creds = entry.oauthCredentialResolver();
    if (creds) {
      env[entry.oauthEnvMapping.clientId] = creds.clientId;
      if (entry.oauthEnvMapping.clientSecret && creds.clientSecret) {
        env[entry.oauthEnvMapping.clientSecret] = creds.clientSecret;
      }
    }
  }

  // Add config path env vars (computed paths in userData)
  const configDir = getMcpConfigDir(entry.name);
  for (const { envVar, subPath } of entry.configPathEnvVars || []) {
    env[envVar] = subPath ? path.join(configDir, subPath) : configDir;
  }

  // Add static env vars, then override with user-provided credentials (e.g., IBKR setup fields)
  if (entry.staticEnv) {
    Object.assign(env, entry.staticEnv);

    if (trimmedCredentials) {
      const normalize = (s: string) => s.toLowerCase().replace(/_/g, '');
      for (const envVar of Object.keys(entry.staticEnv)) {
        const credKey = Object.keys(trimmedCredentials).find(
          k => normalize(envVar).includes(normalize(k))
        );
        if (credKey && trimmedCredentials[credKey]) {
          env[envVar] = trimmedCredentials[credKey];
        }
      }
    }
  }

  // Add bridge state path if needed
  if (entry.needsBridgeState) {
    Object.assign(env, bridgeStateEnv());
  }

  // Map accountIdentity email to any credentialEnvVar ending in _EMAIL that wasn't already populated.
  // This handles MCPs where the email comes from accountIdentity (not setupFields).
  if (trimmedEmail) {
    for (const envVar of entry.credentialEnvVars || []) {
      if (envVar.endsWith('_EMAIL') && !env[envVar]) {
        env[envVar] = trimmedEmail;
      }
    }
  }

  // Generate instance name if email provided (e.g., "HubSpot-greg-acme-com")
  const instanceName = trimmedEmail
    ? generateInstanceId(entry.name, trimmedEmail) 
    : entry.name;

  // Preserved post-migration (Stage 5): HubSpot npx payloads still require
  // HUBSPOT_SCOPE_TIER injection for readonly/full tool filtering.
  if (serverName === 'HubSpot') {
    const scopeTier = await resolveHubSpotScopeTierWithFallback({
      instanceId: instanceName,
      source: 'buildBundledMcpPayload',
      accountEmail: trimmedEmail,
      fallbackScopeTier: options?.scopeTier,
    });
    if (scopeTier) {
      env.HUBSPOT_SCOPE_TIER = scopeTier;
    }
  }

  // Generate description with email if provided
  const description = trimmedEmail
    ? `${trimmedEmail} - ${entry.description}`
    : entry.description;

  return {
    name: instanceName,
    transport: 'stdio',
    command: 'node',
    args: [entry.scriptResolver()],
    description,
    catalogId: entry.catalogId,
    email: trimmedEmail ?? null,
    env,
    lastConnectedAt: Date.now(),
  };
};

export const buildBundledHttpMcpPayload = (
  serverName: string,
  opts: { url: string; description?: string; catalogId?: string }
): McpServerUpsertPayload => ({
  name: serverName,
  transport: 'http',
  type: 'http',
  url: opts.url,
  description: opts.description ?? '',
  ...(opts.catalogId ? { catalogId: opts.catalogId } : {}),
});

// Legacy aliases for backward compatibility
export const isSelfConfiguringMcp = isBundledMcp;
export const buildSelfConfiguringMcpPayload = buildBundledMcpPayload;
export type SelfConfiguringMcpId = string;
export type BundledMcpId = string;

/** Look up the providerKeyMapping for a bundled MCP by server name. */
export function getProviderKeyMapping(serverName: string): Partial<Record<string, ProviderKeyId>> | undefined {
  return BUNDLED_MCP_CATALOG[serverName]?.providerKeyMapping;
}

type ProviderKeyCatalogEntry = {
  id: string;
  provider: string;
  bundledConfig?: { providerKeyMapping?: Partial<Record<string, ProviderKeyId>> };
  email?: string | null;
};

const readCurrentMcpServersConfig = async (): Promise<Record<string, Record<string, unknown>>> => {
  try {
    const settings = getSettings();
    const configPath = resolveMcpConfigPath(settings);
    if (!configPath) {
      return {};
    }

    const parsed = await readJson(configPath);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    const serversRaw = (parsed as Record<string, unknown>).mcpServers;
    if (!serversRaw || typeof serversRaw !== 'object' || Array.isArray(serversRaw)) {
      return {};
    }
    return serversRaw as Record<string, Record<string, unknown>>;
  } catch (err) {
    // A read/parse failure here silently presents as "no MCP servers" — make it
    // observable before recovering with an empty config (behavior preserved).
    log.warn({ err }, 'Failed to read current MCP servers config — treating as empty (servers will appear missing)');
    return {};
  }
};

const readProviderKeyCatalogEntries = async (): Promise<ProviderKeyCatalogEntry[]> => {
  try {
    const catalogRaw = JSON.parse(await fs.readFile(resolveConnectorCatalogPath(), 'utf8'));
    return (catalogRaw?.connectors ?? []) as ProviderKeyCatalogEntry[];
  } catch (err) {
    // A failed connector-catalog read silently becomes "no connectors" — make
    // it observable before recovering with an empty list (behavior preserved).
    log.warn({ err }, 'Failed to read connector catalog — treating as empty (provider-key connectors will appear missing)');
    return [];
  }
};

export interface RebelOssProviderKeyConnectorMatch {
  serverName: string;
  catalogId: string;
  email?: string;
  catalogEntry: ProviderKeyCatalogEntry;
}

export const findRebelOssConnectorsUsingProviderKey = async (
  providerId: ProviderKeyId,
  mcpServersConfig?: Record<string, Record<string, unknown>>,
  connectorCatalog?: ProviderKeyCatalogEntry[],
): Promise<RebelOssProviderKeyConnectorMatch[]> => {
  const servers = mcpServersConfig ?? await readCurrentMcpServersConfig();
  const catalog = connectorCatalog ?? await readProviderKeyCatalogEntries();

  const catalogById = new Map<string, ProviderKeyCatalogEntry>();
  for (const entry of catalog) {
    if (!entry?.id || entry.provider !== 'rebel-oss') continue;
    const providerKeyMapping = entry.bundledConfig?.providerKeyMapping;
    if (!providerKeyMapping || Object.keys(providerKeyMapping).length === 0) continue;
    if (!Object.values(providerKeyMapping).includes(providerId)) continue;
    catalogById.set(entry.id, entry);
  }

  const matches: RebelOssProviderKeyConnectorMatch[] = [];
  for (const [serverName, serverEntry] of Object.entries(servers)) {
    if (!serverEntry || typeof serverEntry !== 'object') continue;
    const catalogId = serverEntry.catalogId;
    if (typeof catalogId !== 'string') continue;
    const catalogEntry = catalogById.get(catalogId);
    if (!catalogEntry) continue;
    const email = typeof serverEntry.email === 'string' ? serverEntry.email : undefined;
    matches.push({ serverName, catalogId, email, catalogEntry });
  }

  return matches;
};

// ============================================================
// Catalog-Aware Payload Building
// ============================================================

/**
 * Look up a connector catalog entry by its `catalogId`.
 * Returns the matching entry or `undefined` if not found.
 */
export function lookupCatalogEntry(
  catalogId: string,
  catalog: Record<string, unknown>[],
): Record<string, unknown> | undefined {
  return catalog.find((entry) => entry.id === catalogId);
}

export interface ResolveEnvPlaceholdersOpts {
  /**
   * Resolved deepest-common-ancestor of the user's MCP sandbox trust list.
   * Used to fill `{{ALLOWED_ROOTS_ANCESTOR}}` and (after `path.join`) the
   * `{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}` placeholders. When undefined the
   * helper falls back to `os.tmpdir()`, which matches the connector's own
   * intrinsic default (so a tmpdir fallback is semantically safe but the
   * connector then rejects every workspace path until the user resolves
   * their trust list).
   */
  ancestor?: string;
  /**
   * Subdirectory placed under {@link ancestor} for the downloads sandbox.
   * Defaults to `'runway-mcp'`. Joined via `path.join` (NOT string concat) so
   * it's correct across POSIX, Windows drive roots, and UNC roots.
   */
  ancestorDownloadsSubdir?: string;
}

/**
 * Resolve catalog-internal env placeholders against per-spawn context.
 *
 * Substitutes:
 *   - `{{MCP_CONFIG_DIR}}` → the per-server config dir
 *   - `{{MCP_BASE_DIR}}`   → the shared MCP base dir
 *   - `{{BRIDGE_STATE_PATH}}` → bridge-state JSON path (rebel-* connectors)
 *   - `{{ALLOWED_ROOTS_ANCESTOR}}` → deepest-common-ancestor of the user's
 *     trust roots (Runway sandbox boundary). Falls back to `os.tmpdir()`
 *     when `opts.ancestor` is undefined.
 *   - `{{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS}}` → `path.join(ancestor, opts.ancestorDownloadsSubdir ?? 'runway-mcp')`.
 *
 * `opts` is REQUIRED so the compiler flags every call site that needs to
 * decide whether it has a real ancestor in scope. Sites without an ancestor
 * (benchmarks, tests) pass `{}` explicitly.
 *
 * Shared by `buildPayloadFromCatalog`, `migrateBundledConnectorsToNpx`,
 * and `contributionSwapService`.
 */
export function resolveEnvPlaceholders(
  env: Record<string, string>,
  configDir: string,
  baseDir: string,
  opts: ResolveEnvPlaceholdersOpts,
): Record<string, string> {
  const ancestor = opts.ancestor ?? os.tmpdir();
  const ancestorDownloads = path.join(ancestor, opts.ancestorDownloadsSubdir ?? 'runway-mcp');
  const resolved: Record<string, string> = {};
  for (const [key, val] of Object.entries(env)) {
    resolved[key] = val
      .replace(/\{\{MCP_CONFIG_DIR\}\}/g, configDir)
      .replace(/\{\{MCP_BASE_DIR\}\}/g, baseDir)
      .replace(/\{\{BRIDGE_STATE_PATH\}\}/g, bridgeStatePath())
      .replace(/\{\{ALLOWED_ROOTS_ANCESTOR_DOWNLOADS\}\}/g, ancestorDownloads)
      .replace(/\{\{ALLOWED_ROOTS_ANCESTOR\}\}/g, ancestor);
  }
  return resolved;
}

type SandboxAncestorSurface =
  | 'desktop-build'
  | 'desktop-migration-reconcile'
  | 'desktop-migration-google'
  | 'desktop-migration-hubspot'
  | 'desktop-migration-slack'
  | 'desktop-migration-legacy'
  | 'contribution-swap';

export interface SandboxAncestorResolution {
  ancestor: string | undefined;
  rootCount: number;
  dcaStatus: 'resolved' | 'empty' | 'root-collapse' | 'fallback-tmpdir';
  fallbackReason?: string;
}

/**
 * Compute the resolved ancestor passed to {@link resolveEnvPlaceholders}.
 *
 * Pulls the trust-root inputs (workspace, `<homePath>/mcp-servers`, Space
 * symlink targets, `rebelSystemRoot`) from the active settings store and
 * platform config, runs them through the realpath-aware sandbox helper,
 * and derives the deepest common ancestor.
 *
 * Returns `{ ancestor: undefined }` when the helper or DCA computation
 * yields no usable root; callers pass that through to
 * {@link resolveEnvPlaceholders}, which falls back to `os.tmpdir()`.
 *
 * Never throws: settings/platform access is guarded so a malformed runtime
 * doesn't break MCP spawn — falls back to tmpdir with `helper-threw` noted.
 */
export function resolveSandboxAncestor(): SandboxAncestorResolution {
  try {
    const settings = getSettings();
    let homePath: string | undefined;
    try {
      homePath = getPlatformConfig().homePath;
    } catch {
      homePath = undefined;
    }
    const coreDirectory = settings.coreDirectory ?? undefined;

    const roots = getMcpSandboxAncestorRoots(settings, {
      ...(homePath ? { homePath } : {}),
      ...(coreDirectory ? { coreDirectory } : {}),
    });

    if (roots.length === 0) {
      return {
        ancestor: undefined,
        rootCount: 0,
        dcaStatus: 'empty',
        fallbackReason: 'no-trust-roots',
      };
    }

    const dca = getDeepestCommonAncestor(roots);
    if (dca) {
      return { ancestor: dca, rootCount: roots.length, dcaStatus: 'resolved' };
    }
    return {
      ancestor: undefined,
      rootCount: roots.length,
      dcaStatus: 'root-collapse',
      fallbackReason: 'dca-collapsed-to-fs-root',
    };
  } catch {
    return {
      ancestor: undefined,
      rootCount: 0,
      dcaStatus: 'fallback-tmpdir',
      fallbackReason: 'helper-threw',
    };
  }
}

/**
 * Resolve sandbox ancestor and emit a structured log on the primary build
 * path. Other sites use {@link resolveSandboxAncestor} directly to avoid
 * spamming a log line on every migration sweep.
 */
function resolveSandboxAncestorLogged(opts: {
  surface: SandboxAncestorSurface;
  serverName: string;
  catalogId: string;
}): string | undefined {
  const resolution = resolveSandboxAncestor();
  const fields = {
    surface: opts.surface,
    serverName: opts.serverName,
    catalogId: opts.catalogId,
    rootCount: resolution.rootCount,
    dcaStatus: resolution.dcaStatus,
    ...(resolution.fallbackReason ? { fallbackReason: resolution.fallbackReason } : {}),
  };
  if (resolution.dcaStatus === 'resolved') {
    log.info(fields, 'mcp.spawn.trusted-roots-resolved');
  } else {
    log.warn(fields, 'mcp.spawn.trusted-roots-resolved');
  }
  return resolution.ancestor;
}

type ProviderKeyMappingResolutionMode = 'preserve' | 'overwrite';

const isProviderKeyPlaceholderSlot = (value: string | undefined, envKey: string): boolean => {
  return value === '' || value === `{{${envKey}}}`;
};

export const applyProviderKeyMappingToEnv = (
  env: Record<string, string>,
  providerKeyMapping: Partial<Record<string, ProviderKeyId>> | undefined,
  providerKeys: ProviderKeys | undefined,
  mode: ProviderKeyMappingResolutionMode,
): Record<string, string> => {
  if (!providerKeyMapping || Object.keys(providerKeyMapping).length === 0) {
    return env;
  }

  const resolvedEnv = { ...env };
  for (const [envKey, providerId] of Object.entries(providerKeyMapping)) {
    if (!providerId) continue;
    const providerKey = providerKeys?.[providerId]?.trim();
    if (
      mode === 'preserve' &&
      !isProviderKeyPlaceholderSlot(resolvedEnv[envKey], envKey)
    ) {
      continue;
    }

    if (providerKey) {
      resolvedEnv[envKey] = providerKey;
    } else if (isProviderKeyPlaceholderSlot(resolvedEnv[envKey], envKey)) {
      resolvedEnv[envKey] = '';
    }
  }

  return resolvedEnv;
};

const areEnvRecordsEqual = (
  first: Record<string, string> | undefined,
  second: Record<string, string> | undefined,
): boolean => {
  if (!first && !second) {
    return true;
  }
  if (!first || !second) {
    return false;
  }
  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);
  if (firstKeys.length !== secondKeys.length) {
    return false;
  }
  for (const key of firstKeys) {
    if (first[key] !== second[key]) {
      return false;
    }
  }
  return true;
};

/**
 * Whole-string match for unresolved env placeholder forms. Catches
 * `{{VAR}}`, `${VAR}`, and `$VAR_NAME`. Used by the cloud-rewrite path to
 * reject user values that are themselves placeholders rather than real
 * literals (super-mcp's runtime expander only fills these from process.env,
 * which on cloud doesn't have the per-user secret).
 */
const STRICT_ENV_PLACEHOLDER_RE = /^(?:\{\{[A-Z_][A-Z0-9_]*\}\}|\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*)$/;

/**
 * Match strings that look like absolute filesystem paths. Covers POSIX
 * (`/...`), tilde-expanded home (`~/...` or `~\...`), Windows drive paths
 * (`C:\...` or `C:/...`), Windows UNC paths (`\\server\share\...`), and
 * Windows extended-length / device paths (`\\?\C:\...`, `\\.\PhysicalDrive0`).
 * Used by the desktop→cloud rewrite to reject user values that would leak
 * machine-specific paths into the cloud payload when the catalog declares
 * the slot as a portable placeholder.
 */
const LOOKS_LIKE_FS_PATH_RE =
  /^(?:\/[^\s]|~[\\/]|[A-Za-z]:[\\/]|\\\\(?:[?.][\\/]|[^\s\\/]))/;

export interface MergePreservedUserEnvOptions {
  /**
   * Drop user-supplied keys that aren't declared in the catalog env. Used by
   * the desktop→cloud rewrite to prevent stale or machine-specific user keys
   * from leaking into the cloud payload (path-leak protection).
   *
   * Default `false` preserves the original migration semantics where
   * non-catalog user keys are carried over.
   */
  dropExtraUserKeys?: boolean;
  /**
   * Reject user values whose strings start with this absolute-path prefix.
   * Used by the desktop→cloud rewrite to drop managed-installs absolute
   * desktop paths (e.g. `<userData>/mcp/managed-installs/...`) that have no
   * meaning on the cloud filesystem.
   */
  rejectAbsolutePathPrefix?: string;
  /**
   * Also recognise `${VAR}` and `$VAR` placeholder forms (in addition to
   * `{{VAR}}`) when deciding whether a user value is unresolved. Used by the
   * desktop→cloud rewrite so that any placeholder shape from a hand-edited
   * config is treated as "not a real literal" and ignored in favour of the
   * catalog default.
   *
   * Default `false` keeps migration's `{{VAR}}`-only behaviour.
   */
  strictPlaceholders?: boolean;
  /**
   * Reject any user value that looks like an absolute filesystem path
   * (POSIX `/...`, tilde `~/...`, or Windows `C:\...`). Used by the
   * desktop→cloud rewrite as the generalisation of
   * `rejectAbsolutePathPrefix`: catalog placeholders that resolve to
   * machine-specific paths on desktop (e.g. `{{MCP_CONFIG_DIR}}`) must not
   * be replaced by the user's resolved local path when shipping to cloud.
   *
   * Default `false` keeps migration's "preserve resolved paths" behaviour
   * (migration runs locally, so absolute paths are intentional).
   */
  rejectAbsoluteFsPathValues?: boolean;
}

export const mergePreservedUserEnv = (
  previousEnv: unknown,
  resolvedEnv: Record<string, string>,
  options: MergePreservedUserEnvOptions = {},
): Record<string, string> => {
  const merged: Record<string, string> = { ...resolvedEnv };
  if (!previousEnv || typeof previousEnv !== 'object' || Array.isArray(previousEnv)) {
    return merged;
  }
  const catalogKeys = new Set(Object.keys(resolvedEnv));
  const {
    dropExtraUserKeys = false,
    rejectAbsolutePathPrefix,
    strictPlaceholders = false,
    rejectAbsoluteFsPathValues = false,
  } = options;
  for (const [k, v] of Object.entries(previousEnv as Record<string, unknown>)) {
    if (typeof v !== 'string' || v.length === 0) continue;
    if (INTERNAL_ENV_KEYS.has(k)) continue;
    if (/\{\{[A-Z0-9_]+\}\}/.test(v)) continue;
    if (strictPlaceholders && STRICT_ENV_PLACEHOLDER_RE.test(v)) continue;
    if (rejectAbsolutePathPrefix && v.startsWith(rejectAbsolutePathPrefix)) continue;
    if (rejectAbsoluteFsPathValues && LOOKS_LIKE_FS_PATH_RE.test(v)) continue;
    if (catalogKeys.has(k)) {
      // Default-only sandbox keys (e.g. RUNWAY_ALLOWED_ROOT) preserve any
      // non-blank user override, even after the catalog placeholder has
      // been resolved to a real path. Without this, a user's manual
      // RUNWAY_ALLOWED_ROOT advanced-config entry gets clobbered the
      // moment Stage 2 resolves {{ALLOWED_ROOTS_ANCESTOR}} before merge.
      if (DEFAULT_ONLY_SANDBOX_ENV_KEYS.has(k)) {
        merged[k] = v;
        continue;
      }
      const catalogVal = merged[k];
      if (typeof catalogVal === 'string' && /\{\{[A-Z0-9_]+\}\}/.test(catalogVal)) {
        merged[k] = v;
      }
      continue;
    }
    if (dropExtraUserKeys) continue;
    merged[k] = v;
  }
  return merged;
};

export const repairBridgeStatePathLiterals = async (
  configPath: string,
): Promise<{ repaired: string[] }> => {
  try {
    const parsed = await readJson(configPath);
    if (!parsed || typeof parsed !== 'object') {
      log.debug({ configPath }, 'mcp.repair: no readable MCP config found');
      return { repaired: [] };
    }

    const config = parsed as Record<string, unknown>;
    const serversRaw = config.mcpServers;
    if (!serversRaw || typeof serversRaw !== 'object' || Array.isArray(serversRaw)) {
      log.debug({ configPath }, 'mcp.repair: no mcpServers object found');
      return { repaired: [] };
    }

    const repaired: string[] = [];
    const replacement = bridgeStatePath();
    for (const [serverName, serverRaw] of Object.entries(serversRaw as Record<string, unknown>)) {
      if (!serverRaw || typeof serverRaw !== 'object' || Array.isArray(serverRaw)) continue;

      const envRaw = (serverRaw as Record<string, unknown>).env;
      if (!envRaw || typeof envRaw !== 'object' || Array.isArray(envRaw)) continue;

      let serverRepaired = false;
      const env = envRaw as Record<string, unknown>;
      for (const [envKey, envValue] of Object.entries(env)) {
        if (typeof envValue !== 'string' || !envValue.includes('{{BRIDGE_STATE_PATH}}')) continue;
        env[envKey] = envValue.replaceAll('{{BRIDGE_STATE_PATH}}', replacement);
        serverRepaired = true;
      }

      if (serverRepaired) {
        repaired.push(serverName);
      }
    }

    if (repaired.length > 0) {
      await writeJson(configPath, config);
      log.info(
        { count: repaired.length, repaired },
        'mcp.repair: rewrote {{BRIDGE_STATE_PATH}} literal in MCP server(s)',
      );
    } else {
      log.debug('mcp.repair: no {{BRIDGE_STATE_PATH}} literals found');
    }

    return { repaired };
  } catch (err) {
    log.warn(
      { err, configPath },
      'mcp.repair: failed to rewrite {{BRIDGE_STATE_PATH}} literal in MCP server(s)',
    );
    return { repaired: [] };
  }
};

type CatalogPayloadEntry = {
  id: string;
  name: string;
  provider: string;
  bundledConfig?: { serverName?: string; authType?: string; accountIdentityEnvVar?: string; providerKeyMapping?: Partial<Record<string, ProviderKeyId>> };
  mcpConfig?: { transport?: string; type?: string; url?: string; command?: string; args?: string[]; env?: Record<string, string>; oauth?: boolean; oauthParams?: Record<string, string>; oauthClientId?: string; oauthClientSecret?: string };
  setupFields?: { id: string; type?: string; default?: string; envVar?: string; headerKey?: string; headerPrefix?: string }[];
  description?: string;
};

type RebelOssMcpRuntimeConfig = { command?: string; args?: string[] };

type ResolvedMcpRuntime = {
  command: string | null;
  args: string[] | null;
};

const resolveManagedInstallForRebelOssRuntime = (
  catalogId: string,
  mcpCfg: RebelOssMcpRuntimeConfig | undefined,
): ResolvedMcpRuntime => {
  if (!mcpCfg) {
    return { command: null, args: null };
  }

  let resolvedCommand: string | null = mcpCfg.command ?? null;
  let resolvedArgs: string[] | null = mcpCfg.args ?? null;

  if (mcpCfg.command !== 'npx') {
    return { command: resolvedCommand, args: resolvedArgs };
  }

  const configuredUserDataDir = managerConfig?.userDataDir;
  const managedRoot = getManagedInstallsRoot()
    ?? (configuredUserDataDir ? resolveManagedInstallsRoot(configuredUserDataDir) : null);
  if (!managedRoot) {
    return { command: resolvedCommand, args: resolvedArgs };
  }
  const args = mcpCfg.args ?? [];
  const yesIdx = args.findIndex((a) => a === '-y' || a === '--yes');
  if (yesIdx === -1 || yesIdx + 1 >= args.length) {
    return { command: resolvedCommand, args: resolvedArgs };
  }

  const spec = args[yesIdx + 1];
  const metaPath = path.join(managedRoot, spec, '.install-meta.json');
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { entryPath?: string };
    if (meta.entryPath && statSync(meta.entryPath).isFile()) {
      resolvedCommand = 'node';
      resolvedArgs = [meta.entryPath];
      log.debug(
        { catalogId, spec, entryPath: meta.entryPath },
        'Using managed install for rebel-oss connector',
      );
    }
  } catch (metaError) {
    log.debug({ catalogId, spec, err: metaError }, 'No valid managed install found, falling back to npx');
  }

  return { command: resolvedCommand, args: resolvedArgs };
};

type BuildPayloadFromCatalogOptions = {
  email?: string;
  setupFields?: Record<string, string>;
  providerKeys?: ProviderKeys;
  workspacePath?: string;
  // HubSpot OAuth registration runs BEFORE accounts.json is written, so
  // getStoredScopeTier(email) intentionally throws ACCOUNT_NOT_FOUND.
  // Caller-supplied scopeTier becomes the fallback for resolveHubSpotScopeTierWithFallback.
  scopeTier?: HubSpotScopeTier;
};

export function buildPayloadFromCatalog(
  catalogEntry: CatalogPayloadEntry & { id: 'openai-image-generation' },
  options: BuildPayloadFromCatalogOptions,
): Promise<McpServerUpsertPayload | null>;
export function buildPayloadFromCatalog(
  catalogEntry: CatalogPayloadEntry,
  options: BuildPayloadFromCatalogOptions,
): Promise<McpServerUpsertPayload>;
/**
 * Build an `McpServerUpsertPayload` from a connector catalog entry.
 *
 * Routes based on `catalogEntry.provider`:
 * - **rebel-oss** → throws (externally built connectors must be installed manually)
 * - **bundled** → maps setupFields to `BuildBundledMcpOptions` and delegates to `buildBundledMcpPayload()`
 * - **direct / community with mcpConfig** → constructs payload from `mcpConfig` + env-var-mapped setup fields
 * - **community without mcpConfig but with a `url` setup field** → constructs HTTP payload from the URL
 * - Otherwise → throws with a clear error
 */
export async function buildPayloadFromCatalog(
  catalogEntry: CatalogPayloadEntry,
  options: BuildPayloadFromCatalogOptions,
): Promise<McpServerUpsertPayload | null> {
  // Trim whitespace from all provided field values (API keys often have trailing newlines)
  const providedFields: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.setupFields ?? {})) {
    providedFields[k] = v.trim();
  }
  const trimmedEmail = options.email?.trim() || undefined;

  // ── Rebel-OSS connectors: fall through to mcpConfig handling if present ───
  if (catalogEntry.provider === 'rebel-oss' && !catalogEntry.mcpConfig) {
    throw new Error(
      `Cannot auto-build payload for rebel-oss connector "${catalogEntry.id}". ` +
      'No mcpConfig defined. Add mcpConfig to the catalog entry or install the connector manually.'
    );
  }

  // ── Bundled connectors ─────────────────────────────────────
  if (catalogEntry.provider === 'bundled') {
    const serverName = catalogEntry.bundledConfig?.serverName;
    if (!serverName) {
      throw new Error(`Bundled catalog entry "${catalogEntry.id}" is missing bundledConfig.serverName`);
    }

    // Discourse connectors use --profile file auth (not env vars), so they need custom builders.
    // rebels-community-write: OAuth flow (discourseHandlers.ts owns registration after auth).
    // standalone discourse: profile written via settingsHandlers.ts before this is called.
    if (catalogEntry.id === 'rebels-community-write') {
      return buildDiscourseWritePayload();
    }
    if (catalogEntry.id === 'discourse') {
      return buildStandaloneDiscoursePayload({
        siteUrl: providedFields.siteUrl || '',
        apiKey: providedFields.apiKey || '',
        apiUsername: providedFields.apiUsername || '',
      });
    }
    // RebelAppBridge's state path uses "rebel-app-bridge" (with dashes),
    // matching the directory the core `createAppBridge` factory defaults
    // to. The generic path resolver would instead use the lowercased
    // server name ("rebelappbridge"), so we short-circuit here to keep
    // the bridge process and its MCP relay talking to the same state
    // file. The catalog entry stays registered so `isSelfConfiguringMcp`
    // lookups still succeed.
    if (catalogEntry.id === 'bundled-app-bridge') {
      return buildAppBridgePayload();
    }
    const bundledOptions: BuildBundledMcpOptions = {};

    // Pass shared provider keys for providerKeyMapping resolution
    if (options.providerKeys) {
      bundledOptions.providerKeys = options.providerKeys;
    }

    // Map email
    if (trimmedEmail) {
      bundledOptions.email = trimmedEmail;
    }

    // Map setupFields → BuildBundledMcpOptions
    if (providedFields.apiKey) {
      bundledOptions.apiKey = providedFields.apiKey;
    }

    // Credential-like keys → options.credentials
    // Known credential keys + any remaining provided fields
    const nonCredentialKeys = new Set(['apiKey', 'scopeTier']);
    const matchedCredentials: Record<string, string> = {};
    for (const [key, value] of Object.entries(providedFields)) {
      if (value && !nonCredentialKeys.has(key)) {
        matchedCredentials[key] = value;
      }
    }
    if (Object.keys(matchedCredentials).length > 0) {
      bundledOptions.credentials = matchedCredentials;
    }

    // Preserved post-migration (Stage 5): HubSpot npx payloads still require
    // HUBSPOT_SCOPE_TIER injection for readonly/full tool filtering.
    if (catalogEntry.bundledConfig?.authType === 'oauth' && serverName === 'HubSpot') {
      const instanceId = trimmedEmail
        ? generateInstanceId('HubSpot', trimmedEmail)
        : 'HubSpot';
      const resolvedScopeTier = await resolveHubSpotScopeTierWithFallback({
        instanceId,
        source: 'buildPayloadFromCatalog.bundled',
        accountEmail: trimmedEmail,
        fallbackScopeTier: options.scopeTier ?? providedFields.scopeTier,
      });
      if (resolvedScopeTier) {
        bundledOptions.scopeTier = resolvedScopeTier;
      }
    }

    const payload = await buildBundledMcpPayload(serverName, bundledOptions);
    payload.catalogId = catalogEntry.id;

    return payload;
  }

  // ── Direct / community connectors with mcpConfig ───────────
  if (catalogEntry.mcpConfig) {
    const mcpCfg = catalogEntry.mcpConfig;
    const transport = (mcpCfg.transport || mcpCfg.type || (mcpCfg.command ? 'stdio' : 'http')) as McpServerUpsertPayload['transport'];

    const env: Record<string, string> = { ...(mcpCfg.env ?? {}) };
    const headers: Record<string, string> = {};

    // Map setup fields to env vars / headers (overrides static mcpConfig.env)
    for (const field of catalogEntry.setupFields ?? []) {
      // Boolean fields fall back to their catalog default when the user has
      // never saved a value — otherwise an existing user upgrading to a
      // version that adds a new toggle would never see the configured default
      // reach the MCP runtime. Non-boolean fields keep the existing
      // "skip if undefined" behaviour because their defaults are typically
      // user-supplied secrets/URLs.
      const provided = providedFields[field.id];
      const value = field.type === 'boolean' ? (provided ?? field.default) : provided;
      if (value === undefined) continue;

      // Fields with headerKey go to headers (e.g., PostHog, DocuSign)
      if (field.headerKey) {
        if (field.type === 'boolean') continue; // booleans never become headers
        headers[field.headerKey] = field.headerPrefix
          ? `${field.headerPrefix}${value}`
          : value;
      } else if (field.envVar) {
        // Standard env-var mapping (community / rebel-oss connectors)
        if (catalogEntry.id === 'bamboohr' && field.envVar === 'BAMBOOHR_COMPANY_DOMAIN') {
          env[field.envVar] = normalizeSingleLabelSubdomainInput(value, 'bamboohr.com', 'BambooHR company subdomain');
        } else {
          env[field.envVar] = value;
        }
      }
    }

    // Wire the account-identity email into env if the bundledConfig requests it.
    // E.g., Email IMAP captures the email via the shared Account Email input
    // (not a setupField) but the upstream package reads process.env.EMAIL_IMAP_EMAIL.
    const accountIdentityEnvVar = catalogEntry.bundledConfig?.accountIdentityEnvVar;
    if (accountIdentityEnvVar && trimmedEmail) {
      env[accountIdentityEnvVar] = trimmedEmail;
    }

    // Preserved post-migration (Stage 5): HubSpot rebel-oss payloads still
    // require HUBSPOT_* env injection. The OSS package reads HUBSPOT_CONFIG_DIR
    // for accounts.json + credentials/, HUBSPOT_CLIENT_ID/SECRET for OAuth
    // exchange, and HUBSPOT_ACCOUNT_EMAIL to pick the right account in multi-
    // account installs.
    //
    // Refresh authority on desktop is the OSS subprocess itself: it silently
    // HTTP-refreshes via the stored refresh_token when an access token
    // expires. The cloud surface keeps HUBSPOT_DISABLE_REFRESH=1 in
    // discoverHubSpot (bundledMcpCloudRegistration.ts) so cloud subprocesses
    // defer to the desktop. The earlier "mirror discoverHubSpot here for
    // parity" assumption was wrong — see 260517 postmortem: injecting
    // DISABLE_REFRESH=1 on desktop caused every CRM call to return
    // auth_required once the access token (30-60 min TTL) expired, because
    // the host-side refresher the Stage 5 design implied was never built.
    const effectiveServerName = catalogEntry.bundledConfig?.serverName ?? catalogEntry.name;
    if (catalogEntry.provider === 'rebel-oss' && effectiveServerName === 'HubSpot') {
      const accountEmailFromEnv = typeof env.HUBSPOT_ACCOUNT_EMAIL === 'string'
        ? env.HUBSPOT_ACCOUNT_EMAIL.trim()
        : undefined;
      const instanceId = trimmedEmail
        ? generateInstanceId('HubSpot', trimmedEmail)
        : catalogEntry.name;
      const resolvedScopeTier = await resolveHubSpotScopeTierWithFallback({
        instanceId,
        source: 'buildPayloadFromCatalog.rebel_oss',
        accountEmail: trimmedEmail ?? accountEmailFromEnv,
        fallbackScopeTier: options.scopeTier ?? providedFields.scopeTier,
      });
      if (resolvedScopeTier) {
        env.HUBSPOT_SCOPE_TIER = resolvedScopeTier;
      }
      env.HUBSPOT_TELEMETRY_SALT = await getTelemetrySaltHex();

      env.HUBSPOT_CONFIG_DIR = getMcpConfigDir('HubSpot');
      env.HUBSPOT_SOURCE_LABEL = 'Mindstone Rebel';

      const resolvedEmail = trimmedEmail ?? accountEmailFromEnv;
      if (resolvedEmail) {
        env.HUBSPOT_ACCOUNT_EMAIL = resolvedEmail;
      }

      const oauthCreds = resolveOAuthCredentials(hubspotCredentialSource);
      if (oauthCreds) {
        env.HUBSPOT_CLIENT_ID = oauthCreds.clientId;
        env.HUBSPOT_CLIENT_SECRET = oauthCreds.clientSecret;
      } else {
        log.warn(
          { instanceId },
          'HubSpot OAuth credentials not available — subprocess will boot without HUBSPOT_CLIENT_ID/SECRET; OAuth refresh will require host orchestration',
        );
      }
    }

    let microsoftInstanceNameOverride: string | undefined;
    const microsoftServerName = MICROSOFT_SERVER_BASE_NAMES.find((name) => name === effectiveServerName);
    if (catalogEntry.provider === 'rebel-oss' && microsoftServerName) {
      if (!trimmedEmail) {
        throw new Error('Microsoft 365 payload requires email; refusing to fall back to catalogEntry.name');
      }

      microsoftInstanceNameOverride = generateInstanceId(microsoftServerName, trimmedEmail);
      env.MS_CONFIG_DIR = resolveMicrosoftConfigDirForPayload(env.MS_CONFIG_DIR);
      env.MS_MCP_PACKAGE_ID = microsoftInstanceNameOverride;
      env.MS_ACCOUNT_EMAIL = trimmedEmail;
      env.LOG_MODE = env.LOG_MODE ?? 'strict';

      const clientId =
        resolveMicrosoftClientIdForPayload(env.MS_CLIENT_ID) ??
        resolveMicrosoftClientId(microsoftCredentialSource) ??
        undefined;
      if (clientId) {
        env.MS_CLIENT_ID = clientId;
      } else {
        log.warn(
          { instanceId: microsoftInstanceNameOverride, catalogId: catalogEntry.id },
          'Microsoft OAuth credentials not available — subprocess will boot without MS_CLIENT_ID',
        );
      }
    }

    let googleWorkspaceInstanceName: string | undefined;
    if (catalogEntry.provider === 'rebel-oss' && effectiveServerName === 'GoogleWorkspace') {
      if (!trimmedEmail) {
        throw new Error('Google Workspace payload requires email; refusing to fall back to catalogEntry.name');
      }

      googleWorkspaceInstanceName = generateInstanceId('GoogleWorkspace', trimmedEmail);
      const instanceDir = getGoogleWorkspaceInstanceDir(googleWorkspaceInstanceName);
      env.ACCOUNTS_PATH = path.join(instanceDir, 'accounts.json');
      env.CREDENTIALS_PATH = path.join(instanceDir, 'credentials');
      env.MCP_MODE = env.MCP_MODE ?? 'true';
      env.LOG_MODE = env.LOG_MODE ?? 'strict';

      const oauthCreds = resolveOAuthCredentials(googleCredentialSource);
      if (oauthCreds) {
        env.GOOGLE_CLIENT_ID = oauthCreds.clientId;
        env.GOOGLE_CLIENT_SECRET = oauthCreds.clientSecret;
      } else {
        log.warn(
          { instanceId: googleWorkspaceInstanceName },
          'Google Workspace OAuth credentials not available — subprocess will boot without GOOGLE_CLIENT_ID/SECRET; OAuth refresh will require host orchestration',
        );
      }
    }

    // rebel-oss connectors: use base name (multi-account handled internally via accounts.json).
    // Office keeps its legacy router key because existing lifecycle hooks and backfill mapping
    // intentionally use the MCP server name ("RebelOffice"), not the catalog display name.
    const instanceName = catalogEntry.provider === 'rebel-oss'
      ? googleWorkspaceInstanceName
        ?? microsoftInstanceNameOverride
        ?? (catalogEntry.id === 'bundled-office'
        ? catalogEntry.bundledConfig?.serverName ?? catalogEntry.name
        : catalogEntry.name)
      : trimmedEmail
        ? generateInstanceId(catalogEntry.name, trimmedEmail)
        : catalogEntry.name;
    const description = trimmedEmail
      ? `${trimmedEmail} - ${catalogEntry.description ?? ''}`
      : (catalogEntry.description ?? null);

    // rebel-oss connectors: resolve platform-specific path placeholders in env vars
    if (catalogEntry.provider === 'rebel-oss') {
      const serverName = catalogEntry.bundledConfig?.serverName ?? catalogEntry.name;
      const configDir = getMcpConfigDir(serverName);
      const baseDir = getMcpConfigDir('');
      const ancestor = resolveSandboxAncestorLogged({
        surface: 'desktop-build',
        serverName,
        catalogId: catalogEntry.id,
      });
      const resolvedEnv = resolveEnvPlaceholders(env, configDir, baseDir, {
        ...(ancestor ? { ancestor } : {}),
      });
      const resolvedWithProviderKeys = applyProviderKeyMappingToEnv(
        resolvedEnv,
        catalogEntry.bundledConfig?.providerKeyMapping,
        options.providerKeys,
        'preserve',
      );
      Object.assign(env, resolvedWithProviderKeys);
    }

    // Prefer existing managed install over npx for rebel-oss connectors.
    // The startup auto-upgrade converts npx entries to managed installs
    // (command: "node" + absolute path). Without this check, disconnect/
    // reconnect would rebuild from the catalog's npx config, reverting the
    // upgrade and falling back to the slower npx runtime.
    const resolvedRuntime = catalogEntry.provider === 'rebel-oss'
      ? resolveManagedInstallForRebelOssRuntime(catalogEntry.id, mcpCfg)
      : { command: mcpCfg.command ?? null, args: mcpCfg.args ?? null };

    return {
      name: instanceName,
      transport,
      type: mcpCfg.type as McpServerUpsertPayload['type'],
      url: mcpCfg.url ?? null,
      command: resolvedRuntime.command,
      args: resolvedRuntime.args,
      description,
      catalogId: catalogEntry.id,
      email: trimmedEmail ?? null,
      oauth: mcpCfg.oauth ?? null,
      oauthParams: mcpCfg.oauthParams ?? null,
      oauthClientId: mcpCfg.oauthClientId ?? null,
      oauthClientSecret: mcpCfg.oauthClientSecret ?? null,
      env: Object.keys(env).length > 0 ? env : null,
      headers: Object.keys(headers).length > 0 ? headers : null,
      lastConnectedAt: Date.now(),
    };
  }

  // ── Community connector without mcpConfig but with a URL setup field ──
  if (catalogEntry.provider === 'community') {
    const urlField = (catalogEntry.setupFields ?? []).find((f) => f.id === 'url');
    const urlValue = urlField ? providedFields.url : undefined;
    if (urlValue) {
      const trimmedEmail = options.email?.trim() || undefined;
      const instanceName = trimmedEmail
        ? generateInstanceId(catalogEntry.name, trimmedEmail)
        : catalogEntry.name;
      const description = trimmedEmail
        ? `${trimmedEmail} - ${catalogEntry.description ?? ''}`
        : (catalogEntry.description ?? null);
      return {
        name: instanceName,
        transport: 'http',
        url: urlValue,
        description,
        catalogId: catalogEntry.id,
        email: trimmedEmail ?? null,
        lastConnectedAt: Date.now(),
      };
    }
  }

  // ── Fallback: cannot construct a payload ────────────────────
  throw new Error(
    `Cannot build payload for catalog entry "${catalogEntry.id}" (provider: ${catalogEntry.provider}): ` +
    'missing both mcpConfig and a URL setup field',
  );
}

export const writeRebelBridgeState = async (state: { port: number; token: string }): Promise<void> => {
  const target = bridgeStatePath();
  await ensureDirectory(target);
  await fs.writeFile(target, JSON.stringify(state), 'utf8');
};

export const extractManagedWrapperMetadata = (parsed: unknown): BundledWrapperMetadata | null => {
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const container = parsed as Record<string, unknown>;
  if (container.managedBy !== 'mindstone-rebel') {
    return null;
  }
  const managedWrapperRaw = container.managedWrapper;
  if (!managedWrapperRaw || typeof managedWrapperRaw !== 'object') {
    return null;
  }
  const managedWrapper = managedWrapperRaw as Record<string, unknown>;
  const sourcePath = typeof managedWrapper.sourcePath === 'string' ? managedWrapper.sourcePath : null;
  const version = typeof managedWrapper.version === 'number' ? managedWrapper.version : 1;
  return {
    sourcePath,
    version
  };
};

const ensureRebelServerInConfig = async (configPath: string): Promise<void> => {
  await upsertMcpServerEntry(configPath, buildRebelInternalPayload());
};

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await ensureDirectory(filePath);
  if (path.basename(filePath) === 'super-mcp-router.json') {
    await atomicCredentialWrite(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
    return;
  }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Migrate RebelTaskQueue to RebelInbox in an MCP config file.
 * This handles the rename from the old server name to the new one.
 * Returns true if migration was performed, false otherwise.
 */
export const migrateRebelTaskQueueToInbox = async (configPath: string): Promise<boolean> => {
  const parsed = await readJson(configPath);
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }

  const config = parsed as Record<string, unknown>;
  const serversRaw = config.mcpServers;
  if (!serversRaw || typeof serversRaw !== 'object') {
    return false;
  }
  const servers = serversRaw as Record<string, unknown>;

  // Check if RebelTaskQueue exists and RebelInbox doesn't
  if (!servers.RebelTaskQueue || servers.RebelInbox) {
    return false;
  }

  // Migrate: copy RebelTaskQueue config to RebelInbox and remove the old entry
  servers.RebelInbox = servers.RebelTaskQueue;
  delete servers.RebelTaskQueue;

  await writeJson(configPath, config);
  return true;
};

export const migrateLegacyWrapperSettingsIfNeeded = async (settings: AppSettings): Promise<AppSettings> => {
  const resolvedPath = resolveMcpConfigPath(settings);
  if (!resolvedPath) {
    return settings;
  }

  const parsed = await readJson(resolvedPath);
  const metadata = parsed ? extractManagedWrapperMetadata(parsed) : null;
  if (!metadata?.sourcePath) {
    return settings;
  }

  const sourcePath = metadata.sourcePath;
  try {
    await fs.access(sourcePath);
  } catch {
    return settings;
  }

  await ensureRebelServerInConfig(sourcePath);

  try {
    await fs.rm(resolvedPath, { recursive: false, force: true });
  } catch {
    // ignore cleanup failures
  }

  return {
    ...settings,
    mcpConfigFile: sourcePath
  };
};

/**
 * RebelWorkspace tool renames for userDisabledToolsByServer migration.
 * Maps old tool names to new rebel_<domain>_<verb>_<noun> pattern.
 * Mirrors WORKSPACE_TOOL_RENAMES_V3 in toolUsageStore.ts.
 */
const WORKSPACE_TOOL_RENAMES: Record<string, string> = {
  'rebel_describe_environment': 'rebel_internal_get_environment',
  'rebel_get_space_config': 'rebel_spaces_get_config',
  'rebel_update_space_config': 'rebel_spaces_update_config',
  'rebel_create_space': 'rebel_spaces_create',
  'rebel_conversation_search': 'rebel_conversations_search',
  'rebel_conversation_get': 'rebel_conversations_export_full',
  'rebel_conversations_get': 'rebel_conversations_export_full',
  'rebel_get_settings': 'rebel_settings_get',
  'rebel_update_settings': 'rebel_settings_update',
  'rebel_get_transcription_vocabulary': 'rebel_vocabulary_get',
  'rebel_update_transcription_vocabulary': 'rebel_vocabulary_update',
  'rebel_connector_catalog_search': 'rebel_mcp_search_connectors',
  'rebel_connector_catalog_get': 'rebel_mcp_get_connector',
};

/**
 * Migrate from legacy internal MCP servers to the consolidated RebelInternal server.
 * 
 * This migration:
 * 1. Removes old server entries: RebelInbox, RebelAutomations, RebelMeetings, RebelWorkspace, RebelSearch
 * 2. Migrates userDisabledToolsByServer entries to RebelInternal (preserves user preferences)
 *
 * This migration is safe to run multiple times (idempotent).
 *
 * @param configPath - Path to the MCP config file (should be userData router config, not external)
 * @returns Object with removed server names and migrated tool count
 */
export const migrateToRebelInternal = async (configPath: string): Promise<{ removed: string[]; migratedTools: number }> => {
  const parsed = await readJson(configPath);
  if (!parsed || typeof parsed !== 'object') {
    return { removed: [], migratedTools: 0 };
  }

  const config = parsed as Record<string, unknown>;
  const serversRaw = config.mcpServers;
  
  let changed = false;
  const removed: string[] = [];
  let migratedTools = 0;

  // Part 1: Remove legacy server entries from mcpServers
  if (serversRaw && typeof serversRaw === 'object') {
    const servers = serversRaw as Record<string, unknown>;
    for (const serverName of LEGACY_INTERNAL_SERVER_NAMES) {
      if (servers[serverName]) {
        delete servers[serverName];
        removed.push(serverName);
        changed = true;
      }
    }
  }

  // Part 2: Migrate userDisabledToolsByServer entries
  const disabledByServerRaw = config.userDisabledToolsByServer;
  if (disabledByServerRaw && typeof disabledByServerRaw === 'object' && !Array.isArray(disabledByServerRaw)) {
    const disabledByServer = disabledByServerRaw as Record<string, unknown>;
    const newDisabledTools: string[] = [];

    for (const serverName of LEGACY_INTERNAL_SERVER_NAMES) {
      const disabledTools = disabledByServer[serverName];
      if (Array.isArray(disabledTools)) {
        for (const toolName of disabledTools) {
          // Apply tool rename if applicable (for RebelWorkspace tools)
          const renamedTool = WORKSPACE_TOOL_RENAMES[toolName as string] ?? toolName;
          if (!newDisabledTools.includes(renamedTool as string)) {
            newDisabledTools.push(renamedTool as string);
            migratedTools++;
          }
        }
        delete disabledByServer[serverName];
        changed = true;
      }
    }

    // Add migrated tools to RebelInternal
    if (newDisabledTools.length > 0) {
      const existingInternalDisabled = Array.isArray(disabledByServer['RebelInternal']) 
        ? disabledByServer['RebelInternal'] as string[]
        : [];
      disabledByServer['RebelInternal'] = [
        ...new Set([...existingInternalDisabled, ...newDisabledTools])
      ];
    }

    // Clean up empty object
    if (Object.keys(disabledByServer).length === 0) {
      delete config.userDisabledToolsByServer;
      changed = true;
    }
  }

  if (!changed) {
    return { removed: [], migratedTools: 0 };
  }

  await writeJson(configPath, config);
  return { removed, migratedTools };
};

// ============================================================
// RebelInternal → 7-MCP Split Migration
// ============================================================

/**
 * Tool prefix mapping for migrating userDisabledToolsByServer from RebelInternal to split MCPs.
 * Maps RebelInternal tool prefixes to their new server name.
 */
const DISABLED_TOOL_MIGRATION_V4: Record<string, string> = {
  'rebel_inbox_': 'RebelInbox',
  'rebel_meetings_': 'RebelMeetings',
  'rebel_search_': 'RebelSearchAndConversations',
  'rebel_conversations_': 'RebelSearchAndConversations',
  'rebel_automations_': 'RebelAutomations',
  'rebel_spaces_': 'RebelSpaces',
  'rebel_settings_': 'RebelSettings',
  'rebel_internal_get_environment': 'RebelSettings',
  'rebel_vocabulary_': 'RebelSettings',
  'rebel_usecases_': 'RebelSettings',
  'rebel_mcp_': 'RebelMcpConnectors',
};

/**
 * Determine which split MCP a tool belongs to based on its name.
 */
const getTargetServerForTool = (toolName: string): string | null => {
  // Check for exact match first (for rebel_internal_get_environment)
  if (toolName in DISABLED_TOOL_MIGRATION_V4) {
    return DISABLED_TOOL_MIGRATION_V4[toolName];
  }
  // Check prefix matches
  for (const [prefix, targetServer] of Object.entries(DISABLED_TOOL_MIGRATION_V4)) {
    if (toolName.startsWith(prefix)) {
      return targetServer;
    }
  }
  return null;
};

/**
 * Migrate from consolidated RebelInternal to the 7-MCP split architecture.
 * 
 * This migration:
 * 1. Removes the RebelInternal server entry from mcpServers
 * 2. Migrates userDisabledToolsByServer entries from RebelInternal to appropriate split servers
 *    - rebel_inbox_* → RebelInbox
 *    - rebel_meetings_* → RebelMeetings
 *    - rebel_search_*, rebel_conversations_* → RebelSearchAndConversations
 *    - rebel_automations_* → RebelAutomations
 *    - rebel_spaces_* → RebelSpaces
 *    - rebel_settings_*, rebel_internal_get_environment, rebel_vocabulary_*, rebel_usecases_* → RebelSettings
 *    - rebel_mcp_* → RebelMcpConnectors
 *
 * This migration is safe to run multiple times (idempotent).
 *
 * @param configPath - Path to the MCP config file (should be userData router config, not external)
 * @returns Object with whether RebelInternal was removed and count of migrated disabled tools
 */
export const migrateRebelInternalToSplit = async (configPath: string): Promise<{ removedRebelInternal: boolean; migratedTools: number }> => {
  const parsed = await readJson(configPath);
  if (!parsed || typeof parsed !== 'object') {
    return { removedRebelInternal: false, migratedTools: 0 };
  }

  const config = parsed as Record<string, unknown>;
  const serversRaw = config.mcpServers;
  
  let changed = false;
  let removedRebelInternal = false;
  let migratedTools = 0;

  // Part 1: Remove RebelInternal from mcpServers if present
  if (serversRaw && typeof serversRaw === 'object') {
    const servers = serversRaw as Record<string, unknown>;
    if (servers['RebelInternal']) {
      delete servers['RebelInternal'];
      removedRebelInternal = true;
      changed = true;
    }
  }

  // Part 2: Migrate userDisabledToolsByServer entries from RebelInternal to split servers
  const disabledByServerRaw = config.userDisabledToolsByServer;
  if (disabledByServerRaw && typeof disabledByServerRaw === 'object' && !Array.isArray(disabledByServerRaw)) {
    const disabledByServer = disabledByServerRaw as Record<string, unknown>;
    const rebelInternalDisabled = disabledByServer['RebelInternal'];
    
    if (Array.isArray(rebelInternalDisabled) && rebelInternalDisabled.length > 0) {
      // Group tools by their target server
      const toolsByServer: Record<string, string[]> = {};
      
      for (const toolName of rebelInternalDisabled) {
        const targetServer = getTargetServerForTool(toolName as string);
        if (targetServer) {
          if (!toolsByServer[targetServer]) {
            toolsByServer[targetServer] = [];
          }
          toolsByServer[targetServer].push(toolName as string);
          migratedTools++;
        }
        // If no target server found, the tool is dropped (unknown tool)
      }

      // Add migrated tools to their respective servers
      for (const [serverName, tools] of Object.entries(toolsByServer)) {
        const existingDisabled = Array.isArray(disabledByServer[serverName]) 
          ? disabledByServer[serverName] as string[]
          : [];
        disabledByServer[serverName] = [...new Set([...existingDisabled, ...tools])];
      }

      // Remove RebelInternal entry
      delete disabledByServer['RebelInternal'];
      changed = true;
    }

    // Clean up empty object
    if (Object.keys(disabledByServer).length === 0) {
      delete config.userDisabledToolsByServer;
      changed = true;
    }
  }

  if (!changed) {
    return { removedRebelInternal: false, migratedTools: 0 };
  }

  await writeJson(configPath, config);
  return { removedRebelInternal, migratedTools };
};

// ============================================================
// RebelSearch → RebelSearchAndConversations Migration
// ============================================================

/**
 * Migrate from RebelSearch to RebelSearchAndConversations in MCP config.
 * 
 * This migration handles the rename from the old server name to the new one.
 * It is idempotent and safe to run multiple times.
 * 
 * Detection: Only migrates if RebelSearch is the internal entry (args contain
 * path segment like /mcp/rebel-search/, supports both / and \\ separators).
 * User-defined custom servers named RebelSearch are preserved entirely.
 * 
 * Actions (only when internal RebelSearch detected):
 * 1. Removes mcpServers.RebelSearch (path no longer exists)
 * 2. Migrates userDisabledToolsByServer.RebelSearch tools to RebelSearchAndConversations
 * 3. Replaces RebelSearch in disabledServers array with RebelSearchAndConversations
 * 
 * @param configPath - Path to the MCP config file
 * @returns Object with migration results
 */
export const migrateRebelSearchToRebelSearchAndConversations = async (
  configPath: string
): Promise<{ removedRebelSearch: boolean; migratedTools: number; updatedDisabledServers: boolean }> => {
  const parsed = await readJson(configPath);
  if (!parsed || typeof parsed !== 'object') {
    return { removedRebelSearch: false, migratedTools: 0, updatedDisabledServers: false };
  }

  const config = parsed as Record<string, unknown>;
  const serversRaw = config.mcpServers;

  // Helper to detect if this is the internal RebelSearch (not a user-defined one)
  const isInternalRebelSearch = (): boolean => {
    if (!serversRaw || typeof serversRaw !== 'object') {
      return false;
    }
    const servers = serversRaw as Record<string, unknown>;
    if (!servers['RebelSearch']) {
      return false;
    }
    const entry = servers['RebelSearch'] as Record<string, unknown>;
    const args = entry.args;
    if (!Array.isArray(args) || args.length === 0) {
      return false;
    }
    // Check if the first arg contains /mcp/rebel-search/ path segment
    // Support both forward slashes and backslashes for cross-platform
    const firstArg = String(args[0]);
    return /[/\\]mcp[/\\]rebel-search[/\\]/.test(firstArg);
  };

  // Safety gate: Only proceed if this is the internal RebelSearch entry.
  // User-defined custom servers named RebelSearch should NOT be touched.
  if (!isInternalRebelSearch()) {
    return { removedRebelSearch: false, migratedTools: 0, updatedDisabledServers: false };
  }

  // servers is guaranteed to exist and be an object by isInternalRebelSearch()
  const servers = serversRaw as Record<string, unknown>;
  let removedRebelSearch = false;
  let migratedTools = 0;
  let updatedDisabledServers = false;

  // Part 1: Remove internal RebelSearch from mcpServers (path no longer exists)
  delete servers['RebelSearch'];
  removedRebelSearch = true;

  // Part 2: Migrate userDisabledToolsByServer entries
  const disabledByServerRaw = config.userDisabledToolsByServer;
  if (disabledByServerRaw && typeof disabledByServerRaw === 'object' && !Array.isArray(disabledByServerRaw)) {
    const disabledByServer = disabledByServerRaw as Record<string, unknown>;
    const rebelSearchDisabled = disabledByServer['RebelSearch'];
    
    if (Array.isArray(rebelSearchDisabled) && rebelSearchDisabled.length > 0) {
      // Get existing tools for the new server name
      const existingDisabled = Array.isArray(disabledByServer['RebelSearchAndConversations'])
        ? disabledByServer['RebelSearchAndConversations'] as string[]
        : [];
      
      // Count existing before merge (for accurate migratedTools count)
      const existingSet = new Set(existingDisabled);
      
      // Merge tools, deduplicating
      const mergedTools = [...new Set([...existingDisabled, ...rebelSearchDisabled as string[]])];
      
      // migratedTools = number of tools newly added (not already in existing)
      migratedTools = mergedTools.length - existingSet.size;
      
      disabledByServer['RebelSearchAndConversations'] = mergedTools;
      delete disabledByServer['RebelSearch'];
    }

    // Clean up empty object
    if (Object.keys(disabledByServer).length === 0) {
      delete config.userDisabledToolsByServer;
    }
  }

  // Part 3: Update disabledServers array
  const disabledServers = config.disabledServers;
  if (Array.isArray(disabledServers) && disabledServers.includes('RebelSearch')) {
    // Replace RebelSearch with RebelSearchAndConversations, dedupe
    const filtered = (disabledServers as string[]).filter((s: string) => s !== 'RebelSearch');
    if (!filtered.includes('RebelSearchAndConversations')) {
      filtered.push('RebelSearchAndConversations');
    }
    
    if (filtered.length === 0) {
      delete config.disabledServers;
    } else {
      config.disabledServers = filtered;
    }
    updatedDisabledServers = true;
  }

  await writeJson(configPath, config);
  return { removedRebelSearch, migratedTools, updatedDisabledServers };
};

// ============================================================
// Cloud Path Rewriting
// ============================================================

/**
 * Rewrite path-dependent fields in bundled MCP entries for the cloud environment.
 *
 * When desktop syncs its MCP config to cloud, bundled MCP entries contain
 * desktop-local absolute paths. This function rewrites them using the cloud's
 * configured resolvers (set via configureBundledMcpManager at startup).
 *
 * Identifies bundled MCPs by matching catalogId against BUNDLED_MCP_CATALOG.
 * Preserves all non-path config (credentials, description, disabled tools, etc.).
 *
 * @param mcpServers — The mcpServers record from the synced config (mutated in place)
 * @returns Number of server entries rewritten
 */

// ============================================================
// Bundled → NPX Migration (rebel-oss)
// ============================================================

export interface MigrationResult {
  migrated: Array<{ catalogId: string; oldNames: string[]; newName: string }>;
  skipped: Array<{ catalogId: string; reason: string }>;
}

/**
 * Migrate ALL legacy bundled connector entries from local `node` to `npx` (rebel-oss packages).
 *
 * Catalog-driven: automatically detects any connector where the catalog has
 * `provider === "rebel-oss"` with a valid `mcpConfig` (command + args), and the user's
 * config still has `command: "node"` entries for that catalogId.
 *
 * For each connector group (by catalogId):
 * - Picks the best candidate (latest `lastConnectedAt`) for identity field preservation
 * - Deletes ALL stale `command: "node"` entries for that catalogId
 * - Creates a single `npx` entry using the catalog's mcpConfig
 * - Migrates `userDisabledToolsByServer` and `disabledServers` from old names to new name
 *
 * Idempotent: safe to run on every startup.
 *
 * IMPORTANT: Runs in the sequential startup chain AFTER initCoreServices
 * (requires configureBundledMcpManager to resolve the connector catalog path).
 * Do not call from concurrent code paths — config file mutations are not locked.
 */
export const migrateBundledConnectorsToNpx = async (
  configPath: string,
  providerKeys?: ProviderKeys,
): Promise<MigrationResult> => {
  const result: MigrationResult = { migrated: [], skipped: [] };

  const parsed = await readJson(configPath);
  if (!parsed || typeof parsed !== 'object') {
    log.debug('migrateBundledConnectorsToNpx: no config found');
    return result;
  }

  const config = parsed as Record<string, unknown>;
  const serversRaw = config.mcpServers;
  if (!serversRaw || typeof serversRaw !== 'object') {
    log.debug('migrateBundledConnectorsToNpx: no mcpServers');
    return result;
  }

  const servers = serversRaw as Record<string, Record<string, unknown>>;

  // Read connector catalog to build rebel-oss lookup
  type CatalogEntry = {
    id?: string;
    name?: string;
    provider?: string;
    bundledConfig?: { serverName?: string; providerKeyMapping?: Partial<Record<string, ProviderKeyId>> };
    mcpConfig?: { command?: string; args?: string[]; env?: Record<string, string> };
  };
  let connectors: CatalogEntry[];
  try {
    const catalogRaw = JSON.parse(await fs.readFile(resolveConnectorCatalogPath(), 'utf8'));
    connectors = (catalogRaw?.connectors ?? []) as CatalogEntry[];
  } catch {
    log.warn('migrateBundledConnectorsToNpx: failed to read connector catalog, skipping');
    return result;
  }

  // Build lookup: catalogId → catalogEntry (rebel-oss with valid mcpConfig only)
  const rebelOssLookup = new Map<string, CatalogEntry>();
  for (const entry of connectors) {
    if (
      entry.id &&
      entry.name &&
      entry.provider === 'rebel-oss' &&
      entry.mcpConfig?.command &&
      entry.mcpConfig?.args?.length
    ) {
      rebelOssLookup.set(entry.id, entry);
    }
  }

  if (rebelOssLookup.size === 0) {
    return result;
  }

  // Managed-install entries also set `command === "node"` but point at an
  // absolute path under the managed installs root. Skip them so this migration
  // does not revert a managed install back to npx on every startup.
  const managedInstallsRoot = resolveManagedInstallsRoot(requireConfig().userDataDir);

  // Group user's legacy entries by catalogId. Two legacy shapes are recognised:
  //   1. command:"node" stdio entries — the original bundled stdio MCP shape.
  //   2. type:"http" + loopback url + no command — the bundled-HTTP-child shape
  //      produced by buildBundledHttpMcpPayload (only openai-image historically).
  // Managed-install entries (command:"node" + absolute path under userData/mcp/managed-installs)
  // are excluded so this migration does not revert managed installs back to npx on every startup.
  // Future agents: do NOT narrow this back to command === 'node' without checking whether any
  // bundled connector still ships as an HTTP child — see buildBundledHttpMcpPayload.
  // See docs/plans/260519_openai_image_http_legacy_migration_gap.md
  const legacyGroups = new Map<string, Array<{ key: string; entry: Record<string, unknown> }>>();
  for (const [key, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== 'object') continue;
    const catalogId = entry.catalogId;
    if (typeof catalogId !== 'string' || !rebelOssLookup.has(catalogId)) continue;

    if (entry.command === 'node' && isManagedInstallEntry(entry, managedInstallsRoot)) {
      log.debug(
        { key, catalogId, managedInstallsRoot },
        'migrateBundledConnectorsToNpx: skipping managed-install entry',
      );
      continue;
    }

    const isLegacyStdioNode = entry.command === 'node';
    const isLegacyBundledHttp =
      entry.command === undefined &&
      entry.type === 'http' &&
      typeof entry.url === 'string' &&
      (entry.url.startsWith('http://127.0.0.1:') ||
        entry.url.startsWith('http://localhost:') ||
        entry.url.startsWith('http://[::1]:'));
    if (!isLegacyStdioNode && !isLegacyBundledHttp) continue;

    let group = legacyGroups.get(catalogId);
    if (!group) {
      group = [];
      legacyGroups.set(catalogId, group);
    }
    group.push({ key, entry });
  }

  const npxOnlyGroups = new Map<string, Array<{ key: string; entry: Record<string, unknown> }>>();
  for (const [key, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== 'object') continue;
    const catalogId = entry.catalogId;
    if (typeof catalogId !== 'string' || !rebelOssLookup.has(catalogId)) continue;
    if (legacyGroups.has(catalogId)) continue;
    if (entry.command !== 'npx') continue;

    const providerKeyMapping = rebelOssLookup.get(catalogId)?.bundledConfig?.providerKeyMapping;
    if (!providerKeyMapping || Object.keys(providerKeyMapping).length === 0) continue;

    const env = entry.env;
    if (!env || typeof env !== 'object' || Array.isArray(env)) continue;
    const envRecord = env as Record<string, unknown>;
    const hasResolvableProviderSlot = Object.keys(providerKeyMapping).some((envKey) => {
      const envValue = envRecord[envKey];
      return typeof envValue === 'string' && isProviderKeyPlaceholderSlot(envValue, envKey);
    });
    if (!hasResolvableProviderSlot) continue;

    let group = npxOnlyGroups.get(catalogId);
    if (!group) {
      group = [];
      npxOnlyGroups.set(catalogId, group);
    }
    group.push({ key, entry });
  }

  if (legacyGroups.size === 0 && npxOnlyGroups.size === 0) {
    return result;
  }

  const mcpBaseDir = path.dirname(configPath);
  let changed = false;

  const reconcileExistingNpxEntry = (
    catalogId: string,
    configEntry: string,
    existingEntry: Record<string, unknown>,
    catalogEntry: CatalogEntry,
  ): boolean => {
    const serverName = catalogEntry.bundledConfig?.serverName ?? catalogEntry.name ?? configEntry;
    const configDir = path.join(mcpBaseDir, serverName.toLowerCase());
    const baseDir = mcpBaseDir;

    const existingEnvRaw =
      existingEntry.env && typeof existingEntry.env === 'object' && !Array.isArray(existingEntry.env)
        ? (existingEntry.env as Record<string, unknown>)
        : {};

    const existingStringEnv: Record<string, string> = {};
    for (const [envKey, envValue] of Object.entries(existingEnvRaw)) {
      if (typeof envValue === 'string') {
        existingStringEnv[envKey] = envValue;
        continue;
      }
      if (envValue !== undefined) {
        log.warn(
          {
            catalogId,
            configEntry,
            envKey,
            valueType: envValue === null ? 'null' : typeof envValue,
          },
          'migrateBundledConnectorsToNpx: skipping non-string env value on existing npx entry',
        );
      }
    }

    const ancestor = resolveSandboxAncestor().ancestor;
    const resolvedEnv = resolveEnvPlaceholders(existingStringEnv, configDir, baseDir, {
      ...(ancestor ? { ancestor } : {}),
    });
    const finalEnv = applyProviderKeyMappingToEnv(
      resolvedEnv,
      catalogEntry.bundledConfig?.providerKeyMapping,
      providerKeys,
      'preserve',
    );

    const normalizedExistingEnv = Object.keys(existingStringEnv).length > 0
      ? existingStringEnv
      : undefined;
    const normalizedFinalEnv = Object.keys(finalEnv).length > 0
      ? finalEnv
      : undefined;

    if (areEnvRecordsEqual(normalizedExistingEnv, normalizedFinalEnv)) {
      return false;
    }

    const preservedNonStringEnv = Object.entries(existingEnvRaw).reduce<Record<string, unknown>>((acc, [envKey, envValue]) => {
      if (typeof envValue !== 'string') {
        acc[envKey] = envValue;
      }
      return acc;
    }, {});

    const mergedEnv: Record<string, unknown> = {
      ...preservedNonStringEnv,
      ...(normalizedFinalEnv ?? {}),
    };

    const updatedExisting = { ...existingEntry };
    if (Object.keys(mergedEnv).length > 0) {
      updatedExisting.env = mergedEnv;
    } else {
      delete updatedExisting.env;
    }
    servers[configEntry] = updatedExisting;
    return true;
  };

  const readGoogleWorkspaceAccountEmailsForLegacyEntry = async (
    key: string,
    entry: Record<string, unknown>,
  ): Promise<string[]> => {
    const emails = new Set<string>();
    const directEmail = typeof entry.email === 'string' ? entry.email.trim() : '';
    if (directEmail) {
      emails.add(directEmail);
    }

    const env = entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
      ? entry.env as Record<string, unknown>
      : {};
    const accountPathCandidates = [
      typeof env.ACCOUNTS_PATH === 'string' ? env.ACCOUNTS_PATH : undefined,
      path.join(getGoogleWorkspaceDataDir(), key, 'accounts.json'),
    ].filter((candidate): candidate is string => Boolean(candidate));

    for (const accountsPath of accountPathCandidates) {
      const accountsConfig = await readJson(accountsPath) as { accounts?: Array<{ email?: string }> } | null;
      for (const account of accountsConfig?.accounts ?? []) {
        const email = account.email?.trim();
        if (email) {
          emails.add(email);
        }
      }
    }

    if (emails.size === 0 && key.startsWith('GoogleWorkspace-')) {
      const parsedEmail = parseEmailFromSlug(key.slice('GoogleWorkspace-'.length));
      if (parsedEmail) {
        emails.add(parsedEmail);
      }
    }

    return [...emails];
  };

  for (const [catalogId, entries] of legacyGroups) {
    const catalogEntry = rebelOssLookup.get(catalogId);
    if (!catalogEntry?.name || !catalogEntry.mcpConfig?.command || !catalogEntry.mcpConfig?.args) continue;

    if (catalogId === 'bundled-google') {
      const legacyByEmail = new Map<string, { key: string; entry: Record<string, unknown> }>();
      const allEmails = new Set<string>();

      for (const entry of entries) {
        const emails = await readGoogleWorkspaceAccountEmailsForLegacyEntry(entry.key, entry.entry);
        for (const email of emails) {
          allEmails.add(email);
          const existing = legacyByEmail.get(email);
          const currentTs = typeof entry.entry.lastConnectedAt === 'number' ? entry.entry.lastConnectedAt : 0;
          const existingTs = typeof existing?.entry.lastConnectedAt === 'number' ? existing.entry.lastConnectedAt : 0;
          if (!existing || currentTs > existingTs) {
            legacyByEmail.set(email, entry);
          }
        }
      }

      const accountEmails = [...allEmails].sort();
      if (accountEmails.length === 0) {
        result.skipped.push({ catalogId, reason: 'Google Workspace accounts.json has no connected accounts' });
        continue;
      }

      const emailsByInstanceId = new Map<string, string[]>();
      for (const email of accountEmails) {
        const instanceId = generateInstanceId('GoogleWorkspace', email);
        const emails = emailsByInstanceId.get(instanceId) ?? [];
        emails.push(email);
        emailsByInstanceId.set(instanceId, emails);
      }

      const collidingInstanceIds = new Set<string>();
      for (const [instanceId, emails] of emailsByInstanceId) {
        if (emails.length <= 1) continue;
        collidingInstanceIds.add(instanceId);
        log.error(
          {
            event: 'google.sanitiser_collision',
            severity: 'security',
            catalogId,
            collidedSlug: instanceId,
            collidingEmailsHashed: emails.map(hashGoogleMigrationEmail),
          },
          'migrateBundledConnectorsToNpx: Google Workspace email-slug collision; skipping colliding accounts',
        );
        result.skipped.push({
          catalogId,
          reason: `Google Workspace email-slug collision for "${instanceId}"; skipped ${emails.length} accounts`,
        });
      }

      const migratedNamePairs: Array<{ oldName: string; newName: string }> = [];
      const preservedEnvKeys = [
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
        'ACCOUNTS_PATH',
        'CREDENTIALS_PATH',
        'MCP_MODE',
        'LOG_MODE',
        'ENABLE_GOOGLE_TASKS_FORMS',
      ] as const;

      for (const accountEmail of accountEmails) {
        const newName = generateInstanceId('GoogleWorkspace', accountEmail);
        if (collidingInstanceIds.has(newName)) {
          continue;
        }

        const legacy = legacyByEmail.get(accountEmail);
        if (!legacy) {
          result.skipped.push({ catalogId, reason: `No legacy Google Workspace entry found for instance "${newName}"` });
          continue;
        }

        const oldName = legacy.key;
        try {
          const existing = servers[newName];
          if (existing && typeof existing === 'object') {
            if (
              existing.catalogId === catalogId &&
              (existing.command === 'npx' || isManagedInstallEntry(existing, managedInstallsRoot))
            ) {
              if (oldName !== newName) {
                delete servers[oldName];
                migratedNamePairs.push({ oldName, newName });
                changed = true;
              }
              continue;
            }

            if (existing.catalogId !== catalogId && existing.catalogId !== undefined) {
              result.skipped.push({
                catalogId,
                reason: `destination "${newName}" owned by different catalogId: ${String(existing.catalogId)}`,
              });
              continue;
            }
          }

          const legacyEnvRaw = legacy.entry.env;
          const legacyEnv = legacyEnvRaw && typeof legacyEnvRaw === 'object' && !Array.isArray(legacyEnvRaw)
            ? legacyEnvRaw as Record<string, unknown>
            : {};
          if (typeof legacyEnv.GOOGLE_CLIENT_ID !== 'string' || legacyEnv.GOOGLE_CLIENT_ID.length === 0) {
            throw new Error('Legacy Google Workspace entry missing GOOGLE_CLIENT_ID');
          }
          if (typeof legacyEnv.GOOGLE_CLIENT_SECRET !== 'string' || legacyEnv.GOOGLE_CLIENT_SECRET.length === 0) {
            throw new Error('Legacy Google Workspace entry missing GOOGLE_CLIENT_SECRET');
          }

          const instanceDir = getGoogleWorkspaceInstanceDir(newName);
          const googleAncestor = resolveSandboxAncestor().ancestor;
          const resolvedEnv = resolveEnvPlaceholders(
            catalogEntry.mcpConfig.env ?? {},
            instanceDir,
            mcpBaseDir,
            { ...(googleAncestor ? { ancestor: googleAncestor } : {}) },
          );
          const finalEnv = applyProviderKeyMappingToEnv(
            resolvedEnv,
            catalogEntry.bundledConfig?.providerKeyMapping,
            providerKeys,
            'overwrite',
          );

          for (const key of preservedEnvKeys) {
            const value = legacyEnv[key];
            if (typeof value === 'string' && value.length > 0) {
              finalEnv[key] = value;
            }
          }
          finalEnv.ACCOUNTS_PATH = finalEnv.ACCOUNTS_PATH || path.join(instanceDir, 'accounts.json');
          finalEnv.CREDENTIALS_PATH = finalEnv.CREDENTIALS_PATH || path.join(instanceDir, 'credentials');

          const runtime = resolveManagedInstallForRebelOssRuntime(catalogId, catalogEntry.mcpConfig);
          servers[newName] = {
            name: newName,
            type: 'stdio',
            command: runtime.command,
            args: runtime.args,
            ...(Object.keys(finalEnv).length > 0 ? { env: finalEnv } : {}),
            description: legacy.entry.description,
            catalogId,
            email: accountEmail,
            lastConnectedAt: legacy.entry.lastConnectedAt,
          };

          if (oldName !== newName) {
            delete servers[oldName];
            migratedNamePairs.push({ oldName, newName });
          }

          changed = true;
          result.migrated.push({ catalogId, oldNames: [oldName], newName });
          log.info(
            { catalogId, oldName, newName },
            'migrateBundledConnectorsToNpx: migrated Google Workspace instance',
          );
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          log.error(
            { catalogId, accountHash: hashGoogleMigrationEmail(accountEmail), instanceId: newName, oldName, err: errMsg },
            'migrateBundledConnectorsToNpx: failed Google Workspace instance migration; preserving legacy entry',
          );
          result.skipped.push({ catalogId, reason: `Google Workspace instance migration failed for instance "${newName}": ${errMsg}` });
        }
      }

      if (config.userDisabledToolsByServer && typeof config.userDisabledToolsByServer === 'object') {
        const disabledByServer = config.userDisabledToolsByServer as Record<string, unknown>;
        for (const { oldName, newName } of migratedNamePairs) {
          const oldTools = disabledByServer[oldName];
          const newTools = disabledByServer[newName];
          if (Array.isArray(oldTools)) {
            const merged = new Set<string>(Array.isArray(newTools) ? newTools as string[] : []);
            for (const tool of oldTools) {
              if (typeof tool === 'string') {
                merged.add(tool);
              }
            }
            disabledByServer[newName] = [...merged];
            delete disabledByServer[oldName];
            changed = true;
          }
        }
      }

      if (Array.isArray(config.disabledServers)) {
        const disabledSet = new Set(config.disabledServers as string[]);
        for (const { oldName, newName } of migratedNamePairs) {
          if (disabledSet.delete(oldName)) {
            disabledSet.add(newName);
            changed = true;
          }
        }
        config.disabledServers = [...disabledSet];
      }

      continue;
    }

    const microsoftServerName = MICROSOFT_CATALOG_SERVER_BY_ID[catalogId];
    if (microsoftServerName) {
      const microsoftConfigDir = resolveMicrosoftConfigDirForPayload();
      const microsoftAccountsPath = path.join(microsoftConfigDir, 'accounts.json');
      const accountsConfig = await readJson(microsoftAccountsPath) as { accounts?: Array<{ email?: string }> } | null;
      const accountEmails = [...new Set(
        (accountsConfig?.accounts ?? [])
          .map((account) => account.email?.trim())
          .filter((email): email is string => Boolean(email)),
      )].sort();

      if (accountEmails.length === 0) {
        result.skipped.push({ catalogId, reason: 'Microsoft accounts.json has no connected accounts' });
        continue;
      }

      const isMicrosoftLegacyName = (name: string): boolean =>
        name === microsoftServerName || name.startsWith(`${microsoftServerName}-`);
      const parseLegacyEmail = (name: string, entry: Record<string, unknown>): string | undefined => {
        const directEmail = typeof entry.email === 'string' ? entry.email.trim() : '';
        if (directEmail) return directEmail;
        if (!name.startsWith(`${microsoftServerName}-`)) return undefined;
        return parseEmailFromSlug(name.slice(`${microsoftServerName}-`.length)) ?? undefined;
      };

      const legacyByEmail = new Map<string, { key: string; entry: Record<string, unknown> }>();
      for (const legacy of entries) {
        if (!isMicrosoftLegacyName(legacy.key)) continue;
        const email = parseLegacyEmail(legacy.key, legacy.entry);
        if (!email || !accountEmails.includes(email)) continue;
        const existing = legacyByEmail.get(email);
        const currentTs = typeof legacy.entry.lastConnectedAt === 'number' ? legacy.entry.lastConnectedAt : 0;
        const existingTs = typeof existing?.entry.lastConnectedAt === 'number' ? existing.entry.lastConnectedAt : 0;
        if (!existing || currentTs > existingTs) {
          legacyByEmail.set(email, legacy);
        }
      }

      const migratedNamePairs: Array<{ oldName: string; newName: string }> = [];
      const addMigratedNamePair = (oldName: string, newName: string): void => {
        if (oldName === newName) return;
        if (migratedNamePairs.some((pair) => pair.oldName === oldName && pair.newName === newName)) return;
        migratedNamePairs.push({ oldName, newName });
      };

      const migratedEmails = new Set<string>();
      const preservedEnvKeys = [
        'MICROSOFT_REQUEST_TIMEOUT_MS',
        'MICROSOFT_DISABLE_REFRESH',
        'MICROSOFT_ALLOW_CLOUD_REFRESH',
        'MS_CLIENT_ID',
        'MS_CONFIG_DIR',
        'MS_MCP_PACKAGE_ID',
        'MS_ACCOUNT_EMAIL',
        'LOG_MODE',
      ] as const;

      for (const accountEmail of accountEmails) {
        const newName = generateInstanceId(microsoftServerName, accountEmail);
        const legacy = legacyByEmail.get(accountEmail);
        const fallbackLegacy = legacy ?? entries.find((entry) => entry.key === microsoftServerName);
        const oldName = fallbackLegacy?.key;

        try {
          const existing = servers[newName];
          if (
            existing &&
            typeof existing === 'object' &&
            existing.catalogId === catalogId &&
            isManagedInstallEntry(existing, managedInstallsRoot)
          ) {
            if (oldName && oldName !== newName) {
              delete servers[oldName];
              addMigratedNamePair(oldName, newName);
              changed = true;
            }
            migratedEmails.add(accountEmail);
            continue;
          }

          const payload = await buildPayloadFromCatalog(
            catalogEntry as Parameters<typeof buildPayloadFromCatalog>[0],
            { email: accountEmail, providerKeys },
          );
          const payloadEnv = payload.env && typeof payload.env === 'object' ? { ...payload.env } : {};

          const legacyEnvRaw = fallbackLegacy?.entry.env;
          const legacyEnv = legacyEnvRaw && typeof legacyEnvRaw === 'object' && !Array.isArray(legacyEnvRaw)
            ? legacyEnvRaw as Record<string, unknown>
            : {};
          for (const key of preservedEnvKeys) {
            const value = legacyEnv[key];
            if (typeof value === 'string' && value.length > 0) {
              payloadEnv[key] = value;
            }
          }
          payloadEnv.MS_CONFIG_DIR = microsoftConfigDir;
          payloadEnv.MS_MCP_PACKAGE_ID = newName;
          payloadEnv.MS_ACCOUNT_EMAIL = accountEmail;
          payloadEnv.LOG_MODE = 'strict';

          servers[newName] = {
            ...payload,
            name: newName,
            catalogId,
            email: accountEmail,
            description: fallbackLegacy?.entry.description ?? payload.description,
            lastConnectedAt: fallbackLegacy?.entry.lastConnectedAt ?? payload.lastConnectedAt,
            env: Object.keys(payloadEnv).length > 0 ? payloadEnv : undefined,
          };

          if (oldName && oldName !== newName) {
            delete servers[oldName];
            addMigratedNamePair(oldName, newName);
          }

          migratedEmails.add(accountEmail);
          changed = true;
          result.migrated.push({ catalogId, oldNames: oldName ? [oldName] : [], newName });
          log.info(
            { catalogId, oldName, newName },
            'migrateBundledConnectorsToNpx: migrated Microsoft 365 instance',
          );
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          result.skipped.push({
            catalogId,
            reason: `Microsoft 365 instance migration failed for "${newName}": ${errMsg}`,
          });
          log.error(
            { catalogId, accountHash: hashGoogleMigrationEmail(accountEmail), instanceId: newName, err: errMsg },
            'migrateBundledConnectorsToNpx: failed Microsoft 365 instance migration',
          );
        }
      }

      for (const { key, entry } of entries) {
        if (!isMicrosoftLegacyName(key)) continue;
        const legacyEmail = parseLegacyEmail(key, entry);
        if (key === microsoftServerName && migratedEmails.size > 0) {
          delete servers[key];
          changed = true;
          continue;
        }
        if (!legacyEmail || !migratedEmails.has(legacyEmail)) continue;
        const targetName = generateInstanceId(microsoftServerName, legacyEmail);
        if (key !== targetName) {
          delete servers[key];
          addMigratedNamePair(key, targetName);
          changed = true;
        }
      }

      if (config.userDisabledToolsByServer && typeof config.userDisabledToolsByServer === 'object') {
        const disabledByServer = config.userDisabledToolsByServer as Record<string, unknown>;
        for (const { oldName, newName } of migratedNamePairs) {
          const oldTools = disabledByServer[oldName];
          const newTools = disabledByServer[newName];
          if (Array.isArray(oldTools)) {
            const merged = new Set<string>(Array.isArray(newTools) ? newTools as string[] : []);
            for (const tool of oldTools) {
              if (typeof tool === 'string') {
                merged.add(tool);
              }
            }
            disabledByServer[newName] = [...merged];
            delete disabledByServer[oldName];
            changed = true;
          }
        }
      }

      if (Array.isArray(config.disabledServers)) {
        const disabledSet = new Set(config.disabledServers as string[]);
        for (const { oldName, newName } of migratedNamePairs) {
          if (disabledSet.delete(oldName)) {
            disabledSet.add(newName);
            changed = true;
          }
        }
        config.disabledServers = [...disabledSet];
      }

      continue;
    }

    if (catalogId === 'bundled-hubspot') {
      const fallbackConfigDir = path.join(mcpBaseDir, 'hubspot');
      const hubspotConfigDir =
        entries
          .map((entry) => entry.entry.env)
          .find((env): env is Record<string, unknown> => typeof env === 'object' && env !== null)?.HUBSPOT_CONFIG_DIR;
      const resolvedHubSpotConfigDir = typeof hubspotConfigDir === 'string' && hubspotConfigDir.length > 0
        ? hubspotConfigDir
        : fallbackConfigDir;

      const hubspotAccountsPath = path.join(resolvedHubSpotConfigDir, 'accounts.json');
      const hubspotAccounts = await readJson(hubspotAccountsPath) as { accounts?: Array<{ email?: string; scopeTier?: HubSpotScopeTier }> } | null;
      const accountScopeByEmail = new Map<string, HubSpotScopeTier | undefined>();
      for (const account of hubspotAccounts?.accounts ?? []) {
        const email = account.email?.trim();
        if (!email) continue;
        accountScopeByEmail.set(email, account.scopeTier);
      }
      const accountEmails = [...new Set(
        [...accountScopeByEmail.keys()],
      )].sort();

      if (accountEmails.length === 0) {
        result.skipped.push({ catalogId, reason: 'HubSpot accounts.json has no connected accounts' });
        continue;
      }

      const legacyByEmail = new Map<string, { key: string; entry: Record<string, unknown> }>();
      for (const entry of entries) {
        const directEmail = typeof entry.entry.email === 'string' ? entry.entry.email.trim() : '';
        const matchedAccount = accountEmails.find((email) => generateInstanceId('HubSpot', email) === entry.key);
        const parsedEmail = matchedAccount ?? (entry.key.startsWith('HubSpot-')
          ? parseEmailFromSlug(entry.key.slice('HubSpot-'.length))
          : null);
        const email = directEmail || parsedEmail || '';
        if (!email) continue;

        const existing = legacyByEmail.get(email);
        const currentTs = typeof entry.entry.lastConnectedAt === 'number' ? entry.entry.lastConnectedAt : 0;
        const existingTs = typeof existing?.entry.lastConnectedAt === 'number' ? existing.entry.lastConnectedAt : 0;
        if (!existing || currentTs > existingTs) {
          legacyByEmail.set(email, entry);
        }
      }

      const migratedNamePairs: Array<{ oldName: string; newName: string }> = [];
      const preservedEnvKeys = [
        'HUBSPOT_CONFIG_DIR',
        'HUBSPOT_CLIENT_ID',
        'HUBSPOT_CLIENT_SECRET',
        'HUBSPOT_SCOPE_TIER',
        'HUBSPOT_SOURCE_LABEL',
      ] as const;

      for (const accountEmail of accountEmails) {
        const legacy = legacyByEmail.get(accountEmail);
        const accountScopeTier = accountScopeByEmail.get(accountEmail);
        const instanceId = generateInstanceId('HubSpot', accountEmail);
        if (!legacy) {
          emitHubSpotTelemetry({
            event: 'hubspot.migration.instance.skipped',
            accountEmail,
            instanceId,
            errorCode: 'missing_legacy_entry',
          }).catch((err) => {
            log.error({ err }, 'hubspot.telemetry_emit_failed');
          });
          result.skipped.push({ catalogId, reason: `No legacy HubSpot entry found for instance "${instanceId}"` });
          continue;
        }

        const oldName = legacy.key;
        const newName = instanceId;

        try {
          emitHubSpotTelemetry({
            event: 'hubspot.migration.instance.start',
            accountEmail,
            instanceId: newName,
          }).catch((err) => {
            log.error({ err }, 'hubspot.telemetry_emit_failed');
          });
          const existing = servers[newName];
          if (existing && typeof existing === 'object') {
            if (
              existing.catalogId === catalogId &&
              isManagedInstallEntry(existing, managedInstallsRoot)
            ) {
              if (oldName !== newName) {
                delete servers[oldName];
                migratedNamePairs.push({ oldName, newName });
                changed = true;
              }
              continue;
            }

            if (existing.catalogId !== catalogId && existing.catalogId !== undefined) {
              result.skipped.push({
                catalogId,
                reason: `destination "${newName}" owned by different catalogId: ${String(existing.catalogId)}`,
              });
              continue;
            }
          }

          const legacyEnvRaw = legacy.entry.env;
          const legacyEnv = typeof legacyEnvRaw === 'object' && legacyEnvRaw !== null
            ? legacyEnvRaw as Record<string, unknown>
            : {};
          if (typeof legacyEnv.HUBSPOT_CLIENT_ID !== 'string' || legacyEnv.HUBSPOT_CLIENT_ID.length === 0) {
            throw new Error('Legacy HubSpot entry missing HUBSPOT_CLIENT_ID');
          }
          if (typeof legacyEnv.HUBSPOT_CLIENT_SECRET !== 'string' || legacyEnv.HUBSPOT_CLIENT_SECRET.length === 0) {
            throw new Error('Legacy HubSpot entry missing HUBSPOT_CLIENT_SECRET');
          }
          const legacyConfigDir = typeof legacyEnv.HUBSPOT_CONFIG_DIR === 'string' && legacyEnv.HUBSPOT_CONFIG_DIR
            ? legacyEnv.HUBSPOT_CONFIG_DIR
            : resolvedHubSpotConfigDir;

          const hubspotAncestor = resolveSandboxAncestor().ancestor;
          const resolvedEnv = resolveEnvPlaceholders(
            catalogEntry.mcpConfig.env ?? {},
            legacyConfigDir,
            mcpBaseDir,
            { ...(hubspotAncestor ? { ancestor: hubspotAncestor } : {}) },
          );
          const finalEnv = applyProviderKeyMappingToEnv(
            resolvedEnv,
            catalogEntry.bundledConfig?.providerKeyMapping,
            providerKeys,
            'overwrite',
          );

          for (const key of preservedEnvKeys) {
            const value = legacyEnv[key];
            if (typeof value === 'string' && value.length > 0) {
              finalEnv[key] = value;
            }
          }

          let resolvedScopeTier: HubSpotScopeTier | undefined;
          try {
            resolvedScopeTier = await getStoredScopeTier(accountEmail);
          } catch (error) {
            const legacyScopeTier = typeof legacyEnv.HUBSPOT_SCOPE_TIER === 'string' &&
              (legacyEnv.HUBSPOT_SCOPE_TIER === 'readonly' || legacyEnv.HUBSPOT_SCOPE_TIER === 'full')
              ? legacyEnv.HUBSPOT_SCOPE_TIER
              : undefined;
            const fallbackScopeTier = accountScopeTier ?? legacyScopeTier;
            if (error instanceof HubSpotAuthError && error.code === 'ACCOUNT_NOT_FOUND' && !fallbackScopeTier) {
              throw new Error('no_scope_tier');
            }
            resolvedScopeTier = fallbackScopeTier;
            log.warn(
              { instanceId: newName, err: error instanceof Error ? error.message : String(error), fallbackScopeTier: resolvedScopeTier },
              'migrateBundledConnectorsToNpx: getStoredScopeTier failed; using migration fallback scope tier',
            );
          }
          if (resolvedScopeTier) {
            finalEnv.HUBSPOT_SCOPE_TIER = resolvedScopeTier;
          }
          finalEnv.HUBSPOT_SOURCE_LABEL = finalEnv.HUBSPOT_SOURCE_LABEL || 'Mindstone Rebel';
          finalEnv.HUBSPOT_TELEMETRY_SALT = await getTelemetrySaltHex();
          finalEnv.HUBSPOT_ACCOUNT_EMAIL = accountEmail;

          const runtime = resolveManagedInstallForRebelOssRuntime(catalogId, catalogEntry.mcpConfig);
          servers[newName] = {
            name: newName,
            type: 'stdio',
            command: runtime.command,
            args: runtime.args,
            ...(Object.keys(finalEnv).length > 0 ? { env: finalEnv } : {}),
            description: legacy.entry.description,
            catalogId,
            email: accountEmail,
            lastConnectedAt: legacy.entry.lastConnectedAt,
          };

          if (oldName !== newName) {
            delete servers[oldName];
            migratedNamePairs.push({ oldName, newName });
          }

          changed = true;
          result.migrated.push({ catalogId, oldNames: [oldName], newName });
          log.info(
            { catalogId, oldName, newName, hasScopeTier: Boolean(finalEnv.HUBSPOT_SCOPE_TIER) },
            'migrateBundledConnectorsToNpx: migrated HubSpot instance',
          );
          emitHubSpotTelemetry({
            event: 'hubspot.migration.instance.success',
            accountEmail,
            instanceId: newName,
          }).catch((err) => {
            log.error({ err }, 'hubspot.telemetry_emit_failed');
          });
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          let accountHash: string | undefined;
          try {
            accountHash = await deriveHubSpotAccountHash(accountEmail);
          } catch (hashError) {
            log.error({ err: hashError }, 'hubspot.account_hash_derive_failed');
          }
          log.error(
            { catalogId, accountHash, instanceId: newName, oldName, err: errMsg },
            'migrateBundledConnectorsToNpx: failed HubSpot instance migration; preserving legacy entry',
          );
          emitHubSpotTelemetry({
            event: 'hubspot.migration.instance.failed',
            accountEmail,
            instanceId: newName,
            errorCode: errMsg,
          }).catch((err) => {
            log.error({ err }, 'hubspot.telemetry_emit_failed');
          });
          result.skipped.push({ catalogId, reason: `HubSpot instance migration failed for instance "${newName}": ${errMsg}` });
        }
      }

      // Migrate userDisabledToolsByServer and disabledServers for renamed HubSpot entries.
      if (config.userDisabledToolsByServer && typeof config.userDisabledToolsByServer === 'object') {
        const disabledByServer = config.userDisabledToolsByServer as Record<string, unknown>;
        for (const { oldName, newName } of migratedNamePairs) {
          const oldTools = disabledByServer[oldName];
          const newTools = disabledByServer[newName];
          if (Array.isArray(oldTools)) {
            const merged = new Set<string>(Array.isArray(newTools) ? newTools as string[] : []);
            for (const tool of oldTools) {
              if (typeof tool === 'string') {
                merged.add(tool);
              }
            }
            disabledByServer[newName] = [...merged];
            delete disabledByServer[oldName];
            changed = true;
          }
        }
      }

      if (Array.isArray(config.disabledServers)) {
        const disabledSet = new Set(config.disabledServers as string[]);
        for (const { oldName, newName } of migratedNamePairs) {
          if (disabledSet.delete(oldName)) {
            disabledSet.add(newName);
            changed = true;
          }
        }
        config.disabledServers = [...disabledSet];
      }

      continue;
    }

    if (catalogId === 'bundled-slack') {
      // Multi-workspace Slack: each workspace has its own legacy entry keyed
      // by generateWorkspaceInstanceId('Slack', teamName) (e.g. "Slack-mindstone",
      // "Slack-acme"). The default branch below would collapse all workspaces
      // into a single 'Slack' entry by selecting one bestCandidate by
      // lastConnectedAt, dropping the other workspaces' SLACK_TEAM_ID + tokens
      // and orphaning them in token-file-only state. Iterate per-entry instead,
      // preserving each workspace's identity and full env.
      //
      // Note: unlike HubSpot, we don't read a separate accounts.json source-of-
      // truth file because each Slack legacy entry already carries its own
      // workspace identity in env.SLACK_TEAM_ID + the entry key's "Slack-<slug>"
      // suffix. Reading slack/config.json would only matter if we wanted to
      // create fresh entries for newly-OAuth'd workspaces with no prior legacy
      // entry — that's a forward-create concern, not a migration concern.
      const migratedNamePairs: Array<{ oldName: string; newName: string }> = [];
      const preservedEnvKeys = [
        'SLACK_BOT_TOKEN',
        'SLACK_USER_TOKEN',
        'SLACK_CONFIG_PATH',
        'SLACK_TEAM_ID',
        'SLACK_MCP_PACKAGE_ID',
        'SLACK_CLIENT_ID',
        'SLACK_CLIENT_SECRET',
      ] as const;

      for (const entry of entries) {
        const oldName = entry.key;
        const legacyEnvRaw = entry.entry.env;
        const legacyEnv = typeof legacyEnvRaw === 'object' && legacyEnvRaw !== null
          ? legacyEnvRaw as Record<string, unknown>
          : {};

        // The legacy entry's name follows 'Slack-<workspaceSlug>' (where slug
        // is the kebab-cased teamName). Preserving that name as the new name
        // keeps the cross-process identity stable for slackMentionAdapter,
        // settings UI, and disabled-tools mappings. Bare 'Slack' (no slug) is
        // a very-old single-workspace shape; promote it to the catalog name
        // for symmetry with the default branch.
        const workspaceSlug = oldName.startsWith('Slack-') ? oldName.slice('Slack-'.length) : '';
        const teamId = typeof legacyEnv.SLACK_TEAM_ID === 'string' ? legacyEnv.SLACK_TEAM_ID : '';
        if (!workspaceSlug && !teamId) {
          result.skipped.push({
            catalogId,
            reason: `Slack legacy entry "${oldName}" has neither workspace slug nor SLACK_TEAM_ID`,
          });
          continue;
        }
        const newName = workspaceSlug ? oldName : catalogEntry.name;

        // Destination collision check (mirrors HubSpot branch shape).
        const existing = servers[newName];
        if (existing && typeof existing === 'object') {
          if (
            existing.catalogId === catalogId &&
            isManagedInstallEntry(existing, managedInstallsRoot)
          ) {
            // Already migrated to a managed install — leave it authoritative,
            // just clean up the stale legacy entry if it still has a separate key.
            if (oldName !== newName) {
              delete servers[oldName];
              migratedNamePairs.push({ oldName, newName });
              changed = true;
            }
            continue;
          }
          if (existing.catalogId !== catalogId && existing.catalogId !== undefined) {
            result.skipped.push({
              catalogId,
              reason: `destination "${newName}" owned by different catalogId: ${String(existing.catalogId)}`,
            });
            continue;
          }
        }

        try {
          const botToken = typeof legacyEnv.SLACK_BOT_TOKEN === 'string' ? legacyEnv.SLACK_BOT_TOKEN : '';
          if (!botToken) {
            throw new Error('Legacy Slack entry missing SLACK_BOT_TOKEN');
          }

          const legacyConfigPath = typeof legacyEnv.SLACK_CONFIG_PATH === 'string' && legacyEnv.SLACK_CONFIG_PATH
            ? legacyEnv.SLACK_CONFIG_PATH
            : '';
          const slackConfigDir = legacyConfigPath
            ? path.dirname(legacyConfigPath)
            : path.join(mcpBaseDir, 'slack');

          const slackAncestor = resolveSandboxAncestor().ancestor;
          const resolvedEnv = resolveEnvPlaceholders(
            catalogEntry.mcpConfig.env ?? {},
            slackConfigDir,
            mcpBaseDir,
            { ...(slackAncestor ? { ancestor: slackAncestor } : {}) },
          );
          const finalEnv = applyProviderKeyMappingToEnv(
            resolvedEnv,
            catalogEntry.bundledConfig?.providerKeyMapping,
            providerKeys,
            'overwrite',
          );

          for (const key of preservedEnvKeys) {
            const value = legacyEnv[key];
            if (typeof value === 'string' && value.length > 0) {
              finalEnv[key] = value;
            }
          }

          // SLACK_MCP_PACKAGE_ID is the in-band identifier the OSS subprocess
          // uses to resolve its workspace; it must match the new instance name
          // so token lookups and bridge-state routing stay consistent if the
          // migration ever changes the name. In identity-preserving migrations
          // (workspaceSlug === oldName slug) this is a no-op.
          if (newName !== oldName) {
            finalEnv.SLACK_MCP_PACKAGE_ID = newName;
          }

          const runtime = resolveManagedInstallForRebelOssRuntime(catalogId, catalogEntry.mcpConfig);
          const migratedEntry: Record<string, unknown> = {
            name: newName,
            type: 'stdio',
            command: runtime.command,
            args: runtime.args,
            ...(Object.keys(finalEnv).length > 0 ? { env: finalEnv } : {}),
            description: entry.entry.description,
            catalogId,
            lastConnectedAt: entry.entry.lastConnectedAt,
          };
          if (typeof entry.entry.workspace === 'string') {
            migratedEntry.workspace = entry.entry.workspace;
          }
          servers[newName] = migratedEntry;

          if (oldName !== newName) {
            delete servers[oldName];
            migratedNamePairs.push({ oldName, newName });
          }

          changed = true;
          result.migrated.push({ catalogId, oldNames: [oldName], newName });
          log.info(
            { catalogId, oldName, newName, hasTeamId: Boolean(legacyEnv.SLACK_TEAM_ID) },
            'migrateBundledConnectorsToNpx: migrated Slack workspace',
          );
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          log.error(
            { catalogId, oldName, err: errMsg },
            'migrateBundledConnectorsToNpx: failed Slack workspace migration; preserving legacy entry',
          );
          result.skipped.push({
            catalogId,
            reason: `Slack workspace migration failed for "${oldName}": ${errMsg}`,
          });
        }
      }

      // Migrate userDisabledToolsByServer and disabledServers for renamed Slack entries.
      if (config.userDisabledToolsByServer && typeof config.userDisabledToolsByServer === 'object') {
        const disabledByServer = config.userDisabledToolsByServer as Record<string, unknown>;
        for (const { oldName, newName } of migratedNamePairs) {
          const oldTools = disabledByServer[oldName];
          const newTools = disabledByServer[newName];
          if (Array.isArray(oldTools)) {
            const merged = new Set<string>(Array.isArray(newTools) ? newTools as string[] : []);
            for (const tool of oldTools) {
              if (typeof tool === 'string') {
                merged.add(tool);
              }
            }
            disabledByServer[newName] = [...merged];
            delete disabledByServer[oldName];
            changed = true;
          }
        }
      }

      if (Array.isArray(config.disabledServers)) {
        const disabledSet = new Set(config.disabledServers as string[]);
        for (const { oldName, newName } of migratedNamePairs) {
          if (disabledSet.delete(oldName)) {
            disabledSet.add(newName);
            changed = true;
          }
        }
        config.disabledServers = [...disabledSet];
      }

      continue;
    }

    const newName = catalogId === 'bundled-office'
      ? catalogEntry.bundledConfig?.serverName ?? catalogEntry.name
      : catalogEntry.name;

    // Check destination collision
    const existing = servers[newName];
    let isExistingNpxForCatalog = false;
    if (existing && typeof existing === 'object') {
      if (existing.catalogId === catalogId && existing.command === 'npx') {
        // Already migrated — preserve user-customized env, but still delete stale node entries.
        log.debug({ catalogId, newName }, 'migrateBundledConnectorsToNpx: target already exists (npx), cleaning up legacy entries');
        isExistingNpxForCatalog = true;
      } else if (
        existing.catalogId === catalogId &&
        isManagedInstallEntry(existing, managedInstallsRoot)
      ) {
        // Same connector, already migrated to managed install — do NOT overwrite
        // the managed entry with npx. Clean up any stale legacy node entries for
        // this catalogId, but leave the managed entry authoritative.
        log.debug(
          { catalogId, newName },
          'migrateBundledConnectorsToNpx: target already exists (managed install), cleaning up legacy entries',
        );
        for (const { key } of entries) {
          if (key !== newName) delete servers[key];
        }
        changed = true;
        continue;
      } else if (existing.catalogId !== catalogId || !existing.catalogId) {
        // Different connector owns this name — skip entirely
        log.error(
          { catalogId, newName, existingCatalogId: existing.catalogId },
          'migrateBundledConnectorsToNpx: destination name collision, skipping',
        );
        result.skipped.push({ catalogId, reason: `destination "${newName}" owned by different catalogId: ${String(existing.catalogId ?? 'none')}` });
        continue;
      }
    }

    // Pick best candidate (latest lastConnectedAt) for identity preservation
    const oldNames = entries.map(e => e.key);
    let bestCandidate = entries[0];
    for (const e of entries) {
      const ts = typeof e.entry.lastConnectedAt === 'number' ? e.entry.lastConnectedAt : 0;
      const bestTs = typeof bestCandidate.entry.lastConnectedAt === 'number' ? bestCandidate.entry.lastConnectedAt : 0;
      if (ts > bestTs) bestCandidate = e;
    }

    const serverName = catalogEntry.bundledConfig?.serverName ?? catalogEntry.name;
    const configDir = path.join(mcpBaseDir, serverName.toLowerCase());
    const baseDir = mcpBaseDir;

    // Union env across ALL legacy entries (oldest first, then progressively newer
    // overwrite same-keys, with bestCandidate's env overlaid last so it wins ties).
    // This protects users where one legacy entry holds OAuth client credentials
    // (e.g. SALESFORCE_CLIENT_ID/SECRET) while a more-recently-used duplicate
    // doesn't — without this union the older entry is deleted and its creds lost.
    const sortedByTs = [...entries].sort((a, b) => {
      const aTs = typeof a.entry.lastConnectedAt === 'number' ? a.entry.lastConnectedAt : 0;
      const bTs = typeof b.entry.lastConnectedAt === 'number' ? b.entry.lastConnectedAt : 0;
      return aTs - bTs;
    });
    const unionedPreviousEnv: Record<string, string> = {};
    for (const e of sortedByTs) {
      const env = e.entry.env;
      if (env && typeof env === 'object' && !Array.isArray(env)) {
        for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
          if (typeof v === 'string') unionedPreviousEnv[k] = v;
        }
      }
    }
    if (bestCandidate.entry.env && typeof bestCandidate.entry.env === 'object' && !Array.isArray(bestCandidate.entry.env)) {
      for (const [k, v] of Object.entries(bestCandidate.entry.env as Record<string, unknown>)) {
        if (typeof v === 'string') unionedPreviousEnv[k] = v;
      }
    }

    if (isExistingNpxForCatalog && existing) {
      // Already-npx branch: preserve non-placeholder/non-empty values (user edits),
      // resolve placeholders only.
      if (reconcileExistingNpxEntry(catalogId, newName, existing, catalogEntry)) {
        changed = true;
      }
    } else {
      // Legacy entry branch (command:"node" stdio OR bundled HTTP-child shape):
      // preserve user-provided non-internal env from duplicate legacy entries,
      // then overwrite provider-key-mapped slots from the current shared
      // provider-key settings. HTTP-shape legacy entries have no `env`, so the
      // union is empty and provider-key placeholders resolve directly from
      // catalog `mcpConfig`. The fresh `servers[newName]` assignment below
      // drops any stale `url` field carried by the HTTP shape.
      const legacyAncestor = resolveSandboxAncestor().ancestor;
      const resolvedEnv = resolveEnvPlaceholders(
        catalogEntry.mcpConfig.env ?? {},
        configDir,
        baseDir,
        { ...(legacyAncestor ? { ancestor: legacyAncestor } : {}) },
      );
      const mergedEnv = mergePreservedUserEnv(unionedPreviousEnv, resolvedEnv);
      const finalEnv = applyProviderKeyMappingToEnv(
        mergedEnv,
        catalogEntry.bundledConfig?.providerKeyMapping,
        providerKeys,
        'overwrite',
      );

      const runtime = resolveManagedInstallForRebelOssRuntime(catalogId, catalogEntry.mcpConfig);
      servers[newName] = {
        name: newName,
        type: 'stdio',
        command: runtime.command,
        args: runtime.args,
        ...(Object.keys(finalEnv).length > 0 ? { env: finalEnv } : {}),
        description: bestCandidate.entry.description,
        catalogId,
        email: bestCandidate.entry.email,
        lastConnectedAt: bestCandidate.entry.lastConnectedAt,
      };
    }

    // Delete ALL stale node entries for this catalogId
    for (const { key } of entries) {
      if (key !== newName) {
        delete servers[key];
      } else {
        // Old entry has the same key as newName but command was "node" — already overwritten above
      }
    }

    // Migrate userDisabledToolsByServer: merge tools from all old names into newName
    if (config.userDisabledToolsByServer && typeof config.userDisabledToolsByServer === 'object') {
      const disabledByServer = config.userDisabledToolsByServer as Record<string, unknown>;
      const mergedTools = new Set<string>(
        Array.isArray(disabledByServer[newName]) ? disabledByServer[newName] as string[] : [],
      );
      for (const oldName of oldNames) {
        if (oldName === newName) continue;
        const tools = disabledByServer[oldName];
        if (Array.isArray(tools)) {
          for (const t of tools) mergedTools.add(t as string);
          delete disabledByServer[oldName];
        }
      }
      if (mergedTools.size > 0) {
        disabledByServer[newName] = [...mergedTools];
      }
    }

    // Migrate disabledServers array: remove all old names, add newName if any was disabled
    if (Array.isArray(config.disabledServers)) {
      const disabledSet = new Set(config.disabledServers as string[]);
      let anyDisabled = false;
      for (const oldName of oldNames) {
        if (disabledSet.has(oldName)) {
          anyDisabled = true;
          disabledSet.delete(oldName);
        }
      }
      if (anyDisabled) {
        disabledSet.add(newName);
      }
      config.disabledServers = [...disabledSet];
    }

    changed = true;
    result.migrated.push({ catalogId, oldNames, newName });
    log.info({ catalogId, oldNames, newName }, 'migrateBundledConnectorsToNpx: migrated connector');
  }

  // Stage 2a carry-over: resolve provider-key placeholders for already-migrated
  // npx entries even when there are no legacy node siblings left to migrate.
  for (const [catalogId, entries] of npxOnlyGroups) {
    const catalogEntry = rebelOssLookup.get(catalogId);
    if (!catalogEntry) continue;

    for (const { key, entry } of entries) {
      if (reconcileExistingNpxEntry(catalogId, key, entry, catalogEntry)) {
        changed = true;
      }
    }
  }

  if (changed) {
    await writeJson(configPath, config);
  }

  return result;
};

export interface HubSpotRefreshEnvPruneResult {
  pruned: Array<{ name: string; removed: string[] }>;
}

const STALE_HUBSPOT_REFRESH_ENV_KEYS = [
  'HUBSPOT_DISABLE_REFRESH',
  'HUBSPOT_ALLOW_CLOUD_REFRESH',
] as const;

const isManagedInstallOrNpxHubSpotEntry = (
  entry: Record<string, unknown>,
  managedInstallsRoot: string,
): boolean => {
  if (entry.catalogId !== 'bundled-hubspot') return false;
  if (entry.command === 'npx') return true;
  if (entry.command === 'node' && isManagedInstallEntry(entry, managedInstallsRoot)) return true;
  return false;
};

/**
 * Strip stale `HUBSPOT_DISABLE_REFRESH` / `HUBSPOT_ALLOW_CLOUD_REFRESH` env
 * keys from any HubSpot router entries left over from versions that injected
 * those keys on desktop (pre-260517 commits — see
 * `docs-private/postmortems/260517_hubspot_disable_refresh_desktop_bypass_postmortem.md`).
 *
 * Idempotent and safe to run on every startup. Covers both `npx`-shaped and
 * `node`-shaped managed-install HubSpot entries. Uses `upsertMcpServersBatch`
 * so the write is atomic and serialised with other config mutations.
 *
 * Why this exists: even after the two source writers were fixed
 * (`buildPayloadFromCatalog` and `discoverHubSpot`), users whose router
 * config was written by a buggy build keep the stale env until something
 * rewrites the entry. Reconnects do that eventually, but the OSS subprocess
 * boots with the stale env before the reconnect lands, so every CRM call
 * inside that window returns `auth_required/refresh_disabled`. Pruning
 * before the auto-upgrade sweep guarantees the OSS process spawns clean.
 *
 * Runs in the sequential startup chain AFTER `migrateBundledConnectorsToNpx`
 * and BEFORE `upgradeRebelOssEntriesToManaged` so a single startup pass
 * (migrate → prune → upgrade) leaves the entry in its final, refresh-enabled
 * managed-install form.
 */
export const pruneStaleHubSpotRefreshEnv = async (
  configPath: string,
): Promise<HubSpotRefreshEnvPruneResult> => {
  const result: HubSpotRefreshEnvPruneResult = { pruned: [] };

  const parsed = await readJson(configPath);
  if (!parsed || typeof parsed !== 'object') return result;

  const config = parsed as Record<string, unknown>;
  const serversRaw = config.mcpServers;
  if (!serversRaw || typeof serversRaw !== 'object') return result;
  const servers = serversRaw as Record<string, Record<string, unknown>>;

  const managedInstallsRoot = resolveManagedInstallsRoot(requireConfig().userDataDir);

  const payloads: McpServerUpsertPayload[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== 'object') continue;
    if (!isManagedInstallOrNpxHubSpotEntry(entry, managedInstallsRoot)) continue;

    const rawEnv = entry.env;
    if (!rawEnv || typeof rawEnv !== 'object' || Array.isArray(rawEnv)) continue;
    const envRecord = rawEnv as Record<string, unknown>;

    const removed: string[] = [];
    const cleanedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(envRecord)) {
      if ((STALE_HUBSPOT_REFRESH_ENV_KEYS as readonly string[]).includes(k)) {
        removed.push(k);
        continue;
      }
      if (typeof v === 'string') cleanedEnv[k] = v;
    }
    if (removed.length === 0) continue;

    const transport = entry.type === 'http' || entry.type === 'sse'
      ? (entry.type as 'http' | 'sse')
      : 'stdio';
    const args = Array.isArray(entry.args)
      ? (entry.args as unknown[]).filter((a): a is string => typeof a === 'string')
      : undefined;
    const command = typeof entry.command === 'string' ? entry.command : undefined;
    const description = typeof entry.description === 'string' ? entry.description : undefined;
    const catalogId = typeof entry.catalogId === 'string' ? entry.catalogId : undefined;
    const email = typeof entry.email === 'string' ? entry.email : undefined;
    const workspace = typeof entry.workspace === 'string' ? entry.workspace : undefined;

    const payload: McpServerUpsertPayload = {
      name,
      transport,
      ...(command ? { command } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      env: cleanedEnv,
      ...(description ? { description } : {}),
      ...(catalogId ? { catalogId } : {}),
      ...(email ? { email } : {}),
      ...(workspace ? { workspace } : {}),
    };
    payloads.push(payload);
    result.pruned.push({ name, removed });
  }

  if (payloads.length === 0) return result;

  await upsertMcpServersBatch(configPath, payloads);
  log.info(
    { count: result.pruned.length, entries: result.pruned },
    'pruneStaleHubSpotRefreshEnv: stripped stale HUBSPOT_DISABLE_REFRESH / HUBSPOT_ALLOW_CLOUD_REFRESH',
  );
  return result;
};

export function rewriteBundledMcpPathsForCloud(
  mcpServers: Record<string, Record<string, unknown>>
): number {
  // Build reverse lookup: catalogId → BundledMcpCatalogEntry
  const catalogByCatalogId = new Map<string, BundledMcpCatalogEntry>();
  for (const entry of Object.values(BUNDLED_MCP_CATALOG)) {
    catalogByCatalogId.set(entry.catalogId, entry);
  }

  let rewritten = 0;

  for (const serverEntry of Object.values(mcpServers)) {
    if (!serverEntry || typeof serverEntry !== 'object') continue;

    const catalogId = serverEntry.catalogId;
    if (typeof catalogId !== 'string' || !catalogId) continue;

    const entry = catalogByCatalogId.get(catalogId);
    if (!entry) continue;

    // Rewrite args[0] → script path from catalog resolver
    const args = serverEntry.args;
    if (Array.isArray(args) && args.length > 0) {
      args[0] = entry.scriptResolver();
    }

    // Rewrite env vars that contain paths
    const env = serverEntry.env;
    if (!env || typeof env !== 'object') {
      rewritten++;
      continue;
    }

    const envRecord = env as Record<string, unknown>;

    // NODE_PATH → node_modules from catalog resolver
    if (envRecord[SUPER_MCP_SPAWN_ENV_KEYS.NODE_PATH] !== undefined) {
      envRecord[SUPER_MCP_SPAWN_ENV_KEYS.NODE_PATH] = entry.nodeModulesResolver();
    }

    // Bridge state path — write BOTH the new and legacy keys whenever the
    // entry needs bridge state. Mirrors the dual-write performed by the
    // payload builders (see bridgeStateEnv()): bundled rebel-*\/server.cjs and
    // the legacy OSS bridges (slack, microsoft-mail, microsoft-sharepoint)
    // still read MINDSTONE_REBEL_BRIDGE_STATE, so any path-rewrite that emits
    // a config for those connectors must carry both names.
    if (entry.needsBridgeState) {
      Object.assign(envRecord, bridgeStateEnv());
    }

    // Connector catalog path (resourcesDir-based)
    if (envRecord.MINDSTONE_REBEL_CONNECTOR_CATALOG_PATH !== undefined) {
      envRecord.MINDSTONE_REBEL_CONNECTOR_CATALOG_PATH = resolveConnectorCatalogPath();
    }

    // Config path env vars (userDataDir-based, e.g. ZENDESK_CONFIG_PATH, HUBSPOT_CONFIG_DIR)
    if (entry.configPathEnvVars) {
      const configDir = getMcpConfigDir(entry.name);
      for (const { envVar, subPath } of entry.configPathEnvVars) {
        if (envRecord[envVar] !== undefined) {
          envRecord[envVar] = subPath ? path.join(configDir, subPath) : configDir;
        }
      }
    }

    rewritten++;
  }

  return rewritten;
}

// ================================================================
// Managed Install → npx Rewrite (for Cloud Payload)
// ================================================================

/**
 * Rewrite managed-install MCP entries back to their catalog npx form in a
 * cloud payload.
 *
 * Why this exists:
 * - A desktop user may have rebel-oss connectors wired up as managed installs
 *   (`command: "node"` + an absolute path under `<userData>/mcp/managed-installs/`).
 * - The cloud container does not share that filesystem; those absolute paths
 *   would spawn nothing.
 * - The cloud runtime already supports npx, and the catalog pins exact
 *   versions, so converting back to `command: "npx"` + catalog args is
 *   lossless for cloud.
 *
 * Managed entries are identified path-based (not by a schema marker) so that
 * manual config edits, UI edits, and schema drift cannot slip a managed entry
 * past this rewrite.
 *
 * Preserves identity fields (`catalogId`, `email`, `description`,
 * `lastConnectedAt`, etc.) and selectively merges `entry.env`: catalog env
 * is the base (so machine-specific path placeholders like `{{MCP_BASE_DIR}}`
 * survive), and user-supplied literals win for catalog keys whose catalog
 * value is itself an unresolved placeholder. This preserves api-key setup
 * fields (e.g. `RETELL_API_KEY`) and runtime-injected literals while still
 * rejecting managed-installs absolute desktop paths and any user keys not
 * declared by the catalog (path-leak protection).
 *
 * @param mcpServers - Mutated in place. Every managed entry is converted.
 * @param managedInstallsRoot - Absolute root of the managed installs dir.
 * @param connectorCatalog - Array of catalog entries (rebel-oss-shaped).
 * @returns Number of entries rewritten.
 */
export function rewriteManagedMcpEntriesToNpxForCloud(
  mcpServers: Record<string, unknown>,
  managedInstallsRoot: string,
  connectorCatalog: Array<{
    id?: string;
    provider?: string;
    mcpConfig?: { transport?: string; command?: string; args?: string[]; env?: Record<string, string> };
  }>,
): number {
  const catalogByCatalogId = new Map<
    string,
    { command: string; args: string[]; transport?: string; env?: Record<string, string> }
  >();
  for (const entry of connectorCatalog) {
    if (
      entry.id &&
      entry.provider === 'rebel-oss' &&
      entry.mcpConfig?.command === 'npx' &&
      Array.isArray(entry.mcpConfig.args) &&
      entry.mcpConfig.args.length > 0
    ) {
      catalogByCatalogId.set(entry.id, {
        command: entry.mcpConfig.command,
        args: entry.mcpConfig.args,
        transport: entry.mcpConfig.transport,
        env: entry.mcpConfig.env,
      });
    }
  }

  if (catalogByCatalogId.size === 0) {
    return 0;
  }

  let rewritten = 0;
  for (const serverEntry of Object.values(mcpServers)) {
    if (!serverEntry || typeof serverEntry !== 'object') continue;
    if (!isManagedInstallEntry(serverEntry, managedInstallsRoot)) continue;

    const entry = serverEntry as Record<string, unknown>;
    const catalogId = entry.catalogId;
    if (typeof catalogId !== 'string') continue;

    const catalogForm = catalogByCatalogId.get(catalogId);
    if (!catalogForm) continue;

    entry.command = catalogForm.command;
    entry.args = [...catalogForm.args];
    if (catalogForm.transport) {
      entry.type = catalogForm.transport;
    }
    // Selective env merge: catalog env is the base (so machine-specific path
    // placeholders like `{{MCP_BASE_DIR}}/...` are kept for cloud
    // re-resolution), and the user's resolved value wins for any catalog key
    // whose catalog value is itself an unresolved placeholder. This preserves
    // api-keys / setup-field literals (the cloud has no other transport for
    // these) while still rejecting managed-installs absolute desktop paths
    // and any user-only keys not declared by the catalog (stale-leak
    // prevention). `INTERNAL_ENV_KEYS` (e.g. `MCP_HOST_BRIDGE_STATE`,
    // `NODE_PATH`, `LOG_MODE`) keep using the catalog literal regardless of
    // what the user has locally — those are Rebel-internal plumbing.
    if (catalogForm.env && Object.keys(catalogForm.env).length > 0) {
      entry.env = mergePreservedUserEnv(entry.env, catalogForm.env, {
        dropExtraUserKeys: true,
        strictPlaceholders: true,
        rejectAbsolutePathPrefix: managedInstallsRoot,
        rejectAbsoluteFsPathValues: true,
      });
    } else if ('env' in entry) {
      delete entry.env;
    }
    rewritten++;
  }

  return rewritten;
}
