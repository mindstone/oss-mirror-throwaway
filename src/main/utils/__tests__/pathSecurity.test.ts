/**
 * Path Security Tests
 *
 * Tests for isPathInsideLexical() which provides secure path containment checking.
 * This replaces the vulnerable startsWith() pattern that was susceptible to bypass:
 *   '/workspace2/evil.txt'.startsWith('/workspace') === true (BAD!)
 */

import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { isPathInsideLexical } from '../systemUtils';

describe('isPathInsideLexical', () => {
  // Use platform-appropriate paths for tests
  const isWindows = process.platform === 'win32';
  const root = isWindows ? 'C:\\workspace' : '/workspace';
  const makePath = (...parts: string[]) =>
    isWindows ? path.win32.join('C:\\workspace', ...parts) : path.posix.join('/workspace', ...parts);

  describe('allows paths inside root', () => {
    it('returns true for direct child', () => {
      expect(isPathInsideLexical(makePath('file.txt'), root)).toBe(true);
    });

    it('returns true for nested path', () => {
      expect(isPathInsideLexical(makePath('a', 'b', 'file.txt'), root)).toBe(true);
    });

    it('returns true for same path (root itself)', () => {
      expect(isPathInsideLexical(root, root)).toBe(true);
    });

    it('allows symlinks inside workspace (lexical check only)', () => {
      // Symlink target doesn't matter - we only check the path string
      expect(isPathInsideLexical(makePath('gdrive-link', 'file.txt'), root)).toBe(true);
    });

    it('handles filenames starting with dots (not traversal)', () => {
      // ..foo is a valid filename, not traversal
      expect(isPathInsideLexical(makePath('..foo', 'file.txt'), root)).toBe(true);
    });

    it('handles hidden directories', () => {
      expect(isPathInsideLexical(makePath('.hidden', 'file.txt'), root)).toBe(true);
    });
  });

  describe('blocks paths outside root', () => {
    it('demonstrates the original vulnerability (fixed)', () => {
      // This is what startsWith allowed - THE KEY VULNERABILITY WE'RE FIXING
      const evilPath = isWindows ? 'C:\\workspace2\\evil.txt' : '/workspace2/evil.txt';
      expect(evilPath.startsWith(root)).toBe(true); // Vulnerable!
      expect(isPathInsideLexical(evilPath, root)).toBe(false); // Fixed!
    });

    it('blocks sibling directory attack', () => {
      const sibling = isWindows ? 'C:\\workspace2\\evil.txt' : '/workspace2/evil.txt';
      expect(isPathInsideLexical(sibling, root)).toBe(false);
    });

    it('blocks sibling with similar prefix', () => {
      const sibling = isWindows ? 'C:\\workspace-backup\\file.txt' : '/workspace-backup/file.txt';
      expect(isPathInsideLexical(sibling, root)).toBe(false);
    });

    it('blocks parent traversal via ..', () => {
      const traversal = isWindows ? 'C:\\workspace\\..\\etc\\passwd' : '/workspace/../etc/passwd';
      expect(isPathInsideLexical(traversal, root)).toBe(false);
    });

    it('blocks direct parent reference', () => {
      const parent = isWindows ? 'C:\\workspace\\..' : '/workspace/..';
      expect(isPathInsideLexical(parent, root)).toBe(false);
    });

    it('blocks absolute path outside root', () => {
      const outside = isWindows ? 'C:\\etc\\passwd' : '/etc/passwd';
      expect(isPathInsideLexical(outside, root)).toBe(false);
    });

    it('blocks double traversal', () => {
      const doubleTraversal = isWindows
        ? 'C:\\workspace\\..\\..\\etc\\passwd'
        : '/workspace/../../etc/passwd';
      expect(isPathInsideLexical(doubleTraversal, root)).toBe(false);
    });

    it('blocks traversal in middle of path', () => {
      const midTraversal = isWindows
        ? 'C:\\workspace\\subdir\\..\\..\\etc\\passwd'
        : '/workspace/subdir/../../etc/passwd';
      expect(isPathInsideLexical(midTraversal, root)).toBe(false);
    });
  });

  describe('Windows-specific', () => {
    it('blocks cross-drive access on Windows', () => {
      if (process.platform === 'win32') {
        // path.relative('C:\\workspace', 'D:\\evil') returns 'D:\\evil' (absolute)
        expect(isPathInsideLexical('D:\\evil\\file.txt', 'C:\\workspace')).toBe(false);
      }
    });
  });

  describe('edge cases', () => {
    it('handles trailing slashes on root', () => {
      const rootWithSlash = isWindows ? 'C:\\workspace\\' : '/workspace/';
      expect(isPathInsideLexical(makePath('file.txt'), rootWithSlash)).toBe(true);
    });

    it('handles relative paths by resolving them', () => {
      // Relative paths get resolved against cwd, but we're testing absolute paths
      // This test verifies the function handles the relative→absolute conversion
      const cwd = process.cwd();
      expect(isPathInsideLexical('subdir/file.txt', cwd)).toBe(true);
    });

    it('handles empty filename component', () => {
      // path.resolve normalizes these, so they should work
      const withEmpty = isWindows ? 'C:\\workspace\\subdir\\\\file.txt' : '/workspace/subdir//file.txt';
      expect(isPathInsideLexical(withEmpty, root)).toBe(true);
    });
  });
});
