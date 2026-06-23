import { useCallback, useRef } from 'react';
import type { FileNode } from '@shared/types';
import type { FileTreeMetadata } from '@shared/ipc/contracts';
import { flattenFileTree, type FlatFileEntry, type SkillMeta } from '@renderer/utils/librarySearch';
import { useAsyncData } from '@renderer/hooks/useAsyncData';

interface UseLibraryIndexOptions {
  autoLoad?: boolean;
  includeHidden?: boolean;
  enabled?: boolean;
}

interface LibraryIndexState {
  files: FlatFileEntry[] | null;
  loading: boolean;
  error: string | null;
  hasLoaded: boolean;
  refresh: () => Promise<void>;
  /** Ref that always contains the latest files value, updated synchronously on fetch completion.
   *  Useful for reading fresh data immediately after awaiting refresh() in async callbacks. */
  filesRef: React.RefObject<FlatFileEntry[] | null>;
  /** Completeness metadata from the last successful fetch (Bug-2). True `truncated` means this
   *  flattened index is a partial view of the workspace — consumers must not present it as complete. */
  treeMetadata: FileTreeMetadata | null;
}

export const useLibraryIndex = (
  options: UseLibraryIndexOptions = {}
): LibraryIndexState => {
  const { autoLoad = true, includeHidden = false, enabled = true } = options;

  // Side-channel for the wrapper metadata: useAsyncData only carries the flattened
  // entries, so we stash the matching metadata on a ref written inside the fetcher.
  // It is read after the entries commit, so it stays tied to the same fetch.
  const treeMetadataRef = useRef<FileTreeMetadata | null>(null);

  const fetcher = useCallback(async (): Promise<FlatFileEntry[]> => {
    // Fetch file tree and skill metadata in parallel (2 IPC calls instead of N+1)
    const [listResult, scanResult] = await Promise.all([
      window.libraryApi.listFiles({ includeHidden }),
      window.libraryApi.scanSkills(),
    ]);
    // listResult is contract-typed as the LibraryListFilesResponse wrapper.
    // Read `.nodes` directly — a `?? []` here would silently turn an
    // undefined/null/old-bare-array response into an empty library, masking a
    // malformed response as "no files". Fail loud instead.
    const tree: FileNode[] = listResult.nodes;
    treeMetadataRef.current = listResult.metadata;

    const entries = flattenFileTree(tree);

    // Build a map from skill directory absolute path → SkillMeta.
    // scanSkills returns SkillInfo with absolutePath pointing to the SKILL.md file,
    // so we strip the trailing /SKILL.md (or \SKILL.md) to get the directory path.
    const skillMetaByDir = new Map<string, SkillMeta>();
    if (!scanResult.success && import.meta.env.DEV) {
      console.warn('[useLibraryIndex] scanSkills failed — skill metadata unavailable for this refresh');
    }
    if (scanResult.success) {
      for (const group of scanResult.groups) {
        for (const skills of Object.values(group.categories)) {
          for (const skill of skills) {
            // Only match folder-based skills (absolutePath ends with /SKILL.md)
            const dirPath = skill.absolutePath.replace(/[/\\]SKILL\.md$/, '');
            if (dirPath !== skill.absolutePath) {
              skillMetaByDir.set(dirPath, {
                name: skill.name,
                description: skill.frontmatter?.description,
              });
            }
          }
        }
      }
    }

    // Attach skill metadata to directory entries by matching absolute paths
    for (const entry of entries) {
      if (entry.node.kind !== 'directory') continue;
      const meta = skillMetaByDir.get(entry.node.path);
      if (meta) {
        entry.skillMeta = meta;
      }
    }

    return entries;
  }, [includeHidden]);

  const { data: files, loading, error, hasLoaded, refresh, dataRef: filesRef } = useAsyncData({
    fetcher,
    enabled,
    autoLoad,
    initialLoading: false,
  });

  return {
    files,
    loading,
    error,
    hasLoaded,
    refresh,
    filesRef,
    treeMetadata: treeMetadataRef.current,
  };
};
