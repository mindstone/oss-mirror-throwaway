import { useRef, useEffect, useCallback, memo, type ReactElement } from 'react';
import { cn } from '@renderer/lib/utils';
import { Bot, FileText, FolderOpen, WandSparkles, MessageSquare, ScanSearch, Users } from 'lucide-react';
import { Button, Spinner } from '@renderer/components/ui';
import { highlightMatches, type FlatFileEntry } from '@renderer/utils/librarySearch';
import type { UnifiedMentionResult, MentionFilterType } from '@renderer/features/mentions';
import type { MentionState } from '../hooks';
import { formatRelativeTime as _formatRelativeTime } from '@rebel/shared';
import { isAutomationSession } from '@shared/sessionKind';
import styles from '@renderer/components/MentionPopover.module.css';

/** Format a relative timestamp like "2 days ago" */
const formatRelativeTime = (timestamp: number): string =>
  _formatRelativeTime(timestamp, { capitalize: false, includeWeeks: true, includeMonths: true, absoluteDateAfterDays: false });

/** Filter tab configuration */
const FILTER_TABS: Array<{ value: MentionFilterType; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'skills', label: 'Skills' },
  { value: 'memory', label: 'Memory' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'models', label: 'Models' },
  { value: 'operators', label: 'Operators' },
];

export type MentionPopoverProps = {
  isTextMode: boolean;
  mentionState: MentionState;
  coreDirectory: string | null | undefined;
  libraryIndex: FlatFileEntry[] | null;
  libraryIndexLoading: boolean;
  libraryIndexError: string | null;
  getRelativeLibraryPath: (path: string) => string;
  refreshLibraryIndex: () => Promise<void>;
  insertMentionResult: (result: UnifiedMentionResult) => void;
  setSelectedIndex: (index: number) => void;
  /** Whether there are conversations available for mentions */
  hasConversations?: boolean;
  /** Whether model profile mentions are available */
  showModelsTab?: boolean;
  /** Whether Operators are available for the active Space scope. */
  hasOperators?: boolean;
  /** Called from the zero-Operators disabled row. */
  onOpenOperatorsPanel?: () => void;
  /** Called when user clicks a filter tab (only when no explicit prefix) */
  onFilterChange?: (filter: MentionFilterType) => void;
};

/**
 * Popover component for @mention autocomplete in the composer.
 * Displays library files and conversations matching the current query.
 */
const MentionPopoverComponent = ({
  isTextMode,
  mentionState,
  coreDirectory,
  libraryIndex,
  libraryIndexLoading,
  libraryIndexError,
  getRelativeLibraryPath,
  refreshLibraryIndex,
  insertMentionResult,
  setSelectedIndex,
  hasConversations = false,
  showModelsTab = false,
  hasOperators = false,
  onOpenOperatorsPanel,
  onFilterChange
}: MentionPopoverProps): ReactElement | null => {
  const listRef = useRef<HTMLUListElement>(null);
  const activeItemRef = useRef<HTMLLIElement>(null);
  // Track when we're scrolling due to keyboard navigation to ignore mouse hover events
  const isKeyboardScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Scroll active item into view when selectedIndex changes
  useEffect(() => {
    if (activeItemRef.current && listRef.current) {
      // Set flag to ignore mouse hover during scroll
      isKeyboardScrollingRef.current = true;
      
      // Clear any pending timeout
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
      
      activeItemRef.current.scrollIntoView({
        block: 'nearest',
        behavior: 'auto' // Use instant scroll to minimize hover conflicts
      });
      
      // Reset flag after a brief delay to allow scroll to complete
      scrollTimeoutRef.current = setTimeout(() => {
        isKeyboardScrollingRef.current = false;
      }, 50);
    }
  }, [mentionState.selectedIndex]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // Handle mouse enter - only update selection if not keyboard scrolling
  const handleMouseEnter = useCallback((index: number) => {
    if (!isKeyboardScrollingRef.current) {
      setSelectedIndex(index);
    }
  }, [setSelectedIndex]);

  // Handle filter tab click - only works when no explicit prefix
  const handleFilterClick = useCallback(
    (filter: MentionFilterType) => {
      // Prevent focus steal from textarea
      // Note: This is handled via onMouseDown in the button, but we also guard here
      if (mentionState.hasExplicitPrefix) {
        return; // Prefix takes precedence - tabs are disabled
      }
      onFilterChange?.(filter);
    },
    [mentionState.hasExplicitPrefix, onFilterChange]
  );

  const visibleFilterTabs = showModelsTab
    ? FILTER_TABS
    : FILTER_TABS.filter((tab) => tab.value !== 'models');
  const filteredTabs = hasOperators
    ? visibleFilterTabs
    : visibleFilterTabs.filter((tab) => tab.value !== 'operators');

  if (!isTextMode || !mentionState.active) {
    return null;
  }

  let content: ReactElement | null = null;

  // Determine if we have any mention sources available
  const hasAnySources = coreDirectory || hasConversations || showModelsTab || hasOperators;

  if (!hasAnySources) {
    content = (
      <div className={styles.state}>
        Choose a library directory to mention files.
      </div>
    );
  } else if (libraryIndexError && !hasConversations && !showModelsTab) {
    content = (
      <div className={cn(styles.state, styles.stateError)}>
        <div>Unable to load library files.</div>
        <Button type="button" size="xs" variant="ghost" onClick={() => void refreshLibraryIndex()}>
          Retry
        </Button>
      </div>
    );
  } else if ((!libraryIndex || libraryIndex.length === 0) && libraryIndexLoading && !hasConversations && !showModelsTab) {
    content = (
      <div className={styles.state}>
        <Spinner size="sm" />
        <span>Loading library files…</span>
      </div>
    );
  } else if (mentionState.results.length === 0) {
    const shouldShowOperatorsEmptyRow =
      !hasOperators &&
      !mentionState.hasExplicitPrefix &&
      (mentionState.filter === 'all' || mentionState.filter === 'operators');
    content = (
      <div className={styles.state}>
        {shouldShowOperatorsEmptyRow ? (
          <>
            <Users size={16} className={styles.icon} aria-hidden />
            <span>No Operators yet. Set them up in Operators.</span>
            {onOpenOperatorsPanel && (
              <button
                type="button"
                className={styles.inlineLink}
                onMouseDown={(event) => event.preventDefault()}
                onClick={onOpenOperatorsPanel}
              >
                Open
              </button>
            )}
          </>
        ) : (
          <>No matches for "{mentionState.query || ' '}."</>
        )}
      </div>
    );
  } else {
    const shouldShowOperatorsEmptyRow =
      !hasOperators &&
      !mentionState.hasExplicitPrefix &&
      (mentionState.filter === 'all' || mentionState.filter === 'operators');
    content = (
      <ul ref={listRef} className={styles.list}>
        {shouldShowOperatorsEmptyRow && (
          <li
            role="presentation"
            className={cn(styles.item, styles.itemDisabled)}
            onMouseDown={(event) => event.preventDefault()}
          >
            <div className={styles.primary}>
              <Users size={16} className={styles.icon} aria-hidden />
              <span>No Operators yet. Set them up in Operators.</span>
            </div>
            {onOpenOperatorsPanel && (
              <button
                type="button"
                className={styles.inlineLink}
                onMouseDown={(event) => event.preventDefault()}
                onClick={onOpenOperatorsPanel}
              >
                Open Operators panel
              </button>
            )}
          </li>
        )}
        {mentionState.results.map((result, index) => {
          const isActive = index === mentionState.selectedIndex;

          if (result.kind === 'command') {
            // Command result (e.g., @files)
            return (
              <li
                key={`cmd-${result.command}`}
                ref={isActive ? activeItemRef : undefined}
                role="option"
                aria-selected={isActive}
                className={cn(styles.item, isActive && styles.itemActive)}
                onMouseEnter={() => handleMouseEnter(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMentionResult(result)}
              >
                <div className={styles.primary}>
                  <ScanSearch size={16} className={styles.icon} aria-hidden />
                  <span>{highlightMatches(result.label, result.matches)}</span>
                </div>
                <div className={styles.meta}>{result.description}</div>
              </li>
            );
          }

          if (result.kind === 'conversation') {
            // Conversation result
            const timeAgo = formatRelativeTime(result.updatedAt);
            return (
              <li
                key={`conv-${result.id}`}
                ref={isActive ? activeItemRef : undefined}
                role="option"
                aria-selected={isActive}
                className={cn(styles.item, isActive && styles.itemActive)}
                onMouseEnter={() => handleMouseEnter(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMentionResult(result)}
              >
                <div className={styles.primary}>
                  <MessageSquare size={16} className={styles.icon} aria-hidden />
                  <span>{highlightMatches(result.title, result.matches)}</span>
                  {result.isCurrent && (
                    <span className={styles.badge}>current</span>
                  )}
                  {isAutomationSession(result.id) && (
                    <span className={styles.badge}>auto</span>
                  )}
                </div>
                <div className={styles.meta}>{timeAgo}</div>
              </li>
            );
          }

          if (result.kind === 'model') {
            // Model profile result
            return (
              <li
                key={`model-${result.profileId}`}
                ref={isActive ? activeItemRef : undefined}
                role="option"
                aria-selected={isActive}
                className={cn(styles.item, isActive && styles.itemActive)}
                onMouseEnter={() => handleMouseEnter(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMentionResult(result)}
              >
                <div className={styles.primary}>
                  <Bot size={16} className={styles.icon} aria-hidden />
                  <span>{highlightMatches(result.profileName, result.matches)}</span>
                </div>
                <div className={styles.meta}>{result.modelName}</div>
              </li>
            );
          }

          if (result.kind === 'operator') {
            return (
              <li
                key={`operator-${result.operatorId}`}
                ref={isActive ? activeItemRef : undefined}
                role="option"
                aria-selected={isActive}
                className={cn(styles.item, isActive && styles.itemActive)}
                onMouseEnter={() => handleMouseEnter(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMentionResult(result)}
              >
                <div className={styles.primary}>
                  <Users size={16} className={styles.icon} aria-hidden />
                  <span>{highlightMatches(result.operatorName, result.matches)}</span>
                </div>
                <div className={styles.meta}>{result.consultWhen || result.description}</div>
              </li>
            );
          }

          // File result
          const relativePath = getRelativeLibraryPath(result.node.path);
          const displayName = result.skillMeta?.name ?? result.node.name;
          const IconComponent = result.skillMeta
            ? WandSparkles
            : result.node.kind === 'directory'
              ? FolderOpen
              : FileText;
          return (
            <li
              key={result.node.path}
              ref={isActive ? activeItemRef : undefined}
              role="option"
              aria-selected={isActive}
              className={cn(styles.item, isActive && styles.itemActive)}
              onMouseEnter={() => handleMouseEnter(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertMentionResult(result)}
            >
              <div className={styles.primary}>
                <IconComponent size={16} className={styles.icon} aria-hidden />
                <span>
                  {result.skillMeta
                    ? displayName
                    : highlightMatches(result.node.name, result.matches)}
                </span>
              </div>
              <div className={styles.meta}>{relativePath}</div>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className={styles.popover}>
      {/* Filter buttons - segmented control pattern (simpler ARIA than tabs) */}
      <div className={styles.filterTabs} role="group" aria-label="Filter mentions">
          {filteredTabs.map((tab) => {
          const isActive = mentionState.filter === tab.value;
          // Disable all buttons when explicit prefix is present (prefix takes precedence)
          const isDisabled = mentionState.hasExplicitPrefix;
          return (
            <button
              key={tab.value}
              type="button"
              aria-pressed={isActive}
              disabled={isDisabled}
              data-testid={`mention-filter-${tab.value}`}
              className={cn(
                styles.filterTab,
                isActive && styles.filterTabActive,
                isDisabled && styles.filterTabDisabled
              )}
              // Prevent focus steal from textarea
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => handleFilterClick(tab.value)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {/* Results listbox */}
      <div role="listbox" aria-label="Mention suggestions">
        {content}
      </div>
    </div>
  );
};

export const MentionPopover = memo(MentionPopoverComponent);
