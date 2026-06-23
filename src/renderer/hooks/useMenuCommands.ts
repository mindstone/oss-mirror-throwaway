/**
 * useMenuCommands - Handles native application menu command events
 *
 * Extracts menu command IPC listeners from App.tsx.
 * Responds to: Settings, Check for Updates, Ask Rebel Help, Show Shortcuts, 
 * Download Diagnostics, Watch Tutorials, Send Feedback
 */

import { useEffect } from 'react';
import type { RendererLogPayload } from '@shared/types';
import type { UpdateManifest } from '@shared/ipc/schemas/misc';
import type { FlowSurface } from '../features/flow-panels/FlowPanelsProvider';
import { compareVersions } from '../features/whats-new/utils/changelogParser';

function getManifestDownloadUrl(manifest: UpdateManifest): string | undefined {
  const platform = window.electronEnv?.platform;
  const arch = window.electronEnv?.arch;
  if (!platform || !arch) return undefined;
  let key: string;
  if (platform === 'darwin') key = `mac-${arch}`;
  else if (platform === 'win32') key = `win-${arch}`;
  else if (platform === 'linux') key = `linux-${arch}`;
  else key = `${platform}-${arch}`;
  return manifest.platforms[key]?.url;
}

interface UseMenuCommandsOptions {
  setActiveSurface: (surface: FlowSurface) => void;
  setShowConversation: (show: boolean) => void;
  setIsTextMode: (isText: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  showToast: (options: { title: string; description?: string; duration?: number; action?: { label: string; onClick: () => void } }) => void;
  emitLog: (log: RendererLogPayload) => void;
  focusComposer: () => void;
  setUpdateAvailable: (
    data:
      | { updateKey: string; version: string; downloadUrl?: string; recoveryAttempts?: number }
      | null,
  ) => void;
  onAskRebel?: () => void;
  onWatchTutorials?: () => void;
  onReportBug?: () => void;
  onStartDemoMode?: () => void;
  onDownloadDiagnostics?: () => void;
}

/**
 * Subscribes to native application menu command events.
 */
export function useMenuCommands({
  setActiveSurface,
  setShowConversation,
  setIsTextMode,
  setShortcutsOpen,
  showToast,
  emitLog,
  focusComposer,
  setUpdateAvailable,
  onAskRebel,
  onWatchTutorials,
  onReportBug,
  onStartDemoMode,
  onDownloadDiagnostics,
}: UseMenuCommandsOptions): void {
  useEffect(() => {
    const unsubscribeSettings = window.api.onMenuOpenSettings(() => {
      setActiveSurface('settings');
    });

    const unsubscribeUpdates = window.api.onMenuCheckForUpdates(async () => {
      try {
        const currentVersion = window.electronEnv?.appVersion || 'unknown';
        showToast({ title: 'Checking for updates...' });

        const autoUpdateResult = await window.miscApi.checkForUpdates();
        if (autoUpdateResult.available) {
          // Check if the update is already downloaded and ready to install.
          // Pass ignoreAck so user-initiated checks always surface a downloaded update
          // even if the toast was previously shown and dismissed this session.
          const pendingResult = await window.miscApi.getPendingDownloaded?.({ ignoreAck: true });
          if (pendingResult?.pending) {
            setUpdateAvailable({
              updateKey: pendingResult.pending.updateKey,
              version: pendingResult.pending.versionLabel,
              downloadUrl: pendingResult.pending.downloadUrl,
              recoveryAttempts: pendingResult.recoveryAttempts ?? 0,
            });
            return;
          }
          const version = autoUpdateResult.version;
          showToast({ 
            title: version ? `Update ${version} found — downloading...` : 'Update found — downloading...',
            description: 'You\'ll be notified when it\'s ready to install.',
            duration: 5000
          });
          return;
        }

        const manifestResult = await window.miscApi.fetchUpdateManifest();
        if (manifestResult.success && manifestResult.manifest) {
          const comparison = compareVersions(currentVersion, manifestResult.manifest.version);
          if (comparison < 0) {
            const downloadUrl = getManifestDownloadUrl(manifestResult.manifest);
            showToast({ 
              title: `Update v${manifestResult.manifest.version} available`,
              description: downloadUrl ? 'Click to download the latest version.' : 'Visit mindstone.ai to download.',
              duration: 15000,
              ...(downloadUrl && {
                action: {
                  label: 'Download',
                  onClick: () => { void window.appApi.openUrl(downloadUrl); },
                },
              }),
            });
            return;
          }
        }

        showToast({ title: 'You are running the latest version.' });
      } catch (error) {
        emitLog({
          level: 'error',
          message: 'Failed to check for updates',
          context: { error: String(error) },
          timestamp: Date.now()
        });
        showToast({ title: 'Failed to check for updates. Please try again later.' });
      }
    });

    const unsubscribeHelp = window.api.onMenuAskRebelHelp(() => {
      if (onAskRebel) {
        // Use the full Ask Rebel handler which starts a new conversation with a prefilled prompt
        onAskRebel();
      } else {
        // Fallback: just open composer without prefilled message
        setActiveSurface('sessions');
        setShowConversation(true);
        setIsTextMode(true);
        setTimeout(() => {
          focusComposer();
        }, 0);
      }
    });

    const unsubscribeShortcuts = window.api.onMenuShowShortcuts(() => {
      setShortcutsOpen(true);
    });

    const unsubscribeTutorials = window.api.onMenuWatchTutorials(() => {
      onWatchTutorials?.();
    });

    const unsubscribeReportBug = window.api.onMenuReportBug(() => {
      onReportBug?.();
    });

    const unsubscribeStartDemoMode = window.api.onMenuStartDemoMode(() => {
      onStartDemoMode?.();
    });

    const unsubscribeDiagnostics = window.api.onMenuDownloadDiagnostics(() => {
      onDownloadDiagnostics?.();
    });

    return () => {
      unsubscribeSettings();
      unsubscribeUpdates();
      unsubscribeHelp();
      unsubscribeShortcuts();
      unsubscribeTutorials();
      unsubscribeReportBug();
      unsubscribeStartDemoMode();
      unsubscribeDiagnostics();
    };
  }, [
    setActiveSurface,
    setShowConversation,
    setIsTextMode,
    setShortcutsOpen,
    showToast,
    emitLog,
    focusComposer,
    setUpdateAvailable,
    onAskRebel,
    onWatchTutorials,
    onReportBug,
    onStartDemoMode,
    onDownloadDiagnostics,
  ]);
}
