/**
 * fseventsLeakGuard tests — run against an injected fake fsevents module so
 * they execute on Linux CI (the real fsevents only loads on darwin).
 *
 * The fake mirrors the real stop-closure mechanics from
 * node_modules/fsevents/fsevents.js:33-37: the closure nulls its captured
 * instance, so a second invocation resolves `undefined` (double-stop safe),
 * and the native stop runs as a PROMISE MICROTASK
 * (`Promise.resolve(instance).then(Native.stop)`), never synchronously —
 * final review F1: a synchronous-stop fake masked the will-quit backstop's
 * fire-and-forget microtask race, so the asynchrony is load-bearing here.
 *
 * Context: docs/plans/260611_fsevents-shutdown-crash/PLAN.md Stage 1.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@core/logger', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Intercepts the guard's lazy `import('../sentry')` in the late-quit-mode
// one-shot report (RS F3) — the real sentry module must never load here.
vi.mock('../../sentry', () => ({
  captureMainMessage: vi.fn(),
}));

import {
  enterQuitMode,
  getFseventsLeakGuardDiagnostics,
  injectLeakedFseventsInstanceForTests,
  installFseventsLeakGuard,
  liveNativeInstanceCount,
  resetFseventsLeakGuardForTests,
  sweepLeakedInstances,
  type FseventsModuleLike,
} from '../fseventsLeakGuard';

const { logger } = await import('@core/logger');

type StopBehavior = 'resolve' | 'throw-sync' | 'reject' | 'hang';

interface FakeInstance {
  path: string;
  stopped: boolean;
  stopCalls: number;
  /** Mutate before stopping to exercise failure containment. */
  behavior: StopBehavior;
}

interface FakeFsevents {
  module: FseventsModuleLike;
  instances: FakeInstance[];
}

function createFakeFsevents(): FakeFsevents {
  const instances: FakeInstance[] = [];
  const module: FseventsModuleLike = {
    watch: (...args: unknown[]) => {
      const instance: FakeInstance = {
        path: String(args[0]),
        stopped: false,
        stopCalls: 0,
        behavior: 'resolve',
      };
      instances.push(instance);
      // Mirrors fsevents.js:33: the closure marks itself dead synchronously,
      // but the native stop work happens in a `.then` MICROTASK — `stopped`
      // flips true only after a tick. Do NOT make this synchronous; the
      // asynchrony is the load-bearing part of the model (final review F1).
      let live = true;
      return () => {
        instance.stopCalls += 1;
        if (!live) {
          return Promise.resolve(undefined);
        }
        live = false;
        if (instance.behavior === 'throw-sync') {
          // Defensive containment case (the real closure never throws sync).
          throw new Error(`sync stop failure for ${instance.path}`);
        }
        if (instance.behavior === 'hang') {
          return new Promise(() => {
            /* never settles */
          });
        }
        return Promise.resolve(instance).then(() => {
          if (instance.behavior === 'reject') {
            throw new Error(`async stop failure for ${instance.path}`);
          }
          instance.stopped = true;
          return undefined;
        });
      };
    },
  };
  return { module, instances };
}

function installWithFake(): FakeFsevents {
  const fake = createFakeFsevents();
  const result = installFseventsLeakGuard({
    platform: 'darwin',
    loadFseventsModule: () => fake.module,
  });
  expect(result).toBe('installed');
  return fake;
}

const noopHandler = (): void => {
  /* fsevents change callback — unused by the guard */
};

/**
 * The fake's native stop runs as a microtask (mirroring fsevents.js:33) —
 * fire-and-forget stop paths (quit-mode auto-stop) need a tick to settle
 * before `stopped` can be asserted. A macrotask hop is deliberately used so
 * the test cannot under-wait if the model ever gains another `.then` hop.
 */
const settleStops = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  resetFseventsLeakGuardForTests();
  vi.clearAllMocks();
});

describe('fseventsLeakGuard', () => {
  /**
   * RED LEG (bug-expression artifact, written first per bug_mode):
   * expresses the pre-fix condition — chokidar v3's instance pooling can leave
   * a native fsevents instance running even after every FSWatcher.close()
   * resolved. With tracking installed but NOTHING sweeping (today's quit
   * path), the live-instance count at quit time can be nonzero; reaching
   * Node env teardown with a live instance is exactly the SIGABRT
   * precondition (fse_instance_destroy releasing a freed TSFN).
   */
  it('RED: without a sweep, a leaked instance is still live at quit time', async () => {
    const fake = installWithFake();

    // chokidar-style call-time property lookup on the shared exports object.
    const stopA = fake.module.watch('/workspace/a', noopHandler);
    fake.module.watch('/workspace/b', noopHandler); // leaked: never stopped

    await stopA(); // the "all watchers closed cleanly" path
    // Quit time, no sweep: one native instance is still live → crash window.
    expect(liveNativeInstanceCount()).toBe(1);
    expect(fake.instances[1].stopped).toBe(false);
  });

  it('registers every watch and deregisters on normal stop', async () => {
    const fake = installWithFake();

    const stopA = fake.module.watch('/workspace/a', noopHandler);
    const stopB = fake.module.watch('/workspace/b', noopHandler);
    expect(liveNativeInstanceCount()).toBe(2);

    await stopA();
    expect(liveNativeInstanceCount()).toBe(1);
    expect(fake.instances[0].stopped).toBe(true);

    await stopB();
    expect(liveNativeInstanceCount()).toBe(0);
    expect(fake.instances[1].stopped).toBe(true);
  });

  it('sweepLeakedInstances stops stragglers and returns the leaked count', async () => {
    const fake = installWithFake();

    const stopA = fake.module.watch('/workspace/a', noopHandler);
    fake.module.watch('/workspace/b', noopHandler);
    fake.module.watch('/workspace/c', noopHandler);
    await stopA();

    const swept = await sweepLeakedInstances();
    expect(swept).toBe(2);
    expect(fake.instances[1].stopped).toBe(true);
    expect(fake.instances[2].stopped).toBe(true);
    expect(liveNativeInstanceCount()).toBe(0);

    // Nothing left: second sweep is a no-op.
    await expect(sweepLeakedInstances()).resolves.toBe(0);
  });

  it('is double-stop safe: a normal stop after the sweep resolves without error', async () => {
    const fake = installWithFake();

    const stop = fake.module.watch('/workspace/a', noopHandler);
    await expect(sweepLeakedInstances()).resolves.toBe(1);
    expect(fake.instances[0].stopped).toBe(true);

    // Late normal close (e.g. chokidar pool teardown racing the sweep).
    await expect(stop()).resolves.toBeUndefined();
    expect(fake.instances[0].stopCalls).toBe(2);
    expect(liveNativeInstanceCount()).toBe(0);
  });

  it('quit mode: watch() after enterQuitMode is auto-stopped immediately and never tracked', async () => {
    const fake = installWithFake();

    enterQuitMode();
    const stop = fake.module.watch('/workspace/late', noopHandler);

    // Never tracked — synchronously true (the auto-stop is scheduled at once).
    expect(liveNativeInstanceCount()).toBe(0);
    // The native stop itself lands a microtask later (real fsevents shape).
    await settleStops();
    expect(fake.instances[0].stopped).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/workspace/late' }),
      expect.stringContaining('quit mode'),
    );

    // Caller-held closure still honours the fsevents contract.
    await expect(stop()).resolves.toBeUndefined();
  });

  it('quit sequence: enterQuitMode then sweep clears stragglers; later watches are auto-stopped', async () => {
    const fake = installWithFake();

    fake.module.watch('/workspace/a', noopHandler);
    enterQuitMode();
    await expect(sweepLeakedInstances()).resolves.toBe(1);
    expect(fake.instances[0].stopped).toBe(true);

    fake.module.watch('/workspace/post-sweep', noopHandler);
    expect(liveNativeInstanceCount()).toBe(0);
    await settleStops();
    expect(fake.instances[1].stopped).toBe(true);
  });

  it('late quit-mode watch (>10s): one-shot loud report fires exactly once (RS F3)', async () => {
    const fake = installWithFake();
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000_000) // enterQuitMode() stamp
      .mockReturnValue(1_011_001); // late watches: +11.001s

    try {
      enterQuitMode();
      fake.module.watch('/workspace/late-1', noopHandler);
      fake.module.watch('/workspace/late-2', noopHandler);

      // Both instances still auto-stopped (the report is additive, not a behavior change).
      await settleStops();
      expect(fake.instances[0].stopped).toBe(true);
      expect(fake.instances[1].stopped).toBe(true);

      const { captureMainMessage } = await import('../../sentry');
      await vi.waitFor(() => {
        // One-shot: two late watches, exactly ONE capture.
        expect(captureMainMessage).toHaveBeenCalledExactlyOnceWith(
          'fsevents watch() in quit mode long after final exit requested',
          expect.objectContaining({
            level: 'warning',
            extra: { sinceQuitModeMs: 11_001 },
          }),
        );
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ sinceQuitModeMs: 11_001 }),
        expect.stringContaining('long after quit mode entered'),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('quit-mode watch within the 10s threshold does NOT fire the late report', async () => {
    const fake = installWithFake();
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000_000) // enterQuitMode() stamp
      .mockReturnValue(1_005_000); // +5s: inside threshold

    try {
      enterQuitMode();
      fake.module.watch('/workspace/soon', noopHandler);

      // Give the (not-expected) lazy sentry import a chance to settle.
      await new Promise((resolve) => setTimeout(resolve, 10));
      const { captureMainMessage } = await import('../../sentry');
      expect(captureMainMessage).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('non-darwin: install is inert and does not patch watch', async () => {
    const fake = createFakeFsevents();
    const originalWatch = fake.module.watch;

    const result = installFseventsLeakGuard({
      platform: 'linux',
      loadFseventsModule: () => fake.module,
    });

    expect(result).toBe('inert:non-darwin');
    expect(fake.module.watch).toBe(originalWatch);
    fake.module.watch('/workspace/a', noopHandler);
    expect(liveNativeInstanceCount()).toBe(0);
    await expect(sweepLeakedInstances()).resolves.toBe(0);
    expect(() => enterQuitMode()).not.toThrow();
  });

  it('unloadable fsevents: install is inert', async () => {
    const result = installFseventsLeakGuard({
      platform: 'darwin',
      loadFseventsModule: () => {
        throw new Error('Cannot find module fsevents');
      },
    });

    expect(result).toBe('inert:unloadable');
    expect(liveNativeInstanceCount()).toBe(0);
    await expect(sweepLeakedInstances()).resolves.toBe(0);
    expect(() => enterQuitMode()).not.toThrow();
  });

  it('module without a callable watch: install is inert', () => {
    const result = installFseventsLeakGuard({
      platform: 'darwin',
      loadFseventsModule: () => ({}) as FseventsModuleLike,
    });
    expect(result).toBe('inert:unexpected-shape');
  });

  it('install is idempotent: second call does not double-wrap', () => {
    const fake = installWithFake();

    const second = installFseventsLeakGuard({
      platform: 'darwin',
      loadFseventsModule: () => fake.module,
    });
    expect(second).toBe('already-installed');

    fake.module.watch('/workspace/a', noopHandler);
    expect(fake.instances).toHaveLength(1);
    expect(liveNativeInstanceCount()).toBe(1);
  });

  it('contains throwing stop closures: sweep resolves and stops the healthy ones', async () => {
    const fake = installWithFake();

    fake.module.watch('/workspace/sync-thrower', noopHandler);
    fake.module.watch('/workspace/rejector', noopHandler);
    fake.module.watch('/workspace/healthy', noopHandler);
    fake.instances[0].behavior = 'throw-sync';
    fake.instances[1].behavior = 'reject';

    await expect(sweepLeakedInstances()).resolves.toBe(3);
    expect(fake.instances[2].stopped).toBe(true);
    expect(liveNativeInstanceCount()).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('injectLeakedFseventsInstanceForTests starts a tracked never-stopped instance the sweep rescues', async () => {
    const fake = installWithFake();

    const result = injectLeakedFseventsInstanceForTests('/workspace/injected-leak');
    expect(result).toEqual({ injected: true, liveNativeInstanceCount: 1 });
    expect(fake.instances[0].stopped).toBe(false);

    // The injected leak is exactly the wild shape: only the sweep stops it.
    await expect(sweepLeakedInstances()).resolves.toBe(1);
    expect(fake.instances[0].stopped).toBe(true);
    expect(liveNativeInstanceCount()).toBe(0);
  });

  it('injectLeakedFseventsInstanceForTests refuses when the guard is not active', () => {
    const result = injectLeakedFseventsInstanceForTests('/workspace/x');
    expect(result.injected).toBe(false);
    expect(result.reason).toContain('guard not active');
  });

  it('respects the sweep time budget when a stop hangs (fail-open)', async () => {
    const fake = installWithFake();

    fake.module.watch('/workspace/hanger', noopHandler);
    fake.module.watch('/workspace/healthy', noopHandler);
    fake.instances[0].behavior = 'hang';

    const startedAt = Date.now();
    await expect(sweepLeakedInstances(50)).resolves.toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(fake.instances[1].stopped).toBe(true);
    expect(liveNativeInstanceCount()).toBe(0);
  });
});

/**
 * Diagnostics snapshot (Stage 3a): backs the test-mode-only
 * `e2e:fsevents-leak-guard-diagnostics` IPC behind the GATING packaged
 * interception assertion in scripts/check-packaged-app-boot-smoke.ts.
 */
describe('getFseventsLeakGuardDiagnostics', () => {
  it('reports null installState before any install (build-predates-guard signal)', () => {
    expect(getFseventsLeakGuardDiagnostics()).toEqual({
      installState: null,
      quitMode: false,
      liveNativeInstanceCount: 0,
    });
  });

  it('tracks installState, live count, and quit mode through the lifecycle', async () => {
    const fake = installWithFake();
    expect(getFseventsLeakGuardDiagnostics().installState).toBe('installed');

    fake.module.watch('/workspace/a', noopHandler);
    fake.module.watch('/workspace/b', noopHandler);
    expect(getFseventsLeakGuardDiagnostics().liveNativeInstanceCount).toBe(2);

    enterQuitMode();
    await sweepLeakedInstances();
    expect(getFseventsLeakGuardDiagnostics()).toMatchObject({
      installState: 'installed',
      quitMode: true,
      liveNativeInstanceCount: 0,
    });
  });

  it('preserves the FIRST install result across an idempotent re-install', () => {
    const fake = installWithFake();
    const second = installFseventsLeakGuard({
      platform: 'darwin',
      loadFseventsModule: () => fake.module,
    });
    expect(second).toBe('already-installed');
    // 'already-installed' must not clobber the recorded 'installed' state.
    expect(getFseventsLeakGuardDiagnostics().installState).toBe('installed');
  });

  it('reports inert states (the non-darwin clean-no-op assertion of the packaged gate)', () => {
    installFseventsLeakGuard({ platform: 'linux' });
    expect(getFseventsLeakGuardDiagnostics()).toEqual({
      installState: 'inert:non-darwin',
      quitMode: false,
      liveNativeInstanceCount: 0,
    });
  });

  it('resets with the test reset', () => {
    installWithFake();
    resetFseventsLeakGuardForTests();
    expect(getFseventsLeakGuardDiagnostics().installState).toBeNull();
  });
});

/**
 * Real-module smoke (macOS dev only — skipped on Linux CI): exercises the
 * genuine fsevents CJS exports object end-to-end (patch → real native watch →
 * track → sweep). The packaged-artifact equivalent is the GATING Stage 3a
 * boot-smoke assertion; this covers the dev-mode resolution path.
 */
describe.runIf(process.platform === 'darwin')('fseventsLeakGuard (real fsevents module)', () => {
  it('tracks and sweeps a real native instance', async () => {
    const { createRequire } = await import('node:module');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const requireCjs = createRequire(import.meta.url);
    const realFsevents = requireCjs('fsevents') as FseventsModuleLike;

    const result = installFseventsLeakGuard({
      platform: 'darwin',
      loadFseventsModule: () => realFsevents,
    });
    expect(result).toBe('installed');

    const watchDir = mkdtempSync(join(tmpdir(), 'fsevents-leak-guard-'));
    try {
      const stopA = realFsevents.watch(watchDir, noopHandler);
      const stopB = realFsevents.watch(watchDir, noopHandler); // deliberately leaked
      expect(liveNativeInstanceCount()).toBe(2);

      await stopA();
      expect(liveNativeInstanceCount()).toBe(1);

      await expect(sweepLeakedInstances()).resolves.toBe(1);
      expect(liveNativeInstanceCount()).toBe(0);

      // Double-stop safety against the real closure.
      await expect(stopB()).resolves.toBeUndefined();
    } finally {
      rmSync(watchDir, { recursive: true, force: true });
    }
  });
});
