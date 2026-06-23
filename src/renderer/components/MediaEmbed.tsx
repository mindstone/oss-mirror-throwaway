/**
 * MediaEmbed - Embeds multimedia content (YouTube, Vimeo, etc.) in conversation messages.
 *
 * Uses react-player v3.x. IMPORTANT: v3 uses `src` prop, not `url` (v2 API).
 * See docs/project/REACT_PLAYER_INTEGRATION.md for API details and gotchas.
 *
 * YouTube in production: Uses localhost wrapper server instead of ReactPlayer.
 * ReactPlayer creates iframes from file:// context which can't send HTTP Referer headers,
 * causing YouTube Error 153. The wrapper server (tutorialPlayerServer.ts) serves from
 * http://127.0.0.1 which CAN send proper Referer headers.
 */
import { memo, useState, useCallback, useEffect } from 'react';
import ReactPlayer from 'react-player';
import styles from './MediaEmbed.module.css';
import { getMediaType, extractYouTubeId } from '@renderer/utils/youtubeUtils';

// Re-export media detection utilities for convenience
export { isYouTubeUrl, isEmbeddableMediaUrl, getMediaType } from '@renderer/utils/youtubeUtils';

export type MediaEmbedProps = {
  url: string;
};

const MediaEmbedComponent = ({ url }: MediaEmbedProps) => {
  const mediaType = getMediaType(url);
  const isYouTubeProduction = mediaType === 'youtube' && !import.meta.env.DEV;

  const [hasError, setHasError] = useState(false);
  const [playerUrl, setPlayerUrl] = useState<string | null>(null);
  // Initialize loading to true for production YouTube to prevent ReactPlayer from mounting on first render
  const [isLoadingUrl, setIsLoadingUrl] = useState(isYouTubeProduction);

  // Reset states when URL changes, then fetch wrapper URL for YouTube in production.
  // Cleanup guard prevents stale promise results when URL changes rapidly or on unmount.
  useEffect(() => {
    let cancelled = false;

    setHasError(false);
    setPlayerUrl(null);

    if (!isYouTubeProduction) {
      setIsLoadingUrl(false);
      return;
    }

    const youtubeId = extractYouTubeId(url);
    if (!youtubeId) {
      setHasError(true);
      setIsLoadingUrl(false);
      return;
    }

    setIsLoadingUrl(true);
    window.appApi.getTutorialPlayerUrl(youtubeId)
      .then((wrapperUrl) => {
        if (cancelled) return;
        if (wrapperUrl) {
          setPlayerUrl(wrapperUrl);
        } else {
          setHasError(true);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setHasError(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoadingUrl(false);
      });

    return () => { cancelled = true; };
  }, [url, isYouTubeProduction]);

  const handleError = useCallback(() => {
    setHasError(true);
  }, []);

  // Fallback to plain link on error
  if (hasError) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={styles.fallbackLink}
      >
        {url}
      </a>
    );
  }

  // Loading state for YouTube in production
  if (isYouTubeProduction && isLoadingUrl) {
    return (
      <div className={styles.container}>
        <div className={styles.playerWrapper}>
          {/* Lightweight loading placeholder — playerWrapper provides the 16:9 aspect ratio */}
        </div>
      </div>
    );
  }

  // YouTube in production with resolved wrapper URL → iframe
  if (isYouTubeProduction && playerUrl) {
    return (
      <div className={styles.container}>
        <div className={styles.playerWrapper}>
          <iframe
            key={playerUrl}
            src={playerUrl}
            title="YouTube video"
            className={styles.player}
            width="100%"
            height="100%"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            style={{ border: 'none' }}
          />
        </div>
      </div>
    );
  }

  // All other media (and YouTube in dev) → ReactPlayer
  const isAudioOnly = mediaType === 'spotify' || mediaType === 'soundcloud' || mediaType === 'audio';

  return (
    <div className={styles.container}>
      <div className={isAudioOnly ? styles.audioWrapper : styles.playerWrapper}>
        <ReactPlayer
          src={url}
          className={styles.player}
          width="100%"
          height="100%"
          controls
          onError={handleError}
        />
      </div>
    </div>
  );
};

export const MediaEmbed = memo(MediaEmbedComponent);
MediaEmbed.displayName = 'MediaEmbed';
