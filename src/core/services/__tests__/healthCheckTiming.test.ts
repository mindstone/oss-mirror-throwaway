import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeCheck } from '../health/utils';
import type { CheckResult } from '../health/types';
import {
  setDiagnosticEventsLedgerWriter,
  resetDiagnosticEventsLedgerForTests,
} from '../diagnosticEventsLedger';

describe('Health Check Timing and Timeouts', () => {
  const events: any[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    events.length = 0;
    
    // Mock the diagnostic events ledger writer to capture emits
    setDiagnosticEventsLedgerWriter({
      append(entry) {
        events.push(entry);
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDiagnosticEventsLedgerForTests();
  });

  // B.1.T1: check sleeps 600ms simulated (default 5s timeout) -> ledger contains exactly one health_check_timing
  it('emits a health_check_timing event for a slow check (>500ms)', async () => {
    const checkFn = async (): Promise<CheckResult> => {
      await new Promise(resolve => setTimeout(resolve, 600));
      return { id: 'test1', name: 'Test 1', status: 'pass', message: 'ok' };
    };

    const promise = safeCheck(checkFn, 'test1', 'Test 1');
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;

    expect(result.status).toBe('pass');
    expect(result.durationMs).toBeGreaterThanOrEqual(600);
    expect(events.length).toBe(1);
    
    const event = events[0];
    expect(event.kind).toBe('health_check_timing');
    expect(event.data.durationBucketMs).toBe(1000); // Bucket for 600ms
    expect(event.data.status).toBe('pass');
    expect(event.data.timedOut).toBeUndefined();
  });

  // B.1.T2: check hangs > 5000ms simulated (default timeout)
  it('times out and emits a failing event for a hanging check (>5000ms)', async () => {
    const checkFn = async (): Promise<CheckResult> => {
      // Simulate hanging forever
      await new Promise(() => {});
      return { id: 'test2', name: 'Test 2', status: 'pass', message: 'ok' };
    };

    const promise = safeCheck(checkFn, 'test2', 'Test 2');
    await vi.advanceTimersByTimeAsync(5001);
    const result = await promise;

    expect(result.status).toBe('fail');
    expect(result.timedOut).toBe(true);
    expect(result.message).toContain('timed out');
    
    expect(events.length).toBe(1);
    const event = events[0];
    expect(event.kind).toBe('health_check_timing');
    expect(event.data.status).toBe('fail');
    expect(event.data.timedOut).toBe(true);
    expect(event.data.durationBucketMs).toBeGreaterThanOrEqual(5000);
  });

  // B.1.T3: check returns in 50ms -> no health_check_timing event emitted
  it('does not emit an event for a fast check (<500ms)', async () => {
    const checkFn = async (): Promise<CheckResult> => {
      await new Promise(resolve => setTimeout(resolve, 50));
      return { id: 'test3', name: 'Test 3', status: 'pass', message: 'ok' };
    };

    const promise = safeCheck(checkFn, 'test3', 'Test 3');
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;

    expect(result.status).toBe('pass');
    expect(events.length).toBe(0);
  });

  // B.1.T4 (per-check override): safeCheck(slowCheck, { timeoutMs: 15000 })
  it('respects per-check override timeoutMs parameter', async () => {
    const checkFn = async (): Promise<CheckResult> => {
      await new Promise(resolve => setTimeout(resolve, 12000));
      return { id: 'test4', name: 'Test 4', status: 'pass', message: 'ok' };
    };

    const promise = safeCheck(checkFn, 'test4', 'Test 4', { timeoutMs: 15000 });
    await vi.advanceTimersByTimeAsync(12000);
    const result = await promise;

    expect(result.status).toBe('pass');
    expect(result.timedOut).toBeUndefined();
    
    expect(events.length).toBe(1);
    const event = events[0];
    expect(event.kind).toBe('health_check_timing');
    expect(event.data.durationBucketMs).toBe(30000); // Bucket for 12000ms
    expect(event.data.status).toBe('pass');
    expect(event.data.timedOut).toBeUndefined();
  });

  it('propagates the timeout AbortSignal into slow check I/O', async () => {
    let fetchSignal: AbortSignal | undefined;
    let abortObservedAtMs: number | undefined;

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(((_input, init) => {
      fetchSignal = init?.signal ?? undefined;
      const startedAt = Date.now();

      return new Promise<Response>((resolve, reject) => {
        const slowResolveId = setTimeout(() => {
          resolve(new Response(null, { status: 200 }));
        }, 30000);

        fetchSignal?.addEventListener(
          'abort',
          () => {
            clearTimeout(slowResolveId);
            abortObservedAtMs = Date.now() - startedAt;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          },
          { once: true }
        );
      });
    }) as typeof fetch);

    const checkFn = async (signal: AbortSignal): Promise<CheckResult> => {
      await fetch('https://example.invalid/health', { method: 'HEAD', signal });
      return { id: 'testAbort', name: 'Test Abort', status: 'pass', message: 'ok' };
    };

    const promise = safeCheck(checkFn, 'testAbort', 'Test Abort', { timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(99);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchSignal?.aborted).toBe(false);
    expect(abortObservedAtMs).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(result.status).toBe('fail');
    expect(result.timedOut).toBe(true);
    expect(fetchSignal?.aborted).toBe(true);
    expect(abortObservedAtMs).toBeGreaterThanOrEqual(100);
    expect(abortObservedAtMs).toBeLessThanOrEqual(200);
  });

  // B.1.T5: grep test asserts network.ts invokes safeCheck with { timeoutMs: ... } explicitly
  it('verifies checkAnthropicReachable uses explicit timeout parameter', async () => {
    const networkFilePath = path.resolve(__dirname, '../../../main/services/health/checks/network.ts');
    const fileContent = await fs.readFile(networkFilePath, 'utf-8');
    
    expect(fileContent).toContain('timeoutMs: NETWORK_CHECK_TIMEOUT_MS');
    expect(fileContent).toContain('safeCheck(');
  });
});
