/**
 * UpdateToastManager
 *
 * Owns the update-available / install-in-progress state and renders the
 * appropriate toast (`UpdateAvailableToast` or `LinuxUpdateAvailableToast`).
 *
 * Post-REBEL-53B: the bespoke `StuckInstallRecoveryDialog` was removed and
 * replaced with adapted copy in `UpdateAvailableToast` driven by the
 * `recoveryAttempts` counter surfaced through `update:get-pending-downloaded`.
 * See docs-private/investigations/260429_rebel_53b_stuck_install_false_positive.md.
 */

import { forwardRef, memo, useCallback, useImperativeHandle, useState } from 'react';
import type { ToastMessage } from '@renderer/contexts';
import { UpdateAvailableToast } from './UpdateAvailableToast';
import { LinuxUpdateAvailableToast } from './LinuxUpdateAvailableToast';

// ─── Platform helper (module-level, no side effects) ────────────────────────
const isLinuxPlatform = () => {
  if (typeof navigator === 'undefined') return false;
  const platform = (navigator.platform ?? '').toLowerCase();
  return platform.includes('linux');
};

// ─── Public types ───────────────────────────────────────────────────────────
export type UpdateAvailableData =
  | {
      updateKey: string;
      version: string;
      downloadUrl?: string;
      /**
       * Number of silent auto-heal attempts already performed for this
       * `updateKey`. When `>= 1`, the toast adapts its copy and shows a
       * "Download directly" affordance.
       */
      recoveryAttempts?: number;
    }
  | null;

export interface UpdateToastManagerRef {
  setUpdateAvailable: (data: UpdateAvailableData) => void;
  setIsInstallingUpdate: (isInstalling: boolean) => void;
}

export interface UpdateToastManagerProps {
  showToast: (message: ToastMessage) => void;
  onDismiss?: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────
const UpdateToastManagerInner = forwardRef<UpdateToastManagerRef, UpdateToastManagerProps>(
  function UpdateToastManager({ showToast, onDismiss }, ref) {
    const [updateAvailable, setUpdateAvailable] = useState<UpdateAvailableData>(null);
    const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);

    // Expose setters so App.tsx can pass them to useIpcListeners
    useImperativeHandle(ref, () => ({
      setUpdateAvailable,
      setIsInstallingUpdate,
    }), []);

    const handleInstallNow = useCallback(async () => {
      setIsInstallingUpdate(true);
      try {
        const result = await window.api.updateInstallNow();
        if (!result.success) {
          setIsInstallingUpdate(false);
          showToast({ title: "Couldn't install the update", description: result.error });
          console.error('Failed to install update:', result.error);
        }
        // If success, app is quitting - no need to update state
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // When the app is quitting for an update, the IPC invoke can fail mid-flight.
        // Treat common teardown errors as success (the process is exiting).
        if (
          message.includes('Object has been destroyed') ||
          message.includes('Render frame was disposed') ||
          message.includes('destroyed') ||
          message.includes('closed')
        ) {
          return;
        }
        setIsInstallingUpdate(false);
        showToast({ title: "Couldn't install the update" });
        console.error('Failed to install update:', err);
      }
    }, [showToast]);

    const handleDismiss = useCallback(() => {
      setUpdateAvailable(null);
      onDismiss?.();
    }, [onDismiss]);

    if (!updateAvailable) return null;

    if (isLinuxPlatform() && updateAvailable.downloadUrl) {
      const downloadUrl = updateAvailable.downloadUrl;
      return (
        <LinuxUpdateAvailableToast
          updateKey={updateAvailable.updateKey}
          version={updateAvailable.version}
          downloadUrl={downloadUrl}
          onDownload={() => {
            window.api.openUrl(downloadUrl).catch((err) => {
              showToast({ title: "Couldn't open that download link" });
              console.error('Failed to open download link:', err);
            });
          }}
          onDismiss={handleDismiss}
        />
      );
    }

    return (
      <UpdateAvailableToast
        updateKey={updateAvailable.updateKey}
        version={updateAvailable.version}
        isInstalling={isInstallingUpdate}
        recoveryAttempts={updateAvailable.recoveryAttempts ?? 0}
        onInstallNow={handleInstallNow}
        onDismiss={handleDismiss}
      />
    );
  },
);

export const UpdateToastManager = memo(UpdateToastManagerInner);
