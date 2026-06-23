import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { vi } from 'vitest';
import type { AgentSession } from '@shared/types';
import { MeetingUploadSessionStore } from '@core/services/meetings/meetingUploadSessionService';
import { createNodeFsMeetingFileStorage } from '../services/nodeFsMeetingFileStorage';

export interface MeetingUploadSessionTestHarness {
  rootDir: string;
  store: MeetingUploadSessionStore;
  sessions: Map<string, AgentSession>;
  calls: {
    transcribeChunkAsync: ReturnType<typeof vi.fn>;
    hasIncrementalTranscript: ReturnType<typeof vi.fn>;
    flushAndMarkTranscriptionComplete: ReturnType<typeof vi.fn>;
    cleanupTranscriptionState: ReturnType<typeof vi.fn>;
    getConversationState: ReturnType<typeof vi.fn>;
    activateCoaching: ReturnType<typeof vi.fn>;
    deactivateCoaching: ReturnType<typeof vi.fn>;
    ensureCoachingTimerIfActive: ReturnType<typeof vi.fn>;
    runAnalysis: ReturnType<typeof vi.fn>;
    notifyAnalysisComplete: ReturnType<typeof vi.fn>;
    getSession: ReturnType<typeof vi.fn>;
    upsertSession: ReturnType<typeof vi.fn>;
    transcribeFullAudio: ReturnType<typeof vi.fn>;
    mediaConcat: ReturnType<typeof vi.fn>;
  };
}

export async function createMeetingUploadSessionTestHarness(options: {
  rootDir?: string;
  transcript?: string;
  analysisSuccess?: boolean;
  sessions?: AgentSession[];
} = {}): Promise<MeetingUploadSessionTestHarness> {
  const rootDir = options.rootDir ?? await mkdtemp(path.join(os.tmpdir(), 'meeting-upload-session-'));
  const sessions = new Map((options.sessions ?? []).map((session) => [session.id, session]));

  const calls = {
    transcribeChunkAsync: vi.fn(),
    hasIncrementalTranscript: vi.fn(() => true),
    flushAndMarkTranscriptionComplete: vi.fn(async () => options.transcript ?? 'mock transcript'),
    cleanupTranscriptionState: vi.fn(),
    getConversationState: vi.fn(() => ({
      currentTopic: 'Roadmap',
      summary: 'Discussed plans',
      openQuestions: ['What next?'],
      recentDecisions: ['Ship it'],
    })),
    activateCoaching: vi.fn(),
    deactivateCoaching: vi.fn(),
    ensureCoachingTimerIfActive: vi.fn(),
    runAnalysis: vi.fn(async () => ({ success: options.analysisSuccess ?? true })),
    notifyAnalysisComplete: vi.fn(async () => {}),
    getSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
    upsertSession: vi.fn(async (session: AgentSession) => {
      sessions.set(session.id, session);
    }),
    transcribeFullAudio: vi.fn(async () => options.transcript ?? 'mock transcript'),
    mediaConcat: vi.fn(async () => {}),
  };

  const store = MeetingUploadSessionStore.forTesting({
    fileStorage: createNodeFsMeetingFileStorage(rootDir),
    mediaConcat: { concatChunksToSingleFile: calls.mediaConcat },
    transcriptionEngine: {
      transcribeChunkAsync: calls.transcribeChunkAsync,
      hasIncrementalTranscript: calls.hasIncrementalTranscript,
      flushAndMarkTranscriptionComplete: calls.flushAndMarkTranscriptionComplete,
      cleanupTranscriptionState: calls.cleanupTranscriptionState,
      getConversationState: calls.getConversationState,
    },
    coachingEngine: {
      activateCoaching: calls.activateCoaching,
      deactivateCoaching: calls.deactivateCoaching,
      ensureCoachingTimerIfActive: calls.ensureCoachingTimerIfActive,
    },
    analysisRunner: { runAnalysis: calls.runAnalysis },
    notificationDispatcher: { notifyAnalysisComplete: calls.notifyAnalysisComplete },
    sessionsAccessor: {
      getSession: calls.getSession,
      upsertSession: calls.upsertSession,
    },
    audioProcessor: { transcribeFullAudio: calls.transcribeFullAudio },
    flushIntervalMs: 50,
  });
  await store.ready();

  return { rootDir, store, sessions, calls };
}
