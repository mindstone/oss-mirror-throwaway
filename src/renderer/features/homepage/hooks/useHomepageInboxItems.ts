/**
 * useHomepageInboxItems - Thin hook for top-N inbox items on the homepage
 *
 * Loads the inbox index and active item details via IPC.
 * Returns only non-archived, actionable items sorted by urgency.
 * This is intentionally separate from the full useInbox hook to keep
 * the homepage lightweight — we only need a handful of items.
 *
 * Freshness:
 *   - Subscribes to `window.api.onInboxUpdate` for live updates
 *   - Refetches when the app becomes visible (handles overnight / sleep)
 */

import { useState, useMemo, useCallback, useRef } from 'react';
import type { InboxItem, InboxIndexEntry } from '@shared/types';
import { useVisibilityAwareInterval } from '@renderer/hooks/useVisibilityAwareInterval';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';

const MAX_INBOX_ITEMS = 30;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes — matches meeting cache cadence

export interface UseHomepageInboxResult {
  items: InboxItem[];
  isLoading: boolean;
}

export function useHomepageInboxItems(enabled = true): UseHomepageInboxResult {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const fetchIdRef = useRef(0);

  const load = useCallback(async () => {
    const currentFetchId = ++fetchIdRef.current;
    try {
      const indexData = await window.inboxApi.loadIndex();
      if (currentFetchId !== fetchIdRef.current) return;

      // Load a broader candidate set (not just currently-relevant items) so the
      // Today stream can keep 5 visible cards by backfilling lower-priority items.
      const candidateEntries = indexData.entries
        .filter((e: InboxIndexEntry) => !e.archived && !e.autoCompleted)
        .sort((a: InboxIndexEntry, b: InboxIndexEntry) => b.addedAt - a.addedAt)
        .slice(0, MAX_INBOX_ITEMS);

      if (currentFetchId !== fetchIdRef.current) return;

      if (candidateEntries.length > 0) {
        const ids = candidateEntries.map((e: InboxIndexEntry) => e.id);
        const loaded = await window.inboxApi.loadItems({ ids });
        if (currentFetchId !== fetchIdRef.current) return;
        setItems(loaded);
      } else {
        setItems([]);
      }
    } catch (err) {
      if (fetchIdRef.current > 1) {
        console.warn('[Homepage inbox] Failed to refresh items:', err);
      }
    } finally {
      if (currentFetchId === fetchIdRef.current) setIsLoading(false);
    }
  }, []);

  // Periodic refresh: runs on mount, every 5 min when visible, pauses when
  // hidden, and catches up immediately on hidden→visible transitions
  useVisibilityAwareInterval(load, REFRESH_INTERVAL_MS, null, [], enabled);

  // Subscribe to real-time inbox updates from the main process (only when enabled)
  useIpcEvent(
    !enabled ? undefined : window.api.onInboxUpdate,
    () => { load(); },
    [load, enabled],
  );

  // Sort by urgency: urgent + important first
  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      const aScore = (a.urgent ? 2 : 0) + (a.important !== false ? 1 : 0);
      const bScore = (b.urgent ? 2 : 0) + (b.important !== false ? 1 : 0);
      if (bScore !== aScore) return bScore - aScore;
      return b.addedAt - a.addedAt;
    });
  }, [items]);

  return { items: sorted, isLoading };
}
