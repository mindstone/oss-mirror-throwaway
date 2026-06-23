import type { MeetingChunkState, MeetingSessionState } from './meetingSessionTypes';

export function sanitizeLoadedState(value: unknown): MeetingSessionState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<MeetingSessionState>;
  if (typeof raw.sessionId !== 'string' || !raw.sessionId) return null;
  if (
    raw.status !== 'recording'
    && raw.status !== 'finalizing'
    && raw.status !== 'processing'
    && raw.status !== 'complete'
    && raw.status !== 'failed'
  ) {
    return null;
  }
  if (typeof raw.meetingStartTime !== 'number' || !Number.isFinite(raw.meetingStartTime)) return null;
  if (typeof raw.startedAt !== 'string' || typeof raw.updatedAt !== 'string') return null;
  const chunks = Array.isArray(raw.chunks)
    ? raw.chunks.filter((chunk): chunk is MeetingChunkState => (
      Boolean(chunk)
      && typeof chunk.index === 'number'
      && Number.isInteger(chunk.index)
      && chunk.index >= 0
      && typeof chunk.idempotencyKey === 'string'
      && typeof chunk.hash === 'string'
      && typeof chunk.receivedAt === 'string'
      && typeof chunk.fileName === 'string'
      && typeof chunk.sizeBytes === 'number'
    ))
    : [];

  return {
    sessionId: raw.sessionId,
    status: raw.status,
    meetingTitle: typeof raw.meetingTitle === 'string' ? raw.meetingTitle : undefined,
    meetingStartTime: raw.meetingStartTime,
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    finalizedAt: typeof raw.finalizedAt === 'string' ? raw.finalizedAt : undefined,
    lastChunkReceivedAt: typeof raw.lastChunkReceivedAt === 'string' ? raw.lastChunkReceivedAt : undefined,
    error: typeof raw.error === 'string' ? raw.error : undefined,
    totalChunksExpected: typeof raw.totalChunksExpected === 'number' ? raw.totalChunksExpected : undefined,
    chunks,
    companionSessionId: raw.companionSessionId === null
      ? null
      : typeof raw.companionSessionId === 'string'
        ? raw.companionSessionId
        : undefined,
  };
}
