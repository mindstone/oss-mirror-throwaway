/**
 * Transcript source system types — shared across desktop, cloud, and mobile.
 *
 * Moved from `src/main/services/meetingBot/transcriptEventBus.ts` to enable
 * cloud and mobile imports without depending on Electron-specific code.
 */

/**
 * Source system that produced the transcript.
 */
export type TranscriptSourceSystem =
  | 'recall'
  | 'desktop_sdk'
  | 'fireflies'
  | 'fathom'
  | 'plaud'
  | 'limitless'
  | 'quick_capture'
  | 'mobile-recording';

/**
 * Event payload emitted when a transcript is saved.
 */
export interface TranscriptSavedEvent {
  /** Source system (recall = Rebel Notetaker, fireflies/fathom = external) */
  sourceSystem: TranscriptSourceSystem;
  /** Stable identifier (botId for recall, externalId for external providers) */
  sourceUid: string;
  /** Absolute path to the saved transcript file */
  filePath: string;
  /** Relative path within workspace (for references) */
  spacePath?: string;
  /** Meeting title */
  meetingTitle: string;
  /** Meeting start time (ISO string) */
  startTime: string;
  /** Meeting participants */
  participants: string[];
  /** Meeting duration in seconds */
  duration: number;
  /** True if transcript already existed (deduplication) */
  alreadyExists: boolean;
  /** Timestamp when event was emitted */
  timestamp: number;
  /** Meeting URL (Zoom/Meet/Teams link) for calendar matching */
  meetingUrl?: string;
  /** Calendar event ID for exact calendar matching */
  calendarEventId?: string;
}

/**
 * Minimal event payload for transcript distribution.
 * The distribution automation reads full metadata from the file's YAML frontmatter.
 */
export interface TranscriptDistributionReadyEvent {
  /** Absolute path to the transcript file (at final quality) */
  filePath: string;
  /** Source system that produced the transcript */
  sourceSystem: TranscriptSourceSystem;
  /** Stable identifier (botId for recall, externalId for external providers) */
  sourceUid: string;
}
