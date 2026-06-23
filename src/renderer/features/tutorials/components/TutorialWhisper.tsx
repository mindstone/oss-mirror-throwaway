import { useEffect, useRef } from 'react';
import { Play, ChevronRight, CheckCircle } from 'lucide-react';
import { useTutorialProgress } from '../hooks/useTutorialProgress';
import { tracking } from '@renderer/src/tracking';
import { getYouTubeThumbnail, type TutorialVideo } from '@shared/config/tutorialVideos';
import styles from './TutorialWhisper.module.css';

interface TutorialWhisperProps {
  onOpenTutorials: () => void;
  onPlayVideo: (video: TutorialVideo) => void;
}

/**
 * Single rotating video suggestion with personality.
 * Shows next unwatched video with quip, or completion state.
 */
export function TutorialWhisper({ onOpenTutorials, onPlayVideo }: TutorialWhisperProps) {
  const { getNextUnwatched, getProgressLabel, watchedCount, totalCount } = useTutorialProgress();
  const trackedVideoIdRef = useRef<string | null>(null);

  const nextVideo = getNextUnwatched();
  const allWatched = watchedCount === totalCount;

  // Track when whisper is shown with a new video
  useEffect(() => {
    if (nextVideo && trackedVideoIdRef.current !== nextVideo.id) {
      tracking.tutorials.whisperShown(nextVideo.id, nextVideo.title);
      trackedVideoIdRef.current = nextVideo.id;
    }
  }, [nextVideo]);

  const handlePlayVideo = (video: TutorialVideo) => {
    tracking.tutorials.whisperClicked(video.id, video.title);
    onPlayVideo(video);
  };

  const handleOpenTutorials = () => {
    tracking.tutorials.modalOpened('spark_whisper');
    onOpenTutorials();
  };

  if (allWatched) {
    return (
      <div className={styles.whisper} data-complete>
        <div className={styles.completeState}>
          <CheckCircle size={20} className={styles.completeIcon} />
          <div className={styles.completeText}>
            <span className={styles.completeTitle}>All tutorials watched</span>
            <span className={styles.completeSubtitle}>You know me well</span>
          </div>
        </div>
        <button type="button" className={styles.seeAll} onClick={handleOpenTutorials}>
          Watch again
          <ChevronRight size={14} className={styles.chevron} />
        </button>
      </div>
    );
  }

  if (!nextVideo) return null;

  return (
    <div className={styles.whisper}>
      <button
        type="button"
        className={styles.videoCard}
        onClick={() => handlePlayVideo(nextVideo)}
        aria-label={`Watch: ${nextVideo.title}`}
      >
        <div className={styles.thumbnail}>
          <img
            src={getYouTubeThumbnail(nextVideo.youtubeId, 'medium')}
            alt=""
            loading="lazy"
          />
          <div className={styles.playOverlay}>
            <Play size={24} fill="currentColor" />
          </div>
          <span className={styles.duration}>{nextVideo.duration}</span>
        </div>
        <div className={styles.content}>
          <p className={styles.quip}>{nextVideo.quip}</p>
          <h4 className={styles.title}>{nextVideo.title}</h4>
        </div>
      </button>

      <footer className={styles.footer}>
        <span className={styles.progress}>{getProgressLabel()}</span>
        <button type="button" className={styles.seeAll} onClick={handleOpenTutorials}>
          See all
          <ChevronRight size={14} className={styles.chevron} />
        </button>
      </footer>
    </div>
  );
}
