/**
 * Meeting time formatting utilities
 *
 * Extracted from TheSparkPanel for reuse across homepage and spark surfaces.
 */

/** Format meeting time range for display (accepts ISO string or epoch number) */
export const formatMeetingTime = (startTime: string | number, endTime: string | number): string => {
  const start = new Date(startTime);
  const end = new Date(endTime);
  const formatTime = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${formatTime(start)} - ${formatTime(end)}`;
};

/** Get time until meeting for urgency display (accepts ISO string or epoch number) */
export const getTimeUntilMeeting = (startTime: string | number, endTime: string | number): string => {
  const now = Date.now();
  const startMs = typeof startTime === 'string' ? new Date(startTime).getTime() : startTime;
  const endMs = typeof endTime === 'string' ? new Date(endTime).getTime() : endTime;

  // Meeting has ended
  if (now > endMs) return '';

  // Meeting is in progress
  if (now >= startMs && now <= endMs) return 'In progress';

  // Meeting is upcoming
  const diff = startMs - now;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `In ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `In ${hours}h`;
  return '';
};

/** Check if a meeting start time is within a threshold of "soon" */
export const isMeetingSoon = (startTime: string | number, thresholdMinutes = 30): boolean => {
  const startMs = typeof startTime === 'string' ? new Date(startTime).getTime() : startTime;
  const diff = startMs - Date.now();
  return diff > 0 && diff < thresholdMinutes * 60 * 1000;
};
