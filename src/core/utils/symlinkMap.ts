import { realpathSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { ignoreBestEffortCleanup } from "@shared/utils/intentionalSwallow";
import { walkToFirstCloudHopViaReadlink } from "@core/utils/readlinkChain";
import { detectCloudStorage } from "@core/utils/cloudStorageUtils";

/**
 * Shared symlink-map primitive for O(1) workspace-relative path conversion.
 *
 * Background: converting an absolute (real) path back to a workspace-relative
 * path used to require an O(workspace-size) synchronous filesystem walk per
 * call (`tryConvertToWorkspacePath`). The expensive part is discovering the
 * symlinks that "mount" outside-the-workspace directories into the workspace
 * tree (e.g. Google-Drive symlinks). That discovery only needs to happen ONCE
 * per workspace; afterwards each conversion is O(path-depth realpath) plus
 * O(#symlinks) string math.
 *
 * This module promotes the pattern that previously lived privately inside
 * `atlasService` so that `systemUtils.tryConvertToWorkspacePath`,
 * `atlasService`, and (Stage 2) the fileIndex hot paths can all share one
 * cached registry.
 *
 * Depth / skip policy is deliberately identical to the legacy walker:
 *   - max depth 4 (work/Company/Drive/...),
 *   - always skip `node_modules`,
 *   - skip dotfiles at depth > 0 (root-level dotfiles are still scanned).
 */

/** Max recursion depth — matches the scan-drive-symlinks handler and the legacy walker. */
export const SYMLINK_MAP_MAX_DEPTH = 4;

export interface SymlinkMapping {
  /** The resolved real path of the symlink target (e.g. /Users/.../My Drive/CoS). */
  realPath: string;
  /** The workspace-relative path of the symlink itself (e.g. chief-of-staff). */
  workspacePath: string;
}

/**
 * Build a registry of symlinks under `workspaceRoot`, mapping each symlink's
 * resolved real target to its workspace-relative path.
 *
 * Scans synchronously, bounded to {@link SYMLINK_MAP_MAX_DEPTH}, skipping
 * `node_modules` and depth>0 dotfiles. Broken / inaccessible symlinks are
 * silently skipped (their `realpathSync` throws), exactly as the legacy walker
 * did.
 *
 * The result is sorted by `realPath` length descending so that the most
 * specific (deepest-nested) symlink target wins when multiple symlinks could
 * contain a given path.
 *
 * CLOUD HANG-PROOFING (Stage 5, GPT-F6 boot-hang vector): this runs SYNCHRONOUSLY
 * at index init (`fileIndexService.initializeIndex`). The original code did
 * `realpathSync(entryPath)` on EVERY symlink — and a symlink pointing into a
 * dead/unresponsive cloud FUSE mount (Google Drive / Dropbox / OneDrive / iCloud /
 * Box) makes `realpathSync` block in the kernel with no timeout, parking a libuv
 * worker and (when several pile up) wedging boot. Unlike an async path, a sync
 * `realpathSync` hang cannot even be try/catch-rescued. So before `realpathSync`,
 * we classify the symlink chain READLINK-ONLY (`walkToFirstCloudHopViaReadlink` —
 * reads only the link's own inode, never dereferences) and SKIP any symlink whose
 * chain reaches a cloud mount (cloud targets are excluded from indexing anyway, so
 * they have no place in the workspace-relative conversion map). Only NON-cloud
 * symlinks reach `realpathSync`. A non-cloud outside-workspace symlink
 * (`rebel-system → /Applications/…`) still classifies non-cloud → still mapped.
 *
 * The recursion's per-directory `readdirSync(dir)` is guarded too: `scanDirectory`
 * skips (does not `readdirSync`) any directory the pure-string `detectCloudStorage`
 * classifier flags as a cloud mount — primarily the workspace ROOT itself if a
 * caller ever roots the index at a cloud path (the watcher/indexer normally root at
 * the single LOCAL `coreDirectory`, but the gate is defence-in-depth). Past the
 * root, the only way to reach a cloud directory during descent is THROUGH a cloud
 * symlink — which the readlink-only guard above already skips before any deref — so
 * `scanDirectory` never recurses into a live cloud subtree. The string gate costs
 * nothing on a local tree (no I/O).
 */
// bounded-walker-pending: see docs/plans/260503_s9_bounded_walker_resource_budget.md
export function buildSymlinkMap(workspaceRoot: string): SymlinkMapping[] {
  const mappings: SymlinkMapping[] = [];

  const scanDirectory = (dir: string, relativePrefix: string, depth: number): void => {
    if (depth > SYMLINK_MAP_MAX_DEPTH) return;

    // Cloud hang-proofing (Stage 5): never `readdirSync` a directory that the
    // pure-string classifier flags as a cloud mount — a dead FUSE mount blocks
    // `readdirSync` unbounded with no try/catch rescue (sync boot-hang). This is
    // primarily the workspace ROOT if it is itself cloud-classified; past the root
    // we only reach a cloud dir through a cloud symlink, which the readlink-only
    // guard below skips before any deref. Pure string check (no I/O) → local trees
    // pay nothing.
    if (detectCloudStorage(dir).isCloud) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      // Skip unreadable directories (parity with legacy walker)
      ignoreBestEffortCleanup(err, {
        operation: "buildSymlinkMap.scanDirectory.readdir",
        reason: "skip-unreadable-directory-during-symlink-scan",
        owner: "core.symlinkMap",
      });
      return;
    }

    for (const entry of entries) {
      // Skip hidden at depth > 0, always skip node_modules (parity with legacy walker)
      if (depth > 0 && entry.startsWith(".")) continue;
      if (entry === "node_modules") continue;

      const entryPath = path.join(dir, entry);
      const relativePath = relativePrefix ? path.join(relativePrefix, entry) : entry;

      try {
        const stat = lstatSync(entryPath);

        if (stat.isSymbolicLink()) {
          // Cloud hang-proofing (Stage 5, GPT-F6): classify the symlink chain
          // READLINK-ONLY before any `realpathSync`. A symlink whose chain reaches
          // a cloud mount is SKIPPED — `realpathSync` into a dead FUSE mount is the
          // sync boot-hang, and cloud targets are excluded from indexing so they
          // have no place in the workspace-relative conversion map anyway. Only
          // NON-cloud symlinks (`rebel-system → /Applications/…`, a local-folder
          // alias) reach `realpathSync`.
          const hop = walkToFirstCloudHopViaReadlink(entryPath);
          if (hop.kind === "cloud") {
            // Reaches a cloud mount via readlink — never deref. Skip from the map.
            continue;
          }
          let realPath: string;
          try {
            realPath = realpathSync(entryPath);
          } catch {
            // Broken symlink, skip
            continue;
          }
          mappings.push({ realPath, workspacePath: relativePath });
        } else if (stat.isDirectory()) {
          // Recurse into directories to find nested symlinks
          scanDirectory(entryPath, relativePath, depth + 1);
        }
      } catch (err) {
        // Skip inaccessible entries (parity with legacy walker)
        ignoreBestEffortCleanup(err, {
          operation: "buildSymlinkMap.scanDirectory.stat",
          reason: "skip-inaccessible-entry-during-symlink-scan",
          owner: "core.symlinkMap",
        });
      }
    }
  };

  scanDirectory(path.resolve(workspaceRoot), "", 0);

  // Sort by realPath length descending (longest / most-specific first).
  //
  // INTENTIONAL deterministic divergence from the legacy walker (MA2, 260529
  // GPT-5.5 review): when two in-workspace symlinks both reach the same canonical
  // file (e.g. /ws/outer -> /outside and /ws/short -> /outside/deep), the legacy
  // walker returned whichever symlink `readdirSync` happened to visit FIRST —
  // filesystem-/platform-dependent and therefore nondeterministic. Sorting
  // longest-realPath-first makes the most-specific target win deterministically
  // (so /outside/deep beats /outside). Deterministic > legacy readdir order.
  // Covered by the "intentional divergences" block in
  // tryConvertToWorkspacePath.test.ts.
  mappings.sort((a, b) => b.realPath.length - a.realPath.length);

  return mappings;
}

/**
 * Containment check using `path.relative` (NOT raw `startsWith`) so that
 * boundary cases like `/tmp/ws2` vs `/tmp/ws` and Windows drive/separator
 * boundaries are handled correctly.
 *
 * Returns the relative part if `target` is contained in (or equal to)
 * `container`, otherwise `null`.
 */
const relativeIfContained = (target: string, container: string): string | null => {
  const rel = path.relative(container, target);
  // Inside iff rel is '', or rel is not '..', does not start with '..'+sep, and is not absolute.
  if (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel))
  ) {
    return rel;
  }
  return null;
};

/**
 * Convert an absolute REAL path to a workspace-relative path using a
 * pre-computed symlink registry. O(#symlinks) string checks, no filesystem I/O.
 *
 * Assumes `absoluteRealPath` is already realpath-resolved (the caller resolves
 * it once). Mappings should be sorted longest-realPath-first (as
 * {@link buildSymlinkMap} returns them) so the most specific match wins.
 *
 * Returns the workspace-relative path, or `null` if no symlink target contains
 * the path.
 */
export function convertPathWithSymlinkMap(
  absoluteRealPath: string,
  mappings: SymlinkMapping[],
): string | null {
  for (const mapping of mappings) {
    const relativePart = relativeIfContained(absoluteRealPath, mapping.realPath);
    if (relativePart !== null) {
      return relativePart
        ? path.join(mapping.workspacePath, relativePart)
        : mapping.workspacePath;
    }
  }
  return null;
}
