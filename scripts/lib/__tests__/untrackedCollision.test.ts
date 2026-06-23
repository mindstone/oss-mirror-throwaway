import { describe, it, expect } from 'vitest';

import { partitionUntrackedByCollision } from '../untrackedCollision';

/**
 * The collision gate behind git-safe-sync's untracked-tolerance (checkSafety).
 * A false-negative here = preflight tolerates an untracked path the incoming
 * merge then refuses to overwrite, aborting the sync mid-flight. The directory
 * and prefix cases (F1) and the fail-closed-on-null case were the review
 * findings this guards.
 */
describe('partitionUntrackedByCollision', () => {
  it('tolerates untracked paths with no overlap with incoming', () => {
    const out = partitionUntrackedByCollision(
      ['docs-private/sentry-triage-log/260611_x_triage.md'],
      new Set(['src/foo.ts', 'docs/project/BAR.md']),
    );
    expect(out.tolerable).toEqual(['docs-private/sentry-triage-log/260611_x_triage.md']);
    expect(out.colliding).toEqual([]);
  });

  it('exact-path overlap collides', () => {
    const out = partitionUntrackedByCollision(['docs/plans/x/PLAN.md'], new Set(['docs/plans/x/PLAN.md']));
    expect(out.colliding).toEqual(['docs/plans/x/PLAN.md']);
    expect(out.tolerable).toEqual([]);
  });

  // F1: untracked directory (porcelain `dir/`) vs an incoming file beneath it.
  it('untracked directory collides with an incoming file beneath it', () => {
    const out = partitionUntrackedByCollision(['docs/plans/260612_foo/'], new Set(['docs/plans/260612_foo/PLAN.md']));
    expect(out.colliding).toEqual(['docs/plans/260612_foo/']);
  });

  // F1 inverse: untracked file vs an incoming path that nests beneath it.
  it('untracked file collides with an incoming path beneath it (file-over-dir)', () => {
    const out = partitionUntrackedByCollision(['node'], new Set(['node/child.txt']));
    expect(out.colliding).toEqual(['node']);
  });

  it('untracked directory collides with an incoming file at the dir path itself', () => {
    const out = partitionUntrackedByCollision(['node/'], new Set(['node']));
    expect(out.colliding).toEqual(['node/']);
  });

  it('does NOT treat a shared name-prefix that is not a path-segment prefix as a collision', () => {
    // `node` vs `nodejs/x` must not collide — the `+ '/'` segment guard.
    const out = partitionUntrackedByCollision(['node'], new Set(['nodejs/x', 'node_modules/y']));
    expect(out.tolerable).toEqual(['node']);
    expect(out.colliding).toEqual([]);
  });

  it('fails closed: null incoming set ⇒ every untracked path collides', () => {
    const out = partitionUntrackedByCollision(['a.md', 'b/'], null);
    expect(out.colliding).toEqual(['a.md', 'b/']);
    expect(out.tolerable).toEqual([]);
  });

  it('empty incoming set ⇒ everything tolerable (nothing to collide with)', () => {
    const out = partitionUntrackedByCollision(['a.md', 'b/c.md'], new Set());
    expect(out.tolerable).toEqual(['a.md', 'b/c.md']);
    expect(out.colliding).toEqual([]);
  });

  it('partitions a mixed set independently', () => {
    const out = partitionUntrackedByCollision(
      ['scratch.md', 'docs/plans/p/', 'keep/note.md'],
      new Set(['docs/plans/p/PLAN.md', 'src/x.ts']),
    );
    expect(out.colliding).toEqual(['docs/plans/p/']);
    expect(out.tolerable).toEqual(['scratch.md', 'keep/note.md']);
  });

  // F2: both sides arrive with surrounding quotes already stripped (status via
  // parsePorcelain, diff via getIncomingChangedPaths), so identical escaped
  // bytes compare equal.
  it('matches special-char paths once surrounding quotes are stripped on both sides', () => {
    const out = partitionUntrackedByCollision(['caf\\303\\251.md'], new Set(['caf\\303\\251.md']));
    expect(out.colliding).toEqual(['caf\\303\\251.md']);
  });
});
