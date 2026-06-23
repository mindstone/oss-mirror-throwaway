import type { FileNode } from '@shared/types';
import type { SpaceInfo } from '@shared/ipc/schemas/library';

export interface SpaceCardEntry {
  id: string;
  kind: 'space';
  name: string;
  path: string;
  relativePath: string;
  role: string;
  description: string;
  lastActiveAt?: number;
  fileCount?: number;
  memberCount?: number;
  conversationCount?: number;
  storageLabel?: string;
  storageKey?: string;
  sharingLabel?: string;
  unavailable: boolean;
  sourceSpace: SpaceInfo;
}

function resolveCompanyNamePlaceholder(text: string, space: SpaceInfo): string {
  const replacement = space.organisationName?.trim();
  if (!replacement) {
    return text;
  }
  return text.replace(/\{COMPANY_NAME\}/g, replacement);
}

function getSpaceRole(space: SpaceInfo): string {
  if (space.type === 'chief-of-staff' || space.type === 'personal') {
    return 'Personal';
  }
  if (space.organisationName?.trim()) {
    return space.organisationName.trim();
  }
  if (space.type === 'company') {
    return 'Work';
  }
  if (space.type === 'project' || space.type === 'team') {
    return 'Project';
  }
  return 'Space';
}

type SpaceStorageDescriptor = {
  label: string;
  key: string;
};

export function inferSpaceStorage(sourcePath?: string): SpaceStorageDescriptor | null {
  const lower = sourcePath?.toLowerCase() ?? '';
  if (!lower) {
    return null;
  }
  if (
    lower.includes('googledrive')
    || lower.includes('google drive')
    || lower.includes('/google/')
  ) {
    return { label: 'Google Drive', key: 'google_drive' };
  }
  if (lower.includes('icloud')) {
    return { label: 'iCloud', key: 'icloud' };
  }
  if (lower.includes('onedrive')) {
    return { label: 'OneDrive', key: 'onedrive' };
  }
  if (lower.includes('dropbox')) {
    return { label: 'Dropbox', key: 'dropbox' };
  }
  if (lower.includes('box.com') || lower.includes('/box/')) {
    return { label: 'Box', key: 'box' };
  }
  return { label: 'Linked folder', key: 'linked' };
}

function resolveSharingLabel(sharing: string | undefined): string | undefined {
  const normalized = sharing?.trim().toLowerCase();
  if (!normalized || normalized === 'private') {
    return undefined;
  }
  if (normalized === 'restricted' || normalized === 'team') {
    return 'Shared';
  }
  if (normalized === 'company-wide') {
    return 'Company';
  }
  if (normalized === 'public') {
    return 'Public';
  }
  return 'Shared';
}

type TreeNodeStats = {
  fileCount: number;
  lastActiveAt?: number;
};

function buildTreeNodeStatsByPath(
  nodes: readonly FileNode[] | null | undefined,
): Map<string, TreeNodeStats> {
  const statsByPath = new Map<string, TreeNodeStats>();
  if (!nodes || nodes.length === 0) {
    return statsByPath;
  }

  const stack: Array<{ node: FileNode; visited: boolean }> = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    stack.push({ node: nodes[index], visited: false });
  }

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    const { node, visited } = current;
    if (!visited) {
      stack.push({ node, visited: true });
      if (node.kind === 'directory' && node.children) {
        for (let childIndex = node.children.length - 1; childIndex >= 0; childIndex -= 1) {
          stack.push({ node: node.children[childIndex], visited: false });
        }
      }
      continue;
    }

    if (node.kind === 'file') {
      statsByPath.set(node.path, {
        fileCount: 1,
        lastActiveAt: typeof node.mtime === 'number' && node.mtime > 0 ? node.mtime : undefined,
      });
      continue;
    }

    let fileCount = 0;
    let lastActiveAt = typeof node.mtime === 'number' && node.mtime > 0 ? node.mtime : undefined;

    for (const child of node.children ?? []) {
      const childStats = statsByPath.get(child.path);
      if (!childStats) continue;
      fileCount += childStats.fileCount;
      if ((childStats.lastActiveAt ?? 0) > (lastActiveAt ?? 0)) {
        lastActiveAt = childStats.lastActiveAt;
      }
    }

    statsByPath.set(node.path, { fileCount, lastActiveAt });
  }

  return statsByPath;
}

export function spacesToCardEntries(
  spacesData: readonly SpaceInfo[] | null | undefined,
  fileTree?: readonly FileNode[] | null,
): SpaceCardEntry[] {
  if (!spacesData || spacesData.length === 0) {
    return [];
  }

  const treeStatsByPath = buildTreeNodeStatsByPath(fileTree);

  return spacesData.map((space) => {
    const nodeStats = treeStatsByPath.get(space.absolutePath);
    const description = space.description?.trim()
      ? resolveCompanyNamePlaceholder(space.description.trim(), space)
      : 'No description yet.';
    const storage = space.isSymlink ? inferSpaceStorage(space.sourcePath) : null;
    const sharingLabel = resolveSharingLabel(space.sharing);

    return {
      id: space.absolutePath,
      kind: 'space',
      name: space.displayName?.trim() || space.name,
      path: space.absolutePath,
      relativePath: space.path,
      role: getSpaceRole(space),
      description,
      lastActiveAt: nodeStats?.lastActiveAt,
      fileCount: nodeStats?.fileCount,
      memberCount: undefined,
      conversationCount: undefined,
      storageLabel: storage?.label,
      storageKey: storage?.key,
      sharingLabel,
      unavailable: !nodeStats,
      sourceSpace: space,
    };
  });
}
