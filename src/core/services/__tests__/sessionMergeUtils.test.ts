/**
 * Unit tests for shared session merge primitives.
 *
 * These primitives are used by both:
 *  - Desktop-pull merge (cloudRouter.ts → mergeSessionTurns)
 *  - Cloud-push merge (sessions.ts → mergeDesktopPushIntoCloud)
 *
 * Each primitive is tested in isolation; integration coverage is provided by
 * the existing cloudSessionMerge.test.ts and sessionsRoute.test.ts test suites.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from '@shared/types';

const mockSessionMergeUtilsLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

 
vi.mock('@core/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/logger')>();
  return {
    ...actual,
    createScopedLogger: () => mockSessionMergeUtilsLog,
  };
});

import { getKnownTurnIds, hasTerminalEvent, hasTerminalEventInTurn, mergePerTurnMap, unionPerTurnMap, unionPerTurnMapWith, resolveMemoryStatusConflict, mergeMemoryStatusByTurn, deduplicateMessages, mergeEventsForDesktopPull, mergeEventsForCloudPush, maxValidSeqForTurn, guardActiveIngestRegression } from '../sessionMergeUtils';
import type { MemoryUpdateStatus } from '@shared/types';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    title: 'Test session',
    createdAt: 1000,
    updatedAt: 1000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    doneAt: null,
    origin: 'manual',
    ...overrides,
  } as AgentSession;
}

function makeMessage(id: string, turnId: string, role: 'user' | 'assistant', text: string, createdAt: number) {
  return { id, turnId, role, text, createdAt } as AgentSession['messages'][number];
}

// --------------------------------------------------------------------------
// getKnownTurnIds
// --------------------------------------------------------------------------

describe('getKnownTurnIds', () => {
  it('returns empty set for empty session', () => {
    const session = makeSession();
    expect(getKnownTurnIds(session)).toEqual(new Set());
  });

  it('extracts turn IDs from eventsByTurn keys', () => {
    const session = makeSession({
      eventsByTurn: { 'turn-a': [], 'turn-b': [] },
    });
    expect(getKnownTurnIds(session)).toEqual(new Set(['turn-a', 'turn-b']));
  });

  it('extracts turn IDs from message turnIds', () => {
    const session = makeSession({
      messages: [
        makeMessage('m1', 'turn-a', 'user', 'hi', 100),
        makeMessage('m2', 'turn-b', 'assistant', 'hello', 200),
      ],
    });
    expect(getKnownTurnIds(session)).toEqual(new Set(['turn-a', 'turn-b']));
  });

  it('merges turn IDs from both sources (union)', () => {
    const session = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-b': [] },
    });
    expect(getKnownTurnIds(session)).toEqual(new Set(['turn-a', 'turn-b']));
  });

  it('deduplicates turn IDs present in both sources', () => {
    const session = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: { 'turn-a': [] },
    });
    const ids = getKnownTurnIds(session);
    expect(ids.size).toBe(1);
    expect(ids.has('turn-a')).toBe(true);
  });

  it('handles undefined messages gracefully', () => {
    const session = makeSession({ messages: undefined as unknown as AgentSession['messages'] });
    session.eventsByTurn = { 'turn-a': [] };
    expect(getKnownTurnIds(session)).toEqual(new Set(['turn-a']));
  });

  it('handles undefined eventsByTurn gracefully', () => {
    const session = makeSession({
      messages: [makeMessage('m1', 'turn-a', 'user', 'hi', 100)],
      eventsByTurn: undefined,
    });
    expect(getKnownTurnIds(session)).toEqual(new Set(['turn-a']));
  });
});

// --------------------------------------------------------------------------
// hasTerminalEvent
// --------------------------------------------------------------------------

describe('hasTerminalEvent', () => {
  it('returns false for undefined events', () => {
    expect(hasTerminalEvent(undefined)).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(hasTerminalEvent([])).toBe(false);
  });

  it('returns false when no terminal events exist', () => {
    const events = [
      { type: 'status', status: 'Thinking', timestamp: 1 },
      { type: 'tool', toolName: 'bash', detail: 'ls', stage: 'start', timestamp: 2 },
    ] as unknown as AgentEvent[];
    expect(hasTerminalEvent(events)).toBe(false);
  });

  it('returns true for result event', () => {
    const events: AgentEvent[] = [
      { type: 'result', text: 'done', timestamp: 2 } as AgentEvent,
    ];
    expect(hasTerminalEvent(events)).toBe(true);
  });

  it('returns true for error event', () => {
    const events: AgentEvent[] = [
      { type: 'error', error: 'something failed', timestamp: 1 } as AgentEvent,
    ];
    expect(hasTerminalEvent(events)).toBe(true);
  });

  it('returns true when result is among other events', () => {
    const events = [
      { type: 'status', status: 'Working', timestamp: 1 },
      { type: 'tool', toolName: 'read', detail: '', stage: 'end', timestamp: 2 },
      { type: 'result', text: 'all done', timestamp: 3 },
    ] as unknown as AgentEvent[];
    expect(hasTerminalEvent(events)).toBe(true);
  });
});

// --------------------------------------------------------------------------
// mergePerTurnMap
// --------------------------------------------------------------------------

describe('mergePerTurnMap', () => {
  it('returns primary when secondary is undefined', () => {
    const primary = { 'turn-a': 'val-a' };
    const primaryTurnIds = new Set(['turn-a']);
    expect(mergePerTurnMap(primary, undefined, primaryTurnIds)).toBe(primary);
  });

  it('returns secondary when primary is undefined', () => {
    const secondary = { 'turn-b': 'val-b' };
    const primaryTurnIds = new Set<string>();
    expect(mergePerTurnMap(undefined, secondary, primaryTurnIds)).toBe(secondary);
  });

  it('returns undefined when both are undefined', () => {
    expect(mergePerTurnMap(undefined, undefined, new Set())).toBeUndefined();
  });

  it('primary wins for shared turns', () => {
    const primary = { 'turn-a': 'primary-val' };
    const secondary = { 'turn-a': 'secondary-val' };
    const primaryTurnIds = new Set(['turn-a']);
    const result = mergePerTurnMap(primary, secondary, primaryTurnIds);
    expect(result).toEqual({ 'turn-a': 'primary-val' });
  });

  it('secondary fills gaps for turns not in primary', () => {
    const primary = { 'turn-a': 'val-a' };
    const secondary = { 'turn-b': 'val-b' };
    const primaryTurnIds = new Set(['turn-a']);
    const result = mergePerTurnMap(primary, secondary, primaryTurnIds);
    expect(result).toEqual({ 'turn-a': 'val-a', 'turn-b': 'val-b' });
  });

  it('only adds secondary entries for turns NOT known to primary', () => {
    const primary = { 'turn-a': 'primary-a' };
    const secondary = { 'turn-a': 'secondary-a', 'turn-b': 'secondary-b', 'turn-c': 'secondary-c' };
    const primaryTurnIds = new Set(['turn-a', 'turn-b']); // primary "knows" turn-b even though it has no entry
    const result = mergePerTurnMap(primary, secondary, primaryTurnIds);
    expect(result).toEqual({
      'turn-a': 'primary-a', // primary wins (turn-a in primary)
      // turn-b: skipped because primaryTurnIds knows it
      'turn-c': 'secondary-c', // secondary fills gap
    });
  });

  it('handles empty objects', () => {
    const primary: Record<string, string> = {};
    const secondary: Record<string, string> = {};
    const result = mergePerTurnMap(primary, secondary, new Set());
    expect(result).toEqual({});
  });

  it('preserves complex values', () => {
    type Status = { state: string; timestamp: number };
    const primary: Record<string, Status> = { 'turn-a': { state: 'completed', timestamp: 100 } };
    const secondary: Record<string, Status> = { 'turn-b': { state: 'pending', timestamp: 200 } };
    const result = mergePerTurnMap(primary, secondary, new Set(['turn-a']));
    expect(result).toEqual({
      'turn-a': { state: 'completed', timestamp: 100 },
      'turn-b': { state: 'pending', timestamp: 200 },
    });
  });
});

// --------------------------------------------------------------------------
// unionPerTurnMap (async/sparse artifact merge — activity summaries)
// --------------------------------------------------------------------------

describe('unionPerTurnMap', () => {
  it('returns primary when secondary is undefined', () => {
    const primary = { 'turn-a': 'val-a' };
    expect(unionPerTurnMap(primary, undefined)).toBe(primary);
  });

  it('returns secondary when primary is undefined', () => {
    const secondary = { 'turn-b': 'val-b' };
    expect(unionPerTurnMap(undefined, secondary)).toBe(secondary);
  });

  it('returns undefined when both are undefined', () => {
    expect(unionPerTurnMap(undefined, undefined)).toBeUndefined();
  });

  it('primary wins for shared turns where both have a value', () => {
    const primary = { 'turn-a': 'primary-val' };
    const secondary = { 'turn-a': 'secondary-val' };
    expect(unionPerTurnMap(primary, secondary)).toEqual({ 'turn-a': 'primary-val' });
  });

  it('unions a secondary key for a turn primary "knows" but lacks the key (the F2 case mergePerTurnMap drops)', () => {
    // This is the exact divergence from mergePerTurnMap: there, a turn primary
    // knows-but-has-no-key skips the secondary value. unionPerTurnMap keeps it,
    // because for an async/sparse artifact "no key" means "not seen yet".
    const primary = { 'turn-a': 'primary-a' }; // primary knows turn-a AND turn-b (turn-b has no key)
    const secondary = { 'turn-a': 'secondary-a', 'turn-b': 'secondary-b' };
    expect(unionPerTurnMap(primary, secondary)).toEqual({
      'turn-a': 'primary-a', // primary wins shared key
      'turn-b': 'secondary-b', // unioned in (mergePerTurnMap would skip if turn-b ∈ primaryTurnIds)
    });
  });

  it('handles empty objects', () => {
    expect(unionPerTurnMap({}, {})).toEqual({});
  });

  it('preserves complex values', () => {
    type Status = { state: string; timestamp: number };
    const primary: Record<string, Status> = { 'turn-a': { state: 'completed', timestamp: 100 } };
    const secondary: Record<string, Status> = { 'turn-b': { state: 'pending', timestamp: 200 } };
    expect(unionPerTurnMap(primary, secondary)).toEqual({
      'turn-a': { state: 'completed', timestamp: 100 },
      'turn-b': { state: 'pending', timestamp: 200 },
    });
  });
});

// --------------------------------------------------------------------------
// unionPerTurnMapWith / resolveMemoryStatusConflict / mergeMemoryStatusByTurn
// --------------------------------------------------------------------------

describe('unionPerTurnMapWith', () => {
  it('returns the other side when one is undefined', () => {
    const primary = { a: 1 };
    const secondary = { b: 2 };
    const resolve = (p: number) => p;
    expect(unionPerTurnMapWith(primary, undefined, resolve)).toBe(primary);
    expect(unionPerTurnMapWith(undefined, secondary, resolve)).toBe(secondary);
    expect(unionPerTurnMapWith(undefined, undefined, resolve)).toBeUndefined();
  });

  it('unions unique keys and applies the resolver only for shared keys', () => {
    const primary = { a: 'p-a', shared: 'p-shared' };
    const secondary = { b: 's-b', shared: 's-shared' };
    // resolver picks secondary on conflict (to prove it is actually consulted)
    const merged = unionPerTurnMapWith(primary, secondary, (_p, s) => s);
    expect(merged).toEqual({ a: 'p-a', b: 's-b', shared: 's-shared' });
  });

  it('default-keeps the primary object reference for unchanged shared keys', () => {
    const primaryVal = { v: 1 };
    const primary = { a: primaryVal };
    const secondary = { a: { v: 2 } };
    const merged = unionPerTurnMapWith(primary, secondary, (p) => p);
    expect(merged?.a).toBe(primaryVal); // same reference → callers can use === to detect "unchanged"
  });
});

const memStatus = (
  status: MemoryUpdateStatus['status'],
  overrides: Partial<MemoryUpdateStatus> = {},
): MemoryUpdateStatus => ({
  originalTurnId: 'turn-a',
  originalSessionId: 'sess-1',
  status,
  timestamp: 1,
  ...overrides,
});

describe('resolveMemoryStatusConflict', () => {
  it('a terminal status beats a running status regardless of side', () => {
    const running = memStatus('running');
    const success = memStatus('success');
    expect(resolveMemoryStatusConflict(running, success)).toBe(success); // primary running → secondary terminal wins
    expect(resolveMemoryStatusConflict(success, running)).toBe(success); // primary terminal → primary wins
  });

  it('primary wins when both are terminal', () => {
    const primaryError = memStatus('error', { error: 'p' });
    const secondarySuccess = memStatus('success');
    expect(resolveMemoryStatusConflict(primaryError, secondarySuccess)).toBe(primaryError);
  });

  it('primary wins when both are running', () => {
    const p = memStatus('running', { timestamp: 1 });
    const s = memStatus('running', { timestamp: 2 });
    expect(resolveMemoryStatusConflict(p, s)).toBe(p);
  });
});

describe('mergeMemoryStatusByTurn', () => {
  it('unions a cloud terminal status the local map lacks (the catch-up case)', () => {
    const cloudSuccess = memStatus('success', { originalTurnId: 'turn-b' });
    const merged = mergeMemoryStatusByTurn({ 'turn-a': memStatus('success') }, { 'turn-b': cloudSuccess });
    expect(merged).toEqual({ 'turn-a': memStatus('success'), 'turn-b': cloudSuccess });
  });

  it('upgrades a local running to a cloud terminal for the same turn', () => {
    const merged = mergeMemoryStatusByTurn(
      { 'turn-a': memStatus('running') },
      { 'turn-a': memStatus('success', { summary: 'done' }) },
    );
    expect(merged?.['turn-a'].status).toBe('success');
  });

  it('does NOT downgrade a local terminal to a cloud running', () => {
    const localSuccess = memStatus('success');
    const merged = mergeMemoryStatusByTurn({ 'turn-a': localSuccess }, { 'turn-a': memStatus('running') });
    expect(merged?.['turn-a']).toBe(localSuccess);
  });
});

// --------------------------------------------------------------------------
// deduplicateMessages
// --------------------------------------------------------------------------

describe('deduplicateMessages', () => {
  it('returns empty array for empty inputs', () => {
    expect(deduplicateMessages([], [], 'authoritative-wins')).toEqual([]);
    expect(deduplicateMessages([], [], 'secondary-wins')).toEqual([]);
  });

  it('returns authoritative messages when secondary is empty', () => {
    const msgs = [makeMessage('m1', 'turn-a', 'user', 'hi', 100)];
    expect(deduplicateMessages(msgs, [], 'authoritative-wins')).toEqual(msgs);
  });

  it('returns secondary messages when authoritative is empty', () => {
    const msgs = [makeMessage('m1', 'turn-a', 'user', 'hi', 100)];
    expect(deduplicateMessages([], msgs, 'authoritative-wins')).toEqual(msgs);
  });

  it('sorts merged messages by createdAt', () => {
    const auth = [makeMessage('m2', 'turn-a', 'user', 'second', 200)];
    const sec = [
      makeMessage('m1', 'turn-b', 'assistant', 'first', 100),
      makeMessage('m3', 'turn-c', 'assistant', 'third', 300),
    ];
    const result = deduplicateMessages(auth, sec, 'authoritative-wins');
    expect(result.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  describe('authoritative-wins mode', () => {
    it('keeps authoritative version on ID collision', () => {
      const auth = [makeMessage('m1', 'turn-a', 'user', 'auth version', 100)];
      const sec = [makeMessage('m1', 'turn-a', 'user', 'sec version', 100)];
      const result = deduplicateMessages(auth, sec, 'authoritative-wins');
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('auth version');
    });

    it('adds non-colliding secondary messages', () => {
      const auth = [makeMessage('m1', 'turn-a', 'user', 'auth', 100)];
      const sec = [makeMessage('m2', 'turn-b', 'assistant', 'sec', 200)];
      const result = deduplicateMessages(auth, sec, 'authoritative-wins');
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['m1', 'm2']);
    });
  });

  describe('secondary-wins mode', () => {
    it('overwrites authoritative version on ID collision', () => {
      const auth = [makeMessage('m1', 'turn-a', 'user', 'auth version', 100)];
      const sec = [makeMessage('m1', 'turn-a', 'user', 'sec version', 100)];
      const result = deduplicateMessages(auth, sec, 'secondary-wins');
      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('sec version');
    });

    it('preserves non-colliding authoritative messages', () => {
      const auth = [makeMessage('m1', 'turn-a', 'user', 'auth', 100)];
      const sec = [makeMessage('m2', 'turn-b', 'assistant', 'sec', 200)];
      const result = deduplicateMessages(auth, sec, 'secondary-wins');
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.id)).toEqual(['m1', 'm2']);
    });
  });

  it('handles multiple collisions correctly', () => {
    const auth = [
      makeMessage('m1', 'turn-a', 'user', 'auth-1', 100),
      makeMessage('m2', 'turn-a', 'assistant', 'auth-2', 200),
      makeMessage('m3', 'turn-b', 'user', 'auth-3', 300),
    ];
    const sec = [
      makeMessage('m1', 'turn-a', 'user', 'sec-1', 100),
      makeMessage('m4', 'turn-c', 'assistant', 'sec-4', 400),
    ];

    // authoritative-wins: m1 keeps auth version, m4 added
    const authWins = deduplicateMessages(auth, sec, 'authoritative-wins');
    expect(authWins).toHaveLength(4);
    expect(authWins.find((m) => m.id === 'm1')!.text).toBe('auth-1');
    expect(authWins.find((m) => m.id === 'm4')!.text).toBe('sec-4');

    // secondary-wins: m1 gets sec version, m4 added
    const secWins = deduplicateMessages(auth, sec, 'secondary-wins');
    expect(secWins).toHaveLength(4);
    expect(secWins.find((m) => m.id === 'm1')!.text).toBe('sec-1');
    expect(secWins.find((m) => m.id === 'm4')!.text).toBe('sec-4');
  });
});

describe('hasTerminalEventInTurn', () => {
  it('returns false for undefined eventsByTurn', () => {
    expect(hasTerminalEventInTurn(undefined, 'turn-1')).toBe(false);
  });

  it('returns false for missing turnId key', () => {
    expect(hasTerminalEventInTurn({ 'other-turn': [] }, 'turn-1')).toBe(false);
  });

  it('returns false for non-array value', () => {
    const eventsByTurn = { 'turn-1': 'not-an-array' } as unknown as Record<string, unknown[]>;
    expect(hasTerminalEventInTurn(eventsByTurn, 'turn-1')).toBe(false);
  });

  it('returns false for empty events array', () => {
    expect(hasTerminalEventInTurn({ 'turn-1': [] }, 'turn-1')).toBe(false);
  });

  it('returns false for non-object entries', () => {
    const eventsByTurn = { 'turn-1': ['string-entry', 42, true] } as unknown as Record<string, unknown[]>;
    expect(hasTerminalEventInTurn(eventsByTurn, 'turn-1')).toBe(false);
  });

  it('returns false for null entries', () => {
    const eventsByTurn = { 'turn-1': [null, null] } as unknown as Record<string, unknown[]>;
    expect(hasTerminalEventInTurn(eventsByTurn, 'turn-1')).toBe(false);
  });

  it('returns false for entries missing type field', () => {
    const eventsByTurn = { 'turn-1': [{ toolName: 'test' }, { message: 'hello' }] } as unknown as Record<string, unknown[]>;
    expect(hasTerminalEventInTurn(eventsByTurn, 'turn-1')).toBe(false);
  });

  it('returns false for non-terminal event types', () => {
    const eventsByTurn = { 'turn-1': [{ type: 'tool' }, { type: 'status' }, { type: 'thinking_delta' }] } as unknown as Record<string, unknown[]>;
    expect(hasTerminalEventInTurn(eventsByTurn, 'turn-1')).toBe(false);
  });

  it('returns true for result terminal event', () => {
    const eventsByTurn = { 'turn-1': [{ type: 'tool' }, { type: 'result' }] } as unknown as Record<string, unknown[]>;
    expect(hasTerminalEventInTurn(eventsByTurn, 'turn-1')).toBe(true);
  });

  it('returns true for error terminal event', () => {
    const eventsByTurn = { 'turn-1': [{ type: 'error' }] } as unknown as Record<string, unknown[]>;
    expect(hasTerminalEventInTurn(eventsByTurn, 'turn-1')).toBe(true);
  });

  it('detects terminal event among corrupted entries', () => {
    const eventsByTurn = { 'turn-1': [null, 'garbage', { type: 'result' }, 42] } as unknown as Record<string, unknown[]>;
    expect(hasTerminalEventInTurn(eventsByTurn, 'turn-1')).toBe(true);
  });

  it('handles partially corrupted objects with extra fields', () => {
    const eventsByTurn = { 'turn-1': [{ type: 'result', garbage: true, extraField: 'foo' }] } as unknown as Record<string, unknown[]>;
    expect(hasTerminalEventInTurn(eventsByTurn, 'turn-1')).toBe(true);
  });
});

// ---------- mergeEventsForDesktopPull ----------

describe('mergeEventsForDesktopPull', () => {

  const toolEvent = (name: string): AgentEvent => ({ type: 'tool', toolName: name, detail: '', stage: 'start', timestamp: 1000 });
  const resultEvent: AgentEvent = { type: 'result', text: 'done', timestamp: 2000 };

  it('preserves local events for shared turns (local wins)', () => {
    const local = { 't1': [toolEvent('local')] };
    const cloud = { 't1': [toolEvent('cloud')] };
    const { merged } = mergeEventsForDesktopPull(local, cloud);
    expect(merged['t1']).toBe(local['t1']);
  });

  it('preserves cloud-only turns', () => {
    const local = { 't1': [toolEvent('local')] };
    const cloud = { 't2': [toolEvent('cloud-only')] };
    const { merged, hasNewEvents } = mergeEventsForDesktopPull(local, cloud);
    expect(merged['t2']).toBe(cloud['t2']);
    expect(hasNewEvents).toBe(true);
  });

  it('terminal-upgrade: cloud terminal replaces local non-terminal', () => {
    const local = { 't1': [toolEvent('in-progress')] };
    const cloud = { 't1': [toolEvent('cloud'), resultEvent] };
    const { merged, hasNewEvents } = mergeEventsForDesktopPull(local, cloud);
    expect(merged['t1']).toBe(cloud['t1']);
    expect(hasNewEvents).toBe(true);
  });

  it('no terminal-upgrade when local already has terminal', () => {
    const local = { 't1': [resultEvent] };
    const cloud = { 't1': [toolEvent('cloud'), resultEvent] };
    const { merged } = mergeEventsForDesktopPull(local, cloud);
    expect(merged['t1']).toBe(local['t1']);
  });

  it('returns hasNewEvents=false when no new data', () => {
    const local = { 't1': [resultEvent] };
    const { merged, hasNewEvents } = mergeEventsForDesktopPull(local, {});
    expect(hasNewEvents).toBe(false);
    expect(merged['t1']).toBe(local['t1']);
  });

  it('independently preserves events for different turnIds', () => {
    const local = { 't1': [toolEvent('l1')] };
    const cloud = { 't2': [toolEvent('c2')], 't3': [toolEvent('c3')] };
    const { merged } = mergeEventsForDesktopPull(local, cloud);
    expect(Object.keys(merged)).toEqual(expect.arrayContaining(['t1', 't2', 't3']));
  });
});

// ---------- mergeEventsForCloudPush ----------

describe('mergeEventsForCloudPush', () => {

  type TestEventOverrides = Omit<Partial<AgentEvent>, 'seq'> & {
    clientOrdinal?: number | null;
    seq?: number | null;
  };

  const toolEvent = (name: string, overrides: TestEventOverrides = {}): AgentEvent => ({
    type: 'tool',
    toolName: name,
    detail: '',
    stage: 'start',
    timestamp: 1000,
    ...overrides,
  } as AgentEvent);
  const assistantTextEvent = (
    text: string,
    overrides: TestEventOverrides = {},
  ): AgentEvent => ({
    type: 'assistant_text',
    text,
    timestamp: 1000,
    seq: null,
    ...overrides,
  } as unknown as AgentEvent);

  beforeEach(() => {
    mockSessionMergeUtilsLog.warn.mockClear();
  });

  it('preserves cloud-only turns when the push does not reference them', () => {
    const existing = { 'cloud-only': [toolEvent('c', { seq: 1 })] };
    const incoming = { 't1': [toolEvent('desktop', { timestamp: 2, clientOrdinal: 0 })] };
    const merged = mergeEventsForCloudPush(existing, incoming);
    expect(merged['cloud-only']).toEqual(existing['cloud-only']);
    expect(merged['t1']).toEqual(incoming['t1']);
  });

  it('preserves existing shared-turn events and appends incoming-only events by identity', () => {
    const cloudEvent = toolEvent('cloud', { seq: 1, timestamp: 10 });
    const desktopEvent = toolEvent('desktop', { timestamp: 20, clientOrdinal: 0 });
    const existing = { 't1': [cloudEvent] };
    const incoming = { 't1': [desktopEvent] };
    const merged = mergeEventsForCloudPush(existing, incoming);
    expect(merged['t1']).toEqual([cloudEvent, desktopEvent]);
  });

  it('keeps cloud event and logs when stale incoming has the same getEventIdentity with different content', () => {
    const cloudEvent = toolEvent('cloud', { seq: 1, timestamp: 10 });
    const staleDesktopEvent = toolEvent('desktop-stale', { seq: 1, timestamp: 10 });
    const prevented: unknown[] = [];
    const merged = mergeEventsForCloudPush(
      { 't1': [cloudEvent] },
      { 't1': [staleDesktopEvent] },
      {
        sessionIdHash: 'sessionhash',
        onEventOverwritePrevented: (details) => prevented.push(details),
      },
    );

    expect(merged['t1']).toEqual([cloudEvent]);
    expect(mockSessionMergeUtilsLog.warn).toHaveBeenCalledTimes(1);
    expect(mockSessionMergeUtilsLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionIdHash: 'sessionhash',
        turnId: 't1',
        identity: 't1:seq:1',
        diff: expect.arrayContaining([expect.objectContaining({ field: 'toolName' })]),
      }),
      'Prevented incoming event from overwriting existing cloud event during session merge',
    );
    expect(prevented).toHaveLength(1);
  });

  it('dedupes seq-null retry against existing seq-stamped event by fallback identity', () => {
    const cloudEvent = assistantTextEvent('cloud kept', {
      seq: 7,
      timestamp: 1234,
      clientOrdinal: 0,
    });
    const staleRetry = assistantTextEvent('stale retry', {
      seq: null,
      timestamp: 1234,
      clientOrdinal: 0,
    });
    const prevented: unknown[] = [];

    const merged = mergeEventsForCloudPush(
      { 't1': [cloudEvent] },
      { 't1': [staleRetry] },
      { onEventOverwritePrevented: (details) => prevented.push(details) },
    );

    expect(merged['t1']).toEqual([cloudEvent]);
    expect(prevented).toHaveLength(1);
    expect(mockSessionMergeUtilsLog.warn).toHaveBeenCalledTimes(1);
  });

  it('sorts the merged result by seq and then timestamp', () => {
    const seqThree = toolEvent('seq-three', { seq: 3, timestamp: 30 });
    const seqTwo = toolEvent('seq-two', { seq: 2, timestamp: 40 });
    const unstampedEarly = toolEvent('unstamped-early', { timestamp: 10, clientOrdinal: 0 });
    const unstampedLate = toolEvent('unstamped-late', { timestamp: 20, clientOrdinal: 1 });

    const merged = mergeEventsForCloudPush(
      { 't1': [seqThree, unstampedLate] },
      { 't1': [unstampedEarly, seqTwo] },
    );

    expect(merged['t1']).toEqual([seqTwo, seqThree, unstampedEarly, unstampedLate]);
  });

  it('returns existing events when incoming is empty', () => {
    const existingEvent = toolEvent('cloud', { seq: 1, timestamp: 10 });
    const merged = mergeEventsForCloudPush({ 't1': [existingEvent] }, {});
    expect(merged).toEqual({ 't1': [existingEvent] });
  });

  it('returns incoming events when existing is empty', () => {
    const incomingEvent = toolEvent('desktop', { timestamp: 10, clientOrdinal: 0 });
    const merged = mergeEventsForCloudPush({}, { 't1': [incomingEvent] });
    expect(merged).toEqual({ 't1': [incomingEvent] });
  });

  it('keeps two same-millisecond incoming events with distinct clientOrdinal values', () => {
    const first = assistantTextEvent('first', { timestamp: 555, clientOrdinal: 0 });
    const second = assistantTextEvent('second', { timestamp: 555, clientOrdinal: 1 });

    const merged = mergeEventsForCloudPush({}, { 't1': [first, second] });

    expect(merged['t1']).toEqual([first, second]);
    expect(mockSessionMergeUtilsLog.warn).not.toHaveBeenCalled();
  });

  it('dedupes identical same-ordinal incoming retries and emits one overwrite-prevented event', () => {
    const first = assistantTextEvent('retry', { timestamp: 555, clientOrdinal: 0 });
    const second = assistantTextEvent('retry', { timestamp: 555, clientOrdinal: 0 });
    const prevented: unknown[] = [];

    const merged = mergeEventsForCloudPush(
      {},
      { 't1': [first, second] },
      { onEventOverwritePrevented: (details) => prevented.push(details) },
    );

    expect(merged['t1']).toEqual([first]);
    expect(prevented).toHaveLength(1);
    expect(mockSessionMergeUtilsLog.warn).toHaveBeenCalledTimes(1);
  });

  it('handles empty inputs', () => {
    expect(Object.keys(mergeEventsForCloudPush({}, {}))).toHaveLength(0);
  });

  it('collapses content-equivalent seq-mismatch echoes for assistant events', () => {
    const original: AgentEvent = {
      type: 'assistant',
      seq: 75,
      text: 'duplicated answer',
      timestamp: 9_999,
    };
    const restamped: AgentEvent = {
      type: 'assistant',
      seq: 77,
      text: 'duplicated answer',
      timestamp: 9_999,
    };

    const merged = mergeEventsForCloudPush(
      { 't1': [original] },
      { 't1': [restamped] },
    );

    expect(merged['t1']).toEqual([original]);
    expect(mockSessionMergeUtilsLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnIdHash: expect.any(String),
        droppedSeq: 77,
        retainedSeq: 75,
      }),
      'Collapsed content-equivalent restamped event during cloud-push merge',
    );
  });
});

// --------------------------------------------------------------------------
// maxValidSeqForTurn
// --------------------------------------------------------------------------

describe('maxValidSeqForTurn', () => {
  it('returns the highest valid positive-integer seq', () => {
    expect(maxValidSeqForTurn([
      { type: 'status', message: 'a', seq: 3 } as AgentEvent,
      { type: 'result', text: 'b', seq: 7 } as AgentEvent,
      { type: 'status', message: 'c', seq: 5 } as AgentEvent,
    ])).toBe(7);
  });

  it('ignores invalid seqs (undefined, 0, negative, non-integer) and returns 0 when none valid', () => {
    expect(maxValidSeqForTurn([
      { type: 'status', message: 'a' } as AgentEvent,
      { type: 'status', message: 'b', seq: 0 } as AgentEvent,
      { type: 'status', message: 'c', seq: -1 } as AgentEvent,
    ])).toBe(0);
  });

  it('returns 0 for undefined/empty', () => {
    expect(maxValidSeqForTurn(undefined)).toBe(0);
    expect(maxValidSeqForTurn([])).toBe(0);
  });
});

// --------------------------------------------------------------------------
// guardActiveIngestRegression (Stage 2 — REBEL-6C0 / REBEL-6BZ)
// --------------------------------------------------------------------------

describe('guardActiveIngestRegression', () => {
  const userMsg = (turnId: string) => makeMessage('m-user', turnId, 'user', 'q', 100);
  const nonUserMsg = (id: string, turnId: string, text: string) =>
    ({ id, turnId, role: 'result', text, createdAt: 200 }) as AgentSession['messages'][number];
  const result = (seq: number) => ({ type: 'result', text: 'final', seq } as AgentEvent);
  const status = (seq: number) => ({ type: 'status', message: 'streaming', seq } as AgentEvent);

  it('COUNT-STABLE regression: refuses a shared turn with equal non-user count + equal event length but LOWER max seq (keeps live)', () => {
    const live = {
      messages: [userMsg('turn-T'), nonUserMsg('m-answer', 'turn-T', 'final answer')],
      eventsByTurn: { 'turn-T': [result(5)] },
    };
    const incoming = {
      // count-stable: same non-user count (1), same event-array length (1), lower seq.
      messages: [userMsg('turn-T'), { id: 'm-answer', turnId: 'turn-T', role: 'assistant', text: 'stale preamble', createdAt: 200 } as AgentSession['messages'][number]],
      eventsByTurn: { 'turn-T': [status(2)] },
    };

    const guarded = guardActiveIngestRegression(live, incoming);
    expect(guarded.refused).toBe(true);
    expect(guarded.refusedTurnIds).toEqual(['turn-T']);
    // Live content kept for the refused turn
    expect(guarded.messages.find((m) => m.id === 'm-answer')?.text).toBe('final answer');
    expect(guarded.eventsByTurn['turn-T']).toEqual([result(5)]);
  });

  it('refuses a shared turn with FEWER non-user messages (defense-in-depth count signal)', () => {
    const live = {
      messages: [userMsg('turn-T'), nonUserMsg('m-a', 'turn-T', 'a'), nonUserMsg('m-b', 'turn-T', 'b')],
      eventsByTurn: { 'turn-T': [result(3)] },
    };
    const incoming = {
      messages: [userMsg('turn-T'), nonUserMsg('m-a', 'turn-T', 'a')], // dropped m-b
      eventsByTurn: { 'turn-T': [result(3)] }, // equal seq
    };
    const guarded = guardActiveIngestRegression(live, incoming);
    expect(guarded.refused).toBe(true);
    expect(guarded.messages.filter((m) => m.turnId === 'turn-T' && m.role !== 'user')).toHaveLength(2);
  });

  it('does NOT refuse a superset incoming turn (more messages / higher seq applies)', () => {
    const live = {
      messages: [userMsg('turn-T'), nonUserMsg('m-pre', 'turn-T', 'preamble')],
      eventsByTurn: { 'turn-T': [status(2)] },
    };
    const incoming = {
      messages: [userMsg('turn-T'), nonUserMsg('m-pre', 'turn-T', 'preamble'), nonUserMsg('m-ans', 'turn-T', 'answer')],
      eventsByTurn: { 'turn-T': [status(2), result(5)] },
    };
    const guarded = guardActiveIngestRegression(live, incoming);
    expect(guarded.refused).toBe(false);
    expect(guarded.messages).toBe(incoming.messages);
    expect(guarded.eventsByTurn).toBe(incoming.eventsByTurn);
  });

  it('does NOT refuse an equal-content incoming turn', () => {
    const live = {
      messages: [userMsg('turn-T'), nonUserMsg('m-ans', 'turn-T', 'answer')],
      eventsByTurn: { 'turn-T': [result(5)] },
    };
    const incoming = {
      messages: [userMsg('turn-T'), nonUserMsg('m-ans', 'turn-T', 'answer')],
      eventsByTurn: { 'turn-T': [result(5)] },
    };
    expect(guardActiveIngestRegression(live, incoming).refused).toBe(false);
  });

  it('adopts a cloud-only NEW turn while refusing a shrinking shared turn (additive)', () => {
    const live = {
      messages: [userMsg('turn-T'), nonUserMsg('m-ans', 'turn-T', 'live answer')],
      eventsByTurn: { 'turn-T': [result(5)] },
    };
    const incoming = {
      messages: [
        userMsg('turn-T'),
        { id: 'm-ans', turnId: 'turn-T', role: 'assistant', text: 'stale', createdAt: 200 } as AgentSession['messages'][number], // shrink
        nonUserMsg('m-new', 'turn-B', 'cloud new turn'), // new turn
      ],
      eventsByTurn: { 'turn-T': [status(2)], 'turn-B': [result(7)] },
    };
    const guarded = guardActiveIngestRegression(live, incoming);
    expect(guarded.refused).toBe(true);
    // Shared turn kept live
    expect(guarded.messages.find((m) => m.id === 'm-ans')?.text).toBe('live answer');
    expect(guarded.eventsByTurn['turn-T']).toEqual([result(5)]);
    // New cloud turn adopted
    expect(guarded.messages.find((m) => m.id === 'm-new')?.text).toBe('cloud new turn');
    expect(guarded.eventsByTurn['turn-B']).toEqual([result(7)]);
  });

  it('refuses when a turn present live is entirely absent from the incoming snapshot', () => {
    const live = {
      messages: [userMsg('turn-T'), nonUserMsg('m-ans', 'turn-T', 'live')],
      eventsByTurn: { 'turn-T': [result(5)] },
    };
    const incoming = {
      messages: [nonUserMsg('m-other', 'turn-Z', 'cloud only')],
      eventsByTurn: { 'turn-Z': [result(9)] },
    };
    const guarded = guardActiveIngestRegression(live, incoming);
    expect(guarded.refused).toBe(true);
    expect(guarded.refusedTurnIds).toContain('turn-T');
    // Live turn-T kept, cloud turn-Z adopted
    expect(guarded.messages.find((m) => m.id === 'm-ans')?.text).toBe('live');
    expect(guarded.messages.find((m) => m.id === 'm-other')?.text).toBe('cloud only');
  });

  it('first-load (empty live) applies the incoming snapshot fully (no false refusal)', () => {
    const live = { messages: [], eventsByTurn: {} };
    const incoming = {
      messages: [userMsg('turn-T'), nonUserMsg('m-ans', 'turn-T', 'cloud answer')],
      eventsByTurn: { 'turn-T': [result(5)] },
    };
    const guarded = guardActiveIngestRegression(live, incoming);
    expect(guarded.refused).toBe(false);
    expect(guarded.messages).toBe(incoming.messages);
  });
});
