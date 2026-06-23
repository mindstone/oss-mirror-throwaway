import { describe, expect, it } from 'vitest';
import {
  isSuppressibleConflictCopy,
  isSuppressibleConflictDir,
  shouldSuppressConflictDirAncestor,
} from '../workspaceSyncPolicy';

describe('WorkspaceSyncPolicy conflict-copy suppression', () => {
  describe('push/pull file conflict copies', () => {
    it.each([
      ['push-file sibling present', true, true],
      ['push-file sibling absent', false, false],
      ['pull-file sibling present', true, true],
      ['pull-file sibling absent', false, false],
    ] as const)('%s', (_label, siblingPresent, expected) => {
      expect(isSuppressibleConflictCopy('foo (1).md', () => siblingPresent)).toBe(expected);
    });

    it('does not suppress Rebel cloud conflict markers through sibling-gating', () => {
      expect(isSuppressibleConflictCopy('foo.conflict-cloud.md', () => true)).toBe(false);
    });

    // REBEL-62A recurrence (Jonas / 0.4.45): a nested numbered copy whose
    // immediate intermediate is missing must still be suppressed when a deeper
    // (root) original survives — otherwise the gate fails open and Fly
    // re-propagates the copy. The probe sees ONLY the originals listed.
    describe('nested chains gate on every shallower original (not just the immediate sibling)', () => {
      const present = (...names: string[]) => (n: string) => names.includes(n);

      it('suppresses foo (1) (1).md when root foo.md present but intermediate foo (1).md absent', () => {
        expect(isSuppressibleConflictCopy('foo (1) (1).md', present('foo.md'))).toBe(true);
      });

      it('suppresses a 3-deep copy when only the root survives', () => {
        expect(isSuppressibleConflictCopy('foo (1) (1) (1).md', present('foo.md'))).toBe(true);
      });

      it('still suppresses when only the immediate sibling is present (unchanged behavior)', () => {
        expect(isSuppressibleConflictCopy('foo (1) (1).md', present('foo (1).md'))).toBe(true);
      });

      it('does NOT suppress when no original at any depth is present (genuine standalone)', () => {
        expect(isSuppressibleConflictCopy('foo (1) (1).md', present())).toBe(false);
      });

      it('does NOT suppress a single-level standalone Report (1).md with no Report.md', () => {
        expect(isSuppressibleConflictCopy('Report (1).md', present())).toBe(false);
      });
    });
  });

  describe('push directory conflict copies', () => {
    it.each([
      ['push-dir sibling present', true, true],
      ['push-dir sibling absent', false, false],
    ] as const)('%s', (_label, siblingPresent, expected) => {
      expect(isSuppressibleConflictDir('Project (1)', () => siblingPresent)).toBe(expected);
    });

    it('does not apply broad file-copy patterns to directories', () => {
      expect(isSuppressibleConflictDir('Copy of Project', () => true)).toBe(false);
    });
  });

  describe('pull directory-conflict ancestors', () => {
    it.each([
      ['pull-dir-ancestor sibling present in manifest', true, false, true],
      ['pull-dir-ancestor sibling present locally', false, true, true],
      ['pull-dir-ancestor sibling absent', false, false, false],
    ] as const)('%s', (_label, manifestSiblingPresent, localSiblingPresent, expected) => {
      expect(
        shouldSuppressConflictDirAncestor('Projects/Client (1)/notes.md', {
          manifestHasPrefix: (prefix) => prefix === 'Projects/Client/' && manifestSiblingPresent,
          localDirExists: (relativeDir) => relativeDir === 'Projects/Client' && localSiblingPresent,
        }),
      ).toBe(expected);
    });

    it('ignores a conflict-shaped final filename because only ancestor directories are checked', () => {
      expect(
        shouldSuppressConflictDirAncestor('Projects/Client (1).md', {
          manifestHasPrefix: () => true,
          localDirExists: () => true,
        }),
      ).toBe(false);
    });
  });
});
