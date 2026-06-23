/**
 * Physical Recording Module
 *
 * Exports the physical recording service for Limitless Pendant integration.
 */

export {
  physicalRecordingService,
  default,
  broadcastPhysicalRecordingStatus,
  broadcastPhysicalRecordingBackgroundStatus,
  getPhysicalRecordingStatus,
  initializePhysicalRecording,
} from './physicalRecordingService';
export { transcribePhysicalRecording } from './transcriptionService';
export { savePhysicalRecording, getPendingRecordings } from './storageService';
export * from './types';
