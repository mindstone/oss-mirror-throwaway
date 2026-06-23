import { isMemoryPath, isSkillPath } from '@renderer/utils/skillUtils';

export type LibraryItemKind = 'skill' | 'memory' | 'plain';

export interface ClassifiableItem {
  path?: string | null;
  relativePath?: string | null;
  fullPath?: string | null;
  skillMeta?: unknown;
}

export function classifyLibraryItem(item: ClassifiableItem | null | undefined): LibraryItemKind {
  if (!item) return 'plain';
  const candidate = item.relativePath ?? item.fullPath ?? item.path ?? '';
  if (typeof candidate !== 'string' || candidate.length === 0) return 'plain';
  if (item.skillMeta != null || isSkillPath(candidate)) return 'skill';
  if (isMemoryPath(candidate)) return 'memory';
  return 'plain';
}
