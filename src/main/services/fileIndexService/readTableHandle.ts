/**
 * File Index Service — ReadTableHandle lease.
 *
 * Ref-counted, FD-leak-safe lease around a LanceDB read table, extracted
 * intact from `fileIndexService/index.ts` (Stage B2). Behavior-preserving move
 * only: the acquire/release/retire/drain pairing is NOT refactored (FD-leak
 * risk). Zero module-level state — the class is constructed per read table.
 */

import { logger } from '@core/logger';

type LanceDBConnection = Awaited<ReturnType<typeof import('@lancedb/lancedb').connect>>;
type LanceDBTable = Awaited<ReturnType<LanceDBConnection['openTable']>>;

/**
 * Ref-counted lease handle for a LanceDB read table.
 *
 * @internal — exported only so unit tests can construct one directly. Not
 * intended for use outside `fileIndexService.ts`; prefer `acquire()` /
 * `release()` via `currentIndex.readTable` from inside this module.
 *
 * Solves the FD leak (see `docs-private/investigations/260428_emfile_fd_leak.md`)
 * where rebinding `currentIndex.readTable` discarded the previous handle
 * without closing it. On Windows in particular, native LanceDB resources
 * accumulate FDs until `EMFILE: too many open files` cascades across the
 * whole process.
 *
 * Lifecycle contract:
 *  - `acquire()` — readers call this, get back the underlying `LanceDBTable`,
 *    and MUST follow up with `release()` (in a `finally` block).
 *  - `release()` — readers call this when their read is complete. If the
 *    handle has been retired AND there are no other in-flight readers, the
 *    underlying table is closed at this point.
 *  - `retire()` — writers call this when swapping in a new read table
 *    handle. Marks the handle as no-longer-current; the underlying table is
 *    closed once all in-flight readers have released. Idempotent.
 *  - `waitForDrain(timeoutMs)` — at shutdown, callers `retire()` then call
 *    this to bound the wait for in-flight readers to release before
 *    closing the read connection underneath them.
 *
 * Why ref-counted instead of timer-based deferred close: the Fix Design
 * Checkpoint explicitly rejected timer-based deferred close because it
 * races with long in-flight reads (e.g., `getFileEmbeddings` over a
 * large workspace). A ref-counted lease guarantees the close happens
 * exactly once, after all readers genuinely finish.
 */
export class ReadTableHandle {
  private refs = 0;
  private retired = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly table: LanceDBTable) {}

  /**
   * Reserve a reader slot and return the underlying table for use.
   * Callers MUST call `release()` exactly once when done.
   */
  acquire(): LanceDBTable {
    this.refs += 1;
    return this.table;
  }

  /**
   * Release a reader slot. If the handle is retired and refs hit zero,
   * closes the underlying table. Defensive: a release with refs already
   * <= 0 is logged at warn level (silent-failure rule) but does not throw,
   * so a buggy caller cannot abort the surrounding finally block.
   */
  async release(): Promise<void> {
    if (this.refs <= 0) {
      logger.warn(
        { refs: this.refs, retired: this.retired },
        'ReadTableHandle.release called with refs <= 0 (likely double-release bug)'
      );
      return;
    }
    this.refs -= 1;
    if (this.refs === 0 && this.retired) {
      await this.closeNow();
    }
  }

  /**
   * Mark the handle as retired (writer is swapping in a new handle).
   * If no readers are currently leasing the table, closes immediately.
   * Otherwise, the close is deferred until the last reader releases.
   * Idempotent: repeated calls await the in-flight close (or no-op).
   */
  async retire(): Promise<void> {
    if (this.retired) {
      if (this.closing) await this.closing;
      return;
    }
    this.retired = true;
    if (this.refs === 0) {
      await this.closeNow();
    }
  }

  /**
   * Bounded wait for in-flight readers to release. Used by shutdown paths
   * (`closeIndexInternal`, `clearIndexInternal`) AFTER `retire()` has been
   * called: gives in-flight `semanticSearch` / `getFileEmbeddings` calls a
   * chance to finish before the read connection is closed underneath them
   * (otherwise they'd see "table closed" mid-read).
   *
   * Returns `{ drained: true }` once `refs <= 0` (or the close has already
   * completed); returns `{ drained: false, remainingRefs }` if the timeout
   * fires first. Polls every 50 ms — same cadence as the in-flight
   * `optimize()` drain in `closeIndexInternal`.
   *
   * The caller is expected to log a warn (silent-failure rule) when the
   * timeout fires, matching the pattern in `closeIndexInternal`.
   */
  async waitForDrain(timeoutMs: number): Promise<{ drained: boolean; remainingRefs: number }> {
    // Fast path — already idle.
    if (this.refs <= 0) {
      // If a close was kicked off (closing promise present), await it so
      // callers can rely on "drained" meaning "table is fully closed".
      if (this.closing) await this.closing;
      return { drained: true, remainingRefs: 0 };
    }
    const start = Date.now();
    while (this.refs > 0 && Date.now() - start < timeoutMs) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (this.refs <= 0) {
      if (this.closing) await this.closing;
      return { drained: true, remainingRefs: 0 };
    }
    return { drained: false, remainingRefs: this.refs };
  }

  private closeNow(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      try {
        // LanceDB's `Table.close()` is documented synchronous in the SDK
        // shipped here, but we await any thenable to stay forward-compatible
        // and to make this method's contract async-uniform.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LanceDB SDK types do not surface .close() on Table, but it is supported at runtime
        const result = (this.table as any).close?.();
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          await result;
        }
      } catch (err) {
        // Silent-failure rule: log structured warn so a close failure is
        // visible in production logs (it would otherwise leak an FD silently).
        logger.warn({ err }, 'ReadTableHandle close failed');
      }
    })();
    return this.closing;
  }

  /** @internal — unit-test introspection. */
  _getRefsForTesting(): number {
    return this.refs;
  }

  /** @internal — unit-test introspection. */
  _isRetiredForTesting(): boolean {
    return this.retired;
  }

  /** @internal — unit-test introspection. */
  _isClosingForTesting(): boolean {
    return this.closing !== null;
  }
}
