import { useCallback, useEffect, useRef, useState } from 'react';
import { useOnlineStatus } from '@renderer/hooks/useOnlineStatus';
import { getSessionStoreState } from '@renderer/features/agent-session/store';
import type { VoiceErrorCategory } from '@shared/types';

// Re-export for existing consumers (barrel in voice/index.ts, tests, PendingAudioPopover)
export type { VoiceErrorCategory } from '@shared/types';

const INITIAL_BACKOFF_MS = 60_000; // Start auto-retry at 60s
const MAX_BACKOFF_MS = 600_000; // Cap at 10min
const MIN_RETRY_GAP_MS = 10_000; // Don't batch-retry more than once per 10s

// Error categories that indicate permanent failures requiring user action (REBEL-ZJ)
const PERMANENT_ERROR_CATEGORIES: Set<VoiceErrorCategory> = new Set(['auth', 'billing']);

export type PendingAudioFileState = {
  filePath: string;
  createdAt: number;
  source: 'voice-mode' | 'inline-mic';
  sessionId?: string;
  lastError?: string;
  errorCategory?: VoiceErrorCategory;
  isRetrying: boolean;
};

type RetryResult = {
  attempted: number;
  succeeded: number;
  failed: number;
};

/**
 * Track, retry, and manage pending audio files awaiting transcription.
 *
 * Exposes the full file list with per-file error state, individual file actions
 * (retry, dismiss), batch actions (dismissAll, retryAllInlineMic), and global
 * exponential backoff for auto-retry.
 *
 * Only inline-mic files are auto-retried here. Voice-mode files are auto-retried
 * by useVoiceRecording which has access to submitVoicePrompt for conversation submission.
 *
 * Inline-mic retry on success creates a new draft session with the recovered transcript.
 */
export const usePendingAudio = () => {
  const [files, setFiles] = useState<PendingAudioFileState[]>([]);
  const [isRetrying, setIsRetrying] = useState(false);
  const isOnline = useOnlineStatus();

  // Per-file error tracking: Map<filePath, errorMessage>
  const errorMapRef = useRef<Map<string, string>>(new Map());
  // Per-file error category tracking: Map<filePath, VoiceErrorCategory>
  const errorCategoryMapRef = useRef<Map<string, VoiceErrorCategory>>(new Map());
  // Set of filePaths currently being retried
  const retryingSetRef = useRef<Set<string>>(new Set());
  // Global backoff state
  const backoffMsRef = useRef(INITIAL_BACKOFF_MS);
  const backoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Batch retry guard
  const isRetryingRef = useRef(false);
  const lastRetryAtRef = useRef<number>(0);
  // Stable ref for current files (avoids stale closures in callbacks)
  const filesRef = useRef<PendingAudioFileState[]>([]);
  filesRef.current = files;

  /** Merge IPC file list with in-memory error/retry state */
  const mergeState = useCallback(
    (
      ipcFiles: Array<{
        filePath: string;
        createdAt: number;
        source: 'voice-mode' | 'inline-mic';
        sessionId?: string;
      }>,
    ): PendingAudioFileState[] => {
      // Prune stale entries for files that no longer exist on disk
      const currentPaths = new Set(ipcFiles.map(f => f.filePath));
      for (const key of errorMapRef.current.keys()) {
        if (!currentPaths.has(key)) errorMapRef.current.delete(key);
      }
      for (const key of errorCategoryMapRef.current.keys()) {
        if (!currentPaths.has(key)) errorCategoryMapRef.current.delete(key);
      }
      for (const key of retryingSetRef.current) {
        if (!currentPaths.has(key)) retryingSetRef.current.delete(key);
      }

      return ipcFiles.map(f => ({
        ...f,
        lastError: errorMapRef.current.get(f.filePath),
        errorCategory: errorCategoryMapRef.current.get(f.filePath),
        isRetrying: retryingSetRef.current.has(f.filePath),
      }));
    },
    [],
  );

  /** Refresh file list from IPC and merge with local state */
  const refresh = useCallback(async () => {
    try {
      const pending = await window.voiceApi.getPendingAudio();
      const merged = mergeState(pending);
      setFiles(merged);
      return merged;
    } catch {
      return [];
    }
  }, [mergeState]);

  /** Create a new draft session with a recovered transcript and clean up the pending file */
  const handleRetrySuccess = useCallback(async (filePath: string, transcript: string) => {
    const store = getSessionStoreState();
    const newSessionId = store.resetSession();
    store.setDraftForSession(newSessionId, transcript);
    store.renameSession(newSessionId, 'Recovered voice note');
    store.setShowConversation(true);

    try {
      await window.voiceApi.deletePendingAudio({ filePath });
    } catch {
      // Non-fatal: transcript was recovered; file will be cleaned up on next retry
    }
    errorMapRef.current.delete(filePath);
    errorCategoryMapRef.current.delete(filePath);
    backoffMsRef.current = INITIAL_BACKOFF_MS;
  }, []);

  /**
   * Retry a single file. Bypasses the global backoff timer.
   * Handles both inline-mic and voice-mode files — on success, creates a
   * new draft session with the recovered transcript.
   */
  const retryFile = useCallback(
    async (filePath: string) => {
      const file = filesRef.current.find(f => f.filePath === filePath);
      if (!file) return;
      // Skip if already being retried (e.g., by batch retry)
      if (retryingSetRef.current.has(filePath)) return;

      retryingSetRef.current.add(filePath);
      setFiles(prev =>
        prev.map(f => (f.filePath === filePath ? { ...f, isRetrying: true, lastError: undefined } : f)),
      );

      try {
        const result = await window.voiceApi.retryPendingAudio({ filePath });
        if (result.success && result.transcript) {
          await handleRetrySuccess(filePath, result.transcript);
        } else {
          errorMapRef.current.set(filePath, result.error ?? 'Transcription failed');
          if (result.errorCategory) {
            errorCategoryMapRef.current.set(filePath, result.errorCategory as VoiceErrorCategory);
          }
        }
      } catch (err) {
        errorMapRef.current.set(filePath, err instanceof Error ? err.message : String(err));
      } finally {
        retryingSetRef.current.delete(filePath);
        await refresh();
      }
    },
    [refresh, handleRetrySuccess],
  );

  /** Reveal a pending audio file in the system file explorer */
  const revealFile = useCallback(async (filePath: string) => {
    await window.voiceApi.revealPendingAudio({ filePath });
  }, []);

  /** Dismiss (delete) a single pending file */
  const dismissFile = useCallback(
    async (filePath: string) => {
      try {
        await window.voiceApi.deletePendingAudio({ filePath });
        errorMapRef.current.delete(filePath);
        errorCategoryMapRef.current.delete(filePath);
      } catch {
        // Silently ignore — file may already be deleted
      }
      await refresh();
    },
    [refresh],
  );

  /** Dismiss (delete) all pending files */
  const dismissAll = useCallback(async () => {
    const current = filesRef.current;
    for (const file of current) {
      try {
        await window.voiceApi.deletePendingAudio({ filePath: file.filePath });
        errorMapRef.current.delete(file.filePath);
        errorCategoryMapRef.current.delete(file.filePath);
      } catch {
        // Continue with remaining files
      }
    }
    await refresh();
  }, [refresh]);

  /**
   * Retry all inline-mic files. Respects MIN_RETRY_GAP_MS throttle.
   * Updates global backoff: resets on any success, doubles on full-batch failure.
   * Self-chains: schedules the next retry via backoff timer after completion.
   */
  const retryAllInlineMic = useCallback(async (): Promise<RetryResult> => {
    // Prevent concurrent batch retries
    if (isRetryingRef.current) return { attempted: 0, succeeded: 0, failed: 0 };

    // Throttle: don't retry more frequently than MIN_RETRY_GAP_MS
    const now = Date.now();
    if (now - lastRetryAtRef.current < MIN_RETRY_GAP_MS) {
      return { attempted: 0, succeeded: 0, failed: 0 };
    }

    isRetryingRef.current = true;
    lastRetryAtRef.current = now;
    setIsRetrying(true);

    const result: RetryResult = { attempted: 0, succeeded: 0, failed: 0 };

    try {
      const pending = await window.voiceApi.getPendingAudio();
      const inlineMicFiles = pending.filter(f => f.source === 'inline-mic');

      for (const file of inlineMicFiles) {
        // Skip files already being retried individually (prevents duplicate retries)
        if (retryingSetRef.current.has(file.filePath)) continue;

        result.attempted++;
        retryingSetRef.current.add(file.filePath);

        try {
          const retryResult = await window.voiceApi.retryPendingAudio({ filePath: file.filePath });
          if (retryResult.success && retryResult.transcript) {
            await handleRetrySuccess(file.filePath, retryResult.transcript);
            result.succeeded++;
          } else {
            errorMapRef.current.set(file.filePath, retryResult.error ?? 'Transcription failed');
            if (retryResult.errorCategory) {
              errorCategoryMapRef.current.set(file.filePath, retryResult.errorCategory as VoiceErrorCategory);
            }
            result.failed++;
          }
        } catch (err) {
          errorMapRef.current.set(file.filePath, err instanceof Error ? err.message : String(err));
          result.failed++;
        } finally {
          retryingSetRef.current.delete(file.filePath);
        }
      }

      await refresh();

      // Adjust global backoff based on batch results
      if (result.succeeded > 0) {
        backoffMsRef.current = INITIAL_BACKOFF_MS;
      } else if (result.attempted > 0 && result.failed === result.attempted) {
        backoffMsRef.current = Math.min(backoffMsRef.current * 2, MAX_BACKOFF_MS);
      }

      // Self-chain: schedule the next retry if inline-mic files still exist
      // and at least one has a retryable error category (REBEL-ZJ).
      const remaining = await window.voiceApi.getPendingAudio();
      const remainingInlineMic = remaining.filter(f => f.source === 'inline-mic');
      if (remainingInlineMic.length > 0) {
        const allPermanent = remainingInlineMic.every(f => {
          const cat = errorCategoryMapRef.current.get(f.filePath);
          return cat != null && PERMANENT_ERROR_CATEGORIES.has(cat);
        });
        if (allPermanent) {
          console.warn('[usePendingAudio] All remaining inline-mic files have permanent errors — stopping auto-retry');
        } else {
          if (backoffTimerRef.current) clearTimeout(backoffTimerRef.current);
          backoffTimerRef.current = setTimeout(() => {
            void retryAllInlineMic();
          }, backoffMsRef.current);
        }
      }
    } finally {
      isRetryingRef.current = false;
      setIsRetrying(false);
    }

    return result;
  }, [refresh, handleRetrySuccess]);

  const pendingCount = files.length;

  // Refresh on mount and when online status changes
  useEffect(() => {
    void refresh();
  }, [isOnline, refresh]);

  // Periodic polling to discover new pending files (e.g., from transcription errors).
  // Discovery only — does NOT trigger retries; that's handled by the backoff timer below.
  // Only polls when pending files exist (to avoid idle IPC overhead).
  // Initial discovery and new-file notification handled by mount refresh + pending-audio-changed event.
  useEffect(() => {
    if (pendingCount === 0) return;
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh, pendingCount]);

  // Immediate refresh when a transcription failure creates a new pending file.
  // Transcription hooks dispatch this event so the badge appears instantly
  // instead of waiting up to 15s for the next poll.
  // The event may carry error category detail from the first failure.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ errorCategory?: string }>).detail;
      if (detail?.errorCategory) {
        // Merge first-failure error category — the refresh below will pick it up
        // via mergeState. We store it keyed by all current files since we don't
        // know the exact filePath from the event (it's created by the main process).
        // The next refresh will associate it with the newest file.
        const category = detail.errorCategory as VoiceErrorCategory;
        // Store with a sentinel key; refresh will re-merge from IPC
        // Actually, apply to the most recently added file after refresh
        void refresh().then((refreshedFiles) => {
          if (refreshedFiles && refreshedFiles.length > 0) {
            // Apply to the newest file (last in sorted-by-createdAt list)
            const newest = refreshedFiles[refreshedFiles.length - 1];
            if (newest && !errorCategoryMapRef.current.has(newest.filePath)) {
              errorCategoryMapRef.current.set(newest.filePath, category);
              // Re-merge state so the category is immediately visible in the UI
              setFiles(prev => prev.map(f =>
                f.filePath === newest.filePath ? { ...f, errorCategory: category } : f
              ));
            }
          }
        });
        return;
      }
      void refresh();
    };
    window.addEventListener('pending-audio-changed', handler);
    return () => window.removeEventListener('pending-audio-changed', handler);
  }, [refresh]);

  // Auto-retry inline-mic files with exponential backoff.
  // Runs once on mount/online and then on backoff timer only.
  // The 15s poll above handles file discovery; this handles retry cadence.
  // Skip if all remaining inline-mic files have permanent error categories (REBEL-ZJ).
  const hasInlineMic = files.some(f => f.source === 'inline-mic');
  const hasRetryableInlineMic = files.some(f => {
    if (f.source !== 'inline-mic') return false;
    const cat = f.errorCategory;
    return cat == null || !PERMANENT_ERROR_CATEGORIES.has(cat);
  });
  useEffect(() => {
    if (backoffTimerRef.current) {
      clearTimeout(backoffTimerRef.current);
      backoffTimerRef.current = null;
    }

    if (!isOnline || !hasInlineMic || !hasRetryableInlineMic) return;

    // Schedule retry with current backoff delay
    backoffTimerRef.current = setTimeout(() => {
      void retryAllInlineMic();
    }, backoffMsRef.current);

    return () => {
      if (backoffTimerRef.current) {
        clearTimeout(backoffTimerRef.current);
        backoffTimerRef.current = null;
      }
    };
    // Only re-schedule when online status or presence of retryable inline-mic files changes —
    // NOT on every `files` identity change (which would defeat backoff)
     
  }, [isOnline, hasInlineMic, hasRetryableInlineMic, retryAllInlineMic]);

  return {
    files,
    pendingCount,
    retryFile,
    revealFile,
    dismissFile,
    dismissAll,
    retryAllInlineMic,
    isRetrying,
    refresh,
  };
};

/**
 * @deprecated Use `usePendingAudio` instead. Backward-compatible re-export.
 */
export const usePendingAudioCount = usePendingAudio;
