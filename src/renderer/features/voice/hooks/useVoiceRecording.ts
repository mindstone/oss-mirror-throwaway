import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BreadcrumbEntry, RendererLogPayload } from '@shared/types';
import { tracking } from '@renderer/src/tracking';
import { DEFAULT_VOICE_STATUS } from '@renderer/constants';
import { useTimeoutRef } from '@renderer/hooks/useTimeoutRef';
import { useOnlineStatus } from '@renderer/hooks/useOnlineStatus';
import { useAudioLevelMeter } from './useAudioLevelMeter';
import { convertBlobToWav, needsConversionForLocalStt } from '../utils/audioConversion';
import { calculateSttCost } from '@shared/utils/sttPricingCalculator';

type EmitLogPayload = Omit<RendererLogPayload, 'source' | 'breadcrumbs'> & {
  breadcrumbs?: BreadcrumbEntry[];
};

type UseVoiceRecordingOptions = {
  missingConfiguration: boolean;
  /** Local STT model not yet installed (downloading or missing) — blocks recording start */
  localModelNotReady: boolean;
  isStopping: boolean;
  isSpeaking: boolean;
  currentSessionId: string;
  emitLog: (payload: EmitLogPayload) => void;
  recordBreadcrumb: (breadcrumb: BreadcrumbEntry) => void;
  showToast: (options: { title: string }) => void;
  submitVoicePrompt: (text: string, sessionId: string) => Promise<void>;
  setAgentError: (value: string | null) => void;
  handleVoiceRunFailure: (message: string) => void;
  stopSpeech: () => void;
};

type UseVoiceRecordingResult = {
  recording: boolean;
  voiceHint: string;
  setVoiceHint: React.Dispatch<React.SetStateAction<string>>;
  voiceGuardTriggered: boolean;
  isVoiceMode: boolean;
  setVoiceMode: (value: boolean) => void;
  autoSpeak: boolean;
  setAutoSpeak: (value: boolean) => void;
  mediaRecorder: MediaRecorder | null;
  computedVoiceHint: string;
  toggleRecording: () => void;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  cancelRecording: () => void;
  /** Normalized audio level from 0 (silence) to 1 (loud), updated during recording */
  audioLevel: number;
};

export const useVoiceRecording = (options: UseVoiceRecordingOptions): UseVoiceRecordingResult => {
  const {
    missingConfiguration,
    localModelNotReady,
    isStopping,
    isSpeaking,
    currentSessionId,
    emitLog,
    recordBreadcrumb,
    showToast,
    submitVoicePrompt,
    setAgentError,
    handleVoiceRunFailure,
    stopSpeech
  } = options;

  const [recording, setRecording] = useState(false);
  const [voiceHint, setVoiceHint] = useState(DEFAULT_VOICE_STATUS);
  const [voiceGuardTriggered, setVoiceGuardTriggered] = useState(false);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);

  // Audio level monitoring for visual feedback
  const { level: audioLevel } = useAudioLevelMeter(activeStream);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const justStoppedSpeechRef = useRef(false);
  const justStoppedSpeechTimer = useTimeoutRef();
  const isStartingRef = useRef(false);
  const recordingGenerationRef = useRef(0);
  const recordingStartTimeRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  // Capture sessionId at recording START so transcripts go to the correct conversation
  // even if user switches sessions during transcription
  const recordingSessionIdRef = useRef<string | null>(null);

  // Minimum recording duration in milliseconds (to prevent accidental taps)
  const MIN_RECORDING_DURATION_MS = 500;

  const startRecording = useCallback(async () => {
    // Synchronous guard to prevent race conditions from rapid clicks/calls
    if (mediaRecorderRef.current || isStartingRef.current) {
      return;
    }

    if (missingConfiguration) {
      setVoiceGuardTriggered(true);
      setVoiceHint('Configure workspace and API keys before speaking.');
      recordBreadcrumb({ type: 'voice', message: 'recording-blocked', timestamp: Date.now() });
      emitLog({
        level: 'warn',
        message: 'Voice recording blocked due to missing configuration',
        timestamp: Date.now()
      });
      return;
    }

    if (localModelNotReady) {
      setVoiceGuardTriggered(true);
      setVoiceHint('Voice model is still downloading \u2014 it\u2019ll be ready in a moment.');
      recordBreadcrumb({ type: 'voice', message: 'recording-blocked-model', timestamp: Date.now() });
      emitLog({
        level: 'warn',
        message: 'Voice recording blocked: local STT model not ready',
        timestamp: Date.now()
      });
      return;
    }

    if (isStopping) {
      showToast({ title: 'Stop in progress… please wait' });
      emitLog({
        level: 'info',
        message: 'Voice input blocked while stop is pending',
        timestamp: Date.now()
      });
      return;
    }

    // Interrupt TTS if speaking
    if (isSpeaking) {
      stopSpeech();
      justStoppedSpeechRef.current = true;
      justStoppedSpeechTimer.set(() => {
        justStoppedSpeechRef.current = false;
      }, 750);
    }

    isStartingRef.current = true;
    cancelledRef.current = false;
    const generation = ++recordingGenerationRef.current;

    try {
      recordBreadcrumb({ type: 'voice', message: 'start-recording', timestamp: Date.now() });
      setVoiceGuardTriggered(false);
      setAgentError(null);
      setVoiceHint('Listening… tap to stop');

      // If we just stopped speech, wait briefly so we don't capture the TTS tail
      if (justStoppedSpeechRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }

      // Check if stopRecording was called during the delay
      if (generation !== recordingGenerationRef.current) {
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Check if stopRecording was called during getUserMedia
      if (generation !== recordingGenerationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      // Start level monitoring for visual feedback
      setActiveStream(stream);

      // Use WebM with Opus codec for efficient speech compression.
      // Opus typically produces ~240KB for 60s of audio (vs ~24MB uncompressed),
      // well under OpenAI Whisper's 25MB limit.
      // For local STT, we convert WebM->WAV in the stop handler before transcription.
      const preferredMimeType = 'audio/webm;codecs=opus';
      const mimeTypeOptions = MediaRecorder.isTypeSupported(preferredMimeType) 
        ? { mimeType: preferredMimeType } 
        : undefined;
      
      // Wrap MediaRecorder creation to ensure stream cleanup on failure
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, mimeTypeOptions);
      } catch (recorderError) {
        // Clean up stream if MediaRecorder creation fails (prevents stuck mic indicator)
        stream.getTracks().forEach((track) => track.stop());
        setActiveStream(null);
        throw recorderError;
      }
      audioChunksRef.current = [];

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      });

      // Handle MediaRecorder errors (permission revoked, hardware issues, etc.)
      recorder.addEventListener('error', (event) => {
        const errorEvent = event as Event & { error?: DOMException };
        const errorName = errorEvent.error?.name || 'UnknownError';
        const errorMessage = errorEvent.error?.message || 'Recording failed unexpectedly';
        
        emitLog({
          level: 'error',
          message: 'MediaRecorder error during recording',
          context: { errorName, errorMessage },
          timestamp: Date.now()
        });
        
        // Clean up and notify user
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        setMediaRecorder(null);
        setRecording(false);
        setActiveStream(null);
        audioChunksRef.current = [];
        recordingStartTimeRef.current = null;
        
        handleVoiceRunFailure(`Recording failed: ${errorName === 'SecurityError' ? 'Microphone access was revoked' : errorMessage}`);
      });

      // Handle track ended (microphone disconnected, permission revoked mid-recording)
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.addEventListener('ended', () => {
          // Only handle if we're still actively recording (track.stop() doesn't fire this)
          if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            emitLog({
              level: 'warn',
              message: 'Audio track ended unexpectedly (microphone disconnected or permission revoked)',
              timestamp: Date.now()
            });
            
            // Trigger normal stop to process whatever audio we captured
            // Note: We call requestData + stop directly here (not stopRecording) because:
            // 1. The 'stop' event listener already handles transcription processing
            // 2. We just need to reset UI state that stopRecording normally handles
            if ((mediaRecorderRef.current.state as string) !== 'inactive') {
              mediaRecorderRef.current.requestData();
              mediaRecorderRef.current.stop();
            }
            // Reset UI state (stopRecording does this, but we bypassed it)
            mediaRecorderRef.current = null;
            setMediaRecorder(null);
            setRecording(false);
            setActiveStream(null);
          }
        });
      }

      recorder.addEventListener('stop', async () => {
        const recordingDurationMs = recordingStartTimeRef.current 
          ? Date.now() - recordingStartTimeRef.current 
          : 0;

        // Check if recording was cancelled - skip all processing
        if (cancelledRef.current) {
          cancelledRef.current = false;
          audioChunksRef.current = [];
          recordingStartTimeRef.current = null;
          setVoiceHint(DEFAULT_VOICE_STATUS);
          return;
        }

        const transcriptionStartTime = Date.now();
        
        try {
          // Check recording duration
          const recordingDuration = recordingStartTimeRef.current
            ? Date.now() - recordingStartTimeRef.current
            : 0;
          recordingStartTimeRef.current = null;

          // Check if recording was too short - treat as accidental tap, reset silently
          if (recordingDuration < MIN_RECORDING_DURATION_MS) {
            emitLog({
              level: 'debug',
              message: 'Voice recording too short - silent reset',
              context: { durationMs: recordingDuration, minDurationMs: MIN_RECORDING_DURATION_MS },
              timestamp: Date.now()
            });
            return;
          }

          setVoiceHint('Processing audio…');
          const mimeType = recorder.mimeType || 'audio/webm';
          const chunksCount = audioChunksRef.current.length;
          const blob = new Blob(audioChunksRef.current, { type: mimeType });
          const blobSize = blob.size;
          // Don't clear chunks yet - keep them until transcription succeeds

          // Log audio details for debugging
          emitLog({
            level: 'debug',
            message: 'Sending audio for transcription',
            context: { mimeType, chunksCount, blobSize, durationMs: recordingDuration },
            timestamp: Date.now()
          });

          // Check if audio blob is too small (likely no audio captured)
          if (blobSize < 1000) {
            handleVoiceRunFailure('No audio captured. Check your microphone permissions and try again.');
            emitLog({
              level: 'warn',
              message: 'Audio blob too small - likely no audio captured',
              context: { mimeType, blobSize, chunksCount },
              timestamp: Date.now()
            });
            return;
          }

          // Hoist buffer outside try so it's accessible in catch for saving
          let buffer: ArrayBuffer;
          try {
            buffer = await blob.arrayBuffer();
          } catch {
            handleVoiceRunFailure("Couldn't process that audio recording");
            return;
          }

          // For local STT, convert WebM to WAV (audio-decode doesn't support WebM container)
          // Cloud providers (OpenAI/ElevenLabs) accept WebM directly
          let audioToSend = buffer;
          let mimeTypeToSend = mimeType;
          const settings = await window.settingsApi.get();
          if (needsConversionForLocalStt(settings.voice.provider, mimeType)) {
            try {
              setVoiceHint('Converting audio…');
              const converted = await convertBlobToWav(blob);
              audioToSend = converted.buffer;
              mimeTypeToSend = converted.mimeType;
              emitLog({
                level: 'debug',
                message: 'Converted WebM to WAV for local STT',
                context: { originalMimeType: mimeType, newMimeType: mimeTypeToSend },
                timestamp: Date.now()
              });
            } catch (conversionError) {
              // If conversion fails, surface error rather than sending WebM to local STT
              // (which would deterministically fail with "Cannot detect audio format")
              const conversionMessage = conversionError instanceof Error ? conversionError.message : 'Audio conversion failed';
              handleVoiceRunFailure(`Local transcription failed: ${conversionMessage}. Try switching to a cloud provider.`);
              emitLog({
                level: 'error',
                message: 'WebM to WAV conversion failed for local STT',
                context: { error: conversionMessage, mimeType },
                timestamp: Date.now()
              });
              return;
            }
          }

          // Reuse the local-STT WAV conversion for the pending file if available,
          // otherwise convert now (Web Audio API handles WebM reliably).
          // Non-fatal: if conversion fails, main process saves raw audio format.
          let pendingAudioWav: ArrayBuffer | undefined;
          if (mimeTypeToSend === 'audio/wav') {
            // Local STT already converted to WAV — reuse it, don't convert twice
            pendingAudioWav = audioToSend;
          } else {
            try {
              const wavResult = await convertBlobToWav(blob);
              pendingAudioWav = wavResult.buffer;
            } catch {
              // Non-fatal: main process will fall back to saving raw audio format
            }
          }

          try {
            // Pass source and sessionId for safe transcribe pattern (main process saves audio before API call)
            const transcript = await window.voiceApi.transcribe({
              audio: audioToSend,
              mimeType: mimeTypeToSend,
              durationMs: recordingDuration,
              source: 'voice-mode',
              sessionId: recordingSessionIdRef.current ?? undefined,
              pendingAudioWav,
            });

            const transcriptionLatencyMs = Date.now() - transcriptionStartTime;

            const voiceProvider = settings.voice.provider;
            const voiceModel = settings.voice.model;

            if (!transcript.trim()) {
              tracking.voice.transcriptionError('empty_result', 'EMPTY_TRANSCRIPT', voiceProvider, recordingDurationMs);
              // Use subtle toast for empty transcript - not an error state
              showToast({ title: "Didn't catch that. Try again?" });
              emitLog({
                level: 'info',
                message: 'Voice transcription returned empty result',
                context: { mimeType, blobSize, durationMs: recordingDuration },
                timestamp: Date.now()
              });
              audioChunksRef.current = [];
              return;
            }

            const wordCount = transcript.trim().split(/\s+/).length;
            const costUsd = calculateSttCost(voiceModel, recordingDuration);
            tracking.voice.transcriptionCompleted(transcriptionLatencyMs, wordCount, voiceProvider, recordingDurationMs, {
              costUsd,
              model: voiceModel,
              source: 'voice-mode',
              inputSizeBytes: blobSize,
            });

            // Success - now safe to clear audio chunks
            audioChunksRef.current = [];
            // Pass captured sessionId so transcript goes to correct conversation
            const capturedSessionId = recordingSessionIdRef.current ?? currentSessionId;
            await submitVoicePrompt(transcript.trim(), capturedSessionId);
          } catch (error) {
            const rawMessage = error instanceof Error ? error.message : String(error);

            // Extract error category from prefixed message (format: [category]message)
            // Electron IPC wraps errors with "Error invoking remote method '...': Error: "
            // so we search anywhere in the string, not just the start
            const categoryMatch = rawMessage.match(/\[(temporary|billing|auth|network|provider-error)\]/);
            const errorCategory = categoryMatch ? categoryMatch[1] : undefined;
            // Strip both the Electron IPC wrapper and the category prefix for display
            const strippedMessage = rawMessage
              .replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
              .replace(/\[(temporary|billing|auth|network|provider-error)\]/, '')
              .trim();

            // Classify raw CLI errors into user-friendly messages (defense-in-depth for FOX-3119)
            const lc = strippedMessage.toLowerCase();
            const displayMessage =
              lc === 'terminated' || lc.includes('was killed') || lc.includes('signal')
                ? 'Transcription was interrupted. Please try again.'
                : lc.includes('error during execution') || lc.includes('non-zero exit')
                  ? 'Transcription failed unexpectedly. Please try again \u2014 if this persists, check Settings \u2192 Voice.'
                  : strippedMessage;

            // Use generic error code for analytics, don't leak provider error messages
            const errorCode = lc.includes('network') ? 'NETWORK_ERROR' 
              : lc.includes('timeout') ? 'TIMEOUT'
              : 'TRANSCRIPTION_FAILED';
            tracking.voice.transcriptionError('api_error', errorCode, settings.voice.provider, recordingDurationMs);

            // Audio is already saved by main process (safe transcribe pattern)
            // Surface actual error so users know what went wrong
            showToast({ title: displayMessage });
            emitLog({
              level: 'info',
              message: 'Voice transcription failed - audio saved for retry by main process',
              context: { error: strippedMessage, errorCategory, mimeType, blobSize, sessionId: recordingSessionIdRef.current },
              timestamp: Date.now()
            });

            // Signal pending audio hook to refresh immediately so badge appears
            // Include error category so the popover can show category-specific messaging
            window.dispatchEvent(new CustomEvent('pending-audio-changed', {
              detail: errorCategory ? { errorCategory } : undefined,
            }));

            // Clear chunks (audio is saved to disk by main process)
            audioChunksRef.current = [];
          }
        } finally {
          setVoiceHint(DEFAULT_VOICE_STATUS);
        }
      });

      mediaRecorderRef.current = recorder;
      setMediaRecorder(recorder);
      recordingStartTimeRef.current = Date.now();
      // Capture sessionId at recording START - this ensures transcript goes to the correct
      // conversation even if user switches sessions during transcription
      recordingSessionIdRef.current = currentSessionId;
      recorder.start();
      setRecording(true);
      tracking.voice.recordingStarted(isVoiceMode ? 'voiceMode' : 'textMode', 'tap');

      // Report voice input as user engagement (voice is a clear user action)
      import('@renderer/hooks/useUserActivityTracking').then(({ pingUserActivityForVoice }) => {
        pingUserActivityForVoice();
      });

      emitLog({
        level: 'info',
        message: 'Voice recording started',
        timestamp: Date.now()
      });

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAgentError(message);
      setVoiceHint(DEFAULT_VOICE_STATUS);
      setRecording(false);
      emitLog({
        level: 'error',
        message: "Couldn't start voice recording.",
        context: { error: message },
        timestamp: Date.now()
      });
    } finally {
      // Only reset if we're still the current generation (not superseded by stop/new start)
      if (generation === recordingGenerationRef.current) {
        isStartingRef.current = false;
      }
    }
  }, [currentSessionId, emitLog, handleVoiceRunFailure, isVoiceMode, isSpeaking, isStopping, justStoppedSpeechTimer, localModelNotReady, missingConfiguration, recordBreadcrumb, setAgentError, showToast, stopSpeech, submitVoicePrompt]);

  const stopRecording = useCallback(() => {
    // Increment generation to cancel any in-flight startRecording operations
    recordingGenerationRef.current++;
    isStartingRef.current = false;

    const recorder = mediaRecorderRef.current;
    if (!recorder) return;
    if (recorder.state !== 'inactive') {
      // Flush any buffered audio data before stopping to avoid cutting off last words
      recorder.requestData();
      recorder.stop();
    }
    recorder.stream.getTracks().forEach((track) => track.stop());
    mediaRecorderRef.current = null;
    setMediaRecorder(null);
    setRecording(false);
    setActiveStream(null); // Stop level monitoring
    const recordingDurationMs = recordingStartTimeRef.current 
      ? Date.now() - recordingStartTimeRef.current 
      : 0;
    tracking.voice.recordingStopped(recordingDurationMs, 'user');
    recordBreadcrumb({ type: 'voice', message: 'stop-recording', timestamp: Date.now() });
  }, [recordBreadcrumb]);

  const cancelRecording = useCallback(() => {
    // Increment generation to cancel any in-flight startRecording operations
    recordingGenerationRef.current++;
    isStartingRef.current = false;
    cancelledRef.current = true;

    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      // No active recording - just reset state
      cancelledRef.current = false;
      setVoiceHint(DEFAULT_VOICE_STATUS);
      setActiveStream(null); // Stop level monitoring
      return;
    }

    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
    recorder.stream.getTracks().forEach((track) => track.stop());
    mediaRecorderRef.current = null;
    setMediaRecorder(null);
    setRecording(false);
    setActiveStream(null); // Stop level monitoring

    const recordingDurationMs = recordingStartTimeRef.current 
      ? Date.now() - recordingStartTimeRef.current 
      : 0;
    tracking.voice.recordingCancelled(recordingDurationMs);
    recordBreadcrumb({ type: 'voice', message: 'cancel-recording', timestamp: Date.now() });
    emitLog({
      level: 'info',
      message: 'Voice recording cancelled',
      context: { durationMs: recordingDurationMs },
      timestamp: Date.now()
    });
  }, [emitLog, recordBreadcrumb]);

  const toggleRecording = useCallback(() => {
    if (recording) {
      stopRecording();
    } else {
      void startRecording();
    }
  }, [recording, startRecording, stopRecording]);

  useEffect(() => {
    if (!missingConfiguration && !localModelNotReady) {
      setVoiceGuardTriggered(false);
      setVoiceHint(DEFAULT_VOICE_STATUS);
    }
  }, [missingConfiguration, localModelNotReady]);

  useEffect(() => {
    return () => {
      cancelRecording();
    };
  }, [cancelRecording]);

  const computedVoiceHint = useMemo(() => {
    if (isVoiceMode && !recording && !isSpeaking) {
      return "🎙️ Voice mode active - I'm listening";
    }
    return voiceHint;
  }, [isVoiceMode, isSpeaking, recording, voiceHint]);

  // Auto-retry pending audio when coming back online
  const isOnline = useOnlineStatus();
  const hasRetriedRef = useRef(false);

  useEffect(() => {
    if (!isOnline) {
      // Reset retry flag when going offline so we retry again when back online
      hasRetriedRef.current = false;
      return;
    }

    if (hasRetriedRef.current) return;
    hasRetriedRef.current = true;

    const retryPending = async () => {
      try {
        const pending = await window.voiceApi.getPendingAudio();
        if (pending.length === 0) return;

        emitLog({
          level: 'info',
          message: `Found ${pending.length} pending audio file(s), attempting retry`,
          timestamp: Date.now(),
        });

        // Only handle voice-mode files here - these need to be submitted to conversations
        // inline-mic files are handled by usePendingAudioCount which creates draft sessions
        const voiceModeFiles = pending.filter(f => f.source === 'voice-mode');

        for (const file of voiceModeFiles) {
          try {
            const result = await window.voiceApi.retryPendingAudio({ filePath: file.filePath });

            if (result.success && result.transcript) {
              // Voice-mode: auto-submit to conversation
              // Submit first, then delete only after submit succeeds
              // This ensures we don't lose audio if submit fails
              try {
                // Use stored sessionId if available, fall back to current session for legacy files
                await submitVoicePrompt(result.transcript, file.sessionId ?? currentSessionId);
                await window.voiceApi.deletePendingAudio({ filePath: file.filePath });
                showToast({ title: 'Your recording was transcribed!' });

                emitLog({
                  level: 'info',
                  message: 'Successfully recovered pending audio transcription',
                  context: { filePath: file.filePath, source: file.source },
                  timestamp: Date.now(),
                });
              } catch (submitError) {
                // Submit failed - keep file for next retry
                emitLog({
                  level: 'warn',
                  message: 'Recovered transcript but failed to submit - keeping file',
                  context: { filePath: file.filePath, error: String(submitError) },
                  timestamp: Date.now(),
                });
              }
            }
          } catch (retryError) {
            // Transcription failed - keep file for next retry
            emitLog({
              level: 'warn',
              message: 'Failed to retry voice-mode pending audio',
              context: { filePath: file.filePath, error: String(retryError) },
              timestamp: Date.now(),
            });
          }
        }
      } catch (error) {
        emitLog({
          level: 'warn',
          message: 'Failed to retry pending audio',
          context: { error: String(error) },
          timestamp: Date.now(),
        });
      }
    };

    void retryPending();
  }, [isOnline, currentSessionId, emitLog, showToast, submitVoicePrompt]);

  return {
    recording,
    voiceHint,
    setVoiceHint,
    voiceGuardTriggered,
    isVoiceMode,
    setVoiceMode: setIsVoiceMode,
    autoSpeak,
    setAutoSpeak,
    mediaRecorder,
    computedVoiceHint,
    toggleRecording,
    startRecording,
    stopRecording,
    cancelRecording,
    audioLevel
  };
};
