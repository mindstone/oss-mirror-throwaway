/**
 * indexRemovalCoordinator — the ONE door through which an index entry is removed
 * from ALL THREE index stores (PLAN.md "Purge-Gating & Removal Design", R3/F4/F5;
 * Stage 4a).
 *
 * The three stores that together form a workspace file's "index presence" are:
 *  1. `sourceMetadataStore` (core, electron-store JSON) — `removeSource(path)`.
 *  2. `entityMetadataStore`  (main, electron-store JSON) — `removeEntity(path)`.
 *  3. the LanceDB vector index (via `fileIndexService`) — `removeFileFromIndex` /
 *     `removeFilesFromIndex` (also drops `file_vectors` + `file_neighbors` rows).
 *
 * Before this seam existed, removals were scattered: `queueFileRemove` mutated the
 * two metadata stores SYNCHRONOUSLY and then enqueued the LanceDB delete to run
 * LATER (a half-purge window where metadata is gone but vectors remain — R3/F5);
 * `cleanupStaleEntries` interleaved its own per-store deletes; the `.rebel` /
 * `.conflict` purges hit only LanceDB. Six sites, each re-deciding what to remove,
 * is exactly how the cloud-skip code shipped two regressions.
 *
 * Stage 4a is a PURE CENTRALIZE + CLASSIFY refactor: every removal now flows
 * through this coordinator carrying a typed {@link RemovalReason}, but the SET of
 * entries removed in every scenario is IDENTICAL to before. There is NO
 * retain-when-degraded gating here — that is Stage 4b, which will gate the
 * health-gateable reasons (`absence` / `watcher-unlink` / `hygiene`) on the
 * cloud-liveness verdict WITHOUT ever gating `replacement` (re-index must never be
 * blocked). The seam is shaped so 4b can add that gate in ONE place.
 *
 * Why a main-side service (not `src/core`): it orchestrates the two MAIN-side
 * stores (`entityMetadataStore`, `fileIndexService`) and the core one. The core
 * `sourceMetadataStore` remover is reached through the same barrel import the
 * watcher already uses, so no new boundary crossing is introduced.
 *
 * IMPORTANT — `replacement` (the re-index prior-row delete in
 * `fileIndexService.indexFileInternal`) is DELIBERATELY NOT routed through this
 * coordinator: that delete runs INSIDE `fileIndexService` already holding the
 * write lock and calls the `*Internal` (lock-free) variant. Routing it back out
 * through the public `removeFileFromIndex` (which re-acquires the lock) would
 * deadlock, and it is LanceDB-internal only (no metadata-store side). The typed
 * `replacement` reason still EXISTS so 4b's gate is structurally exempt for it by
 * construction; the only-door lint gate (scripts/check-index-removal-coordinator.ts)
 * exempts that one internal site for the same reason.
 */
import { logger } from '@core/logger';
import { toPortablePath } from '@core/utils/portablePath';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import path from 'node:path';
import type { AbsenceProof, RemovalReason } from '@core/services/cloudLivenessProbe.types';
import {
  classifyPathForRemoval,
  isPathUnderProvenSpaceRoot,
  noteCloudUnlinkAndCheckStorm,
  checkCloudUnlinkStorm,
  type RemovalPathClassification,
  type UnlinkStormResult,
} from '@core/services/cloudSpaceContainment';
import {
  getCloudLivenessProbe,
  type ReadlinkResolvedTarget,
} from '@core/services/cloudLivenessProbe';

/**
 * The reason a removal is flowing through the coordinator. This is EXACTLY the
 * Stage-1 strict {@link RemovalReason} — Stage 4c removed the loose 4a/4b
 * `{ absence; proof? }` alias so the by-construction guarantee is the public
 * contract (F2/R4): there is NO coordinator reason that expresses "purge an
 * absence with an optional/absent proof".
 *
 * The absence case is SPLIT into two kinds:
 *  - `absence-unverified` — carries NO proof. For a CLOUD path it can never
 *    authorize a purge (always RETAIN); a LOCAL path is purged as before. Every
 *    current call-site uses this kind — the proof PRODUCER (a completed-healthy
 *    per-space walk feeding `tryBuildAbsenceProof`) lands with admission in
 *    Stage 6/7. Until then every cloud-absence is unverified ⇒ retained.
 *  - `absence-authorized` — STRUCTURALLY requires a {@link AbsenceProof} (a
 *    `NonNullRealPath`-rooted, complete + healthy per-space walk). You CANNOT
 *    construct one without the proof ⇒ "purge a cloud absence without proof" is a
 *    COMPILE error. The gate additionally checks the purged path is under
 *    `proof.spaceRoot` (the proof scopes the purge to that one space).
 *
 * `replacement` / `hygiene` are never health-gated; `watcher-unlink` is gated by
 * R5 (fresh healthy verdict + unlink-storm circuit breaker).
 */
export type CoordinatorRemovalReason = RemovalReason;

// ---------------------------------------------------------------------------
// R1/R4/R5 — cloud-removal gate (Stage 4b retain-when-degraded, hardened in 4c).
//
// For the health-gateable reasons (`absence-*` / `watcher-unlink`), a removal of
// an entry under a cloud space is RETAINED (skipped) unless that space is proven
// safe to purge. `degraded` AND `unknown` always retain (fail-closed: never wipe
// the last-known index for a transiently-unreachable Drive, and never
// bare-`fs`-touch the mount on the main thread).
//
// 4c TIGHTENS the cloud-purge authority beyond "verdict happens to be healthy":
//  - `absence-unverified` (R4) — NO proof ⇒ a cloud entry is ALWAYS retained,
//    regardless of verdict. A bare `fs.realpath` ENOENT during a startup sweep is
//    NOT authoritative absence for a cloud space (the mount could be blipping). A
//    cloud absence purge requires `absence-authorized` (below) — which the proof
//    PRODUCER (Stage 6/7) supplies. Until then every cloud-absence retains.
//  - `absence-authorized` (R4) — carries a {@link AbsenceProof} that, by
//    construction, can only have been minted from a complete + HEALTHY +
//    non-null-root per-space walk. We additionally require the purged path to be
//    UNDER `proof.spaceRoot` (the proof scopes the purge to that space — a proof
//    for space A must not authorize purging space B).
//  - `watcher-unlink` (R5) — a live unlink under a cloud space requires a
//    FRESH-enough healthy verdict (not a stale-but-unexpired healthy cache that
//    predates a just-died mount) AND the unlink-storm circuit breaker must not be
//    tripped for that space (≥N unlinks in a short window ⇒ a dead mount's
//    mass-unmount; FREEZE cloud removals + re-probe before any further removal).
//
// What is NEVER gated (by construction):
//  - `replacement` — re-index deleting prior rows before rewrite; gating it would
//    block legitimate re-indexing (NOT an absence claim).
//  - `hygiene`    — pattern purges of Rebel-internal/conflict bookkeeping; these
//    match on already-stored entry paths (no mount fs-op) and remove
//    non-user-content. Allowed even when degraded (PLAN R3 + the Chief decision +
//    the Stage-4a deindexPluginReadme NOTE: a deactivated plugin's README is a
//    deactivation-policy cleanup, not an fs-absence claim).
//
// Local entries (not under any cloud space) are never gated — `classifyPathForRemoval`
// returns `'local'` and the removal proceeds exactly as before. SYNC + total: the
// containment match is pure cached string work; the verdict reads are the total
// `getCachedVerdict`/`getCachedVerdictDetail` (no I/O, never throw, never block).
// ---------------------------------------------------------------------------

/**
 * R5 freshness bound: a destructive cloud `watcher-unlink` removal requires the
 * healthy verdict to have been observed within this window. Healthy real-Drive
 * probes are sub-ms (spike F5), so a fresh verdict is cheap; the point is that a
 * 40s-old healthy cache that predates a mount death must NOT authorize wiping the
 * index. Outside this window the verdict is treated as STALE ⇒ retain + re-probe.
 */
const WATCHER_UNLINK_FRESHNESS_BOUND_MS = 5_000;

/**
 * Optional R5 re-probe hook: invoked when the unlink-storm circuit breaker trips or
 * a stale-healthy `watcher-unlink` is retained, to force a fresh off-thread verdict
 * before the next removal can purge. Wired in index.ts to the desktop probe's
 * `invalidateVerdict` (see {@link configureIndexRemovalReprobeHook}). Unset on
 * cloud/headless (no mounts → no storms) and in tests that don't wire it →
 * `kickReprobe` is a no-op.
 */
let reprobeHook: ((verdictKey: ReadlinkResolvedTarget) => void) | null = null;

/** Reasons whose removal is gated on the cloud-space health verdict. */
function isHealthGated(reason: CoordinatorRemovalReason): boolean {
  return (
    reason.kind === 'absence-unverified' ||
    reason.kind === 'absence-authorized' ||
    reason.kind === 'watcher-unlink'
  );
}

/**
 * Which phase of a removal is asking the gate. A `watcher-unlink` flows through
 * TWO coordinator calls for ONE event (metadata-store sync at enqueue, then the
 * vector-index delete later) — the storm sliding-window must be incremented by
 * EXACTLY ONE of them (GPT must-address: double-counting would trip the breaker on
 * half the real threshold and could split the retain decision between phases).
 *  - `record` — the FIRST phase (enqueue / metadata-store / combined entrypoints):
 *    records the unlink in the storm window.
 *  - `check`  — a downstream phase (the later vector-index delete) that must NOT
 *    re-record: it only honours an already-tripped freeze.
 */
type RemovalGatePhase = 'record' | 'check';

/**
 * True when a removal of `filePath` with `reason` must be RETAINED (skipped)
 * because the entry is under a cloud space that is not safe to purge right now.
 * Pure/sync; returns `false` for local paths and non-gated reasons (those proceed
 * exactly as before).
 */
function shouldRetainForDegradedCloud(
  filePath: string,
  reason: CoordinatorRemovalReason,
  phase: RemovalGatePhase = 'record',
): boolean {
  if (!isHealthGated(reason)) return false;
  const classification = classifyPathForRemoval(filePath);
  if (classification === 'local') return false; // local entries never gated

  switch (reason.kind) {
    case 'absence-unverified':
      // R4: a cloud absence WITHOUT proof can never purge — keep last-known index.
      return retainCloud(filePath, classification, 'absence-unverified (no proof)');
    case 'absence-authorized':
      return shouldRetainAuthorizedAbsence(filePath, classification, reason.proof);
    case 'watcher-unlink':
      return shouldRetainWatcherUnlink(filePath, classification, phase);
    case 'replacement':
    case 'hygiene':
      // Not health-gated (already filtered out by isHealthGated; listed for
      // switch exhaustiveness).
      return false;
  }
}

/** Log + return true (retain a cloud entry). Centralised so the log is uniform. */
function retainCloud(
  filePath: string,
  classification: Exclude<RemovalPathClassification, 'local'>,
  why: string,
): true {
  logger.debug(
    { verdict: classification.verdict, why },
    'indexRemovalCoordinator: retaining cloud entry — keep last-known index',
  );
  return true;
}

/**
 * R4 — an `absence-authorized` cloud purge proceeds ONLY when the proof scopes it
 * to the space being pruned. The proof already guarantees (by construction) a
 * complete + healthy + non-null-root walk, so we don't re-check the verdict here
 * (a proof IS the healthy-walk authority); we only confirm the SCOPE — a space-A
 * proof must not authorize purging space B.
 *
 * Scope is satisfied when EITHER (GPT path-form must-address — the entry can arrive
 * in symlink-form or resolved-cloud-realpath form, while `proof.spaceRoot` is a
 * realpath):
 *  - the entry path is under `proof.spaceRoot` (realpath-form entries — the
 *    dominant stored form); OR
 *  - the entry's containing cloud space (its readlink-only `verdictKey`, the
 *    canonical cloud-root the proof's walk rooted at) is itself under/equal to
 *    `proof.spaceRoot` — i.e. the entry belongs to the proven space even though its
 *    stored key is the workspace-symlink form.
 * Otherwise ⇒ retain.
 */
function shouldRetainAuthorizedAbsence(
  filePath: string,
  classification: Exclude<RemovalPathClassification, 'local'>,
  proof: AbsenceProof,
): boolean {
  // R4(f) health-epoch hysteresis (`proof.healthGeneration`) — "reject the prune if
  // a fresher degraded/error event for the space landed during the walk" — is wired
  // WITH the proof PRODUCER in Stage 6/7 (the producer is the only thing that knows
  // the per-space current generation; it's out of scope here). 4c carries the field
  // and, crucially, makes a no-proof cloud purge unrepresentable + retains every
  // cloud-absence until that producer exists, so nothing can purge prematurely now.
  const entryUnderProof = isPathUnderProvenSpaceRoot(filePath, proof.spaceRoot);
  const spaceIsProven = isPathUnderProvenSpaceRoot(classification.verdictKey, proof.spaceRoot);
  if (entryUnderProof || spaceIsProven) {
    return false; // proven absent in this (proven) space → purge proceeds
  }
  return retainCloud(filePath, classification, 'absence-authorized proof not scoped to this path');
}

/**
 * R5 — a cloud `watcher-unlink` removal requires (a) a FRESH healthy verdict and
 * (b) the unlink-storm circuit breaker not tripped for that space. A dead mount's
 * mass-unmount emits a storm of spurious `unlink` events that must NOT wipe the
 * index. On a storm we FREEZE (retain) and kick a re-probe so the next removal
 * needs a fresh healthy verdict.
 */
function shouldRetainWatcherUnlink(
  filePath: string,
  classification: Exclude<RemovalPathClassification, 'local'>,
  phase: RemovalGatePhase,
): boolean {
  // (1) Storm circuit breaker. RECORD this unlink in the per-space sliding window
  // exactly once (at the enqueue/metadata phase); the later vector phase only
  // CHECKS the freeze so one event isn't double-counted. A storm freezes cloud
  // removals + kicks a re-probe.
  const storm: UnlinkStormResult =
    phase === 'record'
      ? noteCloudUnlinkAndCheckStorm(classification.cloudSpaceRoot)
      : checkCloudUnlinkStorm(classification.cloudSpaceRoot);
  if (storm.tripped) {
    if (storm.justTripped) {
      logger.warn(
        { count: storm.count },
        'indexRemovalCoordinator: cloud unlink storm — freezing cloud removals + re-probing (keep index)',
      );
      kickReprobe(classification.verdictKey);
    }
    return retainCloud(filePath, classification, 'unlink-storm circuit breaker tripped');
  }

  // (2) Freshness: a destructive purge needs a FRESH healthy verdict, not a stale
  // (but unexpired) healthy cache that predates a mount death.
  const detail = getCloudLivenessProbe().getCachedVerdictDetail(classification.verdictKey);
  if (detail.verdict !== 'healthy') {
    return retainCloud(filePath, classification, `watcher-unlink verdict ${detail.verdict}`);
  }
  // Defensive: an impl that reports a non-finite/negative/over-bound age is NOT
  // trusted for a destructive op (fail closed → retain + re-probe). Only a finite,
  // in-bounds fresh healthy verdict authorizes the purge.
  const fresh =
    Number.isFinite(detail.ageMs) &&
    detail.ageMs >= 0 &&
    detail.ageMs <= WATCHER_UNLINK_FRESHNESS_BOUND_MS;
  if (!fresh) {
    // Stale / unreportable healthy → don't trust it; re-probe + retain.
    kickReprobe(classification.verdictKey);
    return retainCloud(filePath, classification, 'watcher-unlink healthy verdict not fresh');
  }
  return false; // fresh healthy + no storm → purge proceeds
}

/**
 * Kick an off-thread re-probe for a cloud space's verdict (best-effort): used by
 * the R5 storm/staleness paths so the next removal needs a freshly-confirmed
 * healthy verdict. Routed through the injected `reprobe` hook (wired in index.ts
 * to the desktop probe's `invalidateVerdict`; the core interface deliberately
 * doesn't expose `invalidateVerdict`, and cloud/headless has no mounts so the hook
 * is unset → no-op). Never throws.
 */
function kickReprobe(verdictKey: ReadlinkResolvedTarget): void {
  if (!reprobeHook) return;
  try {
    reprobeHook(verdictKey);
  } catch (err) {
    // best-effort re-probe — never let it break a removal decision.
    ignoreBestEffortCleanup(err, {
      operation: 'indexRemovalCoordinator.kickReprobe',
      reason: 're-probe hook threw; the removal decision must not depend on it',
      severity: 'debug',
    });
  }
}

// ---------------------------------------------------------------------------
// Remover seams — injected so the coordinator is unit-testable in isolation and
// so the main-side stores are not imported eagerly into core/test contexts. The
// defaults are wired at startup via configureIndexRemovalCoordinator(); when
// unwired (cloud/headless/tests that don't configure it) every remover is a no-op
// so the coordinator never throws on a hot path.
// ---------------------------------------------------------------------------

export interface IndexRemovalRemovers {
  /** Remove a path from the source-metadata store (matches portable/relative variants internally). */
  readonly removeSource: (filePath: string) => void;
  /** True when `filePath` is a source-metadata-tracked path under `workspacePath`. */
  readonly isSourcePath: (filePath: string, workspacePath: string) => boolean;
  /** Remove a path from the entity-metadata store (exact key). */
  readonly removeEntity: (filePath: string) => void;
  /** Remove a single path from the LanceDB vector index. */
  readonly removeFileFromIndex: (
    filePath: string,
    options?: { skipReadRefresh?: boolean },
  ) => Promise<void>;
  /** Batch-remove paths from the LanceDB vector index; returns count actually removed. */
  readonly removeFilesFromIndex: (
    filePaths: string[],
    options?: { skipReadRefresh?: boolean; skipOptimize?: boolean },
  ) => Promise<number>;
}

const NOOP_REMOVERS: IndexRemovalRemovers = {
  removeSource: () => {},
  isSourcePath: () => false,
  removeEntity: () => {},
  removeFileFromIndex: async () => {},
  removeFilesFromIndex: async () => 0,
};

let removers: IndexRemovalRemovers = NOOP_REMOVERS;

/**
 * Wire the real store removers (called once at desktop startup). Idempotent.
 */
export function configureIndexRemovalCoordinator(impl: IndexRemovalRemovers): void {
  removers = impl;
}

/**
 * Wire the R5 re-probe hook (called once at desktop startup, after the cloud
 * liveness probe is registered). Idempotent.
 */
export function configureIndexRemovalReprobeHook(
  hook: (verdictKey: ReadlinkResolvedTarget) => void,
): void {
  reprobeHook = hook;
}

/** Test-only: reset to the inert no-op removers + clear the reprobe hook. */
export function __resetIndexRemovalCoordinatorForTests(): void {
  removers = NOOP_REMOVERS;
  reprobeHook = null;
}

// ---------------------------------------------------------------------------
// Which stores a removal touches.
// ---------------------------------------------------------------------------

/**
 * Per-store selection for a removal. Stage 4a must preserve the EXACT per-store
 * selectivity each call-site had before (e.g. a `cleanupStaleEntries` branch that
 * removed only the entity entry, or the `.rebel` purge that touched only LanceDB).
 * Always-all would change WHICH entries get removed → a 4a behavior change.
 */
export interface RemovalStoreSelection {
  /** Touch the source-metadata store (guarded by `isSourcePath` like the call-sites). */
  readonly source: boolean;
  /** Touch the entity-metadata store. */
  readonly entity: boolean;
  /** Touch the LanceDB vector index. */
  readonly vectorIndex: boolean;
}

const ALL_STORES: RemovalStoreSelection = { source: true, entity: true, vectorIndex: true };

export interface RemoveEntryOptions {
  /** Workspace root — required to evaluate `isSourcePath` before a source removal. */
  readonly workspacePath?: string | null;
  /** Which stores to touch (defaults to all three). */
  readonly stores?: RemovalStoreSelection;
  /**
   * When removing from the source-metadata store, also remove the
   * portable-relative key variant. `queueFileRemove` did this (belt-and-suspenders
   * for entries keyed by the portable-relative path); `cleanupStaleEntries` did
   * NOT. Defaults to `false` so the extra removal is opt-in and behavior stays
   * call-site-identical. (Note: `removeSource` already matches relative/portable
   * variants internally, so this only affects an entry keyed LITERALLY by the
   * portable-relative string that the absolute-path call wouldn't otherwise match.)
   */
  readonly alsoRemoveSourcePortableRelative?: boolean;
  /** Forwarded to the LanceDB remover. */
  readonly skipReadRefresh?: boolean;
}

export interface RemoveEntriesOptions {
  readonly workspacePath?: string | null;
  readonly stores?: RemovalStoreSelection;
  /** Forwarded to the batch LanceDB remover. */
  readonly skipReadRefresh?: boolean;
  readonly skipOptimize?: boolean;
}

// ---------------------------------------------------------------------------
// Metadata-store removal (synchronous) — separated from the vector-index step so
// callers that keep an async queue between the two phases (the watcher) can route
// BOTH phases through the coordinator while preserving today's timing. This is the
// behavior-preserving interpretation of "decide once, apply to all three": the
// decision (reason + store selection) is made once; application is split only
// where the existing code already split it (sync metadata now, async vectors via
// the queue). The set of entries removed is identical.
// ---------------------------------------------------------------------------

/**
 * Remove `filePath` from the SYNCHRONOUS metadata stores (source + entity) per the
 * store selection. The LanceDB removal (async) is done separately via
 * {@link removeVectorIndexEntry} / {@link removeVectorIndexEntries} so an existing
 * async queue between the phases is preserved.
 *
 * @param reason — typed removal reason (carried for Stage 4b gating; not gated in 4a).
 */
export function removeMetadataStoresEntry(
  filePath: string,
  reason: CoordinatorRemovalReason,
  options: RemoveEntryOptions = {},
): void {
  // R1/R4/R5 — retain-when-degraded. This is the FIRST (enqueue) phase, so it
  // RECORDS a `watcher-unlink` into the storm window; the later vector phase only
  // checks the freeze (no double-count).
  if (shouldRetainForDegradedCloud(filePath, reason, 'record')) return;
  applyMetadataRemoval(filePath, reason, options);
}

/**
 * Apply the metadata-store removals UNGATED (the caller already decided to
 * proceed). Used both by the gated `removeMetadataStoresEntry` and by the combined
 * entrypoints, which gate ONCE per entry and then apply atomically across stores
 * (so a mid-batch storm-trip can't leave metadata removed but vectors retained —
 * GPT MA2 split-store fix).
 */
function applyMetadataRemoval(
  filePath: string,
  reason: CoordinatorRemovalReason,
  options: RemoveEntryOptions,
): void {
  const stores = options.stores ?? ALL_STORES;

  if (stores.source) {
    // Mirror the call-sites: a source removal is only attempted for a tracked
    // source path under the workspace (queueFileRemove/cleanupStaleEntries both
    // guard on isSourcePath before removeSource).
    if (options.workspacePath && removers.isSourcePath(filePath, options.workspacePath)) {
      removers.removeSource(filePath);
      if (options.alsoRemoveSourcePortableRelative) {
        // queueFileRemove also removed the portable-relative variant; preserve that
        // only where the original call-site did it (opt-in).
        removers.removeSource(toPortablePath(path.relative(options.workspacePath, filePath)));
      }
    }
  }

  if (stores.entity) {
    removers.removeEntity(filePath);
  }

  logger.debug({ reason: reason.kind }, 'indexRemovalCoordinator: metadata-store removal');
}

/**
 * Remove `filePath` from the LanceDB vector index (async). Paired with
 * {@link removeMetadataStoresEntry} for the watcher's metadata-now/vectors-later
 * shape. Most callers should prefer {@link removeIndexedEntry}, which does both.
 */
export async function removeVectorIndexEntry(
  filePath: string,
  reason: CoordinatorRemovalReason,
  options: { skipReadRefresh?: boolean } = {},
): Promise<void> {
  // R1/R4/R5 — retain-when-degraded. This is the DOWNSTREAM (vector) phase of a
  // removal whose metadata phase already RAN (queueFileRemove → processItem), so it
  // CHECKS the storm freeze without re-recording the unlink.
  if (shouldRetainForDegradedCloud(filePath, reason, 'check')) return;
  await removers.removeFileFromIndex(filePath, { skipReadRefresh: options.skipReadRefresh });
}

/**
 * Batch-remove from the LanceDB vector index (async). Returns count removed.
 *
 * R1 — retain-when-degraded: any path in the batch under a non-healthy cloud space
 * is filtered OUT and kept (per-path gating, so a batch spanning healthy + degraded
 * spaces removes only the safe ones). The returned count reflects what was actually
 * removed.
 */
export async function removeVectorIndexEntries(
  filePaths: string[],
  reason: CoordinatorRemovalReason,
  options: { skipReadRefresh?: boolean; skipOptimize?: boolean } = {},
): Promise<number> {
  // DOWNSTREAM (vector) phase — `check` so a `watcher-unlink` storm isn't
  // re-recorded per path (the metadata phase already recorded each event).
  const removable = isHealthGated(reason)
    ? filePaths.filter((p) => !shouldRetainForDegradedCloud(p, reason, 'check'))
    : filePaths;
  if (removable.length === 0) return 0;
  return removers.removeFilesFromIndex(removable, {
    skipReadRefresh: options.skipReadRefresh,
    skipOptimize: options.skipOptimize,
  });
}

// ---------------------------------------------------------------------------
// Combined entrypoints — decide once, apply to all selected stores. Used by
// call-sites that DON'T keep an async queue between the metadata and vector steps
// (cleanupStaleEntries, the hygiene purges). Fixes the half-purge ordering: a
// single coordinator call applies the metadata removal then the vector removal,
// so the two never drift apart across unrelated code phases (R3/F5).
// ---------------------------------------------------------------------------

/**
 * Remove a single entry from all selected stores (metadata first, then LanceDB).
 *
 * GATE ONCE (GPT MA2): the combined entrypoint evaluates the retain decision a
 * SINGLE time (the `record` phase) and then applies it ATOMICALLY across the
 * metadata + vector stores. This is the difference from the watcher's deliberately
 * split flow (metadata-now/vectors-later, two coordinator calls): here both stores
 * are in one logical removal, so re-gating the vector phase could let a storm trip
 * BETWEEN the metadata and vector steps and leave a split store.
 */
export async function removeIndexedEntry(
  filePath: string,
  reason: CoordinatorRemovalReason,
  options: RemoveEntryOptions = {},
): Promise<void> {
  if (shouldRetainForDegradedCloud(filePath, reason, 'record')) return;
  const stores = options.stores ?? ALL_STORES;
  applyMetadataRemoval(filePath, reason, options);
  if (stores.vectorIndex) {
    await removers.removeFileFromIndex(filePath, { skipReadRefresh: options.skipReadRefresh });
  }
}

/**
 * Remove a batch of entries from all selected stores. Metadata removals run
 * per-path (synchronous), then ONE batch LanceDB delete — matching
 * `cleanupStaleEntries`' phase shape (per-path metadata, single batch vector
 * delete) so behavior is identical.
 *
 * GATE ONCE per path (GPT MA2): each path's retain decision is taken a SINGLE time
 * (the `record` phase) up front; the surviving set is then applied atomically to
 * BOTH the metadata and vector stores — so a storm tripping mid-batch can't remove
 * an entry's metadata while retaining its vectors.
 *
 * @internal Currently exercised only by tests: this batch-removal entry point is part of
 * the S4 removal-coordinator surface that the retain-when-degraded design keeps available
 * ahead of its production caller (the per-path removal is the wired path today). Tagged so
 * knip's production leg does not flag it as a tested-only export; the default leg still
 * tracks it, so it stays visible until a production consumer lands or it is removed.
 */
export async function removeIndexedEntries(
  filePaths: string[],
  reason: CoordinatorRemovalReason,
  options: RemoveEntriesOptions = {},
): Promise<number> {
  const stores = options.stores ?? ALL_STORES;
  // One decision per path (record phase) → the set we will purge across ALL stores.
  const removable = isHealthGated(reason)
    ? filePaths.filter((p) => !shouldRetainForDegradedCloud(p, reason, 'record'))
    : filePaths;
  if (removable.length === 0) return 0;

  if (stores.source || stores.entity) {
    for (const filePath of removable) {
      applyMetadataRemoval(filePath, reason, {
        workspacePath: options.workspacePath,
        stores: { source: stores.source, entity: stores.entity, vectorIndex: false },
      });
    }
  }
  if (stores.vectorIndex) {
    return removers.removeFilesFromIndex(removable, {
      skipReadRefresh: options.skipReadRefresh,
      skipOptimize: options.skipOptimize,
    });
  }
  return 0;
}
