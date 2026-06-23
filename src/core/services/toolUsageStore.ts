/**
 * Tool Usage Store
 *
 * Tracks which MCP tools each user uses most frequently.
 * Used to personalize system prompt with frequently-used tool shortcuts.
 *
 * Key features:
 * - Persistent tracking via electron-store
 * - Seeded default tools for new users
 * - Demo mode support
 * - Meta-tool exclusion (discovery tools like list_tools, execute_action)
 * - Migration framework for future version upgrades
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import {
  TOOL_USAGE_STORE_VERSION,
  MAX_TRACKED_TOOLS,
  FREQUENT_TOOLS_LIMIT,
  TOOL_STALENESS_DAYS
} from '../constants';
import { migrateStore, shouldEnterReadOnlyMode, type VersionedData, type MigrationFn } from '../utils/storeMigration';
import { classifyLoadFailure, resolveConfStorePath } from '../utils/loadStoreSafely';

const log = createScopedLogger({ service: 'toolUsage' });



// ============================================================================
// Types
// ============================================================================

/**
 * Typed parameter info extracted from tool schema at recording time.
 * Used alongside bare `seenParams` for typed system prompt signatures.
 */
export interface ParamTypeInfo {
  name: string;
  type?: string;       // e.g., "string", "integer", "boolean", "object", "array"
  format?: string;     // e.g., "email", "date-time", "uri"
  required?: boolean;
}

/**
 * Individual tool usage record
 */
export interface ToolUsageRecord {
  toolName: string;
  usageCount: number;
  lastUsedAt: number;
  firstUsedAt: number;
  seenParams: string[];  // Parameter names observed across usages
  seenParamTypes?: ParamTypeInfo[];  // Typed parameter info (parallel to seenParams, populated from schema)
}

/**
 * For system prompt injection - simplified view of a frequently-used tool
 */
export interface FrequentTool {
  toolName: string;
  shortName: string;
  params: string[];  // Learned parameter names for compact signature
  typedParams?: ParamTypeInfo[];  // Typed parameter info for richer prompt signatures
}

/**
 * Store shape for electron-store
 */
interface ToolUsageStoreShape extends VersionedData {
  version: number;
  tools: ToolUsageRecord[];
  lastUpdatedAt: number;
}

// ============================================================================
// Default State
// ============================================================================

/**
 * Create empty default state. Tools are populated based on actual usage.
 * No seeding - users only see tools they've actually used.
 */
const createDefaultToolUsageState = (): ToolUsageStoreShape => ({
  version: TOOL_USAGE_STORE_VERSION,
  tools: [],
  lastUpdatedAt: Date.now()
});

// ============================================================================
// Meta-tool Exclusion
// ============================================================================

/**
 * Patterns for meta-tools that should be excluded from tracking.
 * These are discovery/routing tools or built-in tools that don't need shortcuts.
 * All patterns use 'i' flag for case-insensitive matching (tool names are normalized to lowercase).
 */
const META_TOOL_PATTERNS = [
  // Generic meta-tool patterns
  /^(list_tools|list_packages|execute_action|use_tool)$/i,
  /_list_tools$/i,
  /_get_schema$/i,
  /^mcp_.*_(list|schema)$/i,
  
  // Subagent spawns - not useful as shortcuts
  /^Task$/i,
  /\/Task$/i,
  /__Task$/i,
  /^Agent$/i,
  /\/Agent$/i,
  /__Agent$/i,
  
  // Built-in tools (not MCP, no discovery needed)
  /^(Bash|Read|Write|Edit|Grep|Glob|LS|TodoWrite|TodoRead|WebSearch|WebFetch|SearchFiles|MultiEdit|Create)$/i,

  // Task management tools (planning/coordination, not user-discoverable MCP tools)
  /^(TaskCreate|TaskList|TaskGet|TaskUpdate)$/i,

  // Internal tools (subagent communication, user interaction)
  /^(TaskOutput|AskUserQuestion)$/i,
  
  // Super-MCP router admin/diagnostic tools (handles both __ and / separators)
  /(super-mcp-router|mcp__super-mcp-router)(__|\/)?(list_tool_packages|list_tools|get_tool_details|health_check_all|health_check|restart_package|get_help|search_tools|authenticate)/i,
];

/**
 * Check if a tool should be excluded from tracking.
 * Meta-tools like list_tools, execute_action are discovery tools, not work tools.
 */
export const isMetaTool = (toolName: string): boolean => {
  // Extract just the tool name if it has a prefix (e.g., "PackageId/tool_name" -> "tool_name")
  const baseName = toolName.includes('/') ? toolName.split('/').pop() ?? toolName : toolName;
  return META_TOOL_PATTERNS.some(pattern => pattern.test(baseName) || pattern.test(toolName));
};

// ============================================================================
// Migrations
// ============================================================================

/**
 * Tool name rename mapping for v1 -> v2 migration.
 * Maps old unprefixed/inconsistent tool names to new rebel_<domain>_<verb>_<noun> pattern.
 */
const TOOL_RENAME_MAP_V2: Record<string, string> = {
  // RebelMeetings renames
  'sync_meetings': 'rebel_meetings_sync',
  'get_todays_meetings': 'rebel_meetings_today',
  'save_meeting_prep': 'rebel_meetings_save_prep',
  'find_meeting_prep': 'rebel_meetings_find_prep',
  // RebelSearch renames
  'rebel_file_search': 'rebel_search_files',
  'search_sources': 'rebel_search_sources',
  // RebelDiagnostics renames
  'rebel_system_health': 'rebel_diagnostics_check',
  'rebel_quick_check': 'rebel_diagnostics_quick',
  'rebel_export_report': 'rebel_diagnostics_export',
};

/**
 * Server consolidation mapping for v2 -> v3 migration.
 * Maps old server prefixes to RebelInternal.
 * Also includes RebelWorkspace tool renames.
 */
const LEGACY_SERVER_PREFIXES_V3 = [
  'RebelInbox',
  'RebelAutomations',
  'RebelMeetings',
  'RebelWorkspace',
  'RebelSearch',
];

/**
 * RebelWorkspace tool renames for v2 -> v3 migration.
 * Maps old tool names to new rebel_<domain>_<verb>_<noun> pattern.
 */
const WORKSPACE_TOOL_RENAMES_V3: Record<string, string> = {
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
 * Server split mapping for v3 -> v4 migration.
 * Maps RebelInternal tool prefixes to their new split MCP server names.
 */
const SERVER_SPLIT_MAP_V4: Array<[string, string]> = [
  // Order matters: more specific prefixes first
  ['rebel_inbox_', 'RebelInbox'],
  ['rebel_meetings_', 'RebelMeetings'],
  ['rebel_search_', 'RebelSearchAndConversations'],
  ['rebel_conversations_', 'RebelSearchAndConversations'],
  ['rebel_automations_', 'RebelAutomations'],
  ['rebel_spaces_', 'RebelSpaces'],
  ['rebel_settings_', 'RebelSettings'],
  ['rebel_internal_get_environment', 'RebelSettings'],  // Exact match for this special case
  ['rebel_vocabulary_', 'RebelSettings'],
  ['rebel_usecases_', 'RebelSettings'],
  ['rebel_mcp_', 'RebelMcpConnectors'],
];

/**
 * Migrate a tool name from v1 to v2.
 * Handles both bare tool names and prefixed formats (serverId/toolName).
 */
const migrateToolNameV2 = (toolName: string): string => {
  // Check if the bare name needs renaming
  if (TOOL_RENAME_MAP_V2[toolName]) {
    return TOOL_RENAME_MAP_V2[toolName];
  }

  // Check for prefixed format (serverId/toolName)
  const lastSlash = toolName.lastIndexOf('/');
  if (lastSlash > 0) {
    const prefix = toolName.slice(0, lastSlash + 1);
    const bareName = toolName.slice(lastSlash + 1);
    if (TOOL_RENAME_MAP_V2[bareName]) {
      return prefix + TOOL_RENAME_MAP_V2[bareName];
    }
  }

  return toolName;
};

/**
 * Migrate a tool name from v2 to v3.
 * Handles:
 * 1. Server prefix migration: RebelInbox/tool → RebelInternal/tool
 * 2. RebelWorkspace tool renames: rebel_describe_environment → rebel_internal_get_environment
 */
const migrateToolNameV3 = (toolName: string): string => {
  const lastSlash = toolName.lastIndexOf('/');
  
  if (lastSlash > 0) {
    const serverName = toolName.slice(0, lastSlash);
    let bareName = toolName.slice(lastSlash + 1);
    
    // Check if this is a legacy internal server
    const isLegacyServer = LEGACY_SERVER_PREFIXES_V3.some(prefix => serverName === prefix);
    
    if (isLegacyServer) {
      // Apply tool rename if applicable (mainly for RebelWorkspace tools)
      if (WORKSPACE_TOOL_RENAMES_V3[bareName]) {
        bareName = WORKSPACE_TOOL_RENAMES_V3[bareName];
      }
      // Migrate to RebelInternal
      return `RebelInternal/${bareName}`;
    }
  }
  
  // Check bare tool names for workspace renames
  if (WORKSPACE_TOOL_RENAMES_V3[toolName]) {
    return WORKSPACE_TOOL_RENAMES_V3[toolName];
  }

  return toolName;
};

/**
 * Migrate a tool name from v3 to v4.
 * Handles:
 * RebelInternal split → 7 separate MCP servers
 * e.g., RebelInternal/rebel_inbox_add → RebelInbox/rebel_inbox_add
 */
const migrateToolNameV4 = (toolName: string): string => {
  const lastSlash = toolName.lastIndexOf('/');
  
  if (lastSlash > 0) {
    const serverName = toolName.slice(0, lastSlash);
    const bareName = toolName.slice(lastSlash + 1);
    
    // Only migrate RebelInternal tools
    if (serverName === 'RebelInternal') {
      // Find matching prefix to determine new server
      for (const [prefix, targetServer] of SERVER_SPLIT_MAP_V4) {
        if (bareName.startsWith(prefix) || bareName === prefix.replace(/_$/, '')) {
          return `${targetServer}/${bareName}`;
        }
      }
      // Fallback: keep as RebelInternal if no mapping found (shouldn't happen)
      return toolName;
    }
  }

  return toolName;
};

/**
 * Tool rename for v4 -> v5 migration.
 * Fixes model hallucination: rebel_meetings_list_today → rebel_meetings_today.
 */
const TOOL_RENAME_MAP_V5: Record<string, string> = {
  'rebel_meetings_list_today': 'rebel_meetings_today',
};

const migrateToolNameV5 = (toolName: string): string => {
  if (TOOL_RENAME_MAP_V5[toolName]) {
    return TOOL_RENAME_MAP_V5[toolName];
  }

  const lastSlash = toolName.lastIndexOf('/');
  if (lastSlash > 0) {
    const prefix = toolName.slice(0, lastSlash + 1);
    const bareName = toolName.slice(lastSlash + 1);
    if (TOOL_RENAME_MAP_V5[bareName]) {
      return prefix + TOOL_RENAME_MAP_V5[bareName];
    }
  }

  return toolName;
};

const TOOL_USAGE_MIGRATIONS: Record<number, MigrationFn<ToolUsageStoreShape>> = {
  // v1 -> v2: Rename tools to new rebel_<domain>_<verb>_<noun> pattern
  1: (data) => {
    const migratedTools = data.tools.map(tool => ({
      ...tool,
      toolName: migrateToolNameV2(tool.toolName)
    }));
    
    // Merge any duplicate tool names that may result from migration
    const toolMap = new Map<string, ToolUsageRecord>();
    for (const tool of migratedTools) {
      const existing = toolMap.get(tool.toolName);
      if (existing) {
        // Merge: sum counts, take earliest first use, latest last use, union params
        toolMap.set(tool.toolName, {
          toolName: tool.toolName,
          usageCount: existing.usageCount + tool.usageCount,
          firstUsedAt: Math.min(existing.firstUsedAt, tool.firstUsedAt),
          lastUsedAt: Math.max(existing.lastUsedAt, tool.lastUsedAt),
          seenParams: [...new Set([...existing.seenParams, ...tool.seenParams])]
        });
      } else {
        toolMap.set(tool.toolName, tool);
      }
    }

    return {
      ...data,
      version: 2,
      tools: Array.from(toolMap.values()),
      lastUpdatedAt: Date.now()
    };
  },

  // v2 -> v3: Consolidate 5 internal MCPs into RebelInternal + tool renames
  2: (data) => {
    const migratedTools = data.tools.map(tool => ({
      ...tool,
      toolName: migrateToolNameV3(tool.toolName)
    }));
    
    // Merge any duplicate tool names that may result from migration
    const toolMap = new Map<string, ToolUsageRecord>();
    for (const tool of migratedTools) {
      const existing = toolMap.get(tool.toolName);
      if (existing) {
        // Merge: sum counts, take earliest first use, latest last use, union params
        toolMap.set(tool.toolName, {
          toolName: tool.toolName,
          usageCount: existing.usageCount + tool.usageCount,
          firstUsedAt: Math.min(existing.firstUsedAt, tool.firstUsedAt),
          lastUsedAt: Math.max(existing.lastUsedAt, tool.lastUsedAt),
          seenParams: [...new Set([...existing.seenParams, ...tool.seenParams])]
        });
      } else {
        toolMap.set(tool.toolName, tool);
      }
    }

    return {
      ...data,
      version: 3,
      tools: Array.from(toolMap.values()),
      lastUpdatedAt: Date.now()
    };
  },

  // v3 -> v4: Split RebelInternal into 7 separate MCPs
  3: (data) => {
    const migratedTools = data.tools.map(tool => ({
      ...tool,
      toolName: migrateToolNameV4(tool.toolName)
    }));
    
    // Merge any duplicate tool names that may result from migration
    const toolMap = new Map<string, ToolUsageRecord>();
    for (const tool of migratedTools) {
      const existing = toolMap.get(tool.toolName);
      if (existing) {
        // Merge: sum counts, take earliest first use, latest last use, union params
        toolMap.set(tool.toolName, {
          toolName: tool.toolName,
          usageCount: existing.usageCount + tool.usageCount,
          firstUsedAt: Math.min(existing.firstUsedAt, tool.firstUsedAt),
          lastUsedAt: Math.max(existing.lastUsedAt, tool.lastUsedAt),
          seenParams: [...new Set([...existing.seenParams, ...tool.seenParams])]
        });
      } else {
        toolMap.set(tool.toolName, tool);
      }
    }

    return {
      ...data,
      version: 4,
      tools: Array.from(toolMap.values()),
      lastUpdatedAt: Date.now()
    };
  },

  // v4 -> v5: Rename rebel_meetings_list_today → rebel_meetings_today
  4: (data) => {
    const migratedTools = data.tools.map(tool => ({
      ...tool,
      toolName: migrateToolNameV5(tool.toolName)
    }));

    const toolMap = new Map<string, ToolUsageRecord>();
    for (const tool of migratedTools) {
      const existing = toolMap.get(tool.toolName);
      if (existing) {
        toolMap.set(tool.toolName, {
          toolName: tool.toolName,
          usageCount: existing.usageCount + tool.usageCount,
          firstUsedAt: Math.min(existing.firstUsedAt, tool.firstUsedAt),
          lastUsedAt: Math.max(existing.lastUsedAt, tool.lastUsedAt),
          seenParams: [...new Set([...existing.seenParams, ...tool.seenParams])]
        });
      } else {
        toolMap.set(tool.toolName, tool);
      }
    }

    return {
      ...data,
      version: 5,
      tools: Array.from(toolMap.values()),
      lastUpdatedAt: Date.now()
    };
  },

  // v5 -> v6: Add seenParamTypes field for typed parameter signatures
  5: (data) => {
    const migratedTools = data.tools.map(tool => ({
      ...tool,
      seenParamTypes: tool.seenParamTypes ?? []
    }));

    return {
      ...data,
      version: 6,
      tools: migratedTools,
      lastUpdatedAt: Date.now()
    };
  }
};

// ============================================================================
// Data Normalization
// ============================================================================

/**
 * Validate and normalize a tool usage record.
 * Returns null if the record is invalid.
 */
const normalizeToolRecord = (record: unknown): ToolUsageRecord | null => {
  if (!record || typeof record !== 'object') return null;

  const r = record as Record<string, unknown>;
  if (typeof r.toolName !== 'string' || r.toolName.trim().length === 0) return null;
  if (typeof r.usageCount !== 'number' || r.usageCount < 0) return null;

  // Normalize seenParams - ensure it's an array of strings, default to empty
  let seenParams: string[] = [];
  if (Array.isArray(r.seenParams)) {
    seenParams = r.seenParams.filter((p): p is string => typeof p === 'string');
  }

  // Normalize seenParamTypes - ensure it's an array of valid ParamTypeInfo objects
  let seenParamTypes: ParamTypeInfo[] | undefined;
  if (Array.isArray(r.seenParamTypes)) {
    seenParamTypes = r.seenParamTypes.filter((p): p is ParamTypeInfo =>
      p != null && typeof p === 'object' && typeof (p as Record<string, unknown>).name === 'string'
    );
  }

  return {
    toolName: r.toolName.trim(),
    usageCount: Math.floor(r.usageCount),
    lastUsedAt: typeof r.lastUsedAt === 'number' ? r.lastUsedAt : Date.now(),
    firstUsedAt: typeof r.firstUsedAt === 'number' ? r.firstUsedAt : Date.now(),
    seenParams,
    ...(seenParamTypes !== undefined && { seenParamTypes })
  };
};

/**
 * Normalize store shape, filtering out invalid records.
 */
const normalizeStoreShape = (data: unknown): ToolUsageStoreShape => {
  if (!data || typeof data !== 'object') {
    return createDefaultToolUsageState();
  }

  const d = data as Record<string, unknown>;
  const tools = Array.isArray(d.tools)
    ? d.tools.map(normalizeToolRecord).filter((t): t is ToolUsageRecord => t !== null)
    : [];

  return {
    version: typeof d.version === 'number' ? d.version : TOOL_USAGE_STORE_VERSION,
    tools, // Empty array is valid - means no tools tracked yet
    lastUpdatedAt: typeof d.lastUpdatedAt === 'number' ? d.lastUpdatedAt : Date.now()
  };
};

// ============================================================================
// Store Instance
// ============================================================================

let _toolUsageStore: KeyValueStore<ToolUsageStoreShape> | null = null;
const getToolUsageStore = (): KeyValueStore<ToolUsageStoreShape> => {
  if (!_toolUsageStore) {
    _toolUsageStore = createStore<ToolUsageStoreShape>({
      name: 'tool-usage',
      defaults: createDefaultToolUsageState()
    });
  }
  return _toolUsageStore;
};

// Track read-only mode for future version protection
let toolUsageReadOnlyMode = false;

// ============================================================================
// In-memory cache (EMFILE mitigation — REBEL-1C8)
// ============================================================================
//
// The underlying electron-store `.store` getter calls fs.readFileSync() on
// every access. `getFrequentTools()` sits on the agent turn-start path
// (mcpService.resolveSystemPrompt) and is called once per session plus from
// Settings; uncached reads here directly amplify Windows file-descriptor
// exhaustion (EMFILE). We cache the normalized state in memory after the
// first successful load and invalidate only on local writes, mirroring the
// proven settingsStore mitigation.
//
// On EMFILE/ENFILE load failure we must NOT reset-write the store — that
// would turn a read-side FD-exhaustion error into a write-side one against
// `tool-usage.json.tmp-*` and has been observed surfacing as a user-visible
// turn failure in diagnostics bundles.
let _cachedState: ToolUsageStoreShape | null = null;
let _awaitingHydratedLoadAfterFdExhaustion = false;

const isFdExhaustionError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'EMFILE' || code === 'ENFILE';
};

/**
 * Test-only helper: clear the in-memory tool-usage cache.
 * Intended for use from tests that need a fresh load between cases.
 * @internal
 */
export const __resetToolUsageCacheForTests = (): void => {
  _cachedState = null;
  toolUsageReadOnlyMode = false;
  _awaitingHydratedLoadAfterFdExhaustion = false;
};

// ============================================================================
// Internal Load/Save
// ============================================================================

const loadToolUsageInternal = (): ToolUsageStoreShape => {
  // Fast path: return cached state so hot reads (agent turn startup,
  // Settings UI) don't reread the backing store after first successful load.
  if (_cachedState !== null) {
    return _cachedState;
  }

  try {
    const stored = getToolUsageStore().store;

    // Use migration framework for safe version handling
    const migrationResult = migrateStore(stored, {
      storeName: 'tool-usage',
      currentVersion: TOOL_USAGE_STORE_VERSION,
      migrations: TOOL_USAGE_MIGRATIONS,
      createDefault: createDefaultToolUsageState
    });

    // Track read-only mode for future version protection AND corrupted
    // migrations (in-memory defaults; real data preserved on disk — never write back).
    toolUsageReadOnlyMode = shouldEnterReadOnlyMode(migrationResult);

    // Normalize the data to handle corrupted/partial records
    const normalized = normalizeStoreShape(migrationResult.data);

    // Persist migrated/normalized data if needed (but not for future versions).
    // A persistence failure here must not break the load: keep the normalized
    // in-memory state and continue so hot callers still get a usable result.
    if (migrationResult.shouldPersist && !toolUsageReadOnlyMode) {
      try {
        getToolUsageStore().store = normalized;
      } catch (persistError) {
        log.warn(
          { err: persistError },
          'Failed to persist migrated tool usage store - continuing with in-memory state'
        );
      }
    }

    // Log migration status
    if (migrationResult.status === 'future_version') {
      log.warn(
        {
          storedVersion: migrationResult.fromVersion,
          currentVersion: TOOL_USAGE_STORE_VERSION
        },
        'Tool usage store from newer app version - operating in read-only mode'
      );
    } else if (migrationResult.status === 'migrated') {
      log.info(
        {
          fromVersion: migrationResult.fromVersion,
          toVersion: migrationResult.toVersion,
          backupPath: migrationResult.backupPath
        },
        'Tool usage store migrated successfully'
      );
    }

    _awaitingHydratedLoadAfterFdExhaustion = false;
    _cachedState = normalized;
    return normalized;
  } catch (error) {
    // File-descriptor exhaustion: fail open. Return cached state if we have
    // it, otherwise an ephemeral default, and do NOT reset-write the store.
    // Writing here would escalate an EMFILE read into an EMFILE write on
    // tool-usage.json.tmp-* and has been observed surfacing as a user-visible
    // turn failure (REBEL-1C8 diagnostics).
    if (isFdExhaustionError(error)) {
      log.warn(
        { err: error, hasCachedState: _cachedState !== null },
        'Tool usage store read failed due to file-descriptor exhaustion - serving in-memory state without reset-writing'
      );
      if (_cachedState !== null) {
        return _cachedState;
      }
      _awaitingHydratedLoadAfterFdExhaustion = true;
      // Deliberately do not cache this ephemeral default: let the next call
      // retry the disk read once the process recovers file descriptors.
      return createDefaultToolUsageState();
    }

    // Non-EMFILE load failure (corrupt JSON / schema / decrypt / transient IO).
    // Broadened from the prior EMFILE-only fail-open: NEVER reset+persist over
    // real on-disk data. Classify ENOENT (fresh init → ephemeral default, no
    // latch) vs existing-but-unreadable (preserve raw + back up + read-only).
    const classified = classifyLoadFailure('tool-usage', resolveConfStorePath('tool-usage'), error);
    if (classified.outcome === 'absent') {
      // Truly absent: legitimate first run. Serve defaults; a later save may
      // persist (no read-only latch). Cache to avoid re-reading.
      _awaitingHydratedLoadAfterFdExhaustion = false;
      const fresh = createDefaultToolUsageState();
      _cachedState = fresh;
      return fresh;
    }

    // Existing-but-unreadable: preserve the on-disk file, latch read-only so no
    // writer can clobber it, and serve ephemeral in-memory defaults this session.
    toolUsageReadOnlyMode = true;
    _awaitingHydratedLoadAfterFdExhaustion = false;
    const ephemeral = createDefaultToolUsageState();
    _cachedState = ephemeral;
    return ephemeral;
  }
};

const saveToolUsageInternal = (state: ToolUsageStoreShape): boolean => {
  // Ensure load/migration has run so `toolUsageReadOnlyMode` is set correctly
  // before we check it. This makes EVERY writer first-touch-safe by construction
  // (a save as the first touch would otherwise read a stale `false` flag and
  // clobber real, un-migrated data). `loadToolUsageInternal()` has a cache
  // fast-path, so this is cheap after the first load, and it never calls back
  // into this function (no recursion).
  loadToolUsageInternal();
  // Prevent writes in read-only mode (future version protection)
  if (toolUsageReadOnlyMode) {
    log.warn('Skipping tool usage save - operating in read-only mode due to future version');
    return false;
  }

  // Persist first, then mirror to the in-memory cache. If the write throws
  // (e.g. EMFILE), we intentionally leave `_cachedState` untouched so the
  // next successful load rehydrates from disk rather than locking in a
  // cache that may have been derived from an ephemeral default.
  getToolUsageStore().store = state;
  _awaitingHydratedLoadAfterFdExhaustion = false;
  _cachedState = state;
  log.debug({ toolCount: state.tools.length }, 'Saved tool usage to persistent store');
  return true;
};

const hasHydratedStateFromDisk = (): boolean => {
  return _cachedState !== null || !_awaitingHydratedLoadAfterFdExhaustion;
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extract short name from tool name.
 * For MCP tools: "mcp_filesystem_read_file" -> "read_file"
 *                "mcp__super-mcp-router__use_tool" -> "use_tool"
 */
const extractShortName = (toolName: string): string => {
  const name = toolName;

  // Handle MCP tools with server prefix (e.g., "mcp_filesystem_read_file")
  const mcpMatch = name.match(/^mcp_[^_]+_(.+)$/i);
  if (mcpMatch) {
    return mcpMatch[1];
  }

  // Handle double-underscore MCP format (e.g., "mcp__server__tool")
  const mcpDoubleMatch = name.match(/^mcp__[^_]+__(.+)$/i);
  if (mcpDoubleMatch) {
    return mcpDoubleMatch[1];
  }

  return name;
};

/**
 * Prune tools to stay within MAX_TRACKED_TOOLS limit.
 * Removes least-used tools first, prioritizing recency for ties.
 */
const pruneTools = (tools: ToolUsageRecord[]): ToolUsageRecord[] => {
  if (tools.length <= MAX_TRACKED_TOOLS) {
    return tools;
  }

  // Sort by usage count (desc), then by lastUsedAt (desc) for ties
  const sorted = [...tools].sort((a, b) => {
    if (b.usageCount !== a.usageCount) {
      return b.usageCount - a.usageCount;
    }
    return b.lastUsedAt - a.lastUsedAt;
  });

  // Keep only top MAX_TRACKED_TOOLS
  const pruned = sorted.slice(0, MAX_TRACKED_TOOLS);
  log.debug(
    { before: tools.length, after: pruned.length },
    'Pruned tool usage store'
  );

  return pruned;
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Record a tool usage event.
 * Increments usage count for existing tools, adds new tools.
 * Merges observed parameter names into seenParams.
 * Optionally stores typed parameter info in seenParamTypes (parallel field).
 *
 * @param toolName - Full tool name (e.g., "GoogleWorkspace/gmail_search_emails")
 * @param params - Optional array of parameter names observed in this call
 * @param paramTypes - Optional typed parameter info extracted from tool schema
 */
export const recordToolUsage = (toolName: string, params?: string[], paramTypes?: ParamTypeInfo[]): void => {
  if (!toolName || typeof toolName !== 'string' || toolName.trim().length === 0) {
    log.warn({ toolName }, 'Invalid tool name, skipping usage recording');
    return;
  }

  const normalizedName = toolName.trim();
  const now = Date.now();

  const state = loadToolUsageInternal();
  if (!hasHydratedStateFromDisk()) {
    log.warn(
      { toolName: normalizedName },
      'Skipping tool usage update until store successfully hydrates after file-descriptor exhaustion'
    );
    return;
  }
  const existingIndex = state.tools.findIndex(t => t.toolName === normalizedName);

  let nextTools: ToolUsageRecord[];

  if (existingIndex >= 0) {
    // Update existing tool - merge params
    const existing = state.tools[existingIndex];
    const mergedParams = params
      ? [...new Set([...existing.seenParams, ...params])]
      : existing.seenParams;

    // Merge typed params: replace existing entries by name, add new ones
    let mergedParamTypes = existing.seenParamTypes;
    if (paramTypes && paramTypes.length > 0) {
      const typeMap = new Map<string, ParamTypeInfo>();
      // Seed with existing entries
      for (const pt of existing.seenParamTypes ?? []) {
        typeMap.set(pt.name, pt);
      }
      // Overwrite/add new entries (newer schema info takes precedence)
      for (const pt of paramTypes) {
        typeMap.set(pt.name, pt);
      }
      mergedParamTypes = Array.from(typeMap.values());
    }

    const updated: ToolUsageRecord = {
      ...existing,
      usageCount: existing.usageCount + 1,
      lastUsedAt: now,
      seenParams: mergedParams,
      seenParamTypes: mergedParamTypes
    };
    nextTools = [...state.tools];
    nextTools[existingIndex] = updated;
    log.debug(
      { toolName: normalizedName, newCount: updated.usageCount, paramCount: mergedParams.length },
      'Updated tool usage count'
    );
  } else {
    // Add new tool
    const newRecord: ToolUsageRecord = {
      toolName: normalizedName,
      usageCount: 1,
      firstUsedAt: now,
      lastUsedAt: now,
      seenParams: params ?? [],
      seenParamTypes: paramTypes
    };
    nextTools = [...state.tools, newRecord];
    log.debug({ toolName: normalizedName, paramCount: newRecord.seenParams.length }, 'Added new tool to usage tracking');
  }

  // Prune if over limit
  nextTools = pruneTools(nextTools);

  const nextState: ToolUsageStoreShape = {
    version: TOOL_USAGE_STORE_VERSION,
    tools: nextTools,
    lastUpdatedAt: now
  };

  saveToolUsageInternal(nextState);
};

/**
 * Shared selection logic for frequent tools.
 * Selects top N tools by usage, prioritizing active (recent) over stale.
 * Returns records sorted alphabetically for cache-stable ordering.
 */
const selectFrequentToolRecords = (
  tools: ToolUsageRecord[],
  limit: number
): ToolUsageRecord[] => {
  if (limit <= 0) return [];

  // Safety filter: exclude any meta-tools that slipped into storage (defense-in-depth)
  const filteredTools = tools.filter(tool => !isMetaTool(tool.toolName));

  // Staleness threshold: tools not used in TOOL_STALENESS_DAYS are deprioritized
  const staleThreshold = Date.now() - TOOL_STALENESS_DAYS * 24 * 60 * 60 * 1000;

  // Separate into active and stale tools
  const activeTools: ToolUsageRecord[] = [];
  const staleTools: ToolUsageRecord[] = [];
  for (const tool of filteredTools) {
    // Tools at exactly the threshold are considered stale (> not >=)
    if (tool.lastUsedAt > staleThreshold) {
      activeTools.push(tool);
    } else {
      staleTools.push(tool);
    }
  }

  // Sort function: by usage count desc, then alphabetically for deterministic tie-breaking
  const sortByUsage = (a: ToolUsageRecord, b: ToolUsageRecord) => {
    if (b.usageCount !== a.usageCount) {
      return b.usageCount - a.usageCount;
    }
    return a.toolName.localeCompare(b.toolName);
  };

  // Sort both groups
  activeTools.sort(sortByUsage);
  staleTools.sort(sortByUsage);

  // Select from active first, fill remainder from stale if needed
  const selected: ToolUsageRecord[] = activeTools.slice(0, limit);
  if (selected.length < limit) {
    const remainingSlots = limit - selected.length;
    selected.push(...staleTools.slice(0, remainingSlots));
  }

  // Final alphabetical sort for stable display ordering
  return selected.sort((a, b) => a.toolName.localeCompare(b.toolName));
};

/**
 * Get the most frequently used tools.
 *
 * Selection: top N by usage count, active tools prioritized over stale (60+ days)
 * Sorting: alphabetical for stable ordering (cache-friendly)
 *
 * @param limit - Maximum number of tools to return (default: FREQUENT_TOOLS_LIMIT)
 * @returns Array of FrequentTool objects
 */
export const getFrequentTools = (limit: number = FREQUENT_TOOLS_LIMIT): FrequentTool[] => {
  const state = loadToolUsageInternal();
  return selectFrequentToolRecords(state.tools, limit).map(t => {
    // Populate typedParams from seenParamTypes when available,
    // falling back to bare seenParams mapped to {name} entries
    const typedParams: ParamTypeInfo[] | undefined =
      t.seenParamTypes && t.seenParamTypes.length > 0
        ? t.seenParamTypes
        : undefined;

    return {
      toolName: t.toolName,
      shortName: extractShortName(t.toolName),
      params: t.seenParams,
      typedParams
    };
  });
};

/**
 * Get all tool usage records (for settings UI).
 * Sorted by usage count (descending).
 */
export const getAllToolUsage = (): ToolUsageRecord[] => {
  const state = loadToolUsageInternal();
  return [...state.tools].sort((a, b) => b.usageCount - a.usageCount);
};

/**
 * For Settings UI - get frequent tools with usage counts.
 * Uses same selection algorithm as getFrequentTools() for consistency.
 */
export interface FrequentToolWithCount extends FrequentTool {
  usageCount: number;
}

export const getFrequentToolsWithCounts = (limit: number = FREQUENT_TOOLS_LIMIT): FrequentToolWithCount[] => {
  const state = loadToolUsageInternal();
  log.debug({ totalTools: state.tools.length, limit }, 'Loading frequent tools with counts');

  return selectFrequentToolRecords(state.tools, limit).map(t => {
    const typedParams: ParamTypeInfo[] | undefined =
      t.seenParamTypes && t.seenParamTypes.length > 0
        ? t.seenParamTypes
        : undefined;

    return {
      toolName: t.toolName,
      shortName: extractShortName(t.toolName),
      params: t.seenParams,
      typedParams,
      usageCount: t.usageCount
    };
  });
};

/**
 * Clear all tool usage data.
 * Resets to empty state - tools will populate based on future usage.
 * Used for testing and settings "Reset" button.
 * @returns true if the clear succeeded, false if blocked (e.g., read-only mode)
 */
export const clearToolUsage = (): boolean => {
  // Load/migrate FIRST so a first-touch clear (no prior read) runs the migration
  // path, which sets `toolUsageReadOnlyMode` correctly. Without this, a clear as
  // the first touch would see a stale `false` flag and write empty defaults over
  // a real on-disk file whose migration never ran (corrupted/future-version).
  loadToolUsageInternal();
  const nextState = createDefaultToolUsageState();
  const success = saveToolUsageInternal(nextState);
  if (success) {
    log.info('Tool usage data cleared');
  } else {
    log.warn('Failed to clear tool usage data - save was blocked');
  }
  return success;
};

/**
 * Remove all tools associated with a specific MCP server.
 * Called when an MCP server is disconnected to prevent ghost tools
 * from appearing in prompts.
 * 
 * Tool names are stored as "serverId/toolName" (e.g., "GoogleWorkspace-teammember-mindstone-com/list_emails")
 * 
 * @param serverId - The server ID prefix to remove (e.g., "GoogleWorkspace-teammember-mindstone-com")
 * @returns Number of tools removed
 */
export const removeToolsForServer = (serverId: string): number => {
  if (!serverId || typeof serverId !== 'string') {
    log.warn({ serverId }, 'Invalid server ID for tool removal');
    return 0;
  }

  const state = loadToolUsageInternal();
  if (!hasHydratedStateFromDisk()) {
    log.warn(
      { serverId },
      'Skipping server tool removal until tool usage store successfully hydrates after file-descriptor exhaustion'
    );
    return 0;
  }
  const prefix = `${serverId}/`;
  
  const beforeCount = state.tools.length;
  const filteredTools = state.tools.filter(t => !t.toolName.startsWith(prefix));
  const removedCount = beforeCount - filteredTools.length;
  
  if (removedCount > 0) {
    const nextState: ToolUsageStoreShape = {
      version: TOOL_USAGE_STORE_VERSION,
      tools: filteredTools,
      lastUpdatedAt: Date.now()
    };
    
    const success = saveToolUsageInternal(nextState);
    if (success) {
      log.info({ serverId, removedCount }, 'Removed tools for disconnected server');
    } else {
      log.warn({ serverId }, 'Failed to save after removing server tools - read-only mode');
      return 0;
    }
  } else {
    log.debug({ serverId }, 'No tools found for server to remove');
  }
  
  return removedCount;
};


