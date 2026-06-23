/**
 * Native-resource liveness snapshot, captured in-process at the macOS
 * quit-deadlock boundary (Stage 1 of
 * docs/plans/260622_pin-quit-deadlock-blocker/PLAN.md).
 *
 * THE PROBLEM: the residual macOS update-quit HANG (Sentry REBEL-6AM
 * `mac_tier2`; Electron-≥42) is a native env-teardown deadlock — `FreeEnvironment`
 * → N-API finalizers → `Worker::JoinThread` waits forever on some native
 * worker/thread/handle that never finishes. The hang is BELOW JS, so a JS
 * "which shutdown step hung" probe cannot see it. But we CAN take a cheap,
 * SYNCHRONOUS count of every in-MAIN-process native-resource holder *just
 * before* the Tier-2 force-exit fires. Correlated across many crashes, that
 * count NAMES the probable blocking native subsystem (fsevents / moonshine ORT
 * / LanceDB / super-mcp / embedding) instead of leaving it unpinned.
 *
 * This is a COUNT, not a stack: it says *which native subsystems still hold
 * resources*, not which call is wedged. It is a probabilistic pin, not a proof
 * of causation for any single event.
 *
 * CONTRACT (load-bearing):
 *   - SYNCHRONOUS and FAIL-OPEN. Each field is read inside its own try/catch; a
 *     throwing accessor contributes `null` for that field and never aborts the
 *     read. This snapshot must NEVER throw, block, or add latency to the quit
 *     path — capturing it must always be strictly safer than not.
 *   - Counts/bools only. No user content ever enters the snapshot.
 *
 * Lives in `src/main/services/` (not core/shared) because it imports
 * main-process service singletons. The plain snapshot OBJECT is passed down to
 * `quitDeadlockTelemetry`/core — the accessors are not.
 *
 * SINGLE SOURCE OF TRUTH: the per-owner liveness reads are NOT hand-rolled here
 * anymore — they come from `nativeTeardownRegistry.ts` (the coverage/liveness
 * manifest). This snapshot reads each owner's liveness via the registry, so the
 * "what native owners exist + their liveness" list cannot drift between the
 * shutdown-coverage contract and the quit-boundary snapshot. The count/bool
 * owners (fsevents, moonshine, the three LanceDB connections) are read straight
 * from the registry; super-mcp and embedding additionally expose richer
 * multi-field shapes the registry's single representative liveness doesn't
 * carry, so those two read their service accessor directly (the registry models
 * the same owner with one representative flag).
 */

import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { getEmbeddingLivenessSnapshot } from './embeddingService';
import {
  getNativeTeardownOwner,
  type NativeTeardownOwner,
} from './nativeTeardownRegistry';
import { superMcpHttpManager } from './superMcpHttpManager';

/**
 * Per-service open LanceDB connection counts. Each sub-field is `null` if its
 * accessor threw (fail-open). LanceDB is a native Rust addon holding connection
 * handles + an async runtime — a strong teardown-thread suspect.
 */
export interface LancedbConnectionCounts {
  /** Conversation index: 0 or 1. */
  conversation: number | null;
  /** File index: 0 or 2 (separate write + read connections). */
  file: number | null;
  /** Tool index: 0 or 1. */
  tool: number | null;
}

/** In-MAIN-process embedding backend liveness flags (out-of-process holders → weak suspects). */
export interface EmbeddingLivenessFlags {
  workerAlive: boolean | null;
  gpuBackendAlive: boolean | null;
  disposed: boolean | null;
}

/**
 * A snapshot of which in-MAIN-process native-resource holders are still live.
 * Every field is independently fail-open: `null` means "the accessor threw",
 * NOT "zero/absent" — those are distinct signals.
 */
export interface NativeLivenessSnapshot {
  /** fsevents native instances started-but-not-stopped. The KNOWN deadlock culprit; nonzero confirms the leak class. */
  fseventsLiveInstances: number | null;
  /** moonshine onnxruntime InferenceSessions in MAIN (0 or 2). Prime `Worker::JoinThread` suspect; bounded disposer on the normal-quit roster as of Stage 4. */
  moonshineSessions: number | null;
  /** super-mcp child pid (OS child, not an in-main thread). A live pid means graceful stop did not complete. */
  superMcpPid: number | null;
  /** Whether the super-mcp child is still running. */
  superMcpRunning: boolean | null;
  /** Per-index open LanceDB connection counts. */
  lancedbConnections: LancedbConnectionCounts;
  /** In-main embedding backend flags (low value — heavy holders are out-of-process). */
  embedding: EmbeddingLivenessFlags;
}

/**
 * Read one snapshot field, fail-open. Any throw → `fallback` (typically `null`)
 * with an observable best-effort-cleanup log, never propagating onto the quit
 * path. `_field` is a call-site label for readability only (it can't ride in
 * the string-literal `operation`/`reason` the no-silent-swallow rule requires).
 */
function safeRead<T>(_field: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch (err) {
    // FAIL-OPEN: a thrown accessor contributes `fallback` (null) for its field
    // — never aborts the read or the quit/force-exit path. The `operation` and
    // `reason` must be string LITERALS (no-silent-swallow rule) so the dynamic
    // `field` cannot go there; it isn't needed for triage anyway, because the
    // snapshot field that lands as `null` (vs a real 0) names the failed read.
    ignoreBestEffortCleanup(err, {
      operation: 'captureNativeLivenessSnapshot.safeRead',
      reason:
        'Native-liveness snapshot is best-effort quit-boundary telemetry; a failed accessor read must contribute null for its field and never throw, block, or delay the quit/force-exit path',
    });
    return fallback;
  }
}

/**
 * Read a registered owner's liveness as a numeric count, fail-open. Resolves
 * the owner from the registry by name (the single source of truth), reads its
 * synchronous `liveness`, and coerces to `number | null`:
 *   - a `number` count is returned as-is;
 *   - `null` (accessor said "unknown") stays `null`;
 *   - a missing registry entry stays `null` (a real configuration drift, never
 *     a silent zero — distinct from a genuine 0 count);
 *   - an owner with NO liveness accessor (a manifest-only `tracked-gap` the
 *     snapshot is not meant to read) stays `null` — the snapshot only reads
 *     handled owners, so this too is real drift, never a silent 0;
 *   - any throw is contained by `safeRead` → `null`.
 * A `boolean` liveness is not expected for the count-typed owners read here; it
 * would coerce to `null` rather than be silently mapped to 0/1.
 */
function readOwnerCount(field: string, name: string): number | null {
  return safeRead<number | null>(
    field,
    () => {
      const owner: NativeTeardownOwner | undefined = getNativeTeardownOwner(name);
      if (!owner?.liveness) {
        // Registry/snapshot drift: an owner this snapshot expects is no longer
        // registered, or it is manifest-only (no live accessor). Surface it as
        // `null` (unknown), never a silent 0.
        return null;
      }
      const value = owner.liveness();
      return typeof value === 'number' ? value : null;
    },
    null,
  );
}

/**
 * Capture a synchronous, fail-open native-resource liveness snapshot. Safe to
 * call inline on the macOS Tier-1/Tier-2 quit-deadlock exit path BEFORE
 * `emitQuitDeadlockDetected` and BEFORE the fsevents sweep (the sweep clears
 * the fsevents live set — read it first).
 *
 * Per-owner liveness comes from `nativeTeardownRegistry` (single source of
 * truth); the multi-field super-mcp/embedding shapes are read directly because
 * the registry carries only one representative liveness per owner.
 */
export function captureNativeLivenessSnapshot(): NativeLivenessSnapshot {
  const superMcp = safeRead<{ running: boolean | null; pid: number | null }>(
    'superMcp',
    () => {
      const state = superMcpHttpManager.getState();
      return { running: state.isRunning, pid: state.process?.pid ?? null };
    },
    { running: null, pid: null },
  );

  const embedding = safeRead<EmbeddingLivenessFlags>(
    'embedding',
    () => {
      const e = getEmbeddingLivenessSnapshot();
      return { workerAlive: e.workerAlive, gpuBackendAlive: e.gpuBackendAlive, disposed: e.disposed };
    },
    { workerAlive: null, gpuBackendAlive: null, disposed: null },
  );

  return {
    fseventsLiveInstances: readOwnerCount('fseventsLiveInstances', 'fsevents'),
    moonshineSessions: readOwnerCount('moonshineSessions', 'moonshine-onnx'),
    superMcpPid: superMcp.pid,
    superMcpRunning: superMcp.running,
    lancedbConnections: {
      conversation: readOwnerCount('lancedb.conversation', 'conversation-lancedb'),
      file: readOwnerCount('lancedb.file', 'file-lancedb'),
      tool: readOwnerCount('lancedb.tool', 'tool-lancedb'),
    },
    embedding,
  };
}
