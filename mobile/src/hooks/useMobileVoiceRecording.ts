// mobile/src/hooks/useMobileVoiceRecording.ts
// Mobile voice recording hook using expo-audio + offline queue.
// Records audio, saves to persistent storage via queue enqueue,
// and lets the queue consumer handle upload/transcription/turn submission.
// Falls back to direct upload if queue is not initialized.
//
// When local-moonshine is selected AND model is downloaded, transcription
// happens on-device via the MoonshineStt native module (bypasses cloud entirely).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  type RecordingStatus,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { useAuthStore, useOfflineQueueStore, QueueFullError, createLogger, fireUnauthorized, classifyUploadFailureCategory } from '@rebel/cloud-client';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { useNetworkState } from './useNetworkState';
import { deferNativeCleanup } from '../utils/deferNativeCleanup';

const log = createLogger('voiceRecording');
import {
  getMobileVoiceProvider,
  setMobileVoiceProvider,
  type MobileVoiceProvider,
} from '../storage/mobileVoiceSettings';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';
import { configureForRecording, configureForIdle } from '../utils/audioSessionManager';
import { tracking as analyticsTracking } from '../analytics/tracking';
import { buildVoiceTranscriptionUrl } from '../utils/voiceTranscriptionUrl';
import { isMoonshineModelReady, getModelDirectoryPath, purgeModelFiles } from './useMobileModelDownload';
import {
  checkForInferenceCrash,
  shouldDisableLocalStt,
  markInferenceStarted,
  markInferenceCompleted,
  markInferenceFailed,
  CRASH_DISABLE_MESSAGE,
} from '../utils/localSttCrashGuard';
import { checkSufficientDiskSpace } from '../utils/diskSpace';

const MIN_RECORDING_DURATION_MS = 500;
/** Retry config for direct upload fallback (when queue is unavailable). */
const UPLOAD_RETRY_DELAY_MS = 2_000;
const UPLOAD_MAX_RETRIES = 1;

// ---------------------------------------------------------------------------
// Native module — lazy-loaded to avoid crash if not compiled
// ---------------------------------------------------------------------------

interface MoonshineSttApi {
  loadModel: (path: string) => Promise<void>;
  transcribeAudioFile: (path: string) => Promise<string>;
  isModelLoaded: () => Promise<boolean>;
  unloadModel: () => Promise<void>;
}

let _moonshineSttLoaded = false;
let _moonshineStt: MoonshineSttApi | null = null;

function getMoonshineSttModule(): MoonshineSttApi | null {
  if (!_moonshineSttLoaded) {
    _moonshineSttLoaded = true;
    try {
      _moonshineStt = require('../../modules/moonshine-stt') as MoonshineSttApi;
    } catch {
      _moonshineStt = null;
    }
  }
  return _moonshineStt;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseMobileVoiceRecordingReturn {
  /** True while actively recording audio */
  isRecording: boolean;
  /** True while audio is being sent for transcription (direct upload fallback only) */
  isTranscribing: boolean;
  /** Last error message, cleared on next recording start */
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  toggleRecording: () => void;
}

export function useMobileVoiceRecording(
  onTranscript: (text: string) => void,
  sessionId?: string,
): UseMobileVoiceRecordingReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Network state for connectivity-aware drain (ref avoids callback dep churn)
  const { isOnline } = useNetworkState();
  const isOnlineRef = useRef(isOnline);
  useEffect(() => { isOnlineRef.current = isOnline; }, [isOnline]);

  const mountedRef = useRef(true);
  const recordingStartTimeRef = useRef<number | null>(null);
  const isStartingRef = useRef(false);
  const isProcessingRef = useRef(false);
  // Capture sessionId at recording start so transcript goes to the right conversation
  const sessionIdRef = useRef(sessionId);
  // Capture onTranscript to avoid stale closures
  const onTranscriptRef = useRef(onTranscript);
  // Provider pinned at recording start — determines cloud vs local routing
  const pinnedProviderRef = useRef<MobileVoiceProvider>('cloud');

  useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // On mount, check for inference crashes from previous sessions
  useEffect(() => {
    (async () => {
      try {
        const crashed = await checkForInferenceCrash();
        if (crashed) {
          const disabled = await shouldDisableLocalStt();
          if (disabled) {
            // Auto-disable: switch to cloud
            await setMobileVoiceProvider('cloud');
            if (mountedRef.current) {
              setError(CRASH_DISABLE_MESSAGE);
            }
          }
        }
      } catch {
        // Non-critical — crash detection is best-effort
      }
    })();
  }, []);

  const handleRecordingStatus = useCallback((status: RecordingStatus) => {
    if (status.isFinished && !status.hasError && status.url) {
      // Recording finished, process the audio
      void processRecording(status.url);
    } else if (status.hasError) {
      if (mountedRef.current) {
        setIsRecording(false);
        setError('Recording failed unexpectedly.');
      }
    }
  }, []);

  const recorder = useAudioRecorder(
    RecordingPresets.HIGH_QUALITY,
    handleRecordingStatus,
  );

  /**
   * Check whether the offline queue store is initialized and usable.
   */
  const isQueueAvailable = useCallback((): boolean => {
    try {
      const state = useOfflineQueueStore.getState();
      return state.isInitialized;
    } catch {
      // Store not initialized — useOfflineQueueStore.getState() throws
      return false;
    }
  }, []);

  /**
   * Enqueue recording to the offline queue (save-first pattern).
   * The queue consumer handles upload + transcription + turn submission.
   */
  const enqueueRecording = useCallback(async (uri: string, durationMs: number) => {
    try {
      const state = useOfflineQueueStore.getState();
      await state.enqueueOrThrow(
        'voice-transcription',
        uri,
        'm4a',
        {
          sessionId: sessionIdRef.current || null,
          mimeType: 'audio/mp4',
          durationMs,
        },
      );

      // If online, trigger immediate drain for near-zero latency
      try {
        await state.drain(isOnlineRef.current);
      } catch {
        // Drain failure is non-critical — item is safely queued
      }
    } catch (err) {
      if (err instanceof QueueFullError) {
        // Fall back to direct upload — don't lose the recording
        log.warn('Queue full, falling back to direct upload for voice recording', {
          queueSize: err.maxSize,
          sessionId: sessionIdRef.current,
        });
        throw err; // Let processRecording catch handle it via directUpload fallback
      }
      const message = err instanceof Error ? err.message : String(err);
      log.error('Failed to enqueue recording', { err: message });
      throw err;
    }
  }, []);

  /**
   * Direct upload fallback — used when the offline queue is not initialized.
   * Preserves the original upload behavior for graceful degradation.
   */
  const directUpload = useCallback(async (uri: string, durationMs?: number) => {
    if (mountedRef.current) setIsTranscribing(true);

    try {
      const { cloudUrl, token } = useAuthStore.getState();
      if (!cloudUrl || !token) {
        if (mountedRef.current) setError('Not connected to cloud.');
        return;
      }

      const url = buildVoiceTranscriptionUrl(cloudUrl, {
        sessionId: sessionIdRef.current,
        durationMs,
      });

      let lastUploadError: Error | null = null;
      for (let attempt = 0; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
        try {
          const response = await FileSystem.uploadAsync(url, uri, {
            httpMethod: 'POST',
            uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'audio/mp4',
            },
          });

          if (response.status < 200 || response.status >= 300) {
            // Route the HTTP-status -> retry-vs-give-up decision through the
            // shared classifier so this direct-upload fallback treats a
            // transient 404 (deploy window / version skew on
            // /api/voice/transcribe) as retryable — consistent with the
            // offline-queue consumers (REBEL-6BJ / FOX-3516). Previously this
            // fallback retried only >= 500 and failed fast on 404, the same
            // bug class the queue fix removed.
            const category = classifyUploadFailureCategory(response.status);

            if (category === 'auth') {
              fireUnauthorized();
              if (mountedRef.current) setError('Session expired. Please re-pair.');
              return;
            }

            // 'temporary' (404/408/425/429/>=500/unknown 4xx) — retry within
            // the bounded budget; 'permanent' (400/413/415/422) — give up now.
            if (category === 'temporary' && attempt < UPLOAD_MAX_RETRIES) {
              await new Promise(r => setTimeout(r, UPLOAD_RETRY_DELAY_MS));
              continue;
            }

            if (mountedRef.current) setError('Transcription failed. Try again.');
            return;
          }

          const { transcript } = JSON.parse(response.body) as { transcript: string };
          if (!transcript?.trim()) {
            if (mountedRef.current) setError("Didn't catch that. Try again?");
            return;
          }
          if (mountedRef.current) onTranscriptRef.current(transcript.trim());
          return;
        } catch (err) {
          lastUploadError = err instanceof Error ? err : new Error('Upload failed');
          if (attempt < UPLOAD_MAX_RETRIES) {
            await new Promise(r => setTimeout(r, UPLOAD_RETRY_DELAY_MS));
            continue;
          }
        }
      }

      const msg = lastUploadError?.message ?? 'Transcription failed';
      log.error('Transcription error after retries', { err: msg });
      if (mountedRef.current) {
        setError('Transcription failed. Try again.');
      }
    } finally {
      if (mountedRef.current) setIsTranscribing(false);
    }
  }, []);

  /**
   * Local transcription via Moonshine native module.
   * Bypasses cloud upload entirely. Shows explicit error on failure
   * (does NOT silently fall back to cloud).
   */
  const localTranscribe = useCallback(async (uri: string) => {
    if (mountedRef.current) setIsTranscribing(true);

    try {
      const nativeModule = getMoonshineSttModule();
      if (!nativeModule) {
        if (mountedRef.current) {
          setError('Local transcription is not available on this device.');
        }
        return;
      }

      // Ensure model is loaded (lazy load on first use)
      const loaded = await nativeModule.isModelLoaded();
      if (!loaded) {
        const modelDir = getModelDirectoryPath();
        log.info('Loading Moonshine model', { modelDir });
        await nativeModule.loadModel(modelDir);
        log.info('Model loaded successfully');
      }

      // Mark inference started for crash detection
      await markInferenceStarted();

      const transcript = await nativeModule.transcribeAudioFile(uri);

      // Success — reset crash counter
      await markInferenceCompleted();

      if (!transcript?.trim()) {
        if (mountedRef.current) setError("Didn't catch that. Try again?");
        return;
      }

      if (mountedRef.current) onTranscriptRef.current(transcript.trim());
    } catch (err) {
      // Clear inference flag — this was a handled error, not an app crash
      await markInferenceFailed();
      const message = err instanceof Error ? err.message : String(err);
      log.error('Local transcription failed', { err: message, errStack: err instanceof Error ? err.stack : undefined });

      // If the native module threw during model load or inference, the model
      // files are likely corrupt (e.g. truncated download, stale quantization).
      // Purge them so the download hook shows 'not-downloaded' and the user
      // can re-download fresh files.
      const isModelError = message.includes('model') || message.includes('Model')
        || message.includes('native exception') || message.includes('Native exception')
        || message.includes('objc-exception') || message.includes('ONNX');
      if (isModelError) {
        log.warn('Model error detected — purging corrupt model files');
        await purgeModelFiles();
        // Also unload from native memory so next attempt re-loads
        try { await getMoonshineSttModule()?.unloadModel(); } catch { /* best-effort */ }
      }

      if (mountedRef.current) {
        setError(
          isModelError
            ? 'Voice model appears corrupted. Please re-download it in Settings.'
            : 'Local transcription failed. Try again, or switch to cloud in Settings.',
        );
      }
    } finally {
      if (mountedRef.current) setIsTranscribing(false);
    }
  }, []);

  const processRecording = useCallback(async (uri: string) => {
    // Guard against double-processing: both handleRecordingStatus and
    // stopRecording's fallback can call this for the same recording.
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    const recordingDuration = recordingStartTimeRef.current
      ? Date.now() - recordingStartTimeRef.current
      : 0;
    recordingStartTimeRef.current = null;

    // Ignore accidental taps
    if (recordingDuration < MIN_RECORDING_DURATION_MS) {
      isProcessingRef.current = false;
      return;
    }

    try {
      // Route based on provider pinned at recording start
      if (pinnedProviderRef.current === 'local-moonshine') {
        await localTranscribe(uri);
      } else if (isQueueAvailable()) {
        // Save-first pattern: enqueue to offline queue.
        // The queue consumer handles upload + transcription + turn submission.
        // Show brief transcribing state for UX continuity.
        if (mountedRef.current) setIsTranscribing(true);
        try {
          await enqueueRecording(uri, recordingDuration);
        } catch {
          // Queue enqueue failed — fall back to direct upload
          log.warn('Queue enqueue failed, falling back to direct upload');
          await directUpload(uri, recordingDuration);
          return;
        } finally {
          if (mountedRef.current) setIsTranscribing(false);
        }
      } else {
        // Graceful degradation: queue not initialized, use direct upload
        await directUpload(uri, recordingDuration);
      }
    } finally {
      isProcessingRef.current = false;
    }
  }, [localTranscribe, isQueueAvailable, enqueueRecording, directUpload]);

  const startRecording = useCallback(async () => {
    if (isRecording || isStartingRef.current) return;

    // Guard: don't start voice recording while a meeting recording is active.
    // iOS AVAudioSession is a singleton — only one active recording at a time.
    if (useActiveRecordingStore.getState().isActive) {
      log.warn('Voice recording blocked — meeting recording is active');
      if (mountedRef.current) setError('Meeting recording in progress');
      return;
    }

    isStartingRef.current = true;
    setError(null);

    try {
      // Disk-space preflight — same 200MB threshold used by meeting recording
      const diskCheck = await checkSufficientDiskSpace();
      if (!diskCheck.ok) {
        if (mountedRef.current) setError('Not enough storage. Free up at least 200MB before recording.');
        isStartingRef.current = false;
        return;
      }

      const { granted } = await requestRecordingPermissionsAsync();
      if (!mountedRef.current) return; // Component unmounted during permission request
      if (!granted) {
        if (mountedRef.current) setError('Microphone access denied. Check your device settings.');
        return;
      }

      // Pin provider at recording start — determines transcription route
      try {
        const provider = await getMobileVoiceProvider();
        if (provider === 'local-moonshine') {
          const disabled = await shouldDisableLocalStt();
          const modelReady = !disabled && await isMoonshineModelReady();
          pinnedProviderRef.current = modelReady ? 'local-moonshine' : 'cloud';
        } else {
          pinnedProviderRef.current = 'cloud';
        }
      } catch {
        // Default to cloud on any error reading preferences
        pinnedProviderRef.current = 'cloud';
      }

      await configureForRecording();
      if (!mountedRef.current) return; // Component unmounted during audio mode setup

      await recorder.prepareToRecordAsync();
      if (!mountedRef.current) return; // Component unmounted during prepare
      recorder.record();
      recordingStartTimeRef.current = Date.now();
      if (mountedRef.current) setIsRecording(true);
    } catch (err) {
      log.error('Failed to start recording', { err: err instanceof Error ? err.message : String(err) });
      if (mountedRef.current) setError('Could not start recording.');
    } finally {
      isStartingRef.current = false;
    }
  }, [isRecording, recorder]);

  const stopRecording = useCallback(() => {
    if (!isRecording) return;

    if (mountedRef.current) {
      setIsRecording(false);
    }

    // Check minimum duration before stopping
    const recordingDuration = recordingStartTimeRef.current
      ? Date.now() - recordingStartTimeRef.current
      : 0;

    void recorder.stop().then(() => {
      // If the recording status event doesn't fire (e.g. on some platforms),
      // process from the recorder's URI as fallback
      const uri = recorder.uri;
      if (uri && recordingDuration >= MIN_RECORDING_DURATION_MS) {
        // Analytics: UI recording-stop completed (client-origin). The
        // transcription RESULT ("STT Transcription Completed") is emitted by
        // core on the cloud instance — NOT mirrored here. Duration only, no
        // audio/transcript content. No-op until analytics initialises.
        analyticsTracking.voiceRecordingCompleted({ durationMs: recordingDuration });
        void processRecording(uri);
      } else if (recordingDuration < MIN_RECORDING_DURATION_MS) {
        recordingStartTimeRef.current = null;
      }
    }).catch(() => {
      if (mountedRef.current) {
        setIsRecording(false);
        setError('Recording failed. Try again.');
      }
      recordingStartTimeRef.current = null;
      isProcessingRef.current = false;
    });
  }, [isRecording, recorder, processRecording]);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      void startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  // Cleanup on unmount — defer native calls to avoid TurboModule exceptions
  // during React's synchronous unmount phase. All native calls are combined
  // into a single microtask and sequenced: stop recording first, then reset
  // audio mode, so they don't race each other.
  useEffect(() => {
    return () => {
      deferNativeCleanup(async () => {
        try {
          if (recorder.isRecording) {
            await recorder.stop();
          }
        } catch (e) {
          ignoreBestEffortCleanup(e, {
            operation: 'useMobileVoiceRecording.unmount.stopRecorder',
            reason: 'native recorder may already be deallocated during unmount',
            severity: 'warn',
          });
        }
        // Only reset audio mode if no meeting recording is active.
        // Setting allowsRecording: false would corrupt the meeting recording's
        // audio session (iOS AVAudioSession is a singleton).
        if (!useActiveRecordingStore.getState().isActive) {
          try {
            await configureForIdle();
          } catch (e) {
            ignoreBestEffortCleanup(e, {
              operation: 'useMobileVoiceRecording.unmount.configureForIdle',
              reason: 'audio session cleanup is best-effort during unmount',
              severity: 'warn',
            });
          }
        }
      });
    };
  }, []);

  return {
    isRecording,
    isTranscribing,
    error,
    startRecording,
    stopRecording,
    toggleRecording,
  };
}
