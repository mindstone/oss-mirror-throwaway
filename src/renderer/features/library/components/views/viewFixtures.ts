import type { FileNode } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import type { LibraryTreeViewProps } from '../LibraryTreeView';
import type { LibraryViewEntry } from './viewShared';

const NOOP = () => undefined;

export const SAMPLE_TREE: FileNode[] = [
  {
    name: 'Chief-of-Staff',
    path: '/workspace/Chief-of-Staff',
    kind: 'directory',
    children: [
      {
        name: 'memory',
        path: '/workspace/Chief-of-Staff/memory',
        kind: 'directory',
        children: [
          {
            name: 'weekly-summary.md',
            path: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
            kind: 'file',
            mtime: 1716441000000,
          },
        ],
      },
      {
        name: 'skills',
        path: '/workspace/Chief-of-Staff/skills',
        kind: 'directory',
        children: [
          {
            name: 'meeting-prep',
            path: '/workspace/Chief-of-Staff/skills/meeting-prep',
            kind: 'directory',
            children: [
              {
                name: 'SKILL.md',
                path: '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
                kind: 'file',
                mtime: 1716442000000,
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'work',
    path: '/workspace/work',
    kind: 'directory',
    children: [
      {
        name: 'Mindstone',
        path: '/workspace/work/Mindstone',
        kind: 'directory',
        children: [
          {
            name: 'General',
            path: '/workspace/work/Mindstone/General',
            kind: 'directory',
            children: [
              {
                name: 'roadmap.md',
                path: '/workspace/work/Mindstone/General/roadmap.md',
                kind: 'file',
                mtime: 1716443000000,
              },
            ],
          },
        ],
      },
    ],
  },
  {
    name: 'notes.md',
    path: '/workspace/notes.md',
    kind: 'file',
    mtime: 1716444000000,
  },
];

export const SAMPLE_SPACES: SpaceInfo[] = [
  {
    name: 'Chief-of-Staff',
    path: 'Chief-of-Staff',
    absolutePath: '/workspace/Chief-of-Staff',
    type: 'chief-of-staff',
    isSymlink: false,
    hasReadme: true,
    status: 'ok',
    displayName: 'Private',
  },
  {
    name: 'General',
    path: 'work/Mindstone/General',
    absolutePath: '/workspace/work/Mindstone/General',
    type: 'project',
    isSymlink: false,
    hasReadme: true,
    status: 'ok',
    organisationName: 'Mindstone',
    displayName: 'Mindstone — General',
  },
];

export const SAMPLE_SPACES_STATES: SpaceInfo[] = [
  {
    name: 'active-space',
    path: 'active-space',
    absolutePath: '/workspace/active-space',
    type: 'project',
    isSymlink: false,
    hasReadme: true,
    status: 'ok',
    displayName: 'Active space',
    organisationName: 'Mindstone',
    description: 'Recently updated product plans and weekly notes.',
  },
  {
    name: 'detached-space',
    path: 'detached-space',
    absolutePath: '/workspace/detached-space',
    type: 'project',
    isSymlink: true,
    sourcePath: '/Users/example/OneDrive/Detached',
    hasReadme: false,
    status: 'ok',
    displayName: 'Detached space',
    organisationName: 'Mindstone',
    description: 'Linked space that is currently unavailable.',
    sharing: 'company-wide',
  },
  {
    name: 'quiet-space',
    path: 'quiet-space',
    absolutePath: '/workspace/quiet-space',
    type: 'team',
    isSymlink: false,
    hasReadme: true,
    status: 'ok',
    displayName: 'Quiet space',
    organisationName: 'Mindstone',
    description: 'No recent activity yet.',
    sharing: 'restricted',
  },
];

export const SAMPLE_SPACE_STATES_TREE: FileNode[] = [
  {
    name: 'active-space',
    path: '/workspace/active-space',
    kind: 'directory',
    children: [
      {
        name: 'weekly-update.md',
        path: '/workspace/active-space/weekly-update.md',
        kind: 'file',
        mtime: 1_716_445_000_000,
      },
    ],
  },
  {
    name: 'quiet-space',
    path: '/workspace/quiet-space',
    kind: 'directory',
    children: [],
  },
];

export const SAMPLE_ENTRIES: LibraryViewEntry[] = [
  {
    id: '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
    name: 'SKILL.md',
    path: '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
    relativePath: 'Chief-of-Staff/skills/meeting-prep/SKILL.md',
    kind: 'file',
    mtime: 1716442000000,
    content: '# meeting-prep\n',
  },
  {
    id: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
    name: 'weekly-summary.md',
    path: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
    relativePath: 'Chief-of-Staff/memory/weekly-summary.md',
    kind: 'file',
    mtime: 1716441000000,
    summary: 'Weekly highlights and decisions.',
  },
  {
    id: '/workspace/work/Mindstone/General/roadmap.md',
    name: 'roadmap.md',
    path: '/workspace/work/Mindstone/General/roadmap.md',
    relativePath: 'work/Mindstone/General/roadmap.md',
    kind: 'file',
    mtime: 1716443000000,
    summary: 'Shared roadmap planning.',
  },
  {
    id: '/workspace/notes.md',
    name: 'notes.md',
    path: '/workspace/notes.md',
    relativePath: 'notes.md',
    kind: 'file',
    mtime: 1716444000000,
    summary: 'Loose workspace note.',
  },
];

export function makeTreeViewProps(
  overrides: Partial<Omit<LibraryTreeViewProps, 'nodes'>> = {},
): Omit<LibraryTreeViewProps, 'nodes'> {
  return {
    expandedDirectories: {},
    selectedPath: null,
    activePath: null,
    focusedPath: null,
    renamingPath: null,
    draggingNodePath: null,
    dropTarget: null,
    libraryRootAbsolute: '/workspace',
    onSelectNode: NOOP as LibraryTreeViewProps['onSelectNode'],
    onFocusNode: NOOP as LibraryTreeViewProps['onFocusNode'],
    onToggleExpand: NOOP as LibraryTreeViewProps['onToggleExpand'],
    onContextMenu: NOOP as LibraryTreeViewProps['onContextMenu'],
    onConfirmRename: async () => undefined,
    onCancelRename: NOOP,
    onDragStart: NOOP as LibraryTreeViewProps['onDragStart'],
    onDragOver: NOOP as LibraryTreeViewProps['onDragOver'],
    onDragLeave: NOOP as LibraryTreeViewProps['onDragLeave'],
    onDrop: NOOP as LibraryTreeViewProps['onDrop'],
    onDragEnd: NOOP,
    ...overrides,
  };
}

export const SAMPLE_ATLAS_NODES = [
  {
    id: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
    path: '/workspace/Chief-of-Staff/memory/weekly-summary.md',
    relativePath: 'Chief-of-Staff/memory/weekly-summary.md',
    name: 'weekly-summary.md',
    x: 0.1,
    y: 0.2,
    z: 0.3,
    extension: 'md',
    chunkCount: 3,
    mtime: 1716441000000,
  },
  {
    id: '/workspace/work/Mindstone/General/roadmap.md',
    path: '/workspace/work/Mindstone/General/roadmap.md',
    relativePath: 'work/Mindstone/General/roadmap.md',
    name: 'roadmap.md',
    x: 0.2,
    y: 0.3,
    z: 0.4,
    extension: 'md',
    chunkCount: 5,
    mtime: 1716443000000,
  },
  {
    id: '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
    path: '/workspace/Chief-of-Staff/skills/meeting-prep/SKILL.md',
    relativePath: 'Chief-of-Staff/skills/meeting-prep/SKILL.md',
    name: 'SKILL.md',
    x: 0.4,
    y: 0.1,
    z: 0.2,
    extension: 'md',
    chunkCount: 4,
    mtime: 1716442000000,
  },
] as const;
