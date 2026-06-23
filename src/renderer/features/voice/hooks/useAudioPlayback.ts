import { useCallback, useEffect, useRef, useState } from 'react';
import type { BreadcrumbEntry, RendererLogPayload } from '@shared/types';
import { tracking } from '@renderer/src/tracking';
import { useTimeoutRef } from '@renderer/hooks/useTimeoutRef';

type EmitLogPayload = Omit<RendererLogPayload, 'source' | 'breadcrumbs'> & {
  breadcrumbs?: BreadcrumbEntry[];
};

type UseAudioPlaybackOptions = {
  emitLog: (payload: EmitLogPayload) => void;
  onUtteranceStart?: (text: string) => void;
  onUtteranceEnd?: (text: string) => void;
};

type UseAudioPlaybackResult = {
  isSpeaking: boolean;
  speakText: (text: string) => Promise<void>;
  speakTextsOrdered?: (texts: string[]) => Promise<void>;
  stopSpeech: () => void;
  playbackError: string | null;
  clearPlaybackError: () => void;
};

const AUDIO_IDLE_SUSPEND_DELAY_MS = 5000;
const AUDIO_IDLE_CLOSE_DELAY_MS = 60000;
const MAX_AUDIO_QUEUE_LENGTH = 10;

export const useAudioPlayback = ({ emitLog, onUtteranceStart, onUtteranceEnd }: UseAudioPlaybackOptions): UseAudioPlaybackResult => {
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioQueueRef = useRef<ArrayBuffer[]>([]);
  const textQueueRef = useRef<string[]>([]);
  const isPlayingRef = useRef(false);
  const currentAudioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  // Generation token to cancel in-flight decode/play when user presses the mic
  const playbackGenerationRef = useRef(0);
  const completionResolversRef = useRef<Array<() => void>>([]);
  const idleSuspendTimer = useTimeoutRef();
  const idleCloseTimer = useTimeoutRef();
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  const clearIdleSuspendTimeout = useCallback(() => {
    idleSuspendTimer.clear();
  }, [idleSuspendTimer]);

  const clearIdleCloseTimeout = useCallback(() => {
    idleCloseTimer.clear();
  }, [idleCloseTimer]);

  const scheduleContextSuspend = useCallback(
    (immediate = false) => {
      const schedule = () => {
        const context = audioContextRef.current;
        if (!context || context.state === 'closed') {
          return;
        }
        context.suspend().catch(() => undefined);
      };

      if (!audioContextRef.current) {
        clearIdleSuspendTimeout();
        return;
      }

      if (immediate) {
        clearIdleSuspendTimeout();
        schedule();
        return;
      }

      idleSuspendTimer.set(schedule, AUDIO_IDLE_SUSPEND_DELAY_MS);
    },
    [clearIdleSuspendTimeout, idleSuspendTimer]
  );

  const ensureActiveContext = useCallback(async () => {
    clearIdleCloseTimeout();
    let context = audioContextRef.current;
    if (!context || context.state === 'closed') {
      context = new AudioContext();
      audioContextRef.current = context;
    }

    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch (error) {
        emitLog({
          level: 'warn',
          message: 'Failed to resume AudioContext, recreating',
          timestamp: Date.now(),
          context: { error: error instanceof Error ? error.message : String(error) }
        });
        context = new AudioContext();
        audioContextRef.current = context;
      }
    }

    return context;
  }, [clearIdleCloseTimeout, emitLog]);

  const scheduleContextClose = useCallback(
    (immediate = false) => {
      const schedule = () => {
        const context = audioContextRef.current;
        if (!context || context.state === 'closed') {
          audioContextRef.current = null;
          return;
        }
        context
          .close()
          .catch(() => undefined)
          .finally(() => {
            audioContextRef.current = null;
          });
      };

      if (!audioContextRef.current) {
        clearIdleCloseTimeout();
        return;
      }

      if (immediate) {
        clearIdleCloseTimeout();
        schedule();
        return;
      }

      idleCloseTimer.set(schedule, AUDIO_IDLE_CLOSE_DELAY_MS);
    },
    [clearIdleCloseTimeout, idleCloseTimer]
  );

  // Track TTS playback timing
  const currentUtteranceStartRef = useRef<number | null>(null);
  const currentUtteranceCharCountRef = useRef(0);
  const totalUtteranceCharCountRef = useRef(0);

  const stopSpeech = useCallback(() => {
    // Track TTS interruption if currently playing
    if (currentAudioSourceRef.current && currentUtteranceStartRef.current) {
      const elapsedMs = Date.now() - currentUtteranceStartRef.current;
      const percentPlayed = totalUtteranceCharCountRef.current > 0
        ? Math.round((currentUtteranceCharCountRef.current / totalUtteranceCharCountRef.current) * 100)
        : 0;
      tracking.voice.ttsPlaybackInterrupted(elapsedMs, percentPlayed);
    }

    if (currentAudioSourceRef.current) {
      try {
        currentAudioSourceRef.current.stop();
      } catch {
        // Already stopped
      }
      currentAudioSourceRef.current = null;
    }
    setIsSpeaking(false);
    isPlayingRef.current = false;
    currentUtteranceStartRef.current = null;
    currentUtteranceCharCountRef.current = 0;
    // Bump generation so any in-flight decode doesn't start playing
    playbackGenerationRef.current += 1;
    audioQueueRef.current = [];
    textQueueRef.current = [];
    // Resolve any pending completion promises so callers don't hang
    const pending = completionResolversRef.current;
    completionResolversRef.current = [];
    for (const resolve of pending) {
      try { resolve(); } catch { /* ignore */ }
    }
    scheduleContextSuspend(true);
    scheduleContextClose(true);
  }, [scheduleContextClose, scheduleContextSuspend]);

  const playNextAudioInQueue = useCallback(async () => {
    if (isPlayingRef.current || audioQueueRef.current.length === 0) {
      if (!isPlayingRef.current && audioQueueRef.current.length === 0) {
        scheduleContextSuspend();
        scheduleContextClose();
      }
      return;
    }

    isPlayingRef.current = true;
    setIsSpeaking(true);
    clearIdleSuspendTimeout();
    clearIdleCloseTimeout();
    const generationAtStart = playbackGenerationRef.current;

    const audioBuffer = audioQueueRef.current.shift();
    const text = textQueueRef.current.shift() ?? '';
    const completionResolve = completionResolversRef.current.shift();
      if (!audioBuffer) {
        isPlayingRef.current = false;
        setIsSpeaking(false);
        if (audioQueueRef.current.length === 0) {
          scheduleContextSuspend();
          scheduleContextClose();
        }
      if (completionResolve) completionResolve();
      return;
    }

    try {
      const context = await ensureActiveContext();
      if (!context) {
        throw new Error('AudioContext unavailable');
      }
      const decoded = await context.decodeAudioData(audioBuffer);
      // Abort if a newer generation started (e.g., user pressed mic to stop)
      if (generationAtStart !== playbackGenerationRef.current) {
        isPlayingRef.current = false;
        setIsSpeaking(false);
        if (completionResolve) completionResolve();
        return;
      }
      const source = context.createBufferSource();
      source.buffer = decoded;
      source.connect(context.destination);

      currentAudioSourceRef.current = source;
      // Track TTS playback start
      const playbackStartTime = Date.now();
      currentUtteranceStartRef.current = playbackStartTime;
      currentUtteranceCharCountRef.current = text.length;
      totalUtteranceCharCountRef.current = text.length + textQueueRef.current.reduce((sum, t) => sum + t.length, 0);
      tracking.voice.ttsPlaybackStarted(text.length);

      // Notify start of this utterance just before playback
      if (onUtteranceStart) {
        try { onUtteranceStart(text); } catch { /* ignore */ }
      }
      source.onended = () => {
        // Track TTS playback completed
        const durationMs = Date.now() - playbackStartTime;
        tracking.voice.ttsPlaybackCompleted(durationMs, text.length);
        currentUtteranceStartRef.current = null;

        currentAudioSourceRef.current = null;
        isPlayingRef.current = false;
        setIsSpeaking(false);
        if (onUtteranceEnd) {
          try { onUtteranceEnd(text); } catch { /* ignore */ }
        }
        if (completionResolve) completionResolve();
        if (audioQueueRef.current.length === 0) {
          scheduleContextSuspend();
          scheduleContextClose();
        } else {
          void playNextAudioInQueue();
        }
      };

      source.start(0);
    } catch (error) {
      emitLog({
        level: 'error',
        message: 'Failed to decode/play audio',
        context: { error: error instanceof Error ? error.message : String(error) },
        timestamp: Date.now()
      });
      tracking.voice.ttsPlaybackError(error instanceof Error ? error.message : 'decode_error');
      isPlayingRef.current = false;
      setIsSpeaking(false);
      if (completionResolve) completionResolve();
      void playNextAudioInQueue();
      if (audioQueueRef.current.length === 0) {
        scheduleContextSuspend();
        scheduleContextClose();
      }
    }
  }, [clearIdleCloseTimeout, clearIdleSuspendTimeout, emitLog, ensureActiveContext, onUtteranceEnd, onUtteranceStart, scheduleContextClose, scheduleContextSuspend]);

  const speakText = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      try {
        emitLog({
          level: 'debug',
          message: 'Starting TTS for text',
          context: { textLength: text.length },
          timestamp: Date.now()
        });

        const audioData = await window.voiceApi.textToSpeech(text);
        if (audioQueueRef.current.length >= MAX_AUDIO_QUEUE_LENGTH) {
          audioQueueRef.current.shift();
          textQueueRef.current.shift();
          const droppedResolve = completionResolversRef.current.shift();
          if (droppedResolve) {
            try { droppedResolve(); } catch { /* ignore */ }
          }
          emitLog({
            level: 'warn',
            message: 'Dropped queued speech due to backlog',
            timestamp: Date.now()
          });
        }
        clearIdleSuspendTimeout();
        clearIdleCloseTimeout();
        audioQueueRef.current.push(audioData);
        textQueueRef.current.push(text);
        const completionPromise = new Promise<void>((resolve) => {
          completionResolversRef.current.push(resolve);
        });
        void playNextAudioInQueue();
        await completionPromise;
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        emitLog({
          level: 'error',
          message: 'Text-to-speech failed',
          context: { error: errorMsg },
          timestamp: Date.now()
        });
        setPlaybackError(errorMsg);
      }
    },
    [clearIdleCloseTimeout, clearIdleSuspendTimeout, emitLog, playNextAudioInQueue]
  );

  /**
   * Prefetch multiple texts concurrently but enqueue for playback in original order.
   * Resolves when all have finished playing (or earlier if playback was cancelled).
   */
  const speakTextsOrdered = useCallback(
    async (texts: string[]) => {
      const items = texts.map((t) => t?.trim()).filter((t): t is string => Boolean(t && t.length > 0));
      if (items.length === 0) return;

      const generationAtStart = playbackGenerationRef.current;

      // Fire off all TTS requests concurrently
      let firstErrorMsg: string | null = null;
      const ttsPromises = items.map(async (text) => {
        try {
          const audio = await window.voiceApi.textToSpeech(text);
          return { text, audio };
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          if (!firstErrorMsg) {
            firstErrorMsg = errorMsg;
          }
          emitLog({
            level: 'error',
            message: 'Text-to-speech failed (batch item)',
            context: { error: errorMsg },
            timestamp: Date.now()
          });
          // Represent failure by returning null; caller will skip it
          return null;
        }
      });

      const completionPromises: Array<Promise<void>> = [];
      let successCount = 0;

      // Enqueue results strictly in order, as soon as each prior item is ready
      for (let i = 0; i < ttsPromises.length; i += 1) {
        const result = await ttsPromises[i];
        // Abort if playback has been cancelled/restarted
        if (generationAtStart !== playbackGenerationRef.current) {
          break;
        }
        if (!result) {
          // Skip failed item; continue with the rest
          // Still attempt to keep context alive for remaining items
           
          continue;
        }

        if (audioQueueRef.current.length >= MAX_AUDIO_QUEUE_LENGTH) {
          audioQueueRef.current.shift();
          textQueueRef.current.shift();
          const droppedResolve = completionResolversRef.current.shift();
          if (droppedResolve) {
            try { droppedResolve(); } catch { /* ignore */ }
          }
          emitLog({
            level: 'warn',
            message: 'Dropped queued speech due to backlog',
            timestamp: Date.now()
          });
        }
        clearIdleSuspendTimeout();
        clearIdleCloseTimeout();
        audioQueueRef.current.push(result.audio);
        textQueueRef.current.push(result.text);
        successCount += 1;
        const completionPromise = new Promise<void>((resolve) => {
          completionResolversRef.current.push(resolve);
        });
        completionPromises.push(completionPromise);
        void playNextAudioInQueue();
      }

      // Wait for all enqueued items to finish playback
      if (completionPromises.length > 0) {
        await Promise.all(completionPromises);
      }
      // If the entire batch failed, surface an error so UI can show a banner
      if (successCount === 0 && firstErrorMsg) {
        setPlaybackError(firstErrorMsg);
      }
    },
    [clearIdleCloseTimeout, clearIdleSuspendTimeout, emitLog, playNextAudioInQueue]
  );

  useEffect(() => {
    return () => {
      clearIdleSuspendTimeout();
      clearIdleCloseTimeout();
      stopSpeech();
      if (audioContextRef.current) {
        void audioContextRef.current.close().catch(() => undefined);
        audioContextRef.current = null;
      }
    };
  }, [clearIdleCloseTimeout, clearIdleSuspendTimeout, stopSpeech]);

  const clearPlaybackError = useCallback(() => setPlaybackError(null), []);

  return {
    isSpeaking,
    speakText,
    speakTextsOrdered,
    stopSpeech,
    playbackError,
    clearPlaybackError
  };
};
