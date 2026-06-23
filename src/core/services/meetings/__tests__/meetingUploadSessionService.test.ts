import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { AgentSession } from '@shared/types';
import { MeetingUploadSessionStore, RESTART_RECOVERY_ERROR } from '../meetingUploadSessionService';
import type { MeetingFileStorageAdapter } from '../meetingFileStorageAdapter';
import type { MeetingSessionState } from '../meetingSessionTypes';

class MemoryFileStorage implements MeetingFileStorageAdapter {
  public jsonWrites: Array<{ path: string; data: unknown }> = [];
  public files = new Map<string, unknown>();
  public dirs = new Set<string>();

  public constructor(private readonly root = '/memory/meeting-sessions') {}

  public getSessionDir(sessionId: string): string { return path.join(this.root, sessionId); }
  public getChunkPath(sessionId: string, chunkIndex: number): string { return path.join(this.getSessionDir(sessionId), `chunk_${chunkIndex}.m4a`); }
  public getMetaPath(sessionId: string): string { return path.join(this.getSessionDir(sessionId), 'meta.json'); }
  public async ensureSessionDir(sessionId: string): Promise<void> { this.dirs.add(this.getSessionDir(sessionId)); }
  public async ensureRoot(): Promise<void> { this.dirs.add(this.root); }
  public async writeJsonAtomic(filePath: string, data: unknown): Promise<void> { this.jsonWrites.push({ path: filePath, data: JSON.parse(JSON.stringify(data)) }); this.files.set(filePath, JSON.parse(JSON.stringify(data))); }
  public async readJson(filePath: string): Promise<unknown | null> { return this.files.get(filePath) ?? null; }
  public async listSessionDirs(): Promise<string[]> { return Array.from(this.dirs).filter((dir) => path.dirname(dir) === this.root).map((dir) => path.basename(dir)); }
  public async copyFile(src: string, dst: string): Promise<void> { this.files.set(dst, this.files.get(src) ?? new Uint8Array()); }
  public async writeFile(filePath: string, contents: string): Promise<void> { this.files.set(filePath, contents); }
  public async fileExists(filePath: string): Promise<boolean> { return this.files.has(filePath); }
  public getRoot(): string { return this.root; }
}

// Storage subclass whose FIRST writeJsonAtomic call parks at an explicit gate.
// Each write captures a deep-clone snapshot of `data` at CALL time, so a mutation
// made AFTER the call is started (but before release) is NOT reflected in that write.
class GatedFirstWriteStorage extends MemoryFileStorage {
  public release: (() => void) | null = null;
  private gated = false;

  public override async writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(data));
    if (!this.gated) {
      this.gated = true;
      await new Promise<void>((resolve) => { this.release = resolve; });
    }
    this.jsonWrites.push({ path: filePath, data: snapshot });
    this.files.set(filePath, snapshot);
  }
}

function baseState(overrides: Partial<MeetingSessionState> = {}): MeetingSessionState {
  return {
    sessionId: 's1',
    status: 'recording',
    meetingStartTime: 123,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    chunks: [],
    ...overrides,
  };
}

function companionSession(messages: Array<{ role: 'user' | 'assistant' | 'result'; text: string }>): AgentSession {
  return {
    id: 'companion',
    title: 'Companion',
    createdAt: 1,
    updatedAt: 1,
    messages: messages.map((message, index) => ({ id: `m${index}`, turnId: `t${index}`, createdAt: index, ...message })),
    eventsByTurn: {},
  } as AgentSession;
}

const stores: MeetingUploadSessionStore[] = [];

function makeStore(options: { storage?: MemoryFileStorage; transcript?: string; analysisSuccess?: boolean; sessions?: Map<string, AgentSession> } = {}) {
  const storage = options.storage ?? new MemoryFileStorage();
  const sessions = options.sessions ?? new Map<string, AgentSession>();
  const calls = {
    transcribeChunkAsync: vi.fn(),
    hasIncrementalTranscript: vi.fn(() => true),
    flushAndMarkTranscriptionComplete: vi.fn(async () => options.transcript ?? 'transcript'),
    cleanupTranscriptionState: vi.fn(),
    getConversationState: vi.fn(() => ({ currentTopic: 'Topic', summary: 'Summary', openQuestions: ['Q'], recentDecisions: ['D'] })),
    activateCoaching: vi.fn(),
    deactivateCoaching: vi.fn(),
    ensureCoachingTimerIfActive: vi.fn(),
    runAnalysis: vi.fn(async () => ({ success: options.analysisSuccess ?? true })),
    notifyAnalysisComplete: vi.fn(async () => {}),
    getSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
    upsertSession: vi.fn(async (session: AgentSession) => { sessions.set(session.id, session); }),
    transcribeFullAudio: vi.fn(async () => options.transcript ?? 'full transcript'),
    concatChunksToSingleFile: vi.fn(async () => {}),
  };
  const store = MeetingUploadSessionStore.forTesting({
    fileStorage: storage,
    mediaConcat: { concatChunksToSingleFile: calls.concatChunksToSingleFile },
    transcriptionEngine: calls,
    coachingEngine: calls,
    analysisRunner: { runAnalysis: calls.runAnalysis },
    notificationDispatcher: { notifyAnalysisComplete: calls.notifyAnalysisComplete },
    sessionsAccessor: { getSession: calls.getSession, upsertSession: calls.upsertSession },
    audioProcessor: { transcribeFullAudio: calls.transcribeFullAudio },
    generateSessionId: () => 'generated-session',
    now: () => new Date('2026-01-02T03:04:05.000Z'),
    flushIntervalMs: 10,
  });
  stores.push(store);
  return { store, storage, calls, sessions };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.stop();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('MeetingUploadSessionStore', () => {
  it('ready returns an idempotent singleton promise', () => {
    const { store } = makeStore();
    expect(store.ready()).toBe(store.ready());
  });

  it('createSession records a recording session and flushes metadata', async () => {
    const { store, storage } = makeStore();
    await store.ready();
    const result = await store.createSession({ meetingTitle: 'Title', meetingStartTime: 42 });
    expect(result).toEqual({ sessionId: 'generated-session' });
    expect(store.getSessionForTesting('generated-session')).toMatchObject({
      status: 'recording',
      meetingTitle: 'Title',
      meetingStartTime: 42,
      companionSessionId: null,
    });
    expect(storage.jsonWrites).toHaveLength(1);
  });

  it('setCompanionSessionId backfills null companion session ids', async () => {
    const { store } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState({ companionSessionId: null }));
    const result = await store.setCompanionSessionId({ sessionId: 's1', companionSessionId: 'companion-1' });
    expect(result).toEqual({
      ok: true,
      updated: true,
      backfilled: true,
      companionSessionId: 'companion-1',
    });
    expect(store.getSessionForTesting('s1')?.companionSessionId).toBe('companion-1');
  });

  it('setCompanionSessionId rejects companion id mismatches once set', async () => {
    const { store } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState({ companionSessionId: 'companion-a' }));
    const result = await store.setCompanionSessionId({ sessionId: 's1', companionSessionId: 'companion-b' });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'companion_session_mismatch',
        existingCompanionSessionId: 'companion-a',
        nextCompanionSessionId: 'companion-b',
      },
    });
  });

  it('getStatus returns null for unknown sessions', async () => {
    const { store } = makeStore();
    await store.ready();
    expect(store.getStatus('missing')).toBeNull();
  });

  it('validateChunkUpload returns session_not_found for missing sessions', async () => {
    const { store } = makeStore();
    await store.ready();
    expect(store.validateChunkUpload({ sessionId: 'missing', chunkIndex: 0, idempotencyKey: 'k' })).toEqual({ ok: false, error: { kind: 'session_not_found' } });
  });

  it('recordChunk stores chunk metadata sorted by index', async () => {
    const { store } = makeStore();
    await store.ready();
    await store.createSession({ meetingStartTime: 1 });
    store.recordChunk({ sessionId: 'generated-session', chunkIndex: 2, idempotencyKey: 'c', hash: 'h2', finalChunkPath: '/tmp/chunk_2.m4a', sizeBytes: 2 });
    store.recordChunk({ sessionId: 'generated-session', chunkIndex: 0, idempotencyKey: 'a', hash: 'h0', finalChunkPath: '/tmp/chunk_0.m4a', sizeBytes: 1 });
    expect(store.getSessionForTesting('generated-session')?.chunks.map((chunk) => chunk.index)).toEqual([0, 2]);
  });

  it('recordChunk treats same idempotency key as idempotent', async () => {
    const { store } = makeStore();
    await store.ready();
    await store.createSession({ meetingStartTime: 1 });
    store.recordChunk({ sessionId: 'generated-session', chunkIndex: 0, idempotencyKey: 'a', hash: 'h', finalChunkPath: '/tmp/chunk_0.m4a', sizeBytes: 1 });
    expect(store.recordChunk({ sessionId: 'generated-session', chunkIndex: 0, idempotencyKey: 'a', hash: 'h2', finalChunkPath: '/tmp/chunk_0.m4a', sizeBytes: 2 })).toMatchObject({ ok: true, idempotent: true, totalReceived: 1 });
  });

  it('recordChunk rejects different idempotency key conflicts', async () => {
    const { store } = makeStore();
    await store.ready();
    await store.createSession({ meetingStartTime: 1 });
    store.recordChunk({ sessionId: 'generated-session', chunkIndex: 0, idempotencyKey: 'a', hash: 'h', finalChunkPath: '/tmp/chunk_0.m4a', sizeBytes: 1 });
    expect(store.recordChunk({ sessionId: 'generated-session', chunkIndex: 0, idempotencyKey: 'b', hash: 'h2', finalChunkPath: '/tmp/chunk_0.m4a', sizeBytes: 2 })).toEqual({ ok: false, error: { kind: 'chunk_conflict', chunkIndex: 0 } });
  });

  it('recordChunk rejects non-recording sessions', async () => {
    const { store } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState({ status: 'complete' }));
    expect(store.recordChunk({ sessionId: 's1', chunkIndex: 0, idempotencyKey: 'a', hash: 'h', finalChunkPath: '/tmp/chunk_0.m4a', sizeBytes: 1 })).toEqual({ ok: false, error: { kind: 'session_not_recording', status: 'complete', context: 'chunk' } });
  });

  it('recordChunk fires transcription and coaching self-healing', async () => {
    const { store, calls } = makeStore();
    await store.ready();
    await store.createSession({ meetingStartTime: 1 });
    store.recordChunk({ sessionId: 'generated-session', chunkIndex: 0, idempotencyKey: 'a', hash: 'h', finalChunkPath: '/tmp/chunk_0.m4a', sizeBytes: 1 });
    expect(calls.transcribeChunkAsync).toHaveBeenCalledWith('generated-session', 0, '/tmp/chunk_0.m4a');
    expect(calls.ensureCoachingTimerIfActive).toHaveBeenCalledWith('generated-session');
  });

  it('requestFinalize returns invalid_total_chunks for bad totals', async () => {
    const { store } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState());
    expect(await store.requestFinalize({ sessionId: 's1', totalChunks: 0 })).toEqual({ ok: false, error: { kind: 'invalid_total_chunks' } });
  });

  it('requestFinalize returns chunk_range_gap with missing and extra metadata', async () => {
    const { store } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState({ chunks: [
      { index: 0, idempotencyKey: 'a', hash: 'h', receivedAt: 'r', fileName: 'chunk_0.m4a', sizeBytes: 1 },
      { index: 2, idempotencyKey: 'c', hash: 'h', receivedAt: 'r', fileName: 'chunk_2.m4a', sizeBytes: 1 },
    ] }));
    expect(await store.requestFinalize({ sessionId: 's1', totalChunks: 2 })).toEqual({ ok: false, error: { kind: 'chunk_range_gap', missing: [1], extras: [2], expected: 2, received: 2 } });
  });

  it('requestFinalize rejects companion session id mismatches', async () => {
    const { store } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState({
      companionSessionId: 'companion-a',
      chunks: [{ index: 0, idempotencyKey: 'a', hash: 'h', receivedAt: 'r', fileName: 'chunk_0.m4a', sizeBytes: 1 }],
    }));
    expect(await store.requestFinalize({
      sessionId: 's1',
      totalChunks: 1,
      companionSessionId: 'companion-b',
    })).toEqual({
      ok: false,
      error: {
        kind: 'companion_session_mismatch',
        existingCompanionSessionId: 'companion-a',
        nextCompanionSessionId: 'companion-b',
      },
    });
  });

  it('requestFinalize sets finalizing and schedules finalize work', async () => {
    const { store } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState({ chunks: [{ index: 0, idempotencyKey: 'a', hash: 'h', receivedAt: 'r', fileName: 'chunk_0.m4a', sizeBytes: 1 }] }));
    expect(await store.requestFinalize({ sessionId: 's1', totalChunks: 1 })).toEqual({ ok: true, kind: 'accepted' });
    await store.awaitFinalize('s1');
    expect(store.getSessionForTesting('s1')).toMatchObject({ status: 'complete', totalChunksExpected: 1 });
  });

  it('requestFinalize is idempotent for processing sessions', async () => {
    const { store } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState({ status: 'processing' }));
    expect(await store.requestFinalize({ sessionId: 's1', totalChunks: 1 })).toEqual({ ok: true, kind: 'already_in_progress', status: 'processing' });
  });

  it('finalize uses incremental transcript when present', async () => {
    const { store, calls } = makeStore({ transcript: 'incremental' });
    await store.ready();
    store.setSessionForTesting(baseState({ chunks: [{ index: 0, idempotencyKey: 'a', hash: 'h', receivedAt: 'r', fileName: 'chunk_0.m4a', sizeBytes: 1 }] }));
    await store.requestFinalize({ sessionId: 's1', totalChunks: 1 });
    await store.awaitFinalize('s1');
    expect(calls.transcribeFullAudio).not.toHaveBeenCalled();
    expect(calls.runAnalysis).toHaveBeenCalledWith(expect.objectContaining({ transcript: 'incremental' }));
  });

  it('finalize falls back to full audio when incremental transcript is absent', async () => {
    const { store, calls } = makeStore({ transcript: 'full' });
    calls.hasIncrementalTranscript.mockReturnValue(false);
    await store.ready();
    store.setSessionForTesting(baseState({ chunks: [{ index: 0, idempotencyKey: 'a', hash: 'h', receivedAt: 'r', fileName: 'chunk_0.m4a', sizeBytes: 1 }] }));
    await store.requestFinalize({ sessionId: 's1', totalChunks: 1 });
    await store.awaitFinalize('s1');
    expect(calls.transcribeFullAudio).toHaveBeenCalled();
  });

  it('finalize fails on empty transcripts', async () => {
    const { store } = makeStore({ transcript: '   ' });
    await store.ready();
    store.setSessionForTesting(baseState({ chunks: [{ index: 0, idempotencyKey: 'a', hash: 'h', receivedAt: 'r', fileName: 'chunk_0.m4a', sizeBytes: 1 }] }));
    await store.requestFinalize({ sessionId: 's1', totalChunks: 1 });
    await store.awaitFinalize('s1');
    expect(store.getSessionForTesting('s1')).toMatchObject({ status: 'failed', error: 'Transcription produced empty result' });
  });

  it('finalize marks failed when analysis reports failure', async () => {
    const { store } = makeStore({ analysisSuccess: false });
    await store.ready();
    store.setSessionForTesting(baseState({ chunks: [{ index: 0, idempotencyKey: 'a', hash: 'h', receivedAt: 'r', fileName: 'chunk_0.m4a', sizeBytes: 1 }] }));
    await store.requestFinalize({ sessionId: 's1', totalChunks: 1 });
    await store.awaitFinalize('s1');
    expect(store.getSessionForTesting('s1')?.status).toBe('failed');
  });

  it('finalize passes conversation state and companion Q&A to analysis', async () => {
    const sessions = new Map<string, AgentSession>([['companion', companionSession([{ role: 'user', text: 'Q' }, { role: 'assistant', text: 'A' }])]]);
    const { store, calls } = makeStore({ sessions });
    await store.ready();
    store.setSessionForTesting(baseState({ companionSessionId: 'companion', chunks: [{ index: 0, idempotencyKey: 'a', hash: 'h', receivedAt: 'r', fileName: 'chunk_0.m4a', sizeBytes: 1 }] }));
    await store.requestFinalize({ sessionId: 's1', totalChunks: 1, companionSessionId: 'companion' });
    await store.awaitFinalize('s1');
    expect(calls.runAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      conversationState: expect.objectContaining({ currentTopic: 'Topic' }),
      companionQAHistory: [{ question: 'Q', answer: 'A' }],
    }));
  });

  it('finalize cleanup order is complete flush, transcription cleanup, companion cleanup, push dispatch', async () => {
    const sessions = new Map<string, AgentSession>([['companion', companionSession([{ role: 'user', text: 'Q' }])]]);
    const { store, calls } = makeStore({ sessions });
    await store.ready();
    store.setSessionForTesting(baseState({ companionSessionId: 'companion', chunks: [{ index: 0, idempotencyKey: 'a', hash: 'h', receivedAt: 'r', fileName: 'chunk_0.m4a', sizeBytes: 1 }] }));
    await store.requestFinalize({ sessionId: 's1', totalChunks: 1, companionSessionId: 'companion' });
    await store.awaitFinalize('s1');
    expect(calls.cleanupTranscriptionState.mock.invocationCallOrder[0]).toBeLessThan(calls.upsertSession.mock.invocationCallOrder[0]);
    expect(calls.upsertSession.mock.invocationCallOrder[0]).toBeLessThan(calls.notifyAnalysisComplete.mock.invocationCallOrder[0]);
  });

  it('activateCoaching succeeds for recording sessions', async () => {
    const { store, calls } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState());
    expect(store.activateCoaching('s1', { skillId: 'skill', skillName: 'Skill' })).toEqual({ ok: true, value: { active: true, skillId: 'skill', skillName: 'Skill', sessionId: 's1' } });
    expect(calls.activateCoaching).toHaveBeenCalledWith('s1', 'skill', 'Skill');
  });

  it('activateCoaching rejects missing skillId', async () => {
    const { store } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState());
    expect(store.activateCoaching('s1', { skillId: '' })).toEqual({ ok: false, error: { kind: 'missing_skill_id' } });
  });

  it('activateCoaching rejects non-recording sessions', async () => {
    const { store } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState({ status: 'complete' }));
    expect(store.activateCoaching('s1', { skillId: 'skill' })).toEqual({ ok: false, error: { kind: 'session_not_recording', status: 'complete', context: 'coach' } });
  });

  it('deactivateCoaching succeeds for existing sessions', async () => {
    const { store, calls } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState());
    expect(store.deactivateCoaching('s1')).toEqual({ ok: true, value: { active: false, sessionId: 's1' } });
    expect(calls.deactivateCoaching).toHaveBeenCalledWith('s1');
  });

  it('loads persisted recording sessions', async () => {
    const storage = new MemoryFileStorage();
    storage.dirs.add(storage.getSessionDir('persisted'));
    storage.files.set(storage.getMetaPath('persisted'), baseState({ sessionId: 'persisted' }));
    const { store } = makeStore({ storage });
    await store.ready();
    expect(store.getSessionForTesting('persisted')?.status).toBe('recording');
  });

  it('recovers finalizing sessions to failed', async () => {
    const storage = new MemoryFileStorage();
    storage.dirs.add(storage.getSessionDir('persisted'));
    storage.files.set(storage.getMetaPath('persisted'), baseState({ sessionId: 'persisted', status: 'finalizing' }));
    const { store } = makeStore({ storage });
    await store.ready();
    expect(store.getSessionForTesting('persisted')).toMatchObject({ status: 'failed', error: RESTART_RECOVERY_ERROR });
  });

  it('recovers processing sessions to failed', async () => {
    const storage = new MemoryFileStorage();
    storage.dirs.add(storage.getSessionDir('persisted'));
    storage.files.set(storage.getMetaPath('persisted'), baseState({ sessionId: 'persisted', status: 'processing' }));
    const { store } = makeStore({ storage });
    await store.ready();
    expect(store.getSessionForTesting('persisted')).toMatchObject({ status: 'failed', error: RESTART_RECOVERY_ERROR });
  });

  it('ports the O(N) recovery dirty-mark loop by rewriting all loaded sessions', async () => {
    const storage = new MemoryFileStorage();
    for (const [id, status] of [['a', 'recording'], ['b', 'processing'], ['c', 'complete']] as const) {
      storage.dirs.add(storage.getSessionDir(id));
      storage.files.set(storage.getMetaPath(id), baseState({ sessionId: id, status }));
    }
    const { store } = makeStore({ storage });
    await store.ready();
    expect(storage.jsonWrites.map((write) => path.basename(path.dirname(write.path))).sort()).toEqual(['a', 'b', 'c']);
  });

  it('guards concurrent flushes with a single in-flight writer', async () => {
    const { store, storage } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState());
    store.markDirty('s1');
    await Promise.all([store.flushDirtySessionMetadata(), store.flushDirtySessionMetadata()]);
    expect(storage.jsonWrites).toHaveLength(1);
  });

  it('await resolves only after an in-flight fire-and-forget flush\'s write lands', async () => {
    const storage = new GatedFirstWriteStorage();
    const { store } = makeStore({ storage });
    await store.ready();
    store.setSessionForTesting(baseState());
    store.markDirty('s1');

    // Flush #1: fire-and-forget (simulating recordChunk's unawaited flush). It parks at the gate
    // having NOT yet written meta.json to disk.
    void store.flushDirtySessionMetadata();
    // Let flush #1 reach the gate.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(typeof storage.release).toBe('function');

    // At this point the gated write has not landed yet — disk is still empty.
    expect(await storage.readJson(storage.getMetaPath('s1'))).toBeNull();

    // Flush #2: the caller that must observe durability when its await resolves.
    // Track whether flush #2 resolves before or after the gated write is released.
    let flush2Resolved = false;
    const flush2 = store.flushDirtySessionMetadata().then(() => { flush2Resolved = true; });

    // Give any (buggy) early-return path a macrotask to resolve flush #2 prematurely.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // On the unfixed code, flush #2 takes the in-flight early-return and has ALREADY resolved
    // here — before the write landed. On the fixed code it is still chained behind the gate.
    expect(flush2Resolved).toBe(false);

    // Release the gated write so flush #1 (and the chained flush #2) can complete.
    storage.release?.();
    await flush2;
    expect(flush2Resolved).toBe(true);

    const meta = await storage.readJson(storage.getMetaPath('s1')) as MeetingSessionState | null;
    expect(meta).not.toBeNull();
    expect(meta?.sessionId).toBe('s1');
  });

  it('a same-session re-dirty during an in-flight write is not lost (F1)', async () => {
    const storage = new GatedFirstWriteStorage();
    const { store } = makeStore({ storage });
    await store.ready();
    const chunkA = { index: 0, idempotencyKey: 'a', hash: 'hA', receivedAt: 'r', fileName: 'chunk_0.m4a', sizeBytes: 1 };
    store.setSessionForTesting(baseState({ chunks: [chunkA] }));
    store.markDirty('s1');

    // Flush #1: parks at the gate, having captured a snapshot with just [chunkA].
    const flush1 = store.flushDirtySessionMetadata();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(typeof storage.release).toBe('function');

    // Mid-flush chunk append: mutate live state to [chunkA, chunkB] and re-mark dirty.
    const chunkB = { index: 1, idempotencyKey: 'b', hash: 'hB', receivedAt: 'r', fileName: 'chunk_1.m4a', sizeBytes: 2 };
    store.setSessionForTesting(baseState({ chunks: [chunkA, chunkB] }));
    store.markDirty('s1');

    // Flush #2: chains after flush #1; must persist the fresh [chunkA, chunkB] state.
    const flush2 = store.flushDirtySessionMetadata();

    storage.release?.();
    await Promise.all([flush1, flush2]);

    const meta = await storage.readJson(storage.getMetaPath('s1')) as MeetingSessionState | null;
    expect(meta).not.toBeNull();
    expect(meta?.chunks).toHaveLength(2);
  });

  it('starts metadata flush timer after ready', async () => {
    vi.useFakeTimers();
    const { store, storage } = makeStore();
    await store.ready();
    store.setSessionForTesting(baseState());
    store.markDirty('s1');
    await vi.advanceTimersByTimeAsync(11);
    expect(storage.jsonWrites.length).toBeGreaterThanOrEqual(1);
  });
});
