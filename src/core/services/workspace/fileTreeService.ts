import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import { shouldSkipCloudSymlinkTarget } from '@core/utils/cloudStorageUtils';
import { resolveCloudSymlinkAdmission } from '@core/services/cloudSymlinkIndexing';
import {
  MAX_FILE_DEPTH,
  MAX_CHILDREN_PER_DIRECTORY,
  MAX_FILE_TREE_NODES,
  MAX_FILE_TREE_ESTIMATED_BYTES,
} from '@core/constants';
import { isPathInsideLexical } from '@core/utils/systemUtils';
import { getWorkspaceFileSystem } from '@core/workspaceFileSystem';
import type { FileNode } from '@shared/types';
import { WorkspaceFileSystemError } from './guardedPath';

/** Maximum depth for stats counting (effectively unlimited for practical use) */
const STATS_MAX_DEPTH = 50;
/** Maximum items to count before truncating (prevents runaway on huge directories) */
const STATS_MAX_ITEMS = 1_000_000;
/** Concurrency limit for stat() calls during truncation to prevent thread pool exhaustion */
const STAT_BATCH_SIZE = 100;
/**
 * Concurrency limit for cross-directory recursion. Sequential depth-first
 * recursion was producing 4+ minute walks on workspaces containing
 * cloud-storage symlinks (Google Drive, Dropbox), where each readdir on a
 * placeholder-bearing directory waits ~700ms for FUSE metadata. Parallel
 * recursion lets independent subtrees overlap their I/O wait. 16 is a
 * conservative balance between speedup and file-descriptor budget.
 */
const RECURSION_CONCURRENCY = 16;
const log = createScopedLogger({ service: 'workspace-file-tree' });

/**
 * Reason the file tree was truncated by a global/per-directory/depth budget.
 * Kept in lockstep with `FileTreeTruncationReasonSchema` in
 * `src/shared/ipc/schemas/library.ts` (the Zod boundary mirror).
 */
export type FileTreeTruncationReason =
  | 'global-node-cap'
  | 'global-byte-cap'
  | 'per-directory-cap'
  | 'depth'
  // A node (root or descendant) could not be listed/resolved (listdir-failed
  // or realpath-failed). The tree therefore does NOT fully represent the
  // workspace, so completeness must be false even when no budget cap fired.
  | 'unavailable';

/**
 * Completeness metadata travelling WITH the tree so no consumer can observe a
 * `FileNode[]` without observing whether it is complete (the Bug-2 safety
 * invariant — docs/plans/260616_stuck-library-renderer-oom/PLAN.md).
 */
export type FileTreeMetadata = {
  complete: boolean;
  truncated: boolean;
  reasons: FileTreeTruncationReason[];
  returnedNodes: number;
  nodeLimit: number;
  estimatedBytes: number;
  byteLimit: number;
  /**
   * Count of nodes (root or descendant) that could not be listed/resolved.
   * Non-zero forces `complete:false` and an `'unavailable'` reason, so a
   * consumer can never read `complete` as "the tree fully represents the
   * workspace" when a subtree was inaccessible.
   */
  unavailableNodes: number;
};

export type BuildFileTreePublicResult = {
  nodes: FileNode[];
  metadata: FileTreeMetadata;
};

/**
 * Map items through an async function with bounded concurrency. Mirrors the
 * pattern in cloudWorkspaceSync.ts; kept module-local because there is no
 * shared core helper yet.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  limit: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

type FileNodeUnavailableReason = 'realpath-failed' | 'listdir-failed';
type FileNodeWithUnavailable = FileNode & {
  unavailable?: FileNodeUnavailableReason;
};

type BuildFileTreeResult = {
  nodes: FileNodeWithUnavailable[];
  unavailable?: FileNodeUnavailableReason;
};

type WorkspaceRealpathCache = Map<string, Promise<string>>;

/**
 * Per-walk running budget, shared by reference across the WHOLE recursive walk
 * (NOT per-directory). Slots are reserved SYNCHRONOUSLY at admission — before
 * any await or child scheduling — so the `RECURSION_CONCURRENCY` concurrent
 * branches cannot collectively overshoot the cap. JS is single-threaded, so a
 * synchronous reservation segment cannot be interleaved by a sibling branch.
 */
type TreeBudget = {
  nodeLimit: number;
  byteLimit: number;
  nodesUsed: number;
  bytesUsed: number;
  /** Set whenever an otherwise-eligible node/child was declined by a budget. */
  reasons: Set<FileTreeTruncationReason>;
  /**
   * Count of nodes (root or descendant) that could not be listed/resolved.
   * Threaded through the whole walk so availability degradation surfaces in
   * metadata regardless of whether a budget cap also fired.
   */
  unavailableNodes: number;
};

/**
 * Fixed per-node object overhead (V8 hidden class + the small fixed fields:
 * kind, mtime, children array header, unavailable). The variable cost is the
 * two UTF-16 strings `name` and `path` at ~2 bytes/char. Documented in
 * `MAX_FILE_TREE_ESTIMATED_BYTES` (src/core/constants.ts). Deliberately a rough
 * lower bound — the real renderer retains several derivations of each node, so
 * this under-counts on purpose and the byte cap stays conservative.
 */
function estimateNodeBytes(name: string, nodePath: string): number {
  return 160 + 2 * (name.length + nodePath.length);
}

/**
 * Try to reserve one node's budget slot synchronously. Returns true if the node
 * fits (and decrements the shared running budget); false if a global cap is
 * reached, recording the binding reason so truncation travels with the result.
 */
function reserveNode(budget: TreeBudget, name: string, nodePath: string): boolean {
  if (budget.nodesUsed >= budget.nodeLimit) {
    budget.reasons.add('global-node-cap');
    return false;
  }
  const bytes = estimateNodeBytes(name, nodePath);
  if (budget.bytesUsed + bytes > budget.byteLimit) {
    budget.reasons.add('global-byte-cap');
    return false;
  }
  budget.nodesUsed += 1;
  budget.bytesUsed += bytes;
  return true;
}

// S4.1b: the bespoke `runCloudBoundedFsOp` / `CloudFsTimeoutError` / `insideCloud`
// timeout layer is RETIRED — every `workspaceFileSystem` read now routes through the
// `boundedWorkspaceFs` boundary inside the impl (S4.1b: `electronWorkspaceFileSystem`
// + `guardedPath`), which bounds cloud paths (containment-classified) via the killable
// child pool and surfaces a typed `CloudReconnecting` WorkspaceFileSystemError. The
// existing catch blocks here handle that exactly like any other realpath/list failure
// (visible-but-empty / unavailable node), so cloud-degraded reads degrade rather than
// hang — with NO per-consumer timer. Local reads keep the bare-fs fast path.

function cachedRealPath(
  cache: WorkspaceRealpathCache,
  workspaceFileSystem: { realPath: (root: string, target: string) => Promise<string> },
  root: string,
  relativePath: string,
): Promise<string> {
  const existing = cache.get(relativePath);
  if (existing !== undefined) return existing;
  const pending = workspaceFileSystem.realPath(root, relativePath);
  cache.set(relativePath, pending);
  return pending;
}

function serializeError(error: unknown): { name?: string; message?: string; code?: string } {
  if (!(error instanceof Error)) return { message: String(error) };
  const nodeError = error as NodeJS.ErrnoException;
  return {
    name: error.name,
    message: error.message,
    code: nodeError.code ?? (error instanceof WorkspaceFileSystemError ? error.code : undefined),
  };
}

function isBrokenPathError(error: unknown): boolean {
  if (error instanceof WorkspaceFileSystemError) {
    return error.code === 'BrokenSymlink';
  }
  const nodeError = error as NodeJS.ErrnoException;
  return nodeError.code === 'ENOENT' || nodeError.code === 'ENOTDIR';
}

function isRealpathFailure(error: unknown): boolean {
  if (error instanceof WorkspaceFileSystemError) {
    return error.code === 'RealpathFailed';
  }
  const nodeError = error as NodeJS.ErrnoException;
  return nodeError.code === 'ELOOP' || nodeError.code === 'EACCES' || nodeError.code === 'EPERM';
}

function isOutOfRootError(error: unknown): boolean {
  return error instanceof WorkspaceFileSystemError && error.code === 'OutOfRoot';
}

export type LibraryStats = {
  totalFiles: number;
  totalDirs: number;
  truncated: boolean;
};

function toRelativeWorkspacePath(root: string, target: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' ? '.' : relative;
}

/**
 * Count all files and directories in a workspace without building a tree.
 *
 * Matches buildFileTree filters: skips node_modules, respects hidden toggle.
 * Uses global realpath dedup to avoid counting symlinked paths multiple times.
 */
export const countLibraryItems = async (
  root: string,
  includeHidden: boolean
): Promise<LibraryStats> => {
  let totalFiles = 0;
  let totalDirs = 0;

  const result = await safeWalkDirectory(root, {
    maxDepth: STATS_MAX_DEPTH,
    maxEntries: STATS_MAX_ITEMS,
    onDirectory: ({ name, absolutePath }) => {
      if (!includeHidden && name.startsWith('.')) return false;
      if (name === 'node_modules') return false;
      if (!isPathInsideLexical(absolutePath, root)) return false;
      totalDirs++;
      return true;
    },
    onFile: ({ name, absolutePath }) => {
      if (!includeHidden && name.startsWith('.')) return;
      if (!isPathInsideLexical(absolutePath, root)) return;
      totalFiles++;
    },
  });

  return { totalFiles, totalDirs, truncated: result.truncatedReasons.length > 0 };
};

/**
 * Recursively build a file tree structure from a directory.
 *
 * Handles symlinks, respects depth limits, and can filter hidden files. Bounded
 * BY CONSTRUCTION: the whole walk shares one running node+byte budget
 * (`MAX_FILE_TREE_NODES` / `MAX_FILE_TREE_ESTIMATED_BYTES`) reserved
 * synchronously at admission, so the returned tree can never be unbounded and
 * OOM the renderer. Returns `{ nodes, metadata }` so completeness travels WITH
 * the result (the Bug-2 safety invariant — see
 * docs/plans/260616_stuck-library-renderer-oom/PLAN.md).
 *
 * When a directory has more than MAX_CHILDREN_PER_DIRECTORY entries,
 * prioritizes: directories first (to avoid hiding subtrees), then by mtime (recent first).
 */
// bounded-walker-pending: Per-directory MAX_CHILDREN_PER_DIRECTORY truncation
// requires inspecting and sorting all children of a directory (directories first,
// then mtime desc) BEFORE deciding which to recurse into. safeWalkDirectory's
// onDirectory callback only returns descend/skip; it cannot express per-dir
// priority truncation. Tracked by docs/plans/260503_s9_bounded_walker_resource_budget.md
// — Stage 6 ratchet captures this.
export const buildFileTree = async (
  root: string,
  directory: string,
  depth: number,
  includeHidden: boolean,
  visited: Set<string> = new Set<string>()
): Promise<BuildFileTreePublicResult> => {
  const realpathCache: WorkspaceRealpathCache = new Map();
  const budget: TreeBudget = {
    nodeLimit: MAX_FILE_TREE_NODES,
    byteLimit: MAX_FILE_TREE_ESTIMATED_BYTES,
    nodesUsed: 0,
    bytesUsed: 0,
    reasons: new Set<FileTreeTruncationReason>(),
    unavailableNodes: 0,
  };

  const result = await buildFileTreeInternal(
    root,
    directory,
    depth,
    includeHidden,
    visited,
    realpathCache,
    budget,
  );

  // returnedNodes must count the nodes actually returned to the consumer. The
  // recursive walk only reserves budget for the children it admits, NOT for the
  // synthetic root we emit when the root itself is unavailable — so derive the
  // count from the returned shape, not just `budget.nodesUsed`.
  let returnedNodes = budget.nodesUsed;
  let nodes: FileNode[];
  if (result.unavailable) {
    const rootNode: FileNodeWithUnavailable = {
      name: path.basename(path.resolve(directory)) || path.resolve(directory),
      path: directory,
      kind: 'directory',
      mtime: 0,
      children: [],
      unavailable: result.unavailable,
    };
    nodes = [rootNode];
    // The synthetic root is a real returned, unavailable node; record both so
    // metadata never reports returnedNodes:0 / complete:true for a tree the
    // consumer can actually see one (unavailable) node in.
    returnedNodes = 1;
    budget.unavailableNodes += 1;
  } else {
    nodes = result.nodes;
  }

  // Any unavailable node anywhere in the walk (root or descendant) means the
  // tree does NOT fully represent the workspace — force completeness false.
  if (budget.unavailableNodes > 0) {
    budget.reasons.add('unavailable');
  }

  const reasons = Array.from(budget.reasons);
  const truncated = reasons.length > 0;
  const metadata: FileTreeMetadata = {
    complete: !truncated,
    truncated,
    reasons,
    returnedNodes,
    nodeLimit: budget.nodeLimit,
    estimatedBytes: budget.bytesUsed,
    byteLimit: budget.byteLimit,
    unavailableNodes: budget.unavailableNodes,
  };

  // Structured log of actuals so the caps can be tuned against real workspaces.
  log.info(
    {
      root,
      returnedNodes: metadata.returnedNodes,
      nodeLimit: metadata.nodeLimit,
      estimatedBytes: metadata.estimatedBytes,
      byteLimit: metadata.byteLimit,
      truncated: metadata.truncated,
      unavailableNodes: metadata.unavailableNodes,
      reasons,
    },
    truncated
      ? 'workspace-file-tree: tree truncated by budget'
      : 'workspace-file-tree: tree built within budget',
  );

  return { nodes, metadata };
};

async function buildFileTreeInternal(
  root: string,
  directory: string,
  depth: number,
  includeHidden: boolean,
  visited: Set<string>,
  realpathCache: WorkspaceRealpathCache,
  budget: TreeBudget,
): Promise<BuildFileTreeResult> {
  if (depth > MAX_FILE_DEPTH) {
    // A directory whose children would have lived below the depth cap is a
    // depth-truncated subtree only if it had eligible children; we conservatively
    // record 'depth' the moment we refuse to descend so completeness is honest.
    budget.reasons.add('depth');
    return { nodes: [] };
  }

  const workspaceFileSystem = getWorkspaceFileSystem();
  if (!isPathInsideLexical(directory, root)) {
    return { nodes: [] };
  }

  const relativeDirectory = toRelativeWorkspacePath(root, directory);

  let realDirectory = directory;
  try {
    realDirectory = await cachedRealPath(
      realpathCache,
      workspaceFileSystem,
      root,
      relativeDirectory,
    );
  } catch (error) {
    log.debug(
      { root, directory, relativeDirectory, error: serializeError(error) },
      'workspace-file-tree: realpath failed while building file tree',
    );
    return { nodes: [], unavailable: 'realpath-failed' };
  }

  // Cycle detection only — we never mutate the caller's set so concurrent
  // siblings (see RECURSION_CONCURRENCY) can't poison each other's ancestry
  // view. When descending we hand each child a fresh Set that includes our
  // realDirectory.
  if (visited.has(realDirectory)) {
    return { nodes: [] };
  }

  {
    let entries: Array<{
      name: string;
      isDirectory: boolean;
      isSymbolicLink: boolean;
    }> = [];
    try {
      // S4.1b: bounded inside the impl (cloud paths → boundary). A cloud-unavailable
      // read surfaces as CloudReconnecting and is caught here exactly like any other
      // listdir failure → unavailable node, never a hang.
      entries = await workspaceFileSystem.listDirectory(root, relativeDirectory);
    } catch (error) {
      log.debug(
        { root, directory, relativeDirectory, error: serializeError(error) },
        'workspace-file-tree: listDirectory failed while building file tree',
      );
      return { nodes: [], unavailable: 'listdir-failed' };
    }

    // Filter entries BEFORE truncation (fixes bug where hidden files consume quota)
    const filteredEntries = entries.filter((entry) => {
      if (!includeHidden && entry.name.startsWith('.')) return false;
      if (entry.name === 'node_modules') return false;
      const absolutePath = path.resolve(directory, entry.name);
      if (!isPathInsideLexical(absolutePath, root)) return false;
      return true;
    });

    // If we need to truncate, prioritize directories and recent files
    let entriesToProcess = filteredEntries;
    if (filteredEntries.length > MAX_CHILDREN_PER_DIRECTORY) {
      budget.reasons.add('per-directory-cap');
      // Get mtime for all entries (needed for smart truncation)
      // Process in batches to prevent thread pool exhaustion with huge directories
      type EntryWithMeta = {
        entry: (typeof filteredEntries)[number];
        absolutePath: string;
        relativePath: string;
        isDir: boolean;
        mtime: number;
      };
      const entriesWithMtime: EntryWithMeta[] = [];

      for (let i = 0; i < filteredEntries.length; i += STAT_BATCH_SIZE) {
        const batch = filteredEntries.slice(i, i + STAT_BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async (entry) => {
            const absolutePath = path.resolve(directory, entry.name);
            const relativePath = path.join(relativeDirectory, entry.name);
            let mtime = 0;
            let isDir = entry.isDirectory;

            // For symlinks, check if they point to directories. Cloud paths are bounded
            // inside the impl (S4.1b) — a cloud-unavailable read throws and is caught
            // here, degrading to the 0-mtime fallback, never blocks.
            if (!isDir && entry.isSymbolicLink) {
              try {
                const stat = await workspaceFileSystem.stat(root, relativePath);
                isDir = stat.isDirectory;
                mtime = stat.mtimeMs;
              } catch {
                // Broken / out-of-workspace symlink, or cloud-unavailable - treat as
                // file with old mtime (lowest priority).
              }
            } else {
              try {
                const stat = await workspaceFileSystem.stat(root, relativePath);
                mtime = stat.mtimeMs;
              } catch {
                // Can't stat (or cloud-unavailable) - use 0 mtime (lowest priority).
              }
            }

            return { entry, absolutePath, relativePath, isDir, mtime };
          })
        );
        entriesWithMtime.push(...batchResults);
      }

      // Sort: directories first, then by mtime descending (recent first)
      entriesWithMtime.sort((a, b) => {
        // Directories always come first (prevents hiding entire subtrees)
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        // Within same type, sort by mtime descending (recent first)
        return b.mtime - a.mtime;
      });

      // Take the top entries after prioritization
      entriesToProcess = entriesWithMtime
        .slice(0, MAX_CHILDREN_PER_DIRECTORY)
        .map((e) => e.entry);
    }

    // Parallelize stat calls in batches to prevent thread pool exhaustion
    type StatResult = {
      entry: (typeof entriesToProcess)[number];
      absolutePath: string;
      relativePath: string;
      treatAsDirectory: boolean;
      mtime: number;
      unavailable?: FileNodeUnavailableReason;
      drop?: boolean;
      /**
       * Symlink whose resolved target is a cloud-storage mount: emit the node so
       * the user still sees the directory exists, but do NOT recurse into it
       * (descending blocks on FUSE I/O — RC-1). Provider recorded for the
       * detected-and-skipped log line.
       */
      cloudSkip?: { provider?: string };
    };
    const statResults: StatResult[] = [];

    for (let i = 0; i < entriesToProcess.length; i += STAT_BATCH_SIZE) {
      const batch = entriesToProcess.slice(i, i + STAT_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (entry) => {
          const absolutePath = path.resolve(directory, entry.name);
          const relativePath = path.join(relativeDirectory, entry.name);
          let treatAsDirectory = entry.isDirectory;
          let mtime = 0;
          let unavailable: FileNodeUnavailableReason | undefined;
          let drop = false;
          let cloudSkip: { provider?: string } | undefined;

          try {
            // S4.1b: cloud paths are bounded inside the impl (containment-classified →
            // the killable-pool boundary). A cloud-unavailable read throws
            // CloudReconnecting, caught by the outer catch exactly like any other stat
            // failure (a symlink → realpath-failed / unavailable; a plain entry just
            // gets the symlink-only handling) — never a hang.
            const stat = await workspaceFileSystem.stat(root, relativePath);
            mtime = stat.mtimeMs;
            if (!treatAsDirectory && entry.isSymbolicLink) {
              treatAsDirectory = stat.isDirectory;
            }
            if (entry.isSymbolicLink && stat.isDirectory) {
              try {
                const resolvedTarget = await cachedRealPath(
                  realpathCache,
                  workspaceFileSystem,
                  root,
                  relativePath,
                );
                // Don't descend into a symlink whose resolved target is a cloud
                // mount — its readdir/stat block on FUSE I/O and hang the scan
                // (RC-1). Keep the node VISIBLE (directory with no children) so
                // the user still sees it exists; just refuse to walk it.
                const cloudDecision = shouldSkipCloudSymlinkTarget(resolvedTarget);
                if (cloudDecision.skip) {
                  // Stage 6b admission: when the admission flag is ON and the space's
                  // off-thread liveness verdict is `healthy`, DESCEND (don't mark
                  // `cloudSkip`) — its descendants are containment-classified, so the
                  // boundary bounds their reads (no per-consumer timer needed; the
                  // Stage-7 `insideCloud`/`descendInsideCloud` propagation retired in
                  // S4.1b). Decided readlink-only from the symlink's OWN path, keyed by
                  // the same first-cloud-hop minter the verdict cache uses. Default OFF
                  // ⇒ `'skip'` ⇒ byte-identical (mark `cloudSkip`, visible-but-empty).
                  if (resolveCloudSymlinkAdmission(absolutePath) !== 'admit') {
                    cloudSkip = { provider: cloudDecision.provider };
                  }
                }
              } catch (error) {
                if (isBrokenPathError(error)) {
                  drop = true;
                } else if (isOutOfRootError(error)) {
                  drop = true;
                } else {
                  unavailable = 'realpath-failed';
                  treatAsDirectory = false;
                  log.debug(
                    { root, relativePath, absolutePath, error: serializeError(error) },
                    'workspace-file-tree: symlink realpath failed after stat succeeded',
                  );
                }
              }
            }
          } catch (error) {
            if (entry.isSymbolicLink) {
              if (isBrokenPathError(error)) {
                drop = true;
              } else if (isOutOfRootError(error)) {
                drop = true;
              } else if (isRealpathFailure(error)) {
                unavailable = 'realpath-failed';
              }
              treatAsDirectory = false;
            }
          }

          return { entry, absolutePath, relativePath, treatAsDirectory, mtime, unavailable, drop, cloudSkip };
        })
      );
      statResults.push(...batchResults);
    }

    // Drop entries the cycle/permission probe asked us to suppress, and log
    // each drop once so the existing diagnostics remain visible.
    const liveResults = statResults.filter((stat) => {
      if (!stat.drop) return true;
      log.debug(
        { root, absolutePath: stat.absolutePath, entryName: stat.entry.name },
        'workspace-file-tree: dropping unavailable symlink from file tree',
      );
      return false;
    });

    // ───────────────────────────────────────────────────────────────────
    // GLOBAL BUDGET RESERVATION — SYNCHRONOUS, BEFORE ANY CHILD SCHEDULING.
    //
    // Reserve a budget slot for every node THIS directory will emit, in the
    // final display order (directories first, then files; within each group the
    // per-dir prioritized order from liveResults). This whole loop is
    // synchronous — no await — so the `RECURSION_CONCURRENCY` concurrent
    // branches cannot interleave their reservations and collectively overshoot.
    // Children are only recursed into AFTER their slot is reserved here.
    // ───────────────────────────────────────────────────────────────────
    const admittedDirectoryStats: StatResult[] = [];
    const admittedFileStats: StatResult[] = [];

    const directoryStats = liveResults.filter((stat) => stat.treatAsDirectory);
    const fileStats = liveResults.filter((stat) => !stat.treatAsDirectory);

    let budgetExhausted = false;
    // Directories first (preserve dirs-first ordering and avoid hiding subtrees).
    for (const stat of directoryStats) {
      if (reserveNode(budget, stat.entry.name, stat.absolutePath)) {
        admittedDirectoryStats.push(stat);
      } else {
        budgetExhausted = true;
        break;
      }
    }
    if (!budgetExhausted) {
      for (const stat of fileStats) {
        if (reserveNode(budget, stat.entry.name, stat.absolutePath)) {
          admittedFileStats.push(stat);
        } else {
          break;
        }
      }
    }

    // Recurse into ADMITTED directories CONCURRENTLY. Each child gets its own
    // ancestry-cloned visited set so concurrent siblings can't false-positive
    // each other's cycle detection. The shared budget is threaded through so the
    // whole walk shares one ceiling. Cloud-mount symlink targets are admitted as
    // VISIBLE-but-not-walked nodes (no recursion) so their unbounded FUSE I/O
    // never blocks the scan (RC-1).
    const directoryResults = await mapWithConcurrency(
      admittedDirectoryStats,
      async (stat): Promise<{ stat: StatResult; childResult: BuildFileTreeResult }> => {
        if (stat.cloudSkip) {
          log.info(
            {
              root,
              entryName: stat.entry.name,
              provider: stat.cloudSkip.provider,
            },
            'workspace-file-tree: skipping descent into cloud-mount symlink target',
          );
          return { stat, childResult: { nodes: [] } };
        }
        const childVisited = new Set(visited);
        childVisited.add(realDirectory);
        const childResult = await buildFileTreeInternal(
          root,
          stat.absolutePath,
          depth + 1,
          includeHidden,
          childVisited,
          realpathCache,
          budget,
        );
        return { stat, childResult };
      },
      RECURSION_CONCURRENCY,
    );

    const directoryNodes: FileNodeWithUnavailable[] = directoryResults.map(
      ({ stat, childResult }) => {
        if (childResult.unavailable) {
          // A descendant directory we admitted could not be listed/resolved;
          // record it so metadata.complete becomes false at the top level.
          budget.unavailableNodes += 1;
        }
        return {
          name: stat.entry.name,
          path: stat.absolutePath,
          kind: 'directory',
          mtime: stat.mtime,
          children: childResult.nodes,
          ...(childResult.unavailable ? { unavailable: childResult.unavailable } : {}),
        };
      },
    );

    const fileNodes: FileNodeWithUnavailable[] = admittedFileStats.map((stat) => {
      if (stat.unavailable) {
        budget.unavailableNodes += 1;
      }
      return {
        name: stat.entry.name,
        path: stat.absolutePath,
        kind: 'file',
        mtime: stat.mtime,
        ...(stat.unavailable ? { unavailable: stat.unavailable } : {}),
      };
    });

    const nodes: FileNodeWithUnavailable[] = [...directoryNodes, ...fileNodes];

    // Final sort for display: directories first, then alphabetical
    nodes.sort((a, b) => {
      if (a.kind === b.kind) {
        return a.name.localeCompare(b.name);
      }
      return a.kind === 'directory' ? -1 : 1;
    });

    return { nodes };
  }
}
