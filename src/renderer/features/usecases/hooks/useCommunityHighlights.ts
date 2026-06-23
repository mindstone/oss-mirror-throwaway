/**
 * useCommunityHighlights - Subscribes to community highlights state
 *
 * Fetches highlights from the Rebels community forum.
 * Used by The Spark to display trending topics.
 */

import { useState, useEffect } from 'react';
import type { CommunityHighlightsState } from '@shared/types';

/** @deprecated Scheduled for removal — no longer used after Spark simplification */
export function useCommunityHighlights(): CommunityHighlightsState & { isLoading: boolean } {
  const [state, setState] = useState<CommunityHighlightsState>({
    highlights: [],
    lastFetchedAt: null,
    lastError: null,
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // Initial fetch
    window.api.getCommunityHighlights().then((result) => {
      if (cancelled) return;
      setState(result);
      setIsLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      console.error('Failed to fetch community highlights:', err);
      setIsLoading(false);
    });

    // Subscribe to updates
    const unsubscribe = window.api.onCommunityHighlights((newState) => {
      setState(newState);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return { ...state, isLoading };
}
