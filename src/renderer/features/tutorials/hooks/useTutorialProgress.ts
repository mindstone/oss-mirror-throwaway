import { useCallback, useMemo } from 'react';
import { useSettings } from '@renderer/features/settings';
import { TUTORIAL_VIDEOS, getVideosByPath, type TutorialVideo } from '@shared/config/tutorialVideos';

/**
 * Hook for tracking tutorial video watch progress.
 * Uses the existing settings auto-save mechanism via updateDraft.
 */
export function useTutorialProgress() {
  const { settings, updateDraft } = useSettings();

  const watchedVideos = useMemo(
    () => new Set(settings?.tutorialProgress?.watchedVideos ?? []),
    [settings?.tutorialProgress?.watchedVideos]
  );

  const watchedCount = watchedVideos.size;
  const totalCount = TUTORIAL_VIDEOS.length;

  const markWatched = useCallback(
    (videoId: string) => {
      if (watchedVideos.has(videoId)) return;
      const currentWatched = settings?.tutorialProgress?.watchedVideos ?? [];
      updateDraft('tutorialProgress', {
        watchedVideos: [...currentWatched, videoId],
        lastWatchedAt: Date.now(),
      });
    },
    [settings?.tutorialProgress?.watchedVideos, updateDraft, watchedVideos]
  );

  const isWatched = useCallback((videoId: string) => watchedVideos.has(videoId), [watchedVideos]);

  const getNextUnwatched = useCallback((): TutorialVideo | null => {
    // Prioritize "new-here" path for new users
    for (const video of getVideosByPath('new-here')) {
      if (!watchedVideos.has(video.id)) return video;
    }
    // Then any unwatched
    return TUTORIAL_VIDEOS.find((v) => !watchedVideos.has(v.id)) ?? null;
  }, [watchedVideos]);

  const getProgressLabel = useCallback((): string => {
    if (watchedCount === 0) return 'Start your journey';
    if (watchedCount < 5) return `${watchedCount} of ${totalCount} — just getting started`;
    if (watchedCount < 10) return `${watchedCount} of ${totalCount} — you're learning`;
    if (watchedCount < 15) return `${watchedCount} of ${totalCount} — getting dangerous`;
    if (watchedCount < totalCount) return `${watchedCount} of ${totalCount} — almost there`;
    return 'All watched — you know me well';
  }, [watchedCount, totalCount]);

  return {
    watchedVideos,
    watchedCount,
    totalCount,
    markWatched,
    isWatched,
    getNextUnwatched,
    getProgressLabel,
  };
}
