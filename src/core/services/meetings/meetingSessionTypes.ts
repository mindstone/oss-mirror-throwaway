export type MeetingSessionStatus = 'recording' | 'finalizing' | 'processing' | 'complete' | 'failed';

export interface MeetingChunkState {
  index: number;
  idempotencyKey: string;
  hash: string;
  receivedAt: string;
  fileName: string;
  sizeBytes: number;
}

export interface MeetingSessionState {
  sessionId: string;
  status: MeetingSessionStatus;
  meetingTitle?: string;
  meetingStartTime: number;
  startedAt: string;
  updatedAt: string;
  finalizedAt?: string;
  lastChunkReceivedAt?: string;
  error?: string;
  totalChunksExpected?: number;
  chunks: MeetingChunkState[];
  /** Companion session ID for Ask Rebel Q&A during meeting (set on session create; immutable once set) */
  companionSessionId?: string | null;
}

export interface CompanionQAEntry {
  question: string;
  answer: string;
}

export interface MeetingConversationState {
  currentTopic?: string;
  summary?: string;
  openQuestions?: string[];
  recentDecisions?: string[];
}

export type MeetingUploadSessionError =
  | { kind: 'session_not_found' }
  | { kind: 'session_not_recording'; status: MeetingSessionStatus; context: 'chunk' | 'coach' }
  | { kind: 'companion_session_mismatch'; existingCompanionSessionId: string; nextCompanionSessionId: string }
  | { kind: 'chunk_conflict'; chunkIndex: number }
  | { kind: 'chunk_range_gap'; missing: number[]; extras: number[]; expected: number; received: number }
  | { kind: 'invalid_total_chunks' }
  | { kind: 'missing_skill_id' };
