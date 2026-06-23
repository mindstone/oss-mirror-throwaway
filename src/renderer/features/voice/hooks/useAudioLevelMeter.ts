import { useEffect, useRef, useState } from 'react';

export type UseAudioLevelMeterResult = {
  /** Normalized audio level from 0 (silence) to 1 (loud) */
  level: number;
};

// Audio level processing constants (validated via POC)
const TARGET_FPS = 10;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
const SMOOTHING_FACTOR = 0.3; // 30% new value, 70% previous
const MIN_DB = -45; // Minimum dB (silence threshold)
const MAX_DB = -10; // Maximum dB (loud speech)
const NOISE_GATE_DB = -40; // Below this, treat as silence
const MIN_RMS_THRESHOLD = 0.0001; // Avoid log(0)

/**
 * Hook to monitor audio levels from a MediaStream.
 * Returns a normalized level (0-1) suitable for visual indicators.
 *
 * Uses Web Audio API AnalyserNode with dB scaling and smoothing
 * for perceptually accurate level representation.
 *
 * @param stream - MediaStream to analyze, or null when not recording
 * @returns Object with `level` property (0-1)
 */
export function useAudioLevelMeter(stream: MediaStream | null): UseAudioLevelMeterResult {
  const [level, setLevel] = useState(0);

  // Refs for audio processing state (managed outside React render cycle)
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastFrameTimeRef = useRef(0);
  const smoothedLevelRef = useRef(0);

  useEffect(() => {
    // Reset level when stream becomes null
    if (!stream) {
      cleanup();
      setLevel(0);
      smoothedLevelRef.current = 0;
      return;
    }

    // Initialize audio processing
    let isCancelled = false;

    const initAudio = () => {
      try {
        const audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;

        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);

        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        sourceRef.current = source;

        // Start the animation loop (only if visible)
        lastFrameTimeRef.current = performance.now();
        if (!document.hidden) {
          updateLevel();
        } else {
          // Suspend immediately if starting while hidden
          audioContext.suspend().catch(() => {});
        }
      } catch {
        // If createMediaStreamSource fails, return 0 silently
        // This can happen if the stream is invalid or already ended
        setLevel(0);
      }
    };

    function updateLevel() {
      if (isCancelled) return;

      // Stop completely when hidden - visibilitychange handler will restart
      if (document.hidden) {
        return;
      }

      const now = performance.now();

      // Throttle to target FPS for battery efficiency
      if (now - lastFrameTimeRef.current < FRAME_INTERVAL_MS) {
        rafIdRef.current = requestAnimationFrame(updateLevel);
        return;
      }

      lastFrameTimeRef.current = now;

      const analyser = analyserRef.current;
      if (!analyser) {
        rafIdRef.current = requestAnimationFrame(updateLevel);
        return;
      }

      // Get time domain data (waveform)
      const dataArray = new Uint8Array(analyser.fftSize);
      analyser.getByteTimeDomainData(dataArray);

      // Calculate RMS (root mean square)
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        // Normalize sample from 0-255 to -1..1
        const sample = (dataArray[i] - 128) / 128;
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / dataArray.length);

      // Convert RMS to dB scale for better perceptual response
      const db = rms > MIN_RMS_THRESHOLD ? 20 * Math.log10(rms) : MIN_DB;

      // Apply noise gate - below threshold is treated as silence
      const gatedDb = db < NOISE_GATE_DB ? MIN_DB : db;

      // Normalize dB to 0-1 range
      const rawLevel = Math.max(0, Math.min(1, (gatedDb - MIN_DB) / (MAX_DB - MIN_DB)));

      // Apply exponential smoothing for visual stability
      smoothedLevelRef.current =
        SMOOTHING_FACTOR * rawLevel + (1 - SMOOTHING_FACTOR) * smoothedLevelRef.current;

      setLevel(smoothedLevelRef.current);

      rafIdRef.current = requestAnimationFrame(updateLevel);
    }

    // Handle visibility changes to pause/resume RAF loop
    // This reduces WindowServer memory pressure on macOS when app is hidden
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Pause: cancel RAF and suspend AudioContext
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current);
          rafIdRef.current = null;
        }
        audioContextRef.current?.suspend().catch(() => {
          // Ignore suspend errors
        });
      } else {
        // Resume: restart AudioContext and RAF loop
        audioContextRef.current?.resume().catch(() => {
          // Ignore resume errors
        });
        // Reset timing to avoid sampling burst after resume
        lastFrameTimeRef.current = performance.now();
        // Restart RAF loop if we have an analyser
        if (analyserRef.current && rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(updateLevel);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    initAudio();

    return () => {
      isCancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      cleanup();
    };
  }, [stream]);

  function cleanup() {
    // Cancel animation frame
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    // Disconnect and close audio nodes
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    analyserRef.current = null;

    // Close AudioContext
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {
        // Ignore errors when closing context
      });
      audioContextRef.current = null;
    }
  }

  return { level };
}
