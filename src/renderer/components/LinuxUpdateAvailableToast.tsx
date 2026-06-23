import { useCallback, useEffect, useState } from 'react';
import { Button } from './ui';
import styles from './UpdateAvailableToast.module.css';

interface LinuxUpdateAvailableToastProps {
  updateKey: string;
  version: string;
  downloadUrl: string;
  onDownload: () => void;
  onDismiss: () => void;
}

export const LinuxUpdateAvailableToast = ({
  updateKey,
  version,
  downloadUrl,
  onDownload,
  onDismiss
}: LinuxUpdateAvailableToastProps) => {
  const [isExiting, setIsExiting] = useState(false);

  useEffect(() => {
    console.warn('[Update] linux update toast displayed', { updateKey, version, downloadUrl });

    const acknowledge = window.miscApi?.acknowledge;
    if (!acknowledge) {
      return;
    }

    void acknowledge({ updateKey, source: 'toast' }).catch(() => {
      // ignore
    });
  }, [updateKey, version, downloadUrl]);

  const handleDismiss = useCallback(() => {
    setIsExiting(true);
    setTimeout(onDismiss, 200);
  }, [onDismiss]);

  const handleDownload = useCallback(() => {
    onDownload();
    handleDismiss();
  }, [onDownload, handleDismiss]);

  return (
    <div className={`${styles.toast} ${isExiting ? styles.exiting : ''}`}>
      <div className={styles.icon}>
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M10 2L3 7V13L10 18L17 13V7L10 2Z"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M10 8V12"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <path
            d="M7 10L10 7L13 10"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className={styles.content}>
        <div className={styles.title}>Update available</div>
        <div className={styles.description}>
          Version {version} is available for download
        </div>
        <div className={styles.actions}>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDismiss}
          >
            Later
          </Button>
          <Button
            size="sm"
            onClick={handleDownload}
          >
            Download
          </Button>
        </div>
      </div>
      <button
        type="button"
        className={styles.close}
        onClick={handleDismiss}
        aria-label="Dismiss"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 14 14"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
  );
};
