/* eslint-disable no-console -- debug-test fixture: intentional diagnostic output for timer-behaviour investigation */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('debug fake timer behaviour', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('how many ticks per runOnlyPendingTimersAsync?', async () => {
    let count = 0;
    const start = Date.now();
    const id = setInterval(() => {
      count++;
    }, 300);

    await vi.runOnlyPendingTimersAsync();
    console.log('After 1 call: count=', count, 'elapsed=', Date.now() - start);

    await vi.runOnlyPendingTimersAsync();
    console.log('After 2 calls: count=', count, 'elapsed=', Date.now() - start);

    clearInterval(id);
    expect(count).toBeGreaterThan(0);
  });

  it('async setInterval callback that awaits', async () => {
    let count = 0;
    const start = Date.now();
    const id = setInterval(() => {
      (async () => {
        count++;
        await Promise.resolve();
      })().catch(() => {});
    }, 300);

    await vi.runOnlyPendingTimersAsync();
    console.log('Async cb after 1 call: count=', count, 'elapsed=', Date.now() - start);

    clearInterval(id);
    expect(count).toBeGreaterThan(0);
  });

  it('async cb returning promise (no IIFE)', async () => {
    let count = 0;
    const start = Date.now();
    async function inner() { count++; }
    const id = setInterval(() => {
      inner().catch(() => {});
    }, 300);

    await vi.runOnlyPendingTimersAsync();
    console.log('Async-no-IIFE after 1 call: count=', count, 'elapsed=', Date.now() - start);

    clearInterval(id);
    expect(count).toBeGreaterThan(0);
  });

  it('async cb that awaits a real promise resolution', async () => {
    let count = 0;
    const start = Date.now();
    async function inner() {
      await new Promise<void>(resolve => resolve());
      count++;
    }
    const id = setInterval(() => {
      inner().catch(() => {});
    }, 300);

    await vi.runOnlyPendingTimersAsync();
    console.log('Async-await after 1 call: count=', count, 'elapsed=', Date.now() - start);

    clearInterval(id);
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
