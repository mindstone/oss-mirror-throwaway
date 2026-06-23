/**
 * cloudLivenessProbe.types — by-construction safety types for the cloud-liveness
 * / removal-coordinator subsystem (PLAN.md RS-F9/F10).
 *
 * These branded types make two whole classes of bug UNREPRESENTABLE rather than
 * merely guarded-against:
 *
 *  1. `ReadlinkResolvedTarget` — a cache key / probe target that can ONLY be
 *     minted by a `readlinkSync`-only factory. Because the verdict cache and the
 *     containment predicate (later stages) require this brand, "I `realpath`'d a
 *     dead mount to get the cache key" becomes a compile error — the exact touch
 *     that re-parks the libuv pool (the 0.4.48→0.4.49 hang class) cannot reach
 *     the cache key by construction.
 *
 *  2. `AbsenceProof` (inside `RemovalReason`) — an `absence`-kind index removal
 *     STRUCTURALLY requires a non-null root + a complete + healthy per-space
 *     walk. The F1 purge hole (`rootRealPath: null` from a dangling root looks
 *     "complete-empty" and would wipe the whole index) becomes unrepresentable:
 *     you cannot construct an `absence` removal without first passing the
 *     smart-constructor that rejects null/incomplete/unhealthy walks.
 *
 * Stage 1 ships these types CONSUMABLE by later stages (Stage 4 coordinator,
 * Stage 6 descent) but wires them into NO consumer — inert by construction.
 *
 * Pure types + pure smart-constructors. No `electron` import; safe in
 * `src/core/`.
 */
import { isAbsolute } from 'node:path';
import {
  walkSymlinkChainViaReadlink,
  walkToFirstCloudHopViaReadlink,
} from '@core/utils/readlinkChain';
import { detectCloudStorage } from '@core/utils/cloudStorageUtils';

// ---------------------------------------------------------------------------
// ReadlinkResolvedTarget — branded, minted ONLY via readlink-only walking.
// ---------------------------------------------------------------------------

declare const readlinkResolvedTargetBrand: unique symbol;

/**
 * An absolute path that was resolved using `readlinkSync` ONLY — never
 * `realpath`/`stat`/`access`. The verdict cache and the cloud-space containment
 * predicate are keyed on this brand so a dead-mount-dereferencing path can never
 * become a cache key. Mint exclusively via {@link mintReadlinkResolvedTargetSync}.
 */
export type ReadlinkResolvedTarget = string & {
  readonly [readlinkResolvedTargetBrand]: true;
};

/**
 * Mint a {@link ReadlinkResolvedTarget} by walking the symlink chain at
 * `symlinkOrPath` with `readlinkSync` ONLY (never dereferences the target, so it
 * returns instantly even when the chain points into a dead cloud mount).
 *
 * - If the input is a symlink chain that bottoms out at a real path, returns the
 *   chain terminus as the branded target.
 * - If the input is not a symlink, returns the (absolute) input as the branded
 *   target (hops === 0).
 * - Returns `null` if the chain is broken (a hop threw anything but EINVAL —
 *   e.g. a dangling link or a dead mount) or exceeds the hop cap. `null` means
 *   "unclassifiable without touching the target" → callers fail closed
 *   (exclude + retain).
 *
 * Synchronous and hot-path-safe: the only I/O is `readlinkSync` on local link
 * inodes. NEVER calls `realpath`/`stat`/`access`.
 */
export function mintReadlinkResolvedTargetSync(
  symlinkOrPath: string,
): ReadlinkResolvedTarget | null {
  const result = walkSymlinkChainViaReadlink(symlinkOrPath);
  if (result.kind === 'terminus') {
    return result.path as ReadlinkResolvedTarget;
  }
  // broken / too-long → unclassifiable without dereferencing. Fail closed.
  return null;
}

/**
 * Mint a {@link ReadlinkResolvedTarget} by walking the symlink chain at
 * `symlinkPath` with `readlinkSync` ONLY, checking the cloud-storage pattern at
 * EVERY hop and STOPPING at the FIRST cloud-classified hop — returning that hop's
 * target as the probe target / verdict-cache key.
 *
 * This is the correct minter for cold-start prewarm of a cloud space reached via a
 * symlink chain. It follows an intermediate LOCAL alias
 * (`workspace/link → ~/DriveAlias → ~/Library/CloudStorage/GoogleDrive-…`) so the
 * chained-alias topology is NOT silently dropped (Stage-3 review F1). Unlike
 * {@link mintReadlinkResolvedTargetSync} (full chain to terminus), it STOPS at the
 * first cloud hop and NEVER `readlinkSync`s past it — once a hop is inside a dead
 * FUSE mount, even reading the next link inode (which lives in the mount's
 * directory) blocks in the kernel (the libuv-pool hang this whole plan exists to
 * kill). Returning the first cloud hop's target is exactly what the off-thread
 * prober wants to check.
 *
 * Because both prewarm and the (future Stage-6) descent mint the cache KEY via this
 * SAME helper, the prewarm-populated verdict is read back under a byte-identical
 * key by construction — closing the key-mismatch class.
 *
 * Returns `null` when the chain reaches a non-cloud local terminus (NOT a cloud
 * space → skip), or is unclassifiable without dereferencing (dangling link / dead
 * mount on the first hop / hop-cap exceeded → fail closed → skip).
 */
export function mintFirstCloudHopTargetSync(
  symlinkPath: string,
): ReadlinkResolvedTarget | null {
  const result = walkToFirstCloudHopViaReadlink(symlinkPath);
  if (result.kind === 'cloud') {
    return result.target as ReadlinkResolvedTarget;
  }
  // local-terminus (genuinely local space) / unclassifiable (fail closed) → not a
  // cloud prewarm target.
  return null;
}

/**
 * Mint a {@link ReadlinkResolvedTarget} from an ALREADY-RESOLVED cloud path the
 * caller obtained WITHOUT any filesystem touch (e.g. the settings-persisted
 * `space.sourcePath`, which is the raw `readlink` target captured at scan time).
 *
 * ZERO I/O — pure string ops only (`isAbsolute` + the pure-string
 * `detectCloudStorage` match). NEVER calls `readlinkSync`/`realpath`/`stat`/
 * `access`. This is the load-bearing property that lets cold-start prewarm derive
 * a probe target even when the workspace root is a (possibly dead) cloud FUSE
 * mount: the main thread reads an in-memory string, never the link/target inode.
 *
 * Returns `null` (fail closed → skip that space) unless `knownCloudPath` is a
 * non-empty ABSOLUTE path AND `detectCloudStorage` classifies it as cloud.
 *
 * KEY-EQUIVALENCE: for a DIRECT cloud symlink (`workspace/link → …/Shared
 * drives/General`), `space.sourcePath` is the raw `readlinkSync` target. When it
 * is absolute, {@link walkToFirstCloudHopViaReadlink} returns that same raw
 * target verbatim (`nextTarget = isAbsolute(rawTarget) ? rawTarget : …`) at the
 * first (and only) hop, so the branded key minted HERE is byte-identical to the
 * one {@link mintFirstCloudHopTargetSync} would mint from the live link. The
 * `isAbsolute` gate is what guarantees that equality: a RELATIVE `sourcePath`
 * would be resolved-against-parent by the walker but NOT here, so we refuse it
 * (return `null` → fall back to skip) rather than mint a non-equivalent key.
 */
export function mintCloudHopTargetFromKnownCloudPath(
  knownCloudPath: string,
): ReadlinkResolvedTarget | null {
  if (typeof knownCloudPath !== 'string' || knownCloudPath.length === 0) return null;
  if (!isAbsolute(knownCloudPath)) return null;
  if (!detectCloudStorage(knownCloudPath).isCloud) return null;
  return knownCloudPath as ReadlinkResolvedTarget;
}

/**
 * The SINGLE cloud-root-safe verdict-key source shared by every main-thread caller
 * that needs a cloud space's verdict-cache key (prewarm, containment, sync-status).
 *
 * The hazard it closes: a symlink space's link inode lives at
 * `coreDirectory/<space.path>`. When `coreDirectory` is itself a cloud-classified
 * FUSE mount that has gone dead, a `readlinkSync` on that link inode blocks the main
 * thread in the kernel (the libuv-pool hang this whole subsystem exists to kill) —
 * reading the link still has to traverse the dead mount's directory.
 *
 *  - `rootIsCloud === true`  → derive the key ZERO-I/O from the cached, already-
 *    resolved `sourcePath` via {@link mintCloudHopTargetFromKnownCloudPath} (a pure
 *    in-memory string read; never touches the link/target inode). Ineligible
 *    (missing / relative / non-cloud `sourcePath`) → `null` → caller skips that one
 *    space (never a readlink under a possibly-dead root). KEY-EQUIVALENCE with the
 *    live-link mint holds for a DIRECT absolute cloud symlink (see
 *    {@link mintCloudHopTargetFromKnownCloudPath}).
 *  - `rootIsCloud === false` → the root is a LIVE local dir, so reading link inodes
 *    never blocks: use the full-fidelity {@link mintFirstCloudHopTargetSync}
 *    (follows an intermediate LOCAL alias, stops at the first cloud hop). This is the
 *    only path that covers a chained-local-alias topology.
 *
 * `null` (fail closed → skip) when unclassifiable on either path. SYNC + total.
 */
export function mintCloudHopTargetCloudRootSafe(args: {
  readonly linkPath: string;
  readonly sourcePath: string | null | undefined;
  readonly rootIsCloud: boolean;
}): ReadlinkResolvedTarget | null {
  if (args.rootIsCloud) {
    return typeof args.sourcePath === 'string'
      ? mintCloudHopTargetFromKnownCloudPath(args.sourcePath)
      : null;
  }
  return mintFirstCloudHopTargetSync(args.linkPath);
}

// ---------------------------------------------------------------------------
// NonNullRealPath — branded non-null/non-empty path string.
// ---------------------------------------------------------------------------

declare const nonNullRealPathBrand: unique symbol;

/**
 * A realpath string proven non-null and non-empty. Used as the root anchor of an
 * {@link AbsenceProof}: a dangling/missing root yields `rootRealPath: null` from
 * `safeWalkDirectory`, and that null is exactly the F1 purge hole — so the
 * `absence` removal variant requires this brand, making "purge against a null
 * root" a compile error. Mint via {@link toNonNullRealPath}.
 */
export type NonNullRealPath = string & {
  readonly [nonNullRealPathBrand]: true;
};

/**
 * Smart-constructor for {@link NonNullRealPath}. Rejects null/undefined and
 * empty/whitespace-only strings; returns `null` otherwise (callers fail closed).
 * Does NOT touch the filesystem — it only certifies that a realpath the caller
 * already obtained (e.g. `SafeWalkResult.rootRealPath`) is genuinely non-null.
 */
export function toNonNullRealPath(value: string | null | undefined): NonNullRealPath | null {
  if (typeof value !== 'string') return null;
  if (value.trim().length === 0) return null;
  return value as NonNullRealPath;
}

// ---------------------------------------------------------------------------
// RemovalReason — typed index-removal reasons; `absence` requires an AbsenceProof.
// ---------------------------------------------------------------------------

/**
 * Structural proof that an index entry may be removed as `absence`: a COMPLETED,
 * HEALTHY, per-space walk rooted at a NON-NULL realpath. The point is that an
 * `absence` removal cannot be CONSTRUCTED without all of these holding — which
 * makes the F1 `rootRealPath: null` purge hole (and "I pruned on a partial /
 * degraded walk") unrepresentable. Build only via {@link tryBuildAbsenceProof}.
 *
 * Note: the literal `isComplete: true` / `verdict: 'healthy'` discriminants mean
 * a value of any other shape simply isn't assignable to `AbsenceProof`.
 */
export interface AbsenceProof {
  /** The space root being pruned, as a non-null realpath. */
  readonly spaceRoot: NonNullRealPath;
  /** The realpath the authoritative walk actually rooted at (must match `spaceRoot`). */
  readonly walkRootRealPath: NonNullRealPath;
  /** The walk ran to completion (no truncation / abort / cloud-skip). */
  readonly isComplete: true;
  /** The space verdict at walk time was healthy. */
  readonly verdict: 'healthy';
  /** Health epoch recorded at walk start; the coordinator rejects the prune if a fresher degraded/error event landed (R4 hysteresis). */
  readonly healthGeneration: number;
}

/**
 * Typed reason an index entry is being removed. The absence case is SPLIT into two
 * kinds so a cloud `absence` purge cannot be expressed without a proof — F2/R4
 * by-construction (Stage 4c). The others are removals that do NOT depend on an
 * fs-absence claim:
 *
 *  - `replacement`        — re-index deleting prior rows before rewrite. NOT
 *    health-gated (legitimate, not absence).
 *  - `absence-unverified` — a file looked absent but WITHOUT an authoritative
 *    completed-healthy walk to back the claim (e.g. a startup `fs.realpath`
 *    ENOENT). Carries NO proof, so it can NEVER authorize a cloud purge: a cloud
 *    entry under this reason is RETAINED (the proof PRODUCER lands with admission
 *    in Stage 6/7 — until then every cloud-absence is `unverified` ⇒ retained).
 *    A LOCAL entry is unaffected (purged as before).
 *  - `absence-authorized` — a file proven absent by a COMPLETE + HEALTHY +
 *    non-null-root per-space walk (R4). STRUCTURALLY requires the
 *    {@link AbsenceProof}, so "purge a cloud absence without proof" is a COMPILE
 *    error. The `proof.spaceRoot` (a {@link NonNullRealPath}) scopes the purge to
 *    that space.
 *  - `watcher-unlink`     — a live FS unlink event. Health-gated at the coordinator
 *    (fresh healthy verdict + unlink-storm circuit breaker, R5).
 *  - `hygiene`            — pattern purges of Rebel-internal/conflict bookkeeping.
 *    Match on already-stored entry paths; MUST NOT introduce a cloud fs-op (R3).
 */
export type RemovalReason =
  | { readonly kind: 'replacement' }
  | { readonly kind: 'absence-unverified' }
  | { readonly kind: 'absence-authorized'; readonly proof: AbsenceProof }
  | { readonly kind: 'watcher-unlink' }
  | { readonly kind: 'hygiene' };

/**
 * Inputs to {@link tryBuildAbsenceProof}. Modelled on the relevant fields of a
 * `safeWalkDirectory` `SafeWalkResult` plus the per-space verdict/epoch, but kept
 * structurally decoupled so this types module has no walker dependency. `verdict`
 * accepts the full health union so callers can pass a raw verdict; the
 * constructor admits ONLY `'healthy'`.
 */
export interface AbsenceProofInput {
  /** Space root being pruned (raw realpath; may be null if the root could not be resolved). */
  readonly spaceRoot: string | null | undefined;
  /** The realpath the walk rooted at (`SafeWalkResult.rootRealPath`; null if unresolved → F1 hole). */
  readonly walkRootRealPath: string | null | undefined;
  /** Whether the walk ran to completion (`isSafeWalkComplete(result)`). */
  readonly isComplete: boolean;
  /** Per-space health verdict at walk time. */
  readonly verdict: 'healthy' | 'degraded' | 'unknown';
  /** Health epoch recorded at walk start (R4). */
  readonly healthGeneration: number;
}

/**
 * Smart-constructor for {@link AbsenceProof}. Returns `null` (no proof → do not
 * purge) unless ALL hold:
 *  - `spaceRoot` is non-null/non-empty;
 *  - `walkRootRealPath` is non-null/non-empty;
 *  - the walked root MATCHES the space root being pruned;
 *  - the walk is complete;
 *  - the verdict is `healthy`.
 *
 * `null` is the safe answer: it means "cannot prove absence → RETAIN" (the
 * locked keep-old-results intent). Does no filesystem I/O.
 */
export function tryBuildAbsenceProof(input: AbsenceProofInput): AbsenceProof | null {
  if (input.verdict !== 'healthy') return null;
  if (!input.isComplete) return null;

  const spaceRoot = toNonNullRealPath(input.spaceRoot);
  if (spaceRoot === null) return null;

  const walkRootRealPath = toNonNullRealPath(input.walkRootRealPath);
  if (walkRootRealPath === null) return null;

  // The walk must have rooted at the same space we're pruning (R4(e)) — a
  // workspace-global walk must not authorise a per-space purge.
  if (walkRootRealPath !== spaceRoot) return null;

  return {
    spaceRoot,
    walkRootRealPath,
    isComplete: true,
    verdict: 'healthy',
    healthGeneration: input.healthGeneration,
  };
}
