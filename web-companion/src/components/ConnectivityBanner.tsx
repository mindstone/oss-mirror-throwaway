import { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '@rebel/cloud-client';
import styles from './ConnectivityBanner.module.css';

const INITIAL_SUPPRESSION_MS = 3_000;

interface ConnectivityBannerProps {
  isOnline: boolean;
}

interface BannerContent {
  label: string;
  tone: 'warning' | 'error';
  isReconnecting: boolean;
}

export function ConnectivityBanner({ isOnline }: ConnectivityBannerProps) {
  const connectionState = useSessionStore((state) => state.connectionState);
  const [isSuppressed, setIsSuppressed] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsSuppressed(false);
    }, INITIAL_SUPPRESSION_MS);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  const bannerContent = useMemo<BannerContent | null>(() => {
    if (!isOnline) {
      return {
        label: 'No internet connection',
        tone: 'error',
        isReconnecting: false,
      };
    }

    if (connectionState === 'reconnecting') {
      return {
        label: 'Reconnecting to Rebel...',
        tone: 'warning',
        isReconnecting: true,
      };
    }

    if (connectionState === 'disconnected') {
      return {
        label: 'Disconnected from Rebel',
        tone: 'error',
        isReconnecting: false,
      };
    }

    return null;
  }, [connectionState, isOnline]);

  const isVisible = !isSuppressed && bannerContent !== null;

  return (
    <div
      className={`${styles.container} ${isVisible ? styles.visible : styles.hidden}`}
      aria-hidden={!isVisible}
    >
      {bannerContent && (
        <div
          className={`${styles.banner} ${
            bannerContent.tone === 'warning' ? styles.warning : styles.error
          }`}
          role="status"
          aria-live="polite"
        >
          <span
            className={`${styles.dot} ${bannerContent.isReconnecting ? styles.dotPulsing : ''}`}
            aria-hidden="true"
          />
          <span className={styles.label}>{bannerContent.label}</span>
        </div>
      )}
    </div>
  );
}
