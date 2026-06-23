/**
 * S4.1c (was Stage 7 site F2) — index-read cloud bounding via the boundary.
 * `needsReindexing` / `indexFileInternal` do `realpath`/`stat`/`readFile` on the file
 * path. On the flag-ON path an admitted cloud file reaches the indexer; if its mount
 * then dies, those reads would block the indexer queue + park libuv. They are now
 * routed through `boundedWorkspaceFs`: a CLOUD-classified path takes the killable-pool
 * cloud lane (NOT `node:fs`), so a dead mount surfaces `reconnecting` → the index code
 * throws `CloudIndexReadTimeoutError` → DEFERS the file (keeps the last-known entry),
 * never blocks. The Stage-7 bespoke `runCloudBoundedIndexRead` timer is RETIRED.
 *
 * The dead-mount model therefore moved from a `neverResolves` `node:fs/promises` mock
 * to the executor SEAM (`setWorkspaceFsExecutor(deadMountExecutor)`): the cloud lane
 * never touches `fs`, so a cloud path can only be driven by wiring an executor. The
 * LOCAL lane still uses `node:fs/promises` (the boundary imports it), so the local-file
 * case stays interceptable by the standard `vi.mock('node:fs/promises')` seam.
 *
 * The FS-FREE `cloudIndexReadDisposition` pre-gate is KEPT: a NON-healthy space DEFERS
 * a file WITHOUT issuing any op (caps batch libuv-park amplification — should-3).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  deadMountExecutor,
  realFsExecutor,
  realFsExecutorWith,
} from '@core/services/__tests__/workspaceFsExecutorDoubles';

const CORE_DIR = path.resolve('/workspace');
// The symlink lives at <coreDir>/Drive and points at a genuinely cloud-classified
// Google Drive target; the indexed file lives under that resolved cloud root.
const CLOUD_TARGET =
  '/Users/test/Library/CloudStorage/GoogleDrive-user@example.com/Shared drives/Memories';
const CLOUD_FILE = `${CLOUD_TARGET}/note.md`;
const LOCAL_FILE = path.join(CORE_DIR, 'local', 'note.md');

function makeEinval(): NodeJS.ErrnoException {
  const err = new Error('EINVAL: invalid argument, readlink') as NodeJS.ErrnoException;
  err.code = 'EINVAL';
  return err;
}

// LOCAL lane only: the boundary uses `node:fs/promises` for LOCAL paths (LOCAL_FILE).
// CLOUD paths (CLOUD_FILE) take the wired executor, NOT fsp — so this mock only serves
// the local file's realpath/stat (echo + a 10-byte file at mtime 1).
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const realpath = (p: string) => Promise.resolve(p);
  // Full Stats shape: the boundary's local lane maps via `toWorkspaceStat`, which calls
  // isDirectory()/isFile()/isSymbolicLink() + reads ctimeMs/size/mtimeMs.
  const stat = (_p: string) =>
    Promise.resolve({
      isFile: () => true,
      isDirectory: () => false,
      isSymbolicLink: () => false,
      size: 10,
      mtimeMs: 1,
      ctimeMs: 1,
    } as never);
  // `fileIndexService` does `import fs from 'node:fs/promises'` then `fs.realpath`
  // — so the OVERRIDES must be on `default`, not just named exports.
  return {
    ...actual,
    default: { ...actual, realpath, stat },
    realpath,
    stat,
  };
});

// `node:fs` readlinkSync drives both the containment-map build and the verdict-key
// mint: the workspace symlink `Drive` → CLOUD_TARGET (cloud), everything else EINVAL.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: actual,
    readlinkSync: (p: string) => {
      if (typeof p === 'string' && p.endsWith(`${path.sep}Drive`)) return CLOUD_TARGET;
      throw makeEinval();
    },
  };
});

vi.mock('@core/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createScopedLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { needsReindexing, _setCurrentIndexForTesting, _isRecoverableSourceOnDiskForTesting } =
  await import('../fileIndexService');
const { configureCloudSpaceContainment, __resetCloudSpaceContainmentForTests } = await import(
  '@core/services/cloudSpaceContainment'
);
const { setCloudSymlinkIndexingEnabled, __resetCloudSymlinkIndexingForTests } = await import(
  '@core/services/cloudSymlinkIndexing'
);
const { setCloudLivenessProbe, __resetCloudLivenessProbeForTesting } = await import(
  '@core/services/cloudLivenessProbe'
);
const { setWorkspaceFsExecutor, __resetWorkspaceFsExecutorForTesting } = await import(
  '@core/services/boundedWorkspaceFs'
);

// Minimal index stub — `needsReindexing` only reads `getCurrentIndex()?.indexedMtimes`.
function installIndexWith(indexedPaths: string[]): void {
  const indexedMtimes = new Map<string, number>();
  for (const p of indexedPaths) indexedMtimes.set(p, 1);
  _setCurrentIndexForTesting({ indexedMtimes } as never);
}

describe('needsReindexing — S4.1c cloud index-read bounding via the boundary (site F2)', () => {
  beforeEach(() => {
    configureCloudSpaceContainment(CORE_DIR, [{ path: 'Drive', isSymlink: true } as never]);
    setCloudLivenessProbe({
      probeHealth: async () => 'healthy',
      getCachedVerdict: () => 'healthy',
    });
  });

  afterEach(() => {
    _setCurrentIndexForTesting(null);
    __resetCloudSpaceContainmentForTests();
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    __resetWorkspaceFsExecutorForTesting();
    vi.restoreAllMocks();
  });

  it('flag ON: a dead admitted cloud file DEFERS (returns false), does NOT hang', async () => {
    setCloudSymlinkIndexingEnabled(true);
    setWorkspaceFsExecutor(deadMountExecutor); // the mount is dead → cloud lane → reconnecting
    installIndexWith([CLOUD_FILE]); // file is indexed; the mount is now dead

    const result = await needsReindexing(CLOUD_FILE);
    // Deferred: reconnecting → CloudIndexReadTimeoutError → do NOT re-index the dead
    // mount; retain the entry. Bounded by the executor — no hang, no fake timers needed.
    expect(result).toBe(false);
  });

  it('flag OFF: a dead cloud mount is STILL bounded by the boundary (hang-safety is flag-independent)', async () => {
    __resetCloudSymlinkIndexingForTests(); // flag OFF
    setWorkspaceFsExecutor(deadMountExecutor);
    installIndexWith([CLOUD_FILE]);

    // S4.1c INTENDED behaviour change: the boundary bounds a cloud read by CONTAINMENT,
    // which is configured independently of the admission flag — so even with the flag
    // OFF a dead cloud mount degrades (returns false) instead of the pre-S4.1c bare
    // UNBOUNDED read that could hang. (In production cloud paths don't reach the indexer
    // with the flag off; this asserts the belt-and-braces read is hang-safe regardless.)
    const result = await needsReindexing(CLOUD_FILE);
    expect(result).toBe(false);
  });

  it('flag ON: a LOCAL file is unaffected — local lane (bare fs), executor NOT called', async () => {
    setCloudSymlinkIndexingEnabled(true);
    // If a LOCAL file ever wrongly took the cloud lane, these spies would fire (and the
    // dead-mount result would still be `false`, so the spy assertion is what catches it).
    const exec = realFsExecutorWith({
      stat: vi.fn(deadMountExecutor.stat),
      realpath: vi.fn(deadMountExecutor.realpath),
    });
    setWorkspaceFsExecutor(exec);
    installIndexWith([LOCAL_FILE]); // indexed at mtime 1; local-lane stat reports mtime 1 → no reindex

    const result = await needsReindexing(LOCAL_FILE);
    expect(result).toBe(false); // local, cached mtime == disk mtime → no reindex
    expect(exec.realpath).not.toHaveBeenCalled(); // local lane used fsp, not the cloud executor
    expect(exec.stat).not.toHaveBeenCalled();
  });

  it('flag ON + NON-healthy space: DEFERS without issuing ANY fs op (caps batch libuv-park; should-3)', async () => {
    setCloudSymlinkIndexingEnabled(true);
    // Space is degraded → must defer WITHOUT issuing realpath/stat. Spy the executor so
    // a wrongly-issued op is caught even though the deferred result is also `false`.
    setCloudLivenessProbe({ probeHealth: async () => 'degraded', getCachedVerdict: () => 'degraded' });
    const exec = realFsExecutorWith({
      realpath: vi.fn(deadMountExecutor.realpath),
      stat: vi.fn(deadMountExecutor.stat),
    });
    setWorkspaceFsExecutor(exec);
    installIndexWith([CLOUD_FILE]);

    const result = await needsReindexing(CLOUD_FILE);
    expect(result).toBe(false); // deferred by the FS-FREE disposition gate
    expect(exec.realpath).not.toHaveBeenCalled(); // NO fs op issued (defer-cloud short-circuit)
    expect(exec.stat).not.toHaveBeenCalled();
  });

  // S4.1c review F1: the post-purge recoverability probe must NOT collapse a transient
  // cloud-down into terminal "not recoverable" (which the repair sweep treats as
  // not_repairable and DROPS). A dead mount → reject with CloudIndexReadTimeoutError so
  // the caller maps it to the retryable `failed_after_purge`; a genuine fs error → false.
  it('isRecoverableSourceOnDisk: a dead cloud mount REJECTS (CloudIndexReadTimeoutError) so the repair defers, not converges', async () => {
    setWorkspaceFsExecutor(deadMountExecutor); // CLOUD_FILE is containment-cloud → cloud lane → reconnecting
    await expect(_isRecoverableSourceOnDiskForTesting(CLOUD_FILE)).rejects.toMatchObject({
      name: 'CloudIndexReadTimeoutError',
    });
  });

  it('isRecoverableSourceOnDisk: a genuine fs error (missing source) RESOLVES false (terminal), does NOT throw', async () => {
    setWorkspaceFsExecutor(realFsExecutor); // healthy mount → real fs; CLOUD_FILE is absent on disk → ENOENT
    await expect(_isRecoverableSourceOnDiskForTesting(CLOUD_FILE)).resolves.toBe(false);
  });
});
