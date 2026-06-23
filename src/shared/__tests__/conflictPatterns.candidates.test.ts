import { describe, expect, it } from 'vitest';
import {
  deriveOriginalPath,
  deriveOriginalPathCandidates,
  matchConflictPattern,
} from '../conflictPatterns';

describe('deriveOriginalPathCandidates — nested numbered-copy chains', () => {
  // REBEL-62A recurrence (Jonas / 0.4.45): the one-level deriveOriginalPath
  // makes the suppression sibling-gate fail open on a *missing-intermediate*
  // chain. The candidate form walks every shallower level down to the root so a
  // deeper copy is still recognised when only the root original survives.

  it('walks every shallower level for a Drive numbered copy (basename)', () => {
    expect(deriveOriginalPathCandidates('foo (1) (1) (1).md', 'numbered-copy')).toEqual([
      'foo (1) (1).md',
      'foo (1).md',
      'foo.md',
    ]);
  });

  it('first candidate equals the one-level deriveOriginalPath (backward compatible)', () => {
    const name = 'foo (1) (1).md';
    const candidates = deriveOriginalPathCandidates(name, 'numbered-copy');
    expect(candidates[0]).toBe(deriveOriginalPath(name, 'numbered-copy'));
    expect(candidates).toEqual(['foo (1).md', 'foo.md']);
  });

  it('preserves directory segments when joining (full path)', () => {
    expect(deriveOriginalPathCandidates('memory/notes/foo (1) (1).md', 'numbered-copy')).toEqual([
      'memory/notes/foo (1).md',
      'memory/notes/foo.md',
    ]);
  });

  it('single-level numbered copy yields just the root', () => {
    expect(deriveOriginalPathCandidates('Report (1).md', 'numbered-copy')).toEqual(['Report.md']);
  });

  it('non-conflict-shaped name yields no candidates', () => {
    expect(deriveOriginalPathCandidates('Report.md', 'numbered-copy')).toEqual([]);
  });

  it('non-numbered labels collapse to the single one-level derivation', () => {
    // copy-of-duplicate is not multi-level: identical to deriveOriginalPath.
    const name = 'Copy of notes.md';
    expect(deriveOriginalPathCandidates(name, 'copy-of-duplicate')).toEqual([
      deriveOriginalPath(name, 'copy-of-duplicate'),
    ]);
    expect(deriveOriginalPathCandidates(name, 'copy-of-duplicate')).toEqual(['notes.md']);
  });

  it('matches the numbered-copy label for nested copies via the SSOT matcher', () => {
    expect(matchConflictPattern('foo (1) (1).md')?.label).toBe('numbered-copy');
  });
});
