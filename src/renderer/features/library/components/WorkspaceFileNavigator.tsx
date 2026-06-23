import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, MouseEvent } from 'react';
import type { FileNode } from '@shared/types';
import type { EmitLogFn } from '@renderer/contexts';
import { cn } from '@renderer/lib/utils';
import { useLibraryTree } from '../hooks/useLibraryTree';
import { useLibraryTreeChangedReload } from '../hooks/useLibraryTreeChangedReload';
import { LibraryTreeView } from './LibraryTreeView';
import { LibrarySearchTruncationNotice } from './LibrarySearchTruncationNotice';
import styles from './WorkspaceFileNavigator.module.css';

export type WorkspaceFileNavigatorProps = {
  /** Already-canonicalized absolute path of the currently-shown file, or null. The caller is responsible for canonicalization. */
  activePath: string | null;
  /** Workspace root (typically settings.coreDirectory). If null, the navigator renders an informational empty state and does not call listFiles. */
  coreDirectory: string | null;
  /** Invoked when the user selects a file row. Receives the absolute path of the selected file. */
  onSelectFile: (absolutePath: string) => void;
  /** Logger callback (matches the rest of the renderer's logging conventions). Pass from caller. */
  emitLog: EmitLogFn;
  /** Optional density override. Defaults to 'compact' for the navigator's intended slim-rail use. */
  density?: 'compact' | 'default';
  /** Optional test id. Defaults to 'workspace-file-navigator'. */
  testId?: string;
  /** Optional className for outer wrapper. */
  className?: string;
};

function findAncestorDirectoryPaths(
  nodes: FileNode[] | null | undefined,
  targetPath: string,
): string[] | null {
  if (!nodes || nodes.length === 0) return null;

  const search = (nodeList: FileNode[] | undefined, ancestors: string[]): string[] | null => {
    if (!nodeList || nodeList.length === 0) return null;

    for (const node of nodeList) {
      if (node.path === targetPath) {
        return ancestors;
      }

      if (node.kind === 'directory' && node.children) {
        const match = search(node.children, [...ancestors, node.path]);
        if (match) {
          return match;
        }
      }
    }

    return null;
  };

  return search(nodes, []);
}

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }

  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const NOOP_PROMISE = async (): Promise<void> => {};
const NOOP = (): void => {};
const NOOP_DRAG = (_event: DragEvent<HTMLDivElement>): void => {};
const NOOP_CONTEXT = (_event: MouseEvent<HTMLDivElement>): void => {};

export const WorkspaceFileNavigator = ({
  activePath,
  coreDirectory,
  onSelectFile,
  emitLog,
  density = 'compact',
  testId = 'workspace-file-navigator',
  className,
}: WorkspaceFileNavigatorProps) => {
  const rootRef = useRef<HTMLDivElement>(null);
  const lastWarnedActivePathRef = useRef<string | null>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const {
    tree,
    treeMetadata,
    loading,
    error,
    expandedDirectories,
    setExpandedDirectories,
    toggleDirectory,
    loadTree,
  } = useLibraryTree({
    emitLog,
    coreDirectory,
  });

  // Second render surface for the partial-tree notice (Bug-2). This navigator runs
  // its own useLibraryTree instance (no provider), so it reads completeness directly
  // from its own metadata rather than the provider context.
  const isPartialTree = treeMetadata?.truncated === true;

  useEffect(() => {
    lastWarnedActivePathRef.current = null;
  }, [activePath]);

  const reloadTree = useCallback(() => {
    if (!coreDirectory) return;
    void loadTree();
  }, [coreDirectory, loadTree]);

  useLibraryTreeChangedReload(reloadTree, { enabled: Boolean(coreDirectory) });

  useEffect(() => {
    if (!coreDirectory) return;
    void loadTree();
  }, [coreDirectory, loadTree]);

  const handleExpandDirectories = useCallback(
    (paths: readonly string[]) => {
      if (paths.length === 0) return;

      setExpandedDirectories((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const path of paths) {
          if (!next[path]) {
            next[path] = true;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    },
    [setExpandedDirectories],
  );

  useEffect(() => {
    if (!activePath || !tree) return;

    const ancestorPaths = findAncestorDirectoryPaths(tree, activePath);
    if (ancestorPaths && ancestorPaths.length > 0) {
      const collapsedAncestors = ancestorPaths.filter((path) => !expandedDirectories[path]);
      if (collapsedAncestors.length > 0) {
        handleExpandDirectories(collapsedAncestors);
      }
    }

    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 10;
    let timeoutId: number | null = null;

    const scrollToActiveRow = () => {
      if (cancelled) return;
      const activeRow = rootRef.current?.querySelector<HTMLElement>(
        `[data-path="${escapeSelectorValue(activePath)}"]`,
      );

      if (activeRow) {
        activeRow.scrollIntoView({ block: 'nearest' });
        return;
      }

      attempts += 1;
      if (attempts < maxAttempts) {
        timeoutId = window.setTimeout(scrollToActiveRow, 50);
      }
    };

    const frameId = window.requestAnimationFrame(scrollToActiveRow);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [activePath, expandedDirectories, handleExpandDirectories, tree]);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }

    if (!activePath || !coreDirectory || tree === null || loading) {
      return;
    }

    const hasMatch = findAncestorDirectoryPaths(tree, activePath) !== null;
    if (hasMatch) {
      return;
    }

    if (lastWarnedActivePathRef.current === activePath) {
      return;
    }
    lastWarnedActivePathRef.current = activePath;
    emitLog({
      level: 'warn',
      message: `WorkspaceFileNavigator: activePath '${activePath}' does not match any tree node. Ensure it's an absolute path under coreDirectory '${coreDirectory}'.`,
      context: { activePath, coreDirectory },
      timestamp: Date.now(),
    });
  }, [activePath, coreDirectory, emitLog, loading, tree]);

  const handleSelectNode = useCallback(
    (node: FileNode) => {
      if (node.kind === 'directory') {
        toggleDirectory(node.path);
        return;
      }

      onSelectFile(node.path);
    },
    [onSelectFile, toggleDirectory],
  );

  if (coreDirectory == null) {
    return (
      <div
        ref={rootRef}
        className={cn(styles.navigator, className)}
        data-testid={testId}
      >
        <div className={styles.emptyState}>
          <span className={styles.emptyStateText}>No workspace folder set.</span>
        </div>
      </div>
    );
  }

  if (loading && tree === null) {
    return (
      <div
        ref={rootRef}
        className={cn(styles.navigator, className)}
        data-testid={testId}
      >
        <div className={styles.emptyState}>
          <span className={styles.emptyStateText}>Loading workspace files…</span>
        </div>
      </div>
    );
  }

  if (error && tree === null) {
    return (
      <div
        ref={rootRef}
        className={cn(styles.navigator, className)}
        data-testid={testId}
      >
        <div className={styles.emptyState}>
          <span className={styles.emptyStateText}>Failed to load workspace files.</span>
        </div>
      </div>
    );
  }

  if (!loading && tree !== null && tree.length === 0) {
    return (
      <div
        ref={rootRef}
        className={cn(styles.navigator, className)}
        data-testid={testId}
      >
        {isPartialTree ? (
          <LibrarySearchTruncationNotice signal={{ kind: 'tree' }} placement="inline" />
        ) : null}
        <div className={styles.emptyState}>
          <span className={styles.emptyStateText}>No files in this workspace yet.</span>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={cn(styles.navigator, className)}
      data-testid={testId}
    >
      {isPartialTree ? (
        <LibrarySearchTruncationNotice signal={{ kind: 'tree' }} placement="inline" />
      ) : null}
      <LibraryTreeView
        nodes={tree}
        expandedDirectories={expandedDirectories}
        selectedPath={activePath}
        activePath={activePath}
        focusedPath={focusedPath}
        renamingPath={null}
        draggingNodePath={null}
        dropTarget={null}
        libraryRootAbsolute={coreDirectory}
        onSelectNode={handleSelectNode}
        onSelectFile={(node) => onSelectFile(node.path)}
        onFocusNode={setFocusedPath}
        onToggleExpand={toggleDirectory}
        onExpandDirectories={handleExpandDirectories}
        onContextMenu={NOOP_CONTEXT}
        onConfirmRename={NOOP_PROMISE}
        onCancelRename={NOOP}
        onDragStart={NOOP_DRAG}
        onDragOver={NOOP_DRAG}
        onDragLeave={NOOP_DRAG}
        onDrop={NOOP_DRAG}
        onDragEnd={NOOP}
        density={density}
      />
    </div>
  );
};
