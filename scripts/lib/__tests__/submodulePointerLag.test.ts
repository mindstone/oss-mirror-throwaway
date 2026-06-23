import { describe, it, expect } from 'vitest';

import {
  assessDirtySuperproject,
  evaluateSubmoduleLag,
  parsePorcelain,
  type SubmoduleLagProbes,
} from '../submodulePointerLag';
import type { GitResult, RunGit } from '../submodulePinAncestry';

/**
 * Unit tests for git-safe-sync's Stage-6 pointer-lag classifier
 * (docs/plans/260611_prepush-gate-speedup/PLAN.md). This is the
 * never-lose-work predicate gating the only mutation that runs BEFORE the
 * safety check, so the decision table here is exhaustive: every "abort"
 * row exists because auto-aligning in that state could lose information or
 * normalize a bad pin.
 *
 * Driven entirely through a fake `RunGit`, mirroring the pattern in
 * submodulePinAncestry.test.ts. SHAs are distinct per role so merge-base
 * argument order is asserted, not assumed.
 */

const CHECKOUT = 'a'.repeat(40); // submodule's checked-out HEAD (the lagging sha)
const PIN = 'b'.repeat(40); // committed pin (HEAD gitlink)
const STAGED = 'c'.repeat(40); // a staged (index) pin differing from HEAD

function res(status: number, stdout = '', stderr = ''): GitResult {
  return { status, stdout, stderr };
}

interface Scenario {
  /** Superproject `git status --porcelain` output. */
  superStatus?: string;
  /** Index gitlink sha for `sub` (null ⇒ rev-parse :sub fails). */
  indexPin?: string | null;
  /** HEAD gitlink sha for `sub` (null ⇒ not a gitlink in HEAD). */
  headPin?: string | null;
  /** ls-files index mode for `sub`. */
  indexMode?: string;
  /** Submodule checked-out HEAD. */
  checkout?: string | null;
  /** Submodule worktree porcelain output ('' = clean). */
  subStatus?: string;
  /** Current branch ('' = detached). */
  branch?: string;
  /** In-progress op ref that verifies (e.g. 'MERGE_HEAD'). */
  opRef?: 'MERGE_HEAD' | 'REBASE_HEAD' | 'CHERRY_PICK_HEAD' | null;
  /** checkout is ancestor of pin / pin is ancestor of checkout. */
  headUnderPin?: boolean;
  pinUnderHead?: boolean;
  /** merge-base exit for the lag-probe calls (override for probe failure). */
  ancestryStatus?: number | null;
  /** Pin reachable from origin/main (classifyPin's strict check). */
  pinOnRemote?: boolean;
  /** origin/main ref present in the submodule clone. */
  refPresent?: boolean;
  /** .gitmodules tracked branch (default: unset ⇒ 'main'). */
  gitmodulesBranch?: string;
}

/** Fake git for a superproject with one submodule at path `sub`. */
function fakeGit(s: Scenario): RunGit {
  const {
    superStatus = ' M sub',
    indexPin = PIN,
    headPin = PIN,
    indexMode = '160000',
    checkout = CHECKOUT,
    subStatus = '',
    branch = '',
    opRef = null,
    headUnderPin = true,
    pinUnderHead = false,
    ancestryStatus = null,
    pinOnRemote = true,
    refPresent = true,
    gitmodulesBranch,
  } = s;

  return (args) => {
    const a = args.join(' ');

    // --- superproject probes ---
    if (a === 'status --porcelain') return res(0, superStatus);
    if (a.includes('--get-regexp ^submodule')) return res(0, 'submodule.sub.path sub');
    if (a.includes('--get submodule.sub.branch')) {
      return gitmodulesBranch ? res(0, gitmodulesBranch) : res(1);
    }
    if (a === 'ls-files -s -- sub') {
      return indexPin ? res(0, `${indexMode} ${indexPin} 0\tsub`) : res(0, '');
    }
    if (a === 'rev-parse :sub') return indexPin ? res(0, indexPin) : res(1);
    if (a === 'ls-tree HEAD -- sub' || a === 'ls-tree HEAD sub') {
      return headPin ? res(0, `160000 commit ${headPin}\tsub`) : res(0, '');
    }

    // --- submodule probes (-C sub …) ---
    if (a === '-C sub rev-parse HEAD') return checkout ? res(0, checkout) : res(128);
    if (a === '-C sub status --porcelain') return res(0, subStatus);
    if (a.startsWith('-C sub rev-parse -q --verify ')) {
      const ref = args[args.length - 1];
      return res(ref === opRef ? 0 : 1);
    }
    if (a === '-C sub branch --show-current') return res(0, branch);

    // --- ancestry probes: argument order is load-bearing ---
    if (checkout && a === `-C sub merge-base --is-ancestor ${checkout} ${PIN}`) {
      return ancestryStatus !== null ? res(ancestryStatus) : res(headUnderPin ? 0 : 1);
    }
    if (checkout && a === `-C sub merge-base --is-ancestor ${PIN} ${checkout}`) {
      return ancestryStatus !== null ? res(ancestryStatus) : res(pinUnderHead ? 0 : 1);
    }

    // --- classifyPin probes (remote reachability of the recorded pin) ---
    if (a.includes('cat-file -e')) return res(0); // pin object present locally
    if (a.includes('rev-parse --verify --quiet origin/')) return res(refPresent ? 0 : 1);
    if (a.startsWith('-C sub merge-base --is-ancestor origin/')) {
      // origin/main under pin ⇒ pin is AHEAD (message-only distinction)
      return res(1);
    }
    if (a.includes('merge-base --is-ancestor') && a.includes('origin/')) {
      return res(pinOnRemote ? 0 : 1);
    }
    return res(1, '', `unexpected git call in fake: ${a}`);
  };
}

describe('assessDirtySuperproject — alignability decision table', () => {
  it('ALIGN: clean submodule, checkout strictly behind a remote-reachable pin (detached)', () => {
    const out = assessDirtySuperproject(fakeGit({}));
    expect(out.allAlignable).toBe(true);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({
      path: 'sub',
      kind: 'alignable-pointer-lag',
      fromSha: CHECKOUT.slice(0, 10),
      toSha: PIN.slice(0, 10),
    });
    expect(out.entries[0].wasOnBranch).toBeUndefined();
  });

  it('ALIGN: on the expected branch whose tip is the lagging checkout (records wasOnBranch)', () => {
    const out = assessDirtySuperproject(fakeGit({ branch: 'main' }));
    expect(out.allAlignable).toBe(true);
    expect(out.entries[0].kind).toBe('alignable-pointer-lag');
    expect(out.entries[0].wasOnBranch).toBe('main');
  });

  it('ABORT (GPT F2): behind, but the committed pin is NOT reachable from the tracked remote branch', () => {
    const out = assessDirtySuperproject(fakeGit({ pinOnRemote: false }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0].kind).toBe('submodule-blocked');
    expect(out.entries[0].reason).toMatch(/not verifiably reachable from the tracked remote branch/);
    expect(out.entries[0].recovery).toMatch(/land the pin on the submodule's tracked branch/i);
  });

  it('ABORT (fail-closed): pin reachability is unverifiable (origin ref absent ⇒ classifyPin SKIP)', () => {
    const out = assessDirtySuperproject(fakeGit({ refPresent: false }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0].kind).toBe('submodule-blocked');
    expect(out.entries[0].reason).toMatch(/not verifiably reachable/);
  });

  it('ABORT: checkout AHEAD of the committed pin — recovery says commit the bump, never submodule update', () => {
    const out = assessDirtySuperproject(fakeGit({ headUnderPin: false, pinUnderHead: true }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0].reason).toMatch(/AHEAD of the committed pin/);
    expect(out.entries[0].recovery).toMatch(/do NOT run submodule update/);
    expect(out.entries[0].recovery).toMatch(/git add sub && git commit/);
  });

  it('ABORT: pin moved BACKWARD (rollback merge — checkout not an ancestor of the pin)', () => {
    // Identical probe shape to "checkout ahead": pin ⊂ checkout. The predicate
    // must refuse — aligning would move the checkout backward over real commits.
    const out = assessDirtySuperproject(fakeGit({ headUnderPin: false, pinUnderHead: true }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0].kind).toBe('submodule-blocked');
  });

  it('ABORT: checkout and pin have DIVERGED (neither is an ancestor)', () => {
    const out = assessDirtySuperproject(fakeGit({ headUnderPin: false, pinUnderHead: false }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0].reason).toMatch(/DIVERGED/);
  });

  it('ABORT: dirty submodule worktree (even when pointer also lags)', () => {
    const out = assessDirtySuperproject(fakeGit({ subStatus: ' M src/file.ts' }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0].reason).toMatch(/worktree has uncommitted changes/);
  });

  it('ABORT: untracked file inside the submodule counts as dirty (matches safety-check notion)', () => {
    const out = assessDirtySuperproject(fakeGit({ subStatus: '?? notes.txt' }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0].kind).toBe('submodule-blocked');
  });

  it('ABORT: submodule mid-merge (clean worktree but MERGE_HEAD present)', () => {
    const out = assessDirtySuperproject(fakeGit({ opRef: 'MERGE_HEAD' }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0].reason).toMatch(/in-progress merge/);
  });

  it('ABORT: submodule mid-rebase / mid-cherry-pick', () => {
    for (const [ref, word] of [
      ['REBASE_HEAD', 'rebase'],
      ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ] as const) {
      const out = assessDirtySuperproject(fakeGit({ opRef: ref }));
      expect(out.allAlignable).toBe(false);
      expect(out.entries[0].reason).toContain(`in-progress ${word}`);
    }
  });

  it('ABORT: STAGED pointer change (index gitlink differs from HEAD gitlink)', () => {
    const out = assessDirtySuperproject(fakeGit({ indexPin: STAGED }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0].reason).toMatch(/STAGED submodule pointer change/);
  });

  it('ABORT: submodule on an unexpected branch', () => {
    const out = assessDirtySuperproject(fakeGit({ branch: 'feature-x' }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0].reason).toMatch(/unexpected branch 'feature-x'/);
  });

  it('respects a non-default .gitmodules tracked branch', () => {
    const out = assessDirtySuperproject(fakeGit({ branch: 'develop', gitmodulesBranch: 'develop' }));
    expect(out.allAlignable).toBe(true);
  });

  it('ABORT everything: mixed alignable submodule + genuine file change', () => {
    const out = assessDirtySuperproject(fakeGit({ superStatus: ' M sub\n M src/app.ts' }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries.map((e) => e.kind)).toEqual(['alignable-pointer-lag', 'other']);
  });

  it('ABORT: non-gitlink tracked change alone classifies as other', () => {
    // A tracked non-submodule modification is always blocking ('other').
    // (Untracked '??' paths are now classified 'untracked' and tolerated by the
    // caller when non-colliding — see the non-submodule classification suite.)
    const out = assessDirtySuperproject(fakeGit({ superStatus: ' M tmp/scratch.txt' }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0]).toMatchObject({ kind: 'other', path: 'tmp/scratch.txt' });
  });

  it('never vacuously alignable: empty status ⇒ allAlignable false, no entries', () => {
    const out = assessDirtySuperproject(fakeGit({ superStatus: '' }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries).toHaveLength(0);
  });

  it('ABORT (fail-closed): git status itself fails', () => {
    const failing: RunGit = () => res(128, '', 'fatal: not a git repository');
    const out = assessDirtySuperproject(failing);
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0].kind).toBe('other');
  });

  it('ABORT: gitlink path whose dirty entry is not gitlink-mode in the index (DA gitlink-mode awareness)', () => {
    // Path is a submodule in .gitmodules, but the index entry is a regular
    // blob (e.g. the directory was replaced) — never a candidate.
    const out = assessDirtySuperproject(fakeGit({ indexMode: '100644' }));
    expect(out.allAlignable).toBe(false);
    expect(out.entries[0].reason).toMatch(/not a gitlink-mode pointer change/);
  });
});

describe('evaluateSubmoduleLag — pure-predicate edges', () => {
  const base: SubmoduleLagProbes = {
    indexGitlink: true,
    stagedPointerChange: false,
    committedPin: PIN,
    checkoutHead: CHECKOUT,
    worktreeClean: true,
    inProgressOp: null,
    currentBranch: '',
    expectedBranch: 'main',
    headIsAncestorOfPin: true,
    pinIsAncestorOfHead: false,
    pinOnTrackedRemote: 'ok',
  };

  it('happy path aligns', () => {
    expect(evaluateSubmoduleLag('sub', base).kind).toBe('alignable-pointer-lag');
  });

  it('ABORT (fail-closed): ancestry probe failure (null) is never treated as behind or diverged', () => {
    const out = evaluateSubmoduleLag('sub', {
      ...base,
      headIsAncestorOfPin: null,
      pinIsAncestorOfHead: null,
    });
    expect(out.kind).toBe('submodule-blocked');
    expect(out.reason).toMatch(/could not determine/);
  });

  it('ABORT: checkout equals the committed pin yet entry reports dirty (unexpected state)', () => {
    const out = evaluateSubmoduleLag('sub', { ...base, checkoutHead: PIN });
    expect(out.kind).toBe('submodule-blocked');
    expect(out.reason).toMatch(/unexpected state/);
  });

  it('ABORT: unreadable pin or checkout HEAD', () => {
    expect(evaluateSubmoduleLag('sub', { ...base, committedPin: null }).kind).toBe('submodule-blocked');
    expect(evaluateSubmoduleLag('sub', { ...base, checkoutHead: null }).kind).toBe('submodule-blocked');
  });

  it("ABORT: classifyPin 'skip' (unverifiable) blocks exactly like 'fail'", () => {
    for (const status of ['skip', 'fail'] as const) {
      expect(
        evaluateSubmoduleLag('sub', { ...base, pinOnTrackedRemote: status }).kind,
      ).toBe('submodule-blocked');
    }
  });

  it('alignable recovery copy names the safe command, never "commit"', () => {
    const out = evaluateSubmoduleLag('sub', base);
    expect(out.recovery).toContain('git submodule update --init -- sub');
    expect(out.recovery).not.toMatch(/\bgit (add|commit)\b/);
  });
});

describe('parsePorcelain', () => {
  it('splits XY and path, handles staged/unstaged/untracked codes', () => {
    expect(parsePorcelain(' M sub\nM  staged.ts\n?? new.txt')).toEqual([
      { xy: ' M', path: 'sub' },
      { xy: 'M ', path: 'staged.ts' },
      { xy: '??', path: 'new.txt' },
    ]);
  });

  it('unquotes quoted paths and keeps rename tails opaque (safe: never matches a submodule)', () => {
    expect(parsePorcelain('?? "weird name.txt"')).toEqual([{ xy: '??', path: 'weird name.txt' }]);
    expect(parsePorcelain('R  old.ts -> new.ts')).toEqual([{ xy: 'R ', path: 'old.ts -> new.ts' }]);
  });

  it('ignores blank lines', () => {
    expect(parsePorcelain('\n\n')).toEqual([]);
  });
});

describe('assessDirtySuperproject — non-submodule entry classification', () => {
  it('UNTRACKED: a non-submodule untracked file is classified `untracked` (caller tolerates non-colliding)', () => {
    const out = assessDirtySuperproject(fakeGit({ superStatus: '?? docs-private/sentry-triage-log/260611_x_triage.md' }));
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].kind).toBe('untracked');
    expect(out.allAlignable).toBe(false);
  });

  it('OTHER: a tracked modification stays `other` (always blocking)', () => {
    const out = assessDirtySuperproject(fakeGit({ superStatus: ' M src/foo.ts' }));
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].kind).toBe('other');
  });

  it('STAGED ADD: a staged new file (A␣) is `other`, not `untracked` (only ?? is untracked)', () => {
    const out = assessDirtySuperproject(fakeGit({ superStatus: 'A  src/new.ts' }));
    expect(out.entries[0].kind).toBe('other');
  });

  it('MIXED: untracked + tracked classified independently', () => {
    const out = assessDirtySuperproject(fakeGit({ superStatus: '?? scratch.md\n M src/foo.ts' }));
    const byPath = new Map(out.entries.map((e) => [e.path, e.kind]));
    expect(byPath.get('scratch.md')).toBe('untracked');
    expect(byPath.get('src/foo.ts')).toBe('other');
  });
});
