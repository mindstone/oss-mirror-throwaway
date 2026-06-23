/**
 * Stage 1 (260622 render-preview-cloud-hang) — the distinguished-outcome, hang-bounded
 * Chief-of-Staff README reader. Mirrors the MA1 `readSpaceReadmeTextBounded` semantics
 * (README → legacy fallback; legacy ONLY on a genuinely-absent README) but on the
 * killable `workspaceFs` pool and returning a discriminated `ok|reconnecting|unreadable|absent`.
 *
 * Test mechanics:
 *  - CLOUD lane is driven by wiring an executor via `setWorkspaceFsExecutor` (the cloud
 *    lane never touches `fs`), so a "dead mount" is the `deadMountExecutor` double →
 *    every cloud read resolves `reconnecting` (no hang, no parked worker). The
 *    never-resolving baseline that PROVES the bound is exercised by the unwired-executor
 *    default + fake timers in the dedicated hang test.
 *  - LOCAL lane uses `node:fs/promises` (the boundary imports it), so the local cases
 *    are driven by the standard `vi.mock('node:fs/promises')` seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const CLOUD_TARGET =
  '/Users/test/Library/CloudStorage/GoogleDrive-user@example.com/Shared drives/Chief-of-Staff';
const LOCAL_DIR = path.resolve('/workspace/Chief-of-Staff');

function makeEnoent(): NodeJS.ErrnoException {
  const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}
function makeEacces(): NodeJS.ErrnoException {
  const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
  err.code = 'EACCES';
  return err;
}

const README_CONTENT = '# Chief of Staff\n\nlocal readme body\n';
const LEGACY_CONTENT = '# Chief of Staff (legacy)\n\nlegacy body\n';

// LOCAL lane only: the boundary uses `node:fs/promises` for LOCAL paths. Drive
// per-test behaviour through `mockReadFile`.
const mockReadFile = vi.fn();
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const readFile = (...args: unknown[]) => mockReadFile(...args);
  return { ...actual, default: { ...actual, readFile }, readFile };
});

vi.mock('@core/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createScopedLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const { readSpaceReadmeBounded } = await import('../boundedSpaceReadmeReader');
const { setWorkspaceFsExecutor, __resetWorkspaceFsExecutorForTesting } = await import(
  '../boundedWorkspaceFs'
);
const { __resetCloudSpaceContainmentForTests } = await import('../cloudSpaceContainment');
const { realFsExecutorWith } = await import('./workspaceFsExecutorDoubles');

describe('readSpaceReadmeBounded — distinguished, hang-bounded space README read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSpaceContainmentForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSpaceContainmentForTests();
  });

  it('LOCAL README present → ok, source readme, byte-identical content', async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).endsWith('README.md')) return README_CONTENT;
      throw makeEnoent();
    });
    const outcome = await readSpaceReadmeBounded(LOCAL_DIR);
    expect(outcome).toEqual({ status: 'ok', content: README_CONTENT, source: 'readme' });
  });

  it('LOCAL README absent → falls back to legacy AGENTS.md → ok, source legacy', async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).endsWith('README.md')) throw makeEnoent();
      if (String(p).endsWith('AGENTS.md')) return LEGACY_CONTENT;
      throw makeEnoent();
    });
    const outcome = await readSpaceReadmeBounded(LOCAL_DIR);
    expect(outcome).toEqual({ status: 'ok', content: LEGACY_CONTENT, source: 'legacy' });
  });

  it('LOCAL README + legacy both absent → absent', async () => {
    mockReadFile.mockImplementation(async () => {
      throw makeEnoent();
    });
    const outcome = await readSpaceReadmeBounded(LOCAL_DIR);
    expect(outcome).toEqual({ status: 'absent' });
  });

  it('LOCAL README present-but-unreadable (EACCES) → unreadable, NO legacy retry', async () => {
    const reads: string[] = [];
    mockReadFile.mockImplementation(async (p: unknown) => {
      reads.push(String(p));
      if (String(p).endsWith('README.md')) throw makeEacces();
      // Legacy WOULD have content — must NOT be read on an unreadable README.
      if (String(p).endsWith('AGENTS.md')) return LEGACY_CONTENT;
      throw makeEnoent();
    });
    const outcome = await readSpaceReadmeBounded(LOCAL_DIR);
    expect(outcome).toEqual({ status: 'unreadable' });
    // The legacy path must never have been read (no second read on unreadable).
    expect(reads.some((r) => r.endsWith('AGENTS.md'))).toBe(false);
  });

  it('CLOUD README on a DEAD mount → reconnecting (NOT a hang), NO legacy retry', async () => {
    // The CoS path is an explicitly-named cloud root (~/Library/CloudStorage/…), so
    // `cloudLaneOptionForPath` forces the cloud lane (containment not required). Wire an
    // executor that records reads and times out (a dead mount).
    const cloudReads: string[] = [];
    setWorkspaceFsExecutor(
      realFsExecutorWith({
        readFile: async (p) => {
          cloudReads.push(p);
          return { ok: false, reason: 'timeout' };
        },
      }),
    );
    const outcome = await readSpaceReadmeBounded(CLOUD_TARGET);
    expect(outcome).toEqual({ status: 'reconnecting' });
    // Only the README was attempted — never a second (legacy) cloud read.
    expect(cloudReads).toHaveLength(1);
    expect(cloudReads[0]).toBe(path.join(CLOUD_TARGET, 'README.md'));
  });

  it('CLOUD README with NO executor wired takes the LOCAL bare-fs lane (NOT reconnecting) — cross-surface byte-identical (S4.1e final-review F1)', async () => {
    // dev's S4.1e final-review F1 (boundedWorkspaceFs commit 7346625139) changed the
    // contract: with NO executor wired — the cloud/mobile shape AND the desktop
    // pre-bootstrap window — there is nothing to bound the read WITH and no FUSE mount
    // to bound AGAINST, so a cloud-classified path reads LOCALLY byte-identically rather
    // than degrading to a spurious `reconnecting`. (This test previously asserted
    // `reconnecting`; that encoded the cross-surface bug dev fixed.) The desktop
    // dead-mount → `reconnecting` guarantee is covered by the wired-executor "DEAD mount"
    // test above (the executor wires at startup before any real cloud routing).
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).endsWith('README.md')) return README_CONTENT;
      throw makeEnoent();
    });
    const outcome = await readSpaceReadmeBounded(`${CLOUD_TARGET}/`);
    expect(outcome).toEqual({ status: 'ok', content: README_CONTENT, source: 'readme' });
  });

  // F4 (folded Stage-1 follow-up): the README-absent → LEGACY branch outcomes.
  it('F4: README absent (ENOENT) → legacy AGENTS.md UNREADABLE (EACCES) → unreadable', async () => {
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).endsWith('README.md')) throw makeEnoent();
      if (String(p).endsWith('AGENTS.md')) throw makeEacces();
      throw makeEnoent();
    });
    const outcome = await readSpaceReadmeBounded(LOCAL_DIR);
    expect(outcome).toEqual({ status: 'unreadable' });
  });

  it('F4: README absent → legacy read RECONNECTING (dead cloud mount) → reconnecting', async () => {
    // Cloud lane: README read returns absent (ENOENT) so the reader falls through to
    // legacy; the legacy read then times out (dead mount) → reconnecting, NO hang.
    const cloudReads: string[] = [];
    setWorkspaceFsExecutor(
      realFsExecutorWith({
        readFile: async (p) => {
          cloudReads.push(p);
          if (p.endsWith('README.md')) {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            return { ok: false, reason: 'error', error: err };
          }
          return { ok: false, reason: 'timeout' };
        },
      }),
    );
    const outcome = await readSpaceReadmeBounded(CLOUD_TARGET);
    expect(outcome).toEqual({ status: 'reconnecting' });
    // README (absent) then legacy (timeout) — exactly two cloud reads.
    expect(cloudReads).toEqual([
      path.join(CLOUD_TARGET, 'README.md'),
      path.join(CLOUD_TARGET, 'AGENTS.md'),
    ]);
  });
});

// F1 (folded Stage-1 follow-up): a CoS path under a CONTAINMENT-routed cloud space
// (a real `/workspace/Chief-of-Staff` symlink to a cloud target, classified cloud via
// `configureCloudSpaceContainment` — NOT the explicit `/Library/CloudStorage/…` shape
// Stage 1 already tested). Proves the containment lane (not just the pattern lane)
// drives the reader's cloud bound.
describe('readSpaceReadmeBounded — F1 containment-routed cloud space (symlink, not pattern)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSpaceContainmentForTests();
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    // Use the REAL fs for the temp scaffolding (the mock only intercepts the local
    // READ lane; mkdtemp/mkdir/symlink call through to actual via the `...actual` spread).
    tmpRoot = await (fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'cos-containment-'))));
  });
  afterEach(async () => {
    vi.useRealTimers();
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSpaceContainmentForTests();
    const fs = await import('node:fs/promises');
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('a CoS README under a containment-classified cloud symlink → cloud lane → reconnecting on a dead mount', async () => {
    const fs = await import('node:fs/promises');
    const { configureCloudSpaceContainment } = await import('../cloudSpaceContainment');

    const workspace = path.join(tmpRoot, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    // Dead cloud target (Dropbox-shaped path the classifier flags; target need not exist —
    // containment is readlink-only). The LOGICAL CoS path is the plain workspace path.
    const cloudTarget = path.join(tmpRoot, 'cloud-store', 'Dropbox', 'Chief-of-Staff');
    const logicalCos = path.join(workspace, 'Chief-of-Staff');
    await fs.symlink(cloudTarget, logicalCos);

    // Classify the LOGICAL path as cloud via containment (NOT via the path's own shape:
    // `/tmp/.../workspace/Chief-of-Staff` is pattern-LOCAL).
    configureCloudSpaceContainment(workspace, [
      { name: 'Chief-of-Staff', path: 'Chief-of-Staff', type: 'chief-of-staff', isSymlink: true, createdAt: 1 },
    ]);

    // Wire a dead-mount cloud executor: every cloud read times out.
    const cloudReads: string[] = [];
    setWorkspaceFsExecutor(
      realFsExecutorWith({
        readFile: async (p) => {
          cloudReads.push(p);
          return { ok: false, reason: 'timeout' };
        },
      }),
    );

    const outcome = await readSpaceReadmeBounded(logicalCos);
    expect(outcome).toEqual({ status: 'reconnecting' });
    // Containment routed the LOGICAL path to the cloud lane (the read used the executor,
    // not the local fs mock) and stopped at the first reconnecting (no legacy retry).
    expect(cloudReads).toEqual([path.join(logicalCos, 'README.md')]);
  });
});

// rd4-F1 REGRESSION FENCE (260622 postmortem rec #2): the caller's `forceCloud` flag,
// on a path the boundary classifies LOCAL by BOTH pattern AND containment. This is the
// exact recurring hole: a Chief-of-Staff SYMLINK dropped from `settings.spaces` has a
// pattern-LOCAL workspace path and is absent from containment, so neither boundary
// classifier can route it cloud — only the gate's `forceCloud` (derived from its own
// scan-discovered-symlink evidence) can. The existing suites above cover the pattern
// lane (`/Library/CloudStorage/…`) and the containment lane (a configured symlink space)
// but NOT this forceCloud-on-a-pattern-local-path plumbing — which is precisely the bit
// that recurred. If a future edit drops the reader's `forceCloud` honoring, a dead Drive
// target takes the bare-fs LOCAL lane and HANGS the turn; this fence fails first.
describe('readSpaceReadmeBounded — rd4 forceCloud on a pattern-LOCAL, uncontained path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSpaceContainmentForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetWorkspaceFsExecutorForTesting();
    __resetCloudSpaceContainmentForTests();
  });

  it('forceCloud:true routes a LOCAL-classified CoS path through the killable cloud lane → reconnecting, and the bare-fs LOCAL lane is never touched', async () => {
    // LOCAL_DIR is pattern-local and NOT in containment (no configureCloudSpaceContainment
    // call) → the boundary alone would say 'local'. Wire a dead-mount executor.
    const cloudReads: string[] = [];
    setWorkspaceFsExecutor(
      realFsExecutorWith({
        readFile: async (p) => {
          cloudReads.push(p);
          return { ok: false, reason: 'timeout' };
        },
      }),
    );
    // The local lane (mockReadFile) WOULD return content if reached — it must not be.
    mockReadFile.mockResolvedValue(README_CONTENT);

    const outcome = await readSpaceReadmeBounded(LOCAL_DIR, { forceCloud: true });

    expect(outcome).toEqual({ status: 'reconnecting' });
    // Cloud lane engaged (executor saw the README read); the bare-fs local lane never ran.
    expect(cloudReads).toEqual([path.join(LOCAL_DIR, 'README.md')]);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('forceCloud:true ALSO forces the legacy AGENTS.md fallback (README absent) through the cloud lane → reconnecting, bare-fs never touched', async () => {
    // The reader threads `forceCloud` into BOTH the README and the legacy reads. This
    // fences the SECOND branch (GPT review): a future edit like
    // `readOneFileBounded(legacyPath, …, /* forceCloud */ false)` would leave the legacy
    // fallback on the bare-fs LOCAL lane → hang on a dead mount. README returns absent
    // (ENOENT) via the executor so the reader falls through to legacy, which times out.
    const cloudReads: string[] = [];
    setWorkspaceFsExecutor(
      realFsExecutorWith({
        readFile: async (p) => {
          cloudReads.push(p);
          if (p.endsWith('README.md')) {
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            return { ok: false, reason: 'error', error: err };
          }
          return { ok: false, reason: 'timeout' };
        },
      }),
    );
    // The local lane WOULD serve the legacy file if reached — it must not be.
    mockReadFile.mockResolvedValue(LEGACY_CONTENT);

    const outcome = await readSpaceReadmeBounded(LOCAL_DIR, { forceCloud: true });

    expect(outcome).toEqual({ status: 'reconnecting' });
    // BOTH reads went through the cloud lane (README absent → legacy timeout); bare fs never ran.
    expect(cloudReads).toEqual([
      path.join(LOCAL_DIR, 'README.md'),
      path.join(LOCAL_DIR, 'AGENTS.md'),
    ]);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('baseline (NO forceCloud): the same LOCAL path reads on the bare-fs lane → ok (proves the fence is discriminating)', async () => {
    // Same wedged executor wired; without forceCloud the pattern-local path takes the
    // bare-fs LOCAL lane (never touches the executor).
    setWorkspaceFsExecutor(
      realFsExecutorWith({
        readFile: async () => ({ ok: false, reason: 'timeout' }),
      }),
    );
    mockReadFile.mockImplementation(async (p: unknown) => {
      if (String(p).endsWith('README.md')) return README_CONTENT;
      throw makeEnoent();
    });

    const outcome = await readSpaceReadmeBounded(LOCAL_DIR);

    expect(outcome).toEqual({ status: 'ok', content: README_CONTENT, source: 'readme' });
    expect(mockReadFile).toHaveBeenCalled();
  });
});
