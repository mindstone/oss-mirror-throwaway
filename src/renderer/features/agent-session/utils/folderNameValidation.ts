import type { ConversationFolder } from '@shared/ipc/schemas/folders';

export const MAX_FOLDER_NAME_LENGTH = 100;

/** Soft cap — warn when creating another folder while at or above this count */
export const SOFT_FOLDER_COUNT_WARNING_THRESHOLD = 50;

/** Case-insensitive duplicate check; excludes one folder when renaming. */
export function isDuplicateFolderName(
  name: string,
  folders: ConversationFolder[],
  excludeFolderId?: string,
): boolean {
  const t = name.trim().toLowerCase();
  if (!t) return false;
  return folders.some(
    (f) => f.id !== excludeFolderId && f.name.trim().toLowerCase() === t,
  );
}
