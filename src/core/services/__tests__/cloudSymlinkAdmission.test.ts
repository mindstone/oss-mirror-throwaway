/**
 * Stage 6b — `resolveCloudSymlinkAdmission` + the `isCloudSymlinkIndexingEnabled`
 * flag accessor.
 *
 * The shared admission decision the three descent decision points consult:
 *  - flag OFF (default) ⇒ always `'skip'` (byte-identical to today), with NO key
 *    mint / verdict read (the fast path);
 *  - flag ON + verdict `healthy` ⇒ `'admit'`;
 *  - flag ON + `degraded`/`unknown` ⇒ `'skip'`;
 *  - an unclassifiable chain (readlink can't prove cloud) ⇒ `'skip'` (fail closed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CLOUD_SYMLINK = '/Users/test/ws/Company Memories';
const CLOUD_TARGET =
  '/Users/test/Library/CloudStorage/GoogleDrive-test@example.com/Shared drives/Company Memories';
const LOCAL_SYMLINK = '/Users/test/ws/Notes';
const LOCAL_TARGET = '/Users/test/Projects/notes';
const DANGLING_SYMLINK = '/Users/test/ws/Dead';

function einval(): NodeJS.ErrnoException {
  return Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
}
function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

const readlinkSyncSpy = vi.fn((p: string) => {
  if (p === CLOUD_SYMLINK) return CLOUD_TARGET;
  if (p === LOCAL_SYMLINK) return LOCAL_TARGET;
  if (p === DANGLING_SYMLINK) throw enoent(); // dead first hop → unclassifiable
  throw einval(); // a real (non-symlink) path → terminus
});
vi.mock('node:fs', () => ({ readlinkSync: (p: string) => readlinkSyncSpy(p) }));

import {
  setCloudLivenessProbe,
  __resetCloudLivenessProbeForTesting,
  type CloudHealthVerdict,
} from '@core/services/cloudLivenessProbe';
import {
  setCloudSymlinkIndexingEnabled,
  isCloudSymlinkIndexingEnabled,
  resolveCloudSymlinkAdmission,
  resolveSpaceSyncStatus,
  __resetCloudSymlinkIndexingForTests,
} from '@core/services/cloudSymlinkIndexing';

const getCachedVerdictSpy = vi.fn<(t: string) => CloudHealthVerdict>(() => 'healthy');
const getDisplayVerdictSpy = vi.fn<(t: string) => CloudHealthVerdict>(() => 'healthy');
function installProbe(): void {
  setCloudLivenessProbe({
    probeHealth: async () => 'healthy',
    getCachedVerdict: (target) => getCachedVerdictSpy(target),
    getDisplayVerdict: (target) => getDisplayVerdictSpy(target),
  });
}

describe('cloudSymlinkIndexing flag accessor', () => {
  beforeEach(() => __resetCloudSymlinkIndexingForTests());
  afterEach(() => __resetCloudSymlinkIndexingForTests());

  it('defaults to false', () => {
    expect(isCloudSymlinkIndexingEnabled()).toBe(false);
  });
  it('mirrors the set value; undefined coerces to false', () => {
    setCloudSymlinkIndexingEnabled(true);
    expect(isCloudSymlinkIndexingEnabled()).toBe(true);
    setCloudSymlinkIndexingEnabled(undefined);
    expect(isCloudSymlinkIndexingEnabled()).toBe(false);
  });
});

describe('resolveCloudSymlinkAdmission', () => {
  beforeEach(() => {
    readlinkSyncSpy.mockClear();
    getCachedVerdictSpy.mockClear();
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    installProbe();
  });
  afterEach(() => {
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
  });

  it('flag OFF ⇒ skip, with NO key mint or verdict read (fast path)', () => {
    expect(resolveCloudSymlinkAdmission(CLOUD_SYMLINK)).toBe('skip');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
    expect(getCachedVerdictSpy).not.toHaveBeenCalled();
  });

  it('flag ON + healthy verdict ⇒ admit (verdict keyed by the first cloud hop)', () => {
    setCloudSymlinkIndexingEnabled(true);
    getCachedVerdictSpy.mockReturnValue('healthy');
    expect(resolveCloudSymlinkAdmission(CLOUD_SYMLINK)).toBe('admit');
    expect(getCachedVerdictSpy).toHaveBeenCalledWith(CLOUD_TARGET);
  });

  it('flag ON + degraded ⇒ skip', () => {
    setCloudSymlinkIndexingEnabled(true);
    getCachedVerdictSpy.mockReturnValue('degraded');
    expect(resolveCloudSymlinkAdmission(CLOUD_SYMLINK)).toBe('skip');
  });

  it('flag ON + unknown ⇒ skip', () => {
    setCloudSymlinkIndexingEnabled(true);
    getCachedVerdictSpy.mockReturnValue('unknown');
    expect(resolveCloudSymlinkAdmission(CLOUD_SYMLINK)).toBe('skip');
  });

  it('flag ON + a LOCAL symlink ⇒ skip (not cloud → null key → no admission)', () => {
    setCloudSymlinkIndexingEnabled(true);
    // A local-terminus chain mints a null key → skip; never reads a verdict.
    expect(resolveCloudSymlinkAdmission(LOCAL_SYMLINK)).toBe('skip');
    expect(getCachedVerdictSpy).not.toHaveBeenCalled();
  });

  it('flag ON + an UNCLASSIFIABLE chain (dead first hop) ⇒ skip (fail closed)', () => {
    setCloudSymlinkIndexingEnabled(true);
    getCachedVerdictSpy.mockReturnValue('healthy');
    expect(resolveCloudSymlinkAdmission(DANGLING_SYMLINK)).toBe('skip');
    expect(getCachedVerdictSpy).not.toHaveBeenCalled();
  });
});

describe('resolveSpaceSyncStatus (Stage 8 — per-space UI signal producer)', () => {
  beforeEach(() => {
    readlinkSyncSpy.mockClear();
    getDisplayVerdictSpy.mockClear();
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    installProbe();
  });
  afterEach(() => {
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
  });

  it('flag OFF ⇒ healthy (inert), with NO readlink or verdict read (fast path)', () => {
    expect(resolveSpaceSyncStatus(CLOUD_SYMLINK)).toBe('healthy');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
    expect(getDisplayVerdictSpy).not.toHaveBeenCalled();
  });

  it('flag OFF ⇒ healthy even for a dangling symlink (fully inert)', () => {
    expect(resolveSpaceSyncStatus(DANGLING_SYMLINK)).toBe('healthy');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
  });

  it('flag ON + a healthy cloud mount ⇒ healthy (no signal), keyed by the first cloud hop', () => {
    setCloudSymlinkIndexingEnabled(true);
    getDisplayVerdictSpy.mockReturnValue('healthy');
    expect(resolveSpaceSyncStatus(CLOUD_SYMLINK)).toBe('healthy');
    // Reads the DEBOUNCED display verdict (NOT the raw getCachedVerdict).
    expect(getDisplayVerdictSpy).toHaveBeenCalledWith(CLOUD_TARGET);
    expect(getCachedVerdictSpy).not.toHaveBeenCalled();
  });

  it('flag ON + degraded display verdict ⇒ reconnecting', () => {
    setCloudSymlinkIndexingEnabled(true);
    getDisplayVerdictSpy.mockReturnValue('degraded');
    expect(resolveSpaceSyncStatus(CLOUD_SYMLINK)).toBe('reconnecting');
  });

  it('flag ON + unknown display verdict (not yet probed) ⇒ reconnecting', () => {
    setCloudSymlinkIndexingEnabled(true);
    getDisplayVerdictSpy.mockReturnValue('unknown');
    expect(resolveSpaceSyncStatus(CLOUD_SYMLINK)).toBe('reconnecting');
  });

  it('flag ON + a dangling cloud symlink (ENOENT) ⇒ not_found (structurally gone)', () => {
    setCloudSymlinkIndexingEnabled(true);
    expect(resolveSpaceSyncStatus(DANGLING_SYMLINK)).toBe('not_found');
    // Never reads a verdict for a structurally-gone link.
    expect(getDisplayVerdictSpy).not.toHaveBeenCalled();
  });

  it('flag ON + a genuinely LOCAL symlink ⇒ healthy (no cloud mount, no signal)', () => {
    setCloudSymlinkIndexingEnabled(true);
    expect(resolveSpaceSyncStatus(LOCAL_SYMLINK)).toBe('healthy');
    expect(getDisplayVerdictSpy).not.toHaveBeenCalled();
  });
});

describe('resolveSpaceSyncStatus — cloud-root-safe path (readlink hardening)', () => {
  beforeEach(() => {
    readlinkSyncSpy.mockClear();
    getDisplayVerdictSpy.mockClear();
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
    installProbe();
    setCloudSymlinkIndexingEnabled(true);
  });
  afterEach(() => {
    __resetCloudSymlinkIndexingForTests();
    __resetCloudLivenessProbeForTesting();
  });

  it('rootIsCloud + cloud sourcePath + healthy ⇒ healthy, ZERO readlink (key from sourcePath)', () => {
    getDisplayVerdictSpy.mockReturnValue('healthy');
    expect(
      resolveSpaceSyncStatus(CLOUD_SYMLINK, { rootIsCloud: true, sourcePath: CLOUD_TARGET }),
    ).toBe('healthy');
    expect(readlinkSyncSpy).not.toHaveBeenCalled(); // never touched the link inode
    expect(getDisplayVerdictSpy).toHaveBeenCalledWith(CLOUD_TARGET);
  });

  it('rootIsCloud + cloud sourcePath + degraded ⇒ reconnecting, ZERO readlink', () => {
    getDisplayVerdictSpy.mockReturnValue('degraded');
    expect(
      resolveSpaceSyncStatus(CLOUD_SYMLINK, { rootIsCloud: true, sourcePath: CLOUD_TARGET }),
    ).toBe('reconnecting');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
  });

  it('rootIsCloud + missing / non-cloud sourcePath ⇒ healthy (no spurious badge), no readlink/verdict', () => {
    expect(resolveSpaceSyncStatus(CLOUD_SYMLINK, { rootIsCloud: true })).toBe('healthy');
    expect(
      resolveSpaceSyncStatus(CLOUD_SYMLINK, { rootIsCloud: true, sourcePath: LOCAL_TARGET }),
    ).toBe('healthy');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
    expect(getDisplayVerdictSpy).not.toHaveBeenCalled();
  });

  it('rootIsCloud NEVER returns not_found, even for a (would-be dangling) link — we cannot prove "gone" without touching it', () => {
    // The trade-off: under a cloud root we forgo the ENOENT not_found discrimination.
    // A degraded/unknown verdict surfaces the calmer reconnecting, never not_found.
    getDisplayVerdictSpy.mockReturnValue('unknown');
    const status = resolveSpaceSyncStatus(DANGLING_SYMLINK, {
      rootIsCloud: true,
      sourcePath: CLOUD_TARGET,
    });
    expect(status).toBe('reconnecting');
    expect(status).not.toBe('not_found');
    expect(readlinkSyncSpy).not.toHaveBeenCalled();
  });

  it('LOCAL root (rootIsCloud false / omitted) keeps full-fidelity readlink walk incl. not_found', () => {
    // Regression guard: the default path is unchanged — it still readlinks and still
    // distinguishes the structurally-gone not_found state.
    expect(resolveSpaceSyncStatus(DANGLING_SYMLINK, { rootIsCloud: false })).toBe('not_found');
    expect(resolveSpaceSyncStatus(DANGLING_SYMLINK)).toBe('not_found');
    expect(readlinkSyncSpy).toHaveBeenCalledWith(DANGLING_SYMLINK);
  });
});
