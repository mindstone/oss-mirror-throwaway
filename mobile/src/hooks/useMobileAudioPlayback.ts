// mobile/src/hooks/useMobileAudioPlayback.ts
// @device-scoped: generated TTS audio is a temporary playback cache, not account state.
// Mobile audio playback hook — fetches TTS from cloud and plays back via expo-audio.
// Handles barge-in (stop mid-playback + cancel in-flight fetch), temp file lifecycle,
// and iOS audio mode switching.
//
// When `preserveRecording` is true, the hook does NOT switch audio mode to
// `allowsRecording: false` before playback. This allows TTS to play through
// the speaker/earbuds while a meeting recording continues via the `playAndRecord`
// audio session category. See planning doc Stage 2 / Failure Mode #14.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { textToSpeech } from '@rebel/cloud-client';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';
import { configureForPlayback } from '../utils/audioSessionManager';
import { deferNativeCleanup } from '../utils/deferNativeCleanup';

export interface UseMobileAudioPlaybackOptions {
  /**
   * When true, TTS playback does NOT set `allowsRecording: false`.
   * Use this when a meeting recording is active to avoid interrupting it.
   * iOS `playAndRecord` category supports simultaneous record + playback.
   */
  preserveRecording?: boolean;
  /** Callback when playback completes */
  onPlaybackComplete?: () => void;
}

export interface UseMobileAudioPlaybackReturn {
  isLoading: boolean;
  isSpeaking: boolean;
  error: string | null;
  speakText: (text: string) => Promise<void>;
  stopSpeech: () => void;
}

/**
 * @param onPlaybackCompleteOrOptions - Either a callback for backward compatibility,
 *   or an options object with `preserveRecording` and `onPlaybackComplete`.
 */
export function useMobileAudioPlayback(
  onPlaybackCompleteOrOptions?: (() => void) | UseMobileAudioPlaybackOptions,
): UseMobileAudioPlaybackReturn {
  // Normalize overload: support both legacy callback and options object
  const options: UseMobileAudioPlaybackOptions =
    typeof onPlaybackCompleteOrOptions === 'function'
      ? { onPlaybackComplete: onPlaybackCompleteOrOptions }
      : onPlaybackCompleteOrOptions ?? {};

  const { preserveRecording = false, onPlaybackComplete } = options;
  const [isLoading, setIsLoading] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const playerRef = useRef<AudioPlayer | null>(null);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const currentFileRef = useRef<string | null>(null);
  const onPlaybackCompleteRef = useRef(onPlaybackComplete);

  useEffect(() => {
    onPlaybackCompleteRef.current = onPlaybackComplete;
  }, [onPlaybackComplete]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      const player = playerRef.current;
      const file = currentFileRef.current;
      playerRef.current = null;
      currentFileRef.current = null;
      deferNativeCleanup(async () => {
        try {
          player?.remove();
        } catch (e) {
          ignoreBestEffortCleanup(e, {
            operation: 'useMobileAudioPlayback.unmount.removePlayer',
            reason: 'native player may already be torn down during unmount',
            severity: 'warn',
          });
        }
        if (file) {
          await FileSystem.deleteAsync(file, { idempotent: true });
        }
      });
    };
  }, []);

  const stopSpeech = useCallback(() => {
    // Cancel any in-flight TTS fetch
    abortRef.current?.abort();
    abortRef.current = null;

    const player = playerRef.current;
    if (player) {
      playerRef.current = null;
      try { player.pause(); player.remove(); } catch { /* native player may be gone */ }
    }
    // Clean up temp file
    const file = currentFileRef.current;
    if (file) {
      currentFileRef.current = null;
      FileSystem.deleteAsync(file, { idempotent: true }).catch(() => {});
    }
    if (mountedRef.current) {
      setIsSpeaking(false);
      setIsLoading(false);
    }
  }, []);

  const speakText = useCallback(async (text: string) => {
    if (!text.trim()) return;

    stopSpeech();
    setError(null);
    setIsLoading(true);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      // 1. Fetch base64-encoded TTS audio from cloud (cancellable)
      const audioBase64 = await textToSpeech(text, abort.signal);

      if (!mountedRef.current || abort.signal.aborted) return;

      if (!audioBase64) {
        setError("Couldn't generate audio");
        setIsLoading(false);
        return;
      }

      // 2. Write to temp file with unique name to prevent collisions
      const tempFile = `${FileSystem.cacheDirectory}rebel-tts-${Date.now()}.mp3`;
      currentFileRef.current = tempFile;

      await FileSystem.writeAsStringAsync(tempFile, audioBase64, {
        encoding: FileSystem.EncodingType.Base64,
      });

      if (!mountedRef.current || abort.signal.aborted) return;

      // 3. Set audio mode for playback.
      // When preserveRecording is true OR a meeting recording is currently active,
      // use playbackDuringRec preset to keep recording config intact.
      // iOS playAndRecord category supports simultaneous record + playback.
      const meetingActive = useActiveRecordingStore.getState().isActive;
      await configureForPlayback(preserveRecording || meetingActive);

      if (!mountedRef.current || abort.signal.aborted) return;

      // 4. Create player and play
      const player = createAudioPlayer(tempFile);
      playerRef.current = player;

      setIsLoading(false);
      setIsSpeaking(true);

      player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) {
          if (mountedRef.current) setIsSpeaking(false);
          playerRef.current = null;
          try { player.remove(); } catch { /* native player may be gone */ }
          FileSystem.deleteAsync(tempFile, { idempotent: true }).catch(() => {});
          currentFileRef.current = null;
          onPlaybackCompleteRef.current?.();
        }
      });

      player.play();
    } catch (err) {
      if (abort.signal.aborted) return; // Intentional cancellation — no error
      if (mountedRef.current) {
        const message = err instanceof Error ? err.message : 'Text-to-speech failed';
        setError(message);
        setIsLoading(false);
        setIsSpeaking(false);
      }
    }
  }, [stopSpeech, preserveRecording]);

  return { isLoading, isSpeaking, error, speakText, stopSpeech };
}
