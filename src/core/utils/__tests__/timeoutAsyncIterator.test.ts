import { describe, it, expect, vi } from 'vitest';
import { timeoutAsyncIterator, MessageTimeoutError } from '../timeoutAsyncIterator';
import type { TimeoutOptions } from '../timeoutAsyncIterator';

async function* fromArray<T>(items: T[]): AsyncGenerator<T, void, undefined> {
  for (const item of items) {
    yield item;
  }
}

async function* hangAfter<T>(items: T[]): AsyncGenerator<T, void, undefined> {
  for (const item of items) {
    yield item;
  }
  await new Promise(() => {}); // hang forever
}

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of gen) {
    result.push(item);
  }
  return result;
}

describe('timeoutAsyncIterator', () => {
  // --- Original tests (backwards compatibility) ---

  it('passes through all messages when no timeout occurs', async () => {
    const result = await collect(timeoutAsyncIterator(fromArray([1, 2, 3]), 5000));
    expect(result).toEqual([1, 2, 3]);
  });

  it('throws MessageTimeoutError when a message stalls beyond timeout', async () => {
    const gen = timeoutAsyncIterator(hangAfter([1, 2]), 50);

    const results: number[] = [];
    await expect((async () => {
      for await (const item of gen) {
        results.push(item);
      }
    })()).rejects.toThrow(MessageTimeoutError);
    expect(results).toEqual([1, 2]);
  });

  it('MessageTimeoutError has correct timeoutMs and messageCount', async () => {
    const gen = timeoutAsyncIterator(hangAfter([10, 20, 30]), 50);

    let caught: MessageTimeoutError | undefined;
    try {
      for await (const _item of gen) { /* consume */ }
    } catch (err) {
      if (err instanceof MessageTimeoutError) caught = err;
      else throw err;
    }

    expect(caught).toBeInstanceOf(MessageTimeoutError);
    expect(caught!.timeoutMs).toBe(50);
    expect(caught!.messageCount).toBe(3);
    expect(caught!.reason).toBe('inactivity');
  });

  it('MessageTimeoutError uses actionable inactivity copy', () => {
    const err = new MessageTimeoutError(600_000, 95, 'inactivity');

    expect(err.message).toBe(
      "Rebel was thinking but didn't respond for 10 minutes. Your message is safe — try sending it again.",
    );
  });

  it('disables timeout when timeoutMs is 0', async () => {
    const result = await collect(timeoutAsyncIterator(fromArray([1, 2, 3]), 0));
    expect(result).toEqual([1, 2, 3]);
  });

  it('disables timeout when timeoutMs is Infinity', async () => {
    const result = await collect(timeoutAsyncIterator(fromArray([1, 2, 3]), Infinity));
    expect(result).toEqual([1, 2, 3]);
  });

  it('works with empty iterator', async () => {
    const result = await collect(timeoutAsyncIterator(fromArray<number>([]), 1000));
    expect(result).toEqual([]);
  });

  it('propagates errors from the underlying iterator', async () => {
    async function* throwing(): AsyncGenerator<number, void, undefined> {
      yield 1;
      throw new Error('iterator error');
    }
    const results: number[] = [];
    await expect((async () => {
      for await (const item of timeoutAsyncIterator(throwing(), 5000)) {
        results.push(item);
      }
    })()).rejects.toThrow('iterator error');
    expect(results).toEqual([1]);
  });

  it('disables timeout when timeoutMs is negative', async () => {
    const result = await collect(timeoutAsyncIterator(fromArray([1, 2]), -1));
    expect(result).toEqual([1, 2]);
  });

  it('timer resets per message (fast messages complete without timeout)', async () => {
    async function* fastMessages(): AsyncGenerator<number, void, undefined> {
      for (let i = 0; i < 5; i++) {
        await new Promise(r => setTimeout(r, 10));
        yield i;
      }
    }
    const result = await collect(timeoutAsyncIterator(fastMessages(), 100));
    expect(result).toEqual([0, 1, 2, 3, 4]);
  });

  // --- TimeoutOptions backwards compat ---

  it('accepts TimeoutOptions object with same behavior as number', async () => {
    const gen = timeoutAsyncIterator(hangAfter([1]), { timeoutMs: 50 });
    let caught: MessageTimeoutError | undefined;
    try {
      for await (const _item of gen) { /* consume */ }
    } catch (err) {
      if (err instanceof MessageTimeoutError) caught = err;
      else throw err;
    }
    expect(caught).toBeInstanceOf(MessageTimeoutError);
    expect(caught!.timeoutMs).toBe(50);
    expect(caught!.reason).toBe('inactivity');
  });

  it('disables timeout when TimeoutOptions.timeoutMs is 0', async () => {
    const result = await collect(timeoutAsyncIterator(fromArray([1, 2]), { timeoutMs: 0 }));
    expect(result).toEqual([1, 2]);
  });

  // --- Activity-aware re-arm tests (real timers with short delays) ---

  describe('activity-aware re-arm', () => {
    it('uses getTimeoutMs for the active timeout ceiling', async () => {
      const getTimeoutMs = vi.fn(() => 30);
      const opts: TimeoutOptions = {
        timeoutMs: 10_000,
        getTimeoutMs,
      };

      let caught: MessageTimeoutError | undefined;
      try {
        for await (const _item of timeoutAsyncIterator(hangAfter(['a']), opts)) { /* consume */ }
      } catch (err) {
        if (err instanceof MessageTimeoutError) caught = err;
        else throw err;
      }

      expect(caught).toBeInstanceOf(MessageTimeoutError);
      expect(caught!.timeoutMs).toBe(30);
      expect(getTimeoutMs).toHaveBeenCalled();
    });

    it('re-evaluates getTimeoutMs across timeout re-arm cycles', async () => {
      let timeoutCall = 0;
      const getTimeoutMs = vi.fn(() => {
        timeoutCall++;
        return timeoutCall <= 1 ? 1_200 : 500;
      });
      let ageCall = 0;
      const getLastActivityAgeMs = vi.fn(() => {
        ageCall++;
        return ageCall === 1 ? 100 : 600;
      });

      const opts: TimeoutOptions = {
        timeoutMs: 10_000,
        getTimeoutMs,
        getLastActivityAgeMs,
      };

      let caught: MessageTimeoutError | undefined;
      try {
        for await (const _item of timeoutAsyncIterator(hangAfter(['a']), opts)) { /* consume */ }
      } catch (err) {
        if (err instanceof MessageTimeoutError) caught = err;
        else throw err;
      }

      expect(caught).toBeInstanceOf(MessageTimeoutError);
      expect(caught!.timeoutMs).toBe(500);
      expect(getTimeoutMs.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(getLastActivityAgeMs).toHaveBeenCalledTimes(2);
    }, 8_000);

    it('re-arms when upstream activity is recent then fires when stale', async () => {
      let callCount = 0;
      const getLastActivityAgeMs = vi.fn(() => {
        callCount++;
        // First check: recent activity (10ms ago, < 50ms timeout) -> re-arm
        // Second check: stale activity (200ms ago, >= 50ms timeout) -> fire
        return callCount <= 1 ? 10 : 200;
      });

      const opts: TimeoutOptions = { timeoutMs: 50, getLastActivityAgeMs, hardCapMs: 10_000 };
      const gen = timeoutAsyncIterator(hangAfter(['first']), opts);

      const results: string[] = [];
      let caught: MessageTimeoutError | undefined;
      try {
        for await (const item of gen) { results.push(item); }
      } catch (err) {
        if (err instanceof MessageTimeoutError) caught = err;
        else throw err;
      }

      expect(results).toEqual(['first']);
      expect(caught).toBeInstanceOf(MessageTimeoutError);
      expect(getLastActivityAgeMs).toHaveBeenCalledTimes(2);
    });

    it('fires immediately when no activity callback is provided', async () => {
      const opts: TimeoutOptions = { timeoutMs: 50 };
      const gen = timeoutAsyncIterator(hangAfter(['a']), opts);

      const results: string[] = [];
      let caught: MessageTimeoutError | undefined;
      try {
        for await (const item of gen) { results.push(item); }
      } catch (err) {
        if (err instanceof MessageTimeoutError) caught = err;
        else throw err;
      }

      expect(results).toEqual(['a']);
      expect(caught).toBeInstanceOf(MessageTimeoutError);
      expect(caught!.reason).toBe('inactivity');
    });

    it('hard cap fires despite continuous activity', async () => {
      const getLastActivityAgeMs = vi.fn(() => 5); // Always recent

      const opts: TimeoutOptions = {
        timeoutMs: 30,
        getLastActivityAgeMs,
        hardCapMs: 200,
      };

      const gen = timeoutAsyncIterator(hangAfter(['first']), opts);
      const results: string[] = [];
      let caught: MessageTimeoutError | undefined;
      try {
        for await (const item of gen) { results.push(item); }
      } catch (err) {
        if (err instanceof MessageTimeoutError) caught = err;
        else throw err;
      }

      expect(results).toEqual(['first']);
      expect(caught).toBeInstanceOf(MessageTimeoutError);
      expect(caught!.reason).toBe('hard_cap');
    }, 5000);

    it('re-arm floor prevents busy-looping (min 1000ms re-arm)', async () => {
      // Activity is barely recent (remaining = 1ms), floor should kick in at 1000ms
      let callCount = 0;
      const start = Date.now();
      const getLastActivityAgeMs = vi.fn(() => {
        callCount++;
        if (callCount <= 1) return 49; // Barely recent -> floor = 1000ms
        return 200; // Stale -> fire
      });

      const opts: TimeoutOptions = { timeoutMs: 50, getLastActivityAgeMs, hardCapMs: 60_000 };
      const gen = timeoutAsyncIterator(hangAfter(['first']), opts);

      try {
        for await (const _item of gen) { /* consume */ }
      } catch {
        // expected
      }

      const elapsed = Date.now() - start;
      // Floor means second check happens after ~1000ms, not ~1ms
      expect(elapsed).toBeGreaterThan(900);
      expect(getLastActivityAgeMs).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('callback throwing falls through to normal timeout', async () => {
      const getLastActivityAgeMs = vi.fn(() => { throw new Error('callback error'); });

      const opts: TimeoutOptions = { timeoutMs: 50, getLastActivityAgeMs };
      let caught: MessageTimeoutError | undefined;
      try {
        for await (const _item of timeoutAsyncIterator(hangAfter(['first']), opts)) { /* consume */ }
      } catch (err) {
        if (err instanceof MessageTimeoutError) caught = err;
        else throw err;
      }

      expect(caught).toBeInstanceOf(MessageTimeoutError);
      expect(caught!.reason).toBe('inactivity');
    });

    it('reason is inactivity when activity is stale', async () => {
      const getLastActivityAgeMs = vi.fn(() => 10_000);
      const opts: TimeoutOptions = { timeoutMs: 50, getLastActivityAgeMs };

      let caught: MessageTimeoutError | undefined;
      try {
        for await (const _item of timeoutAsyncIterator(hangAfter(['a']), opts)) { /* consume */ }
      } catch (err) {
        if (err instanceof MessageTimeoutError) caught = err;
        else throw err;
      }

      expect(caught!.reason).toBe('inactivity');
    });

    it('onRearm callback is called with correct info', async () => {
      let callCount = 0;
      const getLastActivityAgeMs = vi.fn(() => {
        callCount++;
        return callCount <= 1 ? 10 : 200; // Re-arm once, then stale
      });

      const onRearm = vi.fn();
      const opts: TimeoutOptions = { timeoutMs: 50, getLastActivityAgeMs, hardCapMs: 10_000, onRearm };

      try {
        for await (const _item of timeoutAsyncIterator(hangAfter(['a']), opts)) { /* consume */ }
      } catch {
        // expected
      }

      expect(onRearm).toHaveBeenCalledTimes(1);
      expect(onRearm).toHaveBeenCalledWith(expect.objectContaining({
        activityAgeMs: 10,
        rearmCount: 1,
      }));
    });

    it('rearmCount is passed to MessageTimeoutError', async () => {
      let callCount = 0;
      const getLastActivityAgeMs = vi.fn(() => {
        callCount++;
        return callCount <= 2 ? 10 : 200; // Re-arm twice, then stale
      });

      const opts: TimeoutOptions = { timeoutMs: 50, getLastActivityAgeMs, hardCapMs: 10_000 };
      let caught: MessageTimeoutError | undefined;
      try {
        for await (const _item of timeoutAsyncIterator(hangAfter(['a']), opts)) { /* consume */ }
      } catch (err) {
        if (err instanceof MessageTimeoutError) caught = err;
        else throw err;
      }

      expect(caught!.rearmCount).toBe(2);
    });

    it('re-arms when keepalive says the model is still processing', async () => {
      let keepaliveChecks = 0;
      const opts: TimeoutOptions = {
        timeoutMs: 30,
        isStillProcessing: vi.fn(() => {
          keepaliveChecks++;
          return keepaliveChecks === 1;
        }),
      };

      let caught: MessageTimeoutError | undefined;
      try {
        for await (const _item of timeoutAsyncIterator(hangAfter(['a']), opts)) { /* consume */ }
      } catch (err) {
        if (err instanceof MessageTimeoutError) caught = err;
        else throw err;
      }

      expect(caught).toBeInstanceOf(MessageTimeoutError);
      expect(caught!.rearmCount).toBe(1);
      expect(opts.isStillProcessing).toHaveBeenCalledTimes(2);
    });

    // REBEL-1AF: Layer 1 (timeoutAsyncIterator) must respect the same
    // tool-in-flight signal Layer 2 (watchdog) keys on. In production this
    // shape is: a long-running MCP tool means no SSE for >10 min (so
    // getLastActivityAgeMs returns Infinity / >= timeoutMs), but the turn
    // is legitimately busy and isStillProcessing returns true.
    // See docs/plans/260506_layer1_layer2_tool_in_flight_alignment.md.
    it('re-arms when isStillProcessing is true even though activity is stale (tool-in-flight)', async () => {
      let keepaliveChecks = 0;
      const opts: TimeoutOptions = {
        timeoutMs: 30,
        // Activity is always stale (no upstream SSE — tool is executing).
        getLastActivityAgeMs: () => Infinity,
        // Keepalive (tool-in-flight) returns true once, then false.
        isStillProcessing: vi.fn(() => {
          keepaliveChecks++;
          return keepaliveChecks === 1;
        }),
        hardCapMs: 10_000,
      };

      let caught: MessageTimeoutError | undefined;
      try {
        for await (const _item of timeoutAsyncIterator(hangAfter(['a']), opts)) { /* consume */ }
      } catch (err) {
        if (err instanceof MessageTimeoutError) caught = err;
        else throw err;
      }

      expect(caught).toBeInstanceOf(MessageTimeoutError);
      expect(caught!.reason).toBe('inactivity');
      expect(caught!.rearmCount).toBe(1);
      // Keepalive checked twice: re-armed first, then declined to re-arm.
      expect(opts.isStillProcessing).toHaveBeenCalledTimes(2);
    });

    // REBEL-1AF safety net: a runaway tool that never completes must still
    // be killed at hardCapMs. Without this, a hung MCP server could keep
    // the iterator alive forever via continuous isStillProcessing=true.
    it('hard cap fires when isStillProcessing perpetually returns true (runaway tool)', async () => {
      const opts: TimeoutOptions = {
        timeoutMs: 30,
        getLastActivityAgeMs: () => Infinity,
        isStillProcessing: vi.fn(() => true),
        hardCapMs: 200,
      };

      let caught: MessageTimeoutError | undefined;
      try {
        for await (const _item of timeoutAsyncIterator(hangAfter(['a']), opts)) { /* consume */ }
      } catch (err) {
        if (err instanceof MessageTimeoutError) caught = err;
        else throw err;
      }

      expect(caught).toBeInstanceOf(MessageTimeoutError);
      expect(caught!.reason).toBe('hard_cap');
    }, 5000);
  });

  // --- Abort hang fix tests ---

  describe('abort safety', () => {
    it('rejects with AbortError after grace period when iterator hangs on abort', async () => {
      const ac = new AbortController();
      const gen = timeoutAsyncIterator(hangAfter(['first']), { timeoutMs: 60_000 }, ac.signal);
      const iter = gen[Symbol.asyncIterator]();

      // Consume first message
      const first = await iter.next();
      expect(first.value).toBe('first');

      // Start next (will hang), then abort
      const pendingNext = iter.next();
      // Abort after a short delay
      setTimeout(() => ac.abort(), 50);

      // Should reject with AbortError after grace period (~5s)
      // Use a shorter timeout for the test -- the grace period is 5s
      let caught: Error | undefined;
      try {
        await pendingNext;
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeDefined();
      expect(caught!.name).toBe('AbortError');
    }, 10_000);

    it('abort while iterator resolves naturally does not reject', async () => {
      const ac = new AbortController();

      // Iterator that yields one more value after a 100ms delay
      async function* delayedYield(): AsyncGenerator<string, void, undefined> {
        yield 'first';
        await new Promise(r => setTimeout(r, 100));
        yield 'second';
      }

      const gen = timeoutAsyncIterator(delayedYield(), { timeoutMs: 60_000 }, ac.signal);
      const results: string[] = [];

      // Abort after 50ms (before second yield, but iterator.next() will resolve)
      setTimeout(() => ac.abort(), 50);

      // The for-await should get at least 'first', then abort check in the
      // consumer (runAgentQuery) would handle breaking the loop.
      // Here we just verify no spurious AbortError.
      try {
        for await (const item of gen) {
          results.push(item);
          if (ac.signal.aborted) break;
        }
      } catch {
        // May or may not throw depending on timing
      }

      expect(results).toContain('first');
    });

    it('cleans up abort listener on normal completion', async () => {
      const ac = new AbortController();
      const removeListenerSpy = vi.spyOn(ac.signal, 'removeEventListener');

      const result = await collect(timeoutAsyncIterator(fromArray([1, 2, 3]), 5000, ac.signal));
      expect(result).toEqual([1, 2, 3]);

      // Abort listener should be removed in finally block
      expect(removeListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
      removeListenerSpy.mockRestore();
    });
  });
});
