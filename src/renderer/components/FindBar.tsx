/**
 * FindBar — floating find-in-page bar for the rendered app surface.
 *
 * Uses the CSS Custom Highlight API instead of Electron's native findInPage.
 * Native find searches renderer DOM, including the FindBar input itself, and
 * crosses the process boundary on every keystroke. Local ranges avoid both.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import { Button, Input } from '@renderer/components/ui';
import styles from './FindBar.module.css';

interface FindBarProps {
  isOpen: boolean;
  onClose: () => void;
  pendingAction?: 'next' | 'previous' | null;
  onPendingActionConsumed?: () => void;
}

const FIND_MATCH_HIGHLIGHT = 'rebel-find-match';
const FIND_ACTIVE_HIGHLIGHT = 'rebel-find-active';
const FIND_DEBOUNCE_MS = 120;

interface TextNodePosition {
  node: Text;
  start: number;
  end: number;
}

function clearFindHighlights(): void {
  try {
    CSS.highlights.delete(FIND_MATCH_HIGHLIGHT);
    CSS.highlights.delete(FIND_ACTIVE_HIGHLIGHT);
  } catch {
    // CSS Custom Highlight API may be unavailable in older Chromium builds.
  }
}

function isNodeVisible(element: Element): boolean {
  let current: Element | null = element;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    current = current.parentElement;
  }
  return true;
}

function collectSearchableTextNodes(findBarRoot: HTMLElement | null): TextNodePosition[] {
  const positions: TextNodePosition[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (findBarRoot?.contains(parent)) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script, style, noscript, input, textarea, select')) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!isNodeVisible(parent)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let cumulativeOffset = 0;
  let node = walker.nextNode() as Text | null;
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (length > 0) {
      positions.push({
        node,
        start: cumulativeOffset,
        end: cumulativeOffset + length,
      });
      cumulativeOffset += length;
    }
    node = walker.nextNode() as Text | null;
  }

  return positions;
}

function createRangeForOffsets(textNodes: TextNodePosition[], from: number, to: number): Range | null {
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (const position of textNodes) {
    if (!startNode && position.end > from) {
      startNode = position.node;
      startOffset = from - position.start;
    }
    if (position.end >= to) {
      endNode = position.node;
      endOffset = to - position.start;
      break;
    }
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  } catch {
    return null;
  }
}

function findVisibleRanges(query: string, findBarRoot: HTMLElement | null): Range[] {
  const normalizedQuery = query.toLowerCase();
  if (!normalizedQuery) return [];

  const textNodes = collectSearchableTextNodes(findBarRoot);
  const text = textNodes.map((position) => position.node.textContent ?? '').join('');
  const lowerText = text.toLowerCase();
  const ranges: Range[] = [];

  let index = 0;
  while ((index = lowerText.indexOf(normalizedQuery, index)) !== -1) {
    const range = createRangeForOffsets(textNodes, index, index + query.length);
    if (range) ranges.push(range);
    index += 1;
  }

  return ranges;
}

function resetAppShellScroll(): void {
  const scrollingElement = document.scrollingElement;
  if (scrollingElement && scrollingElement.scrollTop !== 0) {
    scrollingElement.scrollTop = 0;
  }
}

function findScrollableAncestor(element: Element | null): HTMLElement | null {
  let current = element?.parentElement ?? null;

  while (current && current !== document.body && current !== document.documentElement) {
    const style = window.getComputedStyle(current);
    const canScroll = /(auto|scroll)/.test(style.overflowY) && current.scrollHeight > current.clientHeight;
    if (canScroll) {
      return current;
    }
    current = current.parentElement;
  }

  return null;
}

function scrollRangeIntoView(range: Range): void {
  resetAppShellScroll();

  const element = range.startContainer.parentElement;
  const scrollContainer = findScrollableAncestor(element);
  if (!scrollContainer) return;

  const rangeRect = range.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  const topPadding = 80;
  const bottomPadding = 80;

  if (rangeRect.top >= containerRect.top + topPadding && rangeRect.bottom <= containerRect.bottom - bottomPadding) {
    return;
  }

  const targetTop = rangeRect.top - containerRect.top - scrollContainer.clientHeight / 2 + rangeRect.height / 2;
  scrollContainer.scrollTo({
    top: scrollContainer.scrollTop + targetTop,
    behavior: 'smooth',
  });

  requestAnimationFrame(resetAppShellScroll);
}

const FindBarComponent = ({ isOpen, onClose, pendingAction, onPendingActionConsumed }: FindBarProps) => {
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  const [totalMatches, setTotalMatches] = useState(0);
  const findBarRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<Element | null>(null);
  const rangesRef = useRef<Range[]>([]);
  const searchTimerRef = useRef<number | null>(null);

  // Capture and restore focus around open/close
  useEffect(() => {
    if (isOpen) {
      previousFocusRef.current = document.activeElement;
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) {
        window.clearTimeout(searchTimerRef.current);
      }
      clearFindHighlights();
    };
  }, []);

  const applyFindHighlights = useCallback((ranges: Range[], activeIndex: number) => {
    clearFindHighlights();

    if (ranges.length === 0) {
      setActiveMatch(0);
      setTotalMatches(0);
      return;
    }

    const wrappedIndex = ((activeIndex % ranges.length) + ranges.length) % ranges.length;
    const activeRange = ranges[wrappedIndex];

    try {
      CSS.highlights.set(FIND_MATCH_HIGHLIGHT, new Highlight(...ranges));
      CSS.highlights.set(FIND_ACTIVE_HIGHLIGHT, new Highlight(activeRange.cloneRange()));
    } catch {
      // If the browser ever lacks CSS highlights, the count still updates.
    }

    setActiveMatch(wrappedIndex + 1);
    setTotalMatches(ranges.length);
    scrollRangeIntoView(activeRange);
  }, []);

  const runFind = useCallback((text: string) => {
    const ranges = findVisibleRanges(text, findBarRef.current);
    rangesRef.current = ranges;
    applyFindHighlights(ranges, 0);
  }, [applyFindHighlights]);

  // Clear state and stop search on close.
  useEffect(() => {
    if (!isOpen) {
      if (searchTimerRef.current) {
        window.clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
      rangesRef.current = [];
      clearFindHighlights();
      setQuery('');
      setActiveMatch(0);
      setTotalMatches(0);
    }
  }, [isOpen]);

  const handleClose = useCallback(() => {
    clearFindHighlights();
    onClose();
    // Restore focus to the element that was active before find bar opened
    if (previousFocusRef.current && previousFocusRef.current instanceof HTMLElement) {
      previousFocusRef.current.focus();
    }
  }, [onClose]);

  const goToMatch = useCallback((index: number) => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    const wrappedIndex = ((index % ranges.length) + ranges.length) % ranges.length;
    applyFindHighlights(ranges, wrappedIndex);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [applyFindHighlights]);

  const handleQueryChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const text = e.target.value;
    setQuery(text);

    if (searchTimerRef.current) {
      window.clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }

    if (!text) {
      rangesRef.current = [];
      clearFindHighlights();
      setActiveMatch(0);
      setTotalMatches(0);
      return;
    }

    searchTimerRef.current = window.setTimeout(() => {
      searchTimerRef.current = null;
      runFind(text);
    }, FIND_DEBOUNCE_MS);
  }, [runFind]);

  const handleFindNext = useCallback(() => {
    if (query) {
      goToMatch(activeMatch);
    }
  }, [activeMatch, query, goToMatch]);

  const handleFindPrevious = useCallback(() => {
    if (query) {
      goToMatch(activeMatch - 2);
    }
  }, [activeMatch, query, goToMatch]);

  const keepFindInputFocus = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
  }, []);

  // Consume pending find action (next/previous) after mount — avoids timing issues
  // where the event would be dispatched before FindBar has mounted.
  useEffect(() => {
    if (!isOpen || !pendingAction) return;
    if (pendingAction === 'next') handleFindNext();
    else handleFindPrevious();
    onPendingActionConsumed?.();
  }, [isOpen, pendingAction, handleFindNext, handleFindPrevious, onPendingActionConsumed]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        handleFindPrevious();
      } else {
        handleFindNext();
      }
    }
  }, [handleClose, handleFindNext, handleFindPrevious]);

  if (!isOpen) return null;

  const hasQuery = query.length > 0;
  const noMatches = hasQuery && totalMatches === 0;

  return (
    <div ref={findBarRef} className={styles.overlay}>
      <Input
        ref={inputRef}
        type="text"
        inputSize="sm"
        className={styles.input}
        value={query}
        onChange={handleQueryChange}
        onKeyDown={handleKeyDown}
        placeholder="Find in page..."
        autoComplete="off"
        spellCheck={false}
      />
      <span className={styles.matchCount}>
        {hasQuery
          ? noMatches
            ? 'No matches'
            : `${activeMatch} of ${totalMatches}`
          : ''}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className={styles.navButton}
        onMouseDown={keepFindInputFocus}
        onClick={handleFindPrevious}
        disabled={!hasQuery || noMatches}
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp size={14} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={styles.navButton}
        onMouseDown={keepFindInputFocus}
        onClick={handleFindNext}
        disabled={!hasQuery || noMatches}
        title="Next match (Enter)"
      >
        <ChevronDown size={14} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={styles.closeButton}
        onClick={handleClose}
        title="Close (Escape)"
      >
        <X size={14} />
      </Button>
    </div>
  );
};

export const FindBar = memo(FindBarComponent);
