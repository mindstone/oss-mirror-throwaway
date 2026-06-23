import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import {
  installGracefulFsObservability,
  tagFsExhaustion,
  getFsExhaustionSnapshot,
  _resetForTesting,
} from '../gracefulFsObservability';
import type { ErrorReporter } from '@core/errorReporter';

interface BootstrapStashGlobal {
  __REBEL_BOOTSTRAP_BANNER_ERROR__?: unknown;
  __REBEL_BOOTSTRAP_LEAF_ERROR__?: unknown;
}

const QUEUE_SYMBOL = Symbol.for('graceful-fs.queue');

// Use the CJS require view of fs (not the ESM namespace, which is sealed)
// so we can attach the graceful-fs queue symbol that the sampler reads.
// The implementation under test reads via `require('node:fs')` so this
// matches the runtime view exactly.
const requireCjs = createRequire(import.meta.url);
const fsCjs = requireCjs('node:fs') as Record<symbol, unknown>;

type SpyableReporter = {
  captureException: ReturnType<typeof vi.fn>;
  captureMessage: ReturnType<typeof vi.fn>;
  addBreadcrumb: ReturnType<typeof vi.fn>;
  captureExceptionWithScope: ReturnType<typeof vi.fn>;
};

function createReporter(): SpyableReporter {
  return {
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
    captureExceptionWithScope: vi.fn(),
  };
}

/** Cast helper — vi.fn() typings don't directly satisfy the ErrorReporter shape. */
function asReporter(r: SpyableReporter): ErrorReporter {
  return r as unknown as ErrorReporter;
}

/**
 * Manage the graceful-fs queue symbol on `fs` for tests. The real graceful-fs
 * library populates this; in unit tests we install a plain array so the
 * sampler can read it.
 */
function installFakeQueue(): unknown[] {
  const queue: unknown[] = [];
  Object.defineProperty(fsCjs, QUEUE_SYMBOL, {
    configurable: true,
    writable: true,
    value: queue,
  });
  return queue;
}

function clearFakeQueue(): void {
  const descriptor = Object.getOwnPropertyDescriptor(fsCjs, QUEUE_SYMBOL);
  if (!descriptor || descriptor.configurable) {
    delete fsCjs[QUEUE_SYMBOL];
  }
}

describe('gracefulFsObservability', () => {
  beforeEach(() => {
    _resetForTesting();
    clearFakeQueue();
  });

  afterEach(() => {
    _resetForTesting();
    clearFakeQueue();
    vi.useRealTimers();
  });

  describe('installGracefulFsObservability — bootstrap stash drain', () => {
    it('retries banner-stage install failures before reporting and downgrades recovered installs', () => {
      vi.useFakeTimers({ now: 10_000 });
      const g = globalThis as BootstrapStashGlobal;
      g.__REBEL_BOOTSTRAP_BANNER_ERROR__ = {
        kind: 'graceful_fs_install_failed',
        error: { name: 'Error', message: 'bang', stack: 'stack' },
        at: 12345,
        retry: {
          status: 'pending',
          delayMs: 1_000,
          scheduledAt: Date.now(),
        },
      };
      const reporter = createReporter();

      const cleanup = installGracefulFsObservability(asReporter(reporter), { surface: 'desktop_main' });
      try {
        expect(reporter.captureMessage).not.toHaveBeenCalled();
        expect(g.__REBEL_BOOTSTRAP_BANNER_ERROR__).toBeDefined();

        g.__REBEL_BOOTSTRAP_BANNER_ERROR__ = {
          ...(g.__REBEL_BOOTSTRAP_BANNER_ERROR__ as Record<string, unknown>),
          retry: {
            status: 'succeeded',
            delayMs: 1_000,
            attemptedAt: Date.now() + 1_000,
          },
        };
        vi.advanceTimersByTime(1_250);

        expect(reporter.captureMessage).not.toHaveBeenCalled();
        expect(reporter.addBreadcrumb).toHaveBeenCalledWith(
          expect.objectContaining({
            category: 'fs.bootstrap',
            level: 'warning',
            message: 'graceful-fs install recovered after banner retry',
            data: expect.objectContaining({
              extra: expect.objectContaining({
                kind: 'graceful_fs_install_failed',
                retry: expect.objectContaining({ status: 'succeeded' }),
              }),
            }),
          }),
        );
        expect(g.__REBEL_BOOTSTRAP_BANNER_ERROR__).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('waits for pending leaf-module retry before reporting and downgrades recovered installs', () => {
      vi.useFakeTimers({ now: 20_000 });
      const g = globalThis as BootstrapStashGlobal;
      g.__REBEL_BOOTSTRAP_LEAF_ERROR__ = {
        kind: 'graceful_fs_leaf_install_failed',
        error: { name: 'Error', message: 'bang2' },
        at: 67890,
        retry: {
          status: 'pending',
          delayMs: 1_000,
          scheduledAt: Date.now(),
        },
      };
      const reporter = createReporter();

      const cleanup = installGracefulFsObservability(asReporter(reporter), { surface: 'cloud' });
      try {
        expect(reporter.captureMessage).not.toHaveBeenCalled();

        g.__REBEL_BOOTSTRAP_LEAF_ERROR__ = {
          ...(g.__REBEL_BOOTSTRAP_LEAF_ERROR__ as Record<string, unknown>),
          retry: {
            status: 'succeeded',
            delayMs: 1_000,
            attemptedAt: Date.now() + 1_000,
          },
        };
        vi.advanceTimersByTime(1_250);

        expect(reporter.captureMessage).not.toHaveBeenCalled();
        expect(reporter.addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({
          category: 'fs.bootstrap',
          level: 'warning',
          message: 'graceful-fs install recovered after leaf retry',
        }));
        expect(g.__REBEL_BOOTSTRAP_LEAF_ERROR__).toBeUndefined();
      } finally {
        cleanup();
      }
    });

    it('does not surface anything when both stashes are empty', () => {
      const reporter = createReporter();
      const cleanup = installGracefulFsObservability(asReporter(reporter), { surface: 'desktop_main' });
      try {
        expect(reporter.captureMessage).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });
  });

  describe('installGracefulFsObservability — sampler / breadcrumbs', () => {
    it('emits breadcrumb when peakDepth > 0 within 60s window', () => {
      vi.useFakeTimers({ now: 1_000_000 });
      const queue = installFakeQueue();
      const reporter = createReporter();
      const cleanup = installGracefulFsObservability(asReporter(reporter), { surface: 'test' });
      try {
        // First sampler tick @ 500ms with non-empty queue.
        queue.push([() => {}, [], null, Date.now() - 250]);
        vi.advanceTimersByTime(500);
        // Drain queue mid-window.
        queue.length = 0;
        vi.advanceTimersByTime(500);

        // Cross the 60s window boundary — sampler should emit breadcrumb.
        expect(reporter.addBreadcrumb).not.toHaveBeenCalled();
        vi.advanceTimersByTime(60_000);

        expect(reporter.addBreadcrumb).toHaveBeenCalled();
        const call = reporter.addBreadcrumb.mock.calls[0][0] as {
          category: string;
          message: string;
          data: Record<string, unknown>;
        };
        expect(call.category).toBe('fs.queue');
        expect(call.message).toBe('graceful-fs throttled');
        expect(call.data.surface).toBe('test');
        expect(typeof call.data.peakDepth).toBe('number');
        expect(call.data.peakDepth).toBeGreaterThanOrEqual(1);
      } finally {
        cleanup();
      }
    });

    it('does NOT emit breadcrumb when queue stays empty', () => {
      vi.useFakeTimers({ now: 2_000_000 });
      installFakeQueue();
      const reporter = createReporter();
      const cleanup = installGracefulFsObservability(asReporter(reporter), { surface: 'test' });
      try {
        // 65 seconds of empty queue.
        vi.advanceTimersByTime(65_000);
        expect(reporter.addBreadcrumb).not.toHaveBeenCalled();
        expect(reporter.captureMessage).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('escalates to captureMessage when peakDepth > 1000', () => {
      vi.useFakeTimers({ now: 3_000_000 });
      const queue = installFakeQueue();
      const reporter = createReporter();
      const cleanup = installGracefulFsObservability(asReporter(reporter), { surface: 'desktop_main' });
      try {
        // Make queue look "1500 deep" for one sampler tick.
        for (let i = 0; i < 1500; i++) queue.push([() => {}, [], null, Date.now()]);
        vi.advanceTimersByTime(500);
        queue.length = 0;

        vi.advanceTimersByTime(60_000);
        expect(reporter.captureMessage).toHaveBeenCalledWith(
          'graceful-fs queue threshold exceeded',
          expect.objectContaining({
            level: 'warning',
            extra: expect.objectContaining({
              surface: 'desktop_main',
              suppressedCount: 0,
            }),
          }),
        );
        const extra = (reporter.captureMessage.mock.calls[0][1] as { extra: Record<string, unknown> }).extra;
        expect(extra.peakDepth).toBeGreaterThan(1000);
      } finally {
        cleanup();
      }
    });

    it('rate-limits captureMessage to once per hour and tracks suppressedCount', () => {
      vi.useFakeTimers({ now: 4_000_000 });
      const queue = installFakeQueue();
      const reporter = createReporter();
      const cleanup = installGracefulFsObservability(asReporter(reporter), { surface: 'desktop_main' });
      try {
        // Window 1: 1500 deep queue, capture fires once.
        for (let i = 0; i < 1500; i++) queue.push([() => {}, [], null, Date.now()]);
        vi.advanceTimersByTime(500);
        queue.length = 0;
        vi.advanceTimersByTime(60_000);
        expect(reporter.captureMessage).toHaveBeenCalledTimes(1);

        // Window 2 (still within 1h): another peak > 1000 — should NOT capture again.
        for (let i = 0; i < 1500; i++) queue.push([() => {}, [], null, Date.now()]);
        vi.advanceTimersByTime(500);
        queue.length = 0;
        vi.advanceTimersByTime(60_000);
        expect(reporter.captureMessage).toHaveBeenCalledTimes(1);

        // After the rate-limit cooldown elapses, the next breach captures again
        // and reports `suppressedCount > 0`.
        vi.advanceTimersByTime(60 * 60_000); // +1 hour
        for (let i = 0; i < 1500; i++) queue.push([() => {}, [], null, Date.now()]);
        vi.advanceTimersByTime(500);
        queue.length = 0;
        vi.advanceTimersByTime(60_000);

        expect(reporter.captureMessage).toHaveBeenCalledTimes(2);
        const secondCall = reporter.captureMessage.mock.calls[1][1] as { extra: Record<string, unknown> };
        expect(typeof secondCall.extra.suppressedCount).toBe('number');
        expect(secondCall.extra.suppressedCount).toBeGreaterThan(0);
      } finally {
        cleanup();
      }
    });

    it('cleanup fn stops the interval', () => {
      vi.useFakeTimers({ now: 5_000_000 });
      const queue = installFakeQueue();
      const reporter = createReporter();
      const cleanup = installGracefulFsObservability(asReporter(reporter), { surface: 'test' });

      cleanup();

      // After cleanup, sampler should never fire. Push items + advance past
      // a 60s window — no breadcrumb should appear.
      queue.push([() => {}, [], null, Date.now()]);
      vi.advanceTimersByTime(60_500);

      expect(reporter.addBreadcrumb).not.toHaveBeenCalled();
    });
  });

  describe('tagFsExhaustion', () => {
    it('calls captureExceptionWithScope with both setTag and setContext', () => {
      installFakeQueue();
      const reporter = createReporter();
      const cleanup = installGracefulFsObservability(asReporter(reporter), { surface: 'desktop_main' });
      try {
        const error = Object.assign(new Error('emfile'), { code: 'EMFILE' });
        tagFsExhaustion(error, 'native_bypass');

        expect(reporter.captureExceptionWithScope).toHaveBeenCalledTimes(1);
        const [capturedError, mutator] = reporter.captureExceptionWithScope.mock.calls[0] as [
          unknown,
          (scope: { setTag: ReturnType<typeof vi.fn>; setContext: ReturnType<typeof vi.fn> }) => void,
        ];
        expect(capturedError).toBe(error);

        const setTag = vi.fn();
        const setContext = vi.fn();
        mutator({ setTag, setContext });

        expect(setTag).toHaveBeenCalledWith('fs_exhaustion.source', 'native_bypass');
        expect(setContext).toHaveBeenCalledWith(
          'fs_exhaustion',
          expect.objectContaining({
            source: 'native_bypass',
            surface: 'desktop_main',
          }),
        );
      } finally {
        cleanup();
      }
    });

    it('does NOT capture when source === "unknown"', () => {
      const reporter = createReporter();
      const cleanup = installGracefulFsObservability(asReporter(reporter), { surface: 'desktop_main' });
      try {
        const error = Object.assign(new Error('emfile'), { code: 'EMFILE' });
        tagFsExhaustion(error, 'unknown');
        expect(reporter.captureExceptionWithScope).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('swallows reporter errors and never throws', () => {
      const reporter = createReporter();
      reporter.captureExceptionWithScope.mockImplementation(() => {
        throw new Error('reporter is on fire');
      });
      const cleanup = installGracefulFsObservability(asReporter(reporter), { surface: 'desktop_main' });
      try {
        const error = Object.assign(new Error('emfile'), { code: 'EMFILE' });
        expect(() => tagFsExhaustion(error, 'native_bypass')).not.toThrow();
      } finally {
        cleanup();
      }
    });

    it('is a no-op when no reporter has been installed', () => {
      // _resetForTesting in beforeEach ensures _reporter is null. Just verify
      // tagFsExhaustion doesn't throw and there's nothing to assert against.
      const error = Object.assign(new Error('emfile'), { code: 'EMFILE' });
      expect(() => tagFsExhaustion(error, 'emfile_retry_final')).not.toThrow();
    });

    it('is a no-op when reporter has no captureExceptionWithScope', () => {
      const reporter: ErrorReporter = {
        captureException: vi.fn(),
        captureMessage: vi.fn(),
        addBreadcrumb: vi.fn(),
        // captureExceptionWithScope intentionally omitted
      };
      const cleanup = installGracefulFsObservability(reporter, { surface: 'cloud' });
      try {
        const error = Object.assign(new Error('emfile'), { code: 'EMFILE' });
        expect(() => tagFsExhaustion(error, 'native_bypass')).not.toThrow();
      } finally {
        cleanup();
      }
    });
  });

  describe('getFsExhaustionSnapshot', () => {
    it('returns zeroed counters when no exhaustion has been tagged', () => {
      const snap = getFsExhaustionSnapshot();
      expect(snap.lastSource).toBeUndefined();
      expect(snap.lastTaggedAt).toBeUndefined();
      expect(snap.queueDepth).toBe(0);
      expect(snap.queuePeak).toBe(0);
      expect(snap.sourceCounts.emfile_retry_final).toBe(0);
      expect(snap.sourceCounts.native_bypass).toBe(0);
    });

    it('increments per-source counters and tracks last source even without a reporter', () => {
      const before = Date.now();
      const error = Object.assign(new Error('emfile'), { code: 'EMFILE' });
      tagFsExhaustion(error, 'emfile_retry_final');
      tagFsExhaustion(error, 'emfile_retry_final');
      tagFsExhaustion(error, 'native_bypass');

      const snap = getFsExhaustionSnapshot();
      expect(snap.sourceCounts.emfile_retry_final).toBe(2);
      expect(snap.sourceCounts.native_bypass).toBe(1);
      expect(snap.sourceCounts.graceful_fs_queue).toBe(0);
      expect(snap.lastSource).toBe('native_bypass');
      expect(snap.lastTaggedAt).toBeDefined();
      expect(snap.lastTaggedAt!).toBeGreaterThanOrEqual(before);
    });

    it('does NOT increment counter when source is the unknown sentinel', () => {
      const error = Object.assign(new Error('emfile'), { code: 'EMFILE' });
      tagFsExhaustion(error, 'unknown');
      const snap = getFsExhaustionSnapshot();
      expect(snap.lastSource).toBeUndefined();
      for (const value of Object.values(snap.sourceCounts)) {
        expect(value).toBe(0);
      }
    });

    it('returns a defensive copy — mutating the snapshot does not affect future reads', () => {
      const error = Object.assign(new Error('emfile'), { code: 'EMFILE' });
      tagFsExhaustion(error, 'emfile_retry_final');
      const snap = getFsExhaustionSnapshot();
      snap.sourceCounts.emfile_retry_final = 9999;
      const snap2 = getFsExhaustionSnapshot();
      expect(snap2.sourceCounts.emfile_retry_final).toBe(1);
    });
  });
});
