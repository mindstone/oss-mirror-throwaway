import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import type { InboxState, InboxItem, SocialPlatform, TaskExecutionMode, InboxHistoryEntry } from '@shared/types';
import { deriveConfidence, getScheduleDueBy } from '@rebel/shared';
import type { ConcreteTemporalGroup } from '@rebel/shared';
import { tracking } from '@renderer/src/tracking';
import { getQuadrant } from '../utils/quadrant';
import type { EmitLogFn } from '@renderer/contexts';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';

type UseInboxOptions = {
  emitLog?: EmitLogFn;
  showToast?: (options: { title: string }) => void;
};

type UseInboxResult = {
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  // Derived data
  items: InboxItem[];
  history: InboxHistoryEntry[];
  // Action handlers
  recordTaskExecutionResult: (taskId: string, sessionId: string, mode: TaskExecutionMode) => Promise<void>;
  handleTaskShare: (task: InboxItem, platform: SocialPlatform, text: string) => Promise<void>;
  handleDeleteTask: (taskId: string) => Promise<void>;
  handleArchiveTask: (taskId: string, archived: boolean) => Promise<void>;
  handleDone: (itemId: string) => Promise<void>;
  handleDismiss: (itemId: string) => Promise<void>;
  handleSetTags: (itemId: string, tags: string[]) => Promise<void>;
  handleSetPriority: (itemId: string, urgent: boolean, important: boolean) => Promise<boolean>;
  handleSetSchedule: (itemId: string, targetGroup: ConcreteTemporalGroup) => Promise<boolean>;
  // Computed counts from index (always accurate)
  archivedCount: number;
  activeCount: number;
  /** Count of non-archived items needing attention: medium/low confidence OR added today (for badge) */
  actionableCount: number;
};

export const useInbox = (options: UseInboxOptions = {}): UseInboxResult => {
  const { emitLog, showToast } = options;

  // Single source of truth: all items (active + archived)
  const [items, setItems] = useState<InboxItem[]>([]);
  // Lightweight metadata from index (version for freshness checking, history)
  const [inboxMeta, setInboxMeta] = useState<{ version: number; history: InboxHistoryEntry[] } | null>(null);

  // Loading states
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Async sequencing guard — prevents stale responses from overwriting newer data
  const fetchGenerationRef = useRef(0);

  // Counts derived from items (always accurate)
  const archivedCount = useMemo(() => items.filter(item => item.archived).length, [items]);
  const activeCount = useMemo(() => items.filter(item => !item.archived).length, [items]);
  const actionableCount = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayMs = todayStart.getTime();

    return items.filter(item => {
      if (item.archived) return false;
      const confidence = item.confidence ?? deriveConfidence(item);
      if (confidence === 'medium' || confidence === 'low') return true;
      if (item.addedAt >= todayMs && !item.executingSessionId) return true;
      return false;
    }).length;
  }, [items]);

  // Track seen item IDs for detecting new items (for analytics)
  const seenItemIdsRef = useRef<Set<string>>(new Set());

  // History from metadata
  const history = useMemo(() => inboxMeta?.history ?? [], [inboxMeta]);

  // Update from full state (used by subscription and mutation responses).
  // Invalidates in-flight fetches so stale initial loads or refreshes don't
  // overwrite this newer authoritative data.
  const updateFromFullState = useCallback((fullState: InboxState) => {
    // Invalidate any in-flight fetch so it won't overwrite this newer data
    ++fetchGenerationRef.current;

    // Detect new items for analytics (compare with previously seen IDs)
    const newItemIds = fullState.items
      .filter(item => !seenItemIdsRef.current.has(item.id))
      .map(item => item.id);
    
    // Track analytics for each new item added
    for (const newItemId of newItemIds) {
      const item = fullState.items.find(i => i.id === newItemId);
      if (item) {
        const hasReferences = Boolean(item.references && item.references.length > 0);
        const referenceCount = item.references?.length ?? 0;
        const source = item.source?.kind ?? 'unknown';
        const isFirstItem = seenItemIdsRef.current.size === 0;
        tracking.inbox.itemAdded(hasReferences, referenceCount, source, isFirstItem);
      }
    }
    
    // Update seen IDs
    fullState.items.forEach(item => seenItemIdsRef.current.add(item.id));
    
    setItems(fullState.items);
    setInboxMeta({ version: fullState.version, history: fullState.history });
  }, []);

  // Initial load: fetch index then ALL item details
  useEffect(() => {
    let cancelled = false;

    const loadInbox = async () => {
      const currentGeneration = ++fetchGenerationRef.current;
      try {
        setLoading(true);
        setError(null);
        
        // 1. Load index (triggers periodicFreshnessCheck on backend)
        const indexData = await window.inboxApi.loadIndex();
        
        if (cancelled || currentGeneration !== fetchGenerationRef.current) return;
        
        setInboxMeta({ version: indexData.version, history: indexData.history });
        
        // Seed seen IDs from index so pre-existing items aren't
        // double-counted as "newly added" in the first subscription payload.
        for (const entry of indexData.entries) {
          seenItemIdsRef.current.add(entry.id);
        }
        
        // 2. Load ALL item details (active + archived)
        const allIds = indexData.entries.map(e => e.id);
        
        if (allIds.length > 0) {
          const allItems = await window.inboxApi.loadItems({ ids: allIds });
          if (cancelled || currentGeneration !== fetchGenerationRef.current) return;
          setItems(allItems);
        }
      } catch (err) {
        if (!cancelled && currentGeneration === fetchGenerationRef.current) {
          const message = err instanceof Error ? err.message : 'Failed to load actions';
          setError(message);
          emitLog?.({
            level: 'error',
            message: 'Failed to load actions',
            context: { error: message },
            timestamp: Date.now()
          });
        }
      } finally {
        if (!cancelled && currentGeneration === fetchGenerationRef.current) {
          setLoading(false);
        }
      }
    };

    loadInbox();
    
    return () => {
      cancelled = true;
    };
  }, [emitLog]);

  // Refresh function — reloads index and ALL items
  const refresh = useCallback(async () => {
    const currentGeneration = ++fetchGenerationRef.current;
    setLoading(true);
    setError(null);
    
    try {
      const indexData = await window.inboxApi.loadIndex();
      if (currentGeneration !== fetchGenerationRef.current) return;
      
      setInboxMeta({ version: indexData.version, history: indexData.history });
      
      // Load ALL items
      const allIds = indexData.entries.map(e => e.id);
      
      if (allIds.length > 0) {
        const allItems = await window.inboxApi.loadItems({ ids: allIds });
        if (currentGeneration !== fetchGenerationRef.current) return;
        setItems(allItems);
      } else {
        setItems([]);
      }
    } catch (err) {
      if (currentGeneration === fetchGenerationRef.current) {
        const message = err instanceof Error ? err.message : 'Failed to refresh actions';
        setError(message);
        emitLog?.({
          level: 'error',
          message: 'Failed to refresh actions',
          context: { error: message },
          timestamp: Date.now()
        });
      }
    } finally {
      if (currentGeneration === fetchGenerationRef.current) {
        setLoading(false);
      }
    }
  }, [emitLog]);

  // Subscribe to inbox updates
  useIpcEvent(window.api.onInboxUpdate, (fullState) => {
    // Convert full state to index + cache atomically
    updateFromFullState(fullState);
  }, [updateFromFullState]);

  // Focus refresh: trigger backend periodicFreshnessCheck by calling loadIndex.
  // If the freshness check archives stale items, the backend emits via
  // onInboxUpdate (IPC subscription) which atomically replaces our state.
  // No need to manually reload items here — the subscription handles it.
  useEffect(() => {
    const handleFocus = async () => {
      try {
        await window.inboxApi.loadIndex();
      } catch {
        // Silent — don't surface errors for background freshness checks
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  // Action: Record task execution result
  const recordTaskExecutionResult = useCallback(
    async (taskId: string, sessionId: string, mode: TaskExecutionMode) => {
      try {
        const nextState = await window.tasksApi.recordExecution({
          itemId: taskId,
          sessionId,
          mode,
          executedAt: Date.now()
        });
        updateFromFullState(nextState);
      } catch (err) {
        emitLog?.({
          level: 'error',
          message: 'Failed to record task execution',
          context: {
            taskId,
            sessionId,
            mode,
            error: err instanceof Error ? err.message : String(err)
          },
          timestamp: Date.now()
        });
        showToast?.({ title: 'Unable to update task queue' });
      }
    },
    [emitLog, updateFromFullState, showToast]
  );

  // Action: Share task to social platform
  const handleTaskShare = useCallback(
    async (task: InboxItem, platform: SocialPlatform, text: string) => {
      const shareUrls: Record<SocialPlatform, (text: string, url?: string) => string> = {
        twitter: (t, u) => {
          const params = new URLSearchParams({ text: t });
          if (u) params.set('url', u);
          return `https://twitter.com/intent/tweet?${params.toString()}`;
        },
        linkedin: (_t, u) => {
          // LinkedIn only accepts URL, doesn't support pre-filled text
          return u
            ? `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(u)}`
            : 'https://www.linkedin.com/feed/';
        },
        facebook: (_t, u) => {
          // Facebook only accepts URL, doesn't support pre-filled text
          return u
            ? `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(u)}`
            : 'https://www.facebook.com/';
        }
      };

      // Find the shareToSocial action to get the URL
      const shareAction = task.actions?.find((a) => a.type === 'shareToSocial');
      const url = shareAction?.type === 'shareToSocial' ? shareAction.url : undefined;

      // For LinkedIn/Facebook, copy text to clipboard since they don't support pre-fill
      if (platform === 'linkedin' || platform === 'facebook') {
        try {
          await navigator.clipboard.writeText(text);
          showToast?.({ title: 'Text copied! Paste it in your post.' });
        } catch {
          // Clipboard access failed, continue anyway
        }
      }

      const shareUrl = shareUrls[platform](text, url);
      try {
        await window.api.openUrl(shareUrl);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to open share URL';
        showToast?.({ title: message });
        emitLog?.({
          level: 'error',
          message: 'Failed to open share URL',
          context: { platform, error: message },
          timestamp: Date.now()
        });
      }
    },
    [emitLog, showToast]
  );

  // Action: Delete task
  const handleDeleteTask = useCallback(
    async (taskId: string) => {
      try {
        const wasExecuted = history.some((h) => h.id === taskId);
        const nextState = await window.tasksApi.delete(taskId);
        updateFromFullState(nextState);
        tracking.inbox.itemDeleted(taskId, wasExecuted);
        // No toast - task disappears from list, visual feedback is clear
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to delete task';
        emitLog?.({
          level: 'error',
          message: 'Failed to delete task',
          context: { taskId, error: message },
          timestamp: Date.now()
        });
        showToast?.({ title: 'Unable to delete task' });
      }
    },
    [emitLog, history, updateFromFullState, showToast]
  );

  // Action: Archive/restore task (optimistic — UI updates instantly)
  const handleArchiveTask = useCallback(
    async (taskId: string, archived: boolean) => {
      const item = items.find(i => i.id === taskId);
      const now = Date.now();

      // Optimistic: update items state immediately
      setItems(prev => prev.map(i =>
        i.id === taskId
          ? { ...i, archived, archivedAt: archived ? now : undefined }
          : i
      ));

      try {
        await window.inboxApi.setArchived({ itemId: taskId, archived });
        if (archived) {
          const ageMs = item ? Date.now() - item.addedAt : 0;
          const quadrant = item ? getQuadrant(item) : 'consider';
          tracking.inbox.itemArchived(taskId, ageMs, quadrant, true);
        } else {
          tracking.inbox.itemRestored(taskId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to update task';
        emitLog?.({
          level: 'error',
          message: 'Failed to archive/restore task',
          context: { taskId, archived, error: message },
          timestamp: Date.now()
        });
        showToast?.({ title: 'Unable to update task' });
        void refresh();
      }
    },
    [items, emitLog, showToast, refresh]
  );

  // Action: Mark item as done (optimistic — UI updates instantly)
  const handleDone = useCallback(
    async (itemId: string) => {
      const now = Date.now();

      // Optimistic: update items state immediately so item disappears from active view
      setItems(prev => prev.map(item =>
        item.id === itemId
          ? { ...item, status: 'completed' as const, completedBy: 'user' as const, archived: true, archivedAt: now, executingSessionId: undefined }
          : item
      ));

      try {
        await window.inboxApi.setStatus({ itemId, status: 'completed', completedBy: 'user' });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to mark done';
        emitLog?.({
          level: 'error',
          message: 'Failed to mark item done',
          context: { itemId, error: message },
          timestamp: Date.now()
        });
        showToast?.({ title: 'Unable to mark done' });
        void refresh();
      }
    },
    [emitLog, refresh, showToast]
  );

  // Action: Dismiss item (optimistic — UI updates instantly)
  const handleDismiss = useCallback(
    async (
      itemId: string,
      reason?: { category?: InboxItem['dismissedReasonCategory']; text?: string },
    ) => {
      const now = Date.now();
      const dismissedReason = reason?.text?.trim();

      // Optimistic: update items state immediately
      setItems(prev => prev.map(item =>
        item.id === itemId
          ? {
              ...item,
              status: 'dismissed' as const,
              archived: true,
              archivedAt: now,
              executingSessionId: undefined,
              dismissedReasonCategory: reason?.category,
              dismissedReason: dismissedReason || undefined,
            }
          : item
      ));

      try {
        await window.inboxApi.setStatus({
          itemId,
          status: 'dismissed',
          dismissedReasonCategory: reason?.category,
          dismissedReason: dismissedReason || undefined,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to dismiss';
        emitLog?.({
          level: 'error',
          message: 'Failed to dismiss item',
          context: { itemId, error: message },
          timestamp: Date.now()
        });
        showToast?.({ title: 'Unable to dismiss' });
        void refresh();
      }
    },
    [emitLog, refresh, showToast]
  );

  // Action: Set tags
  const handleSetTags = useCallback(
    async (itemId: string, tags: string[]) => {
      try {
        const nextState = await window.inboxApi.setTags({ itemId, tags });
        updateFromFullState(nextState);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to update tags';
        emitLog?.({
          level: 'error',
          message: 'Failed to set tags',
          context: { itemId, error: message },
          timestamp: Date.now()
        });
        showToast?.({ title: 'Unable to update tags' });
      }
    },
    [emitLog, updateFromFullState, showToast]
  );

  const handleSetPriority = useCallback(
    async (itemId: string, urgent: boolean, important: boolean) => {
      const readOnly = await window.versionApi.readOnlyStatus().catch(() => null);
      if (readOnly?.readOnly) {
        showToast?.({ title: 'Update Rebel before changing actions' });
        return false;
      }

      setItems(prev => prev.map(item =>
        item.id === itemId
          ? { ...item, urgent, important }
          : item
      ));

      try {
        const nextState = await window.inboxApi.setQuadrant({ itemId, urgent, important });
        updateFromFullState(nextState);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to update priority';
        emitLog?.({
          level: 'error',
          message: 'Failed to set priority',
          context: { itemId, urgent, important, error: message },
          timestamp: Date.now()
        });
        showToast?.({ title: 'Unable to update priority' });
        void refresh();
        return false;
      }
    },
    [emitLog, updateFromFullState, showToast, refresh]
  );

  const handleSetSchedule = useCallback(
    async (itemId: string, targetGroup: ConcreteTemporalGroup) => {
      const readOnly = await window.versionApi.readOnlyStatus().catch(() => null);
      if (readOnly?.readOnly) {
        showToast?.({ title: 'Update Rebel before changing actions' });
        return false;
      }

      const dueBy = getScheduleDueBy(targetGroup);
      setItems(prev => prev.map(item =>
        item.id === itemId
          ? { ...item, dueBy }
          : item
      ));

      try {
        const nextState = await window.inboxApi.setDueBy({ itemId, dueBy });
        updateFromFullState(nextState);
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to update schedule';
        emitLog?.({
          level: 'error',
          message: 'Failed to set schedule',
          context: { itemId, targetGroup, error: message },
          timestamp: Date.now()
        });
        showToast?.({ title: 'Unable to update schedule' });
        void refresh();
        return false;
      }
    },
    [emitLog, updateFromFullState, showToast, refresh]
  );

  return {
    loading,
    error,
    refresh,
    items,
    history,
    recordTaskExecutionResult,
    handleTaskShare,
    handleDeleteTask,
    handleArchiveTask,
    handleDone,
    handleDismiss,
    handleSetTags,
    handleSetPriority,
    handleSetSchedule,
    archivedCount,
    activeCount,
    actionableCount,
  };
};
