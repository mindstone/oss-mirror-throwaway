import { useEffect, useState, useCallback, useRef } from 'react';
import { ShieldAlert, X } from 'lucide-react';
import { Button, Tooltip } from './ui';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';
import styles from './DataReadOnlyBanner.module.css';

/**
 * DataReadOnlyBanner — banner shown when the app is running in read-only
 * mode because userData was last written by a newer version.
 *
 * Rendered via the `belowTabs` slot in FlowPanelsShell (same as
 * VersionOutdatedBanner).
 *
 * Uses the same update mechanism as UpdateToastManager:
 * 1. Check for a pending downloaded update (background auto-updater may
 *    have already fetched one) → offer "Install & Relaunch"
 * 2. If nothing pending, trigger a fresh check via the auto-updater
 * 3. If still nothing found, fall back to "Get latest version" which
 *    opens the download page so the user always has a path forward
 *
 * Dismissal is session-scoped (reappears on restart) given the severity
 * of the data-safety condition.
 *
 * @see src/core/userDataWriteGate.ts
 * @see docs/plans/partway/260219_global_store_version_gate.md
 */

const DOWNLOAD_URL = 'https://rebel.mindstone.com';

const isLinuxPlatform = () => {
  if (typeof navigator === 'undefined') return false;
  return (navigator.platform ?? '').toLowerCase().includes('linux');
};

interface ReadOnlyStatus {
  readOnly: boolean;
  reason: string | null;
  newerAppVersion: string | null;
}

type ButtonState =
  | 'idle'
  | 'checking'
  | 'ready-to-install'
  | 'installing'
  | 'downloading'
  | 'get-latest'
  | 'error';

const BUTTON_LABELS: Record<ButtonState, string> = {
  idle: 'Update now',
  checking: 'Checking\u2026',
  'ready-to-install': 'Install & Relaunch',
  installing: 'Installing\u2026',
  downloading: 'Downloading\u2026',
  'get-latest': 'Get latest version',
  error: 'Retry update',
};

const ERROR_REVERT_DELAY_MS = 4000;

export function DataReadOnlyBanner() {
  const [status, setStatus] = useState<ReadOnlyStatus | null>(null);
  const [buttonState, setButtonState] = useState<ButtonState>('idle');
  const [dismissed, setDismissed] = useState(false);
  const revertTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let mounted = true;
    async function check() {
      try {
        const result = await window.versionApi.readOnlyStatus();
        if (!mounted) return;
        setStatus(result);

        if (!result.readOnly) return;

        // If an update is already downloaded (background auto-updater),
        // skip straight to "Install & Relaunch" — same as the update toast.
        try {
          const pending = await window.miscApi.getPendingDownloaded();
          if (mounted && pending?.pending) {
            setButtonState('ready-to-install');
          }
        } catch {
          // Non-critical — will fall back to manual check on click
        }
      } catch (err) {
        console.warn('[DataReadOnlyBanner] Failed to check read-only status:', err);
      }
    }
    void check();
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    return () => { clearTimeout(revertTimer.current); };
  }, []);

  // Listen for background download completing while the banner is visible
  useIpcEvent(window.api.onUpdateDownloaded, () => {
    setButtonState('ready-to-install');
  }, []);

  // Listen for download errors so the `downloading` state doesn't get stuck
  useIpcEvent(window.api.onUpdateError, () => {
    setButtonState((prev) => prev === 'downloading' ? 'get-latest' : prev);
  }, []);

  const handleUpdate = useCallback(async () => {
    clearTimeout(revertTimer.current);
    setButtonState('checking');
    try {
      // First: check if an update was already downloaded in the background
      const pending = await window.miscApi.getPendingDownloaded();
      if (pending?.pending) {
        setButtonState('ready-to-install');
        return;
      }

      // Otherwise: trigger a fresh check via the auto-updater
      const result = await window.miscApi.checkForUpdates();
      if (result.available) {
        setButtonState('downloading');
      } else {
        setButtonState('get-latest');
      }
    } catch {
      setButtonState('error');
      clearTimeout(revertTimer.current);
      revertTimer.current = setTimeout(() => setButtonState('idle'), ERROR_REVERT_DELAY_MS);
    }
  }, []);

  const handleInstall = useCallback(async () => {
    // Linux doesn't support native install-and-relaunch — open download page
    if (isLinuxPlatform()) {
      window.api.openUrl(DOWNLOAD_URL).catch(() => {});
      return;
    }

    setButtonState('installing');
    try {
      const result = await window.api.updateInstallNow();
      if (!result.success) {
        console.error('[DataReadOnlyBanner] Install failed:', result.error);
        setButtonState('ready-to-install');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // When the app is quitting for update, IPC can fail mid-flight — that's fine
      if (
        message.includes('Object has been destroyed') ||
        message.includes('Render frame was disposed') ||
        message.includes('destroyed') ||
        message.includes('closed')
      ) {
        return;
      }
      console.error('[DataReadOnlyBanner] Install failed:', err);
      setButtonState('ready-to-install');
    }
  }, []);

  const handleGetLatest = useCallback(() => {
    window.api.openUrl(DOWNLOAD_URL).catch(() => {
      // Non-critical — URL should still be reachable
    });
  }, []);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  if (!status?.readOnly || dismissed) {
    return null;
  }

  const isDisabled = buttonState === 'checking' || buttonState === 'downloading' || buttonState === 'installing';

  const handleClick =
    buttonState === 'ready-to-install' ? handleInstall
      : buttonState === 'get-latest' ? handleGetLatest
        : handleUpdate;

  return (
    <div className={styles.banner} role="alert" aria-live="assertive">
      <ShieldAlert size={15} aria-hidden="true" className={styles.icon} />
      <span className={styles.text}>
        You've used a newer version of Rebel recently — this version
        can't save changes until you update.
      </span>
      <div className={styles.actions}>
        <Button
          size="sm"
          className={styles.updateButton}
          onClick={handleClick}
          disabled={isDisabled}
        >
          {BUTTON_LABELS[buttonState]}
        </Button>
        <Tooltip content="Dismiss until restart" placement="bottom">
          <Button
            variant="ghost"
            size="sm"
            className={styles.dismissButton}
            onClick={handleDismiss}
            aria-label="Dismiss until restart"
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

DataReadOnlyBanner.displayName = 'DataReadOnlyBanner';
