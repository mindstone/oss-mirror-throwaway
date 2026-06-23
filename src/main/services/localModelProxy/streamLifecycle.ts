/**
 * Shared stream-liveness lifecycle for the Local Model Proxy (Stage 14).
 *
 * Part of the CHIEF_ENGINEER2 hotspot-refactor roadmap
 * (`docs/plans/260526_hotspot-refactor-roadmap/PLAN.md`, Stage 14).
 *
 * THE LIVENESS CONTRACT LIVES HERE — ONCE, NOT N TIMES.
 *
 * Before Stage 14 the first-byte / first-chunk / per-chunk / finish-deadline /
 * circuit-breaker dance was copy-pasted across the three SSE streaming handlers
 * (`handleStreamingRequest`, `handleCodexStreamingRequest`,
 * `handleStreamingViaResponsesApi`). Researcher F6 + PMs 260424 / 260427 show
 * that narrowing a liveness signal in one copy without enumerating the others
 * regresses the watchdog. The fix is structural: every streaming branch drives
 * the SAME `StreamLifecycle` instance, so the contract cannot drift between
 * branches.
 *
 * BEHAVIOUR-PRESERVING. The per-branch timeout constants and log wording are
 * NOT baked in here — they are INJECTED via {@link StreamLifecycleConfig}. The
 * Chat-Completions branch derives its timeouts with `{ isLocal }` doubling; the
 * Codex and Responses branches do not. Injecting them (rather than computing
 * them here) guarantees one branch's values can never overwrite another's — the
 * exact Stage-14 risk flagged in the Failure Mode Matrix.
 *
 * This module is intentionally electron-free and logger-free (no
 * `createScopedLogger`, no `electron` import): it is reachable from the
 * cloud-bootstrapped proxy. Logging is delegated to injected callbacks so each
 * branch keeps its EXACT warn wording ("Upstream …" / "Codex …" / "Responses
 * API …").
 */

/** Per-branch liveness timeouts, as produced by `getUpstreamTimeouts(...)`. */
export interface StreamTimeouts {
  /** Abort if upstream sends no response headers within this window. */
  firstByteMs: number;
  /** Tighter window for the first chunk after headers (model may stall pre-token). */
  firstChunkMs: number;
  /** Inter-chunk window once streaming has started. */
  streamChunkMs: number;
}

/**
 * The per-branch knobs the lifecycle needs. Everything that differs between the
 * three streaming handlers is injected here so the lifecycle body is identical.
 */
export interface StreamLifecycleConfig {
  /** Per-branch timeouts (injected, never recomputed — see module doc). */
  timeouts: StreamTimeouts;
  /**
   * Late-reasoning finish deadline: once `finishReasonSeen`, the stream is given
   * at most this long to flush trailing reasoning before being cut. Injected so
   * the constant has one source of truth at the call site.
   */
  finishDeadlineMs: number;
  /** Bumps the per-(turn) consecutive-timeout counter (circuit breaker). */
  recordTimeout: () => void;
  /** Clears the per-(turn) consecutive-timeout counter on a healthy response. */
  resetTimeoutCount: () => void;
  /** Branch-specific liveness logging. All optional — a branch may omit any. */
  log: {
    /** Emitted when the first-byte timer fires (before abort). */
    firstByteTimeout: () => void;
    /** Emitted when the FIRST chunk times out (only the first chunk logs). */
    firstChunkTimeout: () => void;
  };
}

/** Opaque sentinel returned by {@link StreamLifecycle.readNextChunk} when the
 *  late-reasoning finish deadline elapses. */
export const FINISH_DEADLINE = Symbol('stream-lifecycle-finish-deadline');

/**
 * Result of a single guarded chunk read.
 * - `finish-deadline`: the finish-deadline elapsed while waiting (the branch
 *   should cap late reasoning and break — exactly as the inline code did).
 * - `chunk`: a normal `reader.read()` result (`done`/`value`).
 */
export type ChunkReadResult =
  | { kind: 'finish-deadline' }
  | { kind: 'chunk'; done: boolean; value: Uint8Array | undefined };

function finishDeadlineTimer(ms: number): Promise<typeof FINISH_DEADLINE> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(FINISH_DEADLINE), ms);
  });
}

/**
 * Drives the liveness contract for one SSE streaming request. Construct once per
 * request, then:
 *   1. `await fetchFirstByte(doFetch)` — runs the upstream fetch under the
 *      first-byte timer (records a timeout + aborts on expiry).
 *   2. `noteResponseSettled(status)` — resets the circuit-breaker counter on 200.
 *   3. loop: `await readNextChunk(reader, state.finishReasonSeen)` — guards each
 *      read with the first-chunk/per-chunk timeout AND, once a finish-reason has
 *      been seen, the late-reasoning finish deadline.
 *   4. on stream error: `recordStreamTimeoutIfNeeded()` in the catch block.
 *
 * The first-byte abort signal is exposed via {@link signal} so the caller passes
 * it to `fetch` (the original code wired one `AbortController` through the
 * first-byte timer; the lifecycle owns it now).
 */
export class StreamLifecycle {
  private readonly config: StreamLifecycleConfig;
  /** Drives first-byte abort; reused by the caller's `fetch` signal. */
  private readonly abortController = new AbortController();
  private firstByteTimedOut = false;
  private streamTimedOut = false;
  private isFirstChunk = true;

  constructor(config: StreamLifecycleConfig) {
    this.config = config;
  }

  /** Abort signal to pass into the upstream `fetch` for the streaming request. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Abort the upstream stream (used by branches that abort on finish-deadline). */
  abort(): void {
    this.abortController.abort();
  }

  /**
   * Run the upstream fetch under the first-byte timer. On the first-byte timeout
   * the controller is aborted; if `doFetch` then rejects (the abort surfacing as
   * an AbortError) the consecutive-timeout counter is bumped. Mirrors the inline
   * `try/catch(firstByteTimedOut → recordTimeout)/finally(clearTimeout)` exactly.
   */
  async fetchFirstByte(
    doFetch: (signal: AbortSignal) => Promise<globalThis.Response>,
  ): Promise<globalThis.Response> {
    const firstByteTimer = setTimeout(() => {
      this.firstByteTimedOut = true;
      this.config.log.firstByteTimeout();
      this.abortController.abort();
    }, this.config.timeouts.firstByteMs);

    try {
      return await doFetch(this.abortController.signal);
    } catch (error) {
      if (this.firstByteTimedOut) {
        this.config.recordTimeout();
      }
      throw error;
    } finally {
      clearTimeout(firstByteTimer);
    }
  }

  /** Reset the circuit-breaker counter on a healthy (200) upstream response. */
  noteResponseSettled(status: number): void {
    if (status === 200) {
      this.config.resetTimeoutCount();
    }
  }

  /**
   * Perform one guarded `reader.read()`. Races the read against the
   * first-chunk/per-chunk stall timeout (the first chunk uses `firstChunkMs`,
   * subsequent chunks `streamChunkMs`) and — once a finish-reason has been seen —
   * the late-reasoning finish deadline.
   *
   * On a chunk-stall the consecutive-timeout flag is latched (so a later stream
   * error records the timeout) and the returned promise rejects with the same
   * "stalled — no data for <label> in <n>s" Error the inline code threw. On the
   * finish deadline it resolves to a `finish-deadline` result instead of throwing
   * (the branch breaks out and caps late reasoning).
   */
  async readNextChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    finishReasonSeen: boolean,
    stallLabel: string,
  ): Promise<ChunkReadResult> {
    const isFirstChunk = this.isFirstChunk;
    const chunkTimeout = isFirstChunk
      ? this.config.timeouts.firstChunkMs
      : this.config.timeouts.streamChunkMs;
    const chunkLabel = isFirstChunk ? 'first chunk' : 'chunk';

    let chunkTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const readWithChunkTimeout = Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        chunkTimeoutId = setTimeout(() => {
          this.streamTimedOut = true;
          if (isFirstChunk) {
            this.config.log.firstChunkTimeout();
          }
          reject(
            new Error(
              `${stallLabel} stalled — no data for ${chunkLabel} in ${chunkTimeout / 1000}s`,
            ),
          );
        }, chunkTimeout);
      }),
    ]);

    const readResult = finishReasonSeen
      ? await Promise.race([
          readWithChunkTimeout,
          finishDeadlineTimer(this.config.finishDeadlineMs),
        ])
      : await readWithChunkTimeout;
    clearTimeout(chunkTimeoutId);

    if (readResult === FINISH_DEADLINE) {
      return { kind: 'finish-deadline' };
    }

    // Mark subsequent reads as non-first ONLY after a real chunk read resolves
    // (the inline code set `isFirstChunk = false` immediately after the race,
    // before unpacking done/value — preserve that ordering).
    this.isFirstChunk = false;
    const { done, value } = readResult;
    return { kind: 'chunk', done, value };
  }

  /**
   * Record a consecutive timeout iff a chunk stall was latched. Call from the
   * streaming `catch` block (mirrors `if (streamTimedOut) this.recordTimeout()`).
   */
  recordStreamTimeoutIfNeeded(): void {
    if (this.streamTimedOut) {
      this.config.recordTimeout();
    }
  }
}
