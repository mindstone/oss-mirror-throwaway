import { useCallback, useEffect, useState } from 'react';
import { ArrowUpCircle } from 'lucide-react';
import { Button } from './ui';
import styles from './UpdateAvailableToast.module.css';

const REBEL_MASCOT_URL = 'https://storage.googleapis.com/mindstone-public-assets/rebel/rebel6.svg';

/**
 * Public download page. Used as the fallback for the "Download directly"
 * affordance when a previous silent auto-heal didn't take. Mirrors
 * `_DOWNLOAD_URL` in `versionCheckService.ts` and `DOWNLOAD_URL` in
 * `DataReadOnlyBanner.tsx` — promote to a shared constant if a fourth
 * consumer ever lands.
 */
const DOWNLOAD_PAGE_URL = 'https://rebel.mindstone.com';

interface UpdateAvailableToastProps {
  updateKey: string;
  version: string;
  isInstalling?: boolean;
  /**
   * Number of silent auto-heal attempts already performed for this
   * `updateKey`. When `>= 1`, the toast adapts its copy ("Previous install
   * didn't take") and shows a secondary "Download directly" button. When
   * `0` (default), the toast renders the regular "Update ready" copy.
   *
   * Surfaced from main via `update:get-pending-downloaded`. See
   * docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md.
   */
  recoveryAttempts?: number;
  onInstallNow: () => void;
  onDismiss: () => void;
}

export const UpdateAvailableToast = ({
  updateKey,
  version,
  isInstalling = false,
  recoveryAttempts = 0,
  onInstallNow,
  onDismiss
}: UpdateAvailableToastProps) => {
  const [isExiting, setIsExiting] = useState(false);
  const [mascotFailed, setMascotFailed] = useState(false);
  const [downloadOpenError, setDownloadOpenError] = useState<string | null>(null);

  const handleDismiss = useCallback(() => {
    console.warn('[Update] toast dismissed', { version });
    setIsExiting(true);
    setTimeout(onDismiss, 200);
  }, [onDismiss, version]);

  const handleInstallNow = useCallback(() => {
    console.warn('[Update] install now clicked', { version });
    onInstallNow();
  }, [onInstallNow, version]);

  const handleDownloadDirectly = useCallback(() => {
    console.warn('[Update] download directly clicked', { version });
    setDownloadOpenError(null);
    const opener = window.api?.openUrl;
    if (!opener) {
      setDownloadOpenError(
        `Couldn't open the download page. Visit ${DOWNLOAD_PAGE_URL} in your browser.`,
      );
      return;
    }
    opener(DOWNLOAD_PAGE_URL).catch((err: unknown) => {
      console.warn('[Update] openUrl failed', err);
      setDownloadOpenError(
        `Couldn't open the download page. Visit ${DOWNLOAD_PAGE_URL} in your browser.`,
      );
    });
  }, [version]);

  useEffect(() => {
    console.warn('[Update] toast displayed', { updateKey, version, recoveryAttempts });

    // Acknowledge that the toast was displayed (best-effort).
    // Prefer the updateKey-aware channel; fall back to legacy ack when unavailable.
    void (async () => {
      try {
        const acknowledge = window.miscApi?.acknowledge;
        if (acknowledge) {
          await acknowledge({ updateKey, source: 'toast' });
          return;
        }
      } catch {
        // fall back
      }

      window.api?.updateAcknowledgeToast?.().catch(() => {
        // ignore
      });
    })();
  }, [updateKey, version, recoveryAttempts]);

  // Adapted copy when a silent auto-heal already fired. Dry, terse,
  // informative — matches Rebel's brand voice.
  const inRecoveryMode = recoveryAttempts >= 1;
  const title = inRecoveryMode ? "That update didn't take" : 'Update ready';
  const description = inRecoveryMode
    ? `We cleared the updater cache. Try once more, or download v${version} directly.`
    : `Version ${version} is ready to install`;

  return (
    <div className={`${styles.toast} ${isExiting ? styles.exiting : ''}`}>
      <div className={styles.icon}>
        {!mascotFailed ? (
          <img
            src={REBEL_MASCOT_URL}
            alt=""
            className={styles.mascot}
            onError={() => setMascotFailed(true)}
          />
        ) : (
          <ArrowUpCircle size={14} aria-hidden />
        )}
      </div>
      <div className={styles.content}>
        <div className={styles.title}>{title}</div>
        <div className={styles.description}>{description}</div>
        {downloadOpenError != null && (
          <div className={styles.description} role="status" aria-live="polite">
            {downloadOpenError}
          </div>
        )}
        <div className={styles.actions}>
          {inRecoveryMode ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDownloadDirectly}
              disabled={isInstalling}
            >
              Download directly
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              disabled={isInstalling}
            >
              On Next Launch
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleInstallNow}
            disabled={isInstalling}
          >
            {isInstalling ? 'Installing...' : 'Install & Relaunch'}
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
