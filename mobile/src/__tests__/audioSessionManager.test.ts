/**
 * Audio session manager tests — verifies each preset function produces
 * correct AudioMode parameters and that ALL fields are always set.
 */

jest.mock('@rebel/cloud-client', () => ({
  // Pure live-meeting id casts (zero-import module) so a future pure cast added
  // there needs no mock edit. See meetingRecordingContext.test.tsx for rationale.
  ...(jest.requireActual('../../../cloud-client/src/types/liveMeetingIds') as typeof import('../../../cloud-client/src/types/liveMeetingIds')),
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  }),
}));

let mockIsActive = false;
jest.mock('../stores/activeRecordingStore', () => ({
  useActiveRecordingStore: {
    getState: () => ({ isActive: mockIsActive }),
  },
}));

import { setAudioModeAsync, __getLastAudioMode, __resetLastAudioMode } from 'expo-audio';
import {
  configureForBackgroundRecording,
  configureForRecording,
  configureForPlayback,
  configureForIdle,
} from '../utils/audioSessionManager';

// All AudioMode fields that must be present in every preset.
const ALL_AUDIO_MODE_FIELDS = [
  'allowsRecording',
  'playsInSilentMode',
  'shouldPlayInBackground',
  'allowsBackgroundRecording',
  'shouldRouteThroughEarpiece',
  'interruptionMode',
];

beforeEach(() => {
  mockIsActive = false;
  (setAudioModeAsync as jest.Mock).mockClear();
  (__resetLastAudioMode as () => void)();
});

describe('audioSessionManager', () => {
  describe('configureForBackgroundRecording', () => {
    it('enables background recording with correct params', async () => {
      await configureForBackgroundRecording();

      expect(setAudioModeAsync).toHaveBeenCalledTimes(1);
      const params = (__getLastAudioMode as () => Record<string, unknown>)();
      expect(params).toEqual(expect.objectContaining({
        allowsBackgroundRecording: true,
        shouldPlayInBackground: true,
        allowsRecording: true,
        interruptionMode: 'duckOthers',
      }));
    });

    it('sets all AudioMode fields (none undefined)', async () => {
      await configureForBackgroundRecording();

      const params = (__getLastAudioMode as () => Record<string, unknown>)();
      for (const field of ALL_AUDIO_MODE_FIELDS) {
        expect(params[field]).toBeDefined();
      }
    });
  });

  describe('configureForRecording', () => {
    it('enables recording without background support', async () => {
      await configureForRecording();

      expect(setAudioModeAsync).toHaveBeenCalledTimes(1);
      const params = (__getLastAudioMode as () => Record<string, unknown>)();
      expect(params).toEqual(expect.objectContaining({
        allowsRecording: true,
        allowsBackgroundRecording: false,
        shouldPlayInBackground: false,
      }));
    });

    it('sets all AudioMode fields (none undefined)', async () => {
      await configureForRecording();

      const params = (__getLastAudioMode as () => Record<string, unknown>)();
      for (const field of ALL_AUDIO_MODE_FIELDS) {
        expect(params[field]).toBeDefined();
      }
    });
  });

  describe('configureForPlayback(true) — preserves recording config', () => {
    it('keeps recording and background flags active', async () => {
      await configureForPlayback(true);

      expect(setAudioModeAsync).toHaveBeenCalledTimes(1);
      const params = (__getLastAudioMode as () => Record<string, unknown>)();
      expect(params).toEqual(expect.objectContaining({
        allowsRecording: true,
        allowsBackgroundRecording: true,
        shouldPlayInBackground: true,
      }));
    });

    it('sets all AudioMode fields (none undefined)', async () => {
      await configureForPlayback(true);

      const params = (__getLastAudioMode as () => Record<string, unknown>)();
      for (const field of ALL_AUDIO_MODE_FIELDS) {
        expect(params[field]).toBeDefined();
      }
    });
  });

  describe('configureForPlayback(false) — standard playback', () => {
    it('disables recording and background flags', async () => {
      await configureForPlayback(false);

      expect(setAudioModeAsync).toHaveBeenCalledTimes(1);
      const params = (__getLastAudioMode as () => Record<string, unknown>)();
      expect(params).toEqual(expect.objectContaining({
        allowsRecording: false,
        allowsBackgroundRecording: false,
        shouldPlayInBackground: false,
      }));
    });

    it('sets all AudioMode fields (none undefined)', async () => {
      await configureForPlayback(false);

      const params = (__getLastAudioMode as () => Record<string, unknown>)();
      for (const field of ALL_AUDIO_MODE_FIELDS) {
        expect(params[field]).toBeDefined();
      }
    });

    it('auto-upgrades to playbackDuringRec when meeting recording is active', async () => {
      mockIsActive = true;
      await configureForPlayback(false);

      expect(setAudioModeAsync).toHaveBeenCalledTimes(1);
      const params = (__getLastAudioMode as () => Record<string, unknown>)();
      expect(params).toEqual(expect.objectContaining({
        allowsRecording: true,
        allowsBackgroundRecording: true,
      }));
    });
  });

  describe('configureForIdle', () => {
    it('disables all recording flags and uses mixWithOthers', async () => {
      await configureForIdle();

      expect(setAudioModeAsync).toHaveBeenCalledTimes(1);
      const params = (__getLastAudioMode as () => Record<string, unknown>)();
      expect(params).toEqual(expect.objectContaining({
        allowsRecording: false,
        allowsBackgroundRecording: false,
        shouldPlayInBackground: false,
        interruptionMode: 'mixWithOthers',
      }));
    });

    it('sets all AudioMode fields (none undefined)', async () => {
      await configureForIdle();

      const params = (__getLastAudioMode as () => Record<string, unknown>)();
      for (const field of ALL_AUDIO_MODE_FIELDS) {
        expect(params[field]).toBeDefined();
      }
    });

    it('is blocked when meeting recording is active', async () => {
      mockIsActive = true;
      await configureForIdle();
      expect(setAudioModeAsync).not.toHaveBeenCalled();
    });

    it('proceeds when no recording is active', async () => {
      mockIsActive = false;
      await configureForIdle();
      expect(setAudioModeAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe('cross-preset consistency', () => {
    it('all presets set the exact same set of fields', async () => {
      const presetCalls = [
        () => configureForBackgroundRecording(),
        () => configureForRecording(),
        () => configureForPlayback(true),
        () => configureForPlayback(false),
        () => configureForIdle(),
      ];

      const fieldSets: string[][] = [];
      for (const call of presetCalls) {
        (__resetLastAudioMode as () => void)();
        await call();
        const params = (__getLastAudioMode as () => Record<string, unknown>)();
        fieldSets.push(Object.keys(params).sort());
      }

      // All presets should have identical field sets.
      for (let i = 1; i < fieldSets.length; i++) {
        expect(fieldSets[i]).toEqual(fieldSets[0]);
      }
    });
  });
});
