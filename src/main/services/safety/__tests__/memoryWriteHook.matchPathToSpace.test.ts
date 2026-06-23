/**
 * Tests for matchPathToSpace
 * 
 * This function matches file paths to spaces using longest prefix match.
 * Supports workspace-relative paths, absolute paths, and symlink target paths.
 */

import { describe, it, expect } from 'vitest';
import { matchPathToSpace } from '../memoryWriteHook';
import type { SpaceInfo } from '@shared/ipc/schemas/library';

// Helper to create minimal SpaceInfo for testing
function createSpaceInfo(overrides: Partial<SpaceInfo>): SpaceInfo {
  return {
    name: overrides.name ?? 'Test Space',
    path: overrides.path ?? 'test-space',
    absolutePath: overrides.absolutePath ?? '/workspace/test-space',
    type: overrides.type ?? 'personal',
    isSymlink: overrides.isSymlink ?? false,
    hasReadme: overrides.hasReadme ?? true,
    sourcePath: overrides.sourcePath,
    description: overrides.description,
    sharing: overrides.sharing,
    status: overrides.status ?? 'ok',
  };
}

describe('matchPathToSpace', () => {
  const coreDirectory = '/Users/test/Documents/Workspace/Core';

  describe('workspace-relative path matching', () => {
    it('matches file path with workspace-relative space path', () => {
      const spaces = [
        createSpaceInfo({ name: 'Personal', path: 'personal', absolutePath: `${coreDirectory}/personal` }),
      ];
      
      const result = matchPathToSpace('personal/memory/notes.md', spaces, coreDirectory);
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Personal');
    });

    it('matches exact space path', () => {
      const spaces = [
        createSpaceInfo({ name: 'Personal', path: 'personal', absolutePath: `${coreDirectory}/personal` }),
      ];
      
      const result = matchPathToSpace('personal', spaces, coreDirectory);
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Personal');
    });

    it('does not match partial space names (boundary check)', () => {
      const spaces = [
        createSpaceInfo({ name: 'Personal', path: 'personal', absolutePath: `${coreDirectory}/personal` }),
      ];
      
      // Should NOT match 'personal-other' to 'personal'
      const result = matchPathToSpace('personal-other/file.md', spaces, coreDirectory);
      
      expect(result).toBeNull();
    });
  });

  describe('absolute path matching', () => {
    it('matches file path with absolute space path', () => {
      const spaces = [
        createSpaceInfo({ name: 'Personal', path: 'personal', absolutePath: `${coreDirectory}/personal` }),
      ];
      
      const result = matchPathToSpace(`${coreDirectory}/personal/memory/notes.md`, spaces, coreDirectory);
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Personal');
    });
  });

  describe('symlink sourcePath matching', () => {
    it('matches file path against symlink target (sourcePath)', () => {
      const googleDrivePath = '/Users/test/Library/CloudStorage/[external-email]/My Drive/personal';
      const spaces = [
        createSpaceInfo({
          name: 'Personal',
          path: 'personal',
          absolutePath: `${coreDirectory}/personal`,
          isSymlink: true,
          sourcePath: googleDrivePath,
          sharing: 'private',
        }),
      ];
      
      // File path reported as resolved symlink target (Google Drive path)
      const result = matchPathToSpace(`${googleDrivePath}/memory/notes.md`, spaces, coreDirectory);
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Personal');
      expect(result?.sharing).toBe('private');
    });

    it('matches exact sourcePath', () => {
      const googleDrivePath = '/Users/test/Library/CloudStorage/[external-email]/My Drive/personal';
      const spaces = [
        createSpaceInfo({
          name: 'Personal',
          path: 'personal',
          absolutePath: `${coreDirectory}/personal`,
          isSymlink: true,
          sourcePath: googleDrivePath,
        }),
      ];
      
      const result = matchPathToSpace(googleDrivePath, spaces, coreDirectory);
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Personal');
    });

    it('handles relative sourcePath by resolving against absolutePath', () => {
      // Simulate an externally-created symlink with relative target
      const spaces = [
        createSpaceInfo({
          name: 'Personal',
          path: 'personal',
          absolutePath: `${coreDirectory}/personal`,
          isSymlink: true,
          sourcePath: '../../../external/personal', // Relative path
        }),
      ];
      
      // path.resolve('/Users/test/Documents/Workspace/Core/personal', '..', '../../../external/personal')
      // = /Users/test/external/personal
      const resolvedPath = '/Users/test/external/personal';
      const result = matchPathToSpace(`${resolvedPath}/memory/notes.md`, spaces, coreDirectory);
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Personal');
    });

    it('does not match partial sourcePath names (boundary check)', () => {
      const googleDrivePath = '/Users/test/Library/CloudStorage/[external-email]/My Drive/personal';
      const spaces = [
        createSpaceInfo({
          name: 'Personal',
          path: 'personal',
          absolutePath: `${coreDirectory}/personal`,
          isSymlink: true,
          sourcePath: googleDrivePath,
        }),
      ];
      
      // Should NOT match 'personal-backup' to 'personal'
      const result = matchPathToSpace(`${googleDrivePath}-backup/file.md`, spaces, coreDirectory);
      
      expect(result).toBeNull();
    });
  });

  describe('longest prefix matching', () => {
    it('selects the most specific space when multiple match', () => {
      const spaces = [
        createSpaceInfo({ name: 'Work', path: 'work', absolutePath: `${coreDirectory}/work` }),
        createSpaceInfo({ name: 'Work Acme', path: 'work/Acme', absolutePath: `${coreDirectory}/work/Acme` }),
        createSpaceInfo({ name: 'Work Acme General', path: 'work/Acme/General', absolutePath: `${coreDirectory}/work/Acme/General` }),
      ];
      
      const result = matchPathToSpace('work/Acme/General/notes.md', spaces, coreDirectory);
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Work Acme General');
    });
  });

  describe('path normalization', () => {
    it('handles backslashes (Windows paths)', () => {
      const spaces = [
        createSpaceInfo({ name: 'Personal', path: 'personal', absolutePath: `${coreDirectory}/personal` }),
      ];
      
      const result = matchPathToSpace('personal\\memory\\notes.md', spaces, coreDirectory);
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Personal');
    });

    it('handles repeated slashes', () => {
      const spaces = [
        createSpaceInfo({ name: 'Personal', path: 'personal', absolutePath: `${coreDirectory}/personal` }),
      ];
      
      const result = matchPathToSpace('personal//memory///notes.md', spaces, coreDirectory);
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Personal');
    });

    it('handles leading ./', () => {
      const spaces = [
        createSpaceInfo({ name: 'Personal', path: 'personal', absolutePath: `${coreDirectory}/personal` }),
      ];
      
      const result = matchPathToSpace('./personal/memory/notes.md', spaces, coreDirectory);
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Personal');
    });

    it('handles case-insensitive matching', () => {
      const spaces = [
        createSpaceInfo({ name: 'Personal', path: 'personal', absolutePath: `${coreDirectory}/personal` }),
      ];
      
      const result = matchPathToSpace('PERSONAL/MEMORY/notes.md', spaces, coreDirectory);
      
      expect(result).not.toBeNull();
      expect(result?.name).toBe('Personal');
    });
  });

  describe('no match scenarios', () => {
    it('returns null for paths outside any space', () => {
      const spaces = [
        createSpaceInfo({ name: 'Personal', path: 'personal', absolutePath: `${coreDirectory}/personal` }),
      ];
      
      const result = matchPathToSpace('/tmp/random/file.md', spaces, coreDirectory);
      
      expect(result).toBeNull();
    });

    it('returns null for empty spaces array', () => {
      const result = matchPathToSpace('personal/file.md', [], coreDirectory);
      
      expect(result).toBeNull();
    });
  });
});
