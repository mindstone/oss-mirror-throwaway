import { describe, it, expect } from 'vitest';
import { classifyPin, type RunGit, type GitResult, type SubmoduleEntry } from '../lib/submodulePinAncestry';

/**
 * Unit tests for the shared submodule-pin-ancestry classifier, driven by an
 * injected fake `RunGit` so we can exercise the ONLINE (fetch:true) decision
 * table — including the F1 regression: a fetch failure against a present-but-stale
 * ref must SKIP, not FAIL (so a transient network blip never false-aborts a
 * legitimately-landed pin in git-safe-sync). The offline gate's end-to-end
 * topology is covered separately by check-submodule-pin-ancestry.test.ts.
 */

const SHA = 'a'.repeat(40);
const ENTRY: SubmoduleEntry = { name: 'sub', path: 'sub', branch: 'main' };

interface FakeOpts {
  gitlinkSha?: string | null;
  fetchOk?: boolean;
  cloneHasPin?: boolean;
  refPresent?: boolean;
  pinOnBranch?: boolean; // merge-base --is-ancestor <sha> origin/main → 0
  branchOnPin?: boolean; // merge-base --is-ancestor origin/main <sha> → 0 (pin is AHEAD)
}

function res(status: number, stdout = ''): GitResult {
  return { status, stdout, stderr: '' };
}

function fakeGit(o: FakeOpts): RunGit {
  const {
    gitlinkSha = SHA, fetchOk = true, cloneHasPin = true,
    refPresent = true, pinOnBranch = false, branchOnPin = true,
  } = o;
  return (args) => {
    const a = args.join(' ');
    if (a.startsWith('rev-parse :')) return gitlinkSha ? res(0, gitlinkSha) : res(1);
    if (a.startsWith('ls-tree HEAD')) return res(1); // force gitlink read via rev-parse only
    if (a.includes('fetch --quiet origin')) return res(fetchOk ? 0 : 1);
    if (a.includes('cat-file -e')) return res(cloneHasPin ? 0 : 1);
    if (a.includes('rev-parse --verify --quiet')) return res(refPresent ? 0 : 1);
    // Order matters: the "ref first" form (branchOnPin) must be matched before the generic one.
    if (a.includes('merge-base --is-ancestor origin/')) return res(branchOnPin ? 0 : 1);
    if (a.includes('merge-base --is-ancestor')) return res(pinOnBranch ? 0 : 1);
    return res(1);
  };
}

describe('classifyPin', () => {
  it('OK: pin reachable from origin/<branch> (online)', () => {
    expect(classifyPin(fakeGit({ pinOnBranch: true }), ENTRY, { fetch: true }).status).toBe('ok');
  });

  it('FAIL: pin AHEAD of origin/<branch> when fetch SUCCEEDED (online, strict)', () => {
    const o = classifyPin(fakeGit({ pinOnBranch: false, branchOnPin: true, fetchOk: true }), ENTRY, { fetch: true });
    expect(o.status).toBe('fail');
    expect(o.reason).toMatch(/AHEAD/);
  });

  it('FAIL: pin DIVERGED from origin/<branch> when fetch SUCCEEDED (online, strict)', () => {
    const o = classifyPin(fakeGit({ pinOnBranch: false, branchOnPin: false, fetchOk: true }), ENTRY, { fetch: true });
    expect(o.status).toBe('fail');
    expect(o.reason).toMatch(/DIVERGED/);
  });

  it('SKIP (F1): not-on-branch but fetch FAILED → unverifiable, never a false FAIL', () => {
    const o = classifyPin(
      fakeGit({ pinOnBranch: false, branchOnPin: true, fetchOk: false, refPresent: true }),
      ENTRY, { fetch: true },
    );
    expect(o.status).toBe('skip');
    expect(o.reason).toMatch(/could not fetch|verify freshly|connectivity/i);
  });

  it('FAIL: offline mode (fetch:false) stays strict on a not-on-branch pin', () => {
    // The offline gate trusts the local ref (fresh in the pre-push context); no
    // fetch is attempted, so a not-on-branch pin still FAILs.
    const o = classifyPin(fakeGit({ pinOnBranch: false, branchOnPin: true }), ENTRY, { fetch: false });
    expect(o.status).toBe('fail');
  });

  it('SKIP: submodule clone not present (pin object absent)', () => {
    expect(classifyPin(fakeGit({ cloneHasPin: false }), ENTRY, { fetch: true }).status).toBe('skip');
  });

  it('SKIP: tracked-branch ref not present', () => {
    expect(classifyPin(fakeGit({ refPresent: false }), ENTRY, { fetch: true }).status).toBe('skip');
  });

  it('FAIL: recorded gitlink unreadable', () => {
    const o = classifyPin(fakeGit({ gitlinkSha: null }), ENTRY, { fetch: true });
    expect(o.status).toBe('fail');
    expect(o.reason).toMatch(/gitlink/);
  });
});
