import { useState, useEffect } from 'react';
import type { VideoRecommendation } from '@core/services/communityVideoRecsTypes';

/**
 * Lightweight hook returning the top community video recommendation.
 *
 * Third-tier fallback for discovery surfaces — shown only when both tutorials
 * and changelog highlights are exhausted. Calls `communityVideoRecs:get-card-data`
 * IPC (a cheap store read). Returns null when suppressed, empty, or loading.
 *
 * @see CommunityVideoRecsCard for the full Spark card (retry logic, suppress UI).
 */
export function useCommunityVideoRec(): { video: VideoRecommendation | null; loading: boolean } {
  const [video, setVideo] = useState<VideoRecommendation | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function fetch() {
      try {
        const data = await window.communityVideoRecsApi.getCardData({});
        if (cancelled) return;
        if (data.type === 'recommendations' && data.recommendations.length > 0) {
          setVideo(data.recommendations[0]);
        }
      } catch (err) {
        console.error('[useCommunityVideoRec] Failed to fetch card data:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetch();
    return () => { cancelled = true; };
  }, []);

  return { video, loading };
}
