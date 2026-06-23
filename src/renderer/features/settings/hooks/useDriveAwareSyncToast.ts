import { useEffect, useRef } from 'react';
import { useToast } from '@renderer/components/ui/Toast';

export const DRIVE_AWARE_SYNC_TOAST_TITLE = 'Drive is handling this workspace';
export const DRIVE_AWARE_SYNC_TOAST_BODY = 'This workspace is in Google Drive and Rebel is open on more than one computer. Rebel will let Drive deliver new workspace folders so it doesn\'t create duplicate "(1)" copies. Cloud continuity stays on for phone and browser. Less folder archaeology.';
export const DRIVE_AWARE_SYNC_HELP_URL = 'rebel://library/rebel-system%2Fhelp-for-humans%2Fgoogle-drive-desktop-local-sync.md';

export function useDriveAwareSyncToast(): void {
  const { showToast } = useToast();
  const shownWorkspaceFingerprintsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const unsubscribe = window.api.onDriveAwareSyncDeferred?.((payload) => {
      const workspaceFingerprint = payload.workspaceFingerprint?.trim();
      if (!workspaceFingerprint) return;
      if (shownWorkspaceFingerprintsRef.current.has(workspaceFingerprint)) return;
      shownWorkspaceFingerprintsRef.current.add(workspaceFingerprint);

      showToast({
        title: DRIVE_AWARE_SYNC_TOAST_TITLE,
        description: DRIVE_AWARE_SYNC_TOAST_BODY,
        duration: Infinity,
        action: {
          label: 'Learn more',
          onClick: () => {
            void window.api.openUrl(DRIVE_AWARE_SYNC_HELP_URL);
          },
        },
      });
    });

    return () => {
      unsubscribe?.();
    };
  }, [showToast]);
}
