// mobile/src/hooks/usePendingRecordingsAudio.ts
//
// Audio playback of queued offline recordings. Manages expo-audio playback
// of queue item payloads. Only one recording plays at a time.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';
import { configureForPlayback } from '../utils/audioSessionManager';
import { deferNativeCleanup } from '../utils/deferNativeCleanup';

export interface UsePendingRecordingsAudioReturn {
  /** ID of the currently playing recording, or null */
  playingId: string | null;
  /** Toggle play/pause for a specific recording */
  togglePlayback: (id: string, payloadUri: string) => void;
  /** Stop any active playback */
  stopPlayback: () => void;
}

/**
 * Manages audio playback of queued offline recordings.
 * Only one recording plays at a time — starting a new one stops the current.
 */
export function usePendingRecordingsAudio(): UsePendingRecordingsAudioReturn {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);
  const playingIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const player = playerRef.current;
      playerRef.current = null;
      playingIdRef.current = null;
      if (player) {
        deferNativeCleanup(() => player.remove());
      }
    };
  }, []);

  const stopPlayback = useCallback(() => {
    const player = playerRef.current;
    if (player) {
      playerRef.current = null;
      try {
        player.pause();
        player.remove();
      } catch { /* native player may be gone */ }
    }
    playingIdRef.current = null;
    if (mountedRef.current) {
      setPlayingId(null);
    }
  }, []);

  const togglePlayback = useCallback((id: string, payloadUri: string) => {
    // If tapping the currently playing recording, stop it
    if (playingIdRef.current === id) {
      stopPlayback();
      return;
    }

    // Stop any currently playing recording first
    stopPlayback();

    // Start playing the new recording
    void (async () => {
      try {
        // Switch audio mode to playback (iOS requirement).
        // When a meeting recording is active, use playbackDuringRec preset
        // to keep recording config intact (iOS playAndRecord category supports
        // simultaneous record + playback).
        const meetingActive = useActiveRecordingStore.getState().isActive;
        await configureForPlayback(meetingActive);

        if (!mountedRef.current) return;

        const player = createAudioPlayer(payloadUri);
        playerRef.current = player;
        playingIdRef.current = id;
        setPlayingId(id);

        player.addListener('playbackStatusUpdate', (status) => {
          if (status.didJustFinish) {
            if (mountedRef.current) setPlayingId(null);
            playingIdRef.current = null;
            playerRef.current = null;
            try { player.remove(); } catch { /* native player may be gone */ }
          }
        });

        player.play();
      } catch {
        if (mountedRef.current) setPlayingId(null);
        playingIdRef.current = null;
        playerRef.current = null;
      }
    })();
  }, [stopPlayback]);

  return { playingId, togglePlayback, stopPlayback };
}
