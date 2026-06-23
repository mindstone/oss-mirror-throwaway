/**
 * IPC Handlers for Physical Recording
 *
 * Handles BLE device management and recording for Limitless Pendant.
 */

import { ipcMain } from 'electron';
import { createScopedLogger } from '@core/logger';
import { physicalRecordingService, transcribePhysicalRecording, broadcastPhysicalRecordingBackgroundStatus } from '@main/services/physicalRecording';
import type { PhysicalRecordingState } from '@main/services/physicalRecording/types';

const log = createScopedLogger({ service: 'physical-recording-handlers' });

/**
 * Convert service state to IPC-safe state (Date -> string).
 */
function serializeState(state: PhysicalRecordingState): {
  status: string;
  device?: { id: string; name: string; rssi: number };
  batteryLevel?: number;
  isRecording: boolean;
  recordingStartTime?: string;
  error?: string;
} {
  return {
    status: state.status,
    device: state.device,
    batteryLevel: state.batteryLevel,
    isRecording: state.isRecording,
    recordingStartTime: state.recordingStartTime?.toISOString(),
    error: state.error,
  };
}

export function registerPhysicalRecordingHandlers(): void {
  log.info('Registering physical recording handlers');

  // Get current state
  ipcMain.handle('physical-recording:get-state', async () => {
    const state = physicalRecordingService.getState();
    log.debug({ status: state.status, deviceName: state.device?.name }, 'physical-recording:get-state called');
    return serializeState(state);
  });

  // Scan for devices
  ipcMain.handle('physical-recording:scan-devices', async (_event, args: { timeoutMs?: number }) => {
    try {
      const devices = await physicalRecordingService.scanForDevices(args.timeoutMs);
      return { success: true, devices };
    } catch (err) {
      log.error({ err }, 'Failed to scan for devices');
      return {
        success: false,
        devices: [],
        error: err instanceof Error ? err.message : 'Scan failed',
      };
    }
  });

  // Stop scanning
  ipcMain.handle('physical-recording:stop-scanning', async () => {
    physicalRecordingService.stopScanning();
    return { success: true };
  });

  // Connect to device
  ipcMain.handle('physical-recording:connect', async (_event, args: { deviceId: string }) => {
    try {
      await physicalRecordingService.connect(args.deviceId);
      return { success: true };
    } catch (err) {
      log.error({ err, deviceId: args.deviceId }, 'Failed to connect to device');
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Connection failed',
      };
    }
  });

  // Disconnect from device (user-initiated - clears saved device to prevent auto-reconnect)
  ipcMain.handle('physical-recording:disconnect', async () => {
    log.info('physical-recording:disconnect called');
    try {
      // Add timeout to prevent hanging on BLE operations
      const timeoutMs = 3000;
      const disconnectPromise = physicalRecordingService.disconnectAndForget();
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error('Disconnect timed out')), timeoutMs)
      );
      
      await Promise.race([disconnectPromise, timeoutPromise]);
      log.info('Disconnect successful');
      return { success: true };
    } catch (err) {
      log.error({ err }, 'Failed to disconnect from device');
      // If disconnect timed out, force disconnect
      if (err instanceof Error && err.message === 'Disconnect timed out') {
        log.warn('BLE disconnect timed out, forcing disconnect');
        physicalRecordingService.forceDisconnectAndForget();
        return { success: true };
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Disconnect failed',
      };
    }
  });

  // Start recording
  ipcMain.handle('physical-recording:start-recording', async () => {
    try {
      await physicalRecordingService.startRecording();
      return { success: true };
    } catch (err) {
      log.error({ err }, 'Failed to start recording');
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Start recording failed',
      };
    }
  });

  // Stop recording
  ipcMain.handle('physical-recording:stop-recording', async (_event, args: { title?: string }) => {
    try {
      const result = await physicalRecordingService.stopRecording();
      if (!result) {
        const state = physicalRecordingService.getState();
        log.warn(
          { isRecording: state.isRecording, frameCount: physicalRecordingService.getFrameCount(), deviceName: state.device?.name },
          'Stop recording requested but no audio captured'
        );
        return { success: false, error: 'No audio captured' };
      }

      log.info({ duration: result.duration, bytes: result.audioBuffer.length, startTime: result.startTime.toISOString() }, 'Recording stopped, starting transcription');

      // Transcribe and save the recording
      try {
        const { savedPath } = await transcribePhysicalRecording(
          result.audioBuffer,
          result.duration,
          result.startTime, // Pass actual recording start time
          args.title
        );

        // Broadcast done state to UI
        broadcastPhysicalRecordingBackgroundStatus('done_physical', 'Saved to memory');

        return {
          success: true,
          duration: result.duration,
          transcriptPath: savedPath,
        };
      } catch (transcriptionErr) {
        log.error({ err: transcriptionErr }, 'Transcription failed');
        // Broadcast error state
        broadcastPhysicalRecordingBackgroundStatus('transcribing_physical', 'Transcription failed');
        // Still return success for the recording part
        return {
          success: true,
          duration: result.duration,
          error: transcriptionErr instanceof Error ? transcriptionErr.message : 'Transcription failed',
        };
      }
    } catch (err) {
      log.error({ err }, 'Failed to stop recording');
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Stop recording failed',
      };
    }
  });

  // Get recording duration
  ipcMain.handle('physical-recording:get-recording-duration', async () => {
    return {
      duration: physicalRecordingService.getRecordingDuration(),
      frameCount: physicalRecordingService.getFrameCount(),
    };
  });

  log.info('Physical recording handlers registered');
}
