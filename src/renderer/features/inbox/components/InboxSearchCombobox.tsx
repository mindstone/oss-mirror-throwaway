import { memo, useState, useCallback, useRef, useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@renderer/components/ui';
import styles from './InboxSearchCombobox.module.css';

type InboxSearchComboboxProps = {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  selectedTags: Set<string>;
  onToggleTag: (tag: string) => void;
  onClearTags: () => void;
  allTags: string[];
};

const InboxSearchComboboxComponent = ({
  searchQuery,
  onSearchQueryChange,
  selectedTags,
  onToggleTag,
  onClearTags,
  allTags,
}: InboxSearchComboboxProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasSelectedTags = selectedTags.size > 0;
  const hasFilters = searchQuery.length > 0 || hasSelectedTags;

  // Filter available tags by search query for the dropdown
  const visibleTags = allTags.filter(
    tag => !searchQuery || tag.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleFocus = useCallback(() => {
    setIsOpen(true);
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleTagClick = useCallback((tag: string) => {
    onToggleTag(tag);
    // Keep focus on input after tag toggle
    inputRef.current?.focus();
  }, [onToggleTag]);

  const handleClearAll = useCallback(() => {
    onSearchQueryChange('');
    onClearTags();
    inputRef.current?.focus();
  }, [onSearchQueryChange, onClearTags]);

  const handleRemoveTag = useCallback((tag: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleTag(tag);
    inputRef.current?.focus();
  }, [onToggleTag]);

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      inputRef.current?.blur();
    }
    // Backspace on empty input removes last selected tag
    if (e.key === 'Backspace' && !searchQuery && hasSelectedTags) {
      const lastTag = Array.from(selectedTags).pop();
      if (lastTag) onToggleTag(lastTag);
    }
  }, [searchQuery, hasSelectedTags, selectedTags, onToggleTag]);

  return (
    <div ref={containerRef} className={styles.container}>
      <div className={`${styles.inputRow} ${isOpen ? styles.inputRowOpen : ''}`}>
        <Search size={14} className={styles.searchIcon} aria-hidden />
        {/* Inline selected tag chips */}
        {hasSelectedTags && (
          <div className={styles.selectedChips}>
            {Array.from(selectedTags).map(tag => (
              <span key={tag} className={styles.chip}>
                {tag}
                <button
                  type="button"
                  className={styles.chipRemove}
                  onClick={(e) => handleRemoveTag(tag, e)}
                  aria-label={`Remove ${tag} filter`}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
        <Input
          ref={inputRef}
          type="text"
          inputSize="sm"
          className={styles.input}
          placeholder={hasSelectedTags ? 'Search...' : 'Search items...'}
          value={searchQuery}
          onChange={(e) => onSearchQueryChange(e.target.value)}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          aria-label="Search action items"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          role="combobox"
        />
        {hasFilters && (
          <button
            type="button"
            className={styles.clearButton}
            onClick={handleClearAll}
            aria-label="Clear all filters"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {/* Dropdown with available tags */}
      {isOpen && visibleTags.length > 0 && (
        <div className={styles.dropdown} role="listbox" aria-label="Available tags">
          <div className={styles.dropdownLabel}>Tags</div>
          <div className={styles.tagList}>
            {visibleTags.map(tag => (
              <button
                key={tag}
                type="button"
                role="option"
                aria-selected={selectedTags.has(tag)}
                className={`${styles.tagOption} ${selectedTags.has(tag) ? styles.tagOptionSelected : ''}`}
                onClick={() => handleTagClick(tag)}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export const InboxSearchCombobox = memo(InboxSearchComboboxComponent);
InboxSearchCombobox.displayName = 'InboxSearchCombobox';
