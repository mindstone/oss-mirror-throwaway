import type { MemoryHistoryEntry } from '@shared/types';
import type { PendingMemoryRequest } from '../../../hooks/usePendingMemoryApprovals';
import { getFileName } from '@renderer/utils/stringUtils';
import { isNonMemoryAssetPath } from '../../../utils/facets';

export interface MemoryCardEntry {
  id: string;
  kind: 'memory';
  name: string;
  path: string;
  relativePath: string;
  snippet: string;
  createdAt: number;
  sourceSessionId: string;
  sourceTurnId: string;
  sourceSessionTitle?: string;
  entity: string;
  visibility: 'private' | 'shared';
  tags: string[];
}

type MaybeTaggedMemoryHistoryEntry = MemoryHistoryEntry & {
  tags?: unknown;
};

function isAbsolutePath(candidate: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\/|\\\\)/.test(candidate);
}

function joinWorkspacePath(root: string, relativePath: string): string {
  if (!root) return relativePath;
  const normalizedRoot = root.replace(/[\\/]+$/, '');
  const normalizedRelative = relativePath.replace(/^[\\/]+/, '');
  return `${normalizedRoot}/${normalizedRelative}`;
}

function truncateSnippet(value: string, maxLength: number = 180): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength).trim()}…`;
}

function resolveEntryEntity(entry: MemoryHistoryEntry): string {
  const candidate = typeof entry.entity === 'string' ? entry.entity.trim() : '';
  return candidate || 'Memory';
}

function resolveEntryTags(entry: MaybeTaggedMemoryHistoryEntry): string[] {
  const candidateTags = Array.isArray(entry.tags) ? entry.tags : [];
  const normalizedTags = candidateTags
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  if (normalizedTags.length > 0) {
    return normalizedTags;
  }
  return [resolveEntryEntity(entry), entry.visibility];
}

export function memoryHistoryToCardEntries(
  memoryEntries: readonly MemoryHistoryEntry[] | null | undefined,
  _pendingApprovals: readonly PendingMemoryRequest[] | null | undefined,
  libraryRootAbsolute?: string,
): MemoryCardEntry[] {
  if (!memoryEntries || memoryEntries.length === 0) {
    return [];
  }

  return memoryEntries.filter((entry) => !isNonMemoryAssetPath(entry.filePath)).map((entry) => {
    const taggedEntry = entry as MaybeTaggedMemoryHistoryEntry;
    const relativePath = entry.filePath?.trim() || `memory/${entry.id}.md`;
    const path = isAbsolutePath(relativePath)
      ? relativePath
      : joinWorkspacePath(libraryRootAbsolute ?? '', relativePath);
    const entity = resolveEntryEntity(entry);

    return {
      id: entry.id,
      kind: 'memory',
      name: getFileName(relativePath),
      path,
      relativePath,
      snippet: truncateSnippet(entry.summary || 'Memory entry'),
      createdAt: entry.timestamp,
      sourceSessionId: entry.sessionId,
      sourceTurnId: entry.turnId,
      sourceSessionTitle: entry.sessionTitle,
      entity,
      visibility: entry.visibility,
      tags: resolveEntryTags(taggedEntry),
    };
  });
}
