/**
 * Turn Pipeline Replay — Recording Harness (R1 Stage 1B)
 *
 * Pure recording sink. Each side-effect surface in the executor's per-turn
 * dispatch envelope (per plan F6 expanded inventory) is captured into a
 * single `RecordedSideEffects` collector with a monotonic capture-sequence
 * index. Order is deterministic across runs even with parallel `Promise.all`.
 *
 * Stage 1B intentionally ships a recorder API that test files wire into
 * their own `vi.mock(...)` factories. The harness deliberately does NOT
 * call `vi.mock()` itself because:
 *   1. `vi.mock()` is hoisted PER FILE by Vitest — calling it in a shared
 *      module makes the hoisting unpredictable.
 *   2. Different replay-corpus tests will need different mock surfaces
 *      (e.g., admission-only rows don't care about modelMcp mocks). Letting
 *      tests own their `vi.mock()` calls keeps the surface small per row.
 *
 * Stage 1C will introduce the heavy mock-setup helper that drives the
 * monolith executor end-to-end. For Stage 1B, the harness's contract is
 * the recording API + the canonical timeline shape.
 *
 * See:
 *   - `docs/plans/260427_refactor_agent_turn_executor_pipeline.md` (Stage 1)
 *   - `docs/plans/260427_r1_stage0_working_notes.md`
 *   - F6 side-effect inventory (Sentry, costLedger, proxyManager,
 *     mainTracking, apiRateLimitCooldown, turnCheckpointManager,
 *     powerSaveBlocker, file-change callbacks, dynamic-import resolution)
 */

/**
 * Per-row, per-call recording. The `sequence` field is monotonic across the
 * harness; `surface` partitions the timeline so the canonicalizer can build
 * per-surface arrays without losing insertion order.
 */
export interface RecordedCall {
  readonly sequence: number;
  /** Best-effort timestamp; canonicalizer strips this. Recorded for diagnostics only. */
  readonly timestamp: number;
  readonly surface: SideEffectSurface;
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
}

/**
 * Side-effect surfaces enumerated in plan F6 + later replay-harness expansions.
 *
 * Adding a new surface here is a structural change — corpus rows must
 * declare the matching `expected.<surface>` array.
 */
export type SideEffectSurface =
  | 'event' // dispatchAgentEvent / dispatchAgentErrorEvent
  | 'registry' // agentTurnRegistry mutations
  | 'sentry' // captureException / captureMessage / reportMcpError (Round 3 unified)
  | 'log' // structured logger calls (turnLogger.{info,warn,error,debug})
  | 'cost' // costLedgerService.appendCostEntry
  | 'persistence' // R2 Stage 2 / S2-G: persistence-write instrumentation target (additive)
  | 'proxy' // proxyManager.{addRoutes, removeRoutes, getAndResetTurnStats}
  | 'tracking' // mainTracking.* + tracking aggregator updates
  | 'cooldown' // apiRateLimitCooldown.{recordSuccess, updateLastApiCallTime}
  | 'checkpoint' // turnCheckpointManager.{startCheckpointing, stopCheckpointing}
  | 'sleepBlocker' // acquireBlock / releaseBlock
  | 'fileChange' // routerContext.onFileChanged
  | 'dynamicImport' // _preTurnWorker / matchPathToSpace lazy-import resolution
  | 'envMutation' // setupNodeEnvironment() PATH mutation + applyAuthPlanToEnv (Round-2 F6 expansion; Stage-1B-review add)
  | 'settingsMutation' // dispatchErrorRecovery auto-mark-incompatible-profile path (Round-2 F6 expansion; Stage-1B-review add)
  | 'query'; // queryWithRuntime invocation + iterator-end (Stage 1C Phase 3 — captures query options + router context)

/**
 * Collector returned by `installReplayHarness()`. Per-surface arrays mirror
 * the `expected` shape in corpus row JSON; `timeline` is the unified sorted
 * view used by the canonicalizer.
 */
export interface RecordedSideEffects {
  /** Master ordered timeline. Populated in capture-sequence order. */
  readonly timeline: ReadonlyArray<RecordedCall>;
  // Per-surface convenience views. These return the same RecordedCall
  // references as `timeline`, partitioned by surface and sorted by sequence.
  readonly events: ReadonlyArray<RecordedCall>;
  readonly registry: ReadonlyArray<RecordedCall>;
  readonly sentry: ReadonlyArray<RecordedCall>;
  readonly log: ReadonlyArray<RecordedCall>;
  readonly cost: ReadonlyArray<RecordedCall>;
  /** R2 Stage 2 / S2-G: persistence-write instrumentation target (additive, opt-in). */
  readonly persistence: ReadonlyArray<RecordedCall>;
  readonly proxy: ReadonlyArray<RecordedCall>;
  readonly tracking: ReadonlyArray<RecordedCall>;
  readonly cooldown: ReadonlyArray<RecordedCall>;
  readonly checkpoint: ReadonlyArray<RecordedCall>;
  readonly sleepBlocker: ReadonlyArray<RecordedCall>;
  readonly fileChange: ReadonlyArray<RecordedCall>;
  readonly dynamicImport: ReadonlyArray<RecordedCall>;
  readonly envMutation: ReadonlyArray<RecordedCall>;
  readonly settingsMutation: ReadonlyArray<RecordedCall>;
  /** Stage 1C Phase 3: queryWithRuntime / queryEnded — captures normalized query options + router context. */
  readonly query: ReadonlyArray<RecordedCall>;
}

/**
 * Public recorder API the harness exposes back to test wiring code.
 *
 * Tests pass these recorder functions into their `vi.mock(...)` factories.
 * Each recorder takes a method name + arguments; the harness deep-clones
 * arguments at capture time so later mutation by the SUT can't poison the
 * recorded trace.
 *
 * Why not a single `record(surface, method, args)` function? Because the
 * recorder API is also a typing fence — wiring a registry mutation into the
 * `event` recorder is a structural error.
 */
export interface ReplayRecorder {
  recordEvent: (method: string, args: ReadonlyArray<unknown>) => void;
  recordRegistry: (method: string, args: ReadonlyArray<unknown>) => void;
  recordSentry: (method: 'captureException' | 'captureMessage' | 'reportMcpError', args: ReadonlyArray<unknown>) => void;
  recordLog: (method: 'info' | 'warn' | 'error' | 'debug', args: ReadonlyArray<unknown>) => void;
  recordCost: (method: string, args: ReadonlyArray<unknown>) => void;
  /** R2 Stage 2 / S2-G: additive persistence-write recorder for replay assertions. */
  recordPersistence: (method: string, args: ReadonlyArray<unknown>) => void;
  recordProxy: (method: 'addRoutes' | 'removeRoutes' | 'getAndResetTurnStats', args: ReadonlyArray<unknown>) => void;
  recordTracking: (method: string, args: ReadonlyArray<unknown>) => void;
  recordCooldown: (method: 'recordSuccess' | 'recordRateLimit' | 'updateLastApiCallTime' | 'remainingMs', args: ReadonlyArray<unknown>) => void;
  recordCheckpoint: (method: 'startCheckpointing' | 'stopCheckpointing', args: ReadonlyArray<unknown>) => void;
  recordSleepBlocker: (method: 'acquireBlock' | 'releaseBlock', args: ReadonlyArray<unknown>) => void;
  recordFileChange: (method: string, args: ReadonlyArray<unknown>) => void;
  recordDynamicImport: (method: string, args: ReadonlyArray<unknown>) => void;
  /** Round-2 F6 expansion (Stage-1B-review add): setupNodeEnvironment() PATH writes + applyAuthPlanToEnv mutations. */
  recordEnvMutation: (method: 'setPath' | 'setAuthEnvVar' | 'unsetEnvVar', args: ReadonlyArray<unknown>) => void;
  /** Round-2 F6 expansion (Stage-1B-review add): dispatchErrorRecovery auto-mark-incompatible-profile path. */
  recordSettingsMutation: (method: 'markProfileIncompatible' | 'updateSettings', args: ReadonlyArray<unknown>) => void;
  /** Stage 1C Phase 3: queryWithRuntime invocation + queryEnded summary. */
  recordQuery: (method: 'queryWithRuntime' | 'queryEnded', args: ReadonlyArray<unknown>) => void;
}

/** Handle returned by `installReplayHarness()`. */
export interface ReplayHarnessHandle {
  /** Live snapshot of all recorded calls. */
  readonly records: RecordedSideEffects;
  /** Recorder API to wire into test mocks. */
  readonly recorder: ReplayRecorder;
  /** Clear the recorded timeline. Test files call this between runs. */
  readonly reset: () => void;
  /**
   * Tear down the handle. Stage 1B's harness has no instance-level state
   * outside the records buffer, so `uninstall()` is functionally equivalent
   * to `reset()`. Future stages may attach `vi.spyOn(...)` instance hooks
   * that need explicit teardown — this is the future-proof seam.
   */
  readonly uninstall: () => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Best-effort deep clone of the recorded args array. We use `structuredClone`
 * when available (Node ≥17, Vitest's environment) so cloning is fast and
 * lossless for plain values; we fall back to `JSON.parse(JSON.stringify(...))`
 * when the args contain a non-cloneable value (e.g., a function reference).
 *
 * Functions and Symbols are replaced with placeholder strings so the
 * canonicalizer can stably compare them — this is intentional: phase
 * payloads MUST NOT carry functions per R7 purity, so when a function shows
 * up in a recorded arg it's almost certainly a callback (`onMcpError`,
 * `applyRoutePlan`, etc.) that's invariant per row.
 */
function deepCloneArgs(args: ReadonlyArray<unknown>): ReadonlyArray<unknown> {
  return args.map(arg => deepCloneOne(arg));
}

function deepCloneOne(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'number' || t === 'string' || t === 'boolean' || t === 'bigint') return value;
  if (t === 'function') return '[Function]';
  if (t === 'symbol') return `[Symbol:${(value as symbol).description ?? ''}]`;
  if (value instanceof Error) {
    // Preserve the message + name; drop the stack (non-deterministic).
    return { __error: true, name: value.name, message: value.message };
  }
  // structuredClone preserves dates, regexes, typed arrays, etc.
  try {
    return globalThis.structuredClone
      ? globalThis.structuredClone(value)
      : JSON.parse(JSON.stringify(value));
  } catch {
    // Fallback: stringify what we can.
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return '[Uncloneable]';
    }
  }
}

/**
 * Install a fresh harness. Each call returns an isolated handle with its own
 * monotonic counter. Call `installReplayHarness()` in a `beforeEach` hook so
 * tests don't share state across rows.
 */
export function installReplayHarness(): ReplayHarnessHandle {
  const timeline: RecordedCall[] = [];
  let nextSequence = 0;

  const append = (surface: SideEffectSurface, method: string, args: ReadonlyArray<unknown>): void => {
    timeline.push({
      sequence: nextSequence++,
      timestamp: Date.now(),
      surface,
      method,
      args: deepCloneArgs(args),
    });
  };

  const recorder: ReplayRecorder = {
    recordEvent: (method, args) => append('event', method, args),
    recordRegistry: (method, args) => append('registry', method, args),
    recordSentry: (method, args) => append('sentry', method, args),
    recordLog: (method, args) => append('log', method, args),
    recordCost: (method, args) => append('cost', method, args),
    // R2 Stage 2 / S2-G: additive persistence-write surface for opt-in assertions.
    recordPersistence: (method, args) => append('persistence', method, args),
    recordProxy: (method, args) => append('proxy', method, args),
    recordTracking: (method, args) => append('tracking', method, args),
    recordCooldown: (method, args) => append('cooldown', method, args),
    recordCheckpoint: (method, args) => append('checkpoint', method, args),
    recordSleepBlocker: (method, args) => append('sleepBlocker', method, args),
    recordFileChange: (method, args) => append('fileChange', method, args),
    recordDynamicImport: (method, args) => append('dynamicImport', method, args),
    recordEnvMutation: (method, args) => append('envMutation', method, args),
    recordSettingsMutation: (method, args) => append('settingsMutation', method, args),
    recordQuery: (method, args) => append('query', method, args),
  };

  // Per-surface accessors return live filtered views. Since `timeline` is
  // captured by closure, calling `records.events` after another `recordEvent()`
  // reflects the new state. This keeps the live `records` reference usable
  // as a long-lived read handle in tests.
  const filterBy = (surface: SideEffectSurface): ReadonlyArray<RecordedCall> => {
    const out: RecordedCall[] = [];
    for (const call of timeline) {
      if (call.surface === surface) out.push(call);
    }
    return out;
  };

  const records: RecordedSideEffects = {
    get timeline() {
      // Return a stable copy so consumers can't mutate the harness state.
      return [...timeline];
    },
    get events() {
      return filterBy('event');
    },
    get registry() {
      return filterBy('registry');
    },
    get sentry() {
      return filterBy('sentry');
    },
    get log() {
      return filterBy('log');
    },
    get cost() {
      return filterBy('cost');
    },
    get persistence() {
      // R2 Stage 2 / S2-G: additive persistence-write view.
      return filterBy('persistence');
    },
    get proxy() {
      return filterBy('proxy');
    },
    get tracking() {
      return filterBy('tracking');
    },
    get cooldown() {
      return filterBy('cooldown');
    },
    get checkpoint() {
      return filterBy('checkpoint');
    },
    get sleepBlocker() {
      return filterBy('sleepBlocker');
    },
    get fileChange() {
      return filterBy('fileChange');
    },
    get dynamicImport() {
      return filterBy('dynamicImport');
    },
    get envMutation() {
      return filterBy('envMutation');
    },
    get settingsMutation() {
      return filterBy('settingsMutation');
    },
    get query() {
      return filterBy('query');
    },
  };

  const reset = (): void => {
    timeline.length = 0;
    nextSequence = 0;
  };

  return {
    records,
    recorder,
    reset,
    uninstall: reset,
  };
}
