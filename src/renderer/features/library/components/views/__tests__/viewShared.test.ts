import { describe, expect, it } from 'vitest';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { buildSpaceRoots, matchesFilter, matchesSearch } from '../viewShared';

const SYMLINKED_SPACE: SpaceInfo = {
  name: 'Acme',
  path: 'work/Acme/Operations',
  absolutePath: '/workspace/work/Acme/Operations',
  sourcePath: '/Volumes/CloudDrive/Acme/Operations',
  type: 'project',
  isSymlink: true,
  hasReadme: true,
  status: 'ok',
  displayName: 'Acme — Operations',
};

describe('viewShared spaces filter helpers', () => {
  it('includes sourcePath roots so symlinked spaces still match', () => {
    const roots = buildSpaceRoots([SYMLINKED_SPACE]);

    const matchesFromSourcePath = matchesFilter(
      {
        path: '/Volumes/CloudDrive/Acme/Operations/notes.md',
        relativePath: 'work/Acme/Operations/notes.md',
      },
      'spaces',
      roots,
    );

    expect(matchesFromSourcePath).toBe(true);
  });

  it('returns no spaces matches when roots are unavailable', () => {
    const roots = buildSpaceRoots([]);

    const matches = matchesFilter(
      {
        path: '/workspace/work/Acme/Operations/notes.md',
        relativePath: 'work/Acme/Operations/notes.md',
      },
      'spaces',
      roots,
    );

    expect(matches).toBe(false);
  });
});

describe('viewShared matchesSearch', () => {
  const entry = {
    name: 'Roadmap.md',
    relativePath: 'work/Mindstone/General/Roadmap.md',
    summary: 'Weekly Highlights and decisions',
  };

  it('matches case-insensitively across name, relative path, and summary', () => {
    expect(matchesSearch(entry, 'ROADMAP')).toBe(true);
    expect(matchesSearch(entry, 'mindstone/general')).toBe(true);
    expect(matchesSearch(entry, 'highlights')).toBe(true);
  });

  it('treats empty query as match-all', () => {
    expect(matchesSearch(entry, '   ')).toBe(true);
  });

  it('returns false when no field matches', () => {
    expect(matchesSearch(entry, 'nope')).toBe(false);
  });

  it('handles missing summary safely', () => {
    expect(matchesSearch({
      name: 'notes.md',
      relativePath: 'notes.md',
      summary: undefined,
    }, 'notes')).toBe(true);
  });
});
