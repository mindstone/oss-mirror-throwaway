/**
 * Tests for the turn checkpoint service.
 *
 * Covers three layers, in order of dependency:
 *   1. `mergeTurnIntoSession` — pure merge function. Plain unit tests.
 *   2. `IncrementalSessionStore.updateSession` — atomic read-modify-write.
 *      Uses a real store against a temp directory so the writeQueue
 *      serialisation behaviour is exercised end-to-end.
 *   3. `TurnCheckpointManager` — periodic + terminal lifecycle. Uses fake
 *      timers and an in-memory mock store / accumulator.
 *
 * @see docs/plans/260426_main_process_turn_checkpointing.md
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentEvent, AgentSession, AgentTurnMessage } from '@shared/types';
import type { ConversationStateShape } from '@shared/utils/conversationState';
import type { LazyContextAccumulator } from '../lazyContextAccumulator';
import type { SessionLockManager } from '@core/utils/sessionFileLock';
import {
  mergeTurnIntoSession,
  TurnCheckpointManager,
  type TurnCheckpointStore,
} from '../turnCheckpointService';

// ---------------------------------------------------------------------------
// Shared logger stub. The checkpoint service uses createScopedLogger; we mock
// it once so the tests don't litter stdout when exercising error paths.
//
// `vi.hoisted` is required because `vi.mock` is hoisted above all imports —
// referencing a top-level `stubLogger` from inside the factory would error
// with "Cannot access 'stubLogger' before initialization".
// ---------------------------------------------------------------------------

const { stubLogger } = vi.hoisted(() => ({
  stubLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => stubLogger,
  logger: stubLogger,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeMessage(overrides: Partial<AgentTurnMessage> = {}): AgentTurnMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    turnId: 'turn-1',
    role: 'assistant',
    text: 'hello',
    createdAt: 1500,
    ...overrides,
  };
}

function makeShape(
  turnId: string,
  overrides: Partial<ConversationStateShape> = {},
): ConversationStateShape {
  return {
    messages: [],
    eventsByTurn: {},
    activeTurnId: turnId,
    focusedTurnId: null,
    isBusy: true,
    lastError: null,
    lastErrorSource: null,
    terminatedTurnIds: new Set(),
    ...overrides,
  };
}

function makeStatusEvent(message = 'thinking', timestamp = 1100): AgentEvent {
  return { type: 'status', message, timestamp } as AgentEvent;
}

function makeResultEvent(text = 'done', timestamp = 1900): AgentEvent {
  return { type: 'result', text, timestamp } as AgentEvent;
}

// ===========================================================================
// 1. mergeTurnIntoSession — pure function tests
// ===========================================================================

describe('mergeTurnIntoSession', () => {
  it('creates a minimal session when existing is null (first-write case)', () => {
    const turnId = 'turn-1';
    const sessionId = 'sess-new';
    const events = [makeStatusEvent()];
    const messages = [makeMessage({ turnId })];
    const shape = makeShape(turnId, {
      messages,
      eventsByTurn: { [turnId]: events },
    });

    const result = mergeTurnIntoSession(null, shape, sessionId, turnId, false);

    expect(result.id).toBe(sessionId);
    expect(result.title).toBe('New Agent Run');
    expect(result.origin).toBe('manual');
    expect(result.messages).toEqual(messages);
    expect(result.eventsByTurn[turnId]).toEqual(events);
    expect(result.activeTurnId).toBe(turnId);
    expect(result.isBusy).toBe(true);
    expect(result.resolvedAt).toBeNull();
    expect(typeof result.createdAt).toBe('number');
    expect(typeof result.updatedAt).toBe('number');
  });

  it('first-writes a kind-aware default title for use-case-discovery sessions', () => {
    const turnId = 'turn-ucd';
    const sessionId = 'use-case-discovery-abc123';
    const shape = makeShape(turnId, {
      messages: [makeMessage({ turnId })],
      eventsByTurn: { [turnId]: [makeStatusEvent()] },
    });

    const result = mergeTurnIntoSession(null, shape, sessionId, turnId, false);

    expect(result.title).toBe('Use-case ideas');
    expect(result.origin).toBe('manual');
  });

  it('omits the empty turn entry when first-write has zero events', () => {
    const turnId = 'turn-1';
    const shape = makeShape(turnId, { messages: [], eventsByTurn: {} });

    const result = mergeTurnIntoSession(null, shape, 'sess-new', turnId, false);

    // No empty array left behind for `eventsByTurn[turnId]`.
    expect(result.eventsByTurn).toEqual({});
  });

  it('replaces events for the current turn while preserving other turns', () => {
    const existing = makeSession({
      eventsByTurn: {
        'turn-old': [makeStatusEvent('old turn status', 500)],
        'turn-1': [makeStatusEvent('stale event', 999)], // will be replaced
      },
    });

    const newEvents = [makeStatusEvent('new', 1100), makeStatusEvent('newer', 1200)];
    const shape = makeShape('turn-1', { eventsByTurn: { 'turn-1': newEvents } });

    const result = mergeTurnIntoSession(existing, shape, existing.id, 'turn-1', false);

    expect(result.eventsByTurn['turn-1']).toEqual(newEvents);
    // Other turn untouched.
    expect(result.eventsByTurn['turn-old']).toEqual(existing.eventsByTurn['turn-old']);
  });

  it('replaces non-user messages for the current turn but preserves user messages and other turn messages', () => {
    const userMsg = makeMessage({ id: 'u1', turnId: 'turn-1', role: 'user', text: 'q', createdAt: 1000 });
    const oldAssistant = makeMessage({ id: 'a-old', turnId: 'turn-1', role: 'assistant', text: 'partial', createdAt: 1100 });
    const otherTurnMsg = makeMessage({ id: 'o1', turnId: 'turn-old', role: 'assistant', text: 'old', createdAt: 500 });

    const existing = makeSession({
      messages: [otherTurnMsg, userMsg, oldAssistant],
    });

    const newAssistant = makeMessage({ id: 'a-new', turnId: 'turn-1', role: 'assistant', text: 'final', createdAt: 1200 });
    const shape = makeShape('turn-1', { messages: [newAssistant] });

    const result = mergeTurnIntoSession(existing, shape, existing.id, 'turn-1', false);

    // User message preserved.
    expect(result.messages.find((m) => m.id === 'u1')).toBeDefined();
    // Other turn preserved.
    expect(result.messages.find((m) => m.id === 'o1')).toBeDefined();
    // New assistant present.
    expect(result.messages.find((m) => m.id === 'a-new')).toBeDefined();
    // Old assistant from THIS turn is dropped (replaced by accumulator).
    expect(result.messages.find((m) => m.id === 'a-old')).toBeUndefined();
    // Sorted ascending by createdAt.
    expect(result.messages.map((m) => m.createdAt)).toEqual([500, 1000, 1200]);
  });

  it('terminal merge sets activeTurnId to null and isBusy to false regardless of shape', () => {
    const existing = makeSession();
    // Shape claims the turn is still active.
    const shape = makeShape('turn-1', { activeTurnId: 'turn-1', isBusy: true });

    const result = mergeTurnIntoSession(existing, shape, existing.id, 'turn-1', true);

    expect(result.activeTurnId).toBeNull();
    expect(result.isBusy).toBe(false);
  });

  it('non-terminal merge mirrors activeTurnId and isBusy from the shape', () => {
    const existing = makeSession();
    const shape = makeShape('turn-1', { activeTurnId: 'turn-1', isBusy: true });

    const result = mergeTurnIntoSession(existing, shape, existing.id, 'turn-1', false);

    expect(result.activeTurnId).toBe('turn-1');
    expect(result.isBusy).toBe(true);
  });

  it('preserves all existing metadata fields verbatim', () => {
    const existing = makeSession({
      title: 'My Custom Title',
      doneAt: 5000,
      starredAt: 6000,
      deletedAt: null,
      privateMode: true,
      origin: 'automation',
      resolvedAt: 7777,
      draft: { text: 'in-flight', updatedAt: 8000 },
      automationId: 'auto-123',
      automationRunId: 'run-456',
      maxSeq: 42,
      cloudUpdatedAt: 9000,
      memoryUpdateStatusByTurn: { 'turn-1': { status: 'pending', startedAt: 100 } as never },
      timeSavedStatusByTurn: { 'turn-1': { status: 'completed' } as never },
      compactionBoundaries: [{ afterMessageIndex: 0, summary: 'sum', timestamp: 1000, depth: 1 }],
      setupContext: { kind: 'bundled-app-bridge', pairSessionId: 'pair-1' },
      meetingCompanion: { meetingUrl: 'https://x', meetingTitle: 't', startedAt: 1 },
    });

    const shape = makeShape('turn-1');
    const result = mergeTurnIntoSession(existing, shape, existing.id, 'turn-1', false);

    expect(result.title).toBe('My Custom Title');
    expect(result.doneAt).toBe(5000);
    expect(result.starredAt).toBe(6000);
    expect(result.deletedAt).toBeNull();
    expect(result.privateMode).toBe(true);
    expect(result.origin).toBe('automation');
    expect(result.resolvedAt).toBe(7777);
    expect(result.draft).toEqual({ text: 'in-flight', updatedAt: 8000 });
    expect(result.automationId).toBe('auto-123');
    expect(result.automationRunId).toBe('run-456');
    expect(result.maxSeq).toBe(42);
    expect(result.cloudUpdatedAt).toBe(9000);
    expect(result.memoryUpdateStatusByTurn).toEqual(existing.memoryUpdateStatusByTurn);
    expect(result.timeSavedStatusByTurn).toEqual(existing.timeSavedStatusByTurn);
    expect(result.compactionBoundaries).toEqual(existing.compactionBoundaries);
    expect(result.setupContext).toEqual(existing.setupContext);
    expect(result.meetingCompanion).toEqual(existing.meetingCompanion);
    // createdAt is preserved (set once at session birth)
    expect(result.createdAt).toBe(existing.createdAt);
  });

  it('updates updatedAt to the current time', () => {
    const existing = makeSession({ updatedAt: 100 });
    const before = Date.now();

    const result = mergeTurnIntoSession(existing, makeShape('turn-1'), existing.id, 'turn-1', false);

    expect(result.updatedAt).toBeGreaterThanOrEqual(before);
    expect(result.updatedAt).not.toBe(100);
  });

  it('recomputes maxSeq from merged events and preserves monotonicity', () => {
    const existing = makeSession({ maxSeq: 4 });
    const shape = makeShape('turn-1', {
      eventsByTurn: {
        'turn-1': [
          { type: 'status', message: 'older', timestamp: 1100, seq: 3 } as AgentEvent,
          { type: 'status', message: 'newer', timestamp: 1200, seq: 9 } as AgentEvent,
        ],
      },
    });

    const result = mergeTurnIntoSession(existing, shape, existing.id, 'turn-1', false);
    expect(result.maxSeq).toBe(9);
  });

  it('decouples persisted events from the live shape (defensive copy)', () => {
    const turnEvents = [makeStatusEvent('one', 1100)];
    const shape = makeShape('turn-1', { eventsByTurn: { 'turn-1': turnEvents } });

    const result = mergeTurnIntoSession(null, shape, 'sess-x', 'turn-1', false);

    // Mutating the shape's array after the merge must not affect the persisted snapshot.
    turnEvents.push(makeStatusEvent('two', 1200));
    expect(result.eventsByTurn['turn-1']).toHaveLength(1);
  });

  it('propagates lastError from the shape', () => {
    const existing = makeSession({ lastError: null });
    const shape = makeShape('turn-1', { lastError: 'boom' });

    const result = mergeTurnIntoSession(existing, shape, existing.id, 'turn-1', false);
    expect(result.lastError).toBe('boom');
  });
});

// ===========================================================================
// 2. IncrementalSessionStore.updateSession — atomic read-modify-write
// ===========================================================================
//
// These tests exercise a real `IncrementalSessionStore` against a temp dir so
// that we cover the actual writeQueue serialisation behaviour. Pattern lifted
// from incrementalSessionStore.safety.test.ts and incrementalSessionStore.
// interruption.test.ts.
// ---------------------------------------------------------------------------

describe('IncrementalSessionStore.updateSession', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-checkpoint-store-'));
    vi.resetModules();
    await initTestPlatformConfig({ userDataPath: testDir });
    Object.values(stubLogger).forEach((fn) => (fn as Mock).mockClear());
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Build a fresh store against the per-test temp dir. Each test calls this
   * to avoid module-level singleton state leaking between tests.
   */
  async function getStore() {
    const mod = await import('../incrementalSessionStore');
    return new mod.IncrementalSessionStore();
  }

  it('returns true on a successful write', async () => {
    const store = await getStore();
    const session = makeSession({ id: 'sess-write', updatedAt: 1234 });

    const ok = await store.updateSession(session.id, () => session);

    expect(ok).toBe(true);
    const filePath = path.join(testDir, 'sessions', `${session.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf8')) as AgentSession;
    expect(onDisk.id).toBe(session.id);
    expect(onDisk.updatedAt).toBe(1234);
  });

  it('returns false when the store is in read-only mode', async () => {
    const store = await getStore();
    store.setReadOnlyMode(true);

    const ok = await store.updateSession('sess-x', () => makeSession({ id: 'sess-x' }));

    expect(ok).toBe(false);
    expect(fs.existsSync(path.join(testDir, 'sessions'))).toBe(false);
  });

  it('returns false when the session ID is invalid', async () => {
    const store = await getStore();
    const mutator = vi.fn(() => makeSession({ id: 'sess-x' }));

    const ok = await store.updateSession('../bad/id', mutator);

    expect(ok).toBe(false);
    // Mutator must NOT have been invoked — we abort before reading.
    expect(mutator).not.toHaveBeenCalled();
  });

  it('returns false when the mutator returns null (abort)', async () => {
    const store = await getStore();

    const ok = await store.updateSession('sess-skip', () => null);

    expect(ok).toBe(false);
    expect(fs.existsSync(path.join(testDir, 'sessions', 'sess-skip.json'))).toBe(false);
  });

  it('returns false when the session file is corrupt (parse error, non-ENOENT)', async () => {
    const store = await getStore();
    const sessionsDir = path.join(testDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Write a corrupt JSON file under the session ID.
    fs.writeFileSync(path.join(sessionsDir, 'sess-corrupt.json'), '{not valid json', 'utf8');

    const mutator = vi.fn(() => makeSession({ id: 'sess-corrupt' }));
    const ok = await store.updateSession('sess-corrupt', mutator);

    expect(ok).toBe(false);
    // The corrupt file must NOT have been overwritten — checkpoint defers.
    expect(fs.readFileSync(path.join(sessionsDir, 'sess-corrupt.json'), 'utf8')).toBe(
      '{not valid json',
    );
    // Mutator must NOT have been invoked when the read failed.
    expect(mutator).not.toHaveBeenCalled();
  });

  it('passes the existing session to the mutator when the file exists', async () => {
    const store = await getStore();
    const initial = makeSession({ id: 'sess-existing', title: 'Initial' });
    await store.upsertSession(initial);

    const mutator = vi.fn((existing: AgentSession | null): AgentSession | null => {
      expect(existing).not.toBeNull();
      expect(existing?.id).toBe('sess-existing');
      expect(existing?.title).toBe('Initial');
      return { ...(existing as AgentSession), title: 'Updated' };
    });

    const ok = await store.updateSession('sess-existing', mutator);
    expect(ok).toBe(true);
    expect(mutator).toHaveBeenCalledOnce();

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(testDir, 'sessions', 'sess-existing.json'), 'utf8'),
    ) as AgentSession;
    expect(onDisk.title).toBe('Updated');
  });

  it('passes null to the mutator when the session file does not exist (ENOENT)', async () => {
    const store = await getStore();

    const mutator = vi.fn((existing: AgentSession | null): AgentSession => {
      expect(existing).toBeNull();
      return makeSession({ id: 'sess-fresh', title: 'Fresh' });
    });

    const ok = await store.updateSession('sess-fresh', mutator);
    expect(ok).toBe(true);
    expect(mutator).toHaveBeenCalledOnce();
  });

  // Ported peer regression (260612 delete-wins collision, arbitration F5),
  // adapted to OUR outcome shape: a user-delete writes the durable hard-delete
  // ledger, so a late turn-checkpoint merge must not resurrect the session as
  // a first-write shell — updateSession reports false and no file appears.
  it('refuses a checkpoint first-write shell for a deleted active session even with a fresh createdAt', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-06-12T10:00:00.000Z'));
      const store = await getStore();
      const sessionId = 'sess-deleted-active-checkpoint';
      const turnId = 'turn-deleted-active';
      await store.upsertSession(makeSession({
        id: sessionId,
        activeTurnId: turnId,
        isBusy: true,
        eventsByTurn: {
          [turnId]: [{ type: 'status', message: 'running', timestamp: Date.now() } as AgentEvent],
        },
      }));
      await store.deleteSession(sessionId, { intent: 'user-delete' });

      vi.setSystemTime(new Date('2026-06-12T10:01:00.000Z'));
      const shape = makeShape(turnId, {
        messages: [makeMessage({ id: 'assistant-after-delete', turnId, text: 'late checkpoint' })],
        eventsByTurn: {
          [turnId]: [
            makeStatusEvent('late status', Date.now()),
            makeResultEvent('late terminal result', Date.now()),
          ],
        },
        activeTurnId: null,
        isBusy: false,
      });

      const ok = await store.updateSession(sessionId, (current) =>
        mergeTurnIntoSession(current, shape, sessionId, turnId, true),
      );

      expect(ok).toBe(false);
      expect(await store.getSession(sessionId)).toBeNull();
      expect(fs.existsSync(path.join(testDir, 'sessions', `${sessionId}.json`))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serialises concurrent updateSession calls through the write queue', async () => {
    const store = await getStore();
    const sessionId = 'sess-concurrent';

    // Seed the file so all subsequent updates start from a known state.
    await store.upsertSession(makeSession({ id: sessionId, title: 'seed' }));

    // Fire three concurrent updates that each read-modify-write the title.
    // If the queue serialises correctly, every call sees the prior write.
    const observed: Array<string | null | undefined> = [];

    const p1 = store.updateSession(sessionId, (existing) => {
      observed.push(existing?.title);
      return { ...(existing as AgentSession), title: 'one' };
    });
    const p2 = store.updateSession(sessionId, (existing) => {
      observed.push(existing?.title);
      return { ...(existing as AgentSession), title: 'two' };
    });
    const p3 = store.updateSession(sessionId, (existing) => {
      observed.push(existing?.title);
      return { ...(existing as AgentSession), title: 'three' };
    });

    const [ok1, ok2, ok3] = await Promise.all([p1, p2, p3]);
    expect(ok1 && ok2 && ok3).toBe(true);

    // Each mutator saw the previous mutator's write.
    expect(observed).toEqual(['seed', 'one', 'two']);

    // Final disk state is from the last write.
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(testDir, 'sessions', `${sessionId}.json`), 'utf8'),
    ) as AgentSession;
    expect(onDisk.title).toBe('three');
  });

  it('queue keeps processing after a mutator throws', async () => {
    const store = await getStore();
    const sessionId = 'sess-throws';

    await store.upsertSession(makeSession({ id: sessionId, title: 'before' }));

    const okThrow = await store.updateSession(sessionId, () => {
      throw new Error('mutator boom');
    });
    expect(okThrow).toBe(false);

    // File should still hold the original — failed write must not corrupt state.
    let onDisk = JSON.parse(
      fs.readFileSync(path.join(testDir, 'sessions', `${sessionId}.json`), 'utf8'),
    ) as AgentSession;
    expect(onDisk.title).toBe('before');

    // A subsequent update should still succeed.
    const okNext = await store.updateSession(sessionId, (existing) => ({
      ...(existing as AgentSession),
      title: 'after',
    }));
    expect(okNext).toBe(true);

    onDisk = JSON.parse(
      fs.readFileSync(path.join(testDir, 'sessions', `${sessionId}.json`), 'utf8'),
    ) as AgentSession;
    expect(onDisk.title).toBe('after');
  });
});

// ===========================================================================
// 3. TurnCheckpointManager — lifecycle tests
// ===========================================================================
//
// Uses fake timers + an in-memory mock store + a fake accumulator. We do NOT
// touch the file system — we only verify the manager's call patterns into the
// store and timer behaviour. The store's atomic write semantics are covered
// in the previous suite.
// ---------------------------------------------------------------------------

/**
 * Minimal fake store that records every `updateSession` call. The mutator is
 * invoked with `null` by default (simulating a fresh session) so we can
 * inspect the merged session that would have been written. Tests can override
 * the existing-session that's passed to the mutator via `setExisting()`, and
 * can force failures via `setNextResult()`.
 */
function createFakeStore(): {
  store: TurnCheckpointStore;
  calls: Array<{ sessionId: string; written: AgentSession | null }>;
  setExisting: (existing: AgentSession | null) => void;
  setNextResult: (ok: boolean) => void;
} {
  const calls: Array<{ sessionId: string; written: AgentSession | null }> = [];
  let existing: AgentSession | null = null;
  let nextResult: boolean | null = null;

  const store: TurnCheckpointStore = {
    async getSession() {
      return existing;
    },
    upsertSessionsSyncWithReload(sessions) {
      const result = sessions[0] ?? null;
      calls.push({ sessionId: result?.id ?? 'unknown', written: result });
      if (nextResult !== null) {
        const r = nextResult;
        nextResult = null;
        if (!r) {
          throw new Error('fake write failed');
        }
      }
      existing = result;
      return {
        outcome: 'persisted' as const,
        persistedSessionIds: result ? [result.id] : [],
        droppedTombstonedSessionIds: [],
      };
    },
  };

  return {
    store,
    calls,
    setExisting: (e) => {
      existing = e;
    },
    setNextResult: (ok) => {
      nextResult = ok;
    },
  };
}

function createFakeLockManager(): SessionLockManager {
  const asyncHandle = { release: vi.fn(async () => undefined) };
  const syncHandle = { release: vi.fn(() => undefined) };
  return {
    acquirePerSession: vi.fn(async () => asyncHandle),
    acquireGlobalIndex: vi.fn(async () => asyncHandle),
    acquirePerSessionSync: vi.fn(() => syncHandle),
    acquireGlobalIndexSync: vi.fn(() => syncHandle),
  };
}

function createCheckpointManager(
  deps: Omit<ConstructorParameters<typeof TurnCheckpointManager>[0], 'lockManager' | 'ownerKind'>,
): TurnCheckpointManager {
  return new TurnCheckpointManager({
    ...deps,
    lockManager: createFakeLockManager(),
    ownerKind: 'desktop',
  });
}

/**
 * Minimal fake accumulator. Only implements the two methods the manager uses:
 * `getEventCount()` and `getConversationShape()`. Casting to LazyContextAccumulator
 * because the manager only depends on the two methods.
 */
function createFakeAccumulator(turnId: string): {
  accumulator: LazyContextAccumulator;
  setEvents: (events: AgentEvent[]) => void;
  setMessages: (messages: AgentTurnMessage[]) => void;
} {
  let events: AgentEvent[] = [];
  let messages: AgentTurnMessage[] = [];

  const accumulator = {
    getEventCount: () => events.length,
    getConversationShape: (): ConversationStateShape => ({
      messages: [...messages],
      eventsByTurn: { [turnId]: [...events] },
      activeTurnId: turnId,
      focusedTurnId: null,
      isBusy: true,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    }),
  } as unknown as LazyContextAccumulator;

  return {
    accumulator,
    setEvents: (e) => {
      events = e;
    },
    setMessages: (m) => {
      messages = m;
    },
  };
}

describe('TurnCheckpointManager — lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.values(stubLogger).forEach((fn) => (fn as Mock).mockClear());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('startCheckpointing arms a periodic timer that fires after intervalMs', async () => {
    const fakeStore = createFakeStore();
    const fakeAcc = createFakeAccumulator('turn-1');
    fakeAcc.setEvents([makeStatusEvent('a', 100)]);

    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => fakeAcc.accumulator,
      intervalMs: 1000,
    });

    manager.startCheckpointing('turn-1', 'sess-1');

    // Before the interval, no write yet.
    expect(fakeStore.calls).toHaveLength(0);

    // Fire the timer and let async work flush.
    await vi.advanceTimersByTimeAsync(1000);

    expect(fakeStore.calls).toHaveLength(1);
    expect(fakeStore.calls[0].sessionId).toBe('sess-1');

    manager.shutdown();
  });

  it('startCheckpointing is idempotent for the same turnId', () => {
    const fakeStore = createFakeStore();
    const fakeAcc = createFakeAccumulator('turn-1');

    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => fakeAcc.accumulator,
      intervalMs: 1000,
    });

    manager.startCheckpointing('turn-1', 'sess-1');
    // Second call is a no-op (no extra timer).
    manager.startCheckpointing('turn-1', 'sess-1');

    // Setting a different sessionId on the same turnId is also a no-op (idempotent).
    manager.startCheckpointing('turn-1', 'sess-other');

    manager.shutdown();
    // No assertion error means the manager handled re-entry cleanly.
  });

  it('stopCheckpointing clears the timer and is idempotent', async () => {
    const fakeStore = createFakeStore();
    const fakeAcc = createFakeAccumulator('turn-1');
    fakeAcc.setEvents([makeStatusEvent()]);

    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => fakeAcc.accumulator,
      intervalMs: 1000,
    });

    manager.startCheckpointing('turn-1', 'sess-1');
    manager.stopCheckpointing('turn-1');

    // Time passes — no write should happen.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fakeStore.calls).toHaveLength(0);

    // Calling stop again on an unknown turn is a no-op.
    expect(() => manager.stopCheckpointing('turn-1')).not.toThrow();
    expect(() => manager.stopCheckpointing('turn-unknown')).not.toThrow();
  });

  it('shutdown clears all armed timers across multiple turns', async () => {
    const fakeStore = createFakeStore();
    const acc1 = createFakeAccumulator('turn-1');
    acc1.setEvents([makeStatusEvent()]);
    const acc2 = createFakeAccumulator('turn-2');
    acc2.setEvents([makeStatusEvent()]);

    const accumulators: Record<string, LazyContextAccumulator> = {
      'turn-1': acc1.accumulator,
      'turn-2': acc2.accumulator,
    };

    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: (id) => accumulators[id],
      intervalMs: 1000,
    });

    manager.startCheckpointing('turn-1', 'sess-1');
    manager.startCheckpointing('turn-2', 'sess-2');

    manager.shutdown();

    await vi.advanceTimersByTimeAsync(5000);
    expect(fakeStore.calls).toHaveLength(0);

    // Subsequent shutdowns are also no-ops.
    expect(() => manager.shutdown()).not.toThrow();
  });

  it('periodic tick captures shape and writes to the store', async () => {
    const fakeStore = createFakeStore();
    const fakeAcc = createFakeAccumulator('turn-1');
    fakeAcc.setEvents([makeStatusEvent('s1', 100), makeStatusEvent('s2', 200)]);
    fakeAcc.setMessages([makeMessage({ id: 'a1', turnId: 'turn-1', text: 'hi', createdAt: 200 })]);

    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => fakeAcc.accumulator,
      intervalMs: 1000,
    });

    manager.startCheckpointing('turn-1', 'sess-1');
    await vi.advanceTimersByTimeAsync(1000);

    expect(fakeStore.calls).toHaveLength(1);
    const written = fakeStore.calls[0].written;
    expect(written).not.toBeNull();
    expect(written?.eventsByTurn['turn-1']).toHaveLength(2);
    expect(written?.messages).toHaveLength(1);
    // Periodic write — turn still active.
    expect(written?.activeTurnId).toBe('turn-1');
    expect(written?.isBusy).toBe(true);

    manager.shutdown();
  });

  it('periodic tick skips when no new events since the last checkpoint', async () => {
    const fakeStore = createFakeStore();
    const fakeAcc = createFakeAccumulator('turn-1');
    fakeAcc.setEvents([makeStatusEvent()]);

    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => fakeAcc.accumulator,
      intervalMs: 1000,
    });

    manager.startCheckpointing('turn-1', 'sess-1');

    // First tick — writes.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fakeStore.calls).toHaveLength(1);

    // Second tick — no new events, must skip the write.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fakeStore.calls).toHaveLength(1);

    // Adding a new event causes the next tick to write again.
    fakeAcc.setEvents([makeStatusEvent('a'), makeStatusEvent('b')]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fakeStore.calls).toHaveLength(2);

    manager.shutdown();
  });

  it('periodic tick self-reschedules after completion', async () => {
    const fakeStore = createFakeStore();
    const fakeAcc = createFakeAccumulator('turn-1');
    fakeAcc.setEvents([makeStatusEvent('1', 1)]);

    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => fakeAcc.accumulator,
      intervalMs: 500,
    });

    manager.startCheckpointing('turn-1', 'sess-1');

    // Tick 1
    await vi.advanceTimersByTimeAsync(500);
    expect(fakeStore.calls).toHaveLength(1);

    // Tick 2 — add an event so the skip-when-unchanged guard doesn't fire.
    fakeAcc.setEvents([makeStatusEvent('1', 1), makeStatusEvent('2', 2)]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fakeStore.calls).toHaveLength(2);

    // Tick 3
    fakeAcc.setEvents([makeStatusEvent('1', 1), makeStatusEvent('2', 2), makeStatusEvent('3', 3)]);
    await vi.advanceTimersByTimeAsync(500);
    expect(fakeStore.calls).toHaveLength(3);

    manager.shutdown();
  });

  it('periodic tick handles missing accumulator (turn ended) by stopping itself', async () => {
    const fakeStore = createFakeStore();
    let accumulatorMissing = false;
    const fakeAcc = createFakeAccumulator('turn-1');
    fakeAcc.setEvents([makeStatusEvent()]);

    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => (accumulatorMissing ? undefined : fakeAcc.accumulator),
      intervalMs: 1000,
    });

    manager.startCheckpointing('turn-1', 'sess-1');

    // First tick succeeds.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fakeStore.calls).toHaveLength(1);

    // Now the accumulator goes missing (turn cleanup ran without stopCheckpointing).
    accumulatorMissing = true;
    fakeAcc.setEvents([makeStatusEvent('extra')]);

    // Second tick — manager should detect the missing accumulator and tear down.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fakeStore.calls).toHaveLength(1); // No additional write.

    // Third tick — no further writes since the manager stopped tracking the turn.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fakeStore.calls).toHaveLength(1);

    manager.shutdown();
  });

  it('checkpointTerminal writes immediately with isTerminal: true', async () => {
    const fakeStore = createFakeStore();
    const fakeAcc = createFakeAccumulator('turn-1');

    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => fakeAcc.accumulator,
      intervalMs: 60_000,
    });

    const shape = makeShape('turn-1', {
      eventsByTurn: { 'turn-1': [makeStatusEvent('s'), makeResultEvent('done')] },
      // Even though the shape claims active, terminal merge MUST clear it.
      activeTurnId: 'turn-1',
      isBusy: true,
    });

    await manager.checkpointTerminal('turn-1', 'sess-1', shape);

    expect(fakeStore.calls).toHaveLength(1);
    const written = fakeStore.calls[0].written;
    expect(written?.activeTurnId).toBeNull();
    expect(written?.isBusy).toBe(false);
    expect(written?.eventsByTurn['turn-1']).toHaveLength(2);
  });

  it('checkpointTerminal clears the periodic timer for that turn', async () => {
    const fakeStore = createFakeStore();
    const fakeAcc = createFakeAccumulator('turn-1');
    fakeAcc.setEvents([makeStatusEvent()]);

    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => fakeAcc.accumulator,
      intervalMs: 1000,
    });

    manager.startCheckpointing('turn-1', 'sess-1');

    // Run a terminal checkpoint immediately — it should clear the periodic timer.
    const shape = makeShape('turn-1', {
      eventsByTurn: { 'turn-1': [makeResultEvent()] },
    });
    await manager.checkpointTerminal('turn-1', 'sess-1', shape);
    expect(fakeStore.calls).toHaveLength(1);

    // No further writes when the periodic timer would have fired.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fakeStore.calls).toHaveLength(1);

    manager.shutdown();
  });

  it('onCheckpointComplete is called on successful periodic writes', async () => {
    const fakeStore = createFakeStore();
    const fakeAcc = createFakeAccumulator('turn-1');
    fakeAcc.setEvents([makeStatusEvent()]);

    const onCheckpointComplete = vi.fn();
    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => fakeAcc.accumulator,
      onCheckpointComplete,
      intervalMs: 1000,
    });

    manager.startCheckpointing('turn-1', 'sess-1');
    await vi.advanceTimersByTimeAsync(1000);

    expect(onCheckpointComplete).toHaveBeenCalledOnce();
    const [session, reason] = onCheckpointComplete.mock.calls[0];
    expect((session as AgentSession).id).toBe('sess-1');
    expect(reason).toBe('periodic');

    manager.shutdown();
  });

  it('onCheckpointComplete is called on successful terminal writes with reason="terminal"', async () => {
    const fakeStore = createFakeStore();
    const fakeAcc = createFakeAccumulator('turn-1');

    const onCheckpointComplete = vi.fn();
    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => fakeAcc.accumulator,
      onCheckpointComplete,
      intervalMs: 60_000,
    });

    const shape = makeShape('turn-1', {
      eventsByTurn: { 'turn-1': [makeResultEvent()] },
    });
    await manager.checkpointTerminal('turn-1', 'sess-1', shape);

    expect(onCheckpointComplete).toHaveBeenCalledOnce();
    const [, reason] = onCheckpointComplete.mock.calls[0];
    expect(reason).toBe('terminal');
  });

  it('onCheckpointComplete is NOT called when the store reports a failed write', async () => {
    const fakeStore = createFakeStore();
    const fakeAcc = createFakeAccumulator('turn-1');
    fakeAcc.setEvents([makeStatusEvent()]);

    const onCheckpointComplete = vi.fn();
    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => fakeAcc.accumulator,
      onCheckpointComplete,
      intervalMs: 1000,
    });

    // Force the next write to report failure.
    fakeStore.setNextResult(false);

    manager.startCheckpointing('turn-1', 'sess-1');
    await vi.advanceTimersByTimeAsync(1000);

    // The store was called, but the success callback must not have fired.
    expect(fakeStore.calls).toHaveLength(1);
    expect(onCheckpointComplete).not.toHaveBeenCalled();

    manager.shutdown();
  });

  it('onCheckpointComplete that throws does not break the periodic loop', async () => {
    const fakeStore = createFakeStore();
    const fakeAcc = createFakeAccumulator('turn-1');
    fakeAcc.setEvents([makeStatusEvent('a', 1)]);

    const onCheckpointComplete = vi.fn(() => {
      throw new Error('callback boom');
    });
    const manager = createCheckpointManager({
      store: fakeStore.store,
      getAccumulator: () => fakeAcc.accumulator,
      onCheckpointComplete,
      intervalMs: 1000,
    });

    manager.startCheckpointing('turn-1', 'sess-1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(onCheckpointComplete).toHaveBeenCalledOnce();
    expect(fakeStore.calls).toHaveLength(1);

    // Add a new event so the next tick still has work — the manager must
    // still be alive and rescheduling.
    fakeAcc.setEvents([makeStatusEvent('a', 1), makeStatusEvent('b', 2)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fakeStore.calls).toHaveLength(2);

    manager.shutdown();
  });
});

// ===========================================================================
// 4. Cross-turn seq continuity — turn1 persist → reload → turn2 stamps
//    monotonically above turn1's max (I18 follow-up)
// ===========================================================================
//
// Component parts are covered elsewhere:
//   - mergeTurnIntoSession recomputes maxSeq from merged events (above)
//   - incrementalSessionStore hydrates seq index from persisted maxSeq
//     (incrementalSessionStore.test.ts) and accumulator stamps `maxSeq + 1`
//     (sessionSeqIndex.test.ts).
//
// This test wires those together end-to-end with a real temp-dir store:
// turn1 events get persisted via updateSession (the real RMW path, which
// uses mergeTurnIntoSession internally), a fresh store reload re-hydrates
// the seq index, and turn2's accumulator stamps a seq strictly above
// turn1's max. Guards against a regression where the persisted-maxSeq
// hydration silently drops to 0 on second-store reload.
// ---------------------------------------------------------------------------

describe('turn1 persist → reload → turn2 seq continuity', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-seq-continuity-'));
    vi.resetModules();
    await initTestPlatformConfig({ userDataPath: testDir });
    Object.values(stubLogger).forEach((fn) => (fn as Mock).mockClear());
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('next turn stamps seq > persisted maxSeq after store reload', async () => {
    const sessionId = 'sess-cross-turn';
    const { resetSessionSeqIndexForTests } = await import('../sessionSeqIndex');
    resetSessionSeqIndexForTests();

    // ----- turn1: stamp + persist via real updateSession path -----
    const { LazyContextAccumulator } = await import('../lazyContextAccumulator');
    const turn1Accumulator = new LazyContextAccumulator('turn-1', sessionId);
    const stamped1a = turn1Accumulator.appendEvent({
      type: 'status',
      message: 'turn1-event-a',
      timestamp: 1_000,
    } as AgentEvent);
    const stamped1b = turn1Accumulator.appendEvent({
      type: 'status',
      message: 'turn1-event-b',
      timestamp: 1_100,
    } as AgentEvent);

    // Sanity: in-process accumulator stamps starting at 1 (fresh index).
    expect(stamped1a.seq).toBe(1);
    expect(stamped1b.seq).toBe(2);

    // Use the real `mergeTurnIntoSession` reducer through `updateSession` so
    // maxSeq gets recomputed authoritatively.
    const { IncrementalSessionStore } = await import('../incrementalSessionStore');
    const writeStore = new IncrementalSessionStore();
    const persistOk = await writeStore.updateSession(sessionId, (current) => {
      const base = current ?? makeSession({ id: sessionId, eventsByTurn: {} });
      return mergeTurnIntoSession(
        base,
        {
          messages: [],
          eventsByTurn: { 'turn-1': [stamped1a, stamped1b] },
          activeTurnId: 'turn-1',
          focusedTurnId: null,
          isBusy: false,
          lastError: null,
          lastErrorSource: null,
          terminatedTurnIds: new Set(),
        },
        sessionId,
        'turn-1',
        true,
      );
    });
    expect(persistOk).toBe(true);

    // ----- simulate process restart: drop in-memory seq index, new store -----
    resetSessionSeqIndexForTests();
    vi.resetModules();
    // After resetModules the cached PlatformConfig is gone — re-init against the
    // same temp dir so the reloaded store reads the file we just wrote.
    await initTestPlatformConfig({ userDataPath: testDir });

    const { IncrementalSessionStore: ReloadedStoreClass } = await import('../incrementalSessionStore');
    const reloadStore = new ReloadedStoreClass();
    const reloaded = reloadStore.loadSync();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0].id).toBe(sessionId);
    expect(reloaded[0].maxSeq).toBe(2);

    // ----- turn2: fresh accumulator stamps strictly above turn1 max -----
    const { LazyContextAccumulator: ReloadedAccumulator } = await import('../lazyContextAccumulator');
    const turn2Accumulator = new ReloadedAccumulator('turn-2', sessionId);
    const stamped2a = turn2Accumulator.appendEvent({
      type: 'status',
      message: 'turn2-event-a',
      timestamp: 2_000,
    } as AgentEvent);

    expect(stamped2a.seq).toBeGreaterThan(2);
    expect(stamped2a.seq).toBe(3);
  });
});
