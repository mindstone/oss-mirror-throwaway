/**
 * Meeting Bot Domain IPC Handlers
 *
 * Handles meeting bot sending, transcript retrieval, and pending transcript management.
 * Also handles Desktop SDK recording for local meeting detection.
 */

import type { IpcMainInvokeEvent } from 'electron';
import { registerHandler } from './utils/registerHandler';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ component: 'meeting-bot-handlers' });
const MEETING_BOT_CANCEL_IPC_TIMEOUT_MS = 30_000;
import type { MeetingBotService } from '../services/meetingBot/meetingBotService';
import {
  startRecording,
  stopRecording,
  getCurrentMeeting,
  getCurrentMeetingStatus as getDesktopSdkStatus,
  isDesktopSdkInitialized,
  skipCurrentMeeting,
  getTeamsUrlPermissionStatus,
  requestTeamsUrlPermission,
} from '../services/meetingBot/desktopSdkService';
import { getActiveBotState, setActiveBotCoach, setPresenceMode, computeCaptionsActive, getActiveCollaboratorBotId } from '../services/meetingBot/meetingBotService';
import { getPendingTranscripts, getPendingTranscript, updatePendingTranscriptCoachSelection, updatePendingTranscriptPresenceMode } from '../services/meetingBot/pendingTranscriptsStore';
import {
  testProviderConnection,
  triggerManualSync,
} from '../services/meetingBot/externalProviders';
import { testRecallApiKey } from '../services/meetingBot/recallApiKeyTester';
import { isRecorderInstalled } from '../services/meetingBot/recorderInstallation';
import {
  installRecorder,
  cancelRecorderInstall,
  isRecorderInstalling,
} from '../services/meetingBot/recorderInstaller';
import {
  isLocalRecordingSupported,
  isLocalRecordingEnabled,
  checkPermissions,
  requestPermissions,
  startLocalRecording,
  stopLocalRecording,
  getLocalRecordingStatus,
  fetchLocalRecordingTranscript,
  isLocalRecordingCapturing,
  setLocalRecordingCoach,
  setLocalRecordingPresenceMode,
  getLocalRecordingCoachState,
} from '../services/meetingBot/localRecordingService';
import { getPhysicalRecordingStatus } from '../services/physicalRecording';
import {
  setKnowledgeAccess,
  isKnowledgeAccessEnabled,
  requestStopSpeaking,
  isBotSpeaking,
  hasPendingResponse,
  triggerSpeakPendingResponse,
  chatPendingResponse,
  getPendingContributionPreview,
  dismissPendingContribution,
} from '../services/meetingBot/botQAService';

export interface MeetingBotHandlerDeps {
  getMeetingBotService: () => MeetingBotService | null;
}

const cancelBotWithIpcTimeout = async (
  service: MeetingBotService,
  botId: string,
): Promise<{ success: boolean; error?: string; recoverable?: boolean }> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      service.cancelBot(botId),
      new Promise<{ success: boolean; error?: string; recoverable?: boolean }>((resolve) => {
        timeout = setTimeout(() => {
          log.warn(
            { botId, timeoutMs: MEETING_BOT_CANCEL_IPC_TIMEOUT_MS },
            'meeting-bot:cancel timed out; returning while cancellation continues'
          );
          resolve({
            success: true,
            recoverable: true,
            error: 'Cancellation is still in progress.',
          });
        }, MEETING_BOT_CANCEL_IPC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export function registerMeetingBotHandlers(deps: MeetingBotHandlerDeps): void {
  const { getMeetingBotService } = deps;

  registerHandler(
    'meeting-bot:send',
    async (
      _event: IpcMainInvokeEvent,
      payload: { meetingUrl: string; meetingTitle?: string; avatarId?: string; scheduledFor?: string }
    ) => {
      const service = getMeetingBotService();
      if (!service) return { success: false, error: 'Meeting bot service not available' };
      return service.sendBot(payload);
    }
  );

  registerHandler(
    'meeting-bot:cancel',
    async (_event: IpcMainInvokeEvent, payload: { botId: string }) => {
      const service = getMeetingBotService();
      if (!service) return { success: false, error: 'Meeting bot service not available' };
      return cancelBotWithIpcTimeout(service, payload.botId);
    }
  );

  registerHandler(
    'meeting-bot:dismiss-status',
    (_event: IpcMainInvokeEvent) => {
      const service = getMeetingBotService();
      if (!service) return { success: true };
      service.dismissStatus();
      return { success: true };
    }
  );

  registerHandler(
    'meeting-bot:skip-meeting',
    (_event: IpcMainInvokeEvent, payload: { meetingUrl: string }) => {
      skipCurrentMeeting(payload.meetingUrl);
      return { success: true };
    }
  );

  registerHandler(
    'meeting-bot:process-and-save',
    async (_event: IpcMainInvokeEvent, payload: { botId: string }) => {
      const service = getMeetingBotService();
      if (!service) return { success: false, error: 'Meeting bot service not available' };
      return service.processAndSaveTranscript(payload.botId);
    }
  );

  // Desktop SDK handlers
  registerHandler(
    'meeting-bot:start-recording',
    async (_event: IpcMainInvokeEvent, payload: { uploadToken: string }) => {
      return startRecording(payload.uploadToken);
    }
  );

  registerHandler(
    'meeting-bot:stop-recording',
    async (_event: IpcMainInvokeEvent) => {
      return stopRecording();
    }
  );

  registerHandler(
    'meeting-bot:get-current-meeting',
    (_event: IpcMainInvokeEvent) => {
      return getCurrentMeeting();
    }
  );

  registerHandler(
    'meeting-bot:is-sdk-ready',
    (_event: IpcMainInvokeEvent) => {
      return isDesktopSdkInitialized();
    }
  );

  registerHandler(
    'meeting-bot:is-recorder-installed',
    (_event: IpcMainInvokeEvent) => {
      return { installed: isRecorderInstalled() };
    }
  );

  registerHandler(
    'meeting-bot:install-recorder',
    async (_event: IpcMainInvokeEvent) => {
      return installRecorder();
    }
  );

  registerHandler(
    'meeting-bot:cancel-recorder-install',
    (_event: IpcMainInvokeEvent) => {
      return { cancelled: cancelRecorderInstall() };
    }
  );

  registerHandler(
    'meeting-bot:is-recorder-installing',
    (_event: IpcMainInvokeEvent) => {
      return { installing: isRecorderInstalling() };
    }
  );

  registerHandler(
    'meeting-bot:get-current-status',
    (_event: IpcMainInvokeEvent) => {
      // Aggregate status from all sources with precedence:
      // 1. Physical recording (highest priority - Limitless Pendant)
      // 2. Local recording
      // 3. Cloud bot (dispatching/joining/recording)
      // 4. Desktop SDK (detected/preview/no_meetings)

      // Check physical recording first (highest precedence)
      const physicalStatus = getPhysicalRecordingStatus();
      if (physicalStatus?.isRecording) {
        return {
          state: 'recording_physical' as const,
          source: 'physical_recording' as const,
          meeting: {
            id: 'physical-recording',
            title: 'In-person Recording',
            startTime: physicalStatus.startTime ?? new Date().toISOString(),
            meetingUrl: '',
          },
          recordingDuration: physicalStatus.duration ?? 0,
        };
      }

      // Check local recording (second highest precedence).
      // CRITICAL: the snapshot MUST mirror the live broadcast semantics
      // (localRecordingService.broadcastStatus vs broadcastBackgroundStatus), or a
      // renderer that builds state from this snapshot (mount / recovery poll / a second
      // window) re-enters the high-precedence active `recording_local` state DURING UPLOAD
      // and then rejects the low-precedence `uploading_local/desktop_sdk` broadcasts —
      // leaving the recording mic (and its infinite pulse animation) stuck forever (FOX-3438).
      // So: high-precedence active state ONLY while actively capturing audio; once the
      // capture has stopped and we're upload-only, return the low-precedence upload snapshot.
      const localStatus = getLocalRecordingStatus();
      if (localStatus.isCapturing) {
        const recordingDuration = localStatus.startTime
          ? Math.floor((Date.now() - new Date(localStatus.startTime).getTime()) / 1000)
          : 0;
        return {
          state: 'recording_local' as const,
          source: 'local_recording' as const,
          meeting: {
            id: localStatus.uploadId ?? 'local',
            title: localStatus.meetingTitle ?? 'Meeting',
            startTime: localStatus.startTime ?? new Date().toISOString(),
            meetingUrl: localStatus.meetingUrl || '',
          },
          botId: localStatus.uploadId,
          recordingDuration,
          presenceMode: localStatus.presenceMode,
        };
      }
      if (localStatus.isUploading) {
        // Upload-only: low precedence (matches broadcastBackgroundStatus's `desktop_sdk`)
        // so done/clear broadcasts are accepted and new meeting detection can override.
        return {
          state: 'uploading_local' as const,
          source: 'desktop_sdk' as const,
          meeting: {
            id: localStatus.uploadId ?? 'local',
            title: localStatus.meetingTitle ?? 'Meeting',
            startTime: localStatus.startTime ?? new Date().toISOString(),
            meetingUrl: localStatus.meetingUrl || '',
          },
          uploadId: localStatus.uploadId,
        };
      }

      // Check cloud bot state (second precedence)
      const cloudBotState = getActiveBotState();
      if (cloudBotState) {
        const recordingDuration = cloudBotState.recordingStartTime
          ? Math.floor((Date.now() - cloudBotState.recordingStartTime) / 1000)
          : undefined;
        return {
          state: cloudBotState.uiState,
          source: 'cloud_bot' as const,
          meeting: {
            id: cloudBotState.botId,
            title: cloudBotState.meetingTitle,
            startTime: new Date().toISOString(),
            meetingUrl: cloudBotState.meetingUrl,
          },
          botId: cloudBotState.botId,
          quip: cloudBotState.quip,
          recordingDuration,
          avatarConnected: cloudBotState.avatarConnected,
          captionsActive: computeCaptionsActive(cloudBotState),
          presenceMode: cloudBotState.presenceMode ?? (cloudBotState.coachSkillPath ? 'coach' : 'silent'),
          otherActiveBotsCount: getPendingTranscripts().filter(
            t => t.status === 'in_meeting' && t.botId !== cloudBotState.botId
          ).length,
        };
      }

      // Fall back to Desktop SDK status (lowest precedence)
      return getDesktopSdkStatus();
    }
  );

  // External provider handlers
  registerHandler(
    'meeting-bot:test-external-provider',
    async (
      _event: IpcMainInvokeEvent,
      payload: { provider: 'fireflies' | 'fathom'; apiKey: string }
    ) => {
      return testProviderConnection(payload.provider, payload.apiKey);
    }
  );

  registerHandler(
    'meeting-bot:test-recall-api-key',
    async (_event: IpcMainInvokeEvent, payload: { apiKey: string }) => {
      return testRecallApiKey(payload.apiKey);
    }
  );

  registerHandler(
    'meeting-bot:sync-external-provider',
    async (_event: IpcMainInvokeEvent) => {
      return triggerManualSync();
    }
  );

  // Local recording handlers
  registerHandler(
    'meeting-bot:start-local-recording',
    async (_event: IpcMainInvokeEvent, payload: { meetingTitle?: string }) => {
      const currentMeeting = getCurrentMeeting();
      return startLocalRecording({
        meetingTitle: payload.meetingTitle || currentMeeting?.title,
        windowId: currentMeeting?.windowId,
      });
    }
  );

  registerHandler(
    'meeting-bot:stop-local-recording',
    async (_event: IpcMainInvokeEvent) => {
      return stopLocalRecording();
    }
  );

  registerHandler(
    'meeting-bot:get-local-recording-status',
    (_event: IpcMainInvokeEvent) => {
      return getLocalRecordingStatus();
    }
  );

  registerHandler(
    'meeting-bot:check-local-recording-permissions',
    async (_event: IpcMainInvokeEvent) => {
      const platformSupport = isLocalRecordingSupported();
      log.info({ platformSupport }, 'check-local-recording-permissions: platform support');
      if (!platformSupport.supported) {
        log.warn({ reason: platformSupport.reason }, 'check-local-recording-permissions: platform not supported');
        return {
          supported: false,
          unsupportedReason: platformSupport.reason,
          allGranted: false,
        };
      }

      const enabled = isLocalRecordingEnabled();
      log.info({ enabled }, 'check-local-recording-permissions: enabled check');
      if (!enabled) {
        log.warn('check-local-recording-permissions: local recording is disabled');
        return {
          supported: false,
          unsupportedReason: 'Local recording is disabled',
          allGranted: false,
        };
      }

      const permissions = await checkPermissions();
      return {
        supported: true,
        permissions,
        allGranted: permissions.allGranted,
      };
    }
  );

  registerHandler(
    'meeting-bot:request-local-recording-permissions',
    async (_event: IpcMainInvokeEvent) => {
      return requestPermissions();
    }
  );

  registerHandler(
    'meeting-bot:is-local-recording-supported',
    (_event: IpcMainInvokeEvent) => {
      const result = isLocalRecordingSupported();
      log.info({ result }, 'isLocalRecordingSupported check');
      return result;
    }
  );

  registerHandler(
    'meeting-bot:fetch-local-recording-transcript',
    async (
      _event: IpcMainInvokeEvent,
      payload: { uploadId: string; clientSecret: string }
    ) => {
      return fetchLocalRecordingTranscript(payload);
    }
  );

  registerHandler(
    'meeting-bot:get-recording-count',
    (_event: IpcMainInvokeEvent) => {
      const pendingTranscripts = getPendingTranscripts();
      const recording = pendingTranscripts.filter(t => t.status === 'in_meeting');
      const active = pendingTranscripts.filter(t => t.status === 'scheduled' || t.status === 'in_meeting');
      return {
        recordingCount: recording.length,
        activeCount: active.length,
      };
    }
  );

  registerHandler(
    'meeting-bot:set-knowledge-access',
    (_event: IpcMainInvokeEvent, payload: { botId: string; enabled: boolean }) => {
      setKnowledgeAccess(payload.botId, payload.enabled);
      log.info({ botId: payload.botId, enabled: payload.enabled }, 'Knowledge access toggled');
      return { success: true };
    }
  );

  registerHandler(
    'meeting-bot:get-knowledge-access',
    (_event: IpcMainInvokeEvent, payload: { botId: string }) => {
      const enabled = isKnowledgeAccessEnabled(payload.botId);
      return { enabled };
    }
  );

  registerHandler(
    'meeting-bot:stop-speaking',
    (_event: IpcMainInvokeEvent, payload: { botId: string }) => {
      const success = requestStopSpeaking(payload.botId);
      log.info({ botId: payload.botId, success }, 'Stop speaking requested');
      return { success };
    }
  );

  registerHandler(
    'meeting-bot:is-speaking',
    (_event: IpcMainInvokeEvent, payload: { botId: string }) => {
      const speaking = isBotSpeaking(payload.botId);
      return { speaking };
    }
  );

  registerHandler(
    'meeting-bot:has-pending-response',
    (_event: IpcMainInvokeEvent, payload: { botId: string }) => {
      const pending = hasPendingResponse(payload.botId);
      return { pending };
    }
  );

  registerHandler(
    'meeting-bot:speak-pending-response',
    async (_event: IpcMainInvokeEvent, payload: { botId: string }) => {
      const success = await triggerSpeakPendingResponse(payload.botId);
      log.info({ botId: payload.botId, success }, 'Speak pending response requested');
      return { success };
    }
  );

  registerHandler(
    'meeting-bot:chat-pending-response',
    async (_event: IpcMainInvokeEvent, payload: { botId: string }) => {
      const result = await chatPendingResponse(payload.botId);
      log.info({ botId: payload.botId, success: result.success, rateLimited: result.rateLimited }, 'Chat pending response requested');
      return result;
    }
  );

  registerHandler(
    'meeting-bot:get-contribution-preview',
    (_event: IpcMainInvokeEvent, payload: { botId: string }) => {
      return getPendingContributionPreview(payload.botId);
    }
  );

  registerHandler(
    'meeting-bot:dismiss-contribution',
    (_event: IpcMainInvokeEvent, payload: { botId: string }) => {
      const success = dismissPendingContribution(payload.botId);
      return { success };
    }
  );

  // Full Disk Access permission for Teams URL extraction (macOS only)
  registerHandler(
    'meeting-bot:get-teams-url-permission-status',
    (_event: IpcMainInvokeEvent) => {
      return getTeamsUrlPermissionStatus();
    }
  );

  registerHandler(
    'meeting-bot:request-teams-url-permission',
    async (_event: IpcMainInvokeEvent) => {
      const result = await requestTeamsUrlPermission();
      log.info({ result }, 'Teams URL permission request completed');
      return result;
    }
  );

  // Live Coach Selection
  registerHandler(
    'meeting-bot:set-coach',
    (_event: IpcMainInvokeEvent, payload: { coachSkillPath: string; companionSessionId: string } | null) => {
      // Validate payload when non-null
      if (payload !== null) {
        if (!payload.coachSkillPath || typeof payload.coachSkillPath !== 'string' || payload.coachSkillPath.trim() === '') {
          log.warn({ payload }, 'Invalid coachSkillPath in set-coach request');
          return { success: false, error: 'Invalid coach skill path' };
        }
        if (!payload.companionSessionId || typeof payload.companionSessionId !== 'string' || payload.companionSessionId.trim() === '') {
          log.warn({ payload }, 'Invalid companionSessionId in set-coach request');
          return { success: false, error: 'Invalid companion session ID' };
        }
      }
      
      // Try cloud bot first
      const success = setActiveBotCoach(payload);
      if (success) {
        return { success };
      }

      // Fall back to local recording
      if (isLocalRecordingCapturing()) {
        setLocalRecordingCoach(payload);
        return { success: true };
      }

      // Fall back to collaborator mode
      const collaboratorBotId = getActiveCollaboratorBotId();
      if (collaboratorBotId) {
        if (payload === null) {
          updatePendingTranscriptCoachSelection(collaboratorBotId, null);
          updatePendingTranscriptPresenceMode(collaboratorBotId, 'silent');
          return { success: true };
        }
        updatePendingTranscriptCoachSelection(collaboratorBotId, {
          coachSkillPath: payload.coachSkillPath,
          companionSessionId: payload.companionSessionId,
        });
        const pending = getPendingTranscript(collaboratorBotId);
        if (!pending?.presenceMode) {
          updatePendingTranscriptPresenceMode(collaboratorBotId, 'coach');
        }
        return { success: true };
      }

      return { success: false, error: 'No active recording' };
    }
  );

  registerHandler(
    'meeting-bot:set-presence-mode',
    (
      _event: IpcMainInvokeEvent,
      payload: { mode: 'silent' | 'coach' | 'participant' }
    ) => {
      // Try cloud bot first
      const state = getActiveBotState();
      if (state) {
        if (payload.mode === 'participant' && !state.coachSkillPath) {
          return { success: false, error: 'Cannot set participant mode without an active coach' };
        }

        const success = setPresenceMode(payload.mode);
        if (!success) {
          return { success: false, error: 'Failed to set presence mode' };
        }

        return { success };
      }

      // Fall back to local recording
      if (isLocalRecordingCapturing()) {
        try {
          setLocalRecordingPresenceMode(payload.mode);
          return { success: true };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Failed to set presence mode' };
        }
      }

      // Fall back to collaborator mode
      const collaboratorBotIdForMode = getActiveCollaboratorBotId();
      if (collaboratorBotIdForMode) {
        if (payload.mode === 'participant') {
          return { success: false, error: 'Participant mode not available for collaborators' };
        }
        updatePendingTranscriptPresenceMode(collaboratorBotIdForMode, payload.mode);
        return { success: true };
      }

      return { success: false, error: 'No active recording' };
    }
  );

  registerHandler(
    'meeting-bot:get-coach',
    (_event: IpcMainInvokeEvent) => {
      // Try cloud bot first
      const state = getActiveBotState();
      if (state?.coachSkillPath) {
        return {
          hasCoach: true,
          coachSkillPath: state.coachSkillPath,
          companionSessionId: state.companionSessionId,
        };
      }

      // Fall back to local recording
      if (isLocalRecordingCapturing()) {
        const coachState = getLocalRecordingCoachState();
        if (coachState?.coachSkillPath) {
          return {
            hasCoach: true,
            coachSkillPath: coachState.coachSkillPath,
            companionSessionId: coachState.companionSessionId,
          };
        }
      }

      // Fall back to collaborator mode
      const collaboratorBotIdForCoach = getActiveCollaboratorBotId();
      if (collaboratorBotIdForCoach) {
        const pending = getPendingTranscript(collaboratorBotIdForCoach);
        if (pending?.coachSkillPath) {
          return {
            hasCoach: true,
            coachSkillPath: pending.coachSkillPath,
            companionSessionId: pending.companionSessionId,
          };
        }
      }

      return { hasCoach: false };
    }
  );

}
