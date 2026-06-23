/**
 * Active Meeting Session
 *
 * Provides a unified interface for coaching services to access the active meeting state,
 * whether it's a cloud bot or local recording. This avoids coupling coaching logic
 * to cloud-bot-specific ActiveBotState fields.
 */

import { getActiveCollaboratorBotId } from './meetingBotService';
import { getLocalRecordingCoachState } from './localRecordingService';
import {
  getActiveBotState,
  isLocalRecordingCapturing,
  getLocalRecordingStatus,
} from './meetingBotRuntimeRegistry';
import { getPendingTranscript } from './pendingTranscriptsStore';

export interface ActiveMeetingForCoaching {
  botId: string;
  source: 'cloud_bot' | 'local_recording' | 'collaborator';
  meetingUrl: string;
  meetingTitle: string;
  coachSkillPath?: string;
  companionSessionId?: string;
  presenceMode?: 'silent' | 'coach' | 'participant';
}

/**
 * Get the active meeting session for coaching purposes.
 * Checks cloud bot first (if actively recording), then falls back to local recording.
 * Returns null if no active recording session exists.
 */
export function getActiveMeetingForCoaching(): ActiveMeetingForCoaching | null {
  // Cloud bot takes precedence
  const cloudBot = getActiveBotState();
  if (cloudBot) {
    return {
      botId: cloudBot.botId,
      source: 'cloud_bot',
      meetingUrl: cloudBot.meetingUrl,
      meetingTitle: cloudBot.meetingTitle,
      coachSkillPath: cloudBot.coachSkillPath,
      companionSessionId: cloudBot.companionSessionId,
      presenceMode: cloudBot.presenceMode ?? (cloudBot.coachSkillPath ? 'coach' : 'silent'),
    };
  }

  // Fall back to local recording
  if (isLocalRecordingCapturing()) {
    const localStatus = getLocalRecordingStatus();
    const coachState = getLocalRecordingCoachState();
    return {
      botId: localStatus.syntheticBotId || `local-${localStatus.uploadId || 'unknown'}`,
      source: 'local_recording',
      meetingUrl: localStatus.meetingUrl || '',
      meetingTitle: localStatus.meetingTitle || 'Meeting',
      coachSkillPath: coachState?.coachSkillPath,
      companionSessionId: coachState?.companionSessionId,
      presenceMode: coachState?.presenceMode,
    };
  }

  // Check collaborator mode (viewer relay with buffer-only transcript)
  const collaboratorBotId = getActiveCollaboratorBotId();
  if (collaboratorBotId) {
    const pending = getPendingTranscript(collaboratorBotId);
    if (pending) {
      return {
        botId: collaboratorBotId,
        source: 'collaborator' as ActiveMeetingForCoaching['source'],
        meetingUrl: pending.meetingUrl,
        meetingTitle: pending.meetingTitle ?? 'Meeting',
        coachSkillPath: pending.coachSkillPath,
        companionSessionId: pending.companionSessionId,
        presenceMode: pending.presenceMode ?? (pending.coachSkillPath ? 'coach' : 'silent'),
      };
    }
  }

  return null;
}
