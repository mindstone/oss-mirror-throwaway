/**
 * Types for Physical Recording Service
 */

/** Status of the physical recording service */
export type PhysicalRecordingStatus =
  | 'disconnected'
  | 'scanning'
  | 'connecting'
  | 'connected'
  | 'error';

/** Discovered BLE device info */
export interface PhysicalRecordingDevice {
  id: string;
  name: string;
  rssi: number;
}

/** Current state of the physical recording service */
export interface PhysicalRecordingState {
  status: PhysicalRecordingStatus;
  device?: PhysicalRecordingDevice;
  batteryLevel?: number;
  isRecording: boolean;
  recordingStartTime?: Date;
  error?: string;
}

/** Button press event from device */
export interface ButtonPressEvent {
  type: 'short' | 'long';
}

/** Device recording state change event */
export interface DeviceRecordingStateChangeEvent {
  recording: boolean;
}

/** Physical recording metadata for storage */
export interface PhysicalRecordingMetadata {
  id: string;
  title: string;
  startTime: string; // ISO timestamp
  duration: number; // seconds
  deviceName: string;
  reviewStatus: 'pending' | 'reviewed';
  transcriptPath?: string;
  audioPath?: string;
}
