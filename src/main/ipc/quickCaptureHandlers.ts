/**
 * IPC Handlers for Quick Capture
 *
 * Handles ad-hoc laptop microphone recording orchestration:
 * - start/stop capture state
 * - status broadcasts to renderer
 * - transcription handoff
 * - quit protection while recording
 */

import { BrowserWindow, app, dialog } from 'electron';
import { ipcMain } from 'electron';
import { createScopedLogger } from '@core/logger';
import { transcribePhysicalRecording } from '@main/services/physicalRecording';
import { isPhysicalRecordingActive } from '@main/services/physicalRecording/physicalRecordingService';
import { isLocalRecordingCapturing } from '@main/services/meetingBot/localRecordingService';
import { isUpdateQuit } from '@main/services/gracefulShutdown';
import { isQuickCaptureActive, setQuickCaptureActive } from './quickCaptureState';
import type { MeetingStatusSource } from '@shared/ipc/channels/meetingBot';
import { fireAndForget } from '@shared/utils/fireAndForget';

export { isQuickCaptureActive } from './quickCaptureState';

const log = createScopedLogger({ service: 'quick-capture-handlers' });

const QUICK_CAPTURE_QUIPS = [
  'Recording the room.',
  "Go ahead, I'm listening.",
  'Capturing this for you.',
  'All ears.',
  'Taking it all in.',
] as const;

let recordingStartTime: Date | null = null;
let durationBroadcastInterval: NodeJS.Timeout | null = null;
let currentQuip: string | null = null;
let quitDialogActive = false;

type QuickCaptureStatusState =
  | 'recording_quick_capture'
  | 'transcribing_quick_capture'
  | 'done_quick_capture';

function pickRandomQuip(): string {
  return QUICK_CAPTURE_QUIPS[Math.floor(Math.random() * QUICK_CAPTURE_QUIPS.length)];
}

function clearDurationInterval(): void {
  if (durationBroadcastInterval) {
    clearInterval(durationBroadcastInterval);
    durationBroadcastInterval = null;
  }
}

function resetCaptureState(): void {
  setQuickCaptureActive(false);
  recordingStartTime = null;
  currentQuip = null;
  clearDurationInterval();
}

function toAudioBuffer(audio: Buffer | ArrayBuffer | ArrayBufferView): Buffer {
  if (Buffer.isBuffer(audio)) {
    return audio;
  }
  if (audio instanceof ArrayBuffer) {
    return Buffer.from(audio);
  }
  if (ArrayBuffer.isView(audio)) {
    return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  }
  throw new Error('Invalid audio payload');
}

function broadcastQuickCaptureStatus(state: QuickCaptureStatusState, quip: string): void {
  // eslint-disable-next-line no-restricted-syntax -- window-scan-send-allowlisted: quick-capture status is a genuine all-window meeting-bot broadcast; migrate later to BroadcastService.
  const windows = BrowserWindow.getAllWindows();
  const source = 'quick_capture' as MeetingStatusSource;
  const startTime = recordingStartTime?.toISOString() ?? new Date().toISOString();
  const duration = recordingStartTime
    ? Math.floor((Date.now() - recordingStartTime.getTime()) / 1000)
    : undefined;

  const payload = {
    state,
    source,
    meeting: {
      id: 'quick-capture',
      title: 'Quick Capture',
      startTime,
      meetingUrl: '',
    },
    ...(state === 'recording_quick_capture' && typeof duration === 'number'
      ? { recordingDuration: duration }
      : {}),
    quip,
    timestamp: Date.now(),
  };

  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.send('meeting-bot:status', payload);
    }
  }
}

export function registerQuickCaptureHandlers(): void {
  log.info('Registering quick capture handlers');

  ipcMain.handle('quick-capture:start', async () => {
    if (isQuickCaptureActive()) {
      return { success: false, error: 'Quick Capture is already recording.' };
    }

    if (isPhysicalRecordingActive()) {
      return {
        success: false,
        error: 'Physical recording is active. Stop it first to use Quick Capture.',
      };
    }

    if (isLocalRecordingCapturing()) {
      return {
        success: false,
        error: 'Local recording is active. Stop it first to use Quick Capture.',
      };
    }

    setQuickCaptureActive(true);
    recordingStartTime = new Date();
    currentQuip = pickRandomQuip();

    broadcastQuickCaptureStatus('recording_quick_capture', currentQuip);

    clearDurationInterval();
    durationBroadcastInterval = setInterval(() => {
      if (isQuickCaptureActive() && currentQuip) {
        broadcastQuickCaptureStatus('recording_quick_capture', currentQuip);
      }
    }, 1000);

    return { success: true };
  });

  ipcMain.handle('quick-capture:stop', async (_event, args: {
    audio: Buffer | ArrayBuffer | ArrayBufferView;
    mimeType: string;
  }) => {
    const startTime = recordingStartTime ?? new Date();
    const duration = recordingStartTime
      ? Math.floor((Date.now() - recordingStartTime.getTime()) / 1000)
      : 0;

    clearDurationInterval();
    setQuickCaptureActive(false);
    recordingStartTime = null;
    currentQuip = null;

    broadcastQuickCaptureStatus('transcribing_quick_capture', 'Transcribing...');

    try {
      const audioBuffer = toAudioBuffer(args.audio);
      const { savedPath } = await transcribePhysicalRecording(
        audioBuffer,
        duration,
        startTime,
        undefined,
        {
          sourceSystem: 'quick_capture',
          deviceName: 'Built-in Microphone',
          audioMimeType: args.mimeType,
        }
      );

      broadcastQuickCaptureStatus('done_quick_capture', 'Saved to memory');

      return {
        success: true,
        duration,
        transcriptPath: savedPath,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Transcription failed';
      log.error({ err }, 'Quick capture transcription failed');

      broadcastQuickCaptureStatus('done_quick_capture', 'Transcription failed');

      return {
        success: false,
        duration,
        error: message,
      };
    }
  });

  log.info('Quick capture handlers registered');
}

export function registerQuickCaptureQuitHandler(): void {
  app.on('before-quit', (event) => {
    fireAndForget((async () => {
    // Skip dialog during update-driven quit; just clean up state.
    if (isUpdateQuit()) {
      if (isQuickCaptureActive()) {
        log.info('Update quit detected - stopping quick capture without dialog');
        resetCaptureState();
      }
      return;
    }

    if (!isQuickCaptureActive() || quitDialogActive) {
      return;
    }

    event.preventDefault();
    quitDialogActive = true;

    try {
      const result = await dialog.showMessageBox({
        type: 'warning',
        title: 'Recording in Progress',
        message: 'Quick Capture is still recording.',
        detail: 'Quitting now will lose the recording. Stop and save first?',
        buttons: ['Quit Anyway', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });

      if (result.response === 0) {
        resetCaptureState();
        app.quit();
      }
    } finally {
      quitDialogActive = false;
    }
    })(), 'quickCapture.beforeQuit');
  });

  log.info('Quit handler registered for quick capture protection');
}
