/**
 * Per-message timeout wrapper for async iterators.
 *
 * Wraps each `iterator.next()` call in a `Promise.race` against a resettable
 * timer. If no message arrives within `timeoutMs`, throws MessageTimeoutError.
 *
 * Supports activity-aware re-arming: when a `getLastActivityAgeMs` callback is
 * provided, the timeout checks upstream liveness before firing. If recent
 * activity exists (within `timeoutMs`), the timer re-arms for the remaining
 * time instead of throwing. A hard cap prevents infinite re-arming.
 *
 * Abort safety: when signal.abort() fires, the stall timer is cleared and a
 * grace timer (ABORT_GRACE_MS) is scheduled. If iterator.next() resolves
 * naturally within the grace period, cost recovery proceeds normally. If it
 * hangs, the grace timer rejects with AbortError to prevent infinite hangs.
 *
 * Used by agentQueryRunner.ts to prevent indefinite stalls when the API stops
 * sending messages mid-stream. See docs/plans/260405_sdk_stream_per_message_timeout.md
 * and docs/plans/260409_activity_aware_streaming_timeout.md
 */

export type TimeoutReason = 'inactivity' | 'hard_cap';

export interface RearmInfo {
  activityAgeMs: number;
  remainingMs: number;
  totalWaitMs: number;
  rearmCount: number;
}

export class MessageTimeoutError extends Error {
  override readonly name = 'MessageTimeoutError';
  constructor(
    public readonly timeoutMs: number,
    public readonly messageCount: number,
    public readonly reason: TimeoutReason = 'inactivity',
    public readonly rearmCount: number = 0,
  ) {
    const timeoutMinutes = Math.round(timeoutMs / 60_000);
    const durationLabel = timeoutMinutes > 0 ? `${timeoutMinutes} minutes` : `${timeoutMs}ms`;
    const message = reason === 'hard_cap'
      ? 'Rebel kept receiving activity for too long and stopped the turn as a safety guard. Your message is safe — try again or simplify the request.'
      : `Rebel was thinking but didn't respond for ${durationLabel}. Your message is safe — try sending it again.`;
    super(message);
  }
}

export interface TimeoutOptions {
  timeoutMs: number;
  /** Optional dynamic timeout resolver (ms). When provided, evaluated on every
   *  timeout cycle/re-arm so callers can increase/decrease the ceiling in-flight. */
  getTimeoutMs?: () => number;
  /** Returns the age in ms since the last upstream activity (SSE event, etc).
   *  When provided, the timeout re-arms if activity is recent (< timeoutMs). */
  getLastActivityAgeMs?: () => number;
  /** Optional keepalive/ping check before timing out. Return true to re-arm. */
  isStillProcessing?: () => boolean | Promise<boolean>;
  /** Absolute maximum wait time in ms across all re-arms. Default: 6 h sentinel
   *  (see DEFAULT_HARD_CAP_MS). */
  hardCapMs?: number;
  /** Called each time the timeout re-arms due to recent upstream activity. */
  onRearm?: (info: RearmInfo) => void;
}

// Sentinel above the watchdog's effective ceiling (including judge extensions).
// The agent-turn watchdog (`src/main/services/watchdogTracker.ts` AUTO_ABORT_MS)
// is the real per-turn cap; this Layer 1 hardCap only catches catastrophic
// stuck-iterator scenarios where the watchdog is wedged. See the move-together
// list in `src/core/rebelCore/rebelCoreQuery.ts` near TURN_WALL_CLOCK_DEADLINE_MS.
const DEFAULT_HARD_CAP_MS = 6 * 60 * 60 * 1000; // 6 hours
const REARM_FLOOR_MS = 1_000; // Prevent busy-looping on stale-but-recent activity
const ABORT_GRACE_MS = 5_000; // Grace period after abort before force-rejecting

function normalizeOptions(opts: number | TimeoutOptions): TimeoutOptions {
  if (typeof opts === 'number') {
    return { timeoutMs: opts };
  }
  return opts;
}

export async function* timeoutAsyncIterator<T>(
  iterator: AsyncIterableIterator<T>,
  options: number | TimeoutOptions,
  signal?: AbortSignal,
): AsyncGenerator<T, void, undefined> {
  const {
    timeoutMs,
    getTimeoutMs,
    getLastActivityAgeMs,
    isStillProcessing,
    hardCapMs = DEFAULT_HARD_CAP_MS,
    onRearm,
  } = normalizeOptions(options);
  const resolveTimeoutMs = (): number => {
    const dynamicTimeoutMs = getTimeoutMs?.();
    if (typeof dynamicTimeoutMs === 'number' && Number.isFinite(dynamicTimeoutMs) && dynamicTimeoutMs > 0) {
      return dynamicTimeoutMs;
    }
    return timeoutMs;
  };
  const initialTimeoutMs = resolveTimeoutMs();

  if (initialTimeoutMs <= 0 || !isFinite(initialTimeoutMs)) {
    yield* iterator;
    return;
  }

  let messageCount = 0;

  // Single abort handler registered once, not per iteration.
  // Mutable rejectFn is updated per iteration so the abort handler
  // always targets the current Promise.race cycle.
  let currentRejectFn: ((err: Error) => void) | undefined;
  let currentTimerRef: ReturnType<typeof setTimeout> | undefined;

  const onAbort = () => {
    // Clear the stall/re-arm timer
    clearTimeout(currentTimerRef);
    // Schedule a grace timer: if iterator.next() resolves within 5s,
    // the .then() handler clears this timer via clearTimeout(currentTimerRef).
    // If it doesn't, we force-reject to prevent infinite hangs.
    currentTimerRef = setTimeout(() => {
      currentRejectFn?.(new DOMException('Abort grace timeout', 'AbortError'));
    }, ABORT_GRACE_MS);
  };

  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      try {
        const raceResult = await Promise.race([
          iterator.next().then(r => { clearTimeout(currentTimerRef); return r; }),
          new Promise<never>((_, reject) => {
            currentRejectFn = reject;
            const waitingSince = Date.now();
            let rearmCount = 0;

            const scheduleTimeout = (delayMs: number) => {
              currentTimerRef = setTimeout(() => {
                void (async () => {
                  const currentTimeoutMs = resolveTimeoutMs();
                  // Check if we've exceeded the hard cap
                  const totalWaitMs = Date.now() - waitingSince;
                  if (totalWaitMs >= hardCapMs) {
                    reject(new MessageTimeoutError(currentTimeoutMs, messageCount, 'hard_cap', rearmCount));
                    return;
                  }

                  const rearmIfStillProcessing = async (
                    activityAgeMs: number,
                    timeoutForCycleMs: number,
                  ): Promise<boolean> => {
                    if (!isStillProcessing) {
                      return false;
                    }

                    let stillProcessing = false;
                    try {
                      stillProcessing = await isStillProcessing();
                    } catch {
                      return false;
                    }

                    if (!stillProcessing) {
                      return false;
                    }

                    rearmCount++;
                    const remainingMs = timeoutForCycleMs;
                    try {
                      onRearm?.({ activityAgeMs, remainingMs, totalWaitMs, rearmCount });
                    } catch {
                      /* best-effort */
                    }
                    scheduleTimeout(remainingMs);
                    return true;
                  };

                  // If no activity callback, fire immediately
                  if (!getLastActivityAgeMs) {
                    if (await rearmIfStillProcessing(Infinity, currentTimeoutMs)) {
                      return;
                    }
                    reject(new MessageTimeoutError(currentTimeoutMs, messageCount, 'inactivity', rearmCount));
                    return;
                  }

                  // Check upstream activity
                  let activityAgeMs: number;
                  try {
                    activityAgeMs = getLastActivityAgeMs();
                  } catch {
                    if (await rearmIfStillProcessing(Infinity, currentTimeoutMs)) {
                      return;
                    }
                    reject(new MessageTimeoutError(currentTimeoutMs, messageCount, 'inactivity', rearmCount));
                    return;
                  }

                  if (activityAgeMs < currentTimeoutMs) {
                    rearmCount++;
                    const remainingMs = Math.max(currentTimeoutMs - activityAgeMs, REARM_FLOOR_MS);

                    try {
                      onRearm?.({ activityAgeMs, remainingMs, totalWaitMs, rearmCount });
                    } catch {
                      /* best-effort */
                    }

                    scheduleTimeout(remainingMs);
                  } else {
                    if (await rearmIfStillProcessing(activityAgeMs, currentTimeoutMs)) {
                      return;
                    }
                    reject(new MessageTimeoutError(currentTimeoutMs, messageCount, 'inactivity', rearmCount));
                  }
                })().catch(() => {
                  reject(new MessageTimeoutError(resolveTimeoutMs(), messageCount, 'inactivity', rearmCount));
                });
              }, delayMs);
            };

            scheduleTimeout(resolveTimeoutMs());
          }),
        ]);

        if (raceResult.done) return;
        messageCount++;
        yield raceResult.value;
      } catch (err) {
        clearTimeout(currentTimerRef);
        throw err;
      }
    }
  } finally {
    // Clean up: remove abort listener if signal was provided and hasn't fired
    if (signal && !signal.aborted) {
      signal.removeEventListener('abort', onAbort);
    }
    clearTimeout(currentTimerRef);
  }
}
