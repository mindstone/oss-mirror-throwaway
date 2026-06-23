import { isBackgroundConversationSession } from '@shared/sessionKind';

export interface FolderSessionStateEntry {
  id: string;
  isActive: boolean;
  isDeleted?: boolean;
}

export type FolderPinnedState = 'empty' | 'active' | 'done' | 'mixed';

function getLiveFolderEntries(
  entries: FolderSessionStateEntry[],
  membership: Record<string, string>,
  folderId: string,
): FolderSessionStateEntry[] {
  return entries.filter((entry) =>
    !entry.isDeleted &&
    membership[entry.id] === folderId &&
    !isBackgroundConversationSession(entry.id)
  );
}

export function getFolderPinnedState(
  entries: FolderSessionStateEntry[],
  membership: Record<string, string>,
  folderId: string,
): FolderPinnedState {
  const folderEntries = getLiveFolderEntries(entries, membership, folderId);
  if (folderEntries.length === 0) {
    return 'empty';
  }

  const activeCount = folderEntries.filter((entry) => entry.isActive).length;
  if (activeCount === folderEntries.length) {
    return 'active';
  }
  if (activeCount === 0) {
    return 'done';
  }
  return 'mixed';
}

export function getFolderSessionIdsToSetActiveState(
  entries: FolderSessionStateEntry[],
  membership: Record<string, string>,
  folderId: string,
  nextActive: boolean,
): string[] {
  return getLiveFolderEntries(entries, membership, folderId)
    .filter((entry) => entry.isActive !== nextActive)
    .map((entry) => entry.id);
}
