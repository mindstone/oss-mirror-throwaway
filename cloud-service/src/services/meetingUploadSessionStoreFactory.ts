import * as fs from 'node:fs/promises';
import { transcribeAudio } from '@core/services/audioService';
import { getAudioDurationMs } from '@core/services/audioChunking';
import {
  MeetingUploadSessionStore,
  bufferToArrayBufferForMeetingAudio,
  type MeetingUploadLogger,
} from '@core/services/meetings/meetingUploadSessionService';
import type { MeetingFileStorageAdapter } from '@core/services/meetings/meetingFileStorageAdapter';
import { buildMeetingAnalysisCompletePush } from '@shared/schemas/pushNotifications';
import { log } from '../httpUtils';
import { runFallbackAnalysis, type CloudMeetingAnalysisDeps } from './cloudMeetingAnalysis';
import { sendPushNotification } from './pushNotificationService';
import {
  transcribeChunkAsync,
  hasIncrementalTranscript,
  flushAndMarkTranscriptionComplete,
  cleanupTranscriptionState,
  getConversationState,
} from './meetingTranscriptionEngine';
import {
  activateCoaching,
  deactivateCoaching,
  ensureCoachingTimerIfActive,
} from './meetingCoachingEngine';
import { createNodeFsMeetingFileStorage } from './nodeFsMeetingFileStorage';
import { createFfmpegMediaConcatProcessor } from './ffmpegMediaConcatProcessor';
import type { AgentSession } from '@shared/types';

export interface MeetingUploadSessionCloudDeps extends CloudMeetingAnalysisDeps {
  getSession: (id: string) => Promise<AgentSession | null>;
  upsertSession: (session: AgentSession) => Promise<void>;
}

const cloudMeetingStoreLog: MeetingUploadLogger = {
  info: (data, message) => log({ level: 'info', msg: message, ...data }),
  warn: (data, message) => log({ level: 'warn', msg: message, ...data }),
  error: (data, message) => log({ level: 'error', msg: message, ...data }),
  debug: (data, message) => log({ level: 'debug', msg: message, ...data }),
};

export function createMeetingUploadSessionStore(
  deps: MeetingUploadSessionCloudDeps,
  options: { fileStorage?: MeetingFileStorageAdapter } = {},
): MeetingUploadSessionStore {
  const fileStorage = options.fileStorage ?? createNodeFsMeetingFileStorage();
  return new MeetingUploadSessionStore({
    fileStorage,
    mediaConcat: createFfmpegMediaConcatProcessor(),
    transcriptionEngine: {
      transcribeChunkAsync,
      hasIncrementalTranscript,
      flushAndMarkTranscriptionComplete,
      cleanupTranscriptionState,
      getConversationState,
    },
    coachingEngine: {
      activateCoaching,
      deactivateCoaching,
      ensureCoachingTimerIfActive,
    },
    analysisRunner: {
      runAnalysis: async (payload) => runFallbackAnalysis(
        {
          botId: payload.botId,
          userId: payload.userId,
          meetingTitle: payload.meetingTitle,
          transcript: payload.transcript,
          participants: payload.participants,
          meetingStartTime: payload.meetingStartTime,
          conversationState: payload.conversationState,
          companionQAHistory: payload.companionQAHistory,
        },
        deps,
        'mobile-recording',
        payload.companionSessionId,
      ),
    },
    notificationDispatcher: {
      notifyAnalysisComplete: async ({ sessionId, meetingTitle }) => sendPushNotification({
        title: 'Meeting analysis ready',
        body: `Analysis complete: ${meetingTitle}`,
        data: buildMeetingAnalysisCompletePush({ sessionId, meetingTitle }),
      }),
    },
    sessionsAccessor: {
      getSession: deps.getSession,
      upsertSession: deps.upsertSession,
    },
    audioProcessor: {
      transcribeFullAudio: async (_sessionId, _totalChunks, mergedAudioPath) => {
        const audioBuffer = await fs.readFile(mergedAudioPath);
        const duration = await getAudioDurationMs(mergedAudioPath).catch(() => null);
        return transcribeAudio({
          audio: bufferToArrayBufferForMeetingAudio(audioBuffer),
          mimeType: 'audio/mp4',
          durationMs: duration?.durationMs,
        });
      },
    },
    logger: cloudMeetingStoreLog,
  });
}
