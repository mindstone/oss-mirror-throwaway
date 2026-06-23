/**
 * useConversation Hook
 *
 * Returns a reactive snapshot of a single session by ID, or `null` when:
 *   - The session is not found
 *   - The session is private (`privateMode === true`)
 *
 * Deleted sessions are returned with `deletedAt` set (not null),
 * consistent with the list API when `includeDeleted` is used.
 *
 * Uses `useSyncExternalStore` for consistent snapshot semantics,
 * matching the pattern in `useConversations`.
 *
 * @see docs/plans/260408_plugin_conversation_api_expansion.md (C3, FM10)
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';
import { getSessionStoreState, subscribeToSessionStore } from '@renderer/features/agent-session/store/sessionStore';
import { mapSummaryToConversation } from './conversationMapper';
import type { ConversationSummary } from './types';

/**
 * Returns a single conversation summary by ID, or `null`.
 *
 * - Private sessions → `null` (indistinguishable from not-found)
 * - Deleted sessions → returns summary with `deletedAt` set
 * - Not found → `null`
 *
 * Reactive: re-renders when the target session's metadata changes.
 */
export function useConversation(id: string): ConversationSummary | null {
  const cachedRef = useRef<{
    result: ConversationSummary | null;
    updatedAt: number | null;
    title: string | null;
    doneAt: number | null;
    starredAt: number | null;
    isBusy: boolean | null;
    deletedAt: number | null;
  }>({
    result: null,
    updatedAt: null,
    title: null,
    doneAt: null,
    starredAt: null,
    isBusy: null,
    deletedAt: null,
  });

  const getSnapshot = useCallback((): ConversationSummary | null => {
    const { sessionSummaries } = getSessionStoreState();
    const summary = sessionSummaries.find(s => s.id === id);

    // Not found → null
    if (!summary) {
      if (cachedRef.current.result === null) return cachedRef.current.result;
      cachedRef.current = { result: null, updatedAt: null, title: null, doneAt: null, starredAt: null, isBusy: null, deletedAt: null };
      return null;
    }

    // Private → null (indistinguishable from not-found for plugin)
    if (summary.privateMode === true) {
      if (cachedRef.current.result === null) return cachedRef.current.result;
      cachedRef.current = { result: null, updatedAt: null, title: null, doneAt: null, starredAt: null, isBusy: null, deletedAt: null };
      return null;
    }

    // Return cached result if nothing changed
    if (
      cachedRef.current.result !== null
      && cachedRef.current.updatedAt === summary.updatedAt
      && cachedRef.current.title === summary.title
      && cachedRef.current.doneAt === (summary.doneAt ?? null)
      && cachedRef.current.starredAt === summary.starredAt
      && cachedRef.current.isBusy === summary.isBusy
      && cachedRef.current.deletedAt === summary.deletedAt
    ) {
      return cachedRef.current.result;
    }

    const mapped = mapSummaryToConversation(summary);
    cachedRef.current = {
      result: mapped,
      updatedAt: summary.updatedAt,
      title: summary.title,
      doneAt: summary.doneAt ?? null,
      starredAt: summary.starredAt ?? null,
      isBusy: summary.isBusy,
      deletedAt: summary.deletedAt ?? null,
    };
    return mapped;
  }, [id]);

  return useSyncExternalStore(
    subscribeToSessionStore,
    getSnapshot,
    () => null, // SSR fallback
  );
}
