/**
 * Native-teardown LIVENESS registry (Stage 1 of
 * docs/plans/260622_teardown-lifecycle-contract/PLAN.md).
 *
 * THE STRUCTURAL MISS THIS KILLS: a native-resource owner (an in-MAIN-process
 * holder of a native worker/TSFN/handle — ORT InferenceSession, LanceDB
 * connection, fsevents instance, a BLE central) can today be added to the
 * codebase and be COMPLETELY INVISIBLE to shutdown. Nothing structurally forces
 * a new owner to declare its existence, its execution surface, or its liveness.
 * That is exactly how moonshine ONNX (no disposal at all) and the file-index
 * LanceDB connection (`closeIndex` exists but is never called on desktop quit)
 * slipped through and became prime `Worker::JoinThread` quit-deadlock suspects
 * (Sentry REBEL-6AM). See `subagent_reports/260622_researcher.md`.
 *
 * THE MANIFEST/REGISTRY SPLIT:
 *   - The pure metadata (owner name + classification + owning file + note,
 *     ZERO heavy imports) lives in `nativeTeardownManifest.ts`. The CI guard
 *     (`scripts/check-native-teardown-coverage.ts`) consumes THAT, so it never
 *     drags a main-process service singleton into its import graph.
 *   - THIS module adds a synchronous `liveness` accessor on top of the manifest
 *     for the HANDLED owners only — those the durable quit-boundary snapshot
 *     (`nativeLivenessSnapshot.ts`) actually reads. A `liveness` accessor forces
 *     an import of the owning service's native graph, so we attach one ONLY
 *     where the snapshot needs it.
 *
 * KEY PRINCIPLE: `tracked-gap` owners that are NOT wired into shutdown and NOT
 * in the durable snapshot (noble-ble, local-stt-sherpa) are MANIFEST-ONLY —
 * they get NO liveness accessor here. That is what keeps their heavy/native
 * import graphs (e.g. physicalRecordingService → child_process.execFile) OUT of
 * the static import graph of everything that consumes this registry (the bug
 * that broke autoUpdateService's tests). Only owners the snapshot reads
 * (fsevents, the three LanceDB connections, moonshine, plus the multi-field
 * super-mcp/embedding shapes read directly by the snapshot) get an accessor.
 *
 * WHAT THIS IS — and is NOT:
 *   - It IS a LIVENESS accessor layer over the manifest: a SYNCHRONOUS
 *     `liveness` read per HANDLED owner (counts/bools only, never user content).
 *   - It is NOT a disposal runner. Disposal EXECUTION stays in the existing,
 *     hand-ordered `cleanupStatus` roster in `gracefulShutdown.ts`
 *     (`shutdownInternal`). Reusing that roster preserves the known teardown
 *     ordering (GPT design F7 / DA). This module changes NO runtime
 *     teardown/quit behaviour — it is pure metadata + liveness reads.
 *
 * Lives in `src/main/services/` (not core/shared) because the liveness
 * accessors it wires are main-process service singletons (plus one core
 * accessor it re-exports through here). The plain `liveness` VALUES are what
 * flow downstream — the registry object itself is not passed across processes.
 */

import { getConversationLanceLiveConnectionCount } from './conversationIndexService';
import { getEmbeddingLivenessSnapshot } from './embeddingService';
import { getFileLanceLiveConnectionCount } from './fileIndexService';
import { liveNativeInstanceCount } from './fseventsLeakGuard';
import { getMoonshineLiveSessionCount } from './moonshineTranscriber';
import {
  NATIVE_TEARDOWN_MANIFEST,
  type NativeTeardownManifestEntry,
} from './nativeTeardownManifest';
import { superMcpHttpManager } from './superMcpHttpManager';
import { getToolLanceLiveConnectionCount } from './toolIndexService';

export type { NativeTeardownClassification } from './nativeTeardownManifest';

/**
 * A native-resource owner's coverage/liveness contract entry: the pure manifest
 * fields PLUS an optional synchronous `liveness` accessor.
 *
 * `liveness` is SYNCHRONOUS and intended to be cheap and fail-open at the call
 * site (the snapshot wraps each read in its own try/catch). It returns a
 * `number` (a count of live handles), a `boolean` (alive/not), or `null`
 * (genuinely unknown). It must NEVER block or throw on the quit path by design.
 *
 * It is `undefined` for MANIFEST-ONLY owners — `tracked-gap` owners that are
 * not wired into shutdown and not in the durable snapshot (noble-ble,
 * local-stt-sherpa). Attaching one would force their owning service's native
 * import graph into every consumer of this registry; they need no live read.
 */
export interface NativeTeardownOwner extends NativeTeardownManifestEntry {
  /** Synchronous liveness read: count, bool, or null (unknown). Never blocks/throws by design. Absent for manifest-only owners. */
  readonly liveness?: () => number | boolean | null;
}

/**
 * Liveness accessors for the HANDLED owners only — those the durable
 * quit-boundary snapshot reads. Keyed by manifest owner name. Owners absent
 * from this map are manifest-only (no live accessor by design — see the module
 * header's KEY PRINCIPLE).
 */
const LIVENESS_ACCESSORS: Readonly<Record<string, (() => number | boolean | null) | undefined>> = {
  fsevents: () => liveNativeInstanceCount(),
  'conversation-lancedb': () => getConversationLanceLiveConnectionCount(),
  'tool-lancedb': () => getToolLanceLiveConnectionCount(),
  embedding: () => {
    // The heavy ORT/native threads live in the embedding UtilityProcess +
    // offscreen GPU window and die with their own process; only the in-main
    // bookkeeping handles matter. `workerAlive` is the representative flag.
    const e = getEmbeddingLivenessSnapshot();
    return e.workerAlive;
  },
  'super-mcp': () => {
    const state = superMcpHttpManager.getState();
    return state.isRunning;
  },
  'moonshine-onnx': () => getMoonshineLiveSessionCount(),
  'file-lancedb': () => getFileLanceLiveConnectionCount(),
};

/**
 * THE REGISTRY: the pure manifest, each entry augmented with a `liveness`
 * accessor IF it is a handled (snapshot-read) owner. Manifest-only owners
 * (noble-ble, local-stt-sherpa) carry `liveness: undefined`.
 *
 * Ordering mirrors the manifest (the researcher's inventory); it carries no
 * runtime meaning (disposal ordering lives in `gracefulShutdown.ts`).
 */
export const NATIVE_TEARDOWN_OWNERS: readonly NativeTeardownOwner[] = NATIVE_TEARDOWN_MANIFEST.map(
  (entry) => {
    const liveness = LIVENESS_ACCESSORS[entry.name];
    return liveness ? { ...entry, liveness } : { ...entry };
  },
);

/** Lookup by name (the snapshot resolves a handled owner to its liveness via this). */
export function getNativeTeardownOwner(name: string): NativeTeardownOwner | undefined {
  return NATIVE_TEARDOWN_OWNERS.find((o) => o.name === name);
}

/** All registered owner names. */
export function getNativeTeardownOwnerNames(): readonly string[] {
  return NATIVE_TEARDOWN_OWNERS.map((o) => o.name);
}
