import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setErrorReporter } from '@core/errorReporter';

const logDebug = vi.fn();
const logInfo = vi.fn();
const logWarn = vi.fn();
const logError = vi.fn();

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: (...args: unknown[]) => logDebug(...args),
    info: (...args: unknown[]) => logInfo(...args),
    warn: (...args: unknown[]) => logWarn(...args),
    error: (...args: unknown[]) => logError(...args),
  }),
}));

import { SuperMcpOwnerRegistry, type OwnerRecord } from './superMcpOwnerRegistry';

describe('SuperMcpOwnerRegistry', () => {
  let tmpDir: string;
  let registryDir: string;
  let registries: SuperMcpOwnerRegistry[];

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'super-mcp-owner-registry-'));
    registryDir = path.join(tmpDir, 'active-owners');
    registries = [];
    vi.clearAllMocks();
    vi.useRealTimers();
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
  });

  afterEach(async () => {
    await Promise.allSettled(registries.map((registry) => registry.shutdown()));
    await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createRegistry(overrides: { heartbeatCadenceMs?: number; freshnessWindowMs?: number } = {}): SuperMcpOwnerRegistry {
    const registry = new SuperMcpOwnerRegistry({
      registryDir,
      heartbeatCadenceMs: overrides.heartbeatCadenceMs,
      freshnessWindowMs: overrides.freshnessWindowMs,
    });
    registries.push(registry);
    return registry;
  }

  function buildInitialOwner(
    ownerId: string,
    overrides: Partial<Omit<OwnerRecord, 'lastHeartbeatAt'>> = {},
  ): Omit<OwnerRecord, 'lastHeartbeatAt'> {
    return {
      ownerId,
      ownerKind: 'eval-orchestrator',
      ownerPid: 11_001,
      ownerStartTimeMs: 1_700_000_000_000,
      childPid: null,
      childStartTimeMs: null,
      childPort: null,
      spawnedAt: 1_700_000_000_500,
      ...overrides,
    };
  }

  async function readOwnerFromDisk(ownerId: string): Promise<OwnerRecord> {
    const raw = await fsPromises.readFile(path.join(registryDir, `${ownerId}.json`), 'utf8');
    return JSON.parse(raw) as OwnerRecord;
  }

  async function getSingletonFreshnessWindowMs(
    envValue: string | undefined,
  ): Promise<number> {
    vi.resetModules();
    if (envValue === undefined) {
      delete process.env.REBEL_SUPER_MCP_HEARTBEAT_FRESHNESS_MS;
    } else {
      process.env.REBEL_SUPER_MCP_HEARTBEAT_FRESHNESS_MS = envValue;
    }

     
    vi.doMock('@core/utils/dataPaths', () => ({
      getDataPath: () => tmpDir,
    }));

    try {
      const singletonModule = await import('./superMcpOwnerRegistrySingleton');
      return singletonModule.getOwnerRegistry().freshnessWindowMs;
    } finally {
      vi.doUnmock('@core/utils/dataPaths');
      delete process.env.REBEL_SUPER_MCP_HEARTBEAT_FRESHNESS_MS;
    }
  }

  type RegistryWriteFileHook = {
    writeFileFn: typeof fsPromises.writeFile;
  };

  it('register writes a record and listAllOwners round-trips it', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-register-roundtrip');

    await registry.register(initial);

    const stored = await readOwnerFromDisk(initial.ownerId);
    expect(stored).toMatchObject({
      ...initial,
      lastHeartbeatAt: expect.any(Number),
    });

    const owners = await registry.listAllOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0]).toEqual(stored);
  });

  it('register preserves ownerStartTimeMs = null through persistence and listAllOwners', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-null-owner-start', {
      ownerStartTimeMs: null,
    });

    await registry.register(initial);

    const stored = await readOwnerFromDisk(initial.ownerId);
    expect(stored.ownerStartTimeMs).toBeNull();

    const owners = await registry.listAllOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0]?.ownerStartTimeMs).toBeNull();
  });

  it('heartbeat updates lastHeartbeatAt without losing other fields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000));

    const registry = createRegistry();
    const initial = buildInitialOwner('owner-heartbeat-update');
    await registry.register(initial);

    const before = await readOwnerFromDisk(initial.ownerId);

    vi.setSystemTime(new Date(9_000));
    await registry.heartbeat(initial.ownerId);

    const after = await readOwnerFromDisk(initial.ownerId);
    const { lastHeartbeatAt: _beforeHeartbeat, ...beforeRest } = before;
    const { lastHeartbeatAt: afterHeartbeat, ...afterRest } = after;

    expect(afterRest).toEqual(beforeRest);
    expect(afterHeartbeat).toBeGreaterThan(before.lastHeartbeatAt);
  });

  it('heartbeat is a no-op when ownerId does not exist', async () => {
    const registry = createRegistry();
    await expect(registry.heartbeat('owner-missing')).resolves.toBeUndefined();
  });

  it('attachChild updates child fields and heartbeat timestamp', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2_000));

    const registry = createRegistry();
    const initial = buildInitialOwner('owner-attach-child');
    await registry.register(initial);

    vi.setSystemTime(new Date(7_000));
    await registry.attachChild(initial.ownerId, 22_002, 3_100, 1_700_000_002_000);

    const stored = await readOwnerFromDisk(initial.ownerId);
    expect(stored.childPid).toBe(22_002);
    expect(stored.childPort).toBe(3_100);
    expect(stored.childStartTimeMs).toBe(1_700_000_002_000);
    expect(stored.lastHeartbeatAt).toBe(7_000);
    expect(stored.ownerPid).toBe(initial.ownerPid);
  });

  it('attachChild throws when ownerId does not exist', async () => {
    const registry = createRegistry();
    await expect(registry.attachChild('owner-missing', 1, 3_100, null)).rejects.toThrow(/not found/i);
  });

  it('unregister deletes the owner file and is idempotent', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-unregister-idempotent');
    await registry.register(initial);

    const ownerPath = path.join(registryDir, `${initial.ownerId}.json`);
    await registry.unregister(initial.ownerId);
    await expect(fsPromises.readFile(ownerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(registry.unregister(initial.ownerId)).resolves.toBeUndefined();
  });

  it('listAllOwners excludes *.tmp.* files and non-json files', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-list-filter');
    await registry.register(initial);

    const skippedTmpRecord: OwnerRecord = {
      ...buildInitialOwner('owner-should-skip'),
      lastHeartbeatAt: Date.now(),
    };
    await fsPromises.writeFile(
      path.join(registryDir, 'owner-should-skip.tmp.abc.json'),
      JSON.stringify(skippedTmpRecord),
      'utf8',
    );
    await fsPromises.writeFile(path.join(registryDir, 'not-a-record.txt'), 'ignore me', 'utf8');

    const owners = await registry.listAllOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0]?.ownerId).toBe(initial.ownerId);
  });

  it('listAllOwners skips corrupt records and still returns valid ones', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-valid-amid-corruption');
    await registry.register(initial);

    await fsPromises.writeFile(path.join(registryDir, 'broken.json'), '{not-json', 'utf8');
    await fsPromises.writeFile(path.join(registryDir, 'invalid-shape.json'), JSON.stringify({ nope: true }), 'utf8');

    const owners = await registry.listAllOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0]?.ownerId).toBe(initial.ownerId);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        recordPath: expect.stringContaining('broken.json'),
      }),
      'Skipping malformed owner registry record',
    );
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        recordPath: expect.stringContaining('invalid-shape.json'),
      }),
      'Skipping malformed owner registry record',
    );
  });

  it('findOwnerByChildPid returns the matching owner record within start-time tolerance', async () => {
    const registry = createRegistry();
    const first = buildInitialOwner('owner-find-child-a');
    const second = buildInitialOwner('owner-find-child-b');
    await Promise.all([registry.register(first), registry.register(second)]);
    await registry.attachChild(second.ownerId, 44_004, 3_125, 1_700_000_004_000);

    const found = await registry.findOwnerByChildPid(44_004, 1_700_000_005_500);
    expect(found?.ownerId).toBe(second.ownerId);
    expect(found?.childPort).toBe(3_125);
  });

  it('findOwnerByChildPid returns null when no owner matches', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-child-not-found');
    await registry.register(initial);

    const found = await registry.findOwnerByChildPid(99_999, 1_700_000_009_999);
    expect(found).toBeNull();
  });

  it('findOwnerByChildPid returns null when start-time mismatch is beyond tolerance', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-child-mismatch');
    await registry.register(initial);
    await registry.attachChild(initial.ownerId, 55_005, 3_130, 1_700_000_010_000);

    const found = await registry.findOwnerByChildPid(55_005, 1_700_000_020_000);
    expect(found).toBeNull();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: initial.ownerId,
        ownerKind: initial.ownerKind,
        childPid: 55_005,
        recordedChildStartTimeMs: 1_700_000_010_000,
        observedChildStartTimeMs: 1_700_000_020_000,
        deltaMs: -10_000,
      }),
      'Super-MCP owner registry rejected PID match: childStartTimeMs mismatch (PID-reuse defense fired)',
    );
  });

  it('findOwnerByChildPid returns null when start-time delta is exactly at tolerance boundary (2000ms)', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-child-boundary-mismatch');
    await registry.register(initial);
    await registry.attachChild(initial.ownerId, 55_006, 3_134, 1_700_000_010_000);

    const found = await registry.findOwnerByChildPid(55_006, 1_700_000_012_000);
    expect(found).toBeNull();
  });

  it('findOwnerByChildPid returns null for legacy records with childStartTimeMs = null', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-child-legacy-null');
    await registry.register(initial);
    await registry.attachChild(initial.ownerId, 66_006, 3_131, null);

    const found = await registry.findOwnerByChildPid(66_006, 1_700_000_010_000);
    expect(found).toBeNull();
  });

  it('findOwnerByChildPid returns null when observed child start-time is null', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-child-observed-null');
    await registry.register(initial);
    await registry.attachChild(initial.ownerId, 77_007, 3_132, 1_700_000_030_000);

    const found = await registry.findOwnerByChildPid(77_007, null);
    expect(found).toBeNull();
  });

  it('heartbeat skips malformed owner record and logs a structured warning', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-malformed-on-heartbeat');
    await registry.register(initial);

    await fsPromises.writeFile(
      path.join(registryDir, `${initial.ownerId}.json`),
      '{not-json',
      'utf8',
    );

    await expect(registry.heartbeat(initial.ownerId)).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: initial.ownerId,
        recordPath: expect.stringContaining(`${initial.ownerId}.json`),
      }),
      'Owner record is malformed; treating as missing',
    );
  });

  it('listAllOwners skips malformed records with invalid lastHeartbeatAt and logs a warning', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-invalid-last-heartbeat');
    await registry.register(initial);

    await fsPromises.writeFile(
      path.join(registryDir, 'invalid-last-heartbeat.json'),
      JSON.stringify({
        ...initial,
        childPid: 88_008,
        childStartTimeMs: 1_700_000_040_000,
        childPort: 3_133,
        lastHeartbeatAt: 'not-a-number',
      }),
      'utf8',
    );

    const owners = await registry.listAllOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0]?.ownerId).toBe(initial.ownerId);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        recordPath: expect.stringContaining('invalid-last-heartbeat.json'),
      }),
      'Skipping malformed owner registry record',
    );
  });

  it('singleton uses env override for heartbeat freshness window when value is valid', async () => {
    const freshnessWindowMs = await getSingletonFreshnessWindowMs('60000');
    expect(freshnessWindowMs).toBe(60_000);
  });

  it('singleton uses default heartbeat freshness window when env override is empty', async () => {
    const freshnessWindowMs = await getSingletonFreshnessWindowMs('');
    expect(freshnessWindowMs).toBe(30_000);
  });

  it('singleton uses default heartbeat freshness window and logs warning when env override is invalid', async () => {
    const freshnessWindowMs = await getSingletonFreshnessWindowMs('invalid');
    expect(freshnessWindowMs).toBe(30_000);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        envVar: 'REBEL_SUPER_MCP_HEARTBEAT_FRESHNESS_MS',
        rawValue: 'invalid',
        fallbackMs: 30_000,
      }),
      'Invalid heartbeat freshness env override; using default',
    );
  });

  it('singleton clamps heartbeat freshness window to minimum', async () => {
    const freshnessWindowMs = await getSingletonFreshnessWindowMs('1000');
    expect(freshnessWindowMs).toBe(5_000);
  });

  it('singleton clamps heartbeat freshness window to maximum', async () => {
    const freshnessWindowMs = await getSingletonFreshnessWindowMs('99999999');
    expect(freshnessWindowMs).toBe(600_000);
  });

  it('concurrent register calls for two ownerIds are safe', async () => {
    const registry = createRegistry();
    const first = buildInitialOwner('owner-concurrent-register-a');
    const second = buildInitialOwner('owner-concurrent-register-b');

    await Promise.all([registry.register(first), registry.register(second)]);

    const ownerIds = (await registry.listAllOwners()).map((owner) => owner.ownerId).sort();
    expect(ownerIds).toEqual([first.ownerId, second.ownerId].sort());
  });

  it('concurrent register + heartbeat for the same ownerId is safe', async () => {
    const registry = createRegistry();
    const initial = buildInitialOwner('owner-concurrent-register-heartbeat');

    await Promise.all([
      registry.register(initial),
      registry.heartbeat(initial.ownerId),
    ]);

    const owners = await registry.listAllOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0]?.ownerId).toBe(initial.ownerId);
  });

  it('shutdown unregisters all held owners and is idempotent', async () => {
    const registry = createRegistry({ heartbeatCadenceMs: 1_000 });
    const first = buildInitialOwner('owner-shutdown-a');
    const second = buildInitialOwner('owner-shutdown-b');
    await Promise.all([registry.register(first), registry.register(second)]);
    registry.startHeartbeatTimer(first.ownerId);
    registry.startHeartbeatTimer(second.ownerId);

    await registry.shutdown();

    await expect(
      fsPromises.readFile(path.join(registryDir, `${first.ownerId}.json`), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fsPromises.readFile(path.join(registryDir, `${second.ownerId}.json`), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(registry.shutdown()).resolves.toBeUndefined();
  });

  it('heartbeat timer errors are caught, warn is rate-limited, and no unhandled rejection occurs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const registry = createRegistry({ heartbeatCadenceMs: 1_000 });
    const ownerId = 'owner-heartbeat-error-rate-limit';
    await registry.register(buildInitialOwner(ownerId));

    const registryWriteHook = registry as unknown as RegistryWriteFileHook;
    const originalWriteFile = registryWriteHook.writeFileFn;
    registryWriteHook.writeFileFn = async (...args: Parameters<typeof fsPromises.writeFile>) => {
      const [targetPath] = args;
      if (String(targetPath).includes(`${ownerId}.json.tmp.`)) {
        throw new Error('simulated-heartbeat-write-failure');
      }
      return originalWriteFile(...args);
    };

    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      registry.startHeartbeatTimer(ownerId);
      await vi.advanceTimersByTimeAsync(59_000);
      registry.stopHeartbeatTimer(ownerId);
      await Promise.resolve();
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      registryWriteHook.writeFileFn = originalWriteFile;
    }

    const bouncedWarnCalls = logWarn.mock.calls.filter(
      (call) => call[1] === 'Heartbeat update failed for owner registry entry',
    );
    expect(bouncedWarnCalls.length).toBeLessThanOrEqual(1);
    expect(unhandledRejections).toHaveLength(0);
  });

  it('emits owner-registry-degraded breadcrumb after three consecutive heartbeat failures', async () => {
    const addBreadcrumb = vi.fn();
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb,
    });

    const registry = createRegistry({ heartbeatCadenceMs: 1_000 });
    const ownerId = 'owner-heartbeat-degraded';
    await registry.register(buildInitialOwner(ownerId));

    const registryWriteHook = registry as unknown as RegistryWriteFileHook;
    const originalWriteFile = registryWriteHook.writeFileFn;
    registryWriteHook.writeFileFn = async (...args: Parameters<typeof fsPromises.writeFile>) => {
      const [targetPath] = args;
      if (String(targetPath).includes(`${ownerId}.json.tmp.`)) {
        throw new Error('simulated-heartbeat-write-failure');
      }
      return originalWriteFile(...args);
    };

    type RegistryErrorHook = {
      handleHeartbeatError: (targetOwnerId: string, error: unknown) => void;
    };
    const errorHook = registry as unknown as RegistryErrorHook;

    try {
      for (let index = 0; index < 3; index += 1) {
        await registry.heartbeat(ownerId).catch((error: unknown) => {
          errorHook.handleHeartbeatError(ownerId, error);
        });
      }
    } finally {
      registryWriteHook.writeFileFn = originalWriteFile;
    }

    // The error reporter is a process-global singleton (set/getErrorReporter), so a
    // prior test's late-resolving heartbeat-error microtask can land an extra
    // owner-registry-degraded breadcrumb on this local mock under CI scheduling
    // (flake: "expected 1 call, got 2"). Scope the exactly-once assertion to THIS
    // owner's degraded breadcrumbs (ownerId is unique per test) so it stays immune to
    // that cross-test leak — the in-test path can only degrade this owner once.
    const degradedCrumbsForOwner = addBreadcrumb.mock.calls.filter(
      ([crumb]) => crumb?.message === 'owner-registry-degraded' && crumb?.data?.ownerId === ownerId,
    );
    expect(degradedCrumbsForOwner).toHaveLength(1);
    expect(degradedCrumbsForOwner[0][0]).toEqual(
      expect.objectContaining({
        category: 'super-mcp-owner-registry',
        message: 'owner-registry-degraded',
        data: expect.objectContaining({
          ownerId,
        }),
      }),
    );
  });

  it('shutdown() awaits an in-flight heartbeat so it cannot complete after shutdown returns', async () => {
    // Root-cause guard for the cross-test reporter bleed: a timer-tick heartbeat
    // that is still in flight must be drained by shutdown(), not left to resolve
    // (and fire its degraded breadcrumb / state mutation) in a later test.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const registry = createRegistry({ heartbeatCadenceMs: 1_000 });
    const ownerId = 'owner-shutdown-drain';
    await registry.register(buildInitialOwner(ownerId));

    // Gate the heartbeat write so the timer-driven heartbeat stays in flight until
    // we release it — deterministically reproducing "heartbeat outlives shutdown".
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const registryWriteHook = registry as unknown as RegistryWriteFileHook;
    const originalWriteFile = registryWriteHook.writeFileFn;
    registryWriteHook.writeFileFn = async (...args: Parameters<typeof fsPromises.writeFile>) => {
      const [targetPath] = args;
      if (String(targetPath).includes(`${ownerId}.json.tmp.`)) {
        await writeGate;
        return originalWriteFile(...args);
      }
      return originalWriteFile(...args);
    };

    try {
      registry.startHeartbeatTimer(ownerId);
      await vi.advanceTimersByTimeAsync(1_000); // fire one tick → heartbeat blocks on writeGate

      // Unregister first so shutdown() has no held owners to unlink — this removes the
      // real-fs work from shutdown() so the ONLY thing it can await is the gated
      // in-flight heartbeat (otherwise the unlink I/O masks whether the drain runs).
      await registry.unregister(ownerId);

      let shutdownResolved = false;
      const shutdownPromise = registry.shutdown().then(() => {
        shutdownResolved = true;
      });

      // Flush every timer + ready microtask. shutdown() must still be pending because
      // it is awaiting the gated in-flight heartbeat (writeGate is unresolved).
      await vi.advanceTimersByTimeAsync(5_000);
      expect(shutdownResolved).toBe(false);

      // Releasing the write lets the heartbeat settle; only then may shutdown resolve.
      releaseWrite();
      await shutdownPromise;
      expect(shutdownResolved).toBe(true);
    } finally {
      registryWriteHook.writeFileFn = originalWriteFile;
    }
  });
});
