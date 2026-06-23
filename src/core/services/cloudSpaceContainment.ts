/**
 * cloudSpaceContainment — the cached, readlink-only "is this path under a cloud
 * space, and is that space healthy" map (PLAN.md "Purge-Gating & Removal Design",
 * R6; Stage 4b).
 *
 * Both the core search-path purge (`sourceMetadataStore.filterExistingSources` —
 * R2) and the main-side Removal Coordinator (`indexRemovalCoordinator` — R1) must
 * answer the same question about an absolute index-entry path:
 *
 *   "Is this entry under a cloud-storage–backed space, and what is that space's
 *    current health verdict?"
 *
 * The hard rule (R6): answering this MUST be a PURE STRING PREFIX MATCH on a
 * pre-built, cached set of cloud-space roots — it must NEVER `realpath`/`stat`/
 * `access` the entry path or the space root on the purge/search path (that
 * dereference of a possibly-dead FUSE mount IS the libuv-pool hang this whole
 * plan exists to kill). The cloud-space-root set is built FS-FREE from the
 * settings `spaces` (the source of truth for which workspace entries are
 * symlinks), with the ONLY filesystem touch being a `readlinkSync` on the LOCAL
 * link inodes (stop-at-first-cloud-hop, via the shared `readlinkChain` walker —
 * never readlinking into the mount).
 *
 * --- What is matched against (BOTH path forms) ---
 * Index entries reach the purge/search path in TWO forms, and containment must
 * recognise BOTH or it is a silent no-op for the dominant stored form:
 *
 *  (a) WORKSPACE-SYMLINK form — `coreDirectory/<space.path>/…`. This is the path
 *      as a live chokidar-unlink event / `safeWalkDirectory`-recovery walk reports
 *      it (descended THROUGH the symlink, not the resolved cloud target).
 *  (b) RESOLVED-CLOUD-REALPATH form — `~/Library/CloudStorage/GoogleDrive-…/…`.
 *      This is what `fileIndexService.indexFileInternal` actually STORES: it keys
 *      source metadata, vector rows, and `indexedMtimes` under
 *      `canonicalPath = await fs.realpath(filePath)` (intentional for Google Drive
 *      spaces). `getIndexedPaths()` returns those canonical keys, which feed the
 *      startup `cleanupStaleEntries` (→ coordinator `absence`, R1) and
 *      `filterExistingSources` (R2). This is the DOMINANT stored form, so matching
 *      it is what makes R1/R2 actually fire (the original symlink-only match missed
 *      it — a confirmed Stage-4b silent no-op).
 *
 * The resolved-cloud-realpath prefix (b) is derived FS-FREE from the SAME
 * first-cloud-hop target the verdict-cache uses — `fs.realpath` of an entry under a
 * cloud symlink bottoms out under that first cloud hop's target, so the verdict KEY
 * IS the canonical-form prefix. We also fold in the settings `sourcePath` (already
 * the resolved cloud folder) when present, for robustness. Both forms map to the
 * SAME space → the SAME `mintFirstCloudHopTargetSync` verdict-cache key, so the
 * prewarm-populated verdict is read back under a byte-identical key by construction
 * regardless of which form the entry arrived in.
 *
 * --- Verdict (fail-closed) ---
 * The verdict comes from the synchronous `getCloudLivenessProbe().getCachedVerdict`
 * (no I/O, never throws). `unknown` (cold start / no prober) is treated by callers
 * identically to `degraded` (exclude + retain) — fail-closed.
 *
 * Pure + synchronous on the query path. No `electron` import; safe in `src/core/`
 * (RN/cloud build never configure cloud spaces, so the map stays empty → every
 * path classifies `'local'`, i.e. unchanged behaviour there).
 */
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { toPortablePath } from '@core/utils/portablePath';
import { detectCloudStorage } from '@core/utils/cloudStorageUtils';
import type { SpaceConfig } from '@shared/types/settings';
import {
  type CloudHealthVerdict,
  type ReadlinkResolvedTarget,
  getCloudLivenessProbe,
} from '@core/services/cloudLivenessProbe';
import { mintCloudHopTargetCloudRootSafe } from '@core/services/cloudLivenessProbe.types';

const log = createScopedLogger({ service: 'cloudSpaceContainment' });

/**
 * One cloud-space root in the cached containment map.
 */
interface CloudSpaceRoot {
  /**
   * The normalized prefixes (forward slashes, NFC, case-folded on case-insensitive
   * platforms, trailing slash) an index entry under this space can be keyed by —
   * an entry matches this space if it `startsWith` ANY of these. Includes BOTH:
   *  - the WORKSPACE-SYMLINK prefix (`coreDirectory/space.path`) — the live
   *    chokidar-unlink / recovery-walk form; and
   *  - the RESOLVED-CLOUD-REALPATH prefix(es) (the first-cloud-hop target and, when
   *    present, the settings `sourcePath`) — the form `indexFileInternal` STORES
   *    via `fs.realpath`, which dominates the stored index. Matching both is what
   *    makes R1/R2 fire for the dominant stored form (the symlink-only match was a
   *    silent no-op for it).
   */
  readonly matchPrefixes: readonly string[];
  /**
   * The first-cloud-hop target — the verdict-cache KEY. Minted readlink-only via
   * the shared stop-at-first-cloud-hop walker, byte-identical to the prewarm key.
   */
  readonly verdictKey: ReadlinkResolvedTarget;
}

/**
 * Result of classifying an absolute index-entry path for removal/search gating.
 *
 *  - `'local'` — the path is NOT under any cloud space → unchanged behaviour
 *    (the existing cheap `fs.access` / removal proceeds).
 *  - `{ cloudSpaceRoot, verdict, verdictKey }` — the path IS under a cloud space;
 *    the caller consults `verdict` (R1: retain unless `healthy`; R2: skip the
 *    fs-check regardless) and may use `verdictKey` (the readlink-only verdict-cache
 *    key) to read freshness (R5) or force a re-probe (Stage 4c).
 */
export type RemovalPathClassification =
  | 'local'
  | {
      readonly cloudSpaceRoot: string;
      readonly verdict: CloudHealthVerdict;
      readonly verdictKey: ReadlinkResolvedTarget;
    };

// Module-singleton cache. Empty until configured (cloud/headless/tests that don't
// configure it → every path classifies `'local'` → unchanged behaviour).
let cloudSpaceRoots: readonly CloudSpaceRoot[] = [];

const CASE_INSENSITIVE_PLATFORMS = new Set(['darwin', 'win32']);

/**
 * Normalize an absolute path for prefix comparison: forward slashes + NFC +
 * case-folded on case-insensitive platforms. Mirrors the authority-cache key
 * normalization in cloudStorageUtils so comparisons agree.
 */
function normalizeForPrefix(absolutePath: string): string {
  const portable = toPortablePath(path.resolve(absolutePath)).normalize('NFC');
  return CASE_INSENSITIVE_PLATFORMS.has(process.platform) ? portable.toLowerCase() : portable;
}

/**
 * Ensure a normalized directory prefix ends with exactly one trailing slash so
 * `entry.startsWith(prefix)` cannot match a sibling whose name shares the prefix
 * (e.g. `/ws/General` must NOT match `/ws/General-archive/x`).
 */
function withTrailingSlash(normalizedDir: string): string {
  return normalizedDir.endsWith('/') ? normalizedDir : `${normalizedDir}/`;
}

/**
 * (Re)build the cached cloud-space-root containment map from the settings spaces.
 * This is the invalidation hook (R6): call it at startup and whenever the spaces
 * configuration changes.
 *
 * FS-FREE for candidate enumeration (settings `spaces`, never a `readdir` of
 * `coreDirectory` — which can itself be a cloud-classified FUSE mount). The verdict
 * key is minted via the cloud-root-safe `mintCloudHopTargetCloudRootSafe`: when the
 * workspace root is itself cloud-classified, ZERO I/O (derived from the cached
 * `sourcePath`); otherwise the only filesystem touch is `readlinkSync` on LOCAL link
 * inodes (stop-at-first-cloud-hop; never readlinks into the mount, never readlinks
 * under a possibly-dead cloud root). A symlink space whose chain is not cloud (a
 * genuinely local space, e.g. `rebel-system → /Applications/…`) or is unclassifiable
 * (dangling / dead first hop, or — under a cloud root — no usable cached cloud
 * `sourcePath`) yields no entry → those paths classify `'local'` and keep their
 * existing fs-checked behaviour (correct: a non-cloud space is not a hang vector).
 *
 * @param coreDirectory absolute workspace root — used ONLY for `path.join` of
 *   relative space paths (no filesystem touch).
 * @param spaces the configured spaces from settings. `undefined`/empty → clears
 *   the map (every path classifies `'local'`).
 */
export function configureCloudSpaceContainment(
  coreDirectory: string | null | undefined,
  spaces: readonly SpaceConfig[] | undefined,
): void {
  if (!coreDirectory || !spaces || spaces.length === 0) {
    cloudSpaceRoots = [];
    log.debug('cloud-space containment map cleared (no coreDirectory / spaces)');
    return;
  }

  // Whether the workspace root is itself cloud-classified (cloud-inside-cloud, e.g.
  // a Dropbox workspace root holding Google-Drive symlinks). Pure-string match — no
  // filesystem touch. When true, we must NOT `readlinkSync` a link inode under it
  // (that traverses the possibly-dead mount → main-thread hang); the cloud-root-safe
  // key source derives the verdict key zero-I/O from the cached `sourcePath` instead.
  const rootIsCloud = detectCloudStorage(coreDirectory).isCloud;

  const roots: CloudSpaceRoot[] = [];
  const seenWorkspacePrefixes = new Set<string>();
  for (const space of spaces) {
    if (!space.isSymlink) continue; // only symlinked spaces can reach a cloud mount
    // The link lives at `coreDirectory/space.path`. Pure string join — NO
    // filesystem touch on `coreDirectory` even if it is itself cloud-classified.
    const linkPath = path.isAbsolute(space.path)
      ? space.path
      : path.join(coreDirectory, space.path);
    // Cloud-root-safe verdict-key mint (the SAME helper prewarm + admission use):
    // under a cloud root, zero-I/O from `space.sourcePath`; under a local root, the
    // full-fidelity readlink walk. null → genuinely-local / unclassifiable space, or
    // (under a cloud root) no usable cached cloud `sourcePath` → not a cloud space
    // here (skip; classifies `local`, keeps fs-checked behaviour — never a readlink
    // under a possibly-dead root).
    const verdictKey = mintCloudHopTargetCloudRootSafe({
      linkPath,
      sourcePath: space.sourcePath,
      rootIsCloud,
    });
    if (verdictKey === null) {
      // F4 (S1 review): under a cloud root with NO cached `sourcePath` we cannot key
      // this symlink space without a readlink that could hang on a dead mount — so it
      // is omitted from the containment map and its entries classify `local` (i.e. NOT
      // retention-gated). For the real-world case (`sourcePath` is persisted at scan
      // time) this branch is not hit and retention is fully preserved by the
      // sourcePath-derived key. Log the rare AMBIGUOUS case (missing sourcePath, could
      // still be a cloud space) so the retention-coverage gap is observable, not silent.
      // A present-but-non-cloud `sourcePath` is a genuinely LOCAL space → correctly
      // `local`, no log. There is no zero-I/O way to recover the canonical realpath
      // prefix here without the readlink we are deliberately avoiding.
      if (rootIsCloud && (space.sourcePath == null || space.sourcePath === '')) {
        log.debug(
          { spacePath: space.path },
          'cloud-space containment: symlink space under a cloud root has no cached sourcePath — omitted from containment (entries not retention-gated until a sourcePath is persisted)',
        );
      }
      continue;
    }

    const workspacePrefix = withTrailingSlash(normalizeForPrefix(linkPath));
    if (seenWorkspacePrefixes.has(workspacePrefix)) continue;
    seenWorkspacePrefixes.add(workspacePrefix);

    // Match BOTH forms (close the silent no-op): the workspace-symlink prefix AND
    // the resolved-cloud-realpath prefix the index actually STORES under. The
    // canonical prefix is derived FS-FREE from the first-cloud-hop target (the same
    // value `fs.realpath` of an entry under this symlink bottoms out below) and,
    // when present, the settings `sourcePath` (already the resolved cloud folder).
    // De-dupe within the space so an identical sourcePath/verdictKey isn't matched
    // twice. NO `realpath`/`stat`/`access` — pure string normalization.
    const matchPrefixes: string[] = [workspacePrefix];
    const seenMatchPrefixes = new Set<string>([workspacePrefix]);
    for (const canonical of [verdictKey as string, space.sourcePath]) {
      if (!canonical) continue;
      const canonicalPrefix = withTrailingSlash(normalizeForPrefix(canonical));
      if (seenMatchPrefixes.has(canonicalPrefix)) continue;
      seenMatchPrefixes.add(canonicalPrefix);
      matchPrefixes.push(canonicalPrefix);
    }

    roots.push({ matchPrefixes, verdictKey });
  }

  cloudSpaceRoots = roots;
  log.debug({ cloudSpaceCount: roots.length }, 'cloud-space containment map rebuilt');
}

/** Test-only: clear the cached map. */
export function __resetCloudSpaceContainmentForTests(): void {
  cloudSpaceRoots = [];
}

/**
 * Find the cloud space (if any) that CONTAINS `absolutePath` — pure string prefix
 * match on the cached normalized prefixes. An entry matches a space if it lives
 * under EITHER the workspace-symlink prefix OR the resolved-cloud-realpath
 * prefix(es) (both stored in `matchPrefixes`), so a canonical-realpath-form entry
 * (the dominant stored form) matches too. NO filesystem I/O.
 */
function findContainingCloudSpace(absolutePath: string): CloudSpaceRoot | null {
  if (cloudSpaceRoots.length === 0) return null;
  const normalizedEntry = normalizeForPrefix(absolutePath);
  for (const root of cloudSpaceRoots) {
    for (const prefix of root.matchPrefixes) {
      // `prefix` always carries a trailing slash (sibling-collision guard). Match a
      // path UNDER the space (`startsWith`) OR the space ROOT itself — the root has
      // no trailing slash after normalization, so `${root}/` === prefix identifies
      // it. Without the exact-root arm, an op ON the cloud root (e.g. the descent's
      // `readdir(cloudLink)` / `stat(cloudTarget)`) would classify `local` and reach
      // bare fs on a possibly-dead mount — the exact hang this boundary prevents
      // (S1 review F1).
      if (normalizedEntry.startsWith(prefix) || `${normalizedEntry}/` === prefix) {
        return root;
      }
    }
  }
  return null;
}

/**
 * R2 helper — is this absolute path under ANY cloud space? Pure string prefix
 * match, no verdict read, no I/O. The search path uses this to SKIP the
 * `fs.access` existence check (and retain the entry) for cloud entries.
 */
export function isUnderCloudSpace(absolutePath: string): boolean {
  return findContainingCloudSpace(absolutePath) !== null;
}

/**
 * R1/R6 — classify an absolute index-entry path for removal/search gating.
 *
 * Returns `'local'` when the path is not under any cloud space (caller keeps its
 * existing behaviour), otherwise `{ cloudSpaceRoot, verdict }` where `verdict` is
 * the synchronous cached cloud-liveness verdict for that space (`unknown` when no
 * verdict has been observed yet — fail-closed; callers treat `unknown`/`degraded`
 * the same as "do not purge / do not fs-check").
 *
 * SYNC + total: never blocks, never throws (the verdict read is the total
 * `getCachedVerdict`; the containment match is pure string work).
 */
export function classifyPathForRemoval(absolutePath: string): RemovalPathClassification {
  const containing = findContainingCloudSpace(absolutePath);
  if (containing === null) return 'local';
  const verdict = getCloudLivenessProbe().getCachedVerdict(containing.verdictKey);
  // `cloudSpaceRoot` is diagnostic only; report the workspace-symlink prefix
  // (always `matchPrefixes[0]`) as the stable space identity. `verdictKey` lets a
  // caller read freshness / force a re-probe (R5) under the SAME readlink-only key.
  return {
    cloudSpaceRoot: containing.matchPrefixes[0],
    verdict,
    verdictKey: containing.verdictKey,
  };
}

// ---------------------------------------------------------------------------
// R4 — proof-scoped purge: does an entry live under a PROVEN space root?
// ---------------------------------------------------------------------------

/**
 * R4 — true when `absolutePath` is under `provenSpaceRoot` (the `spaceRoot` of an
 * `AbsenceProof`). An `absence-authorized` purge is scoped to the one space the
 * proof's completed-healthy walk covered — a proof for space A must not authorize
 * purging an entry in space B. Pure string prefix match (same normalizer +
 * trailing-slash boundary as containment); NO filesystem I/O.
 */
export function isPathUnderProvenSpaceRoot(
  absolutePath: string,
  provenSpaceRoot: string,
): boolean {
  const prefix = withTrailingSlash(normalizeForPrefix(provenSpaceRoot));
  const normalizedEntry = normalizeForPrefix(absolutePath);
  // An entry exactly AT the root, or under it, both count as "within this space".
  return normalizedEntry === normalizeForPrefix(provenSpaceRoot) || normalizedEntry.startsWith(prefix);
}

// ---------------------------------------------------------------------------
// R5 — unlink-storm circuit breaker (per cloud space).
// ---------------------------------------------------------------------------

/**
 * R5 tuning. A dead cloud mount's mass-unmount emits a burst of spurious `unlink`
 * events. If ≥ `UNLINK_STORM_THRESHOLD` unlinks for ONE cloud space arrive within
 * `UNLINK_STORM_WINDOW_MS`, we trip the breaker: cloud removals for that space are
 * FROZEN (retained) for `UNLINK_STORM_FREEZE_MS`, and the caller re-probes so the
 * next removal needs a freshly-confirmed healthy verdict. A few isolated legit
 * unlinks (rename, single delete) never trip it.
 */
const UNLINK_STORM_THRESHOLD = 5;
const UNLINK_STORM_WINDOW_MS = 2_000;
const UNLINK_STORM_FREEZE_MS = 30_000;

interface UnlinkStormState {
  /** Recent unlink timestamps (ms), pruned to the window on each note. */
  recent: number[];
  /** When the breaker trips, cloud removals stay frozen until this time. */
  frozenUntil: number;
}

const unlinkStorms = new Map<string, UnlinkStormState>();

/** Result of recording an unlink: whether the breaker is tripped (and just-tripped). */
export interface UnlinkStormResult {
  /** Cloud removals for this space are frozen (retain). */
  readonly tripped: boolean;
  /** True only on the transition into tripped (so the caller logs/reprobes once). */
  readonly justTripped: boolean;
  /** Count of unlinks in the current window (diagnostic). */
  readonly count: number;
}

/**
 * R5 — record a cloud-space unlink and report whether the unlink-storm circuit
 * breaker is tripped. Call this EXACTLY ONCE per unlink event (at the enqueue /
 * metadata-store phase) so the sliding-window count isn't double-incremented by
 * the later vector-index phase of the same event — use {@link checkCloudUnlinkStorm}
 * (check-only, no record) for downstream phases. Pure in-memory sliding window
 * keyed by the diagnostic `cloudSpaceRoot` (one per space); NO filesystem I/O,
 * never throws. Non-cloud unlinks never reach here (the coordinator only calls this
 * for a classified cloud path), so local removals are completely unaffected.
 */
export function noteCloudUnlinkAndCheckStorm(cloudSpaceRoot: string): UnlinkStormResult {
  const now = Date.now();
  let state = unlinkStorms.get(cloudSpaceRoot);
  if (!state) {
    state = { recent: [], frozenUntil: 0 };
    unlinkStorms.set(cloudSpaceRoot, state);
  }

  // Still frozen from a prior storm → stay tripped (not just-tripped).
  if (now < state.frozenUntil) {
    return { tripped: true, justTripped: false, count: state.recent.length };
  }

  // Prune the window, then record this unlink.
  state.recent = state.recent.filter((t) => now - t < UNLINK_STORM_WINDOW_MS);
  state.recent.push(now);

  if (state.recent.length >= UNLINK_STORM_THRESHOLD) {
    state.frozenUntil = now + UNLINK_STORM_FREEZE_MS;
    return { tripped: true, justTripped: true, count: state.recent.length };
  }
  return { tripped: false, justTripped: false, count: state.recent.length };
}

/**
 * R5 — check whether the unlink-storm circuit breaker is currently tripped for a
 * space WITHOUT recording a new unlink. Used by the downstream (vector-index) phase
 * of a `watcher-unlink` removal whose enqueue phase already recorded the unlink, so
 * the same event isn't counted twice. Pure, never throws.
 */
export function checkCloudUnlinkStorm(cloudSpaceRoot: string): UnlinkStormResult {
  const state = unlinkStorms.get(cloudSpaceRoot);
  if (!state) return { tripped: false, justTripped: false, count: 0 };
  if (Date.now() < state.frozenUntil) {
    return { tripped: true, justTripped: false, count: state.recent.length };
  }
  return { tripped: false, justTripped: false, count: state.recent.length };
}

/** Test-only: clear the unlink-storm circuit-breaker state. */
export function __resetCloudUnlinkStormsForTests(): void {
  unlinkStorms.clear();
}
