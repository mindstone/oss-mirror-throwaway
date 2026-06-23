import { formatUsage as sharedFormatUsage } from '@shared/utils/usageFormatters';

/**
 * Formatting utility functions for timestamps, durations, messages, and usage lines
 */

/**
 * Format a timestamp for display in relative or absolute time
 */
export const formatTimestamp = (value: number | undefined): string => {
  if (!value) return '';
  try {
    const date = new Date(value);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
};

/**
 * Format a timestamp for history display with relative time
 */
export const formatHistoryTimestamp = (timestamp: number): string => {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) {
    const minutes = Math.floor(delta / 60_000);
    return `${minutes}m ago`;
  }
  if (delta < 86_400_000) {
    const hours = Math.floor(delta / 3_600_000);
    return `${hours}h ago`;
  }
  const formatter = new Intl.DateTimeFormat([], {
    month: 'short',
    day: 'numeric'
  });
  return formatter.format(timestamp);
};

/**
 * Format a timestamp as absolute date and time (e.g., "Dec 16, 2025 at 2:30 PM")
 */
export const formatAbsoluteTimestamp = (timestamp: number): string => {
  const formatter = new Intl.DateTimeFormat([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
  return formatter.format(timestamp);
};

/**
 * Format duration in milliseconds to a short human-readable string
 */
export const formatDurationShort = (ms: number): string => {
  if (ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (remainingMinutes === 0) {
      return `${hours}h`;
    }
    return seconds === 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h ${remainingMinutes}m ${seconds}s`;
  }
  if (seconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
};

/**
 * Format step duration for Insights display.
 * Shows '<1s' for sub-second durations instead of '0s'.
 * Returns null if duration is not computable (negative or undefined).
 */
export const formatStepDuration = (ms: number | undefined): string | null => {
  if (ms === undefined || ms < 0) return null;
  if (ms === 0) return '<1s';
  if (ms < 1000) return '<1s';
  return formatDurationShort(ms);
};

/**
 * Format a save timestamp with relative time or absolute time
 */
export const formatSaveTimestamp = (timestamp?: number): string => {
  if (!timestamp) return 'Never saved';
  const delta = Date.now() - timestamp;
  if (delta < 5_000) return 'Saved just now';
  if (delta < 60_000) return `Saved ${Math.floor(delta / 1_000)}s ago`;
  if (delta < 3_600_000) {
    const minutes = Math.floor(delta / 60_000);
    return `Saved ${minutes}m ago`;
  }
  const formatter = new Intl.DateTimeFormat([], {
    hour: '2-digit',
    minute: '2-digit'
  });
  return `Saved at ${formatter.format(timestamp)}`;
};

/**
 * Strip common markdown syntax for plain-text display (titles, previews, etc.)
 */
export const stripMarkdown = (text: string | null | undefined): string => {
  if (!text) return '';
  return text
    .replace(/^#{1,6}\s+/gm, '') // headers
    .replace(/\*\*(.+?)\*\*/g, '$1') // bold
    .replace(/\*(.+?)\*/g, '$1') // italic
    .replace(/__(.+?)__/g, '$1') // bold alt
    .replace(/_(.+?)_/g, '$1') // italic alt
    .replace(/~~(.+?)~~/g, '$1') // strikethrough
    .replace(/`(.+?)`/g, '$1') // inline code
    .replace(/\[(.+?)\]\([^)]+\)/g, '$1') // links
    .trim();
};

/**
 * Create a short snippet from a message text
 */
export const createMessageSnippet = (text: string, maxLength = 78): string => {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return 'No messages yet';
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength).trim()}…` : trimmed;
};

/**
 * Truncate text for logging with a maximum length
 */
export const truncateForLog = (value: string, maximum = 400): string => {
  const trimmed = value.trim();
  if (trimmed.length <= maximum) {
    return trimmed;
  }
  return `${trimmed.slice(0, maximum)}…`;
};

/**
 * Format the usage line for result events (tokens/cost)
 */
export const formatUsage = sharedFormatUsage;
