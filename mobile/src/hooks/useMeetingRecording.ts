// mobile/src/hooks/useMeetingRecording.ts

/**
 * Meeting recording hook — stop/restart chunked recording (60s chunks).
 *
 * State machine:
 * idle → starting → recording ─(60s)→ rotating → recording
 *                     └─────────────── stop ─────────────→ stopping → idle
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  type RecordingStatus,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { AppState, type AppStateStatus } from 'react-native';
import {
  useAuthStore,
  useOfflineQueueStore,
  QueueFullError,
  createLogger,
  asLocalRecordingId,
  asCloudMeetingSessionId,
} from '@rebel/cloud-client';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { useNetworkState } from './useNetworkState';
import { configureForBackgroundRecording, configureForIdle } from '../utils/audioSessionManager';
import { deferNativeCleanup } from '../utils/deferNativeCleanup';
import { getWidgetRecordingState, setWidgetRecordingState } from '../services/widgetDataSync';
import {
  createMeetingManifest,
  generateMeetingLocalId,
  saveMeetingChunkToDisk,
  updateMeetingManifest,
  type MeetingChunkQueueMetadata,
} from '../utils/meetingManifest';
import {
  createCloudMeetingSession,
  rotateCreateMeetingSessionIdempotencyKey,
} from '../api/meetingSessionApi';
import { checkSufficientDiskSpace, MIN_FREE_DISK_SPACE_BYTES } from '../utils/diskSpace';
import { QUEUE_FULL_MEETING_MESSAGE } from '../utils/queueCopy';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';

const log = createLogger('meetingRecording');
const CHUNK_ROTATION_INTERVAL_MS = 60_000;
const DISK_SPACE_CHECK_INTERVAL_MS = 5 * 60_000;

export type MeetingRecordingState = 'idle' | 'starting' | 'recording' | 'rotating' | 'stopping';

export interface UseMeetingRecordingReturn {
  state: MeetingRecordingState;
  isRecording: boolean;
  error: string | null;
  meetingSessionId: string | null;
  startRecording: (meetingTitle?: string) => Promise<boolean>;
  stopRecording: () => void;
}

export function useMeetingRecording(): UseMeetingRecordingReturn {
  log.debug('useMeetingRecording called (hook body)');
  const [state, setState] = useState<MeetingRecordingState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [meetingSessionId, setMeetingSessionId] = useState<string | null>(null);

  // Network state for connectivity-aware drain (ref avoids callback dep churn)
  const { isOnline } = useNetworkState();
  const isOnlineRef = useRef(isOnline);
  useEffect(() => { isOnlineRef.current = isOnline; }, [isOnline]);

  const mountedRef = useRef(true);
  const meetingStartTimeRef = useRef<number | null>(null);
  const meetingTitleRef = useRef<string | undefined>(undefined);
  const localMeetingSessionIdRef = useRef<string | null>(null);
  const nextChunkIndexRef = useRef(0);
  const isRotatingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const rotationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const diskSpaceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopRecordingRef = useRef<() => void>(() => {});

  useEffect(() => {
    log.info('useMeetingRecording MOUNTED');
    mountedRef.current = true;
    return () => {
      log.info('useMeetingRecording UNMOUNTED');
      mountedRef.current = false;
    };
  }, []);

  const stopRotationTimer = useCallback(() => {
    if (rotationTimerRef.current) {
      clearInterval(rotationTimerRef.current);
      rotationTimerRef.current = null;
    }
    if (diskSpaceTimerRef.current) {
      clearInterval(diskSpaceTimerRef.current);
      diskSpaceTimerRef.current = null;
    }
  }, []);

  // Recorder status handler ref — updated after enqueueChunk/resetToIdle
  // are defined (avoids hook ordering issues with useAudioRecorder).
  const handleRecorderStatusRef = useRef<(status: RecordingStatus) => void>(() => {});
  const handleRecorderStatusStable = useCallback((status: RecordingStatus) => {
    handleRecorderStatusRef.current(status);
  }, []);

  log.debug('calling useAudioRecorder');
  const recorder = useAudioRecorder(
    RecordingPresets.HIGH_QUALITY,
    handleRecorderStatusStable,
  );
  log.debug('useAudioRecorder returned', { isRecording: recorder.isRecording });

  const enqueueChunk = useCallback(async (
    chunkUri: string,
    chunkIndex: number,
    isFinalChunk: boolean,
    totalChunks: number | undefined,
  ): Promise<void> => {
    const localId = localMeetingSessionIdRef.current;
    const meetingStartTime = meetingStartTimeRef.current;
    if (!localId || !meetingStartTime) {
      throw new Error('Missing local meeting session context');
    }

    const queueState = useOfflineQueueStore.getState();
    if (!queueState.isInitialized) {
      throw new Error('Offline queue is not initialized');
    }

    // Save to durable meeting session storage first (crash-safe), then enqueue.
    const persistedChunkUri = await saveMeetingChunkToDisk(localId, chunkIndex, chunkUri, 'm4a');

    await updateMeetingManifest(localId, (current) => ({
      ...current,
      nextChunkIndex: Math.max(current.nextChunkIndex, chunkIndex + 1),
      isStopped: isFinalChunk ? true : current.isStopped,
      totalChunks: isFinalChunk ? totalChunks : current.totalChunks,
    }));

    const metadata: MeetingChunkQueueMetadata = {
      meetingSessionId: localId,
      chunkIndex,
      meetingTitle: meetingTitleRef.current,
      meetingStartTime,
      mimeType: 'audio/mp4',
      isFinalChunk,
      totalChunks,
    };

    await queueState.enqueueOrThrow(
      'meeting-chunk',
      persistedChunkUri,
      'm4a',
      metadata as unknown as Record<string, unknown>,
    );

    try {
      await queueState.drain(isOnlineRef.current);
    } catch {
      // Non-fatal: chunk remains safely queued.
    }
  }, []);

  const resetToIdle = useCallback(() => {
    stopRotationTimer();
    meetingStartTimeRef.current = null;
    localMeetingSessionIdRef.current = null;
    nextChunkIndexRef.current = 0;
    stopRequestedRef.current = false;
    isRotatingRef.current = false;
    if (mountedRef.current) {
      setState('idle');
      setMeetingSessionId(null);
    }
    setWidgetRecordingState(false);
    useActiveRecordingStore.getState().clearRecording();
    // Explicitly restore audio session — the hook may live at root level
    // where unmount cleanup never fires.
    configureForIdle().catch(() => {
      // Best effort — audio session may already be in the correct state.
    });
  }, [stopRotationTimer]);

  // Wire up the recorder status handler now that enqueueChunk/resetToIdle exist.
  // NOTE: `isFinished` fires on EVERY `recorder.stop()` call (both iOS and Android),
  // not just the Android foreground service Stop button. We must guard against
  // handling expected stops (chunk rotation, user-initiated stop) here.
  handleRecorderStatusRef.current = (status: RecordingStatus) => {
    if (status.hasError) {
      log.error('Meeting recorder status callback reported error', { error: status.error });
      resetToIdle();
      if (mountedRef.current) setError('Recording failed unexpectedly.');
      return;
    }

    // Guard: only handle `isFinished` for truly unexpected stops (Android
    // foreground service Stop button). During chunk rotation (`isRotatingRef`)
    // and user-initiated stop (`stopRequestedRef`), the finish event is
    // already handled by `rotateChunk()` / `stopRecording()`.
    if (
      status.isFinished &&
      !status.hasError &&
      localMeetingSessionIdRef.current &&
      !isRotatingRef.current &&
      !stopRequestedRef.current
    ) {
      log.info('Recorder finished unexpectedly (likely Android notification Stop button)');
      stopRequestedRef.current = true;
      stopRotationTimer();

      const chunkUri = status.url;
      if (chunkUri) {
        const chunkIndex = nextChunkIndexRef.current;
        const totalChunks = chunkIndex + 1;
        if (mountedRef.current) setState('stopping');

        void enqueueChunk(chunkUri, chunkIndex, true, totalChunks)
          .then(() => { resetToIdle(); })
          .catch((err) => {
            if (err instanceof QueueFullError) {
              if (mountedRef.current) setError(QUEUE_FULL_MEETING_MESSAGE);
              log.warn('Queue full on meeting chunk enqueue (native stop)', { chunkIndex, queueSize: err.maxSize });
            } else {
              log.error('Failed to save final chunk from native stop', {
                error: err instanceof Error ? err.message : String(err),
              });
              if (mountedRef.current) setError('Recording stopped but final chunk may not have saved.');
            }
            resetToIdle();
          });
      } else {
        log.warn('Native recorder stop had no audio URI — final chunk lost');
        if (mountedRef.current) setError('Recording stopped but final audio may be incomplete.');
        resetToIdle();
      }
    }
  };

  const rotateChunk = useCallback(async (isFinalChunk: boolean) => {
    if (isRotatingRef.current) return;
    if (!recorder.isRecording) return;

    isRotatingRef.current = true;
    if (mountedRef.current) {
      setState(isFinalChunk ? 'stopping' : 'rotating');
    }

    const chunkIndex = nextChunkIndexRef.current;
    const totalChunks = isFinalChunk ? chunkIndex + 1 : undefined;

    try {
      await recorder.stop();
      const chunkUri = recorder.uri;
      if (!chunkUri) {
        throw new Error('Recorder returned no chunk URI');
      }

      await enqueueChunk(chunkUri, chunkIndex, isFinalChunk, totalChunks);
      nextChunkIndexRef.current = chunkIndex + 1;

      if (isFinalChunk || stopRequestedRef.current) {
        resetToIdle();
        return;
      }

      // Re-check stop request after await — stop may have been requested while
      // prepareToRecordAsync was in flight, which would leave recording running
      // without a rotation timer.
      if (stopRequestedRef.current) {
        resetToIdle();
        return;
      }

      await recorder.prepareToRecordAsync();
      recorder.record();

      if (mountedRef.current) {
        setState('recording');
      }
    } catch (err) {
      if (err instanceof QueueFullError) {
        // Queue is full — stop recording gracefully
        log.warn('Queue full during meeting chunk rotation, stopping recording', {
          chunkIndex,
          isFinalChunk,
          queueSize: err.maxSize,
        });
        if (mountedRef.current) {
          setError(QUEUE_FULL_MEETING_MESSAGE);
        }
        resetToIdle();
        return;
      }
      log.error('Failed during meeting chunk rotation', {
        error: err instanceof Error ? err.message : String(err),
        chunkIndex,
        isFinalChunk,
      });
      if (mountedRef.current) {
        setError('Could not save a meeting chunk. Recovery will retry when possible.');
      }
      if (isFinalChunk || stopRequestedRef.current) {
        resetToIdle();
      } else {
        if (stopRequestedRef.current) {
          resetToIdle();
          return;
        }
        if (mountedRef.current) {
          setState('recording');
        }
        try {
          await recorder.prepareToRecordAsync();
          recorder.record();
        } catch {
          resetToIdle();
        }
      }
    } finally {
      isRotatingRef.current = false;
    }
  }, [enqueueChunk, recorder, resetToIdle]);

  const startRotationTimer = useCallback(() => {
    stopRotationTimer();
    rotationTimerRef.current = setInterval(() => {
      if (!recorder.isRecording) return;
      if (stopRequestedRef.current) return;
      void rotateChunk(false);
    }, CHUNK_ROTATION_INTERVAL_MS);
  }, [recorder, rotateChunk, stopRotationTimer]);

  const startRecording = useCallback(async (meetingTitle?: string): Promise<boolean> => {
    if (state !== 'idle') return false;

    setError(null);
    meetingTitleRef.current = meetingTitle;
    stopRequestedRef.current = false;

    if (mountedRef.current) {
      setState('starting');
    }

    try {
      const queueState = useOfflineQueueStore.getState();
      if (!queueState.isInitialized) {
        throw new Error('Offline queue is not initialized');
      }

      const { granted } = await requestRecordingPermissionsAsync();
      if (!mountedRef.current) return false;
      if (!granted) {
        setError('Microphone access denied. Check your device settings.');
        setState('idle');
        return false;
      }

      try {
        const diskCheck = await checkSufficientDiskSpace();
        if (!diskCheck.ok) {
          setError('Not enough storage space. Free up at least 200MB before recording.');
          setState('idle');
          return false;
        }
      } catch {
        log.warn('Disk space check unavailable');
      }

      await configureForBackgroundRecording();
      if (!mountedRef.current) return false;

      const localId = generateMeetingLocalId();
      const startTime = Date.now();
      await createMeetingManifest(localId, meetingTitle, startTime);

      localMeetingSessionIdRef.current = localId;
      meetingStartTimeRef.current = startTime;
      nextChunkIndexRef.current = 0;

      await recorder.prepareToRecordAsync();
      recorder.record();

      if (mountedRef.current) {
        setMeetingSessionId(localId);
        setState('recording');
      }

      const activeRecordingStore = useActiveRecordingStore.getState();
      const companionSessionId = activeRecordingStore.companionSessionId;
      activeRecordingStore.setRecording(
        asLocalRecordingId(localId),
        startTime,
        meetingTitleRef.current ?? '',
        companionSessionId ?? undefined,
      );

      const fallbackCreateNotice = 'Saving locally — Spark will start listening when reconnected';
      const { cloudUrl, token } = useAuthStore.getState();
      if (cloudUrl && token) {
        void createCloudMeetingSession({
          cloudUrl,
          token,
          localMeetingSessionId: localId,
          meetingTitle: meetingTitleRef.current,
          meetingStartTime: startTime,
          companionSessionId,
        })
          .then(async (createResult) => {
            if (createResult.ok) {
              await updateMeetingManifest(localId, (current) => ({
                ...current,
                cloudSessionId: createResult.sessionId,
              }));
              const storeState = useActiveRecordingStore.getState();
              if (storeState.meetingSessionId === localId) {
                // Cloud-id provenance boundary: cloud created this session id.
                storeState.setCloudSessionId(asCloudMeetingSessionId(createResult.sessionId));
              }
              return;
            }

            if (createResult.kind === 'idempotency_conflict') {
              rotateCreateMeetingSessionIdempotencyKey(localId);
              useActiveRecordingStore.getState().setRecordingNotice("Couldn't reuse existing recording — please stop and start a new one");
              return;
            }

            log.warn('Eager meeting session creation failed; continuing with lazy fallback', {
              reason: createResult.kind,
              status: createResult.status,
              localMeetingSessionId: localId,
            });
            useActiveRecordingStore.getState().setRecordingNotice(fallbackCreateNotice);
          })
          .catch((err) => {
            log.warn('Eager meeting session creation threw unexpectedly; continuing with lazy fallback', {
              err: err instanceof Error ? err.message : String(err),
              localMeetingSessionId: localId,
            });
            useActiveRecordingStore.getState().setRecordingNotice(fallbackCreateNotice);
          });
      } else {
        useActiveRecordingStore.getState().setRecordingNotice(fallbackCreateNotice);
      }

      startRotationTimer();

      // Periodic disk space check — stop gracefully if storage runs low.
      // Uses stopRecordingRef to avoid stale closure issues.
      diskSpaceTimerRef.current = setInterval(async () => {
        try {
          const freeSpace = await FileSystem.getFreeDiskStorageAsync();
          if (freeSpace < MIN_FREE_DISK_SPACE_BYTES) {
            log.warn('Low disk space during meeting recording, stopping', { freeSpace });
            if (mountedRef.current) {
              setError('Running low on storage. Recording saved.');
            }
            stopRecordingRef.current();
          }
        } catch {
          // Non-fatal — disk space check is best-effort
        }
      }, DISK_SPACE_CHECK_INTERVAL_MS);

      setWidgetRecordingState(true, meetingTitle);

      log.info('Meeting recording started (chunked mode)', {
        localMeetingSessionId: localId,
        meetingTitle,
      });
      return true;
    } catch (err) {
      log.error('Failed to start meeting recording', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (mountedRef.current) {
        setError('Could not start recording.');
        setState('idle');
      }
      resetToIdle();
      return false;
    }
  }, [recorder, resetToIdle, startRotationTimer, state]);

  const stopRecording = useCallback(() => {
    if (state !== 'recording' && state !== 'rotating') return;
    if (stopRequestedRef.current) return;

    stopRequestedRef.current = true;
    stopRotationTimer();
    if (mountedRef.current) {
      setState('stopping');
    }

    if (state === 'recording') {
      void rotateChunk(true);
    }
    // If state is 'rotating', the in-flight rotation will check stopRequestedRef
    // and handle the final chunk save automatically.
    // Audio session restore happens in resetToIdle() (called after recorder stops
    // and final chunk is saved), not here — calling setAudioModeAsync before the
    // recorder stops could corrupt the final chunk.
  }, [rotateChunk, state, stopRotationTimer]);

  // Keep ref in sync for use by interval callbacks (avoids stale closures).
  stopRecordingRef.current = stopRecording;

  // Log AppState transitions for debugging — recording continues in background
  // (background recording is handled by expo-audio's allowsBackgroundRecording +
  // foreground service on Android).
  //
  // Also reconcile widget recording state on mount and on every `active`
  // transition. If the app crashed/was force-quit mid-recording, the widget
  // UserDefaults flag can remain `true` indefinitely. When the hook mounts
  // (or the app becomes active again) and we're idle, clear the stale flag
  // so the widget drops the "Recording" takeover promptly without waiting
  // for the 4h Swift TTL.
  useEffect(() => {
    const reconcileWidgetIfIdle = (trigger: 'mount' | 'appstate-active') => {
      if (state !== 'idle') return;
      const widgetRecording = getWidgetRecordingState();
      if (widgetRecording === true) {
        log.info(
          'Reconciling widget: hook idle but widget shows recording; clearing widget flag',
          { trigger },
        );
        setWidgetRecordingState(false);
      }
    };

    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        reconcileWidgetIfIdle('appstate-active');
      }
      if (state === 'recording' || state === 'rotating') {
        log.info('AppState changed during meeting recording', { appState: nextState, recordingState: state });
      }
    };

    // Cold-start reconciliation: hooks mount while the app is already active,
    // so no AppState 'change' event is guaranteed — run once on mount if active.
    if (AppState.currentState === 'active') {
      reconcileWidgetIfIdle('mount');
    }

    const subscription = AppState.addEventListener('change', handleAppStateChange);
    return () => subscription.remove();
  }, [state]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      stopRotationTimer();
      deferNativeCleanup(async () => {
        try {
          if (recorder.isRecording) {
            await recorder.stop();
          }
        } catch (e) {
          ignoreBestEffortCleanup(e, {
            operation: 'useMeetingRecording.unmount.stopRecorder',
            reason: 'native recorder may already be deallocated during unmount',
            severity: 'warn',
          });
        }
        try {
          await configureForIdle();
        } catch (e) {
          ignoreBestEffortCleanup(e, {
            operation: 'useMeetingRecording.unmount.configureForIdle',
            reason: 'audio session cleanup is best-effort during unmount',
            severity: 'warn',
          });
        }
      });
    };
  }, []);

  log.debug('useMeetingRecording returning', { state, error, meetingSessionId });
  return {
    state,
    isRecording: state === 'recording' || state === 'rotating',
    error,
    meetingSessionId,
    startRecording,
    stopRecording,
  };
}
