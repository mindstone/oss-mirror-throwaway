import { describe, expect, it } from 'vitest';
import { MessageTimeoutError, timeoutAsyncIterator } from '../../../core/utils/timeoutAsyncIterator';
import type { RawStreamTrackerState } from '../agentTurnExecutor';
import { recordTerminalLifecycleActivity } from '../agentTurnExecutor';

function makeTracker(overrides?: Partial<RawStreamTrackerState>): RawStreamTrackerState {
  return {
    lastActivity: null,
    lastEventType: null,
    lastTimestamp: null,
    eventCount: 0,
    firstActivityTimestamp: null,
    ...overrides,
  };
}

describe('recordTerminalLifecycleActivity (S7 Stage 2)', () => {
  it('records lifecycle/aborted with turn.aborted when watchdog auto-aborts', () => {
    const tracker = makeTracker({
      lastActivity: { kind: 'lifecycle', subkind: 'message-delta', rawEventType: 'message_delta' },
      lastEventType: 'message_delta',
      lastTimestamp: 1_700_000_000_000,
      eventCount: 3,
    });
    const now = 1_800_000_000_000;

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: true,
      abortedByUser: true,
      now,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'aborted',
      rawEventType: 'turn.aborted',
    });
    expect(tracker.lastEventType).toBe('turn.aborted');
    expect(tracker.lastTimestamp).toBe(now);
    expect(tracker.eventCount).toBe(4);
  });

  it('records lifecycle/cancelled with turn.cancelled when user aborts (no watchdog)', () => {
    const tracker = makeTracker({
      lastActivity: { kind: 'token-delta', subkind: 'text', rawEventType: 'response.output_text.delta' },
      lastEventType: 'response.output_text.delta',
      lastTimestamp: 1_700_000_000_000,
      eventCount: 2,
    });
    const now = 1_800_000_000_123;

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
      abortedByUser: true,
      now,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'cancelled',
      rawEventType: 'turn.cancelled',
    });
    expect(tracker.lastEventType).toBe('turn.cancelled');
    expect(tracker.lastTimestamp).toBe(now);
    expect(tracker.eventCount).toBe(3);
  });

  it('records lifecycle/superseded with turn.superseded when supersededByNewerTurn is true', () => {
    const tracker = makeTracker({
      lastActivity: { kind: 'token-delta', subkind: 'text', rawEventType: 'response.output_text.delta' },
      lastEventType: 'response.output_text.delta',
      lastTimestamp: 1_700_000_000_000,
      eventCount: 2,
    });

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
      abortedByUser: true,
      supersededByNewerTurn: true,
      now: 1_800_000_000_200,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'superseded',
      rawEventType: 'turn.superseded',
    });
    expect(tracker.lastEventType).toBe('turn.superseded');
  });

  it('falls back to lifecycle/cancelled when supersededByNewerTurn is false', () => {
    const tracker = makeTracker();

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
      abortedByUser: true,
      supersededByNewerTurn: false,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'cancelled',
      rawEventType: 'turn.cancelled',
    });
    expect(tracker.lastEventType).toBe('turn.cancelled');
  });

  it('falls back to lifecycle/cancelled when supersededByNewerTurn is undefined', () => {
    const tracker = makeTracker();

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
      abortedByUser: true,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'cancelled',
      rawEventType: 'turn.cancelled',
    });
    expect(tracker.lastEventType).toBe('turn.cancelled');
  });

  it('keeps lifecycle/aborted precedence when watchdog and superseded flags are both true', () => {
    const tracker = makeTracker();

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: true,
      abortedByUser: true,
      supersededByNewerTurn: true,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'aborted',
      rawEventType: 'turn.aborted',
    });
    expect(tracker.lastEventType).toBe('turn.aborted');
  });

  it('does not synthesize terminal lifecycle activity on natural completion', () => {
    const tracker = makeTracker({
      lastActivity: { kind: 'lifecycle', subkind: 'response-completed', rawEventType: 'response.completed' },
      lastEventType: 'response.completed',
      lastTimestamp: 1_700_000_000_000,
      eventCount: 5,
    });

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
      abortedByUser: false,
      now: 1_900_000_000_000,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'response-completed',
      rawEventType: 'response.completed',
    });
    expect(tracker.lastEventType).toBe('response.completed');
    expect(tracker.lastTimestamp).toBe(1_700_000_000_000);
    expect(tracker.eventCount).toBe(5);
  });
});

describe('catch-path terminal emission (round 2 — abort-induced exception)', () => {
  it('records turn.aborted when AbortError is thrown and abortedByWatchdog is true', () => {
    const tracker = makeTracker();

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: true,
      abortedByUser: false,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'aborted',
      rawEventType: 'turn.aborted',
    });
    expect(tracker.lastEventType).toBe('turn.aborted');
  });

  it('records turn.cancelled when AbortError is thrown but abortedByWatchdog is false', () => {
    const tracker = makeTracker();

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
      abortedByUser: true,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'cancelled',
      rawEventType: 'turn.cancelled',
    });
    expect(tracker.lastEventType).toBe('turn.cancelled');
  });

  it('records turn.superseded when AbortError is thrown and supersededByNewerTurn is true', () => {
    const tracker = makeTracker();

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
      abortedByUser: true,
      supersededByNewerTurn: true,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'superseded',
      rawEventType: 'turn.superseded',
    });
    expect(tracker.lastEventType).toBe('turn.superseded');
  });

  it('records turn.cancelled when AbortError is thrown and supersededByNewerTurn is false', () => {
    const tracker = makeTracker();

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
      abortedByUser: true,
      supersededByNewerTurn: false,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'cancelled',
      rawEventType: 'turn.cancelled',
    });
    expect(tracker.lastEventType).toBe('turn.cancelled');
  });

  it('records turn.cancelled when AbortError is thrown and supersededByNewerTurn is undefined', () => {
    const tracker = makeTracker();

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
      abortedByUser: true,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'cancelled',
      rawEventType: 'turn.cancelled',
    });
    expect(tracker.lastEventType).toBe('turn.cancelled');
  });

  it('records turn.aborted when AbortError is thrown and watchdog + superseded flags are both true', () => {
    const tracker = makeTracker();

    recordTerminalLifecycleActivity({
      rawStreamTracker: tracker,
      abortedByWatchdog: true,
      abortedByUser: true,
      supersededByNewerTurn: true,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'aborted',
      rawEventType: 'turn.aborted',
    });
    expect(tracker.lastEventType).toBe('turn.aborted');
  });
});

describe.concurrent('catch-path × timeoutAsyncIterator integration (S7B item 3)', () => {
  // These tests lock the implicit invariant documented at agentTurnExecutor.ts
  // (see "Predicate is intentionally local-signal only" comment block above the
  // catch-path call to recordTerminalLifecycleActivity):
  //
  //   timeoutAsyncIterator's grace-timeout AbortError is only scheduled AFTER
  //   signal.aborted becomes true (see timeoutAsyncIterator.ts onAbort handler).
  //   The catch-block therefore uses signal.aborted (not error.name) as the
  //   admission gate for synthesizing terminal lifecycle activity. This admits
  //   all legitimate watchdog/user-cancel cases while correctly ignoring foreign
  //   AbortErrors that did not trip the local signal.
  //
  // The unit tests above cover recordTerminalLifecycleActivity in isolation.
  // These tests construct real timeoutAsyncIterator + real abort signals and
  // exercise the gate end-to-end so the chain is regression-locked.
  //
  // LOCKSTEP-ANCHOR (S7B-item-3): applyCatchPathPredicate below mirrors two
  // production lines in agentTurnExecutor.ts:
  //   1. The catch-block predicate (search for "if (abortController.signal.aborted)"
  //      in the outermost catch).
  //   2. The abortEndReason() helper (search for "signal.reason === 'superseded'")
  //      that derives supersededByNewerTurn from signal.reason.
  // Keep them in sync — if either shape changes, update both.
  //
  // Tradeoff (2026-05-03): we deliberately mirror via copy rather than extracting
  // a production helper. Rationale: (a) the inline catch-block is 6 lines and the
  // 11-line "Predicate is intentionally local-signal only" invariant comment is
  // more valuable at the call site than as JSDoc on a separate helper; (b) extraction
  // doesn't fully eliminate lockstep — production could still stop calling the helper
  // and use a different predicate; (c) the in-test mirror plus this anchor comment
  // give equivalent regression-detection at lower production-code cost. If the chain
  // ever grows past trivial, revisit the extraction call.

  async function* hangForever<T>(): AsyncGenerator<T, void, undefined> {
    await new Promise(() => { /* hang forever */ });
  }

  async function* yieldThenHang<T>(item: T): AsyncGenerator<T, void, undefined> {
    yield item;
    await new Promise(() => { /* hang forever */ });
  }

  async function* yieldThenForeignAbort(item: string): AsyncGenerator<string, void, undefined> {
    yield item;
    throw new DOMException('Foreign upstream abort', 'AbortError');
  }

  function applyCatchPathPredicate(args: {
    signal: AbortSignal;
    rawStreamTracker: RawStreamTrackerState;
    abortedByWatchdog: boolean;
  }): void {
    if (args.signal.aborted) {
      recordTerminalLifecycleActivity({
        rawStreamTracker: args.rawStreamTracker,
        abortedByWatchdog: args.abortedByWatchdog,
        abortedByUser: !args.abortedByWatchdog,
        supersededByNewerTurn: args.signal.reason === 'superseded',
      });
    }
  }

  it('grace-timeout AbortError chain → signal.aborted=true at throw → tracker shows turn.cancelled', async () => {
    const ac = new AbortController();
    const tracker = makeTracker();

    const gen = timeoutAsyncIterator(yieldThenHang('first'), { timeoutMs: 60_000 }, ac.signal);
    const iter = gen[Symbol.asyncIterator]();

    const first = await iter.next();
    expect(first.value).toBe('first');

    const pendingNext = iter.next();
    setTimeout(() => ac.abort(), 50);

    let caught: Error | undefined;
    try {
      await pendingNext;
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.name).toBe('AbortError');
    expect(ac.signal.aborted).toBe(true);

    applyCatchPathPredicate({
      signal: ac.signal,
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'cancelled',
      rawEventType: 'turn.cancelled',
    });
    expect(tracker.lastEventType).toBe('turn.cancelled');
  }, 10_000);

  it('grace-timeout AbortError chain + abortedByWatchdog=true → tracker shows turn.aborted (watchdog precedence preserved through chain)', async () => {
    const ac = new AbortController();
    const tracker = makeTracker();

    const gen = timeoutAsyncIterator(hangForever<string>(), { timeoutMs: 60_000 }, ac.signal);
    setTimeout(() => ac.abort(), 50);

    let caught: Error | undefined;
    try {
      for await (const _ of gen) { /* drain */ }
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.name).toBe('AbortError');
    expect(ac.signal.aborted).toBe(true);

    applyCatchPathPredicate({
      signal: ac.signal,
      rawStreamTracker: tracker,
      abortedByWatchdog: true,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'aborted',
      rawEventType: 'turn.aborted',
    });
    expect(tracker.lastEventType).toBe('turn.aborted');
  }, 10_000);

  it('grace-timeout AbortError chain + signal.reason="superseded" → tracker shows turn.superseded (signal.reason → supersededByNewerTurn propagation locked)', async () => {
    const ac = new AbortController();
    const tracker = makeTracker();

    const gen = timeoutAsyncIterator(hangForever<string>(), { timeoutMs: 60_000 }, ac.signal);
    setTimeout(() => ac.abort('superseded'), 50);

    let caught: Error | undefined;
    try {
      for await (const _ of gen) { /* drain */ }
    } catch (err) {
      caught = err as Error;
    }

    expect(caught?.name).toBe('AbortError');
    expect(ac.signal.aborted).toBe(true);
    expect(ac.signal.reason).toBe('superseded');

    applyCatchPathPredicate({
      signal: ac.signal,
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
    });

    expect(tracker.lastActivity).toEqual({
      kind: 'lifecycle',
      subkind: 'superseded',
      rawEventType: 'turn.superseded',
    });
    expect(tracker.lastEventType).toBe('turn.superseded');
  }, 10_000);

  it('foreign AbortError without local abort → signal.aborted=false → catch-path predicate does NOT fire (foreign-abort isolation invariant)', async () => {
    const ac = new AbortController();
    const tracker = makeTracker();

    const gen = timeoutAsyncIterator(yieldThenForeignAbort('first'), { timeoutMs: 60_000 }, ac.signal);

    const results: string[] = [];
    let caught: Error | undefined;
    try {
      for await (const item of gen) {
        results.push(item);
      }
    } catch (err) {
      caught = err as Error;
    }

    expect(results).toEqual(['first']);
    expect(caught?.name).toBe('AbortError');
    expect(ac.signal.aborted).toBe(false);

    applyCatchPathPredicate({
      signal: ac.signal,
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
    });

    expect(tracker.lastActivity).toBeNull();
    expect(tracker.lastEventType).toBeNull();
    expect(tracker.lastTimestamp).toBeNull();
    expect(tracker.eventCount).toBe(0);
  });

  it('MessageTimeoutError without local abort → signal.aborted=false → catch-path predicate does NOT fire (predicate specificity invariant)', async () => {
    const ac = new AbortController();
    const tracker = makeTracker();

    const gen = timeoutAsyncIterator(hangForever<string>(), { timeoutMs: 50 }, ac.signal);

    let caught: Error | undefined;
    try {
      for await (const _ of gen) { /* drain */ }
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(MessageTimeoutError);
    expect(ac.signal.aborted).toBe(false);

    applyCatchPathPredicate({
      signal: ac.signal,
      rawStreamTracker: tracker,
      abortedByWatchdog: false,
    });

    expect(tracker.lastActivity).toBeNull();
    expect(tracker.lastEventType).toBeNull();
    expect(tracker.lastTimestamp).toBeNull();
    expect(tracker.eventCount).toBe(0);
  });
});
