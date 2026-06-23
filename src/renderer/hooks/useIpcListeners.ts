/**
 * useIpcListeners - Consolidated IPC event subscriptions for App.tsx
 *
 * Extracts IPC listener effects from App.tsx to reduce component complexity.
 * Each listener is isolated and can be individually tested.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { RendererLogPayload } from '@shared/types';
import { useSessionConflictStore } from '@renderer/features/agent-session/store/sessionConflictStore';
import { useSessionStore } from '@renderer/features/agent-session/store/sessionStore';
import { useFolderStore } from '@renderer/features/agent-session/store/folderStore';
import { shouldRefreshTimeSavedBySessionStatus } from '@renderer/utils/timeSavedStatusRouting';

const UPDATE_PERMISSION_ERROR_DESCRIPTION =
  "Rebel can't update itself because it was installed somewhere your account can't modify. Ask IT to update Rebel for this device, or reinstall it somewhere your organization allows.";

interface UseIpcListenersOptions {
  emitLog: (log: RendererLogPayload) => void;
  showToast: (message: {
    title: string;
    description?: string;
    duration?: number;
    action?: { label: string; onClick: () => void };
  }) => void;
  refreshLibraryIndex: () => Promise<void>;
  refreshMcpSummary: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  setTimeSavedBySession: (data: Record<string, number>) => void;
  setCoachingSessionIds: (data: Set<string>) => void;
  setUpdateAvailable: (
    data:
      | { updateKey: string; version: string; downloadUrl?: string; recoveryAttempts?: number }
      | null,
  ) => void;
  setIsInstallingUpdate: (isInstalling: boolean) => void;
  setSuperMcpReady?: (ready: boolean) => void;
  reloadSessionSummaries?: () => Promise<void>;
  refreshActiveCloudSession?: (sessionId: string) => Promise<void>;
  onWorkspaceConflictsDetected?: (paths: string[]) => void;
  openWorkspaceConflictDialog?: () => void;
}

export interface UseIpcListenersReturn {
  /** Reset the update dedup ref so a previously dismissed toast can re-appear. */
  resetUpdateDedup: () => void;
}

/**
 * Subscribes to various IPC events from the main process.
 * Consolidates 7 useEffect hooks from App.tsx.
 */
export function useIpcListeners({
  emitLog,
  showToast,
  refreshLibraryIndex,
  refreshMcpSummary,
  refreshSettings,
  setTimeSavedBySession,
  setCoachingSessionIds,
  setUpdateAvailable,
  setIsInstallingUpdate,
  setSuperMcpReady,
  reloadSessionSummaries,
  refreshActiveCloudSession,
  onWorkspaceConflictsDetected,
  openWorkspaceConflictDialog,
}: UseIpcListenersOptions): UseIpcListenersReturn {
  const superMcpStartupFailureSurfacedRef = useRef(false);

  // Fetch time saved by session + subscribe to updates
  useEffect(() => {
    const fetchTimeSavedBySession = async () => {
      try {
        const data = await window.api.getTimeSavedBySession();
        setTimeSavedBySession(data);
      } catch (error) {
        console.error('Failed to fetch time saved by session:', error);
      }
    };

    fetchTimeSavedBySession();

    const cleanup = window.api.onTimeSavedStatus((status) => {
      const activeSessionId = useSessionStore.getState().currentSessionId;
      if (!shouldRefreshTimeSavedBySessionStatus(status, activeSessionId)) {
        return;
      }
      fetchTimeSavedBySession();
    });

    return cleanup;
  }, [setTimeSavedBySession]);

  // Fetch coaching sessions + subscribe to updates
  useEffect(() => {
    const fetchCoachingSessions = async () => {
      try {
        const data = await window.api.getCoachingSessions();
        console.warn('[Coaching] Fetched sessions with coaching:', data.sessionIds);
        setCoachingSessionIds(new Set(data.sessionIds));
      } catch (error) {
        console.error('Failed to fetch coaching sessions:', error);
      }
    };

    fetchCoachingSessions();

    const cleanup = window.api.onCoachingReflection(() => {
      console.warn('[Coaching] Received coaching reflection event, refetching...');
      fetchCoachingSessions();
    });

    return cleanup;
  }, [setCoachingSessionIds]);

  // Force workspace refresh when demo mode changes
  useEffect(() => {
    const unsubscribe = window.api.onDemoModeChange(() => {
      setTimeout(() => {
        void refreshLibraryIndex();
        void refreshMcpSummary();
      }, 100);
    });
    return () => unsubscribe();
  }, [refreshLibraryIndex, refreshMcpSummary]);

  // Auto-refresh workspace index when files change (tree structure only).
  // Content-only edits don't change the file list used for mentions/search.
  //
  // Adaptive cooldown: when a refresh walk is slow (cloud-storage symlinks
  // re-syncing, large workspaces, libuv saturation), give the user at least
  // `last walk's duration` of usable library between walks. Auto-recovers when
  // walks become fast again. Without this cap, sustained watcher activity (e.g.
  // Google Drive re-sync emitting thousands of FSEvents) keeps the Library tab
  // permanently in a loading state because each walk finishes only to be
  // immediately re-triggered by another `library:changed` event.
  const LIBRARY_REFRESH_BASE_DELAY_MS = 500;
  const LIBRARY_REFRESH_MAX_COOLDOWN_MS = 60_000;
  const libraryRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const libraryLastRefreshEndRef = useRef(0);
  const libraryLastRefreshDurationRef = useRef(0);
  const libraryRefreshInFlightRef = useRef(false);
  useEffect(() => {
    const performRefresh = async () => {
      libraryRefreshInFlightRef.current = true;
      const started = Date.now();
      try {
        await refreshLibraryIndex();
      } finally {
        libraryLastRefreshEndRef.current = Date.now();
        libraryLastRefreshDurationRef.current =
          libraryLastRefreshEndRef.current - started;
        libraryRefreshInFlightRef.current = false;
      }
    };

    const unsubscribe = window.api.onLibraryChanged(({ affectsTree }) => {
      if (!affectsTree) return;
      if (libraryRefreshTimerRef.current) {
        clearTimeout(libraryRefreshTimerRef.current);
      }
      const cooldown = Math.min(
        LIBRARY_REFRESH_MAX_COOLDOWN_MS,
        Math.max(LIBRARY_REFRESH_BASE_DELAY_MS, libraryLastRefreshDurationRef.current),
      );
      const sinceEnd = Date.now() - libraryLastRefreshEndRef.current;
      const delay = Math.max(LIBRARY_REFRESH_BASE_DELAY_MS, cooldown - sinceEnd);
      libraryRefreshTimerRef.current = setTimeout(() => {
        libraryRefreshTimerRef.current = null;
        if (libraryRefreshInFlightRef.current) return;
        void performRefresh();
      }, delay);
    });
    return () => {
      unsubscribe();
      if (libraryRefreshTimerRef.current) {
        clearTimeout(libraryRefreshTimerRef.current);
      }
    };
  }, [refreshLibraryIndex]);

  // Track the last updateKey we've applied (avoids showing twice for push+pull).
  // Reset via resetUpdateDedup() when the toast is dismissed so it can re-appear.
  const lastAppliedUpdateKeyRef = useRef<string | null>(null);

  const resetUpdateDedup = useCallback(() => {
    lastAppliedUpdateKeyRef.current = null;
  }, []);

  // Listen for update downloaded notifications + pull pending state on startup
  useEffect(() => {
    const applyUpdateAvailable = (payload: {
      updateKey: string;
      version: string;
      downloadUrl?: string;
      recoveryAttempts?: number;
    }) => {
      if (!payload?.updateKey) {
        return;
      }

      if (lastAppliedUpdateKeyRef.current === payload.updateKey) {
        return;
      }

      lastAppliedUpdateKeyRef.current = payload.updateKey;
      setUpdateAvailable({
        updateKey: payload.updateKey,
        version: payload.version,
        downloadUrl: payload.downloadUrl,
        recoveryAttempts: payload.recoveryAttempts,
      });
    };

    const unsubscribe = window.api.onUpdateDownloaded((data) => {
      emitLog({
        level: 'info',
        message: 'Update downloaded received',
        context: {
          updateKey: data.updateKey,
          version: data.version,
          downloadUrl: data.downloadUrl,
          recoveryAttempts: data.recoveryAttempts,
          rendererAppVersion: window.electronEnv?.appVersion,
        },
        timestamp: Date.now(),
      });
      // REBEL-53B: the push payload now carries `recoveryAttempts` (read
      // from the persistent state store on the main side) so a push-first
      // sequence still surfaces the recovery copy. The pull path
      // (mount-time `getPendingDownloaded`) is identical, so the dedup
      // ref below safely short-circuits later updates for the same key.
      applyUpdateAvailable({
        updateKey: data.updateKey,
        version: data.version,
        downloadUrl: data.downloadUrl,
        recoveryAttempts: data.recoveryAttempts ?? 0,
      });
    });

    const pendingPromise = window.miscApi?.getPendingDownloaded?.();
    if (pendingPromise) {
      void pendingPromise
        .then((result) => {
          if (result?.pending) {
            applyUpdateAvailable({
              updateKey: result.pending.updateKey,
              version: result.pending.versionLabel,
              downloadUrl: result.pending.downloadUrl,
              recoveryAttempts: result.recoveryAttempts ?? 0,
            });
          }
        })
        .catch(() => {
          // ignore
        });
    }

    return () => unsubscribe();
  }, [emitLog, setUpdateAvailable]);

  // Listen for update install failures (used when main defers quitAndInstall and it fails after IPC resolves)
  useEffect(() => {
    const unsubscribe = window.api.onUpdateInstallFailed?.((data) => {
      emitLog({
        level: 'error',
        message: 'Update install failed',
        context: { updateKey: data.updateKey, error: data.error },
        timestamp: Date.now(),
      });
      setIsInstallingUpdate(false);
      showToast({ title: "Couldn't install the update", description: data.error ?? 'Try again.' });
    });
    return () => unsubscribe?.();
  }, [emitLog, setIsInstallingUpdate, showToast]);

  // Listen for Super-MCP startup notifications (success and failure)
  // On either event, refresh MCP summary to update UI state
  useEffect(() => {
    const unsubscribeSuccess = window.api.onSuperMcpStartupSucceeded((data) => {
      emitLog({
        level: 'info',
        message: 'Super-MCP startup succeeded',
        context: { port: data.port, attempts: data.attempts, skippedServers: data.skippedServers },
        timestamp: Date.now()
      });
      
      // Mark Super-MCP as ready for prompt cache warming
      setSuperMcpReady?.(true);
      
      // Notify user if any MCP servers were skipped due to config issues
      if (data.skippedServers && data.skippedServers.length > 0) {
        const count = data.skippedServers.length;
        const toolWord = count === 1 ? 'tool' : 'tools';
        showToast({ title: `${count} ${toolWord} couldn't load due to configuration issues. Check Settings → Advanced.` });
      }
      
      // Refresh MCP summary to update tools availability in UI
      void refreshMcpSummary();
    });

    const unsubscribeFailed = window.api.onSuperMcpStartupFailed((data) => {
      emitLog({
        level: 'error',
        message: 'Super-MCP startup failed',
        context: { failureCategory: data.failureCategory, attempts: data.attempts },
        timestamp: Date.now()
      });
      // Mark Super-MCP as not ready
      setSuperMcpReady?.(false);
      superMcpStartupFailureSurfacedRef.current = true;
      showToast({ title: 'Tools server failed to start. Try restarting the app or check Diagnostics in Settings.' });
      // Refresh MCP summary to update tools availability in UI
      void refreshMcpSummary();
    });

    const unsubscribeReady = window.api.onSuperMcpReady((data) => {
      emitLog({
        level: data.success ? 'info' : 'warn',
        message: data.success ? 'Super-MCP ready' : 'Super-MCP unavailable',
        context: data,
        timestamp: Date.now(),
      });

      if (!data.success) {
        setSuperMcpReady?.(false);
        return;
      }

      setSuperMcpReady?.(true);

      if (data.recovered) {
        void refreshMcpSummary();
        if (superMcpStartupFailureSurfacedRef.current) {
          superMcpStartupFailureSurfacedRef.current = false;
          showToast({ title: 'Tools are back online.' });
        }
      }
    });

    return () => {
      unsubscribeSuccess();
      unsubscribeFailed();
      unsubscribeReady();
    };
  }, [emitLog, showToast, refreshMcpSummary, setSuperMcpReady]);

  useEffect(() => {
    const unsubscribe = window.api.onCatalogOverrideWarning?.((data) => {
      emitLog({
        level: 'warn',
        message: 'Catalog override rejected at startup',
        context: { banner: data.message },
        timestamp: Date.now(),
      });
      const description = data.message.startsWith('Catalog override rejected: ')
        ? data.message.slice('Catalog override rejected: '.length)
        : data.message;
      showToast({
        title: 'Catalog override rejected',
        description,
      });
    });
    return () => unsubscribe?.();
  }, [emitLog, showToast]);

  // Listen for use cases ready notifications (background generation completed)
  useEffect(() => {
    const unsubscribe = window.api.onUseCasesReady((data) => {
      emitLog({
        level: 'info',
        message: 'Use cases generated in background',
        context: { count: data.count, userFirstName: data.userFirstName },
        timestamp: Date.now()
      });
      showToast({ title: `${data.count} personalized use cases are ready!` });
      void refreshSettings();
    });
    return () => unsubscribe();
  }, [emitLog, showToast, refreshSettings]);

  // Track if we've shown the update error this session (avoid spam)
  const hasShownUpdateErrorRef = useRef(false);

  // Listen for update error notifications (e.g., network issues, update server errors)
  useEffect(() => {
    const unsubscribe = window.api.onUpdateError?.((data) => {
      // Only show once per session to avoid spam on repeated update check failures
      if (hasShownUpdateErrorRef.current) {
        return;
      }
      hasShownUpdateErrorRef.current = true;

      emitLog({
        level: 'warn',
        message: 'Auto-update error',
        context: { code: data.code, category: data.category, message: data.message },
        timestamp: Date.now()
      });
      showToast({
        title: 'Auto-updates unavailable',
        description: data.category === 'permission'
          ? UPDATE_PERMISSION_ERROR_DESCRIPTION
          : data.message,
        duration: 10000
      });
    });
    return () => unsubscribe?.();
  }, [emitLog, showToast]);

  // Listen for physical recording analysis events (Limitless/Plaud)
  useEffect(() => {
    const unsubscribeComplete = window.api.onPhysicalRecordingAnalysisComplete?.((data) => {
      showToast({ title: 'Recording analyzed', description: data.title });
    });
    const unsubscribeFailed = window.api.onPhysicalRecordingAnalysisFailed?.((data) => {
      showToast({ title: 'Recording analysis failed', description: data.title });
    });
    return () => {
      unsubscribeComplete?.();
      unsubscribeFailed?.();
    };
  }, [showToast]);

  // Listen for system resource warnings (ENFILE exhaustion)
  useEffect(() => {
    const unsubscribe = window.api.onSystemResourceWarning?.((data) => {
      if (data.type === 'enfile') {
        showToast({
          title: 'Search temporarily limited',
          description: data.message,
          duration: 10000
        });
      }
    });
    return () => unsubscribe?.();
  }, [showToast]);

  // Listen for cloud session sync events (sessions upserted/deleted from another device)
  useEffect(() => {
    if (!reloadSessionSummaries) return;

    const cleanup = window.cloudApi?.onSessionsSynced((data) => {
      // Guard: skip reload if both arrays are empty (no-op event)
      if (data.upserted.length === 0 && data.deleted.length === 0) return;

      for (const deletedSessionId of data.deleted) {
        useSessionConflictStore.getState().clearConflict(deletedSessionId);
      }

      emitLog({
        level: 'info',
        message: 'Cloud sessions synced, reloading summaries',
        context: { upserted: data.upserted.length, deleted: data.deleted.length },
        timestamp: Date.now(),
      });

      void reloadSessionSummaries();

      // Refresh the actively-viewed session's full content too — sidebar
      // summaries don't include messages/eventsByTurn, so without this the
      // open transcript stays pinned to its last in-memory snapshot even
      // after the main process merged cloud changes to disk. See
      // docs-private/investigations/260518_cloud_merged_session_not_refreshed_in_active_view.md.
      if (refreshActiveCloudSession && data.upserted.length > 0) {
        const activeSessionId = useSessionStore.getState().currentSessionId;
        if (activeSessionId && data.upserted.includes(activeSessionId)) {
          void refreshActiveCloudSession(activeSessionId);
        }
      }
    });

    return () => cleanup?.();
  }, [emitLog, reloadSessionSummaries, refreshActiveCloudSession]);

  // A1: folders restored from cloud (first-connect pull). The main process
  // wrote folders.json + primed the FolderStore cache, but the renderer's
  // Zustand folder store only loads once at App mount — without this re-load
  // the sidebar stays empty until restart (the original user-visible symptom).
  // Re-run loadFolders so the sidebar reflects the restore immediately.
  useEffect(() => {
    const cleanup = window.cloudApi?.onFoldersRestored?.(() => {
      emitLog({
        level: 'info',
        message: 'Cloud folders restored, reloading folder store',
        timestamp: Date.now(),
      });
      void useFolderStore.getState().loadFolders();
    });
    return () => cleanup?.();
  }, [emitLog]);

  const latestWorkspaceConflictPathsRef = useRef<string[]>([]);
  const toastedConflictKeysRef = useRef<Set<string>>(new Set());

  // Listen for workspace file conflicts (both desktop and cloud edited the same file)
  useEffect(() => {
    const cleanup = window.cloudApi?.onWorkspaceConflicts?.((data) => {
      if (!data.paths?.length) return;

      const newPaths = data.paths.filter((p: string) => !toastedConflictKeysRef.current.has(p));

      latestWorkspaceConflictPathsRef.current = [
        ...new Set([...latestWorkspaceConflictPathsRef.current, ...data.paths]),
      ];
      onWorkspaceConflictsDetected?.(latestWorkspaceConflictPathsRef.current);

      if (newPaths.length === 0) return;
      for (const p of newPaths) toastedConflictKeysRef.current.add(p);

      const count = latestWorkspaceConflictPathsRef.current.length;
      showToast({
        title: 'Files changed in more than one place.',
        description:
          count === 1
            ? 'Review the conflict to choose which version to keep.'
            : `Review ${count} conflicts to choose which versions to keep.`,
        duration: 10000,
        action: {
          label: 'Review conflicts',
          onClick: () => {
            onWorkspaceConflictsDetected?.(latestWorkspaceConflictPathsRef.current);
            openWorkspaceConflictDialog?.();
          },
        },
      });
    });
    return () => cleanup?.();
  }, [onWorkspaceConflictsDetected, openWorkspaceConflictDialog, showToast]);

  // Listen for pending cloud updates (a newer version of an OS-synced file lives
  // only in Rebel's cloud — edited on phone/web). Distinct, CALMER signal than a
  // conflict: no alarm copy, "Update" framing, one place to act. REBEL-696 Stage 5.
  const toastedPendingUpdateKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const cleanup = window.cloudApi?.onWorkspacePendingUpdates?.((data) => {
      const paths = data?.paths ?? [];
      // Empty set = everything delivered/cleared; reset dedup so a future update
      // re-toasts, and don't pop a toast for "nothing".
      if (paths.length === 0) {
        toastedPendingUpdateKeysRef.current = new Set();
        return;
      }

      const newPaths = paths.filter((p) => !toastedPendingUpdateKeysRef.current.has(p));
      if (newPaths.length === 0) return;
      for (const p of newPaths) toastedPendingUpdateKeysRef.current.add(p);

      showToast({
        title: paths.length === 1 ? 'A newer version is ready' : `${paths.length} files have newer versions ready`,
        description: 'A newer version is available from your synced workspace.',
        duration: 10000,
        action: {
          label: 'Review',
          onClick: () => {
            openWorkspaceConflictDialog?.();
          },
        },
      });
    });
    return () => cleanup?.();
  }, [openWorkspaceConflictDialog, showToast]);

  // Listen for cloud session conflict signals and store per-session badge state.
  useEffect(() => {
    const cleanup = window.cloudApi?.onSessionConflict?.((data) => {
      if (!data?.sessionId) return;
      if (data.conflictType !== 'stale-metadata' && data.conflictType !== 'concurrent-edit') return;
      useSessionConflictStore.getState().markConflict({
        sessionId: data.sessionId,
        conflictType: data.conflictType,
        fields: data.fields,
        detectedAt: data.detectedAt,
      });
    });
    return () => cleanup?.();
  }, []);

  return { resetUpdateDedup };
}
