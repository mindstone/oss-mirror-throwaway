// cloud-client/src/hooks/useWebVoiceRecording.ts
// Web-native voice recording hook using MediaRecorder + cloud transcription.

import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribe } from '../cloudClient';
import { createLogger } from '../utils/logger';

const log = createLogger('useWebVoiceRecording');

// Audio level processing constants (matched from desktop useAudioLevelMeter)
const TARGET_FPS = 10;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
const SMOOTHING_FACTOR = 0.3;
const MIN_DB = -45;
const MAX_DB = -10;
const NOISE_GATE_DB = -40;
const MIN_RMS_THRESHOLD = 0.0001;
const MIN_RECORDING_DURATION_MS = 500;

export interface UseWebVoiceRecordingReturn {
  /** True while actively recording audio */
  isRecording: boolean;
  /** True while audio is being sent for transcription */
  isTranscribing: boolean;
  /** Normalized audio level from 0 (silence) to 1 (loud), updated during recording */
  audioLevel: number;
  /** Last error message, cleared on next recording start */
  error: string | null;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  toggleRecording: () => void;
}

export function useWebVoiceRecording(
  onTranscript: (text: string) => void,
  sessionId?: string,
): UseWebVoiceRecordingReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const smoothedLevelRef = useRef(0);
  const lastFrameTimeRef = useRef(0);
  const recordingStartTimeRef = useRef<number | null>(null);
  const isStartingRef = useRef(false);
  const mountedRef = useRef(true);
  // Capture sessionId at recording start so transcript goes to the right conversation
  const sessionIdRef = useRef(sessionId);
  // Capture onTranscript at recording start to avoid stale closures
  const onTranscriptRef = useRef(onTranscript);

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

  const cleanupAudioContext = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    analyserRef.current = null;
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setAudioLevel(0);
    smoothedLevelRef.current = 0;
  }, []);

  const updateAudioLevel = useCallback(() => {
    if (!analyserRef.current || !mountedRef.current) return;

    const now = performance.now();
    if (now - lastFrameTimeRef.current < FRAME_INTERVAL_MS) {
      rafIdRef.current = requestAnimationFrame(updateAudioLevel);
      return;
    }
    lastFrameTimeRef.current = now;

    const dataArray = new Uint8Array(analyserRef.current.fftSize);
    analyserRef.current.getByteTimeDomainData(dataArray);

    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const sample = (dataArray[i] - 128) / 128;
      sum += sample * sample;
    }
    const rms = Math.sqrt(sum / dataArray.length);
    const db = rms > MIN_RMS_THRESHOLD ? 20 * Math.log10(rms) : MIN_DB;
    const gatedDb = db < NOISE_GATE_DB ? MIN_DB : db;
    const rawLevel = Math.max(0, Math.min(1, (gatedDb - MIN_DB) / (MAX_DB - MIN_DB)));

    smoothedLevelRef.current =
      SMOOTHING_FACTOR * rawLevel + (1 - SMOOTHING_FACTOR) * smoothedLevelRef.current;

    setAudioLevel(smoothedLevelRef.current);
    rafIdRef.current = requestAnimationFrame(updateAudioLevel);
  }, []);

  const startRecording = useCallback(async () => {
    if (mediaRecorderRef.current || isStartingRef.current) return;
    isStartingRef.current = true;
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Setup audio level monitoring via Web Audio API
      try {
        const audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        sourceRef.current = source;
        lastFrameTimeRef.current = performance.now();
        rafIdRef.current = requestAnimationFrame(updateAudioLevel);
      } catch {
        // Audio level monitoring is non-critical — recording still works
        log.debug('AudioContext setup failed, recording without level meter');
      }

      // Prefer WebM/Opus, fall back to mp4 (Safari), then default
      const preferredMimeType = 'audio/webm;codecs=opus';
      const fallbackMimeType = 'audio/mp4';
      const mimeType = MediaRecorder.isTypeSupported(preferredMimeType)
        ? preferredMimeType
        : MediaRecorder.isTypeSupported(fallbackMimeType)
          ? fallbackMimeType
          : undefined;
      const mimeTypeOptions = mimeType ? { mimeType } : undefined;

      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, mimeTypeOptions);
      } catch {
        stream.getTracks().forEach((track) => track.stop());
        cleanupAudioContext();
        throw new Error('MediaRecorder creation failed');
      }
      audioChunksRef.current = [];

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data?.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      });

      recorder.addEventListener('stop', async () => {
        cleanupAudioContext();

        const recordingDuration = recordingStartTimeRef.current
          ? Date.now() - recordingStartTimeRef.current
          : 0;
        recordingStartTimeRef.current = null;

        // Ignore accidental taps
        if (recordingDuration < MIN_RECORDING_DURATION_MS) {
          log.debug('Recording too short, ignoring', { durationMs: recordingDuration });
          return;
        }

        const recorderMimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: recorderMimeType });
        audioChunksRef.current = [];

        if (blob.size < 1000) {
          if (mountedRef.current) setError('No audio captured. Check your microphone.');
          return;
        }

        if (mountedRef.current) setIsTranscribing(true);

        try {
          const transcript = await transcribe(blob, sessionIdRef.current);
          if (!transcript.trim()) {
            if (mountedRef.current) setError("Didn't catch that. Try again?");
            return;
          }
          if (mountedRef.current) onTranscriptRef.current(transcript.trim());
        } catch (err) {
          log.error('Transcription failed', { error: (err as Error).message });
          if (mountedRef.current) setError('Transcription failed. Try again.');
        } finally {
          if (mountedRef.current) setIsTranscribing(false);
        }
      });

      recorder.addEventListener('error', () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        cleanupAudioContext();
        if (mountedRef.current) {
          setIsRecording(false);
          setError('Recording failed unexpectedly.');
        }
      });

      mediaRecorderRef.current = recorder;
      recordingStartTimeRef.current = Date.now();
      recorder.start();
      if (mountedRef.current) setIsRecording(true);
      log.info('Recording started');
    } catch (err) {
      const message = (err as Error).message;
      log.error('Failed to start recording', { error: message });
      if (mountedRef.current) {
        if (message.includes('Permission') || message.includes('NotAllowed')) {
          setError('Microphone access denied. Check your browser settings.');
        } else {
          setError('Could not start recording.');
        }
      }
    } finally {
      isStartingRef.current = false;
    }
  }, [cleanupAudioContext, updateAudioLevel]);

  const stopRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (!recorder) return;

    if (recorder.state === 'recording') {
      recorder.requestData(); // Flush buffered audio before stopping
    }
    if (recorder.state !== 'inactive') {
      recorder.stop();
    }
    recorder.stream.getTracks().forEach((track) => track.stop());
    mediaRecorderRef.current = null;
    if (mountedRef.current) setIsRecording(false);
    log.info('Recording stopped');
  }, []);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      void startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      const recorder = mediaRecorderRef.current;
      if (recorder && recorder.state !== 'inactive') {
        recorder.stop();
        recorder.stream.getTracks().forEach((track) => track.stop());
      }
      mediaRecorderRef.current = null;
      cleanupAudioContext();
    };
  }, [cleanupAudioContext]);

  return {
    isRecording,
    isTranscribing,
    audioLevel,
    error,
    startRecording,
    stopRecording,
    toggleRecording,
  };
}
