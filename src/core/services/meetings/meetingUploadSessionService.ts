import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { fireAndForget } from '@shared/utils/fireAndForget';
import type { MeetingFileStorageAdapter } from './meetingFileStorageAdapter';
import type { MediaConcatProcessor } from './mediaConcatProcessor';
import { sanitizeLoadedState } from './sanitizeLoadedState';
import { validateContiguousChunkRange } from './validateContiguousChunkRange';
import {
  cleanupEmptyCompanionSession,
  extractCompanionQAHistory,
  type CompanionSessionAccessors,
} from './companionQaExtractor';
import type {
  CompanionQAEntry,
  MeetingChunkState,
  MeetingConversationState,
  MeetingSessionState,
  MeetingSessionStatus,
  MeetingUploadSessionError,
} from './meetingSessionTypes';

export { sanitizeLoadedState } from './sanitizeLoadedState';
export { validateContiguousChunkRange } from './validateContiguousChunkRange';
export {
  cleanupEmptyCompanionSession,
  extractCompanionQAHistory,
  extractCompanionQAPairs,
} from './companionQaExtractor';
export type {
  CompanionQAEntry,
  MeetingChunkState,
  MeetingConversationState,
  MeetingSessionState,
  MeetingSessionStatus,
  MeetingUploadSessionError,
} from './meetingSessionTypes';

export const META_FILENAME = 'meta.json';
export const METADATA_FLUSH_INTERVAL_MS = 5_000;
export const FINAL_AUDIO_FILENAME = 'final.m4a';
export const CONCAT_LIST_FILENAME = 'concat-list.txt';
export const RESTART_RECOVERY_ERROR = 'Finalization interrupted by server restart';

type IntervalHandle = ReturnType<typeof setInterval>;

type SetIntervalImpl = (handler: () => void, timeoutMs: number) => IntervalHandle;

const defaultLog = createScopedLogger({ service: 'meetingUploadSessionService' });

export interface MeetingUploadLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
  debug(data: Record<string, unknown>, message: string): void;
}

export interface MeetingTranscriptionEngine {
  transcribeChunkAsync(sessionId: string, chunkIndex: number, chunkFilePath: string): void;
  hasIncrementalTranscript(sessionId: string): boolean;
  flushAndMarkTranscriptionComplete(sessionId: string): Promise<string | null>;
  cleanupTranscriptionState(sessionId: string): void;
  getConversationState(sessionId: string): MeetingConversationState | undefined;
}

export interface MeetingCoachingEngine {
  activateCoaching(sessionId: string, skillId: string, skillName: string): void;
  deactivateCoaching(sessionId: string): void;
  ensureCoachingTimerIfActive(sessionId: string): void;
}

export interface MeetingAnalysisRunner {
  runAnalysis(payload: {
    botId: string;
    userId: 'mobile-recording';
    meetingTitle: string;
    transcript: string;
    participants: string[];
    meetingStartTime: number;
    conversationState?: MeetingConversationState;
    companionQAHistory?: CompanionQAEntry[];
    companionSessionId?: string;
  }): Promise<{ success: boolean; error?: string }>;
}

export interface MeetingNotificationDispatcher {
  notifyAnalysisComplete(payload: { sessionId: string; meetingTitle: string }): Promise<void>;
}

export interface MeetingAudioProcessor {
  transcribeFullAudio(sessionId: string, totalChunks: number, mergedAudioPath: string): Promise<string>;
}

export interface MeetingUploadSessionStoreDeps {
  fileStorage: MeetingFileStorageAdapter;
  mediaConcat: MediaConcatProcessor;
  transcriptionEngine: MeetingTranscriptionEngine;
  coachingEngine: MeetingCoachingEngine;
  analysisRunner: MeetingAnalysisRunner;
  notificationDispatcher: MeetingNotificationDispatcher;
  sessionsAccessor: CompanionSessionAccessors;
  audioProcessor: MeetingAudioProcessor;
  logger?: MeetingUploadLogger;
  flushIntervalMs?: number;
  setIntervalImpl?: SetIntervalImpl;
  clearIntervalImpl?: (handle: IntervalHandle) => void;
  now?: () => Date;
  generateSessionId?: () => string;
}

export type ValidateChunkUploadResult =
  | { ok: true; idempotent: false }
  | { ok: true; idempotent: true; chunkIndex: number; totalReceived: number }
  | { ok: false; error: Extract<MeetingUploadSessionError, { kind: 'session_not_found' | 'session_not_recording' | 'chunk_conflict' }> };

export type RecordChunkUploadResult =
  | { ok: true; idempotent: false; chunkIndex: number; totalReceived: number }
  | { ok: true; idempotent: true; chunkIndex: number; totalReceived: number }
  | { ok: false; error: Extract<MeetingUploadSessionError, { kind: 'session_not_found' | 'session_not_recording' | 'chunk_conflict' }> };

export type RequestFinalizeResult =
  | { ok: true; kind: 'accepted' }
  | { ok: true; kind: 'already_in_progress'; status: MeetingSessionStatus }
  | { ok: false; error: Extract<MeetingUploadSessionError, { kind: 'session_not_found' | 'invalid_total_chunks' | 'chunk_range_gap' | 'companion_session_mismatch' }> };

export type ActivateCoachingResult =
  | { ok: true; value: { active: true; skillId: string; skillName: string; sessionId: string } }
  | { ok: false; error: Extract<MeetingUploadSessionError, { kind: 'session_not_found' | 'session_not_recording' | 'missing_skill_id' }> };

export type DeactivateCoachingResult =
  | { ok: true; value: { active: false; sessionId: string } }
  | { ok: false; error: Extract<MeetingUploadSessionError, { kind: 'session_not_found' }> };

export type SetCompanionSessionIdResult =
  | { ok: true; updated: boolean; backfilled: boolean; companionSessionId: string | null }
  | { ok: false; error: Extract<MeetingUploadSessionError, { kind: 'session_not_found' | 'companion_session_mismatch' }> };

export interface MeetingSessionStatusPayload {
  sessionId: string;
  status: MeetingSessionStatus;
  chunksReceived: number;
  startedAt: string;
  lastChunkReceivedAt?: string;
  error?: string;
}

function noopLogger(): MeetingUploadLogger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class MeetingUploadSessionStore {
  public readonly fileStorage: MeetingFileStorageAdapter;

  private readonly mediaConcat: MediaConcatProcessor;
  private readonly transcriptionEngine: MeetingTranscriptionEngine;
  private readonly coachingEngine: MeetingCoachingEngine;
  private readonly analysisRunner: MeetingAnalysisRunner;
  private readonly notificationDispatcher: MeetingNotificationDispatcher;
  private readonly sessionsAccessor: CompanionSessionAccessors;
  private readonly audioProcessor: MeetingAudioProcessor;
  private readonly logger: MeetingUploadLogger;
  private readonly flushIntervalMs: number;
  private readonly setIntervalImpl: SetIntervalImpl;
  private readonly clearIntervalImpl: (handle: IntervalHandle) => void;
  private readonly now: () => Date;
  private readonly generateSessionId: () => string;

  private readonly sessionStates = new Map<string, MeetingSessionState>();
  private readonly dirtySessionIds = new Set<string>();
  private metadataFlushTimer: IntervalHandle | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private readonly metadataLoadPromise: Promise<void>;
  private readonly finalizePromises = new Map<string, Promise<void>>();

  public constructor(deps: MeetingUploadSessionStoreDeps) {
    this.fileStorage = deps.fileStorage;
    this.mediaConcat = deps.mediaConcat;
    this.transcriptionEngine = deps.transcriptionEngine;
    this.coachingEngine = deps.coachingEngine;
    this.analysisRunner = deps.analysisRunner;
    this.notificationDispatcher = deps.notificationDispatcher;
    this.sessionsAccessor = deps.sessionsAccessor;
    this.audioProcessor = deps.audioProcessor;
    this.logger = deps.logger ?? defaultLog;
    this.flushIntervalMs = deps.flushIntervalMs ?? METADATA_FLUSH_INTERVAL_MS;
    this.setIntervalImpl = deps.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = deps.clearIntervalImpl ?? clearInterval;
    this.now = deps.now ?? (() => new Date());
    this.generateSessionId = deps.generateSessionId ?? randomUUID;

    this.metadataLoadPromise = this.loadPersistedSessionMetadata()
      .catch((err: unknown) => {
        this.logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Failed to initialize meeting session metadata store');
      })
      .finally(() => {
        this.start();
      });
  }

  public static forTesting(overrides: Partial<MeetingUploadSessionStoreDeps> & { fileStorage: MeetingFileStorageAdapter }): MeetingUploadSessionStore {
    const logger = overrides.logger ?? noopLogger();
    return new MeetingUploadSessionStore({
      fileStorage: overrides.fileStorage,
      mediaConcat: overrides.mediaConcat ?? { concatChunksToSingleFile: async () => {} },
      transcriptionEngine: overrides.transcriptionEngine ?? {
        transcribeChunkAsync: () => {},
        hasIncrementalTranscript: () => true,
        flushAndMarkTranscriptionComplete: async () => 'mock transcript',
        cleanupTranscriptionState: () => {},
        getConversationState: () => undefined,
      },
      coachingEngine: overrides.coachingEngine ?? {
        activateCoaching: () => {},
        deactivateCoaching: () => {},
        ensureCoachingTimerIfActive: () => {},
      },
      analysisRunner: overrides.analysisRunner ?? { runAnalysis: async () => ({ success: true }) },
      notificationDispatcher: overrides.notificationDispatcher ?? { notifyAnalysisComplete: async () => {} },
      sessionsAccessor: overrides.sessionsAccessor ?? {
        getSession: async () => null,
        upsertSession: async () => {},
      },
      audioProcessor: overrides.audioProcessor ?? { transcribeFullAudio: async () => 'mock transcript' },
      logger,
      flushIntervalMs: overrides.flushIntervalMs,
      setIntervalImpl: overrides.setIntervalImpl,
      clearIntervalImpl: overrides.clearIntervalImpl,
      now: overrides.now,
      generateSessionId: overrides.generateSessionId,
    });
  }

  public ready(): Promise<void> {
    return this.metadataLoadPromise;
  }

  public start(): void {
    if (this.metadataFlushTimer) return;
    this.metadataFlushTimer = this.setIntervalImpl(() => {
      fireAndForget(
        this.flushDirtySessionMetadata(),
        'meetingUploadSessionService.flushDirtySessionMetadata.interval',
      );
    }, this.flushIntervalMs);
    this.metadataFlushTimer.unref?.();
  }

  public stop(): void {
    if (!this.metadataFlushTimer) return;
    this.clearIntervalImpl(this.metadataFlushTimer);
    this.metadataFlushTimer = null;
  }

  public async createSession(args: { meetingTitle?: string; meetingStartTime: number; companionSessionId?: string | null }): Promise<{ sessionId: string }> {
    const sessionId = this.generateSessionId();
    const now = this.now().toISOString();

    const state: MeetingSessionState = {
      sessionId,
      status: 'recording',
      meetingTitle: args.meetingTitle,
      meetingStartTime: args.meetingStartTime,
      startedAt: now,
      updatedAt: now,
      chunks: [],
      companionSessionId: args.companionSessionId ?? null,
    };

    this.sessionStates.set(sessionId, state);
    this.markDirty(sessionId);
    await this.flushDirtySessionMetadata();

    this.logger.info({ sessionId, meetingTitle: args.meetingTitle || 'untitled' }, 'Created meeting upload session');
    return { sessionId };
  }

  public getSession(sessionId: string): MeetingSessionState | undefined {
    return this.sessionStates.get(sessionId);
  }

  public getCompanionSessionId(sessionId: string): string | null {
    const session = this.sessionStates.get(sessionId);
    if (!session) return null;
    return typeof session.companionSessionId === 'string' && session.companionSessionId.length > 0
      ? session.companionSessionId
      : null;
  }

  public getStatus(sessionId: string): MeetingSessionStatusPayload | null {
    const state = this.sessionStates.get(sessionId);
    if (!state) return null;
    return {
      sessionId: state.sessionId,
      status: state.status,
      chunksReceived: state.chunks.length,
      startedAt: state.startedAt,
      lastChunkReceivedAt: state.lastChunkReceivedAt,
      error: state.error,
    };
  }

  public async setCompanionSessionId(args: { sessionId: string; companionSessionId: string | null }): Promise<SetCompanionSessionIdResult> {
    const state = this.sessionStates.get(args.sessionId);
    if (!state) return { ok: false, error: { kind: 'session_not_found' } };

    const existingCompanionSessionId = typeof state.companionSessionId === 'string'
      ? state.companionSessionId
      : null;
    const nextCompanionSessionId = args.companionSessionId;

    if (nextCompanionSessionId && existingCompanionSessionId && existingCompanionSessionId !== nextCompanionSessionId) {
      return {
        ok: false,
        error: {
          kind: 'companion_session_mismatch',
          existingCompanionSessionId,
          nextCompanionSessionId,
        },
      };
    }

    if (state.companionSessionId === nextCompanionSessionId) {
      return {
        ok: true,
        updated: false,
        backfilled: false,
        companionSessionId: nextCompanionSessionId,
      };
    }

    const backfilled = state.companionSessionId === null && typeof nextCompanionSessionId === 'string';
    state.companionSessionId = nextCompanionSessionId;
    state.updatedAt = this.now().toISOString();
    this.markDirty(args.sessionId);
    await this.flushDirtySessionMetadata();

    return {
      ok: true,
      updated: true,
      backfilled,
      companionSessionId: nextCompanionSessionId,
    };
  }

  public validateChunkUpload(args: { sessionId: string; chunkIndex: number; idempotencyKey: string }): ValidateChunkUploadResult {
    const state = this.sessionStates.get(args.sessionId);
    if (!state) return { ok: false, error: { kind: 'session_not_found' } };

    const existingChunk = getChunkStateByIndex(state, args.chunkIndex);
    if (existingChunk) {
      if (existingChunk.idempotencyKey === args.idempotencyKey) {
        return {
          ok: true,
          idempotent: true,
          chunkIndex: args.chunkIndex,
          totalReceived: state.chunks.length,
        };
      }
      return { ok: false, error: { kind: 'chunk_conflict', chunkIndex: args.chunkIndex } };
    }

    if (state.status !== 'recording') {
      return { ok: false, error: { kind: 'session_not_recording', status: state.status, context: 'chunk' } };
    }

    return { ok: true, idempotent: false };
  }

  public recordChunk(args: {
    sessionId: string;
    chunkIndex: number;
    idempotencyKey: string;
    hash: string;
    finalChunkPath: string;
    sizeBytes: number;
  }): RecordChunkUploadResult {
    const validation = this.validateChunkUpload(args);
    if (!validation.ok) return validation;
    if (validation.idempotent) return validation;

    const state = this.sessionStates.get(args.sessionId);
    if (!state) return { ok: false, error: { kind: 'session_not_found' } };

    const now = this.now().toISOString();
    state.chunks.push({
      index: args.chunkIndex,
      idempotencyKey: args.idempotencyKey,
      hash: args.hash,
      receivedAt: now,
      fileName: path.basename(args.finalChunkPath),
      sizeBytes: args.sizeBytes,
    });
    state.chunks.sort((a, b) => a.index - b.index);
    state.lastChunkReceivedAt = now;
    state.updatedAt = now;
    this.markDirty(args.sessionId);
    fireAndForget(
      this.flushDirtySessionMetadata(),
      'meetingUploadSessionService.flushDirtySessionMetadata.chunk',
    );

    this.logger.info({
      sessionId: args.sessionId,
      chunkIndex: args.chunkIndex,
      totalReceived: state.chunks.length,
      sizeBytes: args.sizeBytes,
    }, 'Stored meeting chunk upload');

    // Fire-and-forget: transcribe chunk incrementally. Errors are handled by the transcription engine.
    this.transcriptionEngine.transcribeChunkAsync(args.sessionId, args.chunkIndex, args.finalChunkPath);

    // Self-healing: ensure coaching timer is running if coaching was activated.
    this.coachingEngine.ensureCoachingTimerIfActive(args.sessionId);

    return {
      ok: true,
      idempotent: false,
      chunkIndex: args.chunkIndex,
      totalReceived: state.chunks.length,
    };
  }

  public async requestFinalize(args: { sessionId: string; totalChunks: number; companionSessionId?: string }): Promise<RequestFinalizeResult> {
    const state = this.sessionStates.get(args.sessionId);
    if (!state) return { ok: false, error: { kind: 'session_not_found' } };

    if (!Number.isInteger(args.totalChunks) || args.totalChunks <= 0) {
      return { ok: false, error: { kind: 'invalid_total_chunks' } };
    }

    if (args.companionSessionId) {
      const companionSessionUpdate = await this.setCompanionSessionId({
        sessionId: args.sessionId,
        companionSessionId: args.companionSessionId,
      });
      if (!companionSessionUpdate.ok) {
        return { ok: false, error: companionSessionUpdate.error };
      }
    }

    if (state.status === 'finalizing' || state.status === 'processing' || state.status === 'complete') {
      return { ok: true, kind: 'already_in_progress', status: state.status };
    }

    const contiguousCheck = validateContiguousChunkRange(state, args.totalChunks);
    if (!contiguousCheck.isValid) {
      return {
        ok: false,
        error: {
          kind: 'chunk_range_gap',
          missing: contiguousCheck.missing,
          extras: contiguousCheck.extras,
          expected: args.totalChunks,
          received: state.chunks.length,
        },
      };
    }

    state.status = 'finalizing';
    state.totalChunksExpected = args.totalChunks;
    state.updatedAt = this.now().toISOString();
    state.error = undefined;
    this.markDirty(args.sessionId);
    await this.flushDirtySessionMetadata();

    const finalizePromise = this.finalizeSessionAsync(args.sessionId)
      .catch((err: unknown) => {
        this.logger.error({
          sessionId: args.sessionId,
          error: err instanceof Error ? err.message : String(err),
        }, 'Unhandled finalize session async error');
      })
      .finally(() => {
        this.finalizePromises.delete(args.sessionId);
      });
    this.finalizePromises.set(args.sessionId, finalizePromise);
    fireAndForget(finalizePromise, 'meetingUploadSessionService.finalizeSessionAsync');

    return { ok: true, kind: 'accepted' };
  }

  public activateCoaching(sessionId: string, args: { skillId: string; skillName?: string }): ActivateCoachingResult {
    const state = this.sessionStates.get(sessionId);
    if (!state) return { ok: false, error: { kind: 'session_not_found' } };

    if (state.status !== 'recording') {
      return { ok: false, error: { kind: 'session_not_recording', status: state.status, context: 'coach' } };
    }

    if (!args.skillId) {
      return { ok: false, error: { kind: 'missing_skill_id' } };
    }

    const skillName = args.skillName ?? 'Coaching';
    this.coachingEngine.activateCoaching(sessionId, args.skillId, skillName);
    return { ok: true, value: { active: true, skillId: args.skillId, skillName, sessionId } };
  }

  public deactivateCoaching(sessionId: string): DeactivateCoachingResult {
    const state = this.sessionStates.get(sessionId);
    if (!state) return { ok: false, error: { kind: 'session_not_found' } };

    this.coachingEngine.deactivateCoaching(sessionId);
    return { ok: true, value: { active: false, sessionId } };
  }

  public async awaitFinalize(sessionId: string): Promise<void> {
    const promise = this.finalizePromises.get(sessionId);
    if (promise) await promise;
  }

  public flushDirtySessionMetadata(): Promise<void> {
    const result = this.flushChain.then(() => this.runFlushPass());
    // Keep the queue alive even if a pass rejects, so one failure can't wedge future
    // flushes. Callers observe the real outcome via `result`; runFlushPass() catches,
    // logs, and re-marks per-session failures so it should not reject — but if a future
    // change makes it throw, log it (rather than swallow silently) and keep the queue alive.
    this.flushChain = result.catch((err) => {
      this.logger.error(
        { error: err instanceof Error ? err.message : String(err) },
        'Unexpected error in meeting metadata flush queue',
      );
    });
    return result;
  }

  private async runFlushPass(): Promise<void> {
    // Claim-before-persist: snapshot AND clear the dirty set up front. If a session is
    // re-dirtied during an in-flight write (e.g. a new chunk recorded mid-flush),
    // markDirty() re-adds it to the now-empty set and the NEXT pass persists the fresh
    // state — instead of a post-persist delete silently dropping the re-dirty mark.
    const sessionIds = Array.from(this.dirtySessionIds);
    this.dirtySessionIds.clear();
    for (const sessionId of sessionIds) {
      try {
        await this.persistSessionState(sessionId);
      } catch (err) {
        // Re-mark so a later pass / the interval retries; never lose the dirty state.
        this.dirtySessionIds.add(sessionId);
        this.logger.error(
          { sessionId, error: err instanceof Error ? err.message : String(err) },
          'Failed to flush meeting session metadata',
        );
      }
    }
  }

  public markDirty(sessionId: string): void {
    this.dirtySessionIds.add(sessionId);
  }

  public getDirtySessionIdsForTesting(): string[] {
    return Array.from(this.dirtySessionIds);
  }

  public getSessionForTesting(sessionId: string): MeetingSessionState | undefined {
    const state = this.sessionStates.get(sessionId);
    return state ? JSON.parse(JSON.stringify(state)) as MeetingSessionState : undefined;
  }

  public setSessionForTesting(state: MeetingSessionState): void {
    this.sessionStates.set(state.sessionId, state);
  }

  public getLoadedSessionIdsForTesting(): string[] {
    return Array.from(this.sessionStates.keys());
  }

  public async loadPersistedSessionMetadata(): Promise<void> {
    await this.fileStorage.ensureRoot();

    let loadedCount = 0;
    let recoveredCount = 0;

    const sessionDirs = await this.fileStorage.listSessionDirs();
    for (const sessionId of sessionDirs) {
      const metaPath = this.fileStorage.getMetaPath(sessionId);

      try {
        const raw = await this.fileStorage.readJson(metaPath);
        if (raw === null) continue;
        const parsed = sanitizeLoadedState(raw);
        if (!parsed) continue;

        // Recover interrupted finalization/processing into explicit failed state.
        if (parsed.status === 'finalizing' || parsed.status === 'processing') {
          parsed.status = 'failed';
          parsed.error = RESTART_RECOVERY_ERROR;
          parsed.updatedAt = this.now().toISOString();
          recoveredCount++;
        }

        parsed.chunks.sort((a, b) => a.index - b.index);
        this.sessionStates.set(sessionId, parsed);
        loadedCount++;
      } catch (err) {
        this.logger.warn({
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        }, 'Failed to load meeting session metadata');
      }
    }

    if (recoveredCount > 0) {
      // Move-not-improve: preserve the original O(N) bug by marking every loaded session dirty.
      for (const sessionId of this.sessionStates.keys()) {
        this.markDirty(sessionId);
      }
      await this.flushDirtySessionMetadata();
    }

    this.logger.info({ loadedCount, recoveredCount }, 'Loaded persisted meeting session metadata');
  }

  private async persistSessionState(sessionId: string): Promise<void> {
    const state = this.sessionStates.get(sessionId);
    if (!state) return;

    await this.fileStorage.ensureSessionDir(sessionId);
    await this.fileStorage.writeJsonAtomic(this.fileStorage.getMetaPath(sessionId), state);
  }

  private async finalizeSessionAsync(sessionId: string): Promise<void> {
    const state = this.sessionStates.get(sessionId);
    if (!state) return;

    const totalChunks = state.totalChunksExpected;
    if (typeof totalChunks !== 'number' || totalChunks <= 0) {
      state.status = 'failed';
      state.error = 'Missing total chunk count for finalize';
      state.updatedAt = this.now().toISOString();
      this.markDirty(sessionId);
      await this.flushDirtySessionMetadata();
      return;
    }

    state.status = 'processing';
    state.updatedAt = this.now().toISOString();
    this.markDirty(sessionId);
    await this.flushDirtySessionMetadata();

    // Deactivate coaching on finalize (cleanup timers)
    this.coachingEngine.deactivateCoaching(sessionId);

    try {
      // Skip full-audio re-transcription if incremental transcription produced a usable transcript.
      let transcript: string;
      if (this.transcriptionEngine.hasIncrementalTranscript(sessionId)) {
        const incrementalTranscript = await this.transcriptionEngine.flushAndMarkTranscriptionComplete(sessionId);
        if (incrementalTranscript && incrementalTranscript.trim().length > 0) {
          transcript = incrementalTranscript;
          this.logger.info({
            sessionId,
            transcriptLength: transcript.length,
          }, 'Using incremental transcript for finalize (skipping full-audio transcription)');
        } else {
          transcript = await this.transcribeFullAudio(sessionId, totalChunks);
        }
      } else {
        transcript = await this.transcribeFullAudio(sessionId, totalChunks);
      }

      if (!transcript.trim()) {
        throw new Error('Transcription produced empty result');
      }

      const meetingTitle = state.meetingTitle || `Recording ${new Date(state.meetingStartTime).toLocaleString()}`;

      const conversationState = this.transcriptionEngine.getConversationState(sessionId);
      const enrichedConversationState: MeetingConversationState | undefined = conversationState
        ? {
          currentTopic: conversationState.currentTopic,
          summary: conversationState.summary,
          openQuestions: conversationState.openQuestions,
          recentDecisions: conversationState.recentDecisions,
        }
        : undefined;

      const companionQAHistory = await extractCompanionQAHistory(
        state.companionSessionId ?? undefined,
        this.sessionsAccessor,
        this.logger,
      );

      const analysisResult = await this.analysisRunner.runAnalysis({
        botId: sessionId,
        userId: 'mobile-recording',
        meetingTitle,
        transcript,
        participants: [],
        meetingStartTime: state.meetingStartTime,
        conversationState: enrichedConversationState,
        companionQAHistory,
        companionSessionId: state.companionSessionId ?? undefined,
      });

      if (!analysisResult.success) {
        throw new Error(analysisResult.error || 'Meeting analysis failed');
      }

      state.status = 'complete';
      state.error = undefined;
      state.finalizedAt = this.now().toISOString();
      state.updatedAt = state.finalizedAt;
      this.markDirty(sessionId);
      await this.flushDirtySessionMetadata();

      // Clean up transcription state
      this.transcriptionEngine.cleanupTranscriptionState(sessionId);

      // Clean up empty companion sessions (orphan cleanup)
      await cleanupEmptyCompanionSession(state.companionSessionId ?? undefined, this.sessionsAccessor, this.logger);

      // Send push notification on analysis completion. Move-not-improve: fire-and-forget at the call site.
      void this.notificationDispatcher.notifyAnalysisComplete({ sessionId, meetingTitle }).catch((err: unknown) => {
        this.logger.warn({
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        }, 'Failed to send analysis completion push notification');
      });

      this.logger.info({
        sessionId,
        totalChunks,
        hasConversationState: Boolean(enrichedConversationState),
        hasCompanionQA: Boolean(companionQAHistory && companionQAHistory.length > 0),
      }, 'Meeting session finalize completed');
    } catch (err) {
      state.status = 'failed';
      state.error = err instanceof Error ? err.message : String(err);
      state.updatedAt = this.now().toISOString();
      this.markDirty(sessionId);
      await this.flushDirtySessionMetadata();

      // Clean up transcription state on failure too
      this.transcriptionEngine.cleanupTranscriptionState(sessionId);

      this.logger.error({ sessionId, error: state.error }, 'Meeting session finalize failed');
    }
  }

  private async transcribeFullAudio(sessionId: string, totalChunks: number): Promise<string> {
    const mergedAudioPath = await this.concatChunksToSingleFile(sessionId, totalChunks);
    return this.audioProcessor.transcribeFullAudio(sessionId, totalChunks, mergedAudioPath);
  }

  private async concatChunksToSingleFile(sessionId: string, totalChunks: number): Promise<string> {
    const sessionDir = this.fileStorage.getSessionDir(sessionId);
    const outputPath = path.join(sessionDir, FINAL_AUDIO_FILENAME);

    if (totalChunks === 1) {
      await this.fileStorage.copyFile(this.fileStorage.getChunkPath(sessionId, 0), outputPath);
      return outputPath;
    }

    const concatListPath = path.join(sessionDir, CONCAT_LIST_FILENAME);
    const chunkPaths = Array.from({ length: totalChunks }, (_, chunkIndex) => this.fileStorage.getChunkPath(sessionId, chunkIndex));

    await this.mediaConcat.concatChunksToSingleFile({
      sessionDir,
      chunkPaths,
      outputPath,
      concatListPath,
    });

    return outputPath;
  }
}

export function getChunkStateByIndex(
  state: MeetingSessionState,
  chunkIndex: number,
): MeetingChunkState | undefined {
  return state.chunks.find((chunk) => chunk.index === chunkIndex);
}

export function bufferToArrayBufferForMeetingAudio(bytes: Uint8Array): ArrayBuffer {
  return toArrayBuffer(bytes);
}
