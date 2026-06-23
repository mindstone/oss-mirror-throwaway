/**
 * Stage 1 tests for the cloud-liveness probe contract + by-construction safety
 * types. Pure unit tests — no child process, no real Drive, no consumer wiring.
 *
 * What these lock:
 *  - the default probe returns `unknown` for everything (== today's behaviour);
 *  - the consult is a TOTAL function: a probe impl that throws/rejects still
 *    yields `unknown` (RS-F5 — never escapes to a caller that might admit/purge);
 *  - `mintReadlinkResolvedTargetSync` is readlink-only (does not realpath/stat;
 *    a dangling symlink does not throw/hang and returns `null`);
 *  - `tryBuildAbsenceProof` returns `null` unless root non-null + complete +
 *    healthy + matching root (the F1 `rootRealPath:null` hole is closed).
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type CloudHealthVerdict,
  type CloudLivenessProbe,
  type ReadlinkResolvedTarget,
  __resetCloudLivenessProbeForTesting,
  getCloudLivenessProbe,
  setCloudLivenessProbe,
} from '@core/services/cloudLivenessProbe';
import {
  type AbsenceProofInput,
  mintFirstCloudHopTargetSync,
  mintReadlinkResolvedTargetSync,
  toNonNullRealPath,
  tryBuildAbsenceProof,
} from '@core/services/cloudLivenessProbe.types';

// A helper to brand an arbitrary string as a target for tests that don't care
// how the target was minted (the brand is a compile-time-only marker).
const asTarget = (s: string): ReadlinkResolvedTarget => s as ReadlinkResolvedTarget;

describe('cloudLivenessProbe — default probe', () => {
  afterEach(() => {
    __resetCloudLivenessProbeForTesting();
  });

  it('returns a usable probe at import (never undefined, never throws)', () => {
    const probe = getCloudLivenessProbe();
    expect(probe).toBeDefined();
    expect(typeof probe.getCachedVerdict).toBe('function');
    expect(typeof probe.probeHealth).toBe('function');
  });

  it('default getCachedVerdict returns unknown for everything', () => {
    const probe = getCloudLivenessProbe();
    expect(probe.getCachedVerdict(asTarget('/anything'))).toBe('unknown');
    expect(probe.getCachedVerdict(asTarget(''))).toBe('unknown');
  });

  it('default probeHealth resolves unknown for everything', async () => {
    const probe = getCloudLivenessProbe();
    await expect(probe.probeHealth(asTarget('/anything'))).resolves.toBe('unknown');
  });
});

describe('cloudLivenessProbe — RS-F5 totality (never throws / rejects)', () => {
  afterEach(() => {
    __resetCloudLivenessProbeForTesting();
  });

  it('getCachedVerdict collapses a throwing impl to unknown', () => {
    const throwing: CloudLivenessProbe = {
      getCachedVerdict: () => {
        throw new Error('boom');
      },
      probeHealth: async () => 'healthy',
    };
    setCloudLivenessProbe(throwing);
    expect(getCloudLivenessProbe().getCachedVerdict(asTarget('/x'))).toBe('unknown');
  });

  it('probeHealth collapses a rejecting impl to unknown', async () => {
    const rejecting: CloudLivenessProbe = {
      getCachedVerdict: () => 'healthy',
      probeHealth: async () => {
        throw new Error('boom');
      },
    };
    setCloudLivenessProbe(rejecting);
    await expect(getCloudLivenessProbe().probeHealth(asTarget('/x'))).resolves.toBe('unknown');
  });

  it('a well-behaved wired probe is consulted normally', async () => {
    const verdict: CloudHealthVerdict = 'healthy';
    const good: CloudLivenessProbe = {
      getCachedVerdict: () => verdict,
      probeHealth: async () => verdict,
    };
    setCloudLivenessProbe(good);
    expect(getCloudLivenessProbe().getCachedVerdict(asTarget('/x'))).toBe('healthy');
    await expect(getCloudLivenessProbe().probeHealth(asTarget('/x'))).resolves.toBe('healthy');
  });

  it('reset restores the unknown default', () => {
    setCloudLivenessProbe({
      getCachedVerdict: () => 'healthy',
      probeHealth: async () => 'healthy',
    });
    __resetCloudLivenessProbeForTesting();
    expect(getCloudLivenessProbe().getCachedVerdict(asTarget('/x'))).toBe('unknown');
  });
});

describe('mintReadlinkResolvedTargetSync — readlink-only', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloud-liveness-mint-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the absolute input for a non-symlink path (hops 0)', () => {
    const realFile = join(dir, 'real.txt');
    writeFileSync(realFile, 'hi');
    const minted = mintReadlinkResolvedTargetSync(realFile);
    // realpathSync resolves /var → /private/var on macOS; the minter does NOT,
    // so compare against the input, not its realpath.
    expect(minted).toBe(realFile);
  });

  it('resolves a symlink chain to its terminus via readlink only', () => {
    const realDir = join(dir, 'target-dir');
    mkdirSync(realDir);
    const link = join(dir, 'link-to-dir');
    symlinkSync(realDir, link);
    const minted = mintReadlinkResolvedTargetSync(link);
    expect(minted).toBe(realDir);
  });

  it('returns null for a DANGLING symlink without throwing or hanging', () => {
    // A symlink whose target does not exist stands in for a dead mount: realpath
    // would throw/block here, but readlink reads the local link inode and the
    // chain "bottoms out" at a non-symlink path that does not exist → the next
    // readlink throws ENOENT → broken → null. The key assertion is no throw.
    const missingTarget = join(dir, 'does-not-exist');
    const dangling = join(dir, 'dangling-link');
    symlinkSync(missingTarget, dangling);

    let minted: ReadlinkResolvedTarget | null = asTarget('sentinel');
    expect(() => {
      minted = mintReadlinkResolvedTargetSync(dangling);
    }).not.toThrow();
    expect(minted).toBeNull();
  });

  it('does NOT dereference the target (proves readlink-only, not realpath)', () => {
    // Point a symlink at a path under a non-existent "mount". realpathSync on the
    // link MUST throw (target missing); the minter must NOT throw and must NOT
    // return the dereferenced realpath — it returns null (broken chain).
    const fakeMount = join(dir, 'fake-dead-mount', 'inner');
    const link = join(dir, 'into-dead-mount');
    symlinkSync(fakeMount, link);

    expect(() => realpathSync(link)).toThrow(); // baseline: realpath WOULD blow up
    expect(() => mintReadlinkResolvedTargetSync(link)).not.toThrow();
    expect(mintReadlinkResolvedTargetSync(link)).toBeNull();
  });
});

describe('mintFirstCloudHopTargetSync — stop-at-first-cloud-hop, readlink-only', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cloud-liveness-firstcloud-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the cloud target for a DIRECT cloud symlink (dead mount, never dereferenced)', () => {
    const cloudTarget = join(dir, 'Library', 'CloudStorage', 'GoogleDrive-x', 'General');
    const link = join(dir, 'General');
    symlinkSync(cloudTarget, link);
    expect(() => realpathSync(link)).toThrow(); // baseline: realpath WOULD block/throw
    expect(mintFirstCloudHopTargetSync(link)).toBe(cloudTarget);
  });

  it('follows an intermediate LOCAL alias to the cloud hop (the F1 chained topology)', () => {
    // workspace/link → ~/DriveAlias (local) → ~/Library/CloudStorage/... (cloud).
    // The first-hop minter would classify ~/DriveAlias as non-cloud and DROP it;
    // this minter walks the local alias and stops at the cloud hop.
    const cloudTarget = join(dir, 'Library', 'CloudStorage', 'GoogleDrive-x', 'Shared drives', 'Co');
    const localAlias = join(dir, 'DriveAlias');
    symlinkSync(cloudTarget, localAlias); // alias → cloud (target need not exist)
    const link = join(dir, 'General');
    symlinkSync(localAlias, link); // link → alias
    expect(mintFirstCloudHopTargetSync(link)).toBe(cloudTarget);
  });

  it('STOPS at the first cloud hop — never readlinks past it into the (dead) mount', () => {
    // link → CloudStorage/.../inner-link, where inner-link is itself a symlink
    // INSIDE the mount. A walker that readlinked past the cloud hop would touch
    // inner-link's inode (which lives in the dead mount). We must stop at the first
    // cloud hop and return IT, never dereferencing the inner link.
    const innerLinkInMount = join(dir, 'Library', 'CloudStorage', 'GoogleDrive-x', 'inner-link');
    const link = join(dir, 'General');
    symlinkSync(innerLinkInMount, link);
    expect(mintFirstCloudHopTargetSync(link)).toBe(innerLinkInMount);
  });

  it('returns null for a genuinely-local symlink chain (non-cloud terminus → not a prewarm target)', () => {
    // rebel-system → /Applications/... style: a real local terminus, never cloud.
    const realDir = join(dir, 'Applications', 'RebelSystem');
    mkdirSync(realDir, { recursive: true });
    const link = join(dir, 'rebel-system');
    symlinkSync(realDir, link);
    expect(mintFirstCloudHopTargetSync(link)).toBeNull();
  });

  it('returns null for a non-symlink path (EINVAL, fail closed)', () => {
    const realFile = join(dir, 'real.txt');
    writeFileSync(realFile, 'hi');
    expect(mintFirstCloudHopTargetSync(realFile)).toBeNull();
  });

  it('returns null (fail closed) for a dangling LOCAL chain that cannot be proven cloud', () => {
    // link → missing local path (no cloud hop, broken before a terminus) → null.
    const missingLocal = join(dir, 'does-not-exist-local');
    const link = join(dir, 'dangling');
    symlinkSync(missingLocal, link);
    let minted: ReadlinkResolvedTarget | null = asTarget('sentinel');
    expect(() => {
      minted = mintFirstCloudHopTargetSync(link);
    }).not.toThrow();
    expect(minted).toBeNull();
  });

  it('classifies a RELATIVE cloud link by its parent-resolved form', () => {
    // A relative link whose cloud-ness only shows once joined to the parent dir.
    mkdirSync(join(dir, 'workspace'), { recursive: true });
    const link = join(dir, 'workspace', 'General');
    symlinkSync('../Library/CloudStorage/GoogleDrive-x/General', link);
    expect(mintFirstCloudHopTargetSync(link)).toBe(
      resolve(dir, 'workspace', '../Library/CloudStorage/GoogleDrive-x/General'),
    );
  });
});

describe('toNonNullRealPath', () => {
  it('rejects null/undefined/empty/whitespace', () => {
    expect(toNonNullRealPath(null)).toBeNull();
    expect(toNonNullRealPath(undefined)).toBeNull();
    expect(toNonNullRealPath('')).toBeNull();
    expect(toNonNullRealPath('   ')).toBeNull();
  });

  it('accepts a non-empty string', () => {
    expect(toNonNullRealPath('/Users/x/space')).toBe('/Users/x/space');
  });
});

describe('tryBuildAbsenceProof — F1 hole closed', () => {
  const base: AbsenceProofInput = {
    spaceRoot: '/Users/x/space',
    walkRootRealPath: '/Users/x/space',
    isComplete: true,
    verdict: 'healthy',
    healthGeneration: 7,
  };

  it('builds a proof when root non-null + complete + healthy + matching', () => {
    const proof = tryBuildAbsenceProof(base);
    expect(proof).not.toBeNull();
    expect(proof?.spaceRoot).toBe('/Users/x/space');
    expect(proof?.isComplete).toBe(true);
    expect(proof?.verdict).toBe('healthy');
    expect(proof?.healthGeneration).toBe(7);
  });

  it('returns null when verdict is degraded', () => {
    expect(tryBuildAbsenceProof({ ...base, verdict: 'degraded' })).toBeNull();
  });

  it('returns null when verdict is unknown', () => {
    expect(tryBuildAbsenceProof({ ...base, verdict: 'unknown' })).toBeNull();
  });

  it('returns null when the walk is incomplete', () => {
    expect(tryBuildAbsenceProof({ ...base, isComplete: false })).toBeNull();
  });

  it('returns null when walkRootRealPath is null (the F1 hole)', () => {
    expect(tryBuildAbsenceProof({ ...base, walkRootRealPath: null })).toBeNull();
  });

  it('returns null when spaceRoot is null', () => {
    expect(tryBuildAbsenceProof({ ...base, spaceRoot: null })).toBeNull();
  });

  it('returns null when the walked root does not match the space root', () => {
    expect(
      tryBuildAbsenceProof({ ...base, walkRootRealPath: '/Users/x/OTHER' }),
    ).toBeNull();
  });
});
