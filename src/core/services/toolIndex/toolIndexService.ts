/**
 * Tool Index Service
 *
 * Manages semantic indexing of MCP tools using LanceDB for vector storage.
 * Enables semantic search to find relevant tools by natural language query.
 *
 * Architecture:
 * - One embedding per tool (name + summary + parameter names)
 * - Hybrid search: LanceDB native FTS + vector with RRF reranking
 * - Refreshed on app startup and MCP config changes
 *
 * Storage: ~/Library/Application Support/mindstone-rebel/indices/tools/
 */

import { getDataPath, isPackaged } from '@core/utils/dataPaths';
import { getPlatformConfig } from '@core/platform';
import { getEmbeddingGenerator } from '@core/embeddingGenerator';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { createScopedLogger } from '@core/logger';
import { parseMultiInstanceServer } from '@shared/utils/mcpInstanceUtils';
import { superMcpHttpManager } from '@core/services/superMcpHttpManager';
import {
  SUPER_MCP_REST_ENDPOINTS,
  SUPER_MCP_TOOL_INDEX_QUERY_PARAMS,
} from '@core/rebelCore/superMcpContract';
import { isTooManyOpenFilesError } from '@core/utils/emfileRetry';
import { isEnfileActive, markEnfileDetected } from '@core/utils/enfileState';
import { updateAliases, clearAliases } from '@core/services/toolAliasCache';
import { replaceDescriptions } from '@core/services/toolDescriptionCache';
import { cosineDistance } from '@core/utils/vectorMath';
import { eq, and } from '@core/utils/lancedbPredicates';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'toolIndex' });

// Create a require function for loading native modules from the unpacked location
const moduleRequire = createRequire(import.meta.url);

function getNativeModuleRequire(): NodeRequire {
  if (isPackaged()) {
    // process.resourcesPath is guaranteed by Electron when packaged (isPackaged() === true)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const unpackedPath = path.join(process.resourcesPath!, 'app.asar.unpacked', 'node_modules', '.package-lock.json');
    return createRequire(unpackedPath);
  }
  return moduleRequire;
}

// Lazily resolve the native-module require on first use, then memoize. Resolving
// eagerly at module load read getPlatformConfig() (via isPackaged()) before
// bootstrap initialised it, crashing the OSS desktop build at startup.
let resolvedNativeRequire: NodeRequire | undefined;
function resolveNativeRequire(): NodeRequire {
  return (resolvedNativeRequire ??= getNativeModuleRequire());
}
const nativeRequire: NodeRequire = ((id: string) => resolveNativeRequire()(id)) as NodeRequire;

// Table and metadata configuration
const TABLE_NAME = 'tool_embeddings';
const METADATA_FILE = 'index_metadata.json';

// Embedding model name - for index compatibility tracking
const CURRENT_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';

// Schema version - increment when ToolEmbeddingRecord fields change (e.g., packageId → serverId)
// This triggers a full index rebuild on upgrade to ensure field compatibility
const TOOL_INDEX_SCHEMA_VERSION = 4; // v4: searchText → search_text (LanceDB FTS lowercases column names)

// Types
type LanceDBConnection = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

export type ToolEmbeddingRecord = {
  toolId: string;         // Primary key (e.g., "Slack__post_message")
  serverId: string;       // Server ID (e.g., "Slack-mindstone")
  serverName: string;     // Server display name
  name: string;
  description: string;
  summary: string;
  inputSchema: string;    // JSON stringified
  search_text: string;    // Combined text for FTS: name + summary + paramNames (snake_case avoids LanceDB FTS footgun)
  embeddingModel: string;
  indexedAt: number;
  vector: number[];       // 384 dims (BGE-small)
};

export type ToolCatalogTool = {
  package_id: string;
  package_name: string;
  tool_id: string;
  name: string;
  description: string;
  summary?: string;
  input_schema?: unknown;
};

export type ToolCatalogResponse = {
  tools: ToolCatalogTool[];
  aliases?: Record<string, Record<string, string>>;
  package_hashes?: Record<string, string>; // Per-package content hashes from Super-MCP (authority)
  etag: string;
};

interface ConfigHashResponse {
  config_hash: string;
  security_hash: string;
  package_ids: string[];
  package_count: number;
}

interface ManifestPackage {
  package_id: string;
  package_name: string;
  tool_count: number;
  embedding_hash: string;
  status: string;
}

interface ManifestResponse {
  packages: ManifestPackage[];
  security_hash: string;
  package_count: number;
  generated_at: string;
}

export interface ToolSearchResult {
  toolId: string;
  serverId: string;
  serverName: string;
  name: string;
  description: string;
  summary: string;
  inputSchema: unknown;
  score: number;
}

export interface ToolIndexMetadata {
  embeddingModel: string;
  etag: string;
  contentHash?: string;
  packageHashes?: Record<string, string>; // Per-package content hashes for incremental refresh
  configHash?: string; // Hash of MCP package registry config (cheap first-tier check)
  securityHash?: string;
  appVersion?: string; // Rebel version that last refreshed — forces manifest check on upgrade
  toolCount: number;
  lastRefreshAt: number;
  schemaVersion?: number; // Added in v2 for schema compatibility tracking
}

export interface ToolIndexStatus {
  isInitialized: boolean;
  toolCount: number;
  lastRefreshAt: number | null;
  etag: string | null;
  /** Tool count per safe base server name. Undefined when index is not initialized. */
  byServer: Record<string, number> | undefined;
  /** True when the index was invalidated by a config change and should not be used for reads. */
  isStale?: boolean;
  /** Reason supplied when stale invalidation was set. */
  staleReason?: string | null;
  /** Epoch timestamp when stale invalidation was set. */
  staleSince?: number | null;
  /** Generation number for the latest stale invalidation. */
  staleGeneration?: number | null;
  /** Monotonic freshness generation. Changes whenever the index is invalidated. */
  freshnessGeneration?: number;
  /** Last refresh failure reason while stale invalidation remained active. */
  lastRefreshError?: string | null;
}

interface ToolIndex {
  connection: LanceDBConnection;
  table: LanceDBTable | null;
  metadata: ToolIndexMetadata;
  toolIds: Set<string>;
  toolCountByServer: Map<string, number>;
  packageHashes: Map<string, string>; // Per-package content hashes for incremental change detection
  ftsReady: boolean;  // Whether FTS index is available for hybrid search
}

let currentIndex: ToolIndex | null = null;

/**
 * Live count of open LanceDB connections held by the tool index (0 or 1 — a
 * single `currentIndex.connection`). LanceDB is a native Rust addon holding
 * connection handles + an async runtime; a nonzero count at quit time is a
 * teardown-thread suspect for the residual macOS quit-deadlock. Synchronous,
 * allocation-free read for the native-liveness snapshot (see
 * `src/main/services/nativeLivenessSnapshot.ts`).
 */
export function getToolLanceLiveConnectionCount(): number {
  return currentIndex ? 1 : 0;
}

interface ToolIndexFreshnessState {
  generation: number;
  isStale: boolean;
  staleReason: string | null;
  staleSince: number | null;
  staleGeneration: number | null;
  lastRefreshError: string | null;
}

type ToolIndexRefreshCompletion = {
  success: boolean;
  error?: string;
};

const freshnessState: ToolIndexFreshnessState = {
  generation: 0,
  isStale: false,
  staleReason: null,
  staleSince: null,
  staleGeneration: null,
  lastRefreshError: null,
};

const freshnessRollbackSnapshots = new Map<number, ToolIndexFreshnessState>();

function dropFreshnessSnapshotsUpTo(generation: number): void {
  for (const snapshotGeneration of freshnessRollbackSnapshots.keys()) {
    if (snapshotGeneration <= generation) {
      freshnessRollbackSnapshots.delete(snapshotGeneration);
    }
  }
}

/**
 * Strip email slug from multi-instance server IDs for privacy.
 * "GoogleWorkspace-greg-work-com" → "GoogleWorkspace"
 */
function getSafeServerName(serverId: string): string {
  const parsed = parseMultiInstanceServer(serverId);
  return parsed.isInstance && parsed.baseName ? parsed.baseName : serverId;
}

// Queue-chain serializer: each refresh appends to the chain so only one runs at a time,
// but every caller eventually executes (prevents waiter stampede).
// See docs/plans/260402_tool_index_incremental_refresh.md § "Why queue-chain serialization"
let refreshSerializer: Promise<void> | null = null;

// Brief barrier during Phase C only — readers (searchTools, getToolSchema) wait on this
let mutationBarrier: Promise<void> | null = null;

// Disposed flag — prevents Phase C mutations after shutdown
let disposed = false;

// Optimize scheduling — clean up LanceDB version files after incremental mutations
const OPTIMIZE_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes minimum between optimizations
const OPTIMIZE_AFTER_WRITES = 500; // Trigger after this many writes
const OPTIMIZE_RETENTION_MS = 60 * 60 * 1000; // Keep 1 hour of version history
let writesSinceLastOptimize = 0;
let lastOptimizeTime = Date.now();
let needsOptimization = false;
let isOptimizing = false;
let optimizeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Get the storage directory for tool index (global, not per-workspace)
 */
function getIndexStorageDir(): string {
  const userDataPath = getDataPath();
  return path.join(userDataPath, 'indices', 'tools');
}

function getLanceDBDir(): string {
  return path.join(getIndexStorageDir(), 'lancedb');
}

function getMetadataPath(): string {
  return path.join(getIndexStorageDir(), METADATA_FILE);
}

async function loadMetadata(): Promise<ToolIndexMetadata> {
  const metadataPath = getMetadataPath();
  try {
    const data = await fs.readFile(metadataPath, 'utf-8');
    return JSON.parse(data) as ToolIndexMetadata;
  } catch {
    return {
      embeddingModel: CURRENT_EMBEDDING_MODEL,
      etag: '',
      toolCount: 0,
      lastRefreshAt: 0,
    };
  }
}

async function saveMetadata(metadata: ToolIndexMetadata): Promise<void> {
  const metadataPath = getMetadataPath();
  const storageDir = getIndexStorageDir();
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

/**
 * Ensure FTS index exists on the `search_text` column.
 * Creates it if missing, then verifies via listIndices() that the index
 * actually exists (catches silent failures from camelCase naming, schema
 * mismatches, or any other FTS creation problem).
 *
 * Note: LanceDB 0.22.x lowercases FTS column names internally, so camelCase
 * columns silently fail. Always use snake_case for FTS-indexed columns.
 * Query-based verification is NOT reliable — LanceDB returns results via
 * table scan even when no FTS index exists.
 */
async function ensureToolFTSIndex(table: LanceDBTable): Promise<boolean> {
  const column = 'search_text';
  try {
    const lancedb = nativeRequire('@lancedb/lancedb') as typeof import('@lancedb/lancedb');
    const existingIndices = await table.listIndices();
    const indexedColumns = new Set(existingIndices.map(i => i.columns[0]));

    if (!indexedColumns.has(column)) {
      log.info({ column }, 'Creating FTS index');
      await table.createIndex(column, {
        config: lancedb.Index.fts({ stem: true, lowercase: true })
      });

      // Post-create verification: re-list indices and confirm the column is present.
      // This catches silent failures (e.g., camelCase naming where createIndex
      // succeeds but the index targets a lowercased column that doesn't exist).
      const verifyIndices = await table.listIndices();
      const verifyColumns = new Set(verifyIndices.map(i => i.columns[0]));
      if (!verifyColumns.has(column)) {
        log.error(
          { column, expectedColumn: column, actualColumns: [...verifyColumns] },
          'FTS index creation appeared to succeed but index not found in listIndices — search will use vector-only fallback',
        );
        return false;
      }
    }

    log.info('Tool FTS index ready');
    return true;
  } catch (error) {
    log.error({ err: error, column }, 'Failed to create tool FTS index — search will use vector-only fallback');
    return false;
  }
}

/**
 * Build the combined search text for a tool (used for both content hash and embedding).
 * Includes tool name, summary (or description as fallback), parameter names, and package name.
 */
export function buildToolSearchText(
  tool: { name: string; summary?: string; description: string; package_name: string },
  paramNames: string,
): string {
  return `${tool.name} ${tool.summary || tool.description} ${paramNames} ${tool.package_name}`;
}

/**
 * Initialize the tool index
 */
export async function initializeToolIndex(): Promise<void> {
  if (currentIndex) {
    return;
  }

  const storageDir = getIndexStorageDir();
  const lanceDBDir = getLanceDBDir();
  await fs.mkdir(lanceDBDir, { recursive: true });

  log.info({ storageDir }, 'Initializing tool index');

  const metadata = await loadMetadata();

  // Check if embedding model or schema version changed - triggers full rebuild
  const needsRebuild = 
    (metadata.embeddingModel && metadata.embeddingModel !== CURRENT_EMBEDDING_MODEL) ||
    (metadata.schemaVersion !== TOOL_INDEX_SCHEMA_VERSION);

  if (needsRebuild) {
    log.info(
      { 
        oldModel: metadata.embeddingModel, 
        newModel: CURRENT_EMBEDDING_MODEL,
        oldSchemaVersion: metadata.schemaVersion,
        newSchemaVersion: TOOL_INDEX_SCHEMA_VERSION,
      },
      'Tool index incompatible (model or schema changed), clearing for rebuild'
    );
    await fs.rm(lanceDBDir, { recursive: true, force: true });
    await fs.mkdir(lanceDBDir, { recursive: true });
    metadata.embeddingModel = CURRENT_EMBEDDING_MODEL;
    metadata.schemaVersion = TOOL_INDEX_SCHEMA_VERSION;
    metadata.etag = '';
    metadata.contentHash = undefined;
    metadata.toolCount = 0;
    await saveMetadata(metadata);
  }

  // On Rebel version upgrade, clear configHash to force a manifest check on first refresh.
  // New versions may ship with updated Super-MCP packages, so we can't trust the cached
  // config hash. The manifest check (Tier 2) will do per-package diffing and only re-embed
  // packages that actually changed — so this doesn't cause unnecessary full re-embeds.
  const currentAppVersion = getPlatformConfig().version;
  if (metadata.appVersion && metadata.appVersion !== currentAppVersion) {
    log.info(
      { oldVersion: metadata.appVersion, newVersion: currentAppVersion },
      'Rebel version changed, clearing configHash to force manifest check'
    );
    metadata.configHash = undefined;
    metadata.appVersion = currentAppVersion;
    await saveMetadata(metadata);
  } else if (!metadata.appVersion) {
    metadata.appVersion = currentAppVersion;
    await saveMetadata(metadata);
  }

  const lancedb = nativeRequire('@lancedb/lancedb') as typeof import('@lancedb/lancedb');
  const connection = await lancedb.connect(lanceDBDir);

  let table: LanceDBTable | null = null;
  const tableNames = await connection.tableNames();

  if (tableNames.includes(TABLE_NAME)) {
    table = await connection.openTable(TABLE_NAME);
    log.info({ tableName: TABLE_NAME }, 'Opened existing tool index table');
  }

  // Build cache of tool IDs (composite key) and per-server counts
  const toolIds = new Set<string>();
  const toolCountByServer = new Map<string, number>();
  if (table) {
    try {
      const results = await table.query().select(['toolId', 'serverId']).toArray();
      for (const row of results) {
        const record = row as { toolId: string; serverId: string };
        toolIds.add(`${record.serverId}:${record.toolId}`);
        const safeName = getSafeServerName(record.serverId);
        toolCountByServer.set(safeName, (toolCountByServer.get(safeName) ?? 0) + 1);
      }
      log.info({ toolCount: toolIds.size }, 'Loaded tool IDs cache');
    } catch (err) {
      log.warn({ err }, 'Failed to load tool IDs');
    }
  }

  // Restore per-package hashes from metadata (empty on first run / pre-incremental upgrade)
  const packageHashes = new Map<string, string>(
    Object.entries(metadata.packageHashes ?? {})
  );

  // Ensure FTS index exists (creates if missing, e.g. after a previous failure)
  let ftsReady = false;
  if (table) {
    ftsReady = await ensureToolFTSIndex(table);
  }

  currentIndex = {
    connection,
    table,
    metadata,
    toolIds,
    toolCountByServer,
    packageHashes,
    ftsReady,
  };
}

/**
 * Close the tool index
 */
export async function closeToolIndex(): Promise<void> {
  disposed = true;

  if (optimizeTimer) {
    clearTimeout(optimizeTimer);
    optimizeTimer = null;
  }

  if (currentIndex) {
    try {
      currentIndex.connection.close();
    } catch (err) {
      log.warn({ err }, 'Error closing LanceDB connection');
    }
    currentIndex = null;
    log.info('Tool index closed');
  }
}

/**
 * Fetch tools from Super-MCP's /api/tools endpoint
 */
async function fetchToolsFromSuperMcp(): Promise<ToolCatalogResponse | null> {
  const state = superMcpHttpManager.getState();
  if (!state.isRunning || !state.url) {
    log.debug('Super-MCP not running, cannot fetch tools');
    return null;
  }

  // Build API URL from MCP URL (replace /mcp with /api/tools)
  const apiUrl = state.url.replace('/mcp', SUPER_MCP_REST_ENDPOINTS.TOOLS);

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      log.warn({ status: response.status }, 'Failed to fetch tools from Super-MCP');
      return null;
    }

    const data = await response.json() as ToolCatalogResponse;

    log.info({ toolCount: data.tools.length, etag: data.etag }, 'Fetched tools from Super-MCP');
    return data;
  } catch (error) {
    log.warn({ err: error }, 'Error fetching tools from Super-MCP');
    return null;
  }
}

export async function fetchConfigHashFromSuperMcp(): Promise<ConfigHashResponse | null> {
  const state = superMcpHttpManager.getState();
  if (!state.isRunning || !state.url) {
    log.debug('Super-MCP not running, cannot fetch config hash');
    return null;
  }

  const configHashUrl = state.url.replace('/mcp', SUPER_MCP_REST_ENDPOINTS.TOOLS_CONFIG_HASH);

  try {
    const response = await fetch(configHashUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5_000), // Short timeout — this should be instant
    });

    if (!response.ok) {
      log.info({ status: response.status }, 'Config hash endpoint unavailable, falling back to manifest');
      return null;
    }

    const data = await response.json() as ConfigHashResponse;
    log.debug({ configHash: data.config_hash, packageCount: data.package_count }, 'Fetched config hash from Super-MCP');
    return data;
  } catch (error) {
    log.info({ err: error }, 'Config hash fetch failed, falling back to manifest');
    return null;
  }
}

export async function fetchManifestFromSuperMcp(): Promise<ManifestResponse | null> {
  const state = superMcpHttpManager.getState();
  if (!state.isRunning || !state.url) {
    log.debug('Super-MCP not running, cannot fetch tool manifest');
    return null;
  }

  const manifestUrl = state.url.replace('/mcp', SUPER_MCP_REST_ENDPOINTS.TOOLS_MANIFEST);

  try {
    const response = await fetch(manifestUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      log.info({ status: response.status }, 'Tool manifest unavailable from Super-MCP, falling back to full refresh');
      return null;
    }

    const data = await response.json() as ManifestResponse;
    log.info({ packageCount: data.package_count }, 'Fetched tool manifest from Super-MCP');
    return data;
  } catch (error) {
    log.info({ err: error }, 'Tool manifest fetch failed, falling back to full refresh');
    return null;
  }
}

async function fetchToolsForPackages(packageIds: string[]): Promise<ToolCatalogResponse | null> {
  const state = superMcpHttpManager.getState();
  if (!state.isRunning || !state.url) {
    log.debug('Super-MCP not running, cannot fetch package tools');
    return null;
  }

  const apiUrl = state.url.replace('/mcp', SUPER_MCP_REST_ENDPOINTS.TOOLS);
  const params = new URLSearchParams();
  params.set(SUPER_MCP_TOOL_INDEX_QUERY_PARAMS.PACKAGES, packageIds.join(','));

  try {
    const response = await fetch(`${apiUrl}?${params.toString()}`, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      log.warn({ status: response.status, packageIds }, 'Failed to fetch selected tools from Super-MCP');
      return null;
    }

    const data = await response.json() as ToolCatalogResponse;
    log.info({ packageCount: packageIds.length, toolCount: data.tools.length }, 'Fetched selected tools from Super-MCP');
    return data;
  } catch (error) {
    log.warn({ err: error, packageIds }, 'Error fetching selected tools from Super-MCP');
    return null;
  }
}

function buildToolContentHash(tools: ToolCatalogTool[]): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(
      tools
        .map(tool => ({
          key: `${tool.package_id}:${tool.tool_id}`,
          text: buildToolSearchText(tool, getParamNames(tool.input_schema)),
        }))
        .sort((a, b) => a.key.localeCompare(b.key))
    ))
    .digest('hex');
}

async function loadStoredToolsFromLanceDb(serverIds?: ReadonlySet<string>): Promise<ToolCatalogTool[]> {
  if (!currentIndex?.table) {
    return [];
  }

  if (serverIds && serverIds.size === 0) {
    return [];
  }

  const rows = await currentIndex.table
    .query()
    .select(['serverId', 'serverName', 'toolId', 'name', 'description', 'summary', 'inputSchema'])
    .toArray();

  return rows.flatMap(row => {
    const record = row as {
      serverId: string;
      serverName: string;
      toolId: string;
      name: string;
      description: string;
      summary: string;
      inputSchema: string;
    };

    if (serverIds && !serverIds.has(record.serverId)) {
      return [];
    }

    let inputSchema: unknown = {};
    try {
      inputSchema = JSON.parse(record.inputSchema);
    } catch (error) {
      log.debug({ err: error, toolId: record.toolId }, 'Failed to parse stored tool schema during rehydration');
    }

    return [{
      package_id: record.serverId,
      package_name: record.serverName,
      tool_id: record.toolId,
      name: record.name,
      description: record.description,
      summary: record.summary,
      input_schema: inputSchema,
    }];
  });
}

async function loadDescriptionsFromLanceDb(): Promise<Array<{ toolId: string; description: string }>> {
  if (!currentIndex?.table) {
    return [];
  }

  const rows = await currentIndex.table
    .query()
    .select(['toolId', 'description'])
    .toArray();

  return rows.map(row => {
    const record = row as { toolId: string; description: string };
    return { toolId: record.toolId, description: record.description };
  });
}

/**
 * Extract sorted parameter names from a tool's input_schema.
 */
export function getParamNames(inputSchema: unknown): string {
  if (inputSchema && typeof inputSchema === 'object') {
    const schema = inputSchema as { properties?: Record<string, unknown> };
    return schema.properties ? Object.keys(schema.properties).sort().join(' ') : '';
  }
  return '';
}

/**
 * Compute a SHA-256 hash for a single package's tools based on their search text.
 * Sorts tool texts for deterministic hashing regardless of tool order.
 *
 * NOTE: This is a backward-compatible fallback for older Super-MCP versions that
 * don't include `package_hashes` in the /api/tools response. When server hashes
 * are available, they are preferred (Super-MCP is the authority). This local hash
 * uses a different algorithm than Super-MCP's computePackageEmbeddingHash().
 */
export function computePackageHash(
  tools: Array<{ tool_id: string; name: string; summary?: string; description: string; package_name: string; input_schema?: unknown }>
): string {
  // Include tool_id in hash so tool ID renames are detected as modifications
  const texts = tools
    .map(t => `${t.tool_id}:${buildToolSearchText(t, getParamNames(t.input_schema))}`)
    .sort();
  return crypto.createHash('sha256').update(texts.join('\n')).digest('hex');
}

export function detectPackageChanges(
  storedHashes: ReadonlyMap<string, string>,
  newPackageHashes: ReadonlyMap<string, string>,
): {
  addedPackages: string[];
  modifiedPackages: string[];
  removedPackages: string[];
  unchangedPackages: string[];
} {
  const addedPackages: string[] = [];
  const modifiedPackages: string[] = [];
  const removedPackages: string[] = [];
  const unchangedPackages: string[] = [];

  for (const [serverId, hash] of newPackageHashes) {
    if (!storedHashes.has(serverId)) {
      addedPackages.push(serverId);
    } else if (storedHashes.get(serverId) !== hash) {
      modifiedPackages.push(serverId);
    } else {
      unchangedPackages.push(serverId);
    }
  }

  for (const serverId of storedHashes.keys()) {
    if (!newPackageHashes.has(serverId)) {
      removedPackages.push(serverId);
    }
  }

  return {
    addedPackages,
    modifiedPackages,
    removedPackages,
    unchangedPackages,
  };
}

/**
 * Schedule optimization after incremental mutations to clean up LanceDB version files.
 * Time-based primarily since tool writes are bursty (matching conversationIndexService pattern).
 */
function scheduleOptimizeIfNeeded(writeCount: number): void {
  writesSinceLastOptimize += writeCount;

  const enoughWrites = writesSinceLastOptimize >= OPTIMIZE_AFTER_WRITES;
  const enoughTime = Date.now() - lastOptimizeTime >= OPTIMIZE_INTERVAL_MS && writesSinceLastOptimize > 0;

  if (enoughWrites || enoughTime) {
    needsOptimization = true;
  }

  if (needsOptimization && !isOptimizing && !optimizeTimer) {
    // Defer optimization to avoid blocking the current operation
    optimizeTimer = setTimeout(() => {
      optimizeTimer = null;
      fireAndForget(runOptimize(), 'toolIndexService.runOptimize');
    }, 5_000);
  }
}

/**
 * Run LanceDB optimize to clean up version files from incremental mutations.
 */
async function runOptimize(): Promise<void> {
  if (!currentIndex?.table || isOptimizing || disposed) return;

  isOptimizing = true;
  const startTime = Date.now();

  try {
    await currentIndex.table.optimize({
      cleanupOlderThan: new Date(Date.now() - OPTIMIZE_RETENTION_MS),
    });

    lastOptimizeTime = Date.now();
    writesSinceLastOptimize = 0;
    needsOptimization = false;

    log.info({ elapsedMs: Date.now() - startTime }, 'Tool index optimization completed');
  } catch (err) {
    log.warn({ err }, 'Tool index optimization failed');
  } finally {
    isOptimizing = false;
  }
}

/**
 * Refresh the tool index from Super-MCP
 * Returns stats about what changed
 */
export async function refreshToolIndex(): Promise<{
  success: boolean;
  added: number;
  updated: number;
  removed: number;
  total: number;
}> {
  // Skip during ENFILE cooldown to prevent error storms
  if (isEnfileActive()) {
    return { success: false, added: 0, updated: 0, removed: 0, total: 0 };
  }

  if (disposed) {
    return { success: false, added: 0, updated: 0, removed: 0, total: 0 };
  }

  // Chain onto any in-progress refresh (proper queue — avoids waiter stampede).
  // Each caller appends its work to the chain so only one runs at a time.
  const previousRefresh = refreshSerializer;
  let releaseSerializer: () => void = () => {};
  refreshSerializer = new Promise<void>(resolve => {
    releaseSerializer = resolve;
  });

  if (previousRefresh) {
    await previousRefresh;
  }

  try {
    return await doRefreshToolIndex();
  } finally {
    releaseSerializer();
  }
}

/**
 * Refresh the tool index from a supplied tool catalog payload.
 * Uses the same queue-chain serializer as refreshToolIndex() to prevent
 * concurrent writers from overlapping mutation phases.
 */
export async function refreshToolIndexFromCatalogData(
  toolData: ToolCatalogResponse,
  options: {
    packageHashes?: ReadonlyMap<string, string>;
    configHash?: string;
    securityHash?: string;
    updateAliasesFromCatalog?: boolean;
    etag?: string;
  } = {},
): Promise<{
  success: boolean;
  added: number;
  updated: number;
  removed: number;
  total: number;
}> {
  const previousRefresh = refreshSerializer;
  let releaseSerializer: () => void = () => {};
  refreshSerializer = new Promise<void>(resolve => {
    releaseSerializer = resolve;
  });

  if (previousRefresh) {
    await previousRefresh;
  }

  try {
    return await doRefreshToolIndexFromCatalogData(toolData, options);
  } finally {
    releaseSerializer();
  }
}

/**
 * Core refresh logic: 3-phase incremental refresh (Detect → Embed → Mutate).
 * Only re-embeds tools from added/modified packages; unchanged packages are skipped.
 * See docs/plans/260402_tool_index_incremental_refresh.md for design rationale
 * (per-package granularity, lock splitting, hash-based change detection).
 */
async function doRefreshToolIndexFromCatalogData(
  toolData: ToolCatalogResponse,
  options: {
    packageHashes?: ReadonlyMap<string, string>;
    configHash?: string;
    securityHash?: string;
    updateAliasesFromCatalog?: boolean;
    etag?: string;
  } = {},
): Promise<{
  success: boolean;
  added: number;
  updated: number;
  removed: number;
  total: number;
}> {
  if (!currentIndex) {
    await initializeToolIndex();
  }

  if (!currentIndex) {
    return { success: false, added: 0, updated: 0, removed: 0, total: 0 };
  }

  const startTime = Date.now();

  // =============================================
  // Phase A: Detect (no lock)
  // =============================================
  const detectStart = Date.now();

  clearAliases();
  if (options.updateAliasesFromCatalog !== false && toolData.aliases) {
    for (const [packageId, aliasMap] of Object.entries(toolData.aliases)) {
      updateAliases(packageId, aliasMap);
    }
    const packageCount = Object.keys(toolData.aliases).length;
    if (packageCount > 0) {
      log.info({ packageCount }, 'Populated tool alias cache');
    }
  }

  replaceDescriptions(
    toolData.tools.map(tool => ({ toolId: tool.tool_id, description: tool.description }))
  );

  const toolContentHash = buildToolContentHash(toolData.tools);
  const securityHashChanged =
    options.securityHash !== undefined && options.securityHash !== currentIndex.metadata.securityHash;

  // Fast path for full-catalog fetches when nothing changed.
  if (!options.packageHashes && !securityHashChanged && toolContentHash === currentIndex.metadata.contentHash && currentIndex.table) {
    log.debug({ contentHash: toolContentHash }, 'Tool index up to date (content unchanged)');
    return { success: true, added: 0, updated: 0, removed: 0, total: currentIndex.toolIds.size };
  }

  const toolsByPackage = new Map<string, ToolCatalogTool[]>();
  for (const tool of toolData.tools) {
    const serverId = tool.package_id;
    let packageTools = toolsByPackage.get(serverId);
    if (!packageTools) {
      packageTools = [];
      toolsByPackage.set(serverId, packageTools);
    }
    packageTools.push(tool);
  }

  const newPackageHashes = options.packageHashes
    ? new Map(options.packageHashes)
    : new Map<string, string>();
  if (!options.packageHashes) {
    for (const [serverId, tools] of toolsByPackage) {
      newPackageHashes.set(serverId, computePackageHash(tools));
    }
  }

  const storedHashes = currentIndex.packageHashes;
  const {
    addedPackages,
    modifiedPackages,
    removedPackages,
    unchangedPackages,
  } = detectPackageChanges(storedHashes, newPackageHashes);

  const isUpgradeFromPreIncremental = currentIndex.table && storedHashes.size === 0 && currentIndex.toolIds.size > 0;
  const isFirstBuild = !currentIndex.table || isUpgradeFromPreIncremental;
  if (isUpgradeFromPreIncremental) {
    log.info('Upgrading from pre-incremental index — performing full rebuild to populate package hashes');
  }
  const detectMs = Date.now() - detectStart;

  log.info({
    oldContentHash: currentIndex.metadata.contentHash,
    newContentHash: toolContentHash,
    toolCount: toolData.tools.length,
    added: addedPackages.length,
    modified: modifiedPackages.length,
    removed: removedPackages.length,
    unchanged: unchangedPackages.length,
    isFirstBuild,
    securityHashChanged,
  }, 'Tool content changed, refreshing index');

  // =============================================
  // Phase B: Embed (no lock)
  // =============================================
  const embedStart = Date.now();

  const packagesToEmbed = isFirstBuild
    ? [...newPackageHashes.keys()]
    : [...addedPackages, ...modifiedPackages];

  let recordsToAdd: ToolEmbeddingRecord[] = [];

  if (packagesToEmbed.length > 0) {
    const toolsToEmbed = packagesToEmbed.flatMap(serverId => toolsByPackage.get(serverId) ?? []);
    const toolsWithText = toolsToEmbed.map(tool => ({
      tool,
      embeddingText: buildToolSearchText(tool, getParamNames(tool.input_schema)),
    }));

    const embeddings = await getEmbeddingGenerator().generateEmbeddings(
      toolsWithText.map((t) => t.embeddingText),
    );
    const indexedAt = Date.now();

    recordsToAdd = toolsWithText.map(({ tool, embeddingText }, index) => ({
      toolId: tool.tool_id,
      serverId: tool.package_id,
      serverName: tool.package_name,
      name: tool.name,
      description: tool.description,
      summary: tool.summary || tool.description,
      inputSchema: JSON.stringify(tool.input_schema || {}),
      search_text: embeddingText,
      embeddingModel: CURRENT_EMBEDDING_MODEL,
      indexedAt,
      vector: Array.from(embeddings[index]),
    }));
  }

  const embedMs = Date.now() - embedStart;

  // =============================================
  // Phase C: Mutate (under mutationBarrier)
  // =============================================
  if (disposed) {
    log.info('Tool index disposed before mutation phase — aborting refresh');
    return { success: false, added: 0, updated: 0, removed: 0, total: currentIndex.toolIds.size };
  }

  const mutateStart = Date.now();
  let releaseMutationBarrier: () => void = () => {};
  mutationBarrier = new Promise<void>(resolve => {
    releaseMutationBarrier = resolve;
  });

  try {
    if (isFirstBuild) {
      if (recordsToAdd.length > 0) {
        currentIndex.table = await currentIndex.connection.createTable(TABLE_NAME, recordsToAdd);
        log.info({ tableName: TABLE_NAME, recordCount: recordsToAdd.length }, 'Created tool index table');
        currentIndex.ftsReady = await ensureToolFTSIndex(currentIndex.table);
      }
    } else if (toolData.tools.length === 0) {
      if (currentIndex.table) {
        await currentIndex.connection.dropTable(TABLE_NAME);
        currentIndex.table = null;
        currentIndex.ftsReady = false;
      }
    } else if (currentIndex.table) {
      const table = currentIndex.table;
      const packagesToDelete = [...removedPackages, ...modifiedPackages];
      for (const serverId of packagesToDelete) {
        await table.delete(eq('serverId', serverId));
      }

      if (recordsToAdd.length > 0) {
        await table.add(recordsToAdd);
      }

      currentIndex.ftsReady = await ensureToolFTSIndex(table);
    }

    const newToolIds = new Set<string>();
    for (const [serverId, tools] of toolsByPackage) {
      for (const tool of tools) {
        newToolIds.add(`${serverId}:${tool.tool_id}`);
      }
    }

    const newToolCountByServer = new Map<string, number>();
    for (const [serverId, tools] of toolsByPackage) {
      const safeName = getSafeServerName(serverId);
      newToolCountByServer.set(safeName, (newToolCountByServer.get(safeName) ?? 0) + tools.length);
    }

    currentIndex.metadata = {
      embeddingModel: CURRENT_EMBEDDING_MODEL,
      schemaVersion: TOOL_INDEX_SCHEMA_VERSION,
      etag: options.etag ?? toolData.etag,
      contentHash: toolContentHash,
      packageHashes: Object.fromEntries(newPackageHashes),
      configHash: options.configHash ?? currentIndex.metadata.configHash,
      securityHash: options.securityHash ?? currentIndex.metadata.securityHash,
      appVersion: getPlatformConfig().version,
      toolCount: toolData.tools.length,
      lastRefreshAt: Date.now(),
    };
    currentIndex.toolIds = newToolIds;
    currentIndex.toolCountByServer = newToolCountByServer;
    currentIndex.packageHashes = newPackageHashes;

    await saveMetadata(currentIndex.metadata);

    const mutationCount = recordsToAdd.length + removedPackages.length + modifiedPackages.length;
    if (!isFirstBuild && mutationCount > 0) {
      scheduleOptimizeIfNeeded(mutationCount);
    }
  } catch (error) {
    if (isTooManyOpenFilesError(error)) {
      const { isFirstDetection } = markEnfileDetected(error);
      if (isFirstDetection) {
        log.error('ENFILE: System file descriptor exhaustion detected - tool index operations paused for 60s');
      }
      return { success: false, added: 0, updated: 0, removed: 0, total: currentIndex.toolIds.size };
    }
    throw error;
  } finally {
    releaseMutationBarrier();
    mutationBarrier = null;
  }

  const mutateMs = Date.now() - mutateStart;

  const addedToolCount = addedPackages.reduce(
    (sum, serverId) => sum + (toolsByPackage.get(serverId)?.length ?? 0), 0
  );
  const modifiedToolCount = modifiedPackages.reduce(
    (sum, serverId) => sum + (toolsByPackage.get(serverId)?.length ?? 0), 0
  );

  log.info({
    added: addedPackages.length,
    modified: modifiedPackages.length,
    removed: removedPackages.length,
    unchanged: unchangedPackages.length,
    embeddedToolCount: recordsToAdd.length,
    detectMs,
    embedMs,
    mutateMs,
    totalMs: Date.now() - startTime,
  }, 'Tool index refreshed (incremental)');

  return {
    success: true,
    added: addedToolCount,
    updated: modifiedToolCount,
    removed: removedPackages.length,
    total: toolData.tools.length,
  };
}

async function doFullRefreshToolIndex(options?: { securityHash?: string; configHash?: string }): Promise<{
  success: boolean;
  added: number;
  updated: number;
  removed: number;
  total: number;
}> {
  const toolData = await fetchToolsFromSuperMcp();
  if (!toolData) {
    return { success: false, added: 0, updated: 0, removed: 0, total: 0 };
  }

  // Use server-provided package hashes when available (Super-MCP is the authority).
  // This prevents hash parity issues: without this, Rebel would compute its own
  // hashes using a different algorithm, causing the next manifest comparison to
  // falsely detect all packages as "changed".
  // Treat empty/partial objects as absent — {} is truthy but means "no hashes".
  const rawHashes = toolData.package_hashes;
  const serverPackageHashes = rawHashes && Object.keys(rawHashes).length > 0
    ? new Map(Object.entries(rawHashes))
    : undefined;

  return doRefreshToolIndexFromCatalogData(toolData, {
    packageHashes: serverPackageHashes,
    securityHash: options?.securityHash,
    configHash: options?.configHash,
    updateAliasesFromCatalog: true,
    etag: toolData.etag,
  });
}

async function doRefreshToolIndex(): Promise<{
  success: boolean;
  added: number;
  updated: number;
  removed: number;
  total: number;
}> {
  if (!currentIndex) {
    await initializeToolIndex();
  }

  if (!currentIndex) {
    return { success: false, added: 0, updated: 0, removed: 0, total: 0 };
  }

  // Tier 1: Cheap config hash check (no server spin-up).
  // If MCP package config hasn't changed since last refresh, skip entirely.
  const configHash = await fetchConfigHashFromSuperMcp();
  if (configHash) {
    const configUnchanged = configHash.config_hash === currentIndex.metadata.configHash;
    const securityUnchanged = configHash.security_hash === currentIndex.metadata.securityHash;

    if (configUnchanged && securityUnchanged && currentIndex.table) {
      // Config and security identical — no need to spin up servers
      const descriptions = await loadDescriptionsFromLanceDb();
      replaceDescriptions(descriptions);
      currentIndex.metadata.lastRefreshAt = Date.now();
      await saveMetadata(currentIndex.metadata);
      log.info({ packageCount: configHash.package_count }, 'Tool index up to date (config hash unchanged)');
      return { success: true, added: 0, updated: 0, removed: 0, total: currentIndex.toolIds.size };
    }
    // Config or security changed — fall through to Tier 2 (manifest) for per-package diffing
  }

  // Tier 2: Full manifest (spins up servers, computes per-package content hashes).
  // Only reached when config changed, or config-hash endpoint unavailable.
  const manifest = await fetchManifestFromSuperMcp();
  if (!manifest) {
    return doFullRefreshToolIndex();
  }

  const manifestPackageHashes = new Map(
    manifest.packages.map(pkg => [pkg.package_id, pkg.embedding_hash])
  );

  const {
    addedPackages,
    modifiedPackages,
    removedPackages,
    unchangedPackages,
  } = detectPackageChanges(currentIndex.packageHashes, manifestPackageHashes);

  const hasPackageChanges =
    addedPackages.length > 0 || modifiedPackages.length > 0 || removedPackages.length > 0;
  const securityChanged = manifest.security_hash !== currentIndex.metadata.securityHash;

  if (!hasPackageChanges && !securityChanged) {
    // Don't clear aliases — they aren't sourced from Super-MCP and clearing would lose them
    const descriptions = await loadDescriptionsFromLanceDb();
    replaceDescriptions(descriptions);
    currentIndex.metadata.lastRefreshAt = Date.now();
    currentIndex.metadata.configHash = configHash?.config_hash ?? currentIndex.metadata.configHash;
    currentIndex.metadata.securityHash = manifest.security_hash;
    await saveMetadata(currentIndex.metadata);
    log.info({ toolCount: descriptions.length }, 'Tool index up to date (manifest unchanged)');
    return { success: true, added: 0, updated: 0, removed: 0, total: currentIndex.toolIds.size };
  }

  if (!hasPackageChanges && securityChanged) {
    log.info('Tool security hash changed without package changes — falling back to full refresh');
    return doFullRefreshToolIndex({ securityHash: manifest.security_hash, configHash: configHash?.config_hash });
  }

  const changedPackageIds = [...addedPackages, ...modifiedPackages];
  let changedToolData: ToolCatalogResponse = {
    tools: [],
    etag: currentIndex.metadata.etag,
  };

  if (changedPackageIds.length > 0) {
    const selectiveToolData = await fetchToolsForPackages(changedPackageIds);
    if (!selectiveToolData) {
      log.info({ packageCount: changedPackageIds.length }, 'Selective tool fetch failed, falling back to full refresh');
      return doFullRefreshToolIndex({ securityHash: manifest.security_hash, configHash: configHash?.config_hash });
    }
    changedToolData = selectiveToolData;
  }

  const unchangedTools = await loadStoredToolsFromLanceDb(new Set(unchangedPackages));
  const combinedToolData: ToolCatalogResponse = {
    tools: [...unchangedTools, ...changedToolData.tools],
    etag: currentIndex.metadata.etag,
  };
  const fetchedAllManifestPackages = changedPackageIds.length === manifest.packages.length;

  return doRefreshToolIndexFromCatalogData(combinedToolData, {
    packageHashes: manifestPackageHashes,
    configHash: configHash?.config_hash,
    securityHash: manifest.security_hash,
    updateAliasesFromCatalog: false,
    etag: fetchedAllManifestPackages ? changedToolData.etag : currentIndex.metadata.etag,
  });
}

/**
 * Mark tool index reads as stale immediately after an MCP config change.
 * Returns the new invalidation generation, used to resolve refresh races.
 */
export function markToolIndexInvalidated(reason: string): number {
  const normalizedReason = reason.trim().length > 0 ? reason : 'unspecified';
  const generation = freshnessState.generation + 1;
  freshnessRollbackSnapshots.set(generation, { ...freshnessState });

  freshnessState.generation = generation;
  freshnessState.isStale = true;
  freshnessState.staleReason = normalizedReason;
  freshnessState.staleSince = Date.now();
  freshnessState.staleGeneration = generation;
  freshnessState.lastRefreshError = null;

  log.info({ generation, reason: normalizedReason }, 'Tool index marked stale');
  return generation;
}

/**
 * Revert the latest invalidation generation (used when config reconfigure fails).
 */
export function rollbackToolIndexInvalidation(generation: number): void {
  if (generation !== freshnessState.generation) {
    log.debug(
      { generation, currentGeneration: freshnessState.generation },
      'Ignoring stale rollback for outdated generation',
    );
    return;
  }

  const snapshot = freshnessRollbackSnapshots.get(generation);
  if (snapshot) {
    Object.assign(freshnessState, snapshot);
    freshnessRollbackSnapshots.delete(generation);
    dropFreshnessSnapshotsUpTo(freshnessState.generation);
    log.info(
      { generation, restoredGeneration: freshnessState.generation, isStale: freshnessState.isStale },
      'Rolled back tool index stale generation',
    );
    return;
  }

  freshnessRollbackSnapshots.delete(generation);
  freshnessState.generation = Math.max(generation - 1, 0);
  freshnessState.isStale = false;
  freshnessState.staleReason = null;
  freshnessState.staleSince = null;
  freshnessState.staleGeneration = null;
  freshnessState.lastRefreshError = null;
  log.warn({ generation }, 'Tool index stale rollback missing snapshot; cleared stale state');
}

/**
 * Complete the refresh lifecycle for an invalidation generation.
 * Success clears stale state only when generation is still latest.
 */
export function markToolIndexRefreshComplete(
  generation: number,
  result: ToolIndexRefreshCompletion,
): void {
  if (generation !== freshnessState.generation) {
    log.debug(
      { generation, currentGeneration: freshnessState.generation },
      'Ignoring tool index refresh completion for outdated generation',
    );
    return;
  }

  freshnessRollbackSnapshots.delete(generation);

  if (result.success) {
    freshnessState.isStale = false;
    freshnessState.staleReason = null;
    freshnessState.staleSince = null;
    freshnessState.staleGeneration = null;
    freshnessState.lastRefreshError = null;
    dropFreshnessSnapshotsUpTo(generation);
    log.info({ generation }, 'Tool index marked fresh');
    return;
  }

  const errorMessage = result.error?.trim() || 'Tool index refresh failed';
  freshnessState.isStale = true;
  if (freshnessState.staleSince == null) {
    freshnessState.staleSince = Date.now();
  }
  if (freshnessState.staleGeneration == null) {
    freshnessState.staleGeneration = generation;
  }
  if (!freshnessState.staleReason) {
    freshnessState.staleReason = 'refresh-failed';
  }
  freshnessState.lastRefreshError = errorMessage;
  log.warn({ generation, error: errorMessage }, 'Tool index refresh failed; stale gate remains active');
}

/**
 * Whether semantic tool reads are safe to serve.
 */
export function isToolIndexUsable(): boolean {
  return !freshnessState.isStale && currentIndex?.table != null && currentIndex.toolIds.size > 0;
}

/**
 * Build final search results from raw LanceDB rows with per-package limits.
 * Computes cosine similarity manually from vectors for threshold comparison
 * (LanceDB _distance is null in hybrid mode). Uses _relevance_score (RRF) for
 * ranking order only. In vector-only mode, falls back to 1 - _distance.
 */
function buildToolResults(
  rawResults: Array<Record<string, unknown>>,
  queryEmbedding: Float32Array,
  threshold: number,
  limit: number,
  maxPerPackage: number,
  startTime: number,
  isHybrid: boolean,
): ToolSearchResult[] {
  const results: ToolSearchResult[] = [];
  const packageCounts = new Map<string, number>();

  for (const row of rawResults) {
    const record = row as unknown as ToolEmbeddingRecord & {
      _distance?: number;
      _relevance_score?: number;
    };

    // Compute cosine similarity: in hybrid mode _distance is null, so compute manually.
    // In vector-only mode, use 1 - _distance for consistency with previous behavior.
    const score = isHybrid
      ? 1 - cosineDistance(queryEmbedding, record.vector)
      : 1 - (record._distance ?? 1);

    if (!Number.isFinite(score) || score < threshold) continue;

    // Check per-server limit
    const pkgCount = packageCounts.get(record.serverId) ?? 0;
    if (pkgCount >= maxPerPackage) continue;

    let inputSchema: unknown = {};
    try {
      inputSchema = JSON.parse(record.inputSchema);
    } catch {
      // Keep empty object
    }

    results.push({
      toolId: record.toolId,
      serverId: record.serverId,
      serverName: record.serverName,
      name: record.name,
      description: record.description,
      summary: record.summary,
      inputSchema,
      score,
    });

    packageCounts.set(record.serverId, pkgCount + 1);
    if (results.length >= limit) break;
  }

  log.debug({
    resultCount: results.length,
    elapsedMs: Date.now() - startTime,
  }, 'Tool search completed');

  return results;
}

/**
 * Search for tools using hybrid FTS + vector search with RRF reranking.
 * Falls back to vector-only when FTS is unavailable or hybrid search fails.
 *
 * Score semantics: cosine similarity (0-1) is used for threshold comparison.
 * In hybrid mode, RRF reranker determines ranking order; cosine similarity
 * is computed manually from vectors since _distance is null in hybrid mode.
 *
 * @param query - Natural language search query
 * @param limit - Maximum total tools to return (default 10)
 * @param threshold - Minimum relevance score 0-1 (default 0.3)
 * @param maxPerPackage - Maximum tools from any single package (default 5)
 */
export async function searchTools(
  query: string,
  limit: number = 10,
  threshold: number = 0.3,
  maxPerPackage: number = 5
): Promise<ToolSearchResult[]> {
  if (freshnessState.isStale) {
    log.debug(
      { staleGeneration: freshnessState.staleGeneration, staleReason: freshnessState.staleReason },
      'Tool index stale; returning empty search results',
    );
    return [];
  }

  // Wait for any in-progress mutation to complete before reading
  // This prevents ENOENT errors during incremental delete/add
  if (mutationBarrier) {
    await mutationBarrier;
  }

  if (!isToolIndexUsable()) {
    if (freshnessState.isStale) {
      log.debug(
        { staleGeneration: freshnessState.staleGeneration, staleReason: freshnessState.staleReason },
        'Tool index stale after mutation barrier; returning empty results',
      );
    } else {
      log.debug('Tool index not initialized, returning empty results');
    }
    return [];
  }

  if (!query || query.trim().length === 0) {
    return [];
  }

  const startTime = Date.now();

  try {
    // Generate embedding first (this can take time)
    const queryEmbedding = await getEmbeddingGenerator().generateQueryEmbedding(query);

    // Re-check barrier after embedding generation to handle TOCTOU race:
    // A mutation may have started while we were computing the embedding
    if (mutationBarrier) {
      await mutationBarrier;
    }

    if (!isToolIndexUsable()) {
      if (freshnessState.isStale) {
        log.debug(
          { staleGeneration: freshnessState.staleGeneration, staleReason: freshnessState.staleReason },
          'Tool index became stale during search; returning empty results',
        );
      } else {
        log.debug('Tool index became unavailable during search, returning empty results');
      }
      return [];
    }

    const activeIndex = currentIndex;
    if (!activeIndex?.table) {
      return [];
    }

    let rawResults: Array<Record<string, unknown>>;
    let isHybrid = false;

    if (activeIndex.ftsReady) {
      // Hybrid search: FTS on search_text + vector + RRF reranking
      const lancedb = nativeRequire('@lancedb/lancedb') as typeof import('@lancedb/lancedb');
      const ftsQuery = new lancedb.MultiMatchQuery(query, ['search_text']);

      let reranker;
      try {
        reranker = await lancedb.rerankers.RRFReranker.create(60);
      } catch (err) {
        log.warn({ err }, 'RRFReranker creation failed — falling back to vector-only');
        // Fall through to vector-only below
        rawResults = await activeIndex.table
          .vectorSearch(Array.from(queryEmbedding))
          .distanceType('cosine')
          .limit(limit * 3)
          .toArray() as Array<Record<string, unknown>>;
        return buildToolResults(rawResults, queryEmbedding, threshold, limit, maxPerPackage, startTime, false);
      }

      try {
        rawResults = await activeIndex.table
          .query()
          .nearestTo(Array.from(queryEmbedding))
          .distanceType('cosine')
          .fullTextSearch(ftsQuery)
          .rerank(reranker)
          .limit(limit * 3)
          .toArray() as Array<Record<string, unknown>>;
        isHybrid = true;
      } catch (hybridErr) {
        log.warn({ err: hybridErr }, 'Hybrid tool search failed — falling back to vector-only');
        rawResults = await activeIndex.table
          .vectorSearch(Array.from(queryEmbedding))
          .distanceType('cosine')
          .limit(limit * 3)
          .toArray() as Array<Record<string, unknown>>;
      }
    } else {
      // Vector-only fallback
      rawResults = await activeIndex.table
        .vectorSearch(Array.from(queryEmbedding))
        .distanceType('cosine')
        .limit(limit * 3)
        .toArray() as Array<Record<string, unknown>>;
    }

    return buildToolResults(rawResults, queryEmbedding, threshold, limit, maxPerPackage, startTime, isHybrid);
  } catch (error) {
    if (isTooManyOpenFilesError(error)) {
      const { isFirstDetection } = markEnfileDetected(error);
      if (isFirstDetection) {
        log.error('ENFILE: System file descriptor exhaustion detected - tool index operations paused for 60s');
      }
      return [];
    }
    log.error({ err: error, query }, 'Tool search failed');
    return [];
  }
}

/**
 * Look up a tool's schema by exact server ID and tool ID.
 * Best-effort: returns null if the index is unavailable or the tool isn't found.
 *
 * @param serverId - Server/package ID (e.g., "GoogleWorkspace-user-example-com")
 * @param toolId - Tool ID (e.g., "gmail_search_emails")
 * @returns Parsed inputSchema object, or null if unavailable
 */
export async function getToolSchema(serverId: string, toolId: string): Promise<unknown | null> {
  if (freshnessState.isStale) {
    return null;
  }

  // Wait for any in-progress mutation to complete before reading
  if (mutationBarrier) {
    await mutationBarrier;
  }

  if (!isToolIndexUsable()) {
    return null;
  }

  const table = currentIndex?.table;
  if (!table) {
    return null;
  }

  try {
    const results = await table
      .query()
      .where(and(eq('serverId', serverId), eq('toolId', toolId)))
      .select(['inputSchema'])
      .limit(1)
      .toArray();

    if (results.length === 0) {
      return null;
    }

    const record = results[0] as { inputSchema?: string };
    if (!record.inputSchema) {
      return null;
    }

    return JSON.parse(record.inputSchema);
  } catch (error) {
    log.debug({ serverId, toolId, err: error }, 'Schema lookup failed (best-effort)');
    return null;
  }
}

/**
 * Get the current index status
 */
export function getToolIndexStatus(): ToolIndexStatus {
  if (!currentIndex) {
    return {
      isInitialized: false,
      toolCount: 0,
      lastRefreshAt: null,
      etag: null,
      byServer: undefined,
      isStale: freshnessState.isStale,
      staleReason: freshnessState.staleReason,
      staleSince: freshnessState.staleSince,
      staleGeneration: freshnessState.staleGeneration,
      freshnessGeneration: freshnessState.generation,
      lastRefreshError: freshnessState.lastRefreshError,
    };
  }

  return {
    isInitialized: true,
    toolCount: currentIndex.toolIds.size,
    lastRefreshAt: currentIndex.metadata.lastRefreshAt || null,
    etag: currentIndex.metadata.etag || null,
    byServer: Object.fromEntries(currentIndex.toolCountByServer),
    isStale: freshnessState.isStale,
    staleReason: freshnessState.staleReason,
    staleSince: freshnessState.staleSince,
    staleGeneration: freshnessState.staleGeneration,
    freshnessGeneration: freshnessState.generation,
    lastRefreshError: freshnessState.lastRefreshError,
  };
}

/**
 * Check if the tool index has been populated
 */
export function hasToolIndex(): boolean {
  return isToolIndexUsable();
}
