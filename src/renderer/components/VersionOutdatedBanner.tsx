import { useEffect, useState, useCallback } from 'react';
import { X, Info } from 'lucide-react';
import { useSettings } from '../features/settings/SettingsProvider';
import { Button, Tooltip } from './ui';
import styles from './VersionOutdatedBanner.module.css';

/**
 * VersionOutdatedBanner — inline banner below the tab navigation.
 *
 * Shown when user is 2+ minor versions behind. Focuses on the positive
 * — what the newer version offers — rather than badmouthing the current one.
 * Uses the brand indigo/lilac palette for visual consistency.
 *
 * "Update now" triggers the native auto-updater (same as menu "Check for
 * Updates"). On success, the UpdateToastManager handles the "restart to
 * install" flow.
 *
 * Dismissal:
 * - X button: dismiss for DISMISS_DAYS (3 days), stored in localStorage
 * - Version-keyed: when a newer version is released, the timer resets
 *
 * @see src/main/services/versionCheckService.ts
 * @see src/renderer/components/UpdateToastManager.tsx
 */

const DISMISS_DAYS = 3;
const DISMISS_KEY_PREFIX = 'version-outdated-dismissed-';

interface VersionInfo {
  currentVersion: string;
  latestVersion: string;
}

function isDismissedRecently(latestVersion: string): boolean {
  try {
    const raw = localStorage.getItem(`${DISMISS_KEY_PREFIX}${latestVersion}`);
    if (!raw) return false;
    const until = parseInt(raw, 10);
    return !isNaN(until) && Date.now() < until;
  } catch {
    return false;
  }
}

function dismissForDays(latestVersion: string): void {
  try {
    const until = Date.now() + DISMISS_DAYS * 24 * 60 * 60 * 1000;
    localStorage.setItem(`${DISMISS_KEY_PREFIX}${latestVersion}`, String(until));
  } catch {
    // Non-critical
  }
}

export function VersionOutdatedBanner() {
  const { settings } = useSettings();
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function checkVersion() {
      try {
        // If DataReadOnlyBanner is active, don't show this banner — it's
        // redundant (read-only mode already implies we're behind) and the
        // DataReadOnlyBanner handles the update flow with better UX.
        const readOnly = await window.versionApi.readOnlyStatus();
        if (!mounted) return;
        if (readOnly.readOnly) {
          setDismissed(true);
          return;
        }

        const result = await window.versionApi.check();
        if (!mounted) return;
        if (result.isOutdated && result.latestVersion) {
          if (isDismissedRecently(result.latestVersion)) {
            setDismissed(true);
            return;
          }
          setVersionInfo({
            currentVersion: result.currentVersion,
            latestVersion: result.latestVersion,
          });
        }
      } catch {
        // Fail silently — version check is non-critical
      }
    }

    void checkVersion();
    return () => { mounted = false; };
  }, []);

  const handleUpdate = useCallback(async () => {
    setUpdating(true);
    try {
      await window.miscApi.checkForUpdates();
      // Auto-updater will download if available;
      // UpdateToastManager handles the "restart to update" flow.
    } catch {
      // Auto-updater failed — non-critical
    } finally {
      setUpdating(false);
      setDismissed(true);
    }
  }, []);

  const handleDismiss = useCallback(() => {
    if (versionInfo) {
      dismissForDays(versionInfo.latestVersion);
    }
    setDismissed(true);
  }, [versionInfo]);

  if (settings === null || !versionInfo || dismissed) {
    return null;
  }

  return (
    <div className={styles.banner} role="status" aria-live="polite">
      <Info size={15} aria-hidden="true" className={styles.icon} />
      <span className={styles.text}>
        You're a few versions behind — updating brings noticeable speed and
        reliability improvements.
        <span className={styles.versionTag}>(v{versionInfo.latestVersion})</span>
      </span>
      <div className={styles.actions}>
        <Button
          size="sm"
          className={styles.updateButton}
          onClick={handleUpdate}
          disabled={updating}
        >
          {updating ? 'Checking\u2026' : 'Update now'}
        </Button>
        <Tooltip content={`Dismiss for ${DISMISS_DAYS} days`} placement="bottom">
          <Button
            variant="ghost"
            size="sm"
            className={styles.dismissButton}
            onClick={handleDismiss}
            aria-label={`Dismiss for ${DISMISS_DAYS} days`}
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

VersionOutdatedBanner.displayName = 'VersionOutdatedBanner';
