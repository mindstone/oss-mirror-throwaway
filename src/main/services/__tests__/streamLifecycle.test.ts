/**
 * Stage 14 contract tests for the shared StreamLifecycle helper.
 *
 * Two layers:
 *   1. Behavioural unit tests — the lifecycle drives first-byte / first-chunk /
 *      per-chunk / finish-deadline / circuit-breaker handling from INJECTED
 *      constants, and two instances NEVER share or overwrite each other's values
 *      (the Stage-14 Failure-Mode-Matrix risk: one branch's timeout leaking into
 *      another).
 *   2. A source-level contract assertion — every SSE streaming branch in
 *      localModelProxyServer.ts routes its liveness through StreamLifecycle, so
 *      the contract is one copy, not N (Researcher F6 / PMs 260424, 260427).
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  StreamLifecycle,
  FINISH_DEADLINE,
  type StreamLifecycleConfig,
} from '../localModelProxy/streamLifecycle';

function makeConfig(overrides?: Partial<StreamLifecycleConfig>): {
  config: StreamLifecycleConfig;
  recordTimeout: ReturnType<typeof vi.fn>;
  resetTimeoutCount: ReturnType<typeof vi.fn>;
  firstByteLog: ReturnType<typeof vi.fn>;
  firstChunkLog: ReturnType<typeof vi.fn>;
} {
  const recordTimeout = vi.fn();
  const resetTimeoutCount = vi.fn();
  const firstByteLog = vi.fn();
  const firstChunkLog = vi.fn();
  const config: StreamLifecycleConfig = {
    timeouts: { firstByteMs: 100, firstChunkMs: 200, streamChunkMs: 300 },
    finishDeadlineMs: 1000,
    recordTimeout,
    resetTimeoutCount,
    log: { firstByteTimeout: firstByteLog, firstChunkTimeout: firstChunkLog },
    ...overrides,
  };
  return { config, recordTimeout, resetTimeoutCount, firstByteLog, firstChunkLog };
}

/** A reader whose first read never resolves (simulates an upstream stall). */
function makeStalledReader(): ReadableStreamDefaultReader<Uint8Array> {
  return {
    read: () => new Promise(() => {}),
    cancel: vi.fn(() => Promise.resolve()),
    releaseLock: vi.fn(),
    closed: Promise.resolve(undefined),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

/** A reader that yields one chunk then `done`. */
function makeOneChunkReader(chunk: Uint8Array): ReadableStreamDefaultReader<Uint8Array> {
  let sent = false;
  return {
    read: () =>
      Promise.resolve(sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: chunk })),
    cancel: vi.fn(() => Promise.resolve()),
    releaseLock: vi.fn(),
    closed: Promise.resolve(undefined),
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('StreamLifecycle — first-byte', () => {
  it('aborts + logs + records a timeout when the first-byte window elapses', async () => {
    const { config, recordTimeout, firstByteLog } = makeConfig();
    const lifecycle = new StreamLifecycle(config);

    // The fetch rejects when its signal aborts (mirrors fetch + AbortController).
    const promise = lifecycle.fetchFirstByte(
      (signal) =>
        new Promise<globalThis.Response>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const settled = promise.catch((e: Error) => e.message);

    await vi.advanceTimersByTimeAsync(100);
    await expect(settled).resolves.toBe('aborted');
    expect(firstByteLog).toHaveBeenCalledTimes(1);
    expect(recordTimeout).toHaveBeenCalledTimes(1);
  });

  it('does NOT record a timeout when the fetch resolves before the window', async () => {
    const { config, recordTimeout, firstByteLog } = makeConfig();
    const lifecycle = new StreamLifecycle(config);
    const res = { status: 200 } as globalThis.Response;

    await expect(lifecycle.fetchFirstByte(() => Promise.resolve(res))).resolves.toBe(res);
    expect(firstByteLog).not.toHaveBeenCalled();
    expect(recordTimeout).not.toHaveBeenCalled();
  });
});

describe('StreamLifecycle — circuit breaker', () => {
  it('resets the counter only on a 200 response', () => {
    const { config, resetTimeoutCount } = makeConfig();
    const lifecycle = new StreamLifecycle(config);
    lifecycle.noteResponseSettled(500);
    expect(resetTimeoutCount).not.toHaveBeenCalled();
    lifecycle.noteResponseSettled(200);
    expect(resetTimeoutCount).toHaveBeenCalledTimes(1);
  });

  it('records a stream timeout only when a chunk stall was latched', async () => {
    const { config, recordTimeout } = makeConfig();
    const lifecycle = new StreamLifecycle(config);

    // No stall yet → no record.
    lifecycle.recordStreamTimeoutIfNeeded();
    expect(recordTimeout).not.toHaveBeenCalled();

    // Force a first-chunk stall.
    const promise = lifecycle.readNextChunk(makeStalledReader(), false, 'Test stream');
    const settled = promise.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(200);
    await expect(settled).resolves.toContain('stalled');

    lifecycle.recordStreamTimeoutIfNeeded();
    expect(recordTimeout).toHaveBeenCalledTimes(1);
  });
});

describe('StreamLifecycle — chunk reads use INJECTED per-branch constants', () => {
  it('uses firstChunkMs for the first chunk and streamChunkMs thereafter', async () => {
    const { config, firstChunkLog } = makeConfig();
    const lifecycle = new StreamLifecycle(config);

    // First chunk stalls just before firstChunkMs (200) — should NOT fire yet.
    const first = lifecycle.readNextChunk(makeStalledReader(), false, 'Test stream');
    const firstSettled = first.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(199);
    expect(firstChunkLog).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(firstSettled).resolves.toContain('first chunk');
    expect(firstChunkLog).toHaveBeenCalledTimes(1);

    // A successful first read flips isFirstChunk so the next stall uses streamChunkMs (300).
    const lifecycle2 = new StreamLifecycle(config);
    const ok = await lifecycle2.readNextChunk(makeOneChunkReader(new Uint8Array([1])), false, 'Test stream');
    expect(ok).toEqual({ kind: 'chunk', done: false, value: new Uint8Array([1]) });
    const second = lifecycle2.readNextChunk(makeStalledReader(), false, 'Test stream');
    const secondSettled = second.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(299);
    // streamChunkMs (300) not yet elapsed.
    await vi.advanceTimersByTimeAsync(1);
    await expect(secondSettled).resolves.toContain('in 0.3s');
  });

  it('returns the finish-deadline sentinel when finishReasonSeen and the deadline elapses', async () => {
    // The finish deadline (50ms) is shorter than the chunk-stall window (200ms),
    // so once a finish reason is seen the deadline wins on a stall — exactly the
    // late-reasoning cap the streaming handlers rely on.
    const { config } = makeConfig({ finishDeadlineMs: 50 });
    const lifecycle = new StreamLifecycle(config);
    const promise = lifecycle.readNextChunk(makeStalledReader(), true, 'Test stream');
    await vi.advanceTimersByTimeAsync(50);
    await expect(promise).resolves.toEqual({ kind: 'finish-deadline' });
  });
});

describe('StreamLifecycle — per-branch isolation (Stage-14 risk)', () => {
  it('two instances with different injected timeouts do not share or overwrite values', async () => {
    // Branch A: a "local" branch with doubled windows.
    const a = makeConfig({ timeouts: { firstByteMs: 360_000, firstChunkMs: 400_000, streamChunkMs: 90_000 } });
    // Branch B: a cloud branch with the base windows.
    const b = makeConfig({ timeouts: { firstByteMs: 90_000, firstChunkMs: 120_000, streamChunkMs: 45_000 } });

    const lifeA = new StreamLifecycle(a.config);
    const lifeB = new StreamLifecycle(b.config);

    // B's first-byte (90s) fires; A's (360s) must NOT, proving no shared timer state.
    const pA = lifeA
      .fetchFirstByte((signal) => new Promise<globalThis.Response>((_, reject) => signal.addEventListener('abort', () => reject(new Error('A')))))
      .catch(() => 'A-aborted');
    const pB = lifeB
      .fetchFirstByte((signal) => new Promise<globalThis.Response>((_, reject) => signal.addEventListener('abort', () => reject(new Error('B')))))
      .catch(() => 'B-aborted');

    await vi.advanceTimersByTimeAsync(90_000);
    await expect(pB).resolves.toBe('B-aborted');
    expect(b.recordTimeout).toHaveBeenCalledTimes(1);
    expect(a.recordTimeout).not.toHaveBeenCalled();
    expect(b.firstByteLog).toHaveBeenCalledTimes(1);
    expect(a.firstByteLog).not.toHaveBeenCalled();

    // Now advance to A's window — A fires independently.
    await vi.advanceTimersByTimeAsync(360_000 - 90_000);
    await expect(pA).resolves.toBe('A-aborted');
    expect(a.recordTimeout).toHaveBeenCalledTimes(1);
    expect(a.firstByteLog).toHaveBeenCalledTimes(1);
  });
});

describe('StreamLifecycle — source contract: every streaming branch shares the contract', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.resolve(here, '../localModelProxyServer.ts'), 'utf8');

  it('the SSE streaming handlers each construct a StreamLifecycle', () => {
    const handlers = [
      'handleStreamingRequest',
      'handleCodexStreamingRequest',
      'handleStreamingViaResponsesApi',
      'handleOpenRouterPassthrough',
    ];
    for (const handler of handlers) {
      const start = source.indexOf(`private async ${handler}(`);
      expect(start, `${handler} should exist`).toBeGreaterThan(-1);
      // Body extends to the next `private async ` (handlers are ordered).
      const nextPrivate = source.indexOf('private async ', start + 1);
      const body = source.slice(start, nextPrivate === -1 ? undefined : nextPrivate);
      expect(body.includes('new StreamLifecycle('), `${handler} must drive StreamLifecycle`).toBe(true);
      expect(body.includes('lifecycle.fetchFirstByte('), `${handler} must use the shared first-byte path`).toBe(true);
      expect(body.includes('lifecycle.readNextChunk('), `${handler} must use the shared chunk-read path`).toBe(true);
    }
  });

  it('no streaming handler re-implements the inline first-byte timer or chunk-timeout race', () => {
    // The inline liveness primitives were removed in Stage 14; their presence
    // would mean a branch forked the contract again (the F6 regression class).
    expect(source.includes('let firstByteTimedOut')).toBe(false);
    expect(source.includes('let streamTimedOut')).toBe(false);
    expect(source.includes('FINISH_DEADLINE_TIMEOUT')).toBe(false);
  });

  it('exposes the finish-deadline sentinel for consumers', () => {
    expect(typeof FINISH_DEADLINE).toBe('symbol');
  });
});
