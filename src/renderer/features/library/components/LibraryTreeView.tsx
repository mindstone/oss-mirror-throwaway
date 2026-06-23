import { memo, useState, useCallback, useRef, useEffect } from 'react';
import type { DragEvent, MouseEvent, KeyboardEvent } from 'react';
import type { FileNode } from '@shared/types';
import { cn } from '@renderer/lib/utils';
import { ChevronRight, Folder, MoreVertical, Star } from 'lucide-react';
import drawerStyles from './LibraryDrawer.module.css';
import { buildTreeItemClassName } from '../utils/classNames';
import { Badge, Tooltip } from '@renderer/components/ui';
import { getFileIcon } from '../utils/fileTypeIcons';

/** Flatten visible tree nodes into an ordered list for keyboard navigation */
function flattenVisibleNodes(
  nodes: FileNode[] | null | undefined,
  expandedDirectories: Record<string, boolean>
): FileNode[] {
  const result: FileNode[] = [];
  
  function traverse(nodeList: FileNode[] | undefined) {
    if (!nodeList) return;
    for (const node of nodeList) {
      result.push(node);
      if (node.kind === 'directory' && expandedDirectories[node.path] && node.children) {
        traverse(node.children);
      }
    }
  }
  
  traverse(nodes ?? undefined);
  return result;
}

/** Text component that only shows tooltip when content is truncated */
const TruncatedText = ({ text, className }: { text: string; className?: string }) => {
  const [isTruncated, setIsTruncated] = useState(false);

  const handleMouseEnter = useCallback((e: MouseEvent<HTMLSpanElement>) => {
    const el = e.currentTarget;
    setIsTruncated(el.scrollWidth > el.clientWidth);
  }, []);

  return (
    <Tooltip content={text} disabled={!isTruncated}>
      <span className={className} onMouseEnter={handleMouseEnter}>
        {text}
      </span>
    </Tooltip>
  );
};

export type LibraryDropTarget =
  | { kind: 'directory'; path: string; isValid: boolean }
  | { kind: 'root'; isValid: boolean }
  | null;

export type LibraryTreeViewProps = {
  nodes: FileNode[] | null | undefined;
  expandedDirectories: Record<string, boolean>;
  selectedPath: string | null;
  activePath: string | null;
  focusedPath: string | null;
  renamingPath: string | null;
  draggingNodePath: string | null;
  dropTarget: LibraryDropTarget;
  libraryRootAbsolute: string;
  onSelectNode: (node: FileNode, event?: MouseEvent<HTMLDivElement>) => void;
  onSelectFile?: (node: FileNode) => void;
  onFocusNode: (path: string | null) => void;
  onToggleExpand: (path: string) => void;
  onExpandDirectories?: (paths: readonly string[]) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>, node: FileNode) => void;
  onConfirmRename: (path: string, name: string) => Promise<void>;
  onCancelRename: () => void;
  onDragStart: (event: DragEvent<HTMLDivElement>, node: FileNode) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>, node: FileNode) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>, node: FileNode) => void;
  onDrop: (event: DragEvent<HTMLDivElement>, node: FileNode) => void;
  onDragEnd: () => void;
  /** Check if a file is favorited/pinned */
  isFileFavorite?: (filePath: string) => boolean;
  /** Toggle favorite status for a file */
  onToggleFileFavorite?: (filePath: string) => void;
  density?: 'default' | 'compact';
};

// Indent constants: 16px per level for first 5 levels, then 6px to prevent excessive nesting indent.
// Note: Paddings accumulate due to nested <ul> structure, so we use constant steps rather than depth-multiplied values.
const WORKSPACE_TREE_INDENT_NORMAL = 16;
const WORKSPACE_TREE_INDENT_COMPACT = 12;
const WORKSPACE_TREE_INDENT_DEEP = 6;
const WORKSPACE_TREE_INDENT_THRESHOLD = 5;

const getDepthPadding = (depth: number, density: 'default' | 'compact'): number => {
  if (depth <= 0) return 0;
  if (depth > WORKSPACE_TREE_INDENT_THRESHOLD) {
    return WORKSPACE_TREE_INDENT_DEEP;
  }
  return density === 'compact' ? WORKSPACE_TREE_INDENT_COMPACT : WORKSPACE_TREE_INDENT_NORMAL;
};

const TreeNodes = memo(function TreeNodes({
  nodes,
  depth,
  expandedDirectories,
  selectedPath,
  activePath,
  focusedPath,
  renamingPath,
  draggingNodePath,
  dropTarget,
  libraryRootAbsolute,
  onSelectNode,
  onFocusNode,
  onToggleExpand,
  onContextMenu,
  onConfirmRename,
  onCancelRename,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  isFileFavorite,
  onToggleFileFavorite,
  density = 'default',
}: Omit<LibraryTreeViewProps, 'nodes'> & { nodes: FileNode[] | null | undefined; depth: number }) {
  if (!nodes || nodes.length === 0) {
    return null;
  }

  const paddingLeft = getDepthPadding(depth, density);
  const isCompactDensity = density === 'compact';
  const treeStyle = isCompactDensity
    ? (paddingLeft
        ? { paddingLeft: `${paddingLeft}px`, minWidth: 'max-content' }
        : { minWidth: 'max-content' })
    : (paddingLeft ? { paddingLeft: `${paddingLeft}px` } : undefined);

  return (
    <ul className={drawerStyles.tree} style={treeStyle}>
      {nodes.map((node) => {
        const isRenaming = renamingPath === node.path;
        const isSelected = selectedPath === node.path;
        const isActive = activePath === node.path;
        const isFocused = focusedPath === node.path;
        const isDragSource = draggingNodePath === node.path;
        const isDropTargetValid = dropTarget?.kind === 'directory' && dropTarget.path === node.path && dropTarget.isValid;
        const isDropTargetInvalid = dropTarget?.kind === 'directory' && dropTarget.path === node.path && !dropTarget.isValid;
        const isDirectory = node.kind === 'directory';
        const childCount = isDirectory ? (node.children?.length ?? 0) : 0;
        const isEmptyDirectory = isDirectory && childCount === 0;
        const expanded = Boolean(expandedDirectories[node.path]);
        const folderCountTooltip =
          isDirectory && !isCompactDensity
            ? (childCount === 0
                ? 'Empty folder'
                : `${childCount} item${childCount === 1 ? '' : 's'}`)
            : undefined;
        const treeItemClassName = cn(
          buildTreeItemClassName({ kind: node.kind, isActive, isSelected }),
          isFocused && drawerStyles.treeItemFocused,
          isDragSource && drawerStyles.treeItemDragSource,
          isDropTargetValid && drawerStyles.treeItemDropTargetValid,
          isDropTargetInvalid && drawerStyles.treeItemDropTargetInvalid
        );

        return (
          <li key={node.path}>
            <div
              className={treeItemClassName}
              data-path={node.path}
              data-testid="library-tree-item"
              data-relpath={libraryRootAbsolute ? node.path.replace(libraryRootAbsolute, '').replace(/^[/\\]/, '') : node.name}
              onClick={(event) => !isRenaming && onSelectNode(node, event)}
              onContextMenu={(event) => onContextMenu(event, node)}
              draggable={!isRenaming && Boolean(libraryRootAbsolute)}
              onDragStart={(event) => onDragStart(event, node)}
              onDragOver={(event) => onDragOver(event, node)}
              onDragLeave={(event) => onDragLeave(event, node)}
              onDrop={(event) => onDrop(event, node)}
              onDragEnd={onDragEnd}
              aria-grabbed={isDragSource || undefined}
              aria-dropeffect={draggingNodePath && isDirectory ? 'move' : undefined}
              aria-expanded={isDirectory ? expanded : undefined}
              aria-disabled={isEmptyDirectory || undefined}
            >
              <span className={drawerStyles.treeItemIcon} aria-hidden>
                {isDirectory ? (
                  <Folder size={14} strokeWidth={1.5} />
                ) : (
                  getFileIcon(node.name)
                )}
              </span>
              {isRenaming ? (
                <input
                  type="text"
                  className={drawerStyles.renameInput}
                  defaultValue={node.name}
                  autoFocus
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      void onConfirmRename(node.path, event.currentTarget.value);
                    } else if (event.key === 'Escape') {
                      onCancelRename();
                    }
                  }}
                  onBlur={(event) => void onConfirmRename(node.path, event.currentTarget.value)}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <TruncatedText text={node.name} className={drawerStyles.treeItemName} />
              )}
              {isDirectory && (
                <span className={drawerStyles.treeItemMeta}>
                  {!isCompactDensity ? (
                    <Tooltip content={folderCountTooltip} placement="left" disabled={!isDirectory}>
                      <Badge
                        variant="muted"
                        size="sm"
                        className={cn(isEmptyDirectory && drawerStyles.treeItemCountEmpty)}
                        data-testid="library-tree-item-count-badge"
                      >
                        {childCount > 99 ? '99+' : childCount}
                      </Badge>
                    </Tooltip>
                  ) : null}
                  {!isEmptyDirectory ? (
                    <span
                      className={cn(
                        drawerStyles.treeItemExpandIcon,
                        expanded && drawerStyles.treeItemExpandIconExpanded
                      )}
                      aria-hidden
                    >
                      <ChevronRight size={12} strokeWidth={1.5} />
                    </span>
                  ) : null}
                </span>
              )}
              {/* Star/pin button for files and folders - appears on hover */}
              {!isRenaming && onToggleFileFavorite && (
                <button
                  type="button"
                  className={cn(
                    drawerStyles.treeItemStarButton,
                    isDirectory && drawerStyles.treeItemStarButtonDirectory,
                    isCompactDensity && drawerStyles.treeItemStarButtonCompact,
                    isCompactDensity && isDirectory && drawerStyles.treeItemStarButtonCompactDirectory,
                    isFileFavorite?.(node.path) && drawerStyles.treeItemStarButtonActive,
                  )}
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleFileFavorite(node.path);
                  }}
                  aria-label={isFileFavorite?.(node.path) ? `Unfavourite ${node.name}` : `Favourite ${node.name}`}
                  title={isFileFavorite?.(node.path) ? 'Unfavourite' : 'Favourite'}
                >
                  <Star size={12} strokeWidth={1.5} fill={isFileFavorite?.(node.path) ? 'currentColor' : 'none'} />
                </button>
              )}
              {!isRenaming && !isCompactDensity ? (
                <button
                  type="button"
                  className={drawerStyles.treeItemMoreButton}
                  data-testid="library-tree-item-more-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onContextMenu(event as unknown as MouseEvent<HTMLDivElement>, node);
                    (event.currentTarget as HTMLButtonElement).blur();
                  }}
                  aria-label={`More actions for ${node.name}`}
                >
                  <MoreVertical size={14} strokeWidth={1.5} />
                </button>
              ) : null}
            </div>
            {isDirectory && expanded ? (
              (node.children && node.children.length > 0) ? (
                <TreeNodes
                  nodes={node.children}
                  depth={depth + 1}
                  expandedDirectories={expandedDirectories}
                  selectedPath={selectedPath}
                  activePath={activePath}
                  focusedPath={focusedPath}
                  renamingPath={renamingPath}
                  draggingNodePath={draggingNodePath}
                  dropTarget={dropTarget}
                  libraryRootAbsolute={libraryRootAbsolute}
                  onSelectNode={onSelectNode}
                  onFocusNode={onFocusNode}
                  onToggleExpand={onToggleExpand}
                  onContextMenu={onContextMenu}
                  onConfirmRename={onConfirmRename}
                  onCancelRename={onCancelRename}
                  onDragStart={onDragStart}
                  onDragOver={onDragOver}
                  onDragLeave={onDragLeave}
                  onDrop={onDrop}
                  onDragEnd={onDragEnd}
                  isFileFavorite={isFileFavorite}
                  onToggleFileFavorite={onToggleFileFavorite}
                  density={density}
                />
              ) : (
                <ul
                  className={drawerStyles.tree}
                  style={{ paddingLeft: `${getDepthPadding(depth + 1, density)}px` }}
                >
                  <li>
                    <div className={drawerStyles.treeEmptyPlaceholder}>This folder is empty</div>
                  </li>
                </ul>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
});

export const LibraryTreeView = (props: LibraryTreeViewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    nodes,
    expandedDirectories,
    focusedPath,
    selectedPath,
    onFocusNode,
    onSelectNode,
    onToggleExpand,
    density = 'default',
  } = props;
  
  const visibleNodes = flattenVisibleNodes(nodes, expandedDirectories);
  
  // Scroll focused item into view (keyboard navigation)
  useEffect(() => {
    if (!focusedPath || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-path="${CSS.escape(focusedPath)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focusedPath]);
  
  // Scroll selected item into view (click selection) - center it so user sees context
  // Uses manual scroll calculation for reliable behavior in nested scroll containers
  useEffect(() => {
    if (!selectedPath || !containerRef.current) return;
    const container = containerRef.current;
    const el = container.querySelector(`[data-path="${CSS.escape(selectedPath)}"]`) as HTMLElement | null;
    if (!el) return;
    
    // Calculate position to center the element in the scroll container
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const scrollTop = container.scrollTop + (elRect.top - containerRect.top) - (containerRect.height / 2) + (elRect.height / 2);
    container.scrollTo({ top: Math.max(0, scrollTop), behavior: 'smooth' });
  }, [selectedPath]);
  
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!visibleNodes.length) return;
    
    const currentIndex = focusedPath 
      ? visibleNodes.findIndex(n => n.path === focusedPath)
      : -1;
    const currentNode = currentIndex >= 0 ? visibleNodes[currentIndex] : null;
    
    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const nextIndex = currentIndex < visibleNodes.length - 1 ? currentIndex + 1 : 0;
        onFocusNode(visibleNodes[nextIndex].path);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prevIndex = currentIndex > 0 ? currentIndex - 1 : visibleNodes.length - 1;
        onFocusNode(visibleNodes[prevIndex].path);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (currentNode?.kind === 'directory' && !expandedDirectories[currentNode.path]) {
          onToggleExpand(currentNode.path);
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (currentNode?.kind === 'directory' && expandedDirectories[currentNode.path]) {
          onToggleExpand(currentNode.path);
        }
        break;
      }
      case 'Enter': {
        event.preventDefault();
        if (currentNode) {
          onSelectNode(currentNode);
        }
        break;
      }
      case 'Home': {
        event.preventDefault();
        if (visibleNodes.length > 0) {
          onFocusNode(visibleNodes[0].path);
        }
        break;
      }
      case 'End': {
        event.preventDefault();
        if (visibleNodes.length > 0) {
          onFocusNode(visibleNodes[visibleNodes.length - 1].path);
        }
        break;
      }
    }
  }, [visibleNodes, focusedPath, expandedDirectories, onFocusNode, onSelectNode, onToggleExpand]);
  
  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={cn(
        drawerStyles.treeContainer,
        density === 'compact' && drawerStyles.treeContainerCompact,
      )}
      role="tree"
      aria-label="Library files"
      data-testid="library-tree"
      data-density={density}
    >
      <TreeNodes {...props} depth={0} density={density} />
    </div>
  );
};
