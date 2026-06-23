import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentEvent, AgentSession } from '@shared/types';
import type { MemoryUpdateStatus, TimeSavedStatus } from '@shared/types/agent';
import { assertNoStuckBusy } from '@shared/utils/assertNoStuckBusy';
import { STALE_TURN_THRESHOLD_MS } from '@core/services/agentTurnReducer/runtime';
import { deriveTurnLiveness, toPersistedBusyScalars } from '@core/services/conversationState';

const ORPHAN_MEMORY_UPDATE_ERROR =
  "Memory wasn't fully saved before the app closed. No data lost — newer turns will pick it up.";

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    title: 'Test Session',
    createdAt: 1000,
    updatedAt: 2000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

function memoryStatus(overrides: Partial<MemoryUpdateStatus>): MemoryUpdateStatus {
  return {
    originalTurnId: 'turn-default',
    status: 'success',
    timestamp: 1000,
    ...overrides,
  };
}

function timeSavedStatus(overrides: Partial<TimeSavedStatus>): TimeSavedStatus {
  return {
    turnId: 'turn-default',
    status: 'success',
    timestamp: 1000,
    ...overrides,
  };
}

function writeSessionFile(sessionsDir: string, session: AgentSession): void {
  fs.writeFileSync(path.join(sessionsDir, `${session.id}.json`), JSON.stringify(session), 'utf8');
}

function makeStaleInFlightSession(overrides: Partial<AgentSession> = {}): AgentSession {
  const staleTimestamp = Date.now() - STALE_TURN_THRESHOLD_MS - 1;
  return makeSession({
    activeTurnId: 'turn-inflight',
    isBusy: false,
    eventsByTurn: {
      'turn-inflight': [
        { type: 'turn_started', timestamp: staleTimestamp },
        { type: 'status', message: 'still running but quiet', timestamp: staleTimestamp },
      ],
    },
    ...overrides,
  });
}

function writeIndexFile(
  sessionsDir: string,
  indexVersion: number,
  sessions: AgentSession[],
): void {
  fs.writeFileSync(
    path.join(sessionsDir, 'index.json'),
    JSON.stringify({
      version: indexVersion,
      lastUpdated: 1000,
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        resolvedAt: session.resolvedAt ?? null,
        doneAt: session.doneAt ?? null,
        starredAt: session.starredAt ?? null,
        deletedAt: session.deletedAt ?? null,
        origin: session.origin ?? 'manual',
        isCorrupted: false,
        privateMode: session.privateMode ?? false,
        interruptedTurnId: session.interruptedTurnId ?? null,
        preview: '',
        firstMessagePreview: '',
        messageCount: session.messages.length,
        hasDraft: false,
        draftPreview: null,
        draftUpdatedAt: null,
        usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
        activeTurnId: session.activeTurnId ?? null,
        isBusy: session.isBusy,
        lastError: session.lastError ?? null,
        fingerprint: `${session.updatedAt}:test`,
      })),
    }),
    'utf8',
  );
}

describe('IncrementalSessionStore memory-update status hydration', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-update-status-'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-27T12:00:00.000Z'));
    vi.resetModules();
     
    vi.doMock('@core/logger', () => ({
      createScopedLogger: () => stubLogger,
      logger: stubLogger,
    }));
    await initTestPlatformConfig({ userDataPath: testDir });
    Object.values(stubLogger).forEach((fn) => fn.mockClear());
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function loadSession(session: AgentSession): Promise<AgentSession> {
    const { IncrementalSessionStore, INDEX_VERSION } = await import('../incrementalSessionStore');
    const sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    writeSessionFile(sessionsDir, session);
    writeIndexFile(sessionsDir, INDEX_VERSION, [session]);

    const store = new IncrementalSessionStore();
    const sessions = store.loadSync();
    expect(sessions).toHaveLength(1);
    return sessions[0];
  }

  function readPersistedSession(sessionId: string): AgentSession {
    return JSON.parse(
      fs.readFileSync(path.join(testDir, 'sessions', `${sessionId}.json`), 'utf8'),
    ) as AgentSession;
  }

  function expectIndexBusyScalarsToMatchSession(session: AgentSession): void {
    const index = JSON.parse(
      fs.readFileSync(path.join(testDir, 'sessions', 'index.json'), 'utf8'),
    ) as { sessions: Array<Pick<AgentSession, 'id' | 'isBusy' | 'activeTurnId'> & { lastActivityAt?: number | null }> };
    const entry = index.sessions.find((candidate) => candidate.id === session.id);
    const derived = deriveTurnLiveness(session.eventsByTurn ?? {}, Date.now(), {
      declaredActiveTurnId: session.activeTurnId ?? null,
    });
    const projectedScalars = toPersistedBusyScalars(derived);
    expect(entry).toMatchObject({
      isBusy: projectedScalars.isBusy,
      activeTurnId: projectedScalars.activeTurnId,
    });
    expect(entry?.lastActivityAt ?? null).toBe(derived.lastActivityAt ?? derived.startedAt ?? null);
  }

  it('clears busy scalars in sync upsert reload path when terminal event is present', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const staleSession = makeSession({
      id: 'sess-sync-stale',
      updatedAt: 3000,
      activeTurnId: 'turn-1',
      isBusy: true,
      eventsByTurn: {
        'turn-1': [
          { type: 'status', message: 'working', timestamp: 1000 },
          { type: 'result', text: 'done', timestamp: 2000 },
        ],
      },
    });

    store.upsertSessionsSyncWithReload([staleSession]);

    const onDisk = readPersistedSession('sess-sync-stale');
    expect(onDisk.isBusy).toBe(false);
    expect(onDisk.activeTurnId).toBeNull();
    assertNoStuckBusy(onDisk);
    expectIndexBusyScalarsToMatchSession(onDisk);
  });

  it('clears busy scalars in async doUpsertSession path when terminal event is present', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const staleSession = makeSession({
      id: 'sess-async-stale',
      updatedAt: 3000,
      activeTurnId: 'turn-1',
      isBusy: true,
      eventsByTurn: {
        'turn-1': [
          { type: 'status', message: 'working', timestamp: 1000 },
          { type: 'result', text: 'done', timestamp: 2000 },
        ],
      },
    });

    await store.upsertSession(staleSession);

    const onDisk = readPersistedSession('sess-async-stale');
    expect(onDisk.isBusy).toBe(false);
    expect(onDisk.activeTurnId).toBeNull();
    assertNoStuckBusy(onDisk);
    expectIndexBusyScalarsToMatchSession(onDisk);
  });

  it('preserves legitimately running busy scalars in the async write path', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const runningSession = makeSession({
      id: 'sess-async-running',
      updatedAt: 3000,
      activeTurnId: 'turn-1',
      isBusy: true,
      eventsByTurn: {
        'turn-1': [
          { type: 'turn_started', timestamp: Date.now() - 60_000 },
          { type: 'status', message: 'still working', timestamp: Date.now() - 1_000 },
        ],
      },
    });

    await store.upsertSession(runningSession);

    const onDisk = readPersistedSession('sess-async-running');
    expect(onDisk.isBusy).toBe(true);
    expect(onDisk.activeTurnId).toBe('turn-1');
    assertNoStuckBusy(onDisk);
    expectIndexBusyScalarsToMatchSession(onDisk);
  });

  it('preserves busy scalars for stale in-flight turns in the async write path', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const staleInFlightSession = makeStaleInFlightSession({
      id: 'sess-async-interrupted-write',
      updatedAt: 3000,
    });

    await store.upsertSession(staleInFlightSession);

    const onDisk = readPersistedSession('sess-async-interrupted-write');
    const derived = deriveTurnLiveness(onDisk.eventsByTurn ?? {}, Date.now(), {
      declaredActiveTurnId: onDisk.activeTurnId ?? null,
    });
    const canonicalScalars = toPersistedBusyScalars(derived);

    // Pin the intentional divergence: write-path preserves interrupted busy,
    // canonical read/load mapping clears it.
    expect(derived.status).toBe('interrupted');
    expect(canonicalScalars).toEqual({ isBusy: false, activeTurnId: null });
    expect(onDisk.isBusy).toBe(true);
    expect(onDisk.activeTurnId).toBe('turn-inflight');
    assertNoStuckBusy(onDisk);
    expectIndexBusyScalarsToMatchSession(onDisk);
  });

  it('uses stamped sessions when writing index during legacy migration (sync)', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const legacySession = makeStaleInFlightSession({
      id: 'sess-legacy-sync-stale',
      updatedAt: 3000,
    });

    fs.writeFileSync(
      path.join(testDir, 'agent-session-history.json'),
      JSON.stringify({ version: 1, sessions: [legacySession] }),
      'utf8',
    );

    const store = new IncrementalSessionStore();
    const loaded = store.loadSync();
    expect(loaded).toHaveLength(1);

    const onDisk = readPersistedSession('sess-legacy-sync-stale');
    expect(onDisk.isBusy).toBe(true);
    expect(onDisk.activeTurnId).toBe('turn-inflight');
    expectIndexBusyScalarsToMatchSession(onDisk);
  });

  it('uses stamped sessions when writing index during legacy migration (async)', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const legacySession = makeStaleInFlightSession({
      id: 'sess-legacy-async-stale',
      updatedAt: 3000,
    });

    fs.writeFileSync(
      path.join(testDir, 'agent-session-history.json'),
      JSON.stringify({ version: 1, sessions: [legacySession] }),
      'utf8',
    );

    const store = new IncrementalSessionStore();
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);

    const onDisk = readPersistedSession('sess-legacy-async-stale');
    expect(onDisk.isBusy).toBe(true);
    expect(onDisk.activeTurnId).toBe('turn-inflight');
    expectIndexBusyScalarsToMatchSession(onDisk);
  });

  it('uses stamped sessions when writing index during agent-sessions migration (sync)', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const sessionsDir = path.join(testDir, 'agent-sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const agentSession = makeStaleInFlightSession({
      id: 'sess-agent-sync-stale',
      updatedAt: 3000,
    });
    writeSessionFile(sessionsDir, agentSession);

    const store = new IncrementalSessionStore();
    const loaded = store.loadSync();
    expect(loaded.length).toBeGreaterThan(0);

    const onDisk = readPersistedSession('sess-agent-sync-stale');
    expect(onDisk.isBusy).toBe(true);
    expect(onDisk.activeTurnId).toBe('turn-inflight');
    expectIndexBusyScalarsToMatchSession(onDisk);
  });

  it('uses stamped sessions when writing index during agent-sessions migration (async)', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const sessionsDir = path.join(testDir, 'agent-sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const agentSession = makeStaleInFlightSession({
      id: 'sess-agent-async-stale',
      updatedAt: 3000,
    });
    writeSessionFile(sessionsDir, agentSession);

    const store = new IncrementalSessionStore();
    const loaded = await store.load();
    expect(loaded.length).toBeGreaterThan(0);

    const onDisk = readPersistedSession('sess-agent-async-stale');
    expect(onDisk.isBusy).toBe(true);
    expect(onDisk.activeTurnId).toBe('turn-inflight');
    expectIndexBusyScalarsToMatchSession(onDisk);
  });

  it('leaves sessions with no orphan running statuses unchanged', async () => {
    const session = makeSession({
      memoryUpdateStatusByTurn: {
        'turn-1': memoryStatus({ originalTurnId: 'turn-1', status: 'success', summary: 'Saved' }),
        'turn-2': memoryStatus({ originalTurnId: 'turn-2', status: 'error', error: 'Already failed' }),
      },
    });

    const loaded = await loadSession(session);

    expect(loaded.memoryUpdateStatusByTurn).toEqual(session.memoryUpdateStatusByTurn);
    expect(stubLogger.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ sanitizedCount: expect.any(Number) }),
      'Sanitized orphan running memory-update statuses on hydration',
    );
  });

  it('flips two orphan running statuses to branded errors', async () => {
    const session = makeSession({
      memoryUpdateStatusByTurn: {
        'turn-1': memoryStatus({ originalTurnId: 'turn-1', status: 'running' }),
        'turn-2': memoryStatus({ originalTurnId: 'turn-2', status: 'running' }),
      },
    });

    const loaded = await loadSession(session);

    expect(loaded.memoryUpdateStatusByTurn?.['turn-1']).toEqual({
      originalTurnId: 'turn-1',
      status: 'error',
      error: ORPHAN_MEMORY_UPDATE_ERROR,
      timestamp: Date.now(),
    });
    expect(loaded.memoryUpdateStatusByTurn?.['turn-2']).toEqual({
      originalTurnId: 'turn-2',
      status: 'error',
      error: ORPHAN_MEMORY_UPDATE_ERROR,
      timestamp: Date.now(),
    });
    expect(stubLogger.debug).toHaveBeenCalledWith(
      { sessionId: 'sess-1', sanitizedCount: 2 },
      'Sanitized orphan running memory-update statuses on hydration',
    );
  });

  it('only flips running statuses when terminal statuses are mixed in', async () => {
    const success = memoryStatus({ originalTurnId: 'turn-success', status: 'success', summary: 'Saved' });
    const error = memoryStatus({ originalTurnId: 'turn-error', status: 'error', error: 'Already failed' });
    const skipped = memoryStatus({ originalTurnId: 'turn-skipped', status: 'skipped' });
    const session = makeSession({
      memoryUpdateStatusByTurn: {
        'turn-success': success,
        'turn-running': memoryStatus({ originalTurnId: 'turn-running', status: 'running' }),
        'turn-error': error,
        'turn-skipped': skipped,
      },
    });

    const loaded = await loadSession(session);

    expect(loaded.memoryUpdateStatusByTurn?.['turn-success']).toEqual(success);
    expect(loaded.memoryUpdateStatusByTurn?.['turn-error']).toEqual(error);
    expect(loaded.memoryUpdateStatusByTurn?.['turn-skipped']).toEqual(skipped);
    expect(loaded.memoryUpdateStatusByTurn?.['turn-running']).toMatchObject({
      originalTurnId: 'turn-running',
      status: 'error',
      error: ORPHAN_MEMORY_UPDATE_ERROR,
    });
  });

  it('preserves originalTurnId when sanitizing an orphan running status', async () => {
    const session = makeSession({
      memoryUpdateStatusByTurn: {
        'status-key': memoryStatus({ originalTurnId: 'original-turn-preserved', status: 'running' }),
      },
    });

    const loaded = await loadSession(session);

    expect(loaded.memoryUpdateStatusByTurn?.['status-key']?.originalTurnId).toBe('original-turn-preserved');
  });

  it('marks orphan-sanitized sessions so the load path can persist the repair', async () => {
    const { isSessionSanitizedDuringHydration } = await import('../incrementalSessionStore');
    const session = makeSession({
      memoryUpdateStatusByTurn: {
        'turn-1': memoryStatus({ originalTurnId: 'turn-1', status: 'running' }),
      },
    });
    const loaded = await loadSession(session);
    expect(isSessionSanitizedDuringHydration(loaded)).toBe(true);
  });

  it('does not mark clean sessions as sanitized', async () => {
    const { isSessionSanitizedDuringHydration } = await import('../incrementalSessionStore');
    const session = makeSession({
      memoryUpdateStatusByTurn: {
        'turn-1': memoryStatus({ originalTurnId: 'turn-1', status: 'success', summary: 'Saved' }),
      },
    });
    const loaded = await loadSession(session);
    expect(isSessionSanitizedDuringHydration(loaded)).toBe(false);
  });

  it('persists the sanitized status to disk on the next saveSync', async () => {
    const { IncrementalSessionStore, INDEX_VERSION } = await import('../incrementalSessionStore');
    const sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const session = makeSession({
      memoryUpdateStatusByTurn: {
        'turn-1': memoryStatus({ originalTurnId: 'turn-1', status: 'running' }),
      },
    });
    writeSessionFile(sessionsDir, session);
    writeIndexFile(sessionsDir, INDEX_VERSION, [session]);

    const store = new IncrementalSessionStore();
    const sessions = store.loadSync();
    expect(sessions[0].memoryUpdateStatusByTurn?.['turn-1']?.status).toBe('error');

    // Trigger persistence with the sanitized session.
    store.saveSync(sessions);

    const onDisk = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sess-1.json'), 'utf8')) as AgentSession;
    expect(onDisk.memoryUpdateStatusByTurn?.['turn-1']?.status).toBe('error');
    expect(onDisk.memoryUpdateStatusByTurn?.['turn-1']?.error).toBe(ORPHAN_MEMORY_UPDATE_ERROR);
  });

  it('preserves a recently-broadcast running status within the grace window', async () => {
    // A legitimate in-flight BTS memory-update turn just broadcast "running".
    // The sanitizer must NOT flip it to error on hydration — otherwise the UI
    // shows a misleading failure while the turn is genuinely still executing.
    const recentTimestamp = Date.now() - 60_000; // 1 minute ago
    const session = makeSession({
      memoryUpdateStatusByTurn: {
        'turn-running': memoryStatus({
          originalTurnId: 'turn-running',
          status: 'running',
          timestamp: recentTimestamp,
        }),
      },
    });

    const loaded = await loadSession(session);

    expect(loaded.memoryUpdateStatusByTurn?.['turn-running']).toEqual({
      originalTurnId: 'turn-running',
      status: 'running',
      timestamp: recentTimestamp,
    });
    expect(stubLogger.debug).not.toHaveBeenCalledWith(
      expect.objectContaining({ sanitizedCount: expect.any(Number) }),
      'Sanitized orphan running memory-update statuses on hydration',
    );
  });

  it('flips a stale running status outside the grace window to error', async () => {
    // A "running" status whose timestamp predates the grace window is treated
    // as a true orphan (the BTS turn never completed before app close).
    const staleTimestamp = Date.now() - 31 * 60 * 1000; // 31 minutes ago
    const session = makeSession({
      memoryUpdateStatusByTurn: {
        'turn-stale': memoryStatus({
          originalTurnId: 'turn-stale',
          status: 'running',
          timestamp: staleTimestamp,
        }),
      },
    });

    const loaded = await loadSession(session);

    expect(loaded.memoryUpdateStatusByTurn?.['turn-stale']).toEqual({
      originalTurnId: 'turn-stale',
      status: 'error',
      error: ORPHAN_MEMORY_UPDATE_ERROR,
      timestamp: Date.now(),
    });
  });

  it('sanitizes a running status whose timestamp is missing or malformed', async () => {
    // Session JSON on disk bypasses the Zod schema at load time. A malformed
    // entry (NaN timestamp) should still be treated as an orphan —
    // `now - NaN < grace` is false, so the early-continue does not fire and
    // the entry gets the standard orphan sanitization.
    const session = makeSession({
      memoryUpdateStatusByTurn: {
        'turn-malformed': {
          originalTurnId: 'turn-malformed',
          status: 'running',
          timestamp: Number.NaN,
        } as MemoryUpdateStatus,
      },
    });

    const loaded = await loadSession(session);

    expect(loaded.memoryUpdateStatusByTurn?.['turn-malformed']).toEqual({
      originalTurnId: 'turn-malformed',
      status: 'error',
      error: ORPHAN_MEMORY_UPDATE_ERROR,
      timestamp: Date.now(),
    });
  });

  it('only sanitizes stale running statuses when recent and stale are mixed', async () => {
    const recentTimestamp = Date.now() - 60_000;
    const staleTimestamp = Date.now() - 31 * 60 * 1000;
    const session = makeSession({
      memoryUpdateStatusByTurn: {
        'turn-recent': memoryStatus({
          originalTurnId: 'turn-recent',
          status: 'running',
          timestamp: recentTimestamp,
        }),
        'turn-stale': memoryStatus({
          originalTurnId: 'turn-stale',
          status: 'running',
          timestamp: staleTimestamp,
        }),
      },
    });

    const loaded = await loadSession(session);

    expect(loaded.memoryUpdateStatusByTurn?.['turn-recent']).toEqual({
      originalTurnId: 'turn-recent',
      status: 'running',
      timestamp: recentTimestamp,
    });
    expect(loaded.memoryUpdateStatusByTurn?.['turn-stale']).toMatchObject({
      originalTurnId: 'turn-stale',
      status: 'error',
      error: ORPHAN_MEMORY_UPDATE_ERROR,
    });
    expect(stubLogger.debug).toHaveBeenCalledWith(
      { sessionId: 'sess-1', sanitizedCount: 1 },
      'Sanitized orphan running memory-update statuses on hydration',
    );
  });

  it('demotes legacy status preservation logs and dedupes them per session per process', async () => {
    const { IncrementalSessionStore, INDEX_VERSION } = await import('../incrementalSessionStore');
    const session = makeSession({
      id: 'sess-legacy-status',
      memoryUpdateStatusByTurn: {
        'turn-memory-1': memoryStatus({ originalTurnId: 'turn-memory-1', originalSessionId: undefined }),
      },
      timeSavedStatusByTurn: {
        'turn-time-1': timeSavedStatus({ turnId: 'turn-time-1', originalSessionId: undefined }),
      },
    });
    const sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    writeSessionFile(sessionsDir, session);
    writeIndexFile(sessionsDir, INDEX_VERSION, [session]);

    const firstStore = new IncrementalSessionStore();
    const firstLoad = firstStore.loadSync();
    const secondStore = new IncrementalSessionStore();
    const secondLoad = secondStore.loadSync();

    expect(firstLoad[0].memoryUpdateStatusByTurn).toEqual(session.memoryUpdateStatusByTurn);
    expect(firstLoad[0].timeSavedStatusByTurn).toEqual(session.timeSavedStatusByTurn);
    expect(secondLoad[0].memoryUpdateStatusByTurn).toEqual(session.memoryUpdateStatusByTurn);
    expect(secondLoad[0].timeSavedStatusByTurn).toEqual(session.timeSavedStatusByTurn);
    const legacyDebugCalls = stubLogger.debug.mock.calls.filter(
      ([, message]) => typeof message === 'string' && message.includes('Preserving legacy'),
    );
    expect(legacyDebugCalls).toHaveLength(1);
    expect(stubLogger.debug).toHaveBeenCalledWith(
      {
        sessionId: 'sess-legacy-status',
        legacyMemoryEntries: 1,
        legacyTimeSavedEntries: 1,
      },
      'Preserving legacy memory-update and time-saved status entries missing originalSessionId',
    );
    expect(stubLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Preserving legacy'),
    );
  });

  it('emits one first-detection summary with counts seen so far this process', async () => {
    const { IncrementalSessionStore, INDEX_VERSION } = await import('../incrementalSessionStore');
    const sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const memoryOnly = makeSession({
      id: 'sess-legacy-memory-only',
      memoryUpdateStatusByTurn: {
        'turn-memory-1': memoryStatus({ originalTurnId: 'turn-memory-1', originalSessionId: undefined }),
      },
    });
    const timeOnly = makeSession({
      id: 'sess-legacy-time-only',
      timeSavedStatusByTurn: {
        'turn-time-1': timeSavedStatus({ turnId: 'turn-time-1', originalSessionId: undefined }),
      },
    });
    writeSessionFile(sessionsDir, memoryOnly);
    writeSessionFile(sessionsDir, timeOnly);
    writeIndexFile(sessionsDir, INDEX_VERSION, [memoryOnly, timeOnly]);

    const store = new IncrementalSessionStore();
    store.loadSync();
    const secondStore = new IncrementalSessionStore();
    secondStore.loadSync();

    expect(stubLogger.info).toHaveBeenCalledWith(
      {
        sessionsWithLegacyMemoryEntries: 1,
        sessionsWithLegacyTimeSavedEntries: 0,
      },
      'First detection of legacy status entries missing originalSessionId; counts are sessions seen so far this process',
    );
    expect(stubLogger.info.mock.calls.filter(
      ([, message]) => message === 'First detection of legacy status entries missing originalSessionId; counts are sessions seen so far this process',
    )).toHaveLength(1);
    expect(stubLogger.debug).toHaveBeenCalledWith(
      { sessionId: 'sess-legacy-memory-only', legacyEntries: 1 },
      'Preserving legacy memory-update status entries missing originalSessionId',
    );
    expect(stubLogger.debug).toHaveBeenCalledWith(
      { sessionId: 'sess-legacy-time-only', legacyEntries: 1 },
      'Preserving legacy time-saved status entries missing originalSessionId',
    );
    expect(stubLogger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Preserving legacy'),
    );
  });

  it('still deletes status entries whose originalSessionId belongs to another session', async () => {
    const session = makeSession({
      id: 'sess-provenance-owner',
      memoryUpdateStatusByTurn: {
        'turn-owned': memoryStatus({
          originalTurnId: 'turn-owned',
          originalSessionId: 'sess-provenance-owner',
          summary: 'owned',
        }),
        'turn-mismatched': memoryStatus({
          originalTurnId: 'turn-mismatched',
          originalSessionId: 'other-session',
          summary: 'misrouted',
        }),
      },
      timeSavedStatusByTurn: {
        'turn-time-owned': timeSavedStatus({
          turnId: 'turn-time-owned',
          originalSessionId: 'sess-provenance-owner',
        }),
        'turn-time-mismatched': timeSavedStatus({
          turnId: 'turn-time-mismatched',
          originalSessionId: 'other-session',
        }),
      },
    });

    const loaded = await loadSession(session);

    expect(loaded.memoryUpdateStatusByTurn).toEqual({
      'turn-owned': session.memoryUpdateStatusByTurn?.['turn-owned'],
    });
    expect(loaded.timeSavedStatusByTurn).toEqual({
      'turn-time-owned': session.timeSavedStatusByTurn?.['turn-time-owned'],
    });
    expect(stubLogger.debug).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('Preserving legacy'),
    );
    expect(stubLogger.info).toHaveBeenCalledWith(
      { sessionId: 'sess-provenance-owner', removedCount: 2 },
      'Removed orphan status entries with mismatched session provenance on hydration',
    );
  });

  it('repairs a session with content-equivalent duplicate events and doubled result text', async () => {
    const turnId = 'turn-doubled';
    const half =
      'This is the model output that ended up duplicated across two seqs in the on-disk ledger.';
    const assistantOriginal: AgentEvent = {
      type: 'assistant',
      seq: 75,
      text: half,
      timestamp: 1_778_660_284_161,
    };
    const assistantRestamp: AgentEvent = {
      type: 'assistant',
      seq: 77,
      text: half,
      timestamp: 1_778_660_284_161,
    };
    const resultOriginal: AgentEvent = {
      type: 'result',
      seq: 76,
      text: half,
      timestamp: 1_778_660_284_162,
    };
    const resultRestamp: AgentEvent = {
      type: 'result',
      seq: 78,
      text: half,
      timestamp: 1_778_660_284_162,
    };

    const session = makeSession({
      id: 'sess-doubled',
      eventsByTurn: {
        [turnId]: [assistantOriginal, resultOriginal, assistantRestamp, resultRestamp],
      },
      messages: [
        {
          id: 'msg-result',
          turnId,
          role: 'result',
          text: half + '\n\n' + half,
          createdAt: 1_778_660_284_162,
        },
      ],
    });

    const loaded = await loadSession(session);

    expect(loaded.eventsByTurn[turnId]).toHaveLength(2);
    const seqs = loaded.eventsByTurn[turnId].map((e) => e.seq);
    expect(seqs).toEqual([75, 76]);
    const resultMessages = loaded.messages.filter((m) => m.role === 'result');
    expect(resultMessages).toHaveLength(1);
    expect(resultMessages[0].text).toBe(half);
  });

  it('leaves clean sessions unchanged', async () => {
    const turnId = 'turn-clean';
    const session = makeSession({
      id: 'sess-clean',
      eventsByTurn: {
        [turnId]: [
          {
            type: 'assistant',
            seq: 1,
            text: 'answer',
            timestamp: 1_000,
          },
          {
            type: 'result',
            seq: 2,
            text: 'answer',
            timestamp: 1_001,
          },
        ],
      },
      messages: [
        {
          id: 'msg-result',
          turnId,
          role: 'result',
          text: 'answer',
          createdAt: 1_001,
        },
      ],
    });

    const loaded = await loadSession(session);

    expect(loaded.eventsByTurn[turnId]).toHaveLength(2);
    expect(loaded.messages[0].text).toBe('answer');
  });

  it('does not falsely repair legitimately-repeated prose without event corroboration', async () => {
    const turnId = 'turn-repeated-prose';
    const legitimateHalf = 'Yes. Yes.';
    const doubled = legitimateHalf + '\n\n' + legitimateHalf;
    const session = makeSession({
      id: 'sess-legit-repeat',
      eventsByTurn: {
        [turnId]: [
          {
            type: 'assistant',
            seq: 10,
            text: legitimateHalf,
            timestamp: 5_000,
          },
          {
            type: 'result',
            seq: 11,
            text: doubled,
            timestamp: 5_001,
          },
        ],
      },
      messages: [
        {
          id: 'msg-result',
          turnId,
          role: 'result',
          text: doubled,
          createdAt: 5_001,
        },
      ],
    });

    const loaded = await loadSession(session);

    expect(loaded.eventsByTurn[turnId]).toHaveLength(2);
    expect(loaded.messages[0].text).toBe(doubled);
  });

  it('collapses whole-duplicate result MESSAGES (distinct ids, same turn, identical text) under a doubled turn_started', async () => {
    // 260618 diagnosis: a turn that emitted two `turn_started` events persisted
    // two byte-identical `result` messages with DISTINCT ids — rendered as two
    // duplicate "Done…" cards. The id-keyed dedup and the event-level repair
    // both miss this shape; the doubled turn_started corroborates the artifact.
    const turnId = 'turn-double-materialized';
    const resultText = 'Done.\n\n- Overview updated\n- Junior JD updated\n- Gmail draft created in-thread';
    const session = makeSession({
      id: 'sess-dup-result-msg',
      eventsByTurn: {
        [turnId]: [
          { type: 'turn_started', seq: 898, timestamp: 1_778_584_290_080 },
          { type: 'turn_started', seq: 899, timestamp: 1_778_584_290_080 },
          { type: 'assistant', seq: 1016, text: resultText, timestamp: 1_778_584_400_000 },
          { type: 'result', seq: 1017, text: resultText, timestamp: 1_778_584_400_001 },
        ],
      },
      messages: [
        { id: 'msg-result-a', turnId, role: 'result', text: resultText, createdAt: 1_778_584_400_001 },
        { id: 'msg-result-b', turnId, role: 'result', text: resultText, createdAt: 1_778_584_400_001 },
      ],
    });

    const loaded = await loadSession(session);

    const resultMessages = loaded.messages.filter((m) => m.role === 'result' && m.turnId === turnId);
    expect(resultMessages).toHaveLength(1);
    expect(resultMessages[0].id).toBe('msg-result-a'); // keeps the FIRST occurrence
    expect(resultMessages[0].text).toBe(resultText);
  });

  it('does NOT collapse duplicate result messages without a doubled turn_started (evidence gate)', async () => {
    // Conservative gate, mirroring the event-repair pass: no corroborating
    // double turn-start ⇒ no repair, even if two result messages look identical.
    const turnId = 'turn-single-start';
    const resultText = 'All set — three files updated.';
    const session = makeSession({
      id: 'sess-dup-result-uncorroborated',
      eventsByTurn: {
        [turnId]: [
          { type: 'turn_started', seq: 1, timestamp: 2_000 },
          { type: 'result', seq: 2, text: resultText, timestamp: 2_001 },
        ],
      },
      messages: [
        { id: 'msg-a', turnId, role: 'result', text: resultText, createdAt: 2_001 },
        { id: 'msg-b', turnId, role: 'result', text: resultText, createdAt: 2_001 },
      ],
    });

    const loaded = await loadSession(session);

    expect(loaded.messages.filter((m) => m.role === 'result' && m.turnId === turnId)).toHaveLength(2);
  });

  it('hydrates session seq index from persisted maxSeq and continues monotonically for new events', async () => {
    const { resetSessionSeqIndexForTests } = await import('../sessionSeqIndex');
    resetSessionSeqIndexForTests();

    const loaded = await loadSession(makeSession({
      id: 'sess-seq-hydration',
      maxSeq: 7,
      eventsByTurn: {
        legacy: [
          { type: 'status', message: 'legacy-before-seq', timestamp: 1_000 },
        ],
      },
    }));

    expect(loaded.id).toBe('sess-seq-hydration');
    expect(loaded.eventsByTurn.legacy?.[0]?.seq).toBeUndefined();

    const { LazyContextAccumulator } = await import('../lazyContextAccumulator');
    const accumulator = new LazyContextAccumulator('turn-new', 'sess-seq-hydration');
    const stamped = accumulator.appendEvent({
      type: 'status',
      message: 'new-event',
      timestamp: 2_000,
    } as AgentEvent);

    expect(stamped.seq).toBe(8);
  });

  it('preserves imageRef through a session write/read round trip with inline bytes stripped', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const session = makeSession({
      id: 'sess-image-roundtrip',
      eventsByTurn: {
        'turn-images': Array.from({ length: 5 }, (_, index): AgentEvent => ({
          type: 'tool',
          toolName: 'screenshot',
          detail: 'captured',
          stage: 'end',
          timestamp: 10 + index,
          imageContent: [{ type: 'image', data: `base64-${index}`, mimeType: 'image/png' }],
          imageRef: [{ assetId: `turn-images-1-${index}`, mimeType: 'image/png', byteSize: 123 }],
        })),
      },
    });

    const store = new IncrementalSessionStore();
    await store.save([session]);

    const loaded = await store.getSession('sess-image-roundtrip');
    expect(loaded?.eventsByTurn['turn-images']).toHaveLength(5);
    for (const [index, event] of (loaded?.eventsByTurn['turn-images'] ?? []).entries()) {
      expect(event.type).toBe('tool');
      if (event.type === 'tool') {
        expect(event.imageContent).toEqual([
          { type: 'image', data: '', mimeType: 'image/png' },
        ]);
        expect(event.imageRef).toEqual([
          { assetId: `turn-images-1-${index}`, mimeType: 'image/png', byteSize: 123 },
        ]);
      }
    }
  });

  it('keeps a 100-image ref-backed session file under 1MB after sanitization', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const largeInlineImage = 'a'.repeat(500_000);
    const session = makeSession({
      id: 'sess-image-size',
      eventsByTurn: {
        'turn-images': Array.from({ length: 100 }, (_, index): AgentEvent => ({
          type: 'tool',
          toolName: 'screenshot',
          detail: 'captured',
          stage: 'end',
          timestamp: 100 + index,
          imageContent: [{ type: 'image', data: largeInlineImage, mimeType: 'image/png' }],
          imageRef: [{ assetId: `turn-images-2-${index}`, mimeType: 'image/png', byteSize: 375_000 }],
        })),
      },
    });

    const store = new IncrementalSessionStore();
    await store.save([session]);

    const sessionPath = path.join(testDir, 'sessions', 'sess-image-size.json');
    const stat = fs.statSync(sessionPath);
    expect(stat.size).toBeLessThan(1_000_000);
    const onDisk = JSON.parse(fs.readFileSync(sessionPath, 'utf8')) as AgentSession;
    const serialized = JSON.stringify(onDisk);
    expect(serialized).not.toContain(largeInlineImage);
    expect(onDisk.eventsByTurn['turn-images']?.[0]).toMatchObject({
      type: 'tool',
      imageRef: [{ assetId: 'turn-images-2-0', mimeType: 'image/png', byteSize: 375_000 }],
    });
  });

  it('moves session assets into deleted storage with the same soft-delete timestamp suffix', async () => {
    const { setAssetStore } = await import('@core/assetStore');
    const moveSessionAssetsToDeleted = vi.fn(async (_params: { sessionId: string; timestamp: number }) => undefined);
    setAssetStore({
      writeAsset: vi.fn(),
      writeThumbnail: vi.fn(),
      generateThumbnail: vi.fn(),
      readAsset: vi.fn(),
      hasAsset: vi.fn(async () => ({ has: false })),
      listSessionAssets: vi.fn(async () => []),
      deleteSession: vi.fn(),
      moveSessionAssetsToDeleted,
      restoreSessionAssetsFromDeleted: vi.fn(),
    });
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');

    const session = makeSession({ id: 'sess-delete-assets' });
    const store = new IncrementalSessionStore();
    await store.save([session]);

    await store.deleteSession(session.id, { intent: 'user-delete' });

    expect(moveSessionAssetsToDeleted).toHaveBeenCalledTimes(1);
    const call = moveSessionAssetsToDeleted.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) {
      throw new Error('moveSessionAssetsToDeleted expected first call');
    }
    expect(call.sessionId).toBe(session.id);

    const deletedDir = path.join(testDir, 'sessions-deleted');
    const deletedFiles = fs
      .readdirSync(deletedDir)
      .filter((name) => name.startsWith(`${session.id}_`) && name.endsWith('.json'));
    expect(deletedFiles).toHaveLength(1);
    const suffixMatch = deletedFiles[0].match(new RegExp(`^${session.id}_(\\d+)\\.json$`));
    expect(suffixMatch).not.toBeNull();
    expect(call.timestamp).toBe(Number(suffixMatch?.[1]));
  });

  it('attaches a visible quota warning and still persists when session asset count exceeds the cap', async () => {
    const { setAssetStore } = await import('@core/assetStore');
    const { IncrementalSessionStore, MAX_SESSION_ASSETS } = await import('../incrementalSessionStore');
    const assetIds = Array.from({ length: MAX_SESSION_ASSETS + 1 }, (_, index) => `asset-${index}`);
    setAssetStore({
      writeAsset: vi.fn(),
      writeThumbnail: vi.fn(),
      generateThumbnail: vi.fn(),
      readAsset: vi.fn(),
      hasAsset: vi.fn(async () => ({ has: true, byteSize: 10 })),
      listSessionAssets: vi.fn(async () => assetIds),
      deleteSession: vi.fn(),
      moveSessionAssetsToDeleted: vi.fn(),
      restoreSessionAssetsFromDeleted: vi.fn(),
    });

    const session = makeSession({ id: 'sess-quota' });
    const store = new IncrementalSessionStore();

    await store.save([session]);

    const loaded = await store.getSession('sess-quota');
    expect(loaded?.quotaWarning).toEqual({
      kind: 'asset-count-exceeded',
      count: MAX_SESSION_ASSETS + 1,
      bytes: (MAX_SESSION_ASSETS + 1) * 10,
    });
    expect(stubLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        count: MAX_SESSION_ASSETS + 1,
        maxAssets: MAX_SESSION_ASSETS,
        context: 'quota',
        reason: 'quota-exceeded',
      }),
      'asset-resolution-failure',
    );
  });

  it('preserves existing quotaWarning when quota check fails', async () => {
    const { setAssetStore } = await import('@core/assetStore');
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    setAssetStore({
      writeAsset: vi.fn(),
      writeThumbnail: vi.fn(),
      generateThumbnail: vi.fn(),
      readAsset: vi.fn(),
      hasAsset: vi.fn(),
      listSessionAssets: vi.fn(async () => {
        throw new Error('asset store unavailable');
      }),
      deleteSession: vi.fn(),
      moveSessionAssetsToDeleted: vi.fn(),
      restoreSessionAssetsFromDeleted: vi.fn(),
    });

    const existingQuotaWarning = {
      kind: 'asset-bytes-exceeded' as const,
      count: 5,
      bytes: 1_500_000_000,
    };
    const session = makeSession({
      id: 'sess-quota-preserve',
      quotaWarning: existingQuotaWarning,
    });
    const store = new IncrementalSessionStore();

    await store.save([session]);

    const loaded = await store.getSession('sess-quota-preserve');
    expect(loaded?.quotaWarning).toEqual(existingQuotaWarning);
    expect(stubLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        preservedExistingWarning: true,
      }),
      'Session asset quota check unavailable; preserving existing quota warning',
    );
  });

  it('computes summary userMessageCount with the shared count helper', async () => {
    const { IncrementalSessionStore, countUserMessages } = await import('../incrementalSessionStore');
    const session = makeSession({
      id: 'sess-user-count',
      messages: [
        { id: 'u1', role: 'user', text: 'one', turnId: 't1', createdAt: 1 },
        { id: 'a1', role: 'assistant', text: 'reply', turnId: 't1', createdAt: 2 },
        { id: 'u2', role: 'user', text: 'two', turnId: 't2', createdAt: 3 },
        { id: 'r1', role: 'result', text: 'done', turnId: 't2', createdAt: 4 },
      ],
    });
    const store = new IncrementalSessionStore();

    await store.save([session]);

    const [summary] = store.listSessions({ includeInternal: true });
    expect(countUserMessages(session)).toBe(2);
    expect(summary?.userMessageCount).toBe(countUserMessages(session));
  });

  it('refreshes index summaries without rewriting session files', async () => {
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const sessionsDir = path.join(testDir, 'sessions');
    const session = makeSession({
      id: 'sess-index-only-refresh',
      messages: [
        { id: 'u1', role: 'user', text: 'one', turnId: 't1', createdAt: 1 },
        { id: 'a1', role: 'assistant', text: 'reply', turnId: 't1', createdAt: 2 },
        { id: 'u2', role: 'user', text: 'two', turnId: 't2', createdAt: 3 },
      ],
    });

    const initialStore = new IncrementalSessionStore();
    await initialStore.save([session]);

    const sessionPath = path.join(sessionsDir, `${session.id}.json`);
    const indexPath = path.join(sessionsDir, 'index.json');
    const staleIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      sessions: Array<{ id: string; userMessageCount?: number }>;
    };
    const staleEntry = staleIndex.sessions.find((entry) => entry.id === session.id);
    expect(staleEntry?.userMessageCount).toBe(2);
    if (staleEntry) {
      delete staleEntry.userMessageCount;
    }
    fs.writeFileSync(indexPath, JSON.stringify(staleIndex), 'utf8');

    const beforeContent = fs.readFileSync(sessionPath, 'utf8');
    const beforeMtimeMs = fs.statSync(sessionPath).mtimeMs;

    const store = new IncrementalSessionStore();
    store.listSessions({ includeInternal: true });
    const refreshed = await store.refreshSessionIndexSummaries([session]);

    const afterContent = fs.readFileSync(sessionPath, 'utf8');
    const afterMtimeMs = fs.statSync(sessionPath).mtimeMs;
    const refreshedIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      sessions: Array<{ id: string; userMessageCount?: number }>;
    };
    const refreshedEntry = refreshedIndex.sessions.find((entry) => entry.id === session.id);

    expect(refreshed).toBe(1);
    expect(refreshedEntry?.userMessageCount).toBe(2);
    expect(afterContent).toBe(beforeContent);
    expect(afterMtimeMs).toBe(beforeMtimeMs);
  });

  // Bounded session-file load fan-out (defense-in-depth — see
  // docs/plans/260617_session-store-fanout-bound/PLAN.md). These pin the two
  // semantics the bounded fan-out MUST preserve: index-order of the loaded
  // sessions, and the per-entry try/catch->null that makes a bad file a skipped
  // session rather than an aborted load (the index-collapse incident class).
  it('loads sessions in index order across a fan-out larger than the concurrency limit', async () => {
    const { IncrementalSessionStore, INDEX_VERSION } = await import('../incrementalSessionStore');
    const sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // 20 entries > SESSION_STORE_FS_CONCURRENCY (8), so multiple worker batches.
    const sessions = Array.from({ length: 20 }, (_, i) =>
      makeSession({ id: `sess-order-${String(i).padStart(2, '0')}`, updatedAt: 1000 + i }),
    );
    for (const session of sessions) writeSessionFile(sessionsDir, session);
    writeIndexFile(sessionsDir, INDEX_VERSION, sessions);

    const store = new IncrementalSessionStore();
    const loaded = await store.load();

    expect(loaded.map((s) => s.id)).toEqual(sessions.map((s) => s.id));
  });

  it('skips a corrupt session file as a missing session without aborting the whole load', async () => {
    const { IncrementalSessionStore, INDEX_VERSION } = await import('../incrementalSessionStore');
    const sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const good1 = makeSession({ id: 'sess-good-1', updatedAt: 1001 });
    const bad = makeSession({ id: 'sess-bad', updatedAt: 1002 });
    const good2 = makeSession({ id: 'sess-good-2', updatedAt: 1003 });

    writeSessionFile(sessionsDir, good1);
    // Corrupt payload for the middle entry: passes the name-based isSessionFile
    // denylist but fails JSON.parse -> loadSessionFile throws -> mapper returns
    // null -> filtered out, not rethrown.
    fs.writeFileSync(path.join(sessionsDir, 'sess-bad.json'), '{ not valid json', 'utf8');
    writeSessionFile(sessionsDir, good2);
    writeIndexFile(sessionsDir, INDEX_VERSION, [good1, bad, good2]);

    const store = new IncrementalSessionStore();
    const loaded = await store.load();

    // The two good sessions survive, in index order; the bad one is dropped.
    expect(loaded.map((s) => s.id)).toEqual(['sess-good-1', 'sess-good-2']);
  });

  it('finishes every changed session write before the failed save settles (no orphaned background writes) and skips the index (GPT-5.5 F1)', async () => {
    // The bounded write fan-out must not leave orphaned in-flight writes racing
    // PAST the point flush()/save() consider the operation done. A naive
    // reject-fast pool rejects as soon as the first failing worker throws, while
    // surviving workers keep writing files in the background AFTER save()'s
    // promise has already settled (save() swallows the rejection via .catch).
    // That fire-and-forget fs work can race a subsequent flush/quit — the exact
    // hazard class behind this store's data-safety incidents. The fix attempts
    // every changed session, awaits ALL of them, then throws — so when save()
    // settles, no writes are still pending.
    vi.useRealTimers(); // need real async timing for the background-write race
    try {
      const { IncrementalSessionStore } = await import('../incrementalSessionStore');
      const store = new IncrementalSessionStore();

      // 20 changed sessions > SESSION_STORE_FS_CONCURRENCY (8) so multiple worker
      // batches run; one early session fails its write.
      const sessions = Array.from({ length: 20 }, (_, i) =>
        makeSession({ id: `sess-write-${String(i).padStart(2, '0')}`, updatedAt: 2000 + i }),
      );
      const failingId = 'sess-write-02';

      let saveSettled = false;
      let completionsAfterSettle = 0;
      const attempted = new Set<string>();

      const persistSpy = vi
        .spyOn(
          store as unknown as {
            persistSessionToDisk: (filePath: string, session: AgentSession) => Promise<unknown>;
          },
          'persistSessionToDisk',
        )
        .mockImplementation(async (filePath: string, session: AgentSession) => {
          attempted.add(session.id);
          // Small async delay so a naive pool would settle (reject) while later
          // writes are still in flight.
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (session.id === failingId) {
            throw new Error('simulated disk write failure');
          }
          if (saveSettled) completionsAfterSettle += 1;
          fs.writeFileSync(filePath, JSON.stringify(session), 'utf8');
          return { session, json: JSON.stringify(session) };
        });

      // save() swallows the flush rejection (`.catch(log)`), so this resolves.
      await store.save(sessions);
      saveSettled = true;
      // Give any ORPHANED background writes a chance to complete (a naive pool
      // would record completions here; the fix must record zero).
      await new Promise((resolve) => setTimeout(resolve, 200));

      persistSpy.mockRestore();

      // (a) Every changed session was attempted.
      expect(attempted.size).toBe(sessions.length);

      // (b) THE KEY ASSERTION: no write completed after save() settled — the
      // fan-out awaited every attempt before throwing. (Naive reject-fast pool
      // would record several here.)
      expect(completionsAfterSettle).toBe(0);

      // (c) The index update was skipped (a write failed → the index must never
      // reference a session whose write failed). Nothing was committed to it.
      expect(fs.existsSync(path.join(testDir, 'sessions', 'index.json'))).toBe(false);

      // (d) The non-failing session files still landed on disk (best-effort survival).
      expect(fs.existsSync(path.join(testDir, 'sessions', 'sess-write-19.json'))).toBe(true);
      expect(fs.existsSync(path.join(testDir, 'sessions', `${failingId}.json`))).toBe(false);
    } finally {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-27T12:00:00.000Z'));
    }
  });
});
