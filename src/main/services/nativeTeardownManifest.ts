/**
 * PURE native-teardown MANIFEST (Stage 1 of
 * docs/plans/260622_teardown-lifecycle-contract/PLAN.md).
 *
 * THE SPLIT (GPT review F1 + the gate-blocker): this module is the pure,
 * IMPORT-LIGHT metadata half of the native-teardown contract — owner name,
 * shutdown classification, owning source file, and a human note, with ZERO
 * heavy/native imports. It deliberately holds NO `liveness` accessors, because
 * a liveness accessor forces an import of the owning service singleton (and
 * thus that service's whole native graph) — exactly the dependency that broke
 * the build (`nativeTeardownRegistry` eagerly pulling
 * `physicalRecordingService` → `child_process.execFile` into the static import
 * graph of `autoUpdateService`'s tests).
 *
 * TWO CONSUMERS, ONE TRUTH:
 *   - `scripts/check-native-teardown-coverage.ts` (the CI guard) imports THIS
 *     module ONLY, so the guard can validate covered-file → owner-name mappings
 *     against the real manifest without dragging any main-process service
 *     singleton (or its native deps) into the guard's import graph.
 *   - `src/main/services/nativeTeardownRegistry.ts` builds on this manifest,
 *     attaching a synchronous `liveness` accessor for the HANDLED owners (those
 *     in the durable quit-boundary snapshot). `tracked-gap` owners are
 *     manifest-only by design — they are NOT wired into shutdown and NOT in the
 *     snapshot, so they need NO live accessor (which is what kept noble-ble's
 *     native graph out of the build).
 *
 * KEY PRINCIPLE: tracked-gap owners are manifest-only (for the guard); only
 * HANDLED owners (those the snapshot reads) need a liveness accessor in the
 * registry.
 */

/**
 * How a native-resource owner relates to the quit/update teardown contract.
 *
 * - `main-owner`: holds a native worker/TSFN/handle IN the main process. A
 *   nonzero liveness at env teardown can hang `FreeEnvironment → Worker::JoinThread`.
 *   These MUST have a bounded disposer on the shutdown roster (execution lives
 *   in `gracefulShutdown.ts`, not here) — or be a `tracked-gap` below.
 * - `out-of-process-child`: the heavy native resource lives in a SEPARATE OS
 *   process (a `utilityProcess` worker / offscreen window / detached child).
 *   It dies with its own process and cannot block the parent's env teardown; a
 *   live liveness count is a symptom (graceful stop did not finish), not a
 *   parent-teardown blocker.
 * - `stateless-transient`: opens a native handle for the duration of one
 *   bounded call and closes it before returning. No persistent in-main holder.
 * - `tracked-gap`: a real `main-owner` that has NO bounded disposer on the quit
 *   path yet. This is the honest record of a known gap (moonshine, file-index,
 *   noble-ble) — closing it is a later, checkpoint-gated stage (PLAN.md Stage
 *   4). The external watchdog (`buildWatchdogScript`) is the floor that
 *   contains it until then. Tracked-gap owners are MANIFEST-ONLY: not wired
 *   into shutdown, not in the durable snapshot, so they carry no live accessor.
 */
export type NativeTeardownClassification =
  | 'main-owner'
  | 'out-of-process-child'
  | 'stateless-transient'
  | 'tracked-gap';

/**
 * One native-resource owner's PURE manifest entry: identity + classification +
 * owning source file + note. NO liveness accessor (that lives in the registry
 * for handled owners only) and NO heavy imports.
 */
export interface NativeTeardownManifestEntry {
  /** Stable identifier (matches the snapshot field / the CI guard's registry key). */
  readonly name: string;
  /** Relationship to the teardown contract (drives both the snapshot and the guard). */
  readonly classification: NativeTeardownClassification;
  /**
   * Repo-relative posix path of the source file that OWNS this native resource
   * (the file the CI guard's signature matches). Used to cross-check the
   * guard's covered-file → owner-name mapping against this manifest.
   */
  readonly file: string;
  /** Human note — gaps point at the closing stage; out-of-process notes record WHY it can't hang the parent. */
  readonly note?: string;
}

/**
 * THE MANIFEST. Every in-MAIN-process native-resource owner the researcher
 * inventoried (`subagent_reports/260622_researcher.md` §1). The CI guard
 * (`scripts/check-native-teardown-coverage.ts`) validates that every file
 * matching a native-owner signature maps to one of these entries (or an
 * explicit EXEMPT) AND that every covered-file's named owner exists here, so a
 * new owner cannot be added invisibly and a typo'd/deleted owner name cannot
 * pass green.
 *
 * Ordering mirrors the researcher's inventory; it carries no runtime meaning
 * (disposal ordering lives in `gracefulShutdown.ts`).
 */
export const NATIVE_TEARDOWN_MANIFEST: readonly NativeTeardownManifestEntry[] = [
  {
    name: 'fsevents',
    classification: 'main-owner',
    file: 'src/main/services/fseventsLeakGuard.ts',
    note:
      'chokidar darwin watcher backend, tracked + bounded-swept by fseventsLeakGuard/finalExit. ' +
      'The reference implementation of this whole contract — HANDLED.',
  },
  {
    name: 'conversation-lancedb',
    classification: 'main-owner',
    file: 'src/main/services/conversationIndexService.ts',
    note: 'LanceDB conversation index connection. Bounded close on the shutdown roster (closeConversationIndex).',
  },
  {
    name: 'tool-lancedb',
    classification: 'main-owner',
    file: 'src/core/services/toolIndex/toolIndexService.ts',
    note: 'LanceDB tool index connection (owner is src/core/services/toolIndex). Bounded close on the roster (closeToolIndex).',
  },
  {
    name: 'embedding',
    classification: 'out-of-process-child',
    file: 'src/main/services/embeddingService.ts',
    note:
      'CPU UtilityProcess + offscreen GPU BrowserWindow — heavy native holders are OUT of the main process ' +
      'and die with their own process, so they cannot block parent env teardown. Disposed via disposeEmbeddingService (roster).',
  },
  {
    name: 'super-mcp',
    classification: 'out-of-process-child',
    file: 'src/main/services/superMcpHttpManager.ts',
    note:
      'Spawned detached + unref()ed, so it is an OS child not an in-main thread; killed via killProcessTree (SIGKILL ' +
      'process-group). A live pid is a symptom (graceful stop did not finish), not an env-teardown blocker.',
  },
  {
    name: 'moonshine-onnx',
    classification: 'main-owner',
    file: 'src/main/services/moonshineTranscriber.ts',
    note:
      'HANDLED (PLAN.md Stage 4): 2 in-MAIN ORT InferenceSessions, a prime Worker::JoinThread quit-deadlock suspect ' +
      '(REBEL-6AM). State-based, restartable disposer moonshineTranscriber.dispose() is on the shutdownInternal() ' +
      'roster (gracefulShutdown.ts, service "moonshine"), which runs on the normal-quit path AND on restartable ' +
      'services-only paths (workspace rename): InferenceSession.release() joins each per-session threadpool early. ' +
      'Guards: await an in-flight load; an admission gate (transient "disposing" flag) blocks new loads/runs while a ' +
      'dispose is in flight; wait (bounded ~2s) for the FULL session-use window (acquisition→generate complete), not ' +
      'just generate(); null-check guards double-release (no permanent terminal flag — modelState reloads cleanly on ' +
      'a later request); fail open. BOUNDING (Stage-4 review F3): InferenceSession.release() runs the native dispose ' +
      'SYNCHRONOUSLY before the await yields, so a wedged native thread-join is NOT bounded by the per-service ' +
      'Promise.race in cleanupService — the EXTERNAL WATCHDOG is the real floor for that case. The in-flight-use wait ' +
      'and await-load steps are roster-bounded; the synchronous native release is watchdog-bounded.',
  },
  {
    name: 'file-lancedb',
    classification: 'main-owner',
    file: 'src/main/services/fileIndexService/index.ts',
    note:
      'HANDLED (PLAN.md Stage 4): file-index LanceDB connections (read+write). closeIndex() (write-lock + <=3s ' +
      'optimize-drain + read-drain, self-bounded) is now on the normal-quit roster (gracefulShutdown.ts, service ' +
      '"fileIndex") in addition to headlessRuntime, bounded by the per-service budget (Promise.race in cleanupService).',
  },
  {
    name: 'noble-ble',
    classification: 'tracked-gap',
    file: 'src/main/services/physicalRecording/physicalRecordingService.ts',
    note:
      'TRACKED GAP: @stoprocent/noble BLE central (physicalRecordingService). Opens an in-MAIN OS BLE handle ' +
      'while scanning/connected and is NOT on the shutdown roster — surfaced here so it is no longer invisible. ' +
      'MANIFEST-ONLY: not wired into shutdown and not in the durable snapshot, so it carries NO liveness accessor ' +
      '(a live accessor would force physicalRecordingService — and its child_process.execFile transcription graph — ' +
      'into the static import graph of everything that consumes the teardown registry). ' +
      'Lower suspicion than moonshine/file-index (idle-disconnected by default, user-initiated); bounded teardown is ' +
      'a later checkpoint stage.',
  },
  {
    name: 'local-stt-sherpa',
    classification: 'tracked-gap',
    file: 'src/main/services/localSttService.ts',
    note:
      'TRACKED GAP: sherpa-onnx-node OfflineRecognizer (ONNX Runtime native threads, numThreads:4) created IN the ' +
      'MAIN process on Windows per transcription (transcribeWithSherpaOnnx). The recognizer + stream are allocated ' +
      'per call and left to GC — there is NO explicit release()/free()/dispose() call and no bounded teardown, so a ' +
      'recognizer whose native threads have not been reclaimed at env teardown is a Worker::JoinThread suspect like ' +
      'moonshine. Classified tracked-gap (NOT stateless-transient — transient requires a bounded close-before-return, ' +
      'which this path does not do). NOT feasible to dispose gracefully: the ORT release spike (PLAN.md Stage 4, ' +
      'subagent_reports/260622_spike-ort-release.md) found sherpa-onnx-node OfflineRecognizer exposes NO ' +
      'release()/free()/dispose()/close() — the handle is left to GC, so no bounded thread-join is available without a ' +
      'library change. The external watchdog is the floor here. MANIFEST-ONLY (no liveness accessor); Windows-only and ' +
      'function-scoped/idle-between-calls, so lower suspicion than moonshine.',
  },
];

/**
 * All manifested owner names — the set the coverage guard validates source matches against.
 *
 * @public — consumed by `scripts/check-native-teardown-coverage.ts` (a CI guard outside
 * knip's project glob), so knip's unused-export ratchet can't see the consumer.
 */
export function getNativeTeardownManifestNames(): readonly string[] {
  return NATIVE_TEARDOWN_MANIFEST.map((e) => e.name);
}
