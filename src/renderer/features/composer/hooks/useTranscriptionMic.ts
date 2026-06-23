import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioLevelMeter } from '@renderer/features/voice/hooks/useAudioLevelMeter';
import { convertBlobToWav, needsConversionForLocalStt } from '@renderer/features/voice/utils/audioConversion';
import { tracking } from '@renderer/src/tracking';
import { calculateSttCost } from '@shared/utils/sttPricingCalculator';

export type TranscriptionValidationReason =
  | 'too_short'      // Recording was shorter than minDurationMs
  | 'no_audio'       // Blob size was smaller than minBlobSizeBytes
  | 'empty_result';  // Transcription API returned empty/whitespace

export type UseTranscriptionMicOptions = {
  /** Current session ID - captured at recording start for correct message routing. */
  currentSessionId: string;
  /** Called with transcript text and the session ID that was active when recording started. */
  onTranscript: (text: string, sessionId: string) => void;
  /** Called when double-click-to-send flow completes: transcript is pasted AND should be sent. */
  onTranscriptAndSend?: (text: string, sessionId: string) => void;
  onError?: (message: string) => void;
  /** Minimum recording duration in ms. If recording is shorter, onValidationFailed is called. */
  minDurationMs?: number;
  /** Minimum blob size in bytes. If blob is smaller, onValidationFailed is called. */
  minBlobSizeBytes?: number;
  /** Called when recording starts successfully. */
  onRecordingStarted?: () => void;
  /** Called when validation fails (too short, no audio, empty result). */
  onValidationFailed?: (
    reason: TranscriptionValidationReason,
    context?: { durationMs?: number; blobSize?: number }
  ) => void;
  /** Called to mark session as having pending recording (prevents empty session discard). */
  onMarkPendingRecording?: (sessionId: string) => void;
  /** Called to clear pending recording marker after transcription completes/fails. */
  onClearPendingRecording?: (sessionId: string) => void;
};

export type UseTranscriptionMicResult = {
  isRecording: boolean;
  isProcessing: boolean;
  toggleRecording: () => void;
  /** Stop recording and send the transcript immediately (double-click flow). */
  stopAndSend: () => void;
  /** Normalized audio level from 0 (silence) to 1 (loud), updated during recording */
  audioLevel: number;
};

/**
 * Hook for transcription-only voice input.
 * Tap to start recording, tap again to stop and transcribe.
 * The transcribed text is passed to onTranscript (not auto-submitted).
 * 
 * Supports validation options (minDurationMs, minBlobSizeBytes) and lifecycle callbacks.
 */
export const useTranscriptionMic = ({
  currentSessionId,
  onTranscript,
  onTranscriptAndSend,
  onError,
  minDurationMs = 0,
  minBlobSizeBytes = 0,
  onRecordingStarted,
  onValidationFailed,
  onMarkPendingRecording,
  onClearPendingRecording
}: UseTranscriptionMicOptions): UseTranscriptionMicResult => {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);

  // Audio level monitoring for visual feedback
  const { level: audioLevel } = useAudioLevelMeter(activeStream);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingStartTimeRef = useRef<number | null>(null);
  // Flag to indicate whether the next stop should trigger send
  const shouldSendOnStopRef = useRef(false);
  // Capture session ID at recording start for correct message routing
  const recordingSessionIdRef = useRef<string | null>(null);
  // Track mounted state to guard against orphaned streams and post-unmount state updates
  const mountedRef = useRef(true);
  // Track whether stopRecording is in-flight (prevents cleanup from clearing chunks mid-processing)
  const isStoppingRef = useRef(false);

  const releaseStream = useCallback(() => {
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
      setActiveStream(null);
    }
  }, []);

  const stopRecording = useCallback(async () => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      shouldSendOnStopRef.current = false;
      releaseStream();
      setIsRecording(false);
      if (recordingSessionIdRef.current) {
        onClearPendingRecording?.(recordingSessionIdRef.current);
      }
      return;
    }

    isStoppingRef.current = true;

    // Capture the shouldSend flag now and reset it
    const shouldSend = shouldSendOnStopRef.current;
    shouldSendOnStopRef.current = false;

    // Calculate duration before stopping
    const durationMs = recordingStartTimeRef.current
      ? Date.now() - recordingStartTimeRef.current
      : 0;
    recordingStartTimeRef.current = null;

    // Create a promise that resolves when the recorder stops
    const stopPromise = new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
    });

    recorder.stop();
    await stopPromise;

    // Capture chunks immediately after stop event, before any cleanup can clear them
    const chunks = [...audioChunksRef.current];
    audioChunksRef.current = [];

    // Stop the media stream tracks
    releaseStream();

    setIsRecording(false);
    tracking.voice.recordingStopped(durationMs, 'user');

    // Check minimum duration
    if (minDurationMs > 0 && durationMs < minDurationMs) {
      mediaRecorderRef.current = null;
      isStoppingRef.current = false;
      if (recordingSessionIdRef.current) {
        onClearPendingRecording?.(recordingSessionIdRef.current);
      }
      onValidationFailed?.('too_short', { durationMs });
      return;
    }

    if (chunks.length === 0) {
      mediaRecorderRef.current = null;
      isStoppingRef.current = false;
      if (recordingSessionIdRef.current) {
        onClearPendingRecording?.(recordingSessionIdRef.current);
      }
      return;
    }

    setIsProcessing(true);

    const mimeType = recorder.mimeType || 'audio/webm';
    const blob = new Blob(chunks, { type: mimeType });

    let voiceProvider = 'unknown';
    let voiceModel = '';

    try {
      // Check minimum blob size
      if (minBlobSizeBytes > 0 && blob.size < minBlobSizeBytes) {
        onValidationFailed?.('no_audio', { blobSize: blob.size });
        return;
      }

      const buffer = await blob.arrayBuffer();

      // For local STT, convert WebM to WAV (audio-decode doesn't support WebM container)
      // Cloud providers (OpenAI/ElevenLabs) accept WebM directly
      let audioToSend = buffer;
      let mimeTypeToSend = mimeType;
      const settings = await window.settingsApi.get();
      voiceProvider = settings.voice.provider;
      voiceModel = settings.voice.model;
      if (needsConversionForLocalStt(voiceProvider, mimeType)) {
        try {
          const converted = await convertBlobToWav(blob);
          audioToSend = converted.buffer;
          mimeTypeToSend = converted.mimeType;
        } catch (conversionError) {
          const message = conversionError instanceof Error ? conversionError.message : 'Audio conversion failed';
          onError?.(`Local transcription failed: ${message}. Try switching to a cloud provider.`);
          return;
        }
      }

      // Reuse the local-STT WAV conversion for the pending file if available,
      // otherwise convert now (Web Audio API handles WebM reliably).
      // Non-fatal: if conversion fails, main process saves raw audio format.
      let pendingAudioWav: ArrayBuffer | undefined;
      if (mimeTypeToSend === 'audio/wav') {
        pendingAudioWav = audioToSend;
      } else {
        try {
          const wavResult = await convertBlobToWav(blob);
          pendingAudioWav = wavResult.buffer;
        } catch {
          // Non-fatal: main process will fall back to saving raw audio format
        }
      }

      // Pass source and sessionId for safe transcribe pattern (main process saves audio before API call)
      const transcriptionStartTime = Date.now();
      const transcript = await window.voiceApi.transcribe({
        audio: audioToSend,
        mimeType: mimeTypeToSend,
        durationMs,
        source: 'inline-mic',
        sessionId: recordingSessionIdRef.current ?? undefined,
        pendingAudioWav,
      });

      const trimmed = transcript.trim();
      if (trimmed) {
        const wordCount = trimmed.split(/\s+/).length;
        const transcriptionLatencyMs = Date.now() - transcriptionStartTime;
        const costUsd = calculateSttCost(voiceModel, durationMs);
        tracking.voice.transcriptionCompleted(transcriptionLatencyMs, wordCount, voiceProvider, durationMs, {
          costUsd,
          model: voiceModel,
          source: 'inline-mic',
          inputSizeBytes: blob.size,
        });
        
        // Use the captured session ID from when recording started
        const capturedSessionId = recordingSessionIdRef.current;
        if (!capturedSessionId) {
          onError?.('Recording session expired before transcript could be delivered.');
          return;
        }
        if (shouldSend && onTranscriptAndSend) {
          onTranscriptAndSend(trimmed, capturedSessionId);
        } else {
          onTranscript(trimmed, capturedSessionId);
        }
      } else {
        tracking.voice.transcriptionError('empty_result', 'EMPTY_TRANSCRIPT', voiceProvider, durationMs);
        onValidationFailed?.('empty_result');
      }
    } catch (error) {
      // Audio is already saved by main process (safe transcribe pattern)
      const rawMessage = error instanceof Error ? error.message : String(error);

      // Extract error category from prefixed message (format: [category]message)
      // Electron IPC wraps errors with "Error invoking remote method '...': Error: "
      const categoryMatch = rawMessage.match(/\[(temporary|billing|auth|network|provider-error)\]/);
      const errorCategory = categoryMatch ? categoryMatch[1] : undefined;
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
            ? 'Transcription failed unexpectedly. Please try again — if this persists, check Settings \u2192 Voice.'
            : strippedMessage;

      const errorCode = lc.includes('network') ? 'NETWORK_ERROR' 
        : lc.includes('timeout') ? 'TIMEOUT'
        : 'TRANSCRIPTION_FAILED';
      tracking.voice.transcriptionError('api_error', errorCode, voiceProvider, durationMs);
      onError?.(displayMessage);
      // Signal pending audio hook to refresh immediately so badge appears
      // Include error category so the popover can show category-specific messaging
      window.dispatchEvent(new CustomEvent('pending-audio-changed', {
        detail: errorCategory ? { errorCategory } : undefined,
      }));
    } finally {
      isStoppingRef.current = false;
      if (mountedRef.current) {
        setIsProcessing(false);
      }
      mediaRecorderRef.current = null;
      if (recordingSessionIdRef.current) {
        onClearPendingRecording?.(recordingSessionIdRef.current);
      }
    }
  }, [onTranscript, onTranscriptAndSend, onError, onClearPendingRecording, minDurationMs, minBlobSizeBytes, onValidationFailed, releaseStream]);

  const startRecording = useCallback(async () => {
    try {
      // Guard: block recording when local STT model is still downloading.
      // Self-contained check so ALL consumers are protected without prop drilling.
      const currentSettings = await window.settingsApi.get();
      const provider = currentSettings.voice.provider;
      if (provider === 'local-parakeet' || provider === 'local-moonshine') {
        const modelId = provider === 'local-moonshine' ? 'moonshine-base' : undefined;
        const status = await window.localSttApi.modelStatus(modelId ? { modelId } : undefined);
        if (!status.installed) {
          onError?.(status.downloading
            ? 'Voice model is still downloading \u2014 it\u2019ll be ready in a moment.'
            : 'Voice model needs to be downloaded. Check Settings \u2192 Voice.');
          return;
        }
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // If component unmounted during getUserMedia, release the stream immediately
      if (!mountedRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      streamRef.current = stream;
      setActiveStream(stream);

      // Try OGG Opus format (audio-decode supports it), but Chromium/Electron doesn't
      // support OGG for MediaRecorder output, so this will fall back to WebM.
      // For local STT, we convert WebM->WAV in stopRecording() before transcription.
      const preferredMimeType = 'audio/ogg; codecs=opus';
      const mimeTypeOptions = MediaRecorder.isTypeSupported(preferredMimeType) 
        ? { mimeType: preferredMimeType } 
        : undefined;
      const recorder = new MediaRecorder(stream, mimeTypeOptions);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      });

      // Handle MediaRecorder errors (permission revoked, hardware issues, etc.)
      recorder.addEventListener('error', (event) => {
        const errorEvent = event as Event & { error?: DOMException };
        const errorName = errorEvent.error?.name || 'UnknownError';
        const errorMessage = errorEvent.error?.message || 'Recording failed unexpectedly';
        
        // Clean up
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        mediaRecorderRef.current = null;
        setActiveStream(null);
        setIsRecording(false);
        audioChunksRef.current = [];
        recordingStartTimeRef.current = null;
        
        onError?.(errorName === 'SecurityError' ? 'Microphone access was revoked' : errorMessage);
      });

      // Handle track ended (microphone disconnected, permission revoked mid-recording)
      // Bind to this specific recorder instance to avoid affecting a later recording
      const audioTrack = stream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.addEventListener('ended', () => {
          if (recorder.state !== 'inactive') {
            void stopRecording();
          }
        });
      }

      // Capture session ID at recording start for correct message routing
      recordingSessionIdRef.current = currentSessionId;
      // Mark session as having a pending recording (prevents empty session from being discarded)
      onMarkPendingRecording?.(currentSessionId);
      recorder.start();
      recordingStartTimeRef.current = Date.now();
      setIsRecording(true);
      tracking.voice.recordingStarted('textMode', 'tap');
      
      // Report voice input as user engagement (voice is a clear user action)
      import('@renderer/hooks/useUserActivityTracking').then(({ pingUserActivityForVoice }) => {
        pingUserActivityForVoice();
      });
      
      onRecordingStarted?.();
    } catch (error) {
      // Ensure stream is released even if MediaRecorder setup fails
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        setActiveStream(null);
      }
      const message = error instanceof Error ? error.message : String(error);
      onError?.(message);
      setIsRecording(false);
    }
  }, [currentSessionId, onError, onMarkPendingRecording, onRecordingStarted, stopRecording]);

  const toggleRecording = useCallback(() => {
    if (isProcessing) {
      return;
    }

    if (isRecording) {
      void stopRecording();
    } else {
      void startRecording();
    }
  }, [isRecording, isProcessing, startRecording, stopRecording]);

  const stopAndSend = useCallback(() => {
    if (!isRecording || isProcessing) {
      return;
    }
    // Set the flag before stopping so stopRecording knows to call onTranscriptAndSend
    shouldSendOnStopRef.current = true;
    void stopRecording();
  }, [isRecording, isProcessing, stopRecording]);

  // Cleanup on unmount to prevent MediaRecorder/stream leaks
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
      }
      // Always release stream tracks on unmount
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
        streamRef.current = null;
      }
      // Only clear chunks if stopRecording isn't mid-processing (prevents data loss)
      if (!isStoppingRef.current) {
        audioChunksRef.current = [];
      }
      mediaRecorderRef.current = null;
      recordingStartTimeRef.current = null;
    };
  }, []);

  return {
    isRecording,
    isProcessing,
    toggleRecording,
    stopAndSend,
    audioLevel
  };
};

