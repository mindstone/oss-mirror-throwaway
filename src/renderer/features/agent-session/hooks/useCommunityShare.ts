/**
 * Community Share Hook
 *
 * Listens for community share eligibility broadcasts and provides
 * share data for the current session.
 *
 * Follows the same module-level cache + IPC listener pattern as useSessionCoaching.
 */

import { useEffect, useState } from 'react';
import type { CommunityShareEligibility, CommunitySharePreview } from '@shared/types';

type ShareEligibilityListener = (sessionId: string, eligibility: CommunityShareEligibility | null) => void;

// Module-level state for cross-component sharing (same pattern as useSessionCoaching)
const eligibilityBySession: Map<string, CommunityShareEligibility> = new Map();
const listeners: Set<ShareEligibilityListener> = new Set();
let ipcListenerInitialized = false;

/** Cap to prevent unbounded growth in long-running sessions. Oldest entries evicted first. */
const MAX_ELIGIBILITY_CACHE = 50;

/** Evict oldest entries when cache exceeds cap. Map iterates in insertion order. */
const pruneEligibilityCache = (): void => {
  if (eligibilityBySession.size <= MAX_ELIGIBILITY_CACHE) return;
  const toDelete = eligibilityBySession.size - MAX_ELIGIBILITY_CACHE;
  let deleted = 0;
  for (const key of eligibilityBySession.keys()) {
    if (deleted >= toDelete) break;
    eligibilityBySession.delete(key);
    deleted++;
  }
};

const notifyListeners = (sessionId: string, eligibility: CommunityShareEligibility | null): void => {
  listeners.forEach(listener => listener(sessionId, eligibility));
};

const initializeIpcListener = (): void => {
  if (ipcListenerInitialized) return;
  ipcListenerInitialized = true;

  window.api.onCommunityShareEligible(({ sessionId, eligibility }) => {
    const typed = eligibility as CommunityShareEligibility;
    eligibilityBySession.set(sessionId, typed);
    pruneEligibilityCache();
    notifyListeners(sessionId, typed);
  });
};

/**
 * Hook to get community share eligibility for a specific session.
 * Automatically updates when new eligibility arrives via IPC broadcast.
 */
export const useCommunityShare = (sessionId: string | null): CommunityShareEligibility | null => {
  const [eligibility, setEligibility] = useState<CommunityShareEligibility | null>(null);

  useEffect(() => {
    // Initialize global IPC listener
    initializeIpcListener();

    // Subscribe to updates
    const listener: ShareEligibilityListener = (id, elig) => {
      if (id === sessionId) {
        setEligibility(elig);
      }
    };
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  }, [sessionId]);

  // Fetch eligibility when session changes
  useEffect(() => {
    let cancelled = false;

    if (!sessionId) {
      setEligibility(null);
      return;
    }

    // Check cache first
    const cached = eligibilityBySession.get(sessionId);
    if (cached) {
      setEligibility(cached);
      return;
    }

    // Fetch from main process
    window.api.getShareEligibility(sessionId)
      .then(({ eligibility: elig }) => {
        if (cancelled) return;
        if (elig) {
          const typed = elig as CommunityShareEligibility;
          eligibilityBySession.set(sessionId, typed);
          pruneEligibilityCache();
          setEligibility(typed);
        } else {
          setEligibility(null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('Failed to fetch share eligibility for session:', err);
        setEligibility(null);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return eligibility;
};

// ── Action helpers (exported for use in actionsRef) ─────────────────────────

export const composeSharePost = async (sessionId: string): Promise<CommunitySharePreview | null> => {
  const result = await window.api.composeSharePost(sessionId);
  if (!result.preview && result.error) {
    throw new Error(result.error);
  }
  return (result.preview as CommunitySharePreview) ?? null;
};

export const openDiscourseShare = async (sessionId: string): Promise<void> => {
  const result = await window.api.openDiscourseShare(sessionId) as { success: boolean; error?: string };
  if (!result.success) {
    throw new Error(result.error ?? 'Failed to open Discourse');
  }
};

export const dismissShare = async (sessionId: string): Promise<void> => {
  eligibilityBySession.delete(sessionId);
  notifyListeners(sessionId, null);
  await window.api.dismissShare(sessionId);
};

export const optOutSharing = async (): Promise<void> => {
  // Notify listeners for every tracked session before clearing
  const sessionIds = [...eligibilityBySession.keys()];
  eligibilityBySession.clear();
  for (const id of sessionIds) {
    notifyListeners(id, null);
  }
  await window.api.optOutSharing();
};

/** Dev:perf diagnostic — number of cached eligibility entries. */
export const getEligibilityCacheSize = (): number => eligibilityBySession.size;
