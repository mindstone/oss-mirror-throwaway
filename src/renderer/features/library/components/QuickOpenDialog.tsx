import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { FileNode } from '@shared/types';
import { Dialog, DialogContent, Input } from '@renderer/components/ui';
import { FileText, Folder, Search, WandSparkles, Brain, Clock, X } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { highlightMatches, getRecentFiles, addRecentFile } from '@renderer/utils/librarySearch';
import { searchLibrary } from '@renderer/features/library/search/engine';
import type { FlatFileEntry, SearchResult } from '@renderer/utils/librarySearch';
import { isSkillEntry, isHiddenSkillMd, isMemoryPath } from '@renderer/utils/skillUtils';
import type { LibraryFilter } from '../types/lens';
import { INCOMPLETE_LIBRARY_COPY } from './IncompleteLibraryHint';
import styles from './QuickOpenDialog.module.css';

/** How long (ms) before we stop pre-filling the last search query */
const QUERY_MEMORY_DURATION_MS = 2 * 60 * 1000; // 2 minutes

/** Filter tab configuration */
const FILTER_TABS: Array<{ value: LibraryFilter; label: string }> = [
  { value: 'everything', label: 'Everything' },
  { value: 'spaces', label: 'Spaces' },
  { value: 'skills', label: 'Skills' },
  { value: 'memory', label: 'Memory' },
];

type QuickOpenDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: FlatFileEntry[] | null;
  /** True when the file index is a partial view of the workspace (Bug-2) — distinguishes "no matches" from "incomplete Library". */
  isPartialTree?: boolean;
  onSelectFile: (node: FileNode) => void;
};

export const QuickOpenDialog = ({
  open,
  onOpenChange,
  files,
  isPartialTree = false,
  onSelectFile
}: QuickOpenDialogProps) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('everything');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const lastQueryTimeRef = useRef<number>(0);

  // Track when query changes (for time-based pre-fill logic)
  const handleQueryChange = useCallback((newQuery: string) => {
    setQuery(newQuery);
    if (newQuery.trim()) {
      lastQueryTimeRef.current = Date.now();
    }
  }, []);

  // Build a map of node.path (absolute) -> entry for quick lookups
  // Uses absolute paths for consistency with getRecentFiles/addRecentFile
  const filesByPath = useMemo(() => {
    if (!files) return new Map<string, FlatFileEntry>();
    return new Map(files.map((entry) => [entry.node.path, entry]));
  }, [files]);

  // Apply category filter predicate
  const matchesFilter = useCallback((entry: FlatFileEntry): boolean => {
    // Hide SKILL.md files (users should select skill folders instead)
    if (isHiddenSkillMd(entry)) return false;
    
    switch (filter) {
      case 'skills':
        return isSkillEntry(entry);
      case 'memory':
        return isMemoryPath(entry.fullPath);
      case 'spaces':
        return !isSkillEntry(entry) && !isMemoryPath(entry.fullPath);
      case 'everything':
      default:
        return true;
    }
  }, [filter]);

  // Filter files and apply category filter
  const filteredFiles = useMemo(() => {
    if (!files) return [];
    return files.filter(matchesFilter);
  }, [files, matchesFilter]);

  // Get recent files, validated against current file index and filtered by category
  const recentEntries = useMemo(() => {
    const recentPaths = getRecentFiles();
    const entries: FlatFileEntry[] = [];
    for (const path of recentPaths) {
      const entry = filesByPath.get(path);
      if (entry && matchesFilter(entry)) {
        entries.push(entry);
      }
    }
    return entries;
  }, [filesByPath, matchesFilter]);

  const normalizedQuery = query.trim();

  const searchOutcome = useMemo(() => {
    if (!normalizedQuery) {
      return null;
    }

    return searchLibrary(query, filteredFiles, {
      limit: 50,
      surface: 'quick-open',
    });
  }, [filteredFiles, normalizedQuery, query]);

  // When no query, show recents first, then other files (excluding recents)
  const results = useMemo(() => {
    if (!normalizedQuery) {
      // Use node.path (absolute) to track recents for consistency
      const recentPathSet = new Set(recentEntries.map((e) => e.node.path));
      const nonRecentFiles = filteredFiles.filter((e) => !recentPathSet.has(e.node.path));
      const combined = [...recentEntries, ...nonRecentFiles].slice(0, 50);
      return combined.map((entry) => ({
        node: entry.node,
        fullPath: entry.fullPath,
        skillMeta: entry.skillMeta,
        score: 0,
        matches: [] as Array<[number, number]>,
        isRecent: recentPathSet.has(entry.node.path)
      }));
    }
    return (searchOutcome?.results ?? []).map((r) => ({
      ...r,
      isRecent: false
    }));
  }, [filteredFiles, normalizedQuery, recentEntries, searchOutcome]);

  // Count how many recents are in current results (for section header)
  const recentCount = useMemo(() => {
    if (normalizedQuery) return 0;
    return results.filter((r) => r.isRecent).length;
  }, [normalizedQuery, results]);

  const showTruncationHint = Boolean(normalizedQuery) && Boolean(searchOutcome?.truncated);

  useEffect(() => {
    if (open) {
      // Only keep last query if it was recent (within QUERY_MEMORY_DURATION_MS)
      const timeSinceLastQuery = Date.now() - lastQueryTimeRef.current;
      if (timeSinceLastQuery > QUERY_MEMORY_DURATION_MS) {
        setQuery('');
      }
      setSelectedIndex(0);
      setTimeout(() => {
        inputRef.current?.focus();
        // Select all text so user can easily replace or clear
        inputRef.current?.select();
      }, 50);
    }
  }, [open]);

  // Reset selection when query or filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query, filter]);

  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleSelect = useCallback((result: SearchResult & { isRecent?: boolean } | FlatFileEntry & { score: number; matches: Array<[number, number]>; isRecent?: boolean }) => {
    // Add to recent files using absolute path for consistency with rest of app
    addRecentFile(result.node.path);
    onSelectFile(result.node);
    onOpenChange(false);
  }, [onSelectFile, onOpenChange]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (results.length > 0) {
          setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (results.length > 0) {
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
        }
        break;
      case 'Enter':
        event.preventDefault();
        if (results[selectedIndex]) {
          handleSelect(results[selectedIndex]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        onOpenChange(false);
        break;
    }
  }, [results, selectedIndex, handleSelect, onOpenChange]);

  // Determine the appropriate icon for a result.
  // Scanner-detected skills and legacy skill paths should use the skill icon before folder fallback.
  const getResultIcon = (result: Pick<SearchResult, 'node' | 'fullPath' | 'skillMeta'>) => {
    if (isSkillEntry(result)) {
      return <WandSparkles size={14} strokeWidth={1.5} />;
    }
    if (result.node.kind === 'directory') {
      return <Folder size={14} strokeWidth={1.5} />;
    }
    // Use memory icon for files in memory paths
    if (isMemoryPath(result.fullPath)) {
      return <Brain size={14} strokeWidth={1.5} />;
    }
    return <FileText size={14} strokeWidth={1.5} />;
  };

  // Generate empty state message based on filter
  const getEmptyMessage = () => {
    if (query) {
      switch (filter) {
        case 'spaces':
          return 'No matching Space files';
        case 'skills':
          return 'No matching skills';
        case 'memory':
          return 'No matching memories';
        default:
          return 'No matching files';
      }
    }
    switch (filter) {
      case 'spaces':
        return 'No Space files in workspace';
      case 'skills':
        return 'No skills in workspace';
      case 'memory':
        return 'No memory files in workspace';
      default:
        return 'No files in workspace';
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className={styles.content}>
        <div className={styles.searchWrapper}>
          <Search size={14} className={styles.searchIcon} />
          <Input
            ref={inputRef}
            type="text"
            inputSize="sm"
            className={styles.searchInput}
            placeholder="Search files by name..."
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          {query.trim() && (
            <button
              type="button"
              className={styles.clearButton}
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              onMouseDown={(e) => e.preventDefault()}
              aria-label="Clear search"
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
          <kbd className={styles.shortcut}>esc</kbd>
        </div>
        {/* Filter tabs */}
        <div className={styles.filterTabs} role="group" aria-label="Filter files">
          {FILTER_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              aria-pressed={filter === tab.value}
              className={cn(
                styles.filterTab,
                filter === tab.value && styles.filterTabActive
              )}
              // Prevent focus steal from search input
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setFilter(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <ul ref={listRef} className={styles.resultsList} role="listbox">
          {results.length === 0 ? (
            <li className={styles.emptyState}>
              {getEmptyMessage()}
              {isPartialTree ? (
                <span
                  className={styles.emptyStateHint}
                  data-testid="quick-open-incomplete-hint"
                >
                  {INCOMPLETE_LIBRARY_COPY}
                </span>
              ) : null}
            </li>
          ) : (
            results.map((result, index) => {
              const isSelected = index === selectedIndex;
              const showRecentHeader = result.isRecent && index === 0;
              const showAllHeader = recentCount > 0 && index === recentCount;
              return (
                <li key={result.node.path}>
                  {showRecentHeader && (
                    <div className={styles.sectionHeader}>
                      <Clock size={12} strokeWidth={1.5} />
                      <span>Recent</span>
                    </div>
                  )}
                  {showAllHeader && (
                    <div className={cn(styles.sectionHeader, styles.sectionHeaderWithGap)}>
                      <span>All files</span>
                    </div>
                  )}
                  <div
                    role="option"
                    aria-selected={isSelected}
                    data-selected={isSelected}
                    className={cn(styles.resultItem, isSelected && styles.resultItemSelected)}
                    onClick={() => handleSelect(result)}
                    onMouseEnter={() => setSelectedIndex(index)}
                  >
                    <span className={styles.resultIcon}>
                      {getResultIcon(result)}
                    </span>
                    <span className={styles.resultName}>
                      {result.matches && result.matches.length > 0
                        ? highlightMatches(result.node.name, result.matches)
                        : result.node.name}
                    </span>
                    <span className={styles.resultPath}>{result.fullPath}</span>
                  </div>
                </li>
              );
            })
          )}
          {showTruncationHint ? (
            <li
              className={styles.resultsTruncationHint}
              data-testid="quick-open-truncation-hint"
            >
              Searched first 100,000 files. Some matches may be missing.
            </li>
          ) : null}
        </ul>
        <div className={styles.footer}>
          <span className={styles.footerHint}>
            <kbd>↑</kbd><kbd>↓</kbd> to navigate
          </span>
          <span className={styles.footerHint}>
            <kbd>↵</kbd> to open
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
};
