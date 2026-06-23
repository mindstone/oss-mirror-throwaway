// mobile/src/utils/audioSessionManager.ts
//
// Centralized audio session configuration for mobile.
// Every function sets ALL AudioMode fields explicitly — never partial.
// This prevents expo-audio's native code from defaulting missing fields
// to `false`, which would silently clobber `allowsBackgroundRecording`.

import { setAudioModeAsync, type AudioMode } from 'expo-audio';
import { createLogger } from '@rebel/cloud-client';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';

const log = createLogger('audioSession');

// ---------------------------------------------------------------------------
// Presets — every field explicit, no partial objects
// ---------------------------------------------------------------------------

const PRESETS = {
  /** Meeting recording in background — full background support. */
  backgroundRecording: {
    allowsRecording: true,
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    allowsBackgroundRecording: true,
    shouldRouteThroughEarpiece: false,
    interruptionMode: 'duckOthers',
  },

  /** Voice recording (foreground only, no background). */
  recording: {
    allowsRecording: true,
    playsInSilentMode: true,
    shouldPlayInBackground: false,
    allowsBackgroundRecording: false,
    shouldRouteThroughEarpiece: false,
    interruptionMode: 'duckOthers',
  },

  /** Playback while a recording is active — preserves recording config. */
  playbackDuringRec: {
    allowsRecording: true,
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    allowsBackgroundRecording: true,
    shouldRouteThroughEarpiece: false,
    interruptionMode: 'duckOthers',
  },

  /** Standard playback — no recording active. */
  playback: {
    allowsRecording: false,
    playsInSilentMode: true,
    shouldPlayInBackground: false,
    allowsBackgroundRecording: false,
    shouldRouteThroughEarpiece: false,
    interruptionMode: 'duckOthers',
  },

  /** Idle — no recording, no playback, mix with other apps. */
  idle: {
    allowsRecording: false,
    playsInSilentMode: true,
    shouldPlayInBackground: false,
    allowsBackgroundRecording: false,
    shouldRouteThroughEarpiece: false,
    interruptionMode: 'mixWithOthers',
  },
} as const satisfies Record<string, AudioMode>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Configure audio session for background meeting recording.
 * Enables `allowsBackgroundRecording` (iOS) and foreground service (Android).
 */
export async function configureForBackgroundRecording(): Promise<void> {
  log.info('Configuring audio session for background recording');
  await setAudioModeAsync(PRESETS.backgroundRecording);
}

/**
 * Configure audio session for foreground-only voice recording.
 */
export async function configureForRecording(): Promise<void> {
  log.info('Configuring audio session for recording');
  await setAudioModeAsync(PRESETS.recording);
}

/**
 * Configure audio session for playback.
 * @param preserveRecording - When true, keeps recording config active
 *   (uses `playbackDuringRec` preset). When false, uses standard playback.
 */
export async function configureForPlayback(preserveRecording: boolean): Promise<void> {
  const meetingActive = useActiveRecordingStore.getState().isActive;
  const preset = (preserveRecording || meetingActive) ? 'playbackDuringRec' : 'playback';
  if (!preserveRecording && meetingActive) {
    log.warn('configureForPlayback auto-upgraded to playbackDuringRec — meeting recording is active');
  }
  log.info('Configuring audio session for playback', { preset });
  await setAudioModeAsync(PRESETS[preset]);
}

/**
 * Configure audio session for idle state.
 * Disables recording and mixes with other apps.
 */
export async function configureForIdle(): Promise<void> {
  if (useActiveRecordingStore.getState().isActive) {
    log.warn('configureForIdle blocked — meeting recording is active');
    return;
  }
  log.info('Configuring audio session for idle');
  await setAudioModeAsync(PRESETS.idle);
}
