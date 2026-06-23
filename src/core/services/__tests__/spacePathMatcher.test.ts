/**
 * Tests for the three helpers added alongside `matchPathToSpace`:
 *   - `isShareableSpace` — allowlist gate over SpaceType + sharing flag
 *   - `resolveMatchRoot` — picks `sourcePath` for symlinked spaces, else `absolutePath`
 *   - `getCanonicalSpaceName` — canonical string for `rebel://space/{name}/...`
 *     URL emission; must match main-side `getSpaceDisplayName` so renderer +
 *     main emit identical URLs for the same file (Stage 1 Must-fix #4).
 *
 * `matchPathToSpace` itself has existing coverage via memoryWriteHook and
 * spaceService tests — we don't retest it here.
 *
 * See docs/plans/260418_finish_cross_surface_links_closeout.md — Stage 1.
 */

import { describe, expect, it } from 'vitest';
import { getCanonicalSpaceName, isShareableSpace, matchPathToSpace, resolveMatchRoot, tryCorrectAgentSpacePath } from '../spacePathMatcher';
import type { SpaceType } from '@shared/ipc/schemas/library';

describe('matchPathToSpace — traversal normalization', () => {
  it('normalizes dot segments before longest-prefix matching', () => {
    const coreDirectory = '/workspace';
    const spaces = [
      {
        name: 'Chief-of-Staff',
        path: 'Chief-of-Staff',
        absolutePath: '/workspace/Chief-of-Staff',
      },
      {
        name: 'Public Team',
        path: 'public-team',
        absolutePath: '/workspace/public-team',
      },
    ];

    const match = matchPathToSpace(
      'Chief-of-Staff/memory/sources/../../../public-team/leak.md',
      spaces,
      coreDirectory,
    );

    expect(match?.name).toBe('Public Team');
  });
});

describe('isShareableSpace — SpaceType allowlist', () => {
  const shareableTypes: SpaceType[] = ['team', 'company', 'project', 'personal', 'operator', 'other'];
  const unshareableTypes: SpaceType[] = ['chief-of-staff'];

  it.each(shareableTypes)('returns true for type=%s with no sharing flag', (type) => {
    expect(isShareableSpace({ type })).toBe(true);
  });

  it.each(unshareableTypes)('returns false for type=%s', (type) => {
    expect(isShareableSpace({ type })).toBe(false);
  });

  it('returns false when top-level sharing="private"', () => {
    expect(isShareableSpace({ type: 'team', sharing: 'private' })).toBe(false);
  });

  it('returns false when frontmatter.sharing="private" (even with shareable type)', () => {
    expect(isShareableSpace({ type: 'team', frontmatter: { sharing: 'private' } })).toBe(false);
  });

  it('returns true when sharing is non-private string (e.g., "team", "restricted")', () => {
    expect(isShareableSpace({ type: 'company', sharing: 'team' })).toBe(true);
    expect(isShareableSpace({ type: 'company', sharing: 'restricted' })).toBe(true);
    expect(isShareableSpace({ type: 'company', sharing: 'public' })).toBe(true);
  });

  it('ignores frontmatter when its sharing is undefined', () => {
    expect(isShareableSpace({ type: 'project', frontmatter: {} })).toBe(true);
    expect(isShareableSpace({ type: 'project', frontmatter: undefined })).toBe(true);
  });

  it('prioritizes explicit "private" over type allowlist', () => {
    // Even for a shareable type, explicit private denies.
    expect(isShareableSpace({ type: 'operator', sharing: 'private' })).toBe(false);
    expect(isShareableSpace({ type: 'other', frontmatter: { sharing: 'private' } })).toBe(false);
  });
});

describe('resolveMatchRoot — picks sourcePath for symlinked spaces', () => {
  it('returns absolutePath when space has no sourcePath', () => {
    const space = { absolutePath: '/Users/me/core/Exec' };
    expect(resolveMatchRoot(space, '/Users/me/core/Exec/Q1.md')).toBe('/Users/me/core/Exec');
  });

  it('returns sourcePath when input path lies under sourcePath', () => {
    const space = {
      absolutePath: '/Users/me/core/Drive',
      sourcePath: '/Users/me/Library/CloudStorage/GoogleDrive-x/My Drive/team',
    };
    const input = '/Users/me/Library/CloudStorage/GoogleDrive-x/My Drive/team/Q1.md';
    expect(resolveMatchRoot(space, input)).toBe('/Users/me/Library/CloudStorage/GoogleDrive-x/My Drive/team');
  });

  it('returns absolutePath when input lies under absolutePath (not sourcePath)', () => {
    const space = {
      absolutePath: '/Users/me/core/Drive',
      sourcePath: '/Users/me/Library/CloudStorage/GoogleDrive-x/My Drive/team',
    };
    const input = '/Users/me/core/Drive/Q1.md';
    expect(resolveMatchRoot(space, input)).toBe('/Users/me/core/Drive');
  });

  it('is case-insensitive for sourcePath matching', () => {
    const space = {
      absolutePath: '/Users/me/core/Drive',
      sourcePath: '/Users/me/Library/CloudStorage/GoogleDrive-X/My Drive/team',
    };
    const input = '/Users/me/library/cloudstorage/googledrive-x/my drive/team/doc.md';
    // Case-insensitive comparison in resolveMatchRoot — should still pick sourcePath.
    expect(resolveMatchRoot(space, input)).toBe('/Users/me/Library/CloudStorage/GoogleDrive-X/My Drive/team');
  });
});

describe('getCanonicalSpaceName — shared renderer/main space-name emitter', () => {
  it('uses frontmatter displayName when present (trimmed)', () => {
    expect(getCanonicalSpaceName({
      name: 'folder-exec',
      displayName: 'Mindstone Exec',
      type: 'team',
    })).toBe('Mindstone Exec');
  });

  it('trims whitespace from displayName', () => {
    expect(getCanonicalSpaceName({
      name: 'folder-exec',
      displayName: '   Mindstone Exec  ',
      type: 'team',
    })).toBe('Mindstone Exec');
  });

  it('ignores displayName when empty / whitespace-only, falling back to type default', () => {
    expect(getCanonicalSpaceName({
      name: 'me-2024',
      displayName: '   ',
      type: 'personal',
    })).toBe('Personal');
  });

  it('returns "Private Space" for chief-of-staff type (parity with getSpaceDisplayName)', () => {
    expect(getCanonicalSpaceName({ name: 'cos', type: 'chief-of-staff' })).toBe('Private Space');
  });

  it('returns "Personal" for personal type', () => {
    expect(getCanonicalSpaceName({ name: 'me-2024', type: 'personal' })).toBe('Personal');
  });

  it('returns folder name for team / company / project / operator / other types', () => {
    expect(getCanonicalSpaceName({ name: 'Exec', type: 'team' })).toBe('Exec');
    expect(getCanonicalSpaceName({ name: 'Co', type: 'company' })).toBe('Co');
    expect(getCanonicalSpaceName({ name: 'Alpha', type: 'project' })).toBe('Alpha');
    expect(getCanonicalSpaceName({ name: 'Ops', type: 'operator' })).toBe('Ops');
    expect(getCanonicalSpaceName({ name: 'Misc', type: 'other' })).toBe('Misc');
  });
});

describe('tryCorrectAgentSpacePath — bare space name correction', () => {
  const coreDirectory = '/Users/me/workspace';

  const makeSpace = (name: string, spacePath: string) => ({
    name,
    path: spacePath,
    absolutePath: `${coreDirectory}/${spacePath}`,
  });

  const spaces = [
    makeSpace('General', 'work/Mindstone/General'),
    makeSpace('Research', 'work/Mindstone/Research'),
  ];

  it('corrects bare space name to full workspace-relative path', () => {
    const result = tryCorrectAgentSpacePath(
      'General/memory/sources/report.md',
      spaces,
      coreDirectory,
    );
    expect(result).not.toBeNull();
    expect(result!.correctedPath).toBe('work/Mindstone/General/memory/sources/report.md');
    expect(result!.matchedSpace.name).toBe('General');
  });

  it('is case-insensitive on the space name segment', () => {
    const result = tryCorrectAgentSpacePath(
      'general/notes.md',
      spaces,
      coreDirectory,
    );
    expect(result).not.toBeNull();
    expect(result!.correctedPath).toBe('work/Mindstone/General/notes.md');
  });

  it('returns null when no space matches the first segment', () => {
    const result = tryCorrectAgentSpacePath(
      'NonExistent/file.md',
      spaces,
      coreDirectory,
    );
    expect(result).toBeNull();
  });

  it('returns null on ambiguity (2+ spaces with same name)', () => {
    const ambiguousSpaces = [
      ...spaces,
      makeSpace('General', 'other/path/General'),
    ];
    const result = tryCorrectAgentSpacePath(
      'General/file.md',
      ambiguousSpaces,
      coreDirectory,
    );
    expect(result).toBeNull();
  });

  it('returns null when path already matches a space (no correction needed)', () => {
    const result = tryCorrectAgentSpacePath(
      'work/Mindstone/General/file.md',
      spaces,
      coreDirectory,
    );
    expect(result).toBeNull();
  });

  it('returns null when space path equals first segment (no prefix to add)', () => {
    const flatSpaces = [makeSpace('Docs', 'Docs')];
    const result = tryCorrectAgentSpacePath(
      'Docs/file.md',
      flatSpaces,
      coreDirectory,
    );
    expect(result).toBeNull();
  });

  it('returns the most specific nested space when corrected path matches a child space', () => {
    const nestedSpaces = [
      makeSpace('General', 'work/Mindstone/General'),
      makeSpace('Subproject', 'work/Mindstone/General/Subproject'),
    ];
    const result = tryCorrectAgentSpacePath(
      'General/Subproject/file.md',
      nestedSpaces,
      coreDirectory,
    );
    expect(result).not.toBeNull();
    expect(result!.correctedPath).toBe('work/Mindstone/General/Subproject/file.md');
    // matchedSpace should be Subproject (longest-prefix), not General (name-match)
    expect(result!.matchedSpace.name).toBe('Subproject');
  });
});
