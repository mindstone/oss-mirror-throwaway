import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { cn } from '@renderer/lib/utils';
import { extractHeadings, type MarkdownHeading } from '../utils/markdownHeadings';
import styles from './DocumentOutlinePanel.module.css';

type DocumentOutlinePanelProps = {
  content: string;
  /** Index in the headings array that is currently active (cursor/scroll position) */
  currentHeadingIndex: number | null;
  onSelectHeading: (heading: MarkdownHeading) => void;
  className?: string;
};

/**
 * Build parent index for each heading so we can collapse by section.
 * Parent of heading i = last heading j < i with level < heading[i].level.
 */
function buildParentIndices(headings: MarkdownHeading[]): (number | null)[] {
  const parent: (number | null)[] = [];
  const stack: number[] = []; // indices of headings, by increasing level

  for (let i = 0; i < headings.length; i++) {
    const level = headings[i].level;
    while (stack.length > 0 && headings[stack[stack.length - 1]].level >= level) {
      stack.pop();
    }
    parent[i] = stack.length > 0 ? stack[stack.length - 1] : null;
    stack.push(i);
  }
  return parent;
}

/** Whether heading at index i is visible (no ancestor is collapsed). */
function isVisible(
  i: number,
  parentIndices: (number | null)[],
  collapsed: Set<number>
): boolean {
  let p: number | null = parentIndices[i];
  while (p !== null) {
    if (collapsed.has(p)) return false;
    p = parentIndices[p];
  }
  return true;
}

/** Whether heading at index i has any descendants (for showing expand/collapse chevron). */
function hasDescendants(i: number, headings: MarkdownHeading[]): boolean {
  const level = headings[i].level;
  for (let j = i + 1; j < headings.length; j++) {
    if (headings[j].level <= level) break;
    return true;
  }
  return false;
}

export function DocumentOutlinePanel({
  content,
  currentHeadingIndex,
  onSelectHeading,
  className,
}: DocumentOutlinePanelProps) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const activeItemRef = useRef<HTMLLIElement>(null);
  const listRef = useRef<HTMLElement>(null);

  const headings = useMemo(() => extractHeadings(content), [content]);
  const parentIndices = useMemo(() => buildParentIndices(headings), [headings]);

  const toggleCollapsed = useCallback((index: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  // Auto-scroll the outline list so the active heading stays visible
  useEffect(() => {
    if (currentHeadingIndex === null || !activeItemRef.current || !listRef.current) return;
    const item = activeItemRef.current;
    const list = listRef.current;
    const itemRect = item.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    // Only scroll if the active item is outside the visible area of the list
    if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [currentHeadingIndex]);

  if (headings.length === 0) {
    return (
      <aside className={cn(styles.panel, className)} aria-label="Document outline">
        <div className={styles.header}>
          <span className={styles.title}>Outline</span>
        </div>
        <div className={styles.empty}>
          <p>No headings in this document</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={cn(styles.panel, className)} aria-label="Document outline">
      <div className={styles.header}>
        <span className={styles.title}>Outline</span>
      </div>
      <nav ref={listRef} className={styles.list} role="navigation" aria-label="Table of contents">
        <ul className={styles.ul}>
          {headings.map((heading, index) => {
            if (!isVisible(index, parentIndices, collapsed)) return null;

            const isActive = index === currentHeadingIndex;
            const hasChildren = hasDescendants(index, headings);
            const isCollapsed = collapsed.has(index);

            return (
              <li
                key={`${heading.lineIndex}-${heading.text}`}
                ref={isActive ? activeItemRef : undefined}
                className={styles.li}
                style={{ paddingLeft: `${8 + (heading.level - 1) * 14}px` }}
              >
                <div className={styles.row}>
                  {hasChildren ? (
                    <button
                      type="button"
                      className={styles.chevron}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleCollapsed(index);
                      }}
                      aria-expanded={!isCollapsed}
                      aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
                    >
                      {isCollapsed ? (
                        <ChevronRight size={14} />
                      ) : (
                        <ChevronDown size={14} />
                      )}
                    </button>
                  ) : (
                    <span className={styles.chevronPlaceholder} />
                  )}
                  <button
                    type="button"
                    className={cn(
                      styles.item,
                      isActive && styles.itemActive
                    )}
                    onClick={() => onSelectHeading(heading)}
                  >
                    <span className={styles.text}>{heading.text}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </nav>
    </aside>
  );
}
