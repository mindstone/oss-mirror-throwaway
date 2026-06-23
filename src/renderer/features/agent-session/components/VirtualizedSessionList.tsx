import type { RefObject, ReactNode } from "react";
import { useRef, useCallback, useImperativeHandle, forwardRef, useLayoutEffect, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { SidebarListEntry } from "../utils/buildFolderAwareList";
import styles from "./AgentSessionSidebar.module.css";

/** Minimum number of items before virtualization kicks in */
const VIRTUALIZATION_THRESHOLD = 50;

/** Estimated height of a sidebar entry in pixels (padding + content) */
const ESTIMATED_ITEM_HEIGHT = 76;

/** Estimated height of a folder header in pixels */
const FOLDER_HEADER_HEIGHT = 40;

/** Estimated height of a folder's "Done (N)" subsection header in pixels (matches DoneSubsectionRow.module.css) */
const DONE_SUBHEADER_HEIGHT = 28;

/** Gap between virtualized items in pixels (matches plain list margin-top) */
const ITEM_GAP = 8;

/** Number of extra items to render above/below viewport */
const OVERSCAN = 5;

/** Handle exposed by VirtualizedSessionList for programmatic scroll */
export interface VirtualizedSessionListHandle {
  /** Scroll to the item at the given index */
  scrollToIndex: (index: number) => void;
  /** Find the index of an entry by ID (session ID or folder: prefixed ID), or -1 if not found */
  findIndex: (id: string) => number;
  /** Whether the list is currently virtualized (above threshold) */
  isVirtualized: boolean;
}

type VirtualizedSessionListProps = {
  entries: SidebarListEntry[];
  /**
   * Render function for each entry. Must return a single element with
   * data-session-id (for sessions), className, event handlers, etc.
   */
  renderEntry: (entry: SidebarListEntry, index: number) => ReactNode;
  /** Ref to the outer scroll container (sidebarListContainer) used as the virtualizer's scroll element */
  scrollContainerRef: RefObject<HTMLElement | null>;
  /** Test ID for the list element */
  "data-testid"?: string;
};

// ─── Plain list (below threshold) ────────────────────────────────────────────

const PlainList = forwardRef<
  VirtualizedSessionListHandle,
  { entries: SidebarListEntry[]; renderEntry: VirtualizedSessionListProps["renderEntry"]; testId?: string }
>(({ entries, renderEntry, testId }, ref) => {
  useImperativeHandle(ref, () => ({
    scrollToIndex: () => {
      // No-op — caller should fall back to DOM scrollIntoView for plain lists
    },
    findIndex: (id: string) => entries.findIndex((e) => e.id === id),
    isVirtualized: false,
  }), [entries]);

  return (
    <div role="list" className={styles.sidebarList} data-testid={testId}>
      {entries.map((entry, index) => renderEntry(entry, index))}
    </div>
  );
});

PlainList.displayName = "PlainList";

// ─── Virtualized list (above threshold) ──────────────────────────────────────

const VirtualList = forwardRef<
  VirtualizedSessionListHandle,
  {
    entries: SidebarListEntry[];
    renderEntry: VirtualizedSessionListProps["renderEntry"];
    scrollContainerRef: RefObject<HTMLElement | null>;
    testId?: string;
  }
>(({ entries, renderEntry, scrollContainerRef, testId }, ref) => {
  // Ref to the list wrapper — used to calculate scrollMargin
  const listWrapperRef = useRef<HTMLDivElement>(null);

  // Track scrollMargin (offset of this list within the scroll container).
  // Uses useLayoutEffect to avoid first-frame visual glitch, and a
  // ResizeObserver to recalculate when sibling sections expand/collapse.
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const listEl = listWrapperRef.current;
    const scrollEl = scrollContainerRef.current;
    if (!listEl || !scrollEl) return;

    const recalc = () => {
      const listRect = listEl.getBoundingClientRect();
      const scrollRect = scrollEl.getBoundingClientRect();
      setScrollMargin(listRect.top - scrollRect.top + scrollEl.scrollTop);
    };

    recalc();

    const ro = new ResizeObserver(recalc);
    ro.observe(scrollEl);
    return () => ro.disconnect();
  }, [scrollContainerRef]);

  const getItemKey = useCallback(
    (index: number) => entries[index]?.id ?? `sidebar-${index}`,
    [entries]
  );

  const estimateSize = useCallback(
    (index: number) => {
      const type = entries[index]?.type;
      if (type === 'folder-header') return FOLDER_HEADER_HEIGHT;
      if (type === 'done-subheader') return DONE_SUBHEADER_HEIGHT;
      return ESTIMATED_ITEM_HEIGHT;
    },
    [entries],
  );

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize,
    overscan: OVERSCAN,
    getItemKey,
    scrollMargin,
    gap: ITEM_GAP,
  });

  useImperativeHandle(ref, () => ({
    scrollToIndex: (index: number) => {
      if (index >= 0 && index < entries.length) {
        virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
      }
    },
    findIndex: (id: string) => entries.findIndex((e) => e.id === id),
    isVirtualized: true,
  }), [entries, virtualizer]);

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div ref={listWrapperRef} data-testid={testId}>
      <div
        role="list"
        className={styles.virtualizedList}
        style={{ height: virtualizer.getTotalSize() }}
      >
        {virtualItems.map((virtualRow) => {
          const entry = entries[virtualRow.index];
          return (
            <div
              key={virtualRow.key}
              role="listitem"
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className={styles.virtualizedItem}
              style={{ transform: `translateY(${virtualRow.start - scrollMargin}px)` }}
            >
              {renderEntry(entry, virtualRow.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
});

VirtualList.displayName = "VirtualList";

/**
 * Renders a session list, using virtualization when the list exceeds
 * VIRTUALIZATION_THRESHOLD items. Below that threshold, renders a plain
 * <ul> with .map() — the virtualization overhead isn't worth it for short lists.
 *
 * When virtualized, uses the parent's scroll container (sidebarListContainer) as the
 * scroll element — no nested scroll contexts. The virtualizer uses scrollMargin to
 * account for its offset within the parent scroll container.
 *
 * Follows the same useVirtualizer pattern as ConversationPane.tsx.
 */
export const VirtualizedSessionList = forwardRef<
  VirtualizedSessionListHandle,
  VirtualizedSessionListProps
>(({ entries, renderEntry, scrollContainerRef, "data-testid": testId }, ref) => {
  const shouldVirtualize = entries.length > VIRTUALIZATION_THRESHOLD;

  if (!shouldVirtualize) {
    return (
      <PlainList entries={entries} renderEntry={renderEntry} testId={testId} ref={ref} />
    );
  }

  return (
    <VirtualList
      entries={entries}
      renderEntry={renderEntry}
      scrollContainerRef={scrollContainerRef}
      testId={testId}
      ref={ref}
    />
  );
});

VirtualizedSessionList.displayName = "VirtualizedSessionList";
