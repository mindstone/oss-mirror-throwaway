import { describe, expect, it } from 'vitest';
import type { FileNode } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { inferSpaceStorage, spacesToCardEntries } from './spacesToCardEntries';

const SPACES_FIXTURE: SpaceInfo[] = [
  {
    name: 'Chief-of-Staff',
    path: 'Chief-of-Staff',
    absolutePath: '/workspace/Chief-of-Staff',
    type: 'chief-of-staff',
    isSymlink: false,
    hasReadme: true,
    status: 'ok',
    displayName: 'Private',
    description: 'Context for {COMPANY_NAME}',
    organisationName: 'Mindstone',
  },
  {
    name: 'Ops',
    path: 'work/Mindstone/Ops',
    absolutePath: '/workspace/work/Mindstone/Ops',
    type: 'project',
    isSymlink: true,
    sourcePath: '/Users/example/Google Drive/Acme/Ops',
    hasReadme: true,
    status: 'ok',
    sharing: 'restricted',
  },
];

const TREE_FIXTURE: FileNode[] = [
  {
    name: 'Chief-of-Staff',
    path: '/workspace/Chief-of-Staff',
    kind: 'directory',
    mtime: 1716400000000,
    children: [
      {
        name: 'memory',
        path: '/workspace/Chief-of-Staff/memory',
        kind: 'directory',
        mtime: 1716500000000,
        children: [
          {
            name: 'planning.md',
            path: '/workspace/Chief-of-Staff/memory/planning.md',
            kind: 'file',
            mtime: 1716600000000,
          },
        ],
      },
    ],
  },
];

describe('spacesToCardEntries', () => {
  it('maps spaces data to typed space cards using file tree enrichment', () => {
    const entries = spacesToCardEntries(SPACES_FIXTURE, TREE_FIXTURE);
    expect(entries).toHaveLength(2);

    const privateEntry = entries.find((entry) => entry.path === '/workspace/Chief-of-Staff');
    expect(privateEntry).toMatchObject({
      kind: 'space',
      name: 'Private',
      role: 'Personal',
      description: 'Context for Mindstone',
      fileCount: 1,
      lastActiveAt: 1716600000000,
      unavailable: false,
    });

    const unavailableEntry = entries.find((entry) => entry.path === '/workspace/work/Mindstone/Ops');
    expect(unavailableEntry).toMatchObject({
      kind: 'space',
      role: 'Project',
      unavailable: true,
      description: 'No description yet.',
      storageLabel: 'Google Drive',
      storageKey: 'google_drive',
      sharingLabel: 'Shared',
    });
  });

  it('returns empty array when spaces are unavailable', () => {
    expect(spacesToCardEntries([], TREE_FIXTURE)).toEqual([]);
    expect(spacesToCardEntries(null, TREE_FIXTURE)).toEqual([]);
  });

  it('does not infer storage for non-symlink spaces', () => {
    const [entry] = spacesToCardEntries([SPACES_FIXTURE[0]], TREE_FIXTURE);
    expect(entry?.storageLabel).toBeUndefined();
    expect(entry?.storageKey).toBeUndefined();
  });
});

describe('inferSpaceStorage', () => {
  it.each([
    ['/Users/me/Google Drive/Acme', { label: 'Google Drive', key: 'google_drive' }],
    ['/Users/me/GoogleDrive/Acme', { label: 'Google Drive', key: 'google_drive' }],
    ['/Users/me/iCloud Drive/Acme', { label: 'iCloud', key: 'icloud' }],
    ['/Users/me/OneDrive/Acme', { label: 'OneDrive', key: 'onedrive' }],
    ['/Users/me/Dropbox/Acme', { label: 'Dropbox', key: 'dropbox' }],
    ['/Users/me/box.com/Acme', { label: 'Box', key: 'box' }],
    ['/Users/me/Documents/Acme', { label: 'Linked folder', key: 'linked' }],
  ])('infers storage provider for %s', (sourcePath, expected) => {
    expect(inferSpaceStorage(sourcePath)).toEqual(expected);
  });

  it('returns null when no source path exists', () => {
    expect(inferSpaceStorage(undefined)).toBeNull();
  });
});
