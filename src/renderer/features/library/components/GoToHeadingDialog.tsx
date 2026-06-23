import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Dialog, DialogContent, Input } from '@renderer/components/ui';
import { Hash, Search } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { extractHeadings, type MarkdownHeading } from '../utils/markdownHeadings';
import styles from './GoToHeadingDialog.module.css';

type GoToHeadingDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: string;
  onSelectHeading: (heading: MarkdownHeading) => void;
};

export const GoToHeadingDialog = ({
  open,
  onOpenChange,
  content,
  onSelectHeading
}: GoToHeadingDialogProps) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const headings = useMemo(() => {
    return extractHeadings(content);
  }, [content]);

  const filteredHeadings = useMemo(() => {
    if (!query.trim()) {
      return headings;
    }
    const lowerQuery = query.toLowerCase();
    return headings.filter((h) => h.text.toLowerCase().includes(lowerQuery));
  }, [headings, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleSelect = useCallback((heading: MarkdownHeading) => {
    onSelectHeading(heading);
    onOpenChange(false);
  }, [onSelectHeading, onOpenChange]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, filteredHeadings.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        break;
      case 'Enter':
        event.preventDefault();
        if (filteredHeadings[selectedIndex]) {
          handleSelect(filteredHeadings[selectedIndex]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        onOpenChange(false);
        break;
    }
  }, [filteredHeadings, selectedIndex, handleSelect, onOpenChange]);

  const getHeadingIcon = (level: number) => {
    const size = Math.max(12, 18 - (level - 1) * 2);
    return <Hash size={size} strokeWidth={1.5} />;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md" className={styles.content}>
        <div className={styles.searchWrapper}>
          <Search size={14} className={styles.searchIcon} />
          <Input
            ref={inputRef}
            type="text"
            inputSize="sm"
            className={styles.searchInput}
            placeholder="Go to heading..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className={styles.shortcut}>esc</kbd>
        </div>
        <ul ref={listRef} className={styles.resultsList} role="listbox">
          {filteredHeadings.length === 0 ? (
            <li className={styles.emptyState}>
              {headings.length === 0 ? 'No headings in this document' : 'No matching headings'}
            </li>
          ) : (
            filteredHeadings.map((heading, index) => {
              const isSelected = index === selectedIndex;
              return (
                <li
                  key={`${heading.lineIndex}-${heading.text}`}
                  role="option"
                  aria-selected={isSelected}
                  data-selected={isSelected}
                  className={cn(styles.resultItem, isSelected && styles.resultItemSelected)}
                  style={{ paddingLeft: `${12 + (heading.level - 1) * 16}px` }}
                  onClick={() => handleSelect(heading)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <span className={styles.resultIcon}>
                    {getHeadingIcon(heading.level)}
                  </span>
                  <span className={styles.resultText}>{heading.text}</span>
                  <span className={styles.resultLine}>Line {heading.lineIndex + 1}</span>
                </li>
              );
            })
          )}
        </ul>
        <div className={styles.footer}>
          <span className={styles.footerHint}>
            <kbd>↑</kbd><kbd>↓</kbd> to navigate
          </span>
          <span className={styles.footerHint}>
            <kbd>↵</kbd> to jump
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
};
