import type { MeetingState, MeetingStatusSource } from '@shared/ipc/channels/meetingBot';
import { useMeetingStatusContext, type MeetingStatus, type MeetingInfo } from '@renderer/contexts/MeetingStatusContext';

// Re-export types for convenience
export type { MeetingState, MeetingStatusSource, MeetingStatus, MeetingInfo };

/**
 * Hook to track meeting status from main process.
 * 
 * ARCHITECTURE: Uses singleton MeetingStatusProvider to share state.
 * All consumers share a single IPC subscription and polling interval,
 * eliminating redundant IPC calls when multiple components need meeting status.
 * 
 * Requires MeetingStatusProvider to be mounted above in the component tree.
 */
export function useMeetingStatus(): MeetingStatus {
  return useMeetingStatusContext();
}

/**
 * Returns time until meeting start in human-readable format.
 */
export function formatTimeUntilMeeting(startTime: string): string {
  const start = new Date(startTime);
  const now = new Date();
  const diffMs = start.getTime() - now.getTime();
  
  if (diffMs < 0) {
    return 'now';
  }
  
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) {
    return 'now';
  }
  if (diffMins < 60) {
    return `in ${diffMins} min`;
  }
  
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  
  if (mins === 0) {
    return `in ${hours}h`;
  }
  return `in ${hours}h ${mins}m`;
}

/**
 * Format recording duration in mm:ss or hh:mm:ss format.
 */
export function formatRecordingDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}


