import { cn } from '@renderer/lib/utils';
import drawerStyles from './LibraryDrawer.module.css';
import type { LibraryRailSearchMatch } from '../hooks/useLibraryRailSearch';
import { getFileIcon } from '../utils/fileTypeIcons';

type LibraryRailSearchResultsProps = {
  matches: LibraryRailSearchMatch[];
  activePath: string | null;
  onSelectNode: (node: LibraryRailSearchMatch['node']) => void;
  libraryRootAbsolute: string;
};

function formatFileCount(count: number): string {
  return `${count} file${count === 1 ? '' : 's'}`;
}

export function LibraryRailSearchResults({
  matches,
  activePath,
  onSelectNode,
  libraryRootAbsolute,
}: LibraryRailSearchResultsProps) {
  return (
    <div
      className={drawerStyles.kioskRailSearchResults}
      data-testid="library-kiosk-rail-search-results"
      data-library-root={libraryRootAbsolute}
    >
      <p
        className={drawerStyles.kioskRailSearchResultCount}
        data-testid="library-kiosk-rail-search-count"
      >
        {formatFileCount(matches.length)}
      </p>
      <ul className={drawerStyles.kioskRailSearchResultList}>
        {matches.map(({ node, parentRelativePath }) => {
          const isActive = node.path === activePath;
          return (
            <li key={node.path} className={drawerStyles.kioskRailSearchResultListItem}>
              <button
                type="button"
                className={cn(
                  drawerStyles.kioskRailSearchResultRow,
                  isActive && drawerStyles.kioskRailSearchResultRowActive,
                )}
                onClick={() => onSelectNode(node)}
                data-testid="library-kiosk-rail-search-result-row"
                data-path={node.path}
                data-active={isActive ? 'true' : undefined}
                aria-current={isActive ? 'true' : undefined}
              >
                <span className={drawerStyles.kioskRailSearchResultIcon} aria-hidden>
                  {getFileIcon(node.name)}
                </span>
                <span className={drawerStyles.kioskRailSearchResultContent}>
                  <span className={drawerStyles.kioskRailSearchResultName}>{node.name}</span>
                  <span className={drawerStyles.kioskRailSearchResultPath}>
                    {parentRelativePath || 'Library root'}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
