/**
 * File Watcher Service
 *
 * Watches workspace files for changes and triggers reindexing.
 * Uses chokidar for file discovery and watching.
 * Respects .gitignore patterns and common ignore patterns.
 *
 * Uses an async queue with proper backpressure to prevent memory exhaustion
 * during large workspace indexing.
 */

import path from "node:path";
// S4.1c: all workspace-fs READS go through the bounded boundary (no raw `fs` reads
// remain in this file — it has no writes). A dead cloud mount degrades to
// `reconnecting`, which `unwrapWatcherRead` throws so the existing per-site try/catches
// skip-and-continue (never hang). `cloudLaneOptionForPath` bridges PATTERN-cloud paths
// to the cloud lane; CONTAINMENT (configured spaces) is the boundary's default.
import {
  workspaceFs,
  cloudLaneOptionForPath,
  type WorkspaceFsOutcome,
} from '@core/services/boundedWorkspaceFs';
import { logger } from "@core/logger";
import { toPortablePath, relativePortablePath } from '@core/utils/portablePath';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import { redactSensitiveData } from '@core/utils/logRedaction';
import { WORKSPACE_CONFLICT_MARKER } from '@shared/conflictPatterns';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { detectCloudStorage } from "../utils/cloudStorageUtils";
import { workspaceWatcherService } from "./workspaceWatcherService";
import {
  initializeIndex,
  indexFile,
  refreshReadTable,
  needsReindexing,
  closeIndex,
  clearIndex,
  getIndexStatus,
  getScanCompletedAt,
  getTotalFilesAtCompletion,
  markScanComplete,
  hydrateIndexedPathsCache,
  reconcileFileVectorsIfNeeded,
  hasIndex,
  refreshEnhancementCounts,
  getIndexedPaths,
  getWorkspaceSymlinkMap,
  rebuildWorkspaceSymlinkMap,
  type IndexStatus,
  type IndexState,
} from "./fileIndexService";
// Atlas workspace notification — wired via callback injection to break
// atlasService↔fileWatcherService circular dependency (see coreStartup.ts).
let notifyAtlasWorkspaceChanged: ((workspacePath: string | null) => void) | null = null;

/**
 * Register a callback invoked when the watched workspace changes.
 * Called once at app startup to inject the atlasService dependency.
 */
export function registerAtlasWorkspaceCallback(cb: (workspacePath: string | null) => void): void {
  notifyAtlasWorkspaceChanged = cb;
}

function scheduleFileVectorsReconcile(workspacePath: string): void {
  void reconcileFileVectorsIfNeeded().catch((error) => {
    logger.warn({ err: error, workspacePath }, 'file_vectors.reconcile_background_failure');
  });
}

import * as sourceMetadataStore from "./sourceMetadataStore";
import * as entityMetadataStore from "./entityMetadataStore";
// Removal Coordinator (Stage 4a): the single door through which an index entry is
// removed from all three stores. queueFileRemove/cleanupStaleEntries/the hygiene
// purges all route through it with a typed RemovalReason.
import {
  removeMetadataStoresEntry,
  removeVectorIndexEntry,
  removeVectorIndexEntries,
  type CoordinatorRemovalReason,
  type RemovalStoreSelection,
} from "./indexRemovalCoordinator";
// Stage 4c (Opus-F4): the readlink-only, cached cloud-space containment classifier.
// `cleanupStaleEntries` consults it so a CLOUD-space indexed path is NOT bare-
// `fs.realpath`'d on the main thread (a residual dead-mount hang vector) — cloud
// paths are skipped + retained (consistent with R1; the healthy-walk producer in
// Stage 6/7 reconciles genuinely-absent cloud entries).
import { classifyPathForRemoval } from "@core/services/cloudSpaceContainment";

// Typed classifications each call-site applies. Stage 4c: `cleanupStaleEntries`'
// fs-absence detections are `absence-unverified` — a bare `fs.realpath` ENOENT is
// NOT an authoritative absence claim for a CLOUD space (the proof PRODUCER — a
// completed-healthy per-space walk — lands with admission in Stage 6/7). So a cloud
// entry under this reason is RETAINED; a LOCAL entry is purged as before.
const WATCHER_UNLINK_REASON: CoordinatorRemovalReason = { kind: 'watcher-unlink' };
const ABSENCE_REASON: CoordinatorRemovalReason = { kind: 'absence-unverified' };
const HYGIENE_REASON: CoordinatorRemovalReason = { kind: 'hygiene' };
const METADATA_SOURCE_AND_ENTITY: RemovalStoreSelection = { source: true, entity: true, vectorIndex: false };
const METADATA_ENTITY_ONLY: RemovalStoreSelection = { source: false, entity: true, vectorIndex: false };
import { waitForModelReady, isEmbeddingServiceReady } from "./embeddingService";
import { stopEnhancement, startEnhancement } from "./enhancementService";
import {
  isAppCurrentlyBlurred,
  onBlurStateChange,
  waitForFocus,
  createBackgroundConsumerLatch,
  type BackgroundConsumerLatch,
} from "./visibilityAwareScheduler";
import { getSettings } from "@core/services/settingsStore";
import { tryConvertToWorkspacePath } from "../utils/systemUtils";

// Queue configuration
//
// DESIGN NOTE: The queue processes files SEQUENTIALLY (one at a time), not in parallel.
// This is intentional for two reasons:
// 1. The Worker Thread doing embeddings is the actual bottleneck, not the queue.
//    Running multiple files "in parallel" just means more waiting in the worker queue.
// 2. Sequential processing avoids same-file race conditions. If File A is modified twice
//    quickly, sequential ensures the second operation completes after the first. Parallel
//    processing would require per-file serialization to prevent index corruption.
//
// If profiling shows the queue (not the worker) is a bottleneck, concurrency can be added
// via p-queue with per-file serialization. See docs/plans/obsolete/251226_queue_migration_to_pqueue.md.
//
const INTER_FILE_DELAY_MS = 20; // Yield to event loop between files
const GC_INTERVAL = 50; // Longer pause every N files for garbage collection
const GC_PAUSE_MS = 100; // Duration of GC pause
const MAX_QUEUE_SIZE = 500000; // Backpressure limit - reject new items if exceeded
const INITIAL_SCAN_DELAY_MS = 200; // Delay before processing after chokidar 'ready'
const BACKGROUND_DISCOVERY_DELAY_MS = 5_000; // Keep startup responsive before reconciling offline changes

// Skip full rescan if index was updated recently (within this threshold)
// This dramatically speeds up app restart - we only watch for new changes
const SKIP_RESCAN_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

// Skip auto-enhancement for large workspaces - user must manually trigger.
// Exported so the enhancement health check can mirror this gate without drift.
export const AUTO_ENHANCE_FILE_THRESHOLD = 1000;

/**
 * Patterns to always ignore. Display-only: surfaced via getIgnoredPatterns()
 * for UI/diagnostics — NOT passed to chokidar (this service rides on
 * workspaceWatcherService events; the watcher's real ignore list is
 * WORKSPACE_IGNORE_PATTERNS in workspaceWatcherService.ts).
 */
const IGNORED_PATTERNS: (string | RegExp)[] = [
  // Version control
  "**/.git/**",
  "**/.svn/**",
  "**/.hg/**",

  // Dependencies
  "**/node_modules/**",
  "**/bower_components/**",
  "**/vendor/**",
  "**/packages/**",

  // Build outputs
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.output/**",
  "**/target/**",

  // Cache directories
  "**/.cache/**",
  "**/.parcel-cache/**",
  "**/.turbo/**",
  "**/.eslintcache",
  "**/.stylelintcache",

  // Hidden cache files (app caches, not useful content)
  "**/.*cache*",
  "**/.*_cache*",

  // Application data directories (configs/indexes, not content)
  "**/.obsidian/**",
  "**/.leann/**",
  "**/.rebel/**",

  // Index/database files (other tools' indexes)
  "**/*.idx",
  "**/*.index",

  // Test coverage
  "**/coverage/**",
  "**/.nyc_output/**",

  // Python
  "**/__pycache__/**",
  "**/.pytest_cache/**",
  "**/venv/**",
  "**/.venv/**",
  "**/env/**",
  "**/*.egg-info/**",

  // IDE/Editor
  "**/.idea/**",
  "**/.vscode/**",
  "**/*.swp",
  "**/*.swo",
  "**/*~",

  // OS files
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/desktop.ini",

  // Lock files
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/Gemfile.lock",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/composer.lock",

  // Logs
  "**/*.log",
  "**/logs/**",

  // Minified/compiled assets
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.chunk.*",

  // Binary/media files (not useful for semantic search)
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.ico",
  "**/*.svg",
  "**/*.webp",
  "**/*.mp3",
  "**/*.mp4",
  "**/*.wav",
  "**/*.avi",
  "**/*.mov",
  "**/*.pdf",
  "**/*.zip",
  "**/*.tar",
  "**/*.gz",
  "**/*.rar",
  "**/*.7z",
  "**/*.exe",
  "**/*.dll",
  "**/*.so",
  "**/*.dylib",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.eot",

  // Temporary files
  "**/*.tmp",
  "**/*.temp",
  "**/tmp/**",
  "**/temp/**",

  // Environment and secret files - NEVER index these
  "**/.env",
  "**/.env.*",
  "**/.env.local",
  "**/.env.*.local",
  "**/*.pem",
  "**/*.key",
  "**/*.crt",
  "**/*.p12",
  "**/*.pfx",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/*.secret",
  "**/*.secrets",
  "**/credentials*",
  "**/secrets/**",
  "**/.secrets/**",
];

// Maximum depth for manual file discovery.
// Note: This is intentionally lower than workspaceWatcherService's depth (12) to limit
// CPU usage during initial scans. Files at depth 11-12 won't be in the initial index
// but will be indexed when they change (the shared watcher will emit events for them).
const DISCOVERY_MAX_DEPTH = 10;

/**
 * Check if a path should be ignored based on common patterns.
 * Uses simple substring/suffix matching for performance during directory walks.
 * Should match the intent of WORKSPACE_IGNORE_PATTERNS in workspaceWatcherService.
 */
function shouldIgnorePath(filePath: string): boolean {
  const normalized = toPortablePath(filePath);
  
  // Check common directory patterns (must match WORKSPACE_IGNORE_PATTERNS)
  const ignoreDirs = [
    '/node_modules/', '/.git/', '/.svn/', '/.hg/',
    '/bower_components/', '/vendor/', '/packages/',
    '/dist/', '/build/', '/out/', '/.next/', '/.nuxt/', '/.output/', '/target/',
    '/venv/', '/.venv/', '/env/', '/__pycache__/', '/.pytest_cache/',
    '/coverage/', '/.nyc_output/',
    '/.cache/', '/.parcel-cache/', '/.turbo/',
    '/tmp/', '/temp/',
    '/.obsidian/', '/.leann/', '/.rebel/', '/.idea/', '/.vscode/',
    '/rebel-system/', '/secrets/', '/.secrets/',
    '/logs/',
  ];
  
  for (const dir of ignoreDirs) {
    if (normalized.includes(dir)) return true;
  }
  
  // Check file suffixes (handles .min.js, .min.css, .chunk.*, etc.)
  // Note: path.extname('foo.min.js') returns '.js', so we need suffix checks
  const ignoreSuffixes = [
    '.min.js', '.min.css', '.chunk.js', '.chunk.css',
    '.map', '.log', '.tmp', '.temp', '.swp', '.swo',
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
    '.mp3', '.mp4', '.wav', '.avi', '.mov',
    '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
    '.exe', '.dll', '.so', '.dylib',
    '.woff', '.woff2', '.ttf', '.eot',
    '.pem', '.key', '.crt', '.p12', '.pfx',
    '.idx', '.index',
    '.secret', '.secrets',
    '.egg-info',
  ];
  
  const lowerPath = normalized.toLowerCase();
  for (const suffix of ignoreSuffixes) {
    if (lowerPath.endsWith(suffix)) return true;
  }
  
  // Check specific filenames
  const basename = path.basename(normalized);
  const ignoreFiles = [
    '.DS_Store', 'Thumbs.db', 'desktop.ini',
    'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
    'Gemfile.lock', 'Cargo.lock', 'poetry.lock', 'composer.lock',
    '.eslintcache', '.stylelintcache',
    '.rebel-maintenance.lock.json',
  ];

  // Maintenance lease conflict-cloud / sidecar variants (REBEL-1HK class).
  if (basename.startsWith('.rebel-maintenance.lock.json')) return true;
  
  if (ignoreFiles.includes(basename)) return true;
  if (basename.startsWith('.env')) return true;
  if (basename.startsWith('id_rsa') || basename.startsWith('id_ed25519')) return true;
  if (basename.startsWith('credentials')) return true;
  // Hidden cache files
  if (basename.startsWith('.') && (basename.includes('cache') || basename.includes('_cache'))) return true;
  
  return false;
}

/**
 * Discover files in a directory for initial indexing.
 * Used when skipRescan=false since workspaceWatcherService uses ignoreInitial: true.
 *
 * Backed by `safeWalkDirectory` so we get realpath cycle detection, depth,
 * path-length, and entry caps automatically — without these guards a user
 * with a self-nested workspace tripped REBEL-506 (ENAMETOOLONG storms).
 */
async function discoverFiles(
  rootDir: string,
  onFile: (filePath: string) => void,
  signal?: AbortSignal
): Promise<number> {
  let count = 0;

  await safeWalkDirectory(rootDir, {
    signal,
    maxDepth: DISCOVERY_MAX_DEPTH,
    // Cloud-symlink skipping is now handled by safeWalkDirectory's default-on
    // `skipCloudSymlinkTargets` (RC-1 generalised into the shared walker — one
    // source of truth). A skipped cloud symlink surfaces as the
    // 'cloud-symlink-skipped' truncation reason, logged via onTruncated below.
    onDirectory: ({ absolutePath }) => {
      if (shouldIgnorePath(absolutePath)) return false;
      return true;
    },
    onFile: ({ absolutePath }) => {
      if (shouldIgnorePath(absolutePath)) return;
      onFile(absolutePath);
      count += 1;
    },
    onTruncated: ({ reasons, entriesVisited }) => {
      // A cloud-symlink skip is a deliberate exclusion, not a cap — log it at
      // info so the "we declined to descend into a cloud mount during discovery"
      // signal shows up in diagnostics bundles (the postmortem wanted this).
      // True caps (depth/path/entries) and unreadable subtrees stay at debug.
      if (reasons.includes('cloud-symlink-skipped')) {
        logger.info(
          { rootDir, reasons, entriesVisited },
          'discoverFiles skipped at least one cloud-mount symlink — initial indexing excludes that subtree',
        );
        return;
      }
      logger.debug(
        { rootDir, reasons, entriesVisited },
        'discoverFiles hit a traversal cap — initial indexing may be incomplete',
      );
    },
  });

  return count;
}

/**
 * Symlink telemetry result
 */
interface SymlinkTelemetry {
  /** Number of symlinks/junctions found at workspace root level */
  symlinkCount: number;
  /** Details of each symlink found */
  symlinks: Array<{
    name: string;
    target: string;
    isOutsideWorkspace: boolean;
    /**
     * Cloud-storage provider of the symlink's RESOLVED TARGET (not the
     * workspace root), or null if the target is local. Non-null means the
     * scan/watch surfaces refuse to descend into it (RC-1).
     */
    cloudProvider: string | null;
  }>;
  /** Whether workspace itself is inside cloud storage */
  cloudStorageProvider: string | null;
  /**
   * True when the workspace ROOT is itself cloud-classified and we therefore
   * SKIPPED the root `fs.readdir` symlink analysis to avoid blocking the main
   * thread on a dead FUSE mount (Stage 5 cloud-root hang-proofing). The telemetry
   * is degraded (no per-symlink detail) but the watcher start never hangs.
   */
  rootIsCloudSkipped: boolean;
  /** Time taken to analyze in ms */
  analysisTimeMs: number;
}

/**
 * Analyze symlinks at the workspace root for telemetry purposes.
 * This helps us understand the impact of followSymlinks: true on performance.
 */
/**
 * S4.1c — unwrap a bounded-boundary read outcome to the throw-based contract the
 * read sites already expect. `ok` → value; a real fs error → rethrow it RAW (so
 * `err.code` handling, e.g. the ENOENT/ENOTDIR checks in cleanupStaleEntries, is
 * byte-identical to the prior bare-fs throw); `reconnecting` (dead cloud mount,
 * reclaimed) → throw a typed error so the existing per-site try/catch degrades the
 * one file/entry and continues — a degraded cloud read can never be silently
 * confused with success or with absence.
 */
function unwrapWatcherRead<T>(outcome: WorkspaceFsOutcome<T>): T {
  if (outcome.status === 'ok') return outcome.value;
  if (outcome.status === 'reconnecting') {
    throw new Error(`workspace cloud mount unavailable (reconnecting): ${outcome.path}`);
  }
  throw outcome.error;
}

async function analyzeWorkspaceSymlinks(workspacePath: string): Promise<SymlinkTelemetry> {
  const startTime = Date.now();
  const cloudInfo = detectCloudStorage(workspacePath);
  const result: SymlinkTelemetry = {
    symlinkCount: 0,
    symlinks: [],
    cloudStorageProvider: cloudInfo.isCloud ? cloudInfo.provider ?? null : null,
    rootIsCloudSkipped: false,
    analysisTimeMs: 0,
  };

  // Stage-5 cloud-root hang-proofing: this is TELEMETRY ONLY, and the root
  // `fs.readdir` below would block the main thread unbounded if `workspacePath` is
  // itself a dead/unresponsive cloud FUSE mount. Pure-string `detectCloudStorage`
  // (already computed, no I/O) lets us decide BEFORE touching the mount: if the
  // root is cloud-classified, skip the analysis and degrade gracefully (we still
  // report the provider; we just don't enumerate symlinks). Never blocks boot.
  if (cloudInfo.isCloud) {
    result.rootIsCloudSkipped = true;
    result.analysisTimeMs = Date.now() - startTime;
    return result;
  }

  try {
    const entries = unwrapWatcherRead(
      await workspaceFs.readdirWithFileTypes(workspacePath, cloudLaneOptionForPath(workspacePath)),
    );

    for (const entry of entries) {
      if (entry.isSymbolicLink) {
        result.symlinkCount++;

        try {
          const symlinkPath = path.join(workspacePath, entry.name);
          const target = unwrapWatcherRead(
            await workspaceFs.readlink(symlinkPath, cloudLaneOptionForPath(symlinkPath)),
          );
          const resolvedTarget = path.isAbsolute(target) 
            ? target 
            : path.resolve(path.dirname(symlinkPath), target);
          
          // Check if target is outside the workspace
          const relativePath = path.relative(workspacePath, resolvedTarget);
          const isOutsideWorkspace = relativePath.startsWith('..') || path.isAbsolute(relativePath);

          // Detect cloud on the RESOLVED TARGET (the bug was detecting only on
          // the workspace root). This is what the scan/watch surfaces gate on.
          const targetCloud = detectCloudStorage(resolvedTarget);

          result.symlinks.push({
            name: entry.name,
            target: resolvedTarget,
            isOutsideWorkspace,
            cloudProvider: targetCloud.isCloud ? targetCloud.provider ?? null : null,
          });
        } catch {
          // Broken symlink or permission error - still count it
          result.symlinks.push({
            name: entry.name,
            target: '(unreadable)',
            isOutsideWorkspace: true,
            cloudProvider: null,
          });
        }
      }
    }
  } catch (err) {
    logger.warn({ err, workspacePath }, 'Failed to analyze workspace symlinks for telemetry');
  }

  result.analysisTimeMs = Date.now() - startTime;
  return result;
}

/**
 * Async Queue Implementation
 *
 * A simple FIFO queue with backpressure and deduplication by file path.
 * Processes items SEQUENTIALLY - see design note above for rationale.
 *
 * Deduplication: If a file is enqueued while already pending, the old entry is
 * removed and a new entry added at the end. This ensures the latest operation
 * for each path is processed, and avoids redundant work.
 */
interface QueueItem {
  type: "add" | "remove";
  filePath: string;
  addedAt: number;
}

interface AsyncQueue {
  items: QueueItem[];
  isStartingProcessing: boolean;
  isProcessing: boolean;
  processedCount: number;
  abortController: AbortController | null;
}

interface WatcherState {
  workspacePath: string | null;
  queue: AsyncQueue;
  totalFilesDiscovered: number;
  filesIndexedThisSession: number; // Files actually re-indexed this session (not skipped)
  onProgressCallback: ((status: IndexStatus) => void) | null;
  isInitialScanComplete: boolean;
  hasRunPostScanFinalization: boolean; // True after first markScanComplete + enhancement gating
  isSubscribed: boolean; // Track if we're subscribed to workspaceWatcherService
  backgroundDiscoveryInProgress: boolean;
  backgroundDiscoveryAbortController: AbortController | null;
  backgroundDiscoveryTimeout: ReturnType<typeof setTimeout> | null;
}

/**
 * Indexer lifecycle counters exposed via `getIndexerStats()` for Stage 5 telemetry.
 *
 * Reset semantics: **session-scoped, not process-scoped.** These counters are
 * reset on every call to `startWatching()`, `pauseWatching()`, and `stopWatching()`
 * — one logical indexing "session" corresponds to one active watcher. Operators
 * interpreting `REBEL_PERF_MODE=1` log output should treat gaps between sessions
 * as counter resets, not as "no work happened."
 *
 * Invariant: `queueItemsProcessed == queueItemsEnqueued` (modulo in-flight)
 * implies no silent drops; deviations indicate a regression in Stage 4's
 * pause/resume path. `queueItemsFailed` covers both add-path reindex failures
 * and remove-path unindex failures so counter coverage is symmetric.
 */
export interface IndexerStats {
  queueItemsEnqueued: number;
  queueItemsProcessed: number;
  queueItemsFailed: number;
  blurPauseCount: number;
  blurPauseTotalMs: number;
  maxPauseTimeoutsFired: number;
  /** Stage 6 (260508): how many times the queue paused on the active-turn signal. Session-scoped. */
  turnActivePauseCount: number;
  /** Stage 6 (260508): cumulative ms paused on the active-turn signal. Session-scoped. */
  turnActivePauseTotalMs: number;
  /** Stage 6 (260508): how many times the per-consumer latch entered degraded mode. Session-scoped. */
  degradedModeEntryCount: number;
}

const state: WatcherState = {
  workspacePath: null,
  queue: {
    items: [],
    isStartingProcessing: false,
    isProcessing: false,
    processedCount: 0,
    abortController: null,
  },
  totalFilesDiscovered: 0,
  filesIndexedThisSession: 0, // Reset each session, tracks actual reindexing work
  onProgressCallback: null,
  isInitialScanComplete: false,
  hasRunPostScanFinalization: false,
  isSubscribed: false,
  backgroundDiscoveryInProgress: false,
  backgroundDiscoveryAbortController: null,
  backgroundDiscoveryTimeout: null,
};

const indexerStats = {
  queueItemsEnqueued: 0,
  queueItemsFailed: 0,
  blurPauseCount: 0,
  blurPauseTotalMs: 0,
  maxPauseTimeoutsFired: 0,
  turnActivePauseCount: 0,
  turnActivePauseTotalMs: 0,
  degradedModeEntryCount: 0,
};

function resetIndexerStats(): void {
  indexerStats.queueItemsEnqueued = 0;
  indexerStats.queueItemsFailed = 0;
  indexerStats.blurPauseCount = 0;
  indexerStats.blurPauseTotalMs = 0;
  indexerStats.maxPauseTimeoutsFired = 0;
  indexerStats.turnActivePauseCount = 0;
  indexerStats.turnActivePauseTotalMs = 0;
  indexerStats.degradedModeEntryCount = 0;
}

// Store listener refs for cleanup (CRITICAL: never use removeAllListeners on shared emitter)
const eventListeners = {
  fileAdded: (filePath: string) => {
    state.totalFilesDiscovered++;
    queueFileAdd(filePath);
  },
  fileChanged: (filePath: string) => {
    queueFileAdd(filePath);
  },
  fileRemoved: (filePath: string) => {
    state.totalFilesDiscovered--;
    queueFileRemove(filePath);
  },
  // A directory add/remove can introduce or drop a symlinked mount, which
  // changes the workspace's symlink topology. Rebuild the cached symlink
  // registry so hot-path path conversions stay correct (Stage 2 invalidation).
  // Bounded depth-4 scan; rare event (directory churn), so the rebuild cost is
  // amortized away. chokidar surfaces a symlink-to-directory as addDir/unlinkDir.
  dirAdded: (_dirPath: string) => {
    rebuildWorkspaceSymlinkMap();
  },
  dirRemoved: (_dirPath: string) => {
    rebuildWorkspaceSymlinkMap();
  },
};

/**
 * Delay helper that respects abort signal
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("Aborted"));
    });
  });
}

/**
 * Enqueue a file operation. Deduplicates by keeping only the latest operation per file.
 */
function enqueue(type: "add" | "remove", filePath: string): void {
  if (!state.workspacePath) return;

  // Backpressure: if queue is too large, log warning and skip
  if (state.queue.items.length >= MAX_QUEUE_SIZE) {
    logger.warn(
      { queueSize: state.queue.items.length, filePath },
      "Queue full, skipping file"
    );
    return;
  }

  // Remove any existing entry for this file (deduplication)
  const existingIndex = state.queue.items.findIndex(
    (item) => item.filePath === filePath
  );
  if (existingIndex !== -1) {
    state.queue.items.splice(existingIndex, 1);
  }

  // Add to end of queue (FIFO)
  state.queue.items.push({
    type,
    filePath,
    addedAt: Date.now(),
  });
  if (existingIndex === -1) {
    indexerStats.queueItemsEnqueued++;
  }

  // Start processing if not already running. Background discovery temporarily
  // batches queue additions so the mtime filter can run before embeddings start.
  if (!state.backgroundDiscoveryInProgress) {
    fireAndForget(startProcessing(), 'fileWatcherService.line617');
  }
}

/**
 * Process a single queue item
 */
async function processItem(
  item: QueueItem,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return;

  const fileBasename = path.basename(item.filePath);

  if (item.type === "remove") {
    try {
      // Removal Coordinator (Stage 4a): the LanceDB phase of the `watcher-unlink`
      // removal — its metadata-store phase already ran synchronously in
      // queueFileRemove. Skip read table refresh for individual removals — batch
      // refresh happens in the queue loop. Behavior-preserving wrapper over the
      // prior direct removeFileFromIndex(..., {skipReadRefresh:true}).
      await removeVectorIndexEntry(item.filePath, WATCHER_UNLINK_REASON, {
        skipReadRefresh: true,
      });
      logger.debug({ file: fileBasename }, "Removed from index");
    } catch (err) {
      indexerStats.queueItemsFailed++;
      logger.warn({ err, file: fileBasename }, "Failed to remove file from index");
    }
    return;
  }

  // Type is "add"
  try {
    const processStartMs = Date.now();
    const needs = await needsReindexing(item.filePath);
    if (!needs) {
      logger.debug({ file: fileBasename }, "Skipped (not modified)");
      return;
    }

    if (signal.aborted) return;

    if (!state.workspacePath) return;
    const chunksIndexed = await indexFile(item.filePath, state.workspacePath);
    const totalMs = Date.now() - processStartMs;
    if (chunksIndexed > 0) {
      state.filesIndexedThisSession++;
      logger.debug({ file: fileBasename, chunks: chunksIndexed, totalMs }, "Indexed");
    }
  } catch (err) {
    indexerStats.queueItemsFailed++;
    logger.warn({ err, file: fileBasename }, "Failed to index file");
  }
}

/**
 * Main queue processing loop with proper backpressure
 */
async function startProcessing(): Promise<void> {
  // Prevent concurrent processing loops
  if (state.queue.isProcessing || state.queue.isStartingProcessing) {
    return;
  }

  // Wait for initial scan to complete before processing
  if (!state.isInitialScanComplete) {
    return;
  }

  if (state.queue.items.length === 0) {
    return;
  }

  state.queue.isStartingProcessing = true;

  // Wait for embedding model to be ready before processing files
  // This prevents blocking the UI during model loading
  if (!isEmbeddingServiceReady()) {
    logger.info(
      { queueSize: state.queue.items.length },
      "Waiting for embedding model to load before processing files"
    );
    try {
      await waitForModelReady();
      logger.info("Embedding model ready, starting file processing");
    } catch (err) {
      // Embedding service unavailable - return early to preserve queue
      // Queue items stay intact for retry when embedding recovers
      logger.warn(
        { err, queueSize: state.queue.items.length },
        'Embedding service unavailable - deferring file indexing until recovery'
      );
      state.queue.isStartingProcessing = false;
      return; // Exit without processing - queue preserved
    }
    // Re-check after await to prevent race condition where multiple callers
    // wait on waitForModelReady() and all try to start processing
    if (state.queue.isProcessing) {
      state.queue.isStartingProcessing = false;
      return;
    }
  }

  state.queue.isProcessing = true;
  state.queue.isStartingProcessing = false;
  state.queue.abortController = new AbortController();
  const signal = state.queue.abortController.signal;
  const pauseOnBlur = process.env.REBEL_INDEXER_PAUSE_ON_BLUR === '1';
  // Stage 6 (260508): pause on active-turn state in addition to blur. Defaults
  // on; opt-out via REBEL_INDEXER_PAUSE_ON_ACTIVE_TURN=0.
  const pauseOnTurnActive = (process.env.REBEL_INDEXER_PAUSE_ON_ACTIVE_TURN ?? '1') === '1';
  // Clamp REBEL_INDEXER_MAX_PAUSE_MS to a positive integer; fall back to 30 min default
  // for missing, invalid, or non-positive values (setTimeout treats <=0 as immediate).
  const DEFAULT_MAX_PAUSE_MS = 30 * 60 * 1000;
  const rawMaxPauseMs = Number.parseInt(process.env.REBEL_INDEXER_MAX_PAUSE_MS ?? '', 10);
  const maxPauseMs = Number.isFinite(rawMaxPauseMs) && rawMaxPauseMs > 0
    ? rawMaxPauseMs
    : DEFAULT_MAX_PAUSE_MS;
  if ((pauseOnBlur || pauseOnTurnActive) && process.env.REBEL_INDEXER_MAX_PAUSE_MS && maxPauseMs === DEFAULT_MAX_PAUSE_MS) {
    logger.warn(
      { raw: process.env.REBEL_INDEXER_MAX_PAUSE_MS },
      'Invalid REBEL_INDEXER_MAX_PAUSE_MS; falling back to default 30 min'
    );
  }
  const blurDebounceMs = 15_000;
  let blurPauseEngagedAt: number | null = null;
  let pendingEngageTimer: ReturnType<typeof setTimeout> | null = null;
  let cleanupBlurPause: (() => void) | null = null;

  // Stage 6 background-consumer latch (active-turn pause + degraded-mode latch).
  let turnActiveLatch: BackgroundConsumerLatch | null = null;
  if (pauseOnTurnActive) {
    turnActiveLatch = createBackgroundConsumerLatch('fileWatcherService', {
      watchdogTimeoutMs: maxPauseMs,
    });
  }

  if (pauseOnBlur) {
    const clearPendingEngageTimer = () => {
      if (pendingEngageTimer !== null) {
        clearTimeout(pendingEngageTimer);
        pendingEngageTimer = null;
      }
    };

    const schedulePauseEngagement = () => {
      if (pendingEngageTimer !== null) return;
      pendingEngageTimer = setTimeout(() => {
        pendingEngageTimer = null;
        if (isAppCurrentlyBlurred()) {
          blurPauseEngagedAt = Date.now();
          indexerStats.blurPauseCount++;
          logger.info(
            { queueSize: state.queue.items.length, maxPauseMs, reason: 'blur' },
            'Indexer paused on blur'
          );
        }
      }, blurDebounceMs);
    };

    const unsubBlur = onBlurStateChange((isBlurred) => {
      if (isBlurred) {
        schedulePauseEngagement();
      } else {
        clearPendingEngageTimer();
        blurPauseEngagedAt = null;
      }
    });

    const handleAbort = () => {
      clearPendingEngageTimer();
      unsubBlur();
    };

    signal.addEventListener('abort', handleAbort, { once: true });
    cleanupBlurPause = () => {
      clearPendingEngageTimer();
      unsubBlur();
      signal.removeEventListener('abort', handleAbort);
    };

    if (isAppCurrentlyBlurred()) {
      schedulePauseEngagement();
    }
  }

  logger.info(
    { queueSize: state.queue.items.length },
    "Starting queue processing"
  );

  try {
    while (state.queue.items.length > 0 && !signal.aborted) {
      // Stage 6: gate on active-turn signal (skips when in degraded mode or
      // armed-after-clear, per the per-consumer state-machine latch). Checked
      // before blur — turn-active is the more aggressive signal.
      if (pauseOnTurnActive && turnActiveLatch?.shouldDeferForTurnActive()) {
        const pauseStartedAt = turnActiveLatch.getPausedSinceMs() ?? Date.now();
        const queueSizeAtPause = state.queue.items.length;
        indexerStats.turnActivePauseCount++;
        logger.info(
          { queueSize: queueSizeAtPause, maxPauseMs, reason: 'active_turn' },
          'Indexer paused on active turn'
        );
        const result = await turnActiveLatch.waitUntilResumeOrDegraded(signal);
        const durationMs = Date.now() - pauseStartedAt;
        const queueSize = state.queue.items.length;
        indexerStats.turnActivePauseTotalMs += durationMs;

        if (result.outcome === 'resumed') {
          logger.info({ durationMs, queueSize }, 'Indexer resumed on turn idle');
        } else if (result.outcome === 'degraded') {
          const degradedReason = result.reason;
          const degradedMessage = degradedReason === 'leaked_active_turn_signal'
            ? 'Indexer entered degraded mode due leaked active-turn signal; resuming indexing'
            : 'Indexer entered degraded mode due stuck active-turn signal; resuming indexing';
          indexerStats.degradedModeEntryCount++;
          indexerStats.maxPauseTimeoutsFired++;
          logger.warn(
            {
              queueSize,
              durationMs,
              reason: degradedReason,
            },
            degradedMessage,
          );
        } else {
          logger.debug({ queueSize, durationMs }, 'Indexer turn-active pause aborted (shutdown)');
        }

        continue;
      }

      if (pauseOnBlur && blurPauseEngagedAt !== null && isAppCurrentlyBlurred()) {
        // Capture engagement timestamp BEFORE awaiting; the focus listener nulls
        // `blurPauseEngagedAt` before this promise resolves, so we need a local copy.
        // This gives a faithful "engage to resume" duration rather than an always-0 window.
        const pauseStartedAt = blurPauseEngagedAt;
        const result = await waitForFocus(signal, maxPauseMs);
        const durationMs = Date.now() - pauseStartedAt;
        const queueSize = state.queue.items.length;
        indexerStats.blurPauseTotalMs += durationMs;

        if (result === 'focused') {
          logger.info({ durationMs, queueSize }, 'Indexer resumed on focus');
        } else if (result === 'timeout') {
          blurPauseEngagedAt = null;
          indexerStats.maxPauseTimeoutsFired++;
          logger.warn(
            { queueSize, durationMs },
            'Indexer max-pause exceeded; resuming under degraded mode'
          );
        } else {
          logger.debug({ queueSize, durationMs }, 'Indexer pause aborted (shutdown)');
        }

        continue;
      }

      // Take the first item (FIFO)
      const item = state.queue.items.shift();
      if (!item) break;

      await processItem(item, signal);
      state.queue.processedCount++;

      // Report progress periodically
      if (state.queue.processedCount % 10 === 0) {
        if (state.onProgressCallback) {
          state.onProgressCallback(getWatcherStatus());
        }
        logger.info(
          {
            processed: state.queue.processedCount,
            remaining: state.queue.items.length,
            indexed: state.filesIndexedThisSession,
          },
          "Indexing progress"
        );
      }

      // Yield to event loop between files
      if (!signal.aborted) {
        await delay(INTER_FILE_DELAY_MS, signal).catch(() => {});
      }

      // Longer pause periodically for GC
      if (state.queue.processedCount % GC_INTERVAL === 0 && !signal.aborted) {
        logger.debug({ processed: state.queue.processedCount }, "GC pause");
        await delay(GC_PAUSE_MS, signal).catch(() => {});
      }
    }

    logger.info(
      {
        totalProcessed: state.queue.processedCount,
        indexed: state.filesIndexedThisSession,
        remaining: state.queue.items.length,
      },
      "Queue processing complete"
    );

    // Refresh read table once after batch processing completes
    // This ensures searches see all updates without refreshing after every single file
    await refreshReadTable();

    await finalizeInitialScanIfIdle();
  } catch (error) {
    if ((error as Error).message !== "Aborted") {
      logger.error({ err: error }, "Error in queue processing");
    }
  } finally {
    cleanupBlurPause?.();
    turnActiveLatch?.dispose();
    turnActiveLatch = null;
    state.queue.isProcessing = false;
    state.queue.abortController = null;

    // Final progress update
    if (state.onProgressCallback) {
      state.onProgressCallback(getWatcherStatus());
    }
  }
}

/**
 * Stop queue processing
 */
function stopProcessing(): void {
  if (state.queue.abortController) {
    state.queue.abortController.abort();
    state.queue.abortController = null;
  }
  state.queue.isStartingProcessing = false;
  state.queue.isProcessing = false;
}

/**
 * Batch filter queue by checking mtimes in parallel.
 * This dramatically speeds up restart when most files haven't changed:
 * - Sequential: 13k files × ~50ms = ~11 minutes
 * - Parallel (100 at a time): 13k files / 100 batches × ~50ms = ~6.5 seconds
 */
async function batchFilterQueue(signal?: AbortSignal): Promise<void> {
  // Extract items to check (new arrivals during check will accumulate in empty queue)
  const itemsToCheck = [...state.queue.items];
  state.queue.items = [];

  if (itemsToCheck.length === 0) return;

  const startTime = Date.now();
  const BATCH_SIZE = 100; // 100 concurrent stat calls is safe and fast
  const filteredItems: QueueItem[] = [];
  let skippedCount = 0;
  let checkedCount = 0;

  logger.info({ totalFiles: itemsToCheck.length }, 'Starting batch mtime check');

  for (let i = 0; i < itemsToCheck.length; i += BATCH_SIZE) {
    // Check for abort (e.g., user switched workspace)
    if (signal?.aborted) {
      const remainingItems = itemsToCheck.slice(i);
      state.queue.items = [...filteredItems, ...remainingItems, ...state.queue.items];
      logger.info({ checked: checkedCount, remaining: remainingItems.length }, 'Batch mtime check aborted');
      return;
    }

    const batch = itemsToCheck.slice(i, i + BATCH_SIZE);

    // Check all files in batch concurrently
    const results = await Promise.all(
      batch.map(async (item) => {
        // Remove items always need processing
        if (item.type === 'remove') return { item, keep: true };
        try {
          const needs = await needsReindexing(item.filePath);
          return { item, keep: needs };
        } catch {
          // If stat fails, keep in queue (will fail gracefully in processItem)
          return { item, keep: true };
        }
      })
    );

    for (const { item, keep } of results) {
      if (keep) {
        filteredItems.push(item);
      } else {
        skippedCount++;
      }
    }

    checkedCount += batch.length;

    // Log progress every 1000 files
    if (checkedCount % 1000 === 0) {
      logger.info({
        checked: checkedCount,
        total: itemsToCheck.length,
        needsIndexing: filteredItems.length,
        skipped: skippedCount
      }, 'Batch mtime check progress');
    }
  }

  // Combine: filtered items + any new arrivals during check
  // Deduplicate: if same path in both, new arrival wins (it's more recent)
  const newArrivals = state.queue.items;
  const newArrivalPaths = new Set(newArrivals.map(item => item.filePath));
  const deduplicatedFiltered = filteredItems.filter(
    item => !newArrivalPaths.has(item.filePath)
  );
  state.queue.items = [...deduplicatedFiltered, ...newArrivals];

  const elapsed = Date.now() - startTime;
  logger.info({
    checked: itemsToCheck.length,
    needsIndexing: filteredItems.length,
    skipped: skippedCount,
    newArrivals: newArrivals.length,
    finalQueueSize: state.queue.items.length,
    elapsedMs: elapsed
  }, 'Batch mtime check complete');
}

async function finalizeInitialScanIfIdle(): Promise<void> {
  // Run post-scan finalization only once after an initial or background discovery
  // scan completes. Watcher-driven batches skip this to avoid re-running
  // markScanComplete + refreshEnhancementCounts on every file change.
  if (
    !state.isInitialScanComplete ||
    state.queue.items.length > 0 ||
    state.hasRunPostScanFinalization ||
    state.backgroundDiscoveryTimeout ||
    state.backgroundDiscoveryInProgress
  ) {
    return;
  }

  await markScanComplete(state.totalFilesDiscovered);

  // Refresh counts before starting enhancement so UI shows accurate numbers.
  await refreshEnhancementCounts();

  // Start background enhancement now that indexing is complete.
  // Skip auto-enhancement if:
  // - Large workspace (>1000 files) and user hasn't explicitly requested it
  // - User has explicitly paused enhancement (enhancementUserRequested === false)
  const settings = getSettings();
  const userExplicitlyPaused = settings.enhancementUserRequested === false;
  const userExplicitlyRequested = settings.enhancementUserRequested === true;
  const isLargeWorkspace = state.totalFilesDiscovered > AUTO_ENHANCE_FILE_THRESHOLD;

  if (userExplicitlyPaused) {
    logger.info('Auto-enhancement skipped (user previously paused)');
  } else if (isLargeWorkspace && !userExplicitlyRequested) {
    logger.info(
      { files: state.totalFilesDiscovered, threshold: AUTO_ENHANCE_FILE_THRESHOLD },
      'Auto-enhancement skipped (workspace exceeds file threshold) - manual trigger available'
    );
  } else {
    fireAndForget(startEnhancement(), 'fileWatcherService.line1074');
  }

  // Mark finalization as done only after all awaited work succeeds.
  // If markScanComplete or refreshEnhancementCounts throws, the flag
  // stays false so the next empty-queue batch retries finalization.
  state.hasRunPostScanFinalization = true;
}

/**
 * Rebuild source metadata from filesystem.
 * Used when skip-rescan is true but metadata store is empty.
 * Fast because we only parse frontmatter, no embeddings.
 */
async function rebuildSourceMetadata(workspacePath: string): Promise<void> {
  const sourcesDir = path.join(workspacePath, 'memory', 'sources');
  
  try {
    // Check if sources directory exists (bounded — a dead cloud mount throws
    // `reconnecting` here and we skip the rebuild rather than block boot). CONTAINMENT
    // default (no forceCloud): a fast-local Dropbox workspace stays on the bare-fs local
    // lane; only a CONFIGURED cloud space takes the bounded cloud lane.
    unwrapWatcherRead(await workspaceFs.access(sourcesDir));
  } catch {
    logger.debug({ sourcesDir }, 'No sources directory found (or unavailable), skipping metadata rebuild');
    return;
  }

  const startTime = Date.now();
  let indexedCount = 0;

  // Walk memory/sources/**/*.md via safeWalkDirectory so we get cycle/depth
  // protection out of the box. Pre-fix this walker had no guards; a user
  // with a self-nested workspace would hit ENAMETOOLONG (REBEL-506).
  await safeWalkDirectory(sourcesDir, {
    onFile: async ({ absolutePath, name }) => {
      if (!name.endsWith('.md')) return;
      try {
        // CONTAINMENT default (no forceCloud): configured cloud spaces take the bounded
        // cloud lane; a fast-local workspace stays bare-fs (no per-file executor overhead).
        const stat = unwrapWatcherRead(await workspaceFs.stat(absolutePath));
        const content = unwrapWatcherRead(await workspaceFs.readFile(absolutePath, 'utf-8'));
        const relativePath = relativePortablePath(workspacePath, absolutePath);

        sourceMetadataStore.indexSource(absolutePath, relativePath, content, Math.floor(stat.mtimeMs));
        indexedCount++;
      } catch (err) {
        logger.warn({ err, path: absolutePath }, 'Failed to index source for metadata');
      }
    },
    onTruncated: ({ reasons, entriesVisited }) => {
      logger.debug(
        { sourcesDir, reasons, entriesVisited },
        'rebuildSourceMetadata hit a traversal cap — metadata rebuild may be incomplete',
      );
    },
  });

  const elapsed = Date.now() - startTime;
  logger.info({ indexedCount, elapsedMs: elapsed }, 'Rebuilt source metadata from filesystem');
}

/**
 * Rebuild entity metadata from indexed markdown files.
 * Used when skip-rescan is true but entity metadata store is empty.
 */
async function rebuildEntityMetadata(workspacePath: string): Promise<void> {
  const indexedPaths = getIndexedPaths();

  if (indexedPaths.length === 0) {
    logger.debug('No indexed paths available, skipping entity metadata rebuild');
    return;
  }

  const startTime = Date.now();
  let indexedCount = 0;

  for (const indexedPath of indexedPaths) {
    if (!indexedPath.endsWith('.md')) {
      continue;
    }

    try {
      // `getIndexedPaths()` can return canonical CLOUD paths (a previously-indexed
      // configured cloud space) — route through the boundary (CONTAINMENT default) so a
      // dead mount degrades this entry instead of blocking the rebuild (was an unbounded
      // gap pre-S4.1c). No forceCloud: a fast-local indexed path stays bare-fs.
      const stat = unwrapWatcherRead(await workspaceFs.stat(indexedPath));
      if (!stat.isFile) {
        continue;
      }

      const content = unwrapWatcherRead(await workspaceFs.readFile(indexedPath, 'utf-8'));
      if (!entityMetadataStore.isEntityFile(content)) {
        continue;
      }

      const relativePath = toPortablePath(tryConvertToWorkspacePath(indexedPath, workspacePath, getWorkspaceSymlinkMap())
        ?? path.relative(workspacePath, indexedPath));
      entityMetadataStore.indexEntity(indexedPath, relativePath, content, Math.floor(stat.mtimeMs));
      indexedCount++;
    } catch (err) {
      logger.warn({ err, path: indexedPath }, 'Failed to index entity for metadata');
    }
  }

  const elapsed = Date.now() - startTime;
  logger.info({ indexedCount, elapsedMs: elapsed }, 'Rebuilt entity metadata from indexed paths');
}

/**
 * Remove stale entries from the index (files deleted/moved while app was closed).
 * Also detects and fixes case-mismatch entries (e.g., Personal vs personal on macOS).
 * Runs on startup when skipRescan is true to detect orphaned index entries.
 * Uses batch parallel fs.realpath() checks for performance.
 */
async function cleanupStaleEntries(): Promise<void> {
  const indexedPaths = getIndexedPaths();
  
  if (indexedPaths.length === 0) {
    logger.debug('No indexed paths to check for stale entries');
    return;
  }

  const startTime = Date.now();
  const BATCH_SIZE = 100; // Parallel fs.realpath() calls per batch
  let checkedCount = 0;
  
  // Track canonical paths we've seen - maps canonical -> indexed path
  // Used to detect if we already have a correct entry for this file
  const canonicalToIndexed = new Map<string, string>();
  
  // Collect all paths to delete (batch them for one LanceDB operation)
  const pathsToDelete: string[] = [];
  
  // Files that need reindexing (case mismatch with no correct entry)
  const filesToReindex: string[] = [];

  logger.info({ totalPaths: indexedPaths.length }, 'Checking for stale index entries (deleted files and case mismatches)');

  // Phase 1: Check all files and collect paths to delete
  for (let i = 0; i < indexedPaths.length; i += BATCH_SIZE) {
    const batch = indexedPaths.slice(i, i + BATCH_SIZE);

    // Check all paths in batch concurrently using fs.realpath
    // This resolves symlinks AND returns the true case on case-insensitive filesystems
    const results = await Promise.all(
      batch.map(async (filePath) => {
        // Stage 4c (Opus-F4): NEVER bare-`fs.realpath` a CLOUD-space path here — on
        // a dead mount that blocks the main thread (the residual hang vector). The
        // containment classifier is sync, cached, readlink-only (no mount fs-op).
        // A cloud path is RETAINED whole (skip the realpath; not marked for
        // deletion, no case-mismatch dedup) — consistent with R1 "keep last-known
        // index"; the healthy-walk producer (Stage 6/7) reconciles genuine cloud
        // absences. (Case-mismatch dedup is a local-FS concern.)
        if (classifyPathForRemoval(filePath) !== 'local') {
          return { filePath, canonicalPath: null, exists: true, error: null, cloudRetained: true };
        }
        try {
          // The classifyPathForRemoval guard above guarantees `filePath` is LOCAL
          // (containment) here, so this is the boundary's bare-fs local lane (never
          // `reconnecting`); routed through the boundary only so the file stays free of
          // raw fs (gate). CONTAINMENT default — no forceCloud (would wrongly route a
          // fast-local Dropbox path, which the guard already admitted as local).
          const canonicalPath = unwrapWatcherRead(await workspaceFs.realpath(filePath));
          return { filePath, canonicalPath, exists: true, error: null, cloudRetained: false };
        } catch (err) {
          // Check error code - only treat ENOENT/ENOTDIR as "deleted"
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT' || code === 'ENOTDIR') {
            return { filePath, canonicalPath: null, exists: false, error: null, cloudRetained: false };
          }
          // Other errors (permission, network) - skip this file, don't remove
          return { filePath, canonicalPath: null, exists: true, error: code, cloudRetained: false };
        }
      })
    );

    // Collect paths to delete (don't delete yet - batch at the end)
    for (const { filePath, canonicalPath, exists, error, cloudRetained } of results) {
      if (cloudRetained) {
        // Cloud-space path: retained whole, never realpath'd. Skip all stale/case
        // handling for it (keep last-known index).
        continue;
      }
      if (error) {
        // Skip files with transient errors (permission, network, etc.)
        logger.debug({ filePath, error }, 'Skipping file with transient error');
        continue;
      }

      if (!exists) {
        // File doesn't exist - mark for deletion
        pathsToDelete.push(filePath);
        // Removal Coordinator (Stage 4a): metadata-store phase of this `absence`
        // removal (source + entity). The LanceDB phase is the single batch delete
        // at the end. Source removal still guarded by isSourcePath internally, so
        // the same entries are removed as the prior inline calls.
        removeMetadataStoresEntry(filePath, ABSENCE_REASON, {
          workspacePath: state.workspacePath,
          stores: METADATA_SOURCE_AND_ENTITY,
        });
        state.totalFilesDiscovered = Math.max(0, state.totalFilesDiscovered - 1);
      } else if (canonicalPath) {
        // File exists - check for case mismatch
        const existingIndexed = canonicalToIndexed.get(canonicalPath);
        
        if (filePath === canonicalPath) {
          // Path matches canonical - this is a correct entry
          canonicalToIndexed.set(canonicalPath, filePath);
          
          // If we previously saw a wrong-cased entry for this file, we can ignore it
          // (it will be removed when we process it, or already was)
        } else if (existingIndexed === canonicalPath) {
          // We already have the correct canonical entry - remove this wrong-cased duplicate
          pathsToDelete.push(filePath);
          // Removal Coordinator (Stage 4a): metadata phase (source-if-applicable +
          // entity); LanceDB phase is the batch delete at the end.
          removeMetadataStoresEntry(filePath, ABSENCE_REASON, {
            workspacePath: state.workspacePath,
            stores: METADATA_SOURCE_AND_ENTITY,
          });
          logger.debug({ indexed: filePath, canonical: canonicalPath }, 'Case-mismatched duplicate marked for deletion');
        } else if (!existingIndexed) {
          // First time seeing this canonical path, but indexed path has wrong case
          // Mark for removal and queue for reindexing at canonical path
          canonicalToIndexed.set(canonicalPath, filePath); // Track we've seen it
          pathsToDelete.push(filePath);
          // Removal Coordinator (Stage 4a): metadata phase (source-if-applicable +
          // entity); LanceDB phase is the batch delete at the end.
          removeMetadataStoresEntry(filePath, ABSENCE_REASON, {
            workspacePath: state.workspacePath,
            stores: METADATA_SOURCE_AND_ENTITY,
          });
          filesToReindex.push(canonicalPath);
          logger.debug({ indexed: filePath, canonical: canonicalPath }, 'Case-mismatched entry marked for deletion and reindex');
        } else {
          // existingIndexed is set but != canonicalPath (shouldn't happen, but defensive)
          // This is a duplicate - mark for removal
          pathsToDelete.push(filePath);
          // Removal Coordinator (Stage 4a): ENTITY-ONLY here (source untouched),
          // preserving this branch's original selectivity exactly.
          removeMetadataStoresEntry(filePath, ABSENCE_REASON, {
            workspacePath: state.workspacePath,
            stores: METADATA_ENTITY_ONLY,
          });
        }
      }
    }

    checkedCount += batch.length;

    // Log progress every 1000 files
    if (checkedCount % 1000 === 0) {
      logger.info({
        checked: checkedCount,
        total: indexedPaths.length,
        toDelete: pathsToDelete.length
      }, 'Stale entry cleanup progress');
    }
  }

  // Phase 2: Batch delete all stale entries in one operation
  // This is MUCH faster than individual deletes (~700ms each on Windows)
  let actuallyRemoved = 0;
  if (pathsToDelete.length > 0) {
    logger.info({ pathCount: pathsToDelete.length }, 'Batch deleting stale entries from index');
    // Removal Coordinator (Stage 4a): LanceDB phase of the `absence` removals.
    // The metadata phases already ran inline per-path above (preserving each
    // branch's per-store selectivity). Vector-index ONLY here.
    actuallyRemoved = await removeVectorIndexEntries(pathsToDelete, ABSENCE_REASON, {
      skipReadRefresh: false,  // Refresh once after batch
      skipOptimize: true       // Don't trigger optimize during cleanup
    });
  }

  // Reindex files that had case mismatches (queue them for the file watcher)
  // This ensures the file gets re-added with the correct canonical path
  if (filesToReindex.length > 0) {
    logger.info({ count: filesToReindex.length }, 'Queueing case-mismatched files for reindex');
    for (const canonicalPath of filesToReindex) {
      queueFileAdd(canonicalPath);
    }
  }

  const elapsed = Date.now() - startTime;
  
  if (actuallyRemoved > 0 || filesToReindex.length > 0) {
    logger.info({
      checked: indexedPaths.length,
      removed: actuallyRemoved,
      reindexQueued: filesToReindex.length,
      elapsedMs: elapsed
    }, 'Stale entry cleanup complete');
  } else {
    logger.debug({
      checked: indexedPaths.length,
      elapsedMs: elapsed
    }, 'Stale entry cleanup complete - no stale entries found');
  }
}

/**
 * Test-only seam for Stage 4c (Opus-F4): run `cleanupStaleEntries` directly with a
 * given workspace path, so a test can assert it does NOT `fs.realpath` a cloud-space
 * path and retains it. Internal otherwise (only `startWatching` calls it).
 *
 * @public Consumed ONLY via a runtime `await import('../fileWatcherService')` in
 * fileWatcherService.test.ts (the suite MUST load this module dynamically so the
 * boundedWorkspaceFs executor it wires targets the SAME module instance — see the
 * test file header, lines 3-8). Knip's static analysis cannot trace dynamic-import
 * member access, so the DEFAULT leg false-positives this `ForTests` seam as unused
 * even though the test exercises it. `@internal` would only silence the production
 * leg (which already exempts the `ForTests` name); `@public` is the only tag knip
 * honours in BOTH legs. NOT production API — a knip dynamic-import-tracing
 * limitation, not dead code. Sibling `__resetCloudSpaceContainmentForTests` has the
 * identical shape but evades the diff-guard only because its file is unchanged.
 */
export async function __cleanupStaleEntriesForTests(workspacePath: string): Promise<void> {
  state.workspacePath = workspacePath;
  await cleanupStaleEntries();
}

// S4.2 (260619_cloud-symlink-indexing): the Stage-6b ABSENCE-PROOF PRODUCER
// (reconcileHealthyCloudSpaces + resolveHealthyCloudSpaceTargets + the
// __reconcileHealthyCloudSpacesForTests seam + the hashForLog/normalizeRelKey/
// HealthyCloudSpaceWalkTarget helpers) is RETIRED. v1 does NOT auto-purge absent
// cloud entries (PLAN safety invariant 3: retain last-known index). The
// coordinator's `absence-authorized` removal + AbsenceProof/tryBuildAbsenceProof
// remain RETAINED-DEAD (R-D2) for a future opt-in reconcile.

async function purgeRebelEntriesFromIndex(): Promise<void> {
  const rebelPaths = getIndexedPaths().filter((indexedPath) => toPortablePath(indexedPath).includes('/.rebel/'));

  if (rebelPaths.length === 0) {
    return;
  }

  // Removal Coordinator (Stage 4a): typed `hygiene` removal — LanceDB-ONLY (no
  // metadata-store side, matching today). Hygiene matches on already-stored entry
  // paths (no mount fs-op) so Stage 4b allows it even when degraded.
  await removeVectorIndexEntries(rebelPaths, HYGIENE_REASON, {
    skipReadRefresh: false,
    skipOptimize: true,
  });

  logger.info({ count: rebelPaths.length }, 'Purged .rebel/ entries from semantic index');
}

/**
 * Remove already-indexed Rebel cloud-sync conflict files from the semantic index.
 * Conflict files (`.conflict-cloud`) are duplicates created by cloud workspace sync
 * that inflate the index with redundant content. Run at startup alongside
 * purgeRebelEntriesFromIndex to clean up historical conflict chunks.
 *
 * Modeled on purgeRebelEntriesFromIndex above.
 */
async function purgeConflictEntriesFromIndex(): Promise<void> {
  const conflictPaths = getIndexedPaths().filter((indexedPath) =>
    path.basename(indexedPath).includes(WORKSPACE_CONFLICT_MARKER),
  );

  if (conflictPaths.length === 0) {
    return;
  }

  // Removal Coordinator (Stage 4a): typed `hygiene` removal — LanceDB-ONLY.
  await removeVectorIndexEntries(conflictPaths, HYGIENE_REASON, {
    skipReadRefresh: false,
    skipOptimize: true,
  });

  logger.info({ count: conflictPaths.length }, 'Purged .conflict-cloud entries from semantic index');
}

/**
 * Queue a file for indexing
 */
function queueFileAdd(filePath: string): void {
  enqueue("add", filePath);
}

/**
 * Queue a file for removal
 */
function queueFileRemove(filePath: string): void {
  // Removal Coordinator (Stage 4a): the metadata stores (source + entity) are
  // removed SYNCHRONOUSLY now (fast, as before), and the LanceDB removal happens
  // LATER when the enqueued "remove" item is dequeued in processItem — both phases
  // route through the SAME coordinator with reason `watcher-unlink`, so the async
  // queue (batching/dedup/backpressure) is preserved while the coordinator is the
  // one door for cloud removals. Behavior-preserving: identical entries removed,
  // identical timing. Stage 4b will gate this reason on the cloud-liveness verdict.
  removeMetadataStoresEntry(filePath, WATCHER_UNLINK_REASON, {
    workspacePath: state.workspacePath,
    alsoRemoveSourcePortableRelative: true,
  });

  enqueue("remove", filePath);
}

function cancelBackgroundDiscovery(): void {
  if (state.backgroundDiscoveryTimeout) {
    clearTimeout(state.backgroundDiscoveryTimeout);
    state.backgroundDiscoveryTimeout = null;
  }
  if (state.backgroundDiscoveryAbortController) {
    state.backgroundDiscoveryAbortController.abort();
    state.backgroundDiscoveryAbortController = null;
  }
  state.backgroundDiscoveryInProgress = false;
}

function scheduleBackgroundDiscovery(workspacePath: string): void {
  cancelBackgroundDiscovery();

  const abortController = new AbortController();
  state.backgroundDiscoveryAbortController = abortController;
  state.backgroundDiscoveryTimeout = setTimeout(() => {
    state.backgroundDiscoveryTimeout = null;
    fireAndForget(runBackgroundDiscovery(workspacePath, abortController), 'fileWatcherService.line1415');
  }, BACKGROUND_DISCOVERY_DELAY_MS);

  logger.info(
    { workspacePath, delayMs: BACKGROUND_DISCOVERY_DELAY_MS },
    'Scheduled background file discovery'
  );
}

function queueBackgroundDiscoveredFile(filePath: string, pendingRemovePaths: ReadonlySet<string>): void {
  if (pendingRemovePaths.has(filePath)) {
    return;
  }

  queueFileAdd(filePath);
}

async function runBackgroundDiscovery(
  workspacePath: string,
  abortController: AbortController,
): Promise<void> {
  if (state.workspacePath !== workspacePath || abortController.signal.aborted) {
    return;
  }

  state.backgroundDiscoveryInProgress = true;
  const queueSizeBefore = state.queue.items.length;
  const discoveredBefore = state.totalFilesDiscovered;
  const discoveredPaths: string[] = [];

  try {
    logger.info({ workspacePath }, 'Starting background file discovery');
    const discoveredCount = await discoverFiles(workspacePath, (filePath) => {
      discoveredPaths.push(filePath);
    }, abortController.signal);

    if (abortController.signal.aborted || state.workspacePath !== workspacePath) {
      return;
    }

    await waitForActiveProcessingToFinish(abortController.signal);

    if (abortController.signal.aborted || state.workspacePath !== workspacePath) {
      return;
    }

    const pendingRemovePaths = new Set(
      state.queue.items
        .filter((item) => item.type === 'remove')
        .map((item) => item.filePath)
    );
    for (const filePath of discoveredPaths) {
      queueBackgroundDiscoveredFile(filePath, pendingRemovePaths);
    }

    await batchFilterQueue(abortController.signal);
    state.totalFilesDiscovered = discoveredCount;

    logger.info(
      {
        discoveredCount,
        queuedForIndexing: state.queue.items.length,
        queueSizeBefore,
        totalFilesBefore: discoveredBefore,
        totalFilesAfter: state.totalFilesDiscovered,
      },
      'Background file discovery complete'
    );
    // S4.2 (260619_cloud-symlink-indexing): the post-discovery absence-purge producer
    // (reconcileHealthyCloudSpaces) is RETIRED — v1 does NOT auto-purge absent cloud
    // entries (PLAN safety invariant 3: retain last-known index; the coordinator's
    // `absence-authorized` path is kept retained-dead for a future opt-in).
  } catch (error) {
    if (!abortController.signal.aborted) {
      logger.warn({ err: error, workspacePath }, 'Background file discovery failed');
    }
  } finally {
    // Only the CURRENT owner (its controller still installed) may clear the shared
    // in-progress + controller bookkeeping. `discoverWorkspaceNow()` can abort an
    // active background discovery and immediately start a replacement; without this
    // ownership scope, the aborted OLD run's `finally` would clobber the replacement
    // run's `backgroundDiscoveryInProgress = true`, letting `finalizeInitialScanIfIdle`
    // / queue processing fire mid-discovery (so unchanged files may not mtime-skip and
    // a large workspace churns). The replacement run clears it when IT finishes.
    if (state.backgroundDiscoveryAbortController === abortController) {
      state.backgroundDiscoveryAbortController = null;
      state.backgroundDiscoveryInProgress = false;
    }

    if (!abortController.signal.aborted && state.workspacePath === workspacePath) {
      if (state.queue.items.length > 0) {
        fireAndForget(startProcessing(), 'fileWatcherService.line1495');
      } else {
        await finalizeInitialScanIfIdle();
      }
    }
  }
}

async function waitForActiveProcessingToFinish(signal: AbortSignal): Promise<void> {
  while ((state.queue.isStartingProcessing || state.queue.isProcessing) && !signal.aborted) {
    await delay(50, signal).catch(() => {});
  }
}

/**
 * Force a non-clearing discovery re-walk of the CURRENT workspace NOW, bypassing
 * the startup `skipForegroundRescan` heuristic.
 *
 * `reindexWorkspace(false)` is NOT a guaranteed re-walk: it routes through
 * `startWatching`, which SKIPS foreground discovery whenever a usable index already
 * exists, and only schedules a *background* pass when the last completed scan is
 * stale (>`SKIP_RESCAN_THRESHOLD_MS`). So a recovery/periodic re-walk via that path
 * would commonly do no discovery at all. This entry point ALWAYS re-walks: it drives
 * `runBackgroundDiscovery` directly — a full `discoverFiles` → `safeWalkDirectory`
 * traversal (boundary-routed, so a dead cloud mount degrades via `cloud-timeout`
 * truncation rather than blocking) where unchanged files mtime-skip at queue-filter
 * time and the index is NEVER cleared (retain last-known on a degraded mount).
 *
 * It does NOT restart the chokidar watcher (no `restartCurrent`) — purely a
 * discovery pass. Used by the cloud periodic re-walk scheduler
 * (260619_cloud-symlink-indexing S4.3) to re-join a recovered cloud mount's content
 * within one interval without touching live-watch admission (that retraction is
 * S4.2/DROP-3's concern). Cancels any in-flight/pending background discovery first
 * (single owner of the background-discovery abort controller). No-op when no
 * workspace is being watched.
 */
export async function discoverWorkspaceNow(): Promise<void> {
  const workspacePath = state.workspacePath;
  if (!workspacePath) {
    return;
  }
  cancelBackgroundDiscovery();
  const abortController = new AbortController();
  state.backgroundDiscoveryAbortController = abortController;
  await runBackgroundDiscovery(workspacePath, abortController);
}

/**
 * Start watching a workspace for file changes
 */
export async function startWatching(
  workspacePath: string,
  onProgress?: (status: IndexStatus) => void,
): Promise<void> {
  await stopWatching();

  // Two-phase indexing: basic indexing happens first (fast)
  // Enhancement service will add contextual embeddings in the background later
  logger.info({ workspacePath }, "Starting file watcher");

  // Capture memory before starting watcher (for performance telemetry)
  const _memoryBeforeWatcher = process.memoryUsage();

  // Analyze symlinks for telemetry (helps understand followSymlinks: true impact)
  const symlinkTelemetry = await analyzeWorkspaceSymlinks(workspacePath);
  if (symlinkTelemetry.symlinkCount > 0 || symlinkTelemetry.cloudStorageProvider) {
    logger.info(
      {
        workspacePath,
        symlinkCount: symlinkTelemetry.symlinkCount,
        // Stage 5: non-zero analysisTimeMs with this true means we declined to
        // enumerate symlinks because the root is a cloud mount (hang-proofing).
        rootIsCloudSkipped: symlinkTelemetry.rootIsCloudSkipped,
        symlinksOutsideWorkspace: symlinkTelemetry.symlinks.filter(s => s.isOutsideWorkspace).length,
        // Count symlinks whose RESOLVED TARGET is a cloud mount — these are now
        // excluded from scan/watch (RC-1). Non-zero is the diagnostic signal for
        // the "scanning forever" class.
        cloudSymlinkTargets: symlinkTelemetry.symlinks.filter(s => s.cloudProvider !== null).length,
        cloudStorageProvider: symlinkTelemetry.cloudStorageProvider,
        analysisTimeMs: symlinkTelemetry.analysisTimeMs,
        // Log symlink targets for debugging (limited to first 10). The resolved
        // target is PII-bearing — a Google Drive target is
        // `~/Library/CloudStorage/GoogleDrive-<email>/…` and this log lands in
        // shared diagnostics bundles — so redact the email + normalize the home
        // dir at source. provider + (redacted) path is enough to debug; the raw
        // email never hits the log.
        symlinkTargets: symlinkTelemetry.symlinks.slice(0, 10).map(s => ({
          name: s.name,
          target: redactSensitiveData(s.target),
          outsideWorkspace: s.isOutsideWorkspace,
          cloudProvider: s.cloudProvider,
        })),
      },
      symlinkTelemetry.symlinkCount > 0
        ? "Workspace contains symlinks - followSymlinks:true will traverse these"
        : "Workspace is in cloud storage"
    );
  }

  state.workspacePath = workspacePath;
  state.onProgressCallback = onProgress ?? null;
  state.totalFilesDiscovered = 0;
  state.filesIndexedThisSession = 0;
  state.isInitialScanComplete = false;
  state.hasRunPostScanFinalization = false;
  state.queue.processedCount = 0;
  resetIndexerStats();

  // Clear Atlas cache when workspace changes
  notifyAtlasWorkspaceChanged?.(workspacePath);

  await initializeIndex(workspacePath);

  // Initialize source metadata store for this workspace
  // Clears entries if workspace changed or version mismatch
  sourceMetadataStore.initForWorkspace(workspacePath);
  await sourceMetadataStore.reconcileSourceMetadataWithFilesystem().catch((error) => {
    logger.warn({ err: error, workspacePath }, "Failed to reconcile source metadata store");
    return 0;
  });

  // Initialize entity metadata store for this workspace
  // Clears entries if workspace changed or version mismatch
  entityMetadataStore.initForWorkspace(workspacePath);

  // Ensure indexed path cache is available for startup cleanup steps
  await hydrateIndexedPathsCache();

  await purgeRebelEntriesFromIndex();
  await purgeConflictEntriesFromIndex();
  scheduleFileVectorsReconcile(workspacePath);

  // Check if we can skip the foreground full rescan.
  //
  // A stale completed-scan timestamp should not force a foreground reindex of
  // large existing workspaces on startup. Instead, start from the existing index
  // and run a delayed background discovery pass to preserve offline-change
  // correctness without blocking app readiness. Developers can force the old
  // foreground full-rescan path when diagnosing index drift.
  const scanCompletedAt = getScanCompletedAt();
  const now = Date.now();
  const timeSinceScanComplete = scanCompletedAt ? now - scanCompletedAt : Infinity;
  const recentCompletedScan = timeSinceScanComplete < SKIP_RESCAN_THRESHOLD_MS;
  const existingIndexedFileCount = getIndexStatus().indexedFiles;
  const hasUsableExistingIndex = existingIndexedFileCount > 0;
  const forceFullRescan = process.env.REBEL_FORCE_FULL_INDEX_RESCAN === '1';
  const skipForegroundRescan = !forceFullRescan && (recentCompletedScan || hasUsableExistingIndex);
  const shouldRunBackgroundDiscovery = skipForegroundRescan && hasUsableExistingIndex && !recentCompletedScan;

  if (skipForegroundRescan) {
    // Restore totalFilesDiscovered from last completed scan
    const savedTotalFiles = getTotalFilesAtCompletion();
    if (savedTotalFiles !== null) {
      state.totalFilesDiscovered = savedTotalFiles;
    } else {
      state.totalFilesDiscovered = existingIndexedFileCount;
    }

    logger.info(
      { 
        scanCompletedAt: new Date(scanCompletedAt ?? 0).toISOString(),
        timeSinceScanCompleteMs: timeSinceScanComplete,
        thresholdMs: SKIP_RESCAN_THRESHOLD_MS,
        existingIndexedFileCount,
        totalFilesRestored: state.totalFilesDiscovered,
        skipReason: recentCompletedScan ? 'recent-completed-scan' : 'existing-index',
        backgroundDiscoveryScheduled: shouldRunBackgroundDiscovery,
      },
      "Skipping foreground full rescan on startup"
    );

    // Clean up stale entries (files deleted/moved while app was closed)
    // This runs after hydration so we have the indexed paths to check
    await cleanupStaleEntries();

    // If source metadata store is empty (e.g., deleted/corrupted), rebuild from filesystem
    // This is fast since we're only parsing frontmatter, not generating embeddings
    if (sourceMetadataStore.isEmpty()) {
      logger.info('Source metadata store is empty - scanning sources for metadata');
      fireAndForget(rebuildSourceMetadata(workspacePath), 'fileWatcherService.line1628');
    }

    if (entityMetadataStore.isEmpty()) {
      logger.info('Entity metadata store is empty - scanning indexed markdown files for entities');
      fireAndForget(rebuildEntityMetadata(workspacePath), 'fileWatcherService.line1633');
    }

    if (shouldRunBackgroundDiscovery) {
      scheduleBackgroundDiscovery(workspacePath);
    }
  } else {
    logger.info(
      { 
        scanCompletedAt: scanCompletedAt ? new Date(scanCompletedAt).toISOString() : 'never',
        timeSinceScanCompleteMs: timeSinceScanComplete,
        existingIndexedFileCount,
        forceFullRescan,
      },
      "No recent completed scan - performing full rescan"
    );
  }

  // Subscribe to workspaceWatcherService for ongoing file changes
  // Note: workspaceWatcherService uses ignoreInitial: true, so we do our own discovery below
  workspaceWatcherService.on('file:added', eventListeners.fileAdded);
  workspaceWatcherService.on('file:changed', eventListeners.fileChanged);
  workspaceWatcherService.on('file:removed', eventListeners.fileRemoved);
  workspaceWatcherService.on('dir:added', eventListeners.dirAdded);
  workspaceWatcherService.on('dir:removed', eventListeners.dirRemoved);
  state.isSubscribed = true;

  // If we need a full rescan, discover files ourselves
  // (workspaceWatcherService uses ignoreInitial: true so won't send initial add events)
  if (!skipForegroundRescan) {
    logger.info({ workspacePath }, 'Starting file discovery for initial indexing');
    const discoveredCount = await discoverFiles(workspacePath, (filePath) => {
      state.totalFilesDiscovered++;
      queueFileAdd(filePath);
    });
    logger.info({ discoveredCount, queuedForIndexing: state.queue.items.length }, 'File discovery complete');
  }

  logger.info(
    {
      totalFiles: state.totalFilesDiscovered,
      queuedForIndexing: state.queue.items.length,
      workspacePath,
      skippedForegroundRescan: skipForegroundRescan,
      backgroundDiscoveryScheduled: shouldRunBackgroundDiscovery,
    },
    skipForegroundRescan
      ? "File indexing ready - watching for changes"
      : "File indexing ready - initial discovery complete, starting indexing"
  );

  // Mark initial scan complete and start processing after a short delay
  setTimeout(() => {
    fireAndForget((async () => {
    // Batch filter queue by mtime before processing (only if not skipping rescan)
    // This dramatically speeds up restart: 13k files in ~6s instead of ~11min
    if (!skipForegroundRescan && state.queue.items.length > 0) {
      await batchFilterQueue();
    }

    state.isInitialScanComplete = true;
    if (!skipForegroundRescan || state.queue.items.length > 0) {
      fireAndForget(startProcessing(), 'fileWatcherService.line1695');
    }

    // Resume enhancement on restart if conditions are met:
    // - Skipped rescan (index already exists and is recent)
    // - No queue to process (not busy with initial indexing)
    // - User hasn't explicitly paused enhancement
    // - Either small workspace (<1000 files) OR user explicitly requested enhancement
    if (skipForegroundRescan && !shouldRunBackgroundDiscovery && state.queue.items.length === 0) {
      const settings = getSettings();
      const userExplicitlyPaused = settings.enhancementUserRequested === false;
      const userExplicitlyRequested = settings.enhancementUserRequested === true;
      const shouldAutoEnhance = state.totalFilesDiscovered <= AUTO_ENHANCE_FILE_THRESHOLD;
      
      if (userExplicitlyPaused) {
        logger.info('Enhancement not resumed (user previously paused)');
      } else if (shouldAutoEnhance || userExplicitlyRequested) {
        logger.info(
          { 
            totalFiles: state.totalFilesDiscovered, 
            userExplicitlyRequested,
            autoEnhanceThreshold: AUTO_ENHANCE_FILE_THRESHOLD 
          },
          'Resuming enhancement on startup'
        );
        fireAndForget(startEnhancement(), 'fileWatcherService.line1720');
      }
    }
    })(), 'fileWatcher.initialScanDelay');
  }, INITIAL_SCAN_DELAY_MS);
}

/**
 * Unsubscribe from workspaceWatcherService events.
 */
function unsubscribeFromWatcher(): void {
  if (state.isSubscribed) {
    workspaceWatcherService.off('file:added', eventListeners.fileAdded);
    workspaceWatcherService.off('file:changed', eventListeners.fileChanged);
    workspaceWatcherService.off('file:removed', eventListeners.fileRemoved);
    workspaceWatcherService.off('dir:added', eventListeners.dirAdded);
    workspaceWatcherService.off('dir:removed', eventListeners.dirRemoved);
    state.isSubscribed = false;
  }
}

/**
 * Pause watching - unsubscribes from events but keeps index open and preserves state.
 * Use this for temporary pauses where user wants to resume later.
 * Note: The shared workspaceWatcherService continues running for other subscribers.
 */
export async function pauseWatching(): Promise<void> {
  cancelBackgroundDiscovery();

  // Stop any ongoing queue processing
  stopProcessing();

  // Clear the pending queue (work in progress is lost, but indexed files are preserved)
  state.queue.items = [];
  state.queue.processedCount = 0;

  // Unsubscribe from workspace watcher events
  unsubscribeFromWatcher();
  logger.info({ workspacePath: state.workspacePath }, "File indexing paused (index preserved)");

  // Keep workspacePath, totalFilesDiscovered, and index open for resume
  // Only reset session-specific counters
  state.filesIndexedThisSession = 0;
  state.isInitialScanComplete = false;
  state.hasRunPostScanFinalization = false;
  resetIndexerStats();
}

/**
 * Stop watching and close the index completely.
 * Use this for full cleanup (e.g., switching workspaces).
 * Note: The shared workspaceWatcherService continues running for other subscribers.
 */
export async function stopWatching(): Promise<void> {
  // Stop enhancement service before closing index
  stopEnhancement();

  cancelBackgroundDiscovery();
  
  // Stop any ongoing queue processing
  stopProcessing();

  // Clear the queue
  state.queue.items = [];
  state.queue.processedCount = 0;

  // Unsubscribe from workspace watcher events
  unsubscribeFromWatcher();
  logger.info("File indexing stopped");

  await closeIndex();

  state.workspacePath = null;
  state.onProgressCallback = null;
  state.isInitialScanComplete = false;
  state.hasRunPostScanFinalization = false;
  state.totalFilesDiscovered = 0;
  state.filesIndexedThisSession = 0;
  resetIndexerStats();

  // Clear Atlas cache since workspace is now null
  notifyAtlasWorkspaceChanged?.(null);
}

/**
 * Trigger a full reindex of the workspace
 * @param force - If true, clears the entire index and re-embeds all files.
 *                If false, only re-indexes files that have changed (mtime check).
 */
export async function reindexWorkspace(force: boolean = false): Promise<void> {
  if (!state.workspacePath) {
    throw new Error("No workspace is being watched");
  }

  const workspacePath = state.workspacePath;
  const onProgress = state.onProgressCallback;

  logger.info({ force, workspacePath }, "Starting workspace reindex");

  if (force) {
    // Force reindex: stop enhancement and clear the entire index table
    logger.info("Force reindex: stopping enhancement and clearing index");
    stopEnhancement();
    await clearIndex();
  }

  // Restart the watcher - chokidar will re-discover all files
  // With force=true, all files will be re-indexed since the table is empty
  // With force=false, only changed files (mtime) will be re-indexed
  await startWatching(workspacePath, onProgress ?? undefined);
}

/**
 * Determine the current index state
 */
export function getIndexState(): IndexState {
  if (state.isSubscribed) {
    return 'watching';
  }
  if (hasIndex()) {
    return 'paused';
  }
  return 'not_started';
}

/**
 * Get the current watcher status
 * 
 * Note: indexedFiles comes from the database (via getIndexStatus), not the session counter.
 * state.filesIndexedThisSession tracks files re-indexed this session (useful for progress),
 * but indexedFiles in the returned status should reflect the total persisted count.
 */
export function getWatcherStatus(): IndexStatus {
  const indexState = getIndexState();
  const indexStatus = getIndexStatus(state.isSubscribed, indexState);

  return {
    ...indexStatus,
    totalFiles: state.totalFilesDiscovered,
    // Use DB count from indexStatus, not session counter (fixes bug where indexedFiles=0 after restart)
    indexedFiles: indexStatus.indexedFiles,
    pendingFiles: state.queue.items.length,
  };
}

export function getIndexerStats(): IndexerStats {
  return {
    ...indexerStats,
    queueItemsProcessed: state.queue.processedCount,
  };
}

/**
 * Check if the watcher is active (subscribed to workspace events)
 */
export function isWatching(): boolean {
  return state.isSubscribed;
}

/**
 * Get the current workspace path being watched
 */
export function getWatchedWorkspace(): string | null {
  return state.workspacePath;
}

/**
 * Get the list of ignored patterns (for debugging/display)
 */
export function getIgnoredPatterns(): (string | RegExp)[] {
  return [...IGNORED_PATTERNS];
}
