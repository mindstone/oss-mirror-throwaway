import type { FileNode } from '@shared/types';
import type { SearchResult } from '@renderer/utils/librarySearch';
import { highlightMatches } from '@renderer/utils/librarySearch';
import drawerStyles from './LibraryDrawer.module.css';
import { buildTreeItemClassName } from '../utils/classNames';
import { IncompleteLibraryHint } from './IncompleteLibraryHint';

export type LibrarySearchResultsProps = {
  results: SearchResult[];
  truncated?: boolean;
  /** True when the underlying file tree is a partial view (Bug-2) — distinguishes "no matches" from "incomplete Library". */
  isPartialTree?: boolean;
  selectedIndex: number;
  editorPath: string | null;
  workspaceRoot: string;
  query: string;
  onSelectResult: (node: FileNode) => void;
  onHoverResult: (index: number) => void;
};

export const LibrarySearchResults = ({
  results,
  truncated = false,
  isPartialTree = false,
  selectedIndex,
  editorPath,
  workspaceRoot,
  query,
  onSelectResult,
  onHoverResult
}: LibrarySearchResultsProps) => {
  const truncationHint = truncated ? (
    <p
      className={drawerStyles.searchFooterTruncationHint}
      data-testid="library-search-truncation-hint"
    >
      Searched first 100,000 files. Some matches may be missing.
    </p>
  ) : null;

  if (results.length === 0) {
    return (
      <div className={drawerStyles.searchEmpty}>
        <p>No files match "{query}"</p>
        <p className={drawerStyles.searchEmptyHint}>Try a shorter query or check spelling</p>
        <IncompleteLibraryHint show={isPartialTree} />
        {truncationHint}
      </div>
    );
  }

  return (
    <div className={drawerStyles.searchResults} data-testid="library-search-results">
      <ul className={drawerStyles.tree}>
        {results.map((result, index) => {
          const isSelected = index === selectedIndex;
          const isActive = editorPath === result.node.path;
          const isDirectory = result.node.kind === 'directory';
          const icon = isDirectory ? '📁' : '📄';
          const relativePath = workspaceRoot
            ? result.fullPath.replace(workspaceRoot, '').replace(/^\//, '')
            : result.fullPath;

          return (
            <li key={result.node.path}>
              <button
                type="button"
                className={buildTreeItemClassName({ kind: result.node.kind, isActive, isSelected })}
                onClick={() => onSelectResult(result.node)}
                onMouseEnter={() => onHoverResult(index)}
                data-testid="library-search-result-item"
                data-relpath={relativePath}
              >
                <span className={drawerStyles.treeItemIcon}>{icon}</span>
                <div className={drawerStyles.searchResultContent}>
                  <div className={drawerStyles.searchResultName}>{highlightMatches(result.node.name, result.matches)}</div>
                  <div className={drawerStyles.searchResultPath}>{relativePath || result.node.path}</div>
                </div>
                {isActive ? <span className={drawerStyles.searchResultActive}>Open</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
      <div className={drawerStyles.searchFooter}>
        <div>↵ Open · ↑↓ Navigate · Esc Close</div>
        {truncationHint}
      </div>
    </div>
  );
};
