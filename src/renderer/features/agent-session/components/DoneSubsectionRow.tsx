import { memo, useCallback, type KeyboardEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import styles from './DoneSubsectionRow.module.css';

interface DoneSubsectionRowProps {
  folderId: string;
  folderName: string;
  doneCount: number;
  isCollapsed: boolean;
  onToggle: (folderId: string) => void;
}

/**
 * Inline disclosure row for a folder's "Done (N)" subsection in the Active tab.
 *
 * Anatomy is deliberately different from FolderHeaderRow: no leading icon, no
 * actions/menu, not a drop target. It borrows only the chevron rotation and the
 * keyboard interaction contract (Enter/Space toggle, ArrowRight expands when
 * collapsed, ArrowLeft collapses when expanded) with the same
 * `e.target !== e.currentTarget` guard.
 */
export const DoneSubsectionRow = memo(({
  folderId,
  folderName,
  doneCount,
  isCollapsed,
  onToggle,
}: DoneSubsectionRowProps) => {
  const handleClick = useCallback(() => {
    onToggle(folderId);
  }, [onToggle, folderId]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    // Only handle keyboard activation when the event originated on the wrapper
    // itself (mirrors FolderHeaderRow's guard).
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggle(folderId);
    } else if (e.key === 'ArrowRight' && isCollapsed) {
      e.preventDefault();
      onToggle(folderId);
    } else if (e.key === 'ArrowLeft' && !isCollapsed) {
      e.preventDefault();
      onToggle(folderId);
    }
  }, [isCollapsed, onToggle, folderId]);

  return (
    <div
      role="button"
      tabIndex={0}
      className={styles.doneSubheader}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      aria-expanded={!isCollapsed}
      aria-label={`Done conversations in ${folderName}, ${doneCount} items`}
    >
      <ChevronRight
        className={`${styles.chevron}${!isCollapsed ? ` ${styles.chevronExpanded}` : ''}`}
        aria-hidden
      />
      <span className={styles.label}>Done ({doneCount})</span>
    </div>
  );
});

DoneSubsectionRow.displayName = 'DoneSubsectionRow';
