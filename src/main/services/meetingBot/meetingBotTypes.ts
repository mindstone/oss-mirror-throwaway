/**
 * Shared type definitions for the meetingBot service cluster. Lives at the
 * bottom of the import graph so type-only imports do not contribute to
 * runtime cycles between sibling services (desktopSdkService, meetingBotService,
 * localRecordingService, botQAService, etc.).
 */

import type { PendingTranscript } from '@shared/ipc/channels/meetingBot';

export type MeetingState = 'idle' | 'detected' | 'recording';

export interface DetectedMeeting {
  windowId: string;
  title: string;
  url: string;
  platform: string;
}

export interface MeetingStatusUpdate {
  state: MeetingState;
  meeting?: DetectedMeeting;
  recordingDuration?: number;
  timestamp: number;
}

export type PresenceMode = 'silent' | 'coach' | 'participant';

export type BotUiState =
  | 'detected'
  | 'dispatching'
  | 'joining'
  | 'recording'
  | 'waiting_too_long'
  | 'rejected';

export interface ActiveBotState {
  botId: string;
  meetingUrl: string;
  meetingTitle: string;
  uiState: BotUiState;
  quip: string;
  recallStatus?: string;
  joiningStartTime?: number;
  waitingRoomStartTime?: number;
  recordingStartTime?: number;
  clientSecret?: string;
  sessionToken?: string;
  relayUrl?: string;
  avatarConnected?: boolean;
  hasAnnounced?: boolean;
  companionSessionId?: string;
  coachSkillPath?: string;
  coachPrompt?: string;
  coachContentHash?: string;
  coachPromptSource?: 'operator-frontmatter' | 'file-body';
  coachProactiveIntervalMinutes?: number;
  coachPromptLastModifiedMs?: number;
  presenceMode?: PresenceMode;
  lastCaptionReceivedAt?: number;
  hasReceivedCaption?: boolean;
  inCallNotRecordingEnteredAt?: number;
  inCallNotRecordingWarned?: boolean;
  conversationStatePersistedAtDisconnect?: boolean;
}

export interface LocalRecordingStatus {
  isRecording: boolean;
  isCapturing: boolean;
  isUploading: boolean;
  uploadId?: string;
  meetingTitle?: string;
  meetingUrl?: string;
  startTime?: string;
  syntheticBotId?: string;
  coachSkillPath?: string;
  companionSessionId?: string;
  presenceMode?: 'silent' | 'coach' | 'participant';
}

export interface MeetingBotService {
  sendBot(params: {
    meetingUrl: string;
    meetingTitle?: string;
    avatarId?: string;
    scheduledFor?: string;
    calendarEventId?: string;
    calendarSource?: string;
    forceJoin?: boolean;
  }): Promise<{
    success: boolean;
    botId?: string;
    error?: string;
    isOwner?: boolean;
    ownerName?: string;
    canOverride?: boolean;
  }>;

  getPendingTranscripts(): PendingTranscript[];

  getTranscript(botId: string): Promise<{
    success: boolean;
    transcript?: string;
    participants?: string[];
    duration?: number;
    error?: string;
  }>;

  cancelBot(botId: string): Promise<{ success: boolean; error?: string; recoverable?: boolean }>;

  dismissStatus(): void;

  removePending(botId: string): { success: boolean };

  processAndSaveTranscript(botId: string): Promise<{
    success: boolean;
    filePath?: string;
    spacePath?: string;
    error?: string;
  }>;

  startPolling(): void;
  stopPolling(): void;

  activatePreScheduledBot(botId: string): boolean;

  forceStatusCheck(): void;
}
