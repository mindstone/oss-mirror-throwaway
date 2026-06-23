import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

/** Status of the physical recording service */
export const PhysicalRecordingStatusSchema = z.enum([
  'disconnected',
  'scanning',
  'connecting',
  'connected',
  'error',
]);
export type PhysicalRecordingStatus = z.infer<typeof PhysicalRecordingStatusSchema>;

/** Discovered BLE device */
export const PhysicalRecordingDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  rssi: z.number(),
});
export type PhysicalRecordingDevice = z.infer<typeof PhysicalRecordingDeviceSchema>;

/** Current state of physical recording */
export const PhysicalRecordingStateSchema = z.object({
  status: PhysicalRecordingStatusSchema,
  device: PhysicalRecordingDeviceSchema.optional(),
  batteryLevel: z.number().optional(),
  isRecording: z.boolean(),
  recordingStartTime: z.string().optional(), // ISO timestamp
  error: z.string().optional(),
});
export type PhysicalRecordingState = z.infer<typeof PhysicalRecordingStateSchema>;

export const physicalRecordingChannels = {
  'physical-recording:get-state': defineInvokeChannel({
    channel: 'physical-recording:get-state',
    request: z.void(),
    response: PhysicalRecordingStateSchema,
    description: 'Get current physical recording state',
  }),

  'physical-recording:scan-devices': defineInvokeChannel({
    channel: 'physical-recording:scan-devices',
    request: z.object({
      timeoutMs: z.number().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      devices: z.array(PhysicalRecordingDeviceSchema),
      error: z.string().optional(),
    }),
    description: 'Scan for Limitless Pendant devices',
  }),

  'physical-recording:stop-scanning': defineInvokeChannel({
    channel: 'physical-recording:stop-scanning',
    request: z.void(),
    response: z.object({ success: z.boolean() }),
    description: 'Stop scanning for devices',
  }),

  'physical-recording:connect': defineInvokeChannel({
    channel: 'physical-recording:connect',
    request: z.object({
      deviceId: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Connect to a Limitless Pendant device',
  }),

  'physical-recording:disconnect': defineInvokeChannel({
    channel: 'physical-recording:disconnect',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Disconnect from the current device and clear saved device (prevents auto-reconnect)',
  }),

  'physical-recording:start-recording': defineInvokeChannel({
    channel: 'physical-recording:start-recording',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Start recording audio from the connected device',
  }),

  'physical-recording:stop-recording': defineInvokeChannel({
    channel: 'physical-recording:stop-recording',
    request: z.object({
      title: z.string().optional(),
    }),
    response: z.object({
      success: z.boolean(),
      duration: z.number().optional(),
      transcriptPath: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Stop recording and save the audio for transcription',
  }),

  'physical-recording:get-recording-duration': defineInvokeChannel({
    channel: 'physical-recording:get-recording-duration',
    request: z.void(),
    response: z.object({
      duration: z.number(),
      frameCount: z.number(),
    }),
    description: 'Get the current recording duration and frame count',
  }),
} as const;

export const quickCaptureChannels = {
  'quick-capture:start': defineInvokeChannel({
    channel: 'quick-capture:start',
    request: z.void(),
    response: z.object({
      success: z.boolean(),
      error: z.string().optional(),
    }),
    description: 'Start quick capture recording from laptop microphone',
  }),

  'quick-capture:stop': defineInvokeChannel({
    channel: 'quick-capture:stop',
    request: z.object({
      audio: z.any(), // TypeScript type: ArrayBuffer (binary audio payload)
      mimeType: z.string(),
    }),
    response: z.object({
      success: z.boolean(),
      duration: z.number().optional(),
      transcriptPath: z.string().optional(),
      error: z.string().optional(),
    }),
    description: 'Stop quick capture recording and process audio through transcript pipeline',
  }),
} as const;
