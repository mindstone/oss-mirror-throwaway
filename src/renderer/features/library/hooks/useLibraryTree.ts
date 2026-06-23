import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileNode } from '@shared/types';
import type { FileTreeMetadata } from '@shared/ipc/contracts';
import type { EmitLogFn } from '@renderer/contexts';

type UseLibraryTreeOptions = {
  emitLog: EmitLogFn;
  initialShowHidden?: boolean;
  coreDirectory?: string | null;
};

export const useLibraryTree = ({ emitLog, initialShowHidden = false, coreDirectory = null }: UseLibraryTreeOptions) => {
  const normalizedCoreDirectory = coreDirectory ?? null;
  const activeCoreDirectoryRef = useRef<string | null>(normalizedCoreDirectory);
  const generationRef = useRef(0);
  const isMountedRef = useRef(true);
  const [tree, setTree] = useState<FileNode[] | null>(null);
  // Completeness metadata travels WITH the tree (Bug-2 safety invariant). Stage 3
  // re-points the truncation notice at this instead of the separate stats walk.
  const [treeMetadata, setTreeMetadata] = useState<FileTreeMetadata | null>(null);
  const [treeCoreDirectory, setTreeCoreDirectory] = useState<string | null>(normalizedCoreDirectory);
  // Latest tree + its core directory, mirrored into refs so loadTree can read
  // them (for the empty-incomplete preservation guard, RC-1) without taking a
  // `tree` dependency that would churn the callback identity on every change.
  const latestTreeRef = useRef<FileNode[] | null>(null);
  const latestTreeCoreDirectoryRef = useRef<string | null>(normalizedCoreDirectory);
  latestTreeRef.current = tree;
  latestTreeCoreDirectoryRef.current = treeCoreDirectory;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHiddenFiles, setShowHiddenFiles] = useState(initialShowHidden);
  const [expandedDirectories, setExpandedDirectories] = useState<Record<string, boolean>>({});

  if (activeCoreDirectoryRef.current !== normalizedCoreDirectory) {
    activeCoreDirectoryRef.current = normalizedCoreDirectory;
    generationRef.current += 1;
  }

  useEffect(() => () => {
    isMountedRef.current = false;
  }, []);

  const loadTree = useCallback(
    async (includeHiddenOverride?: boolean, options?: { resetExpanded?: boolean }) => {
      const includeHidden = includeHiddenOverride ?? showHiddenFiles;
      const resetExpanded = options?.resetExpanded ?? false;
      const loadGeneration = generationRef.current;
      const loadCoreDirectory = activeCoreDirectoryRef.current;
      const isCurrentLoad = () =>
        generationRef.current === loadGeneration &&
        activeCoreDirectoryRef.current === loadCoreDirectory;
      const canCommit = () => isMountedRef.current && isCurrentLoad();

      try {
        setLoading(true);
        setError(null);
        const response = await window.libraryApi.listFiles({ includeHidden });
        if (!canCommit()) {
          return;
        }
        const nextTree = response.nodes;

        // Never let a slow/partial scan WIPE a tree the user could already see
        // (RC-1 "files disappear after visiting Library"). An empty result is
        // only trustworthy as "the workspace is empty" when the scan ran to
        // completion. An empty-AND-incomplete result means the scan was
        // truncated/degraded before it found anything — keep the prior populated
        // tree rather than blanking the Library. A genuinely empty workspace
        // (complete:true, empty) and any non-empty result still update normally.
        const isEmptyIncomplete =
          (nextTree?.length ?? 0) === 0 && !response.metadata.complete;
        const hadPopulatedTree =
          latestTreeCoreDirectoryRef.current === loadCoreDirectory &&
          (latestTreeRef.current?.length ?? 0) > 0;

        if (isEmptyIncomplete && hadPopulatedTree) {
          // Refresh metadata so the partial/degraded state is observable, but
          // preserve the visible tree. Do NOT advance treeCoreDirectory away
          // from the populated snapshot.
          setTreeMetadata(response.metadata);
          emitLog({
            level: 'warn',
            message: 'Library scan returned empty+incomplete; preserving previously-loaded tree',
            context: {
              includeHidden,
              truncated: response.metadata.truncated,
              reasons: response.metadata.reasons,
              unavailableNodes: response.metadata.unavailableNodes,
            },
            timestamp: Date.now()
          });
        } else {
          setTree(nextTree);
          setTreeMetadata(response.metadata);
          setTreeCoreDirectory(loadCoreDirectory);
          if (resetExpanded) {
            setExpandedDirectories({});
          }
          emitLog({
            level: 'info',
            message: 'Workspace tree loaded',
            context: {
              includeHidden,
              nodeCount: nextTree?.length ?? 0,
              truncated: response.metadata.truncated,
              returnedNodes: response.metadata.returnedNodes,
            },
            timestamp: Date.now()
          });
        }
      } catch (err) {
        if (canCommit()) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          emitLog({
            level: 'error',
            message: 'Failed to load workspace tree',
            context: { includeHidden, error: message },
            timestamp: Date.now()
          });
        }
      } finally {
        if (canCommit()) {
          setLoading(false);
        }
      }
    },
    [emitLog, showHiddenFiles]
  );

  const toggleDirectory = useCallback((path: string) => {
    setExpandedDirectories((prev) => ({
      ...prev,
      [path]: !prev[path]
    }));
  }, []);

  const isTreeForCurrentCoreDirectory = treeCoreDirectory === normalizedCoreDirectory;

  return {
    tree: isTreeForCurrentCoreDirectory ? tree : null,
    treeMetadata: isTreeForCurrentCoreDirectory ? treeMetadata : null,
    setTree,
    loading: loading || (!isTreeForCurrentCoreDirectory && Boolean(normalizedCoreDirectory)),
    setLoading,
    error: isTreeForCurrentCoreDirectory ? error : null,
    showHiddenFiles,
    setShowHiddenFiles,
    expandedDirectories,
    setExpandedDirectories,
    toggleDirectory,
    loadTree
  } as const;
};
