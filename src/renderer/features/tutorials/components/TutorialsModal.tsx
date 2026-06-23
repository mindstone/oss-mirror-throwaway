import { useState, useCallback, useEffect, useRef } from 'react';
import { Play, Check, ChevronRight, ExternalLink, X } from 'lucide-react';
import { FloatingPortal } from '@floating-ui/react';
import { useTutorialProgress } from '../hooks/useTutorialProgress';
import { tracking } from '@renderer/src/tracking';
import {
  LEARNING_PATHS,
  getVideosByPath,
  getYouTubeUrl,
  getTotalDuration,
  formatDuration,
  PLAYLIST_URL,
  type TutorialVideo,
  type LearningPathId,
} from '@shared/config/tutorialVideos';
import styles from './TutorialsModal.module.css';

// YouTube Player State constants
const YT_PLAYER_STATE = {
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

interface TutorialsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialVideo?: TutorialVideo | null;
}

/**
 * Two-panel modal for browsing and watching tutorial videos.
 * Uses FloatingPortal to render outside TheSparkPanel's opacity context.
 */
export function TutorialsModal({ open, onOpenChange, initialVideo }: TutorialsModalProps) {
  const [activeVideo, setActiveVideo] = useState<TutorialVideo | null>(initialVideo ?? null);
  const [expandedPath, setExpandedPath] = useState<LearningPathId | null>(
    initialVideo?.path ?? 'new-here'
  );
  const [videoError, setVideoError] = useState(false);
  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  const { isWatched, markWatched, watchedCount, totalCount } = useTutorialProgress();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  
  // Track session stats for close event
  const sessionStartRef = useRef<number>(0);
  const videosWatchedInSessionRef = useRef<number>(0);
  
  const handleVideoEnd = useCallback(() => {
    if (!activeVideo) return;
    
    // Track video completion
    const pathTitle = LEARNING_PATHS.find(p => p.id === activeVideo.path)?.title ?? activeVideo.path;
    tracking.tutorials.videoCompleted(activeVideo.id, activeVideo.title, pathTitle);
    videosWatchedInSessionRef.current += 1;
    
    markWatched(activeVideo.id);
    
    // Check if learning path is now complete
    const pathVideos = getVideosByPath(activeVideo.path);
    const watchedInPath = pathVideos.filter(v => isWatched(v.id) || v.id === activeVideo.id).length;
    if (watchedInPath === pathVideos.length) {
      tracking.tutorials.learningPathCompleted(activeVideo.path, pathTitle, pathVideos.length);
    }
    
    // Auto-advance to next in path
    const currentIndex = pathVideos.findIndex((v) => v.id === activeVideo.id);
    if (currentIndex < pathVideos.length - 1) {
      setActiveVideo(pathVideos[currentIndex + 1]);
    }
  }, [activeVideo, markWatched, isWatched]);
  
  // Handle YouTube iframe API messages for video end detection
  // Messages come from our localhost wrapper which forwards YouTube's postMessage events
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Accept messages from our localhost wrapper, youtube-nocookie.com, or youtube.com
      // The localhost wrapper forwards YouTube's postMessage events to us
      const isLocalhostOrigin = event.origin.startsWith('http://127.0.0.1:');
      const isYouTubeOrigin = event.origin === 'https://www.youtube-nocookie.com' || 
                              event.origin === 'https://www.youtube.com';
      if (!isLocalhostOrigin && !isYouTubeOrigin) return;
      
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        
        // YouTube sends player state changes via postMessage when enablejsapi=1
        if (data.event === 'onStateChange' && data.info === YT_PLAYER_STATE.ENDED) {
          handleVideoEnd();
        }
      } catch {
        // Ignore non-JSON messages
      }
    };
    
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [handleVideoEnd]);

  // Reset state when modal closes to avoid stale video on reopen
  useEffect(() => {
    if (open) {
      // Track session start
      sessionStartRef.current = Date.now();
      videosWatchedInSessionRef.current = 0;
    } else if (sessionStartRef.current > 0) {
      // Track modal close with session stats
      const timeSpentMs = Date.now() - sessionStartRef.current;
      tracking.tutorials.modalClosed(videosWatchedInSessionRef.current, timeSpentMs);
      
      // Reset state
      setActiveVideo(null);
      setExpandedPath('new-here');
      setVideoError(false);
      sessionStartRef.current = 0;
    }
  }, [open]);

  // Sync initialVideo prop changes (e.g., when store updates while modal is open)
  useEffect(() => {
    if (open && initialVideo) {
      setActiveVideo(initialVideo);
      setExpandedPath(initialVideo.path);
      setVideoError(false);
    }
  }, [open, initialVideo]);

  // Reset error state and fetch player URL when video changes
  useEffect(() => {
    setVideoError(false);
    setPlayerUrl(null);
    
    if (!activeVideo) return;
    
    // Fetch the localhost wrapper URL for this video
    // This workaround is needed because file:// protocol cannot send valid HTTP Referer headers
    // which YouTube requires. The localhost server serves a wrapper page that CAN send headers.
    window.appApi.getTutorialPlayerUrl(activeVideo.youtubeId)
      .then((url) => {
        if (url) {
          // Append autoplay=1 for tutorial playback (wrapper defaults to no autoplay)
          setPlayerUrl(`${url}&autoplay=1`);
        } else {
          // Server not running - fall back to direct embed (will fail in production builds)
          setPlayerUrl(`https://www.youtube-nocookie.com/embed/${activeVideo.youtubeId}?autoplay=1&modestbranding=1&rel=0&enablejsapi=1`);
        }
      })
      .catch(() => {
        // On error, fall back to direct embed
        setPlayerUrl(`https://www.youtube-nocookie.com/embed/${activeVideo.youtubeId}?autoplay=1&modestbranding=1&rel=0&enablejsapi=1`);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps intentionally narrowed to id/youtubeId; only those fields are used in the body
  }, [activeVideo?.id, activeVideo?.youtubeId]);

  const handleSelectVideo = (video: TutorialVideo) => {
    // Track video started
    const pathTitle = LEARNING_PATHS.find(p => p.id === video.path)?.title ?? video.path;
    tracking.tutorials.videoStarted(video.id, video.title, pathTitle);
    
    setActiveVideo(video);
    setExpandedPath(video.path);
    setVideoError(false);
  };

  const handlePathToggle = (pathId: LearningPathId, pathTitle: string, isCurrentlyExpanded: boolean) => {
    const newExpanded = isCurrentlyExpanded ? null : pathId;
    if (newExpanded) {
      tracking.tutorials.learningPathExpanded(pathId, pathTitle);
    }
    setExpandedPath(newExpanded);
  };

  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  // Handle Escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, handleClose]);

  if (!open) return null;

  return (
    <FloatingPortal>
      <div
        className={styles.overlay}
        role="dialog"
        aria-modal
        aria-label="Tutorial videos"
        onClick={handleClose}
      >
        <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
          {/* Close button */}
          <button
            type="button"
            className={styles.closeButton}
            onClick={handleClose}
            aria-label="Close"
          >
            <X size={20} />
          </button>

          <div className={styles.layout}>
            {/* Left panel: Learning paths */}
            <nav className={styles.sidebar}>
              <header className={styles.sidebarHeader}>
                <h2 className={styles.sidebarTitle}>Tutorials</h2>
                <span className={styles.progressBadge}>
                  {watchedCount}/{totalCount}
                </span>
              </header>

              <div className={styles.pathList}>
                {LEARNING_PATHS.map((path) => {
                  const videos = getVideosByPath(path.id);
                  const watchedInPath = videos.filter((v) => isWatched(v.id)).length;
                  const isExpanded = expandedPath === path.id;
                  const isComplete = watchedInPath === videos.length;

                  return (
                    <div key={path.id} className={styles.pathGroup}>
                      <button
                        type="button"
                        className={styles.pathHeader}
                        onClick={() => handlePathToggle(path.id, path.title, isExpanded)}
                        data-complete={isComplete}
                        aria-expanded={isExpanded}
                      >
                        <div className={styles.pathInfo}>
                          <span className={styles.pathTitle}>{path.title}</span>
                          <span className={styles.pathMeta}>
                            {watchedInPath}/{videos.length} · {formatDuration(getTotalDuration(videos))}
                          </span>
                        </div>
                        <ChevronRight
                          size={16}
                          className={styles.pathChevron}
                          data-expanded={isExpanded}
                        />
                      </button>

                      {isExpanded && (
                        <div className={styles.pathVideos}>
                          <p className={styles.pathTagline}>{path.tagline}</p>
                          {videos.map((video) => {
                            const watched = isWatched(video.id);
                            const isActive = activeVideo?.id === video.id;
                            return (
                              <button
                                key={video.id}
                                type="button"
                                className={styles.videoItem}
                                onClick={() => handleSelectVideo(video)}
                                data-active={isActive}
                                data-watched={watched}
                              >
                                {watched ? (
                                  <Check size={14} className={styles.watchedIcon} />
                                ) : (
                                  <Play size={14} className={styles.playIcon} />
                                )}
                                <span className={styles.videoItemTitle}>{video.title}</span>
                                <span className={styles.videoItemDuration}>{video.duration}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <footer className={styles.sidebarFooter}>
                <button
                  type="button"
                  className={styles.playlistLink}
                  onClick={() => {
                    tracking.tutorials.openedOnYoutube();
                    window.appApi.openUrl(PLAYLIST_URL);
                  }}
                >
                  <ExternalLink size={14} />
                  Open on YouTube
                </button>
              </footer>
            </nav>

            {/* Right panel: Video player */}
            <main className={styles.playerArea}>
              {activeVideo && !videoError && playerUrl ? (
                <>
                  <div className={styles.playerWrapper}>
                    {/* YouTube embed via localhost wrapper server.
                        Background: YouTube requires valid HTTP Referer headers. In production, Electron serves
                        the app from file:// protocol which CANNOT send Referer headers (browser security).
                        Solution: We serve a small wrapper HTML page from http://127.0.0.1 that embeds YouTube.
                        The wrapper CAN send proper Referer headers because it's served over HTTP.
                        See: src/main/services/tutorialPlayerServer.ts */}
                    <iframe
                      ref={iframeRef}
                      key={activeVideo.youtubeId}
                      src={playerUrl}
                      width="100%"
                      height="100%"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      title={activeVideo.title}
                      style={{ border: 'none' }}
                      onError={() => setVideoError(true)}
                    />
                  </div>
                  <div className={styles.videoMeta}>
                    <h3 className={styles.activeTitle}>{activeVideo.title}</h3>
                    <p className={styles.activeQuip}>{activeVideo.quip}</p>
                  </div>
                </>
              ) : activeVideo && !playerUrl && !videoError ? (
                <div className={styles.emptyPlayer}>
                  <p>Loading video...</p>
                </div>
              ) : videoError && activeVideo ? (
                <div className={styles.errorState}>
                  <p className={styles.errorText}>Video unavailable</p>
                  <button
                    type="button"
                    className={styles.errorButton}
                    onClick={() => {
                      tracking.tutorials.openedOnYoutube(activeVideo.id);
                      window.appApi.openUrl(getYouTubeUrl(activeVideo.youtubeId));
                    }}
                  >
                    <ExternalLink size={16} />
                    Open on YouTube
                  </button>
                </div>
              ) : (
                <div className={styles.emptyPlayer}>
                  <p>Select a video to start learning</p>
                </div>
              )}
            </main>
          </div>
        </div>
      </div>
    </FloatingPortal>
  );
}
