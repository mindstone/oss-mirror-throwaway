import { useCallback, memo } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import type { DocumentTab } from '../hooks/useDocumentTabs';
import styles from './UnifiedDocumentEditor.module.css';

interface DocumentTabBarProps {
  tabs: DocumentTab[];
  activeTabId: string | null;
  onTabClick: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
  onTabMouseDown: (e: React.MouseEvent, tabId: string) => void;
  onOpenFileDialog?: () => void;
}

const DocumentTabBarComponent = ({
  tabs,
  activeTabId,
  onTabClick,
  onTabClose,
  onTabMouseDown,
  onOpenFileDialog,
}: DocumentTabBarProps) => {
  const handleClose = useCallback(
    (e: React.MouseEvent, tabId: string) => {
      e.stopPropagation();
      onTabClose(tabId);
    },
    [onTabClose],
  );

  const handleTabKeyDown = useCallback(
    (e: React.KeyboardEvent, tabId: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onTabClick(tabId);
      }
    },
    [onTabClick],
  );

  return (
    <div className={styles.tabBar} role="tablist">
      <div className={styles.tabBarScroll}>
        {tabs.map((tab) => (
          // Use <div role="tab"> instead of <button> so the close <button>
          // inside can remain a real button — nested <button> inside <button>
          // is invalid HTML and causes React hydration warnings + broken
          // click handling (the inner close button's clicks bubble unreliably).
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={tab.id === activeTabId}
            className={cn(styles.tab, tab.id === activeTabId && styles.tabActive)}
            onClick={() => onTabClick(tab.id)}
            onKeyDown={(e) => handleTabKeyDown(e, tab.id)}
            onMouseDown={(e) => onTabMouseDown(e, tab.id)}
            title={tab.path}
          >
            <span className={styles.tabTitle}>{tab.title}</span>
            <button
              type="button"
              className={styles.tabClose}
              onClick={(e) => handleClose(e, tab.id)}
              aria-label={`Close ${tab.title}`}
            >
              <X size={12} aria-hidden />
            </button>
          </div>
        ))}
      </div>
      {onOpenFileDialog && (
        <button
          type="button"
          className={styles.tabBarAction}
          onClick={onOpenFileDialog}
          aria-label="Open file"
          data-testid="document-tabbar-open-file"
        >
          <Plus size={12} aria-hidden />
          <span>Open file</span>
        </button>
      )}
    </div>
  );
};

export const DocumentTabBar = memo(DocumentTabBarComponent);
