import { describe, expect, it } from 'vitest';
import {
  deriveOriginalDirPath,
  matchConflictDirPattern,
  matchConflictPattern,
} from '../conflictPatterns';

describe('directory conflict patterns', () => {
  // Directory suppression is intentionally limited to UNAMBIGUOUSLY machine-minted shapes:
  // Google Drive numbered copies and Dropbox conflicted-copy markers only.
  it.each([
    ['Project (1)', 'numbered-copy', 'Project'],
    ['Project (10)', 'numbered-copy', 'Project'],
    ['Project (conflicted copy 2026-06-06)', 'dropbox-conflict', 'Project'],
  ] as const)('matches and derives %s as %s', (dirName, expectedLabel, expectedOriginal) => {
    const match = matchConflictDirPattern(dirName);

    expect(match?.label).toBe(expectedLabel);
    expect(deriveOriginalDirPath(dirName, expectedLabel)).toBe(expectedOriginal);
  });

  it('does not match non-conflict directory names', () => {
    expect(matchConflictDirPattern('Project')).toBeNull();
  });

  // REBEL-5QS adversarial review F1: generic file-copy heuristics must NOT match
  // directories — `Copy of Project/` and `backup copy/` are normal user folders, and
  // suppressing them would drop a whole legitimate subtree from Fly sync. Locks the narrowing.
  it.each([
    ['Copy of Project'],
    ['backup copy'],
    ['Project copy'],
    ['Project-conflict-20260606'],
  ] as const)('does NOT match generic copy/conflict folder name %s', (dirName) => {
    expect(matchConflictDirPattern(dirName)).toBeNull();
  });

  it('derives only the final basename for nested directory paths', () => {
    expect(deriveOriginalDirPath('A (1)/B (1)', 'numbered-copy')).toBe('A (1)/B');
  });

  it('leaves the file conflict API extension-gated for numbered copies', () => {
    expect(matchConflictPattern('Project (1)')).toBeNull();
  });
});
