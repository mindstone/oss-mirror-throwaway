import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { AgentEvent, AgentTurnMessage } from '@shared/types';
import type { AgentSessionWithRuntime } from '../../types';
import {
  applyTurnEventUnion,
  updateSessionWithEvent,
  stripRuntimeFromSessions,
} from '../reducers/historyReducer';

const makeTurnId = () => 'turn-test-1';

const makeSession = (
  messages: AgentTurnMessage[] = [],
  eventsByTurn: Record<string, AgentEvent[]> = {}
): AgentSessionWithRuntime => ({
  id: 'session-1',
  title: 'Test Session',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages,
  eventsByTurn,
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  resolvedAt: null,
  doneAt: null,
  origin: 'manual',
} as AgentSessionWithRuntime);

const makeUserMessage = (turnId: string, text = 'Hello'): AgentTurnMessage => ({
  id: 'msg-user-1',
  turnId,
  role: 'user',
  text,
  createdAt: Date.now()
});

const makeAssistantMessage = (turnId: string, text: string): AgentTurnMessage => ({
  id: 'msg-assistant-1',
  turnId,
  role: 'assistant',
  text,
  createdAt: Date.now()
});

type Synthetic137Fixture = {
  sessionId: string;
  turnId: string;
  events: AgentEvent[];
  expectedUniqueCount: number;
};

const loadSynthetic137Fixture = (): Synthetic137Fixture => {
  const fixturePath = path.join(__dirname, 'fixtures', 'terminalReplay137.synthetic.json');
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as Synthetic137Fixture;
};

describe('historyReducer.updateSessionWithEvent', () => {
  it('preserves thinking-style assistant messages when skipThinkingPrune is true', () => {
    const turnId = makeTurnId();
    const thinkingText = "I'll check that for you.";
    const session = makeSession(
      [makeUserMessage(turnId), makeAssistantMessage(turnId, thinkingText)],
      { [turnId]: [{ type: 'assistant', text: thinkingText, timestamp: Date.now() }] }
    );

    const toolStartEvent: AgentEvent = {
      type: 'tool',
      toolName: 'search',
      detail: 'Searching...',
      stage: 'start',
      timestamp: Date.now()
    };

    const updated = updateSessionWithEvent(session, turnId, toolStartEvent, { skipThinkingPrune: true });

    // Thinking-style message should be preserved
    expect(updated.messages).toHaveLength(2);
    expect(updated.messages[1].role).toBe('assistant');
    expect(updated.messages[1].text).toBe(thinkingText);
  });

  it('removes thinking-style assistant messages by default (no options)', () => {
    const turnId = makeTurnId();
    const session = makeSession(
      [makeUserMessage(turnId), makeAssistantMessage(turnId, "Let me look into that.")],
      { [turnId]: [{ type: 'assistant', text: "Let me look into that.", timestamp: Date.now() }] }
    );

    const toolStartEvent: AgentEvent = {
      type: 'tool',
      toolName: 'search',
      detail: 'Searching...',
      stage: 'start',
      timestamp: Date.now()
    };

    const updated = updateSessionWithEvent(session, turnId, toolStartEvent);

    // Thinking-style message should be removed (default behavior)
    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0].role).toBe('user');
  });
});

describe('historyReducer.updateSessionWithEvent — classified-supersede gating', () => {
  // The classified-supersede is intentionally gated to the live in-process IPC
  // path (where terminatedTurnIds is populated and ordered). On rehydration
  // the field is stripped (see stripRuntimeFromSessions), so we cannot make a
  // safe most-recently-terminated check. The persisted lastError already
  // carries the final state; we don't try to upgrade it on load.
  it('does NOT upgrade lastError on rehydrated-then-late-IPC path', () => {
    const turnId = makeTurnId();
    const firstError: AgentEvent = {
      type: 'error',
      error: 'Provider returned error',
      errorSource: 'main',
      timestamp: 1000
    };
    // Simulate a session as it looks immediately after being rehydrated from
    // disk: eventsByTurn already contains the first (unclassified) error,
    // lastError carries the raw string, terminatedTurnIds is absent (stripped).
    const session: AgentSessionWithRuntime = {
      ...makeSession([makeUserMessage(turnId)], { [turnId]: [firstError] }),
      lastError: 'Provider returned error',
      resolvedAt: 1000
    };

    const classified: AgentEvent = {
      type: 'error',
      error: "Your AI provider's rate limit was reached. Try again shortly.",
      errorKind: 'rate_limit',
      errorSource: 'main',
      timestamp: 1016
    };

    const updated = updateSessionWithEvent(session, turnId, classified);

    // No supersede on rehydrated path — the persisted raw copy stays.
    expect(updated.lastError).toBe('Provider returned error');
  });
});

describe('historyReducer.applyTurnEventUnion', () => {
  it('dedups the synthetic 137-event replay fixture to the expected unique event count', () => {
    const fixture = loadSynthetic137Fixture();
    const turnId = fixture.turnId;
    const baseEvents = fixture.events.slice(0, fixture.expectedUniqueCount);
    const replayEvents = fixture.events.slice(fixture.expectedUniqueCount);
    const session = makeSession([makeUserMessage(turnId)], { [turnId]: baseEvents });

    const buggyReplay = replayEvents.reduce(
      (acc, event) => updateSessionWithEvent(acc, turnId, event, { skipThinkingPrune: true }),
      session,
    );
    expect(buggyReplay.eventsByTurn[turnId]).toHaveLength(136);

    const dedupActivations: Array<{ turnId: string; dedupedCount: number }> = [];
    const fixedReplay = applyTurnEventUnion(session, turnId, replayEvents, {
      skipThinkingPrune: true,
      onDedupActivated: (params) => dedupActivations.push(params),
    });

    expect(fixedReplay.eventsByTurn[turnId]).toHaveLength(fixture.expectedUniqueCount);
    expect(dedupActivations).toEqual([{ turnId, dedupedCount: fixture.expectedUniqueCount }]);
  });

  it('handles terminal-before-checkpoint overlap without dropping buffered events', () => {
    const fixture = loadSynthetic137Fixture();
    const turnId = fixture.turnId;
    const full = fixture.events.slice(0, fixture.expectedUniqueCount);
    const basePartial = full.slice(0, 40);
    const session = makeSession([makeUserMessage(turnId)], { [turnId]: basePartial });

    const merged = applyTurnEventUnion(session, turnId, full, { skipThinkingPrune: true });

    expect(merged.eventsByTurn[turnId]).toHaveLength(fixture.expectedUniqueCount);
    expect(new Set(merged.eventsByTurn[turnId].map((event) => event.seq))).toHaveLength(
      fixture.expectedUniqueCount,
    );
  });

  it('handles terminal-after-checkpoint overlap idempotently (no duplication)', () => {
    const fixture = loadSynthetic137Fixture();
    const turnId = fixture.turnId;
    const full = fixture.events.slice(0, fixture.expectedUniqueCount);
    const session = makeSession([makeUserMessage(turnId)], { [turnId]: full });

    const merged = applyTurnEventUnion(session, turnId, full, { skipThinkingPrune: true });

    expect(merged.eventsByTurn[turnId]).toHaveLength(fixture.expectedUniqueCount);
    expect(new Set(merged.eventsByTurn[turnId].map((event) => event.seq))).toHaveLength(
      fixture.expectedUniqueCount,
    );
  });

  it('handles concurrent interleaving overlap without loss or duplication', () => {
    const fixture = loadSynthetic137Fixture();
    const turnId = fixture.turnId;
    const full = fixture.events.slice(0, fixture.expectedUniqueCount);
    const baseInterleaved = [...full.slice(0, 32), ...full.slice(48, 56)];
    const incomingInterleaved = [...full.slice(16, 60), ...full.slice(56)];
    const session = makeSession([makeUserMessage(turnId)], { [turnId]: baseInterleaved });

    const merged = applyTurnEventUnion(session, turnId, incomingInterleaved, {
      skipThinkingPrune: true,
    });

    expect(merged.eventsByTurn[turnId]).toHaveLength(fixture.expectedUniqueCount);
    expect(new Set(merged.eventsByTurn[turnId].map((event) => event.seq))).toHaveLength(
      fixture.expectedUniqueCount,
    );
  });

  it('reports legacy fallback identity usage once per union batch', () => {
    const turnId = makeTurnId();
    const base: AgentEvent = {
      type: 'status',
      message: 'base',
      timestamp: 1_000,
      seq: 1,
    };
    const legacyA: AgentEvent = {
      type: 'status',
      message: 'legacy-a',
      timestamp: 1_100,
    };
    const legacyB: AgentEvent = {
      type: 'assistant',
      text: 'legacy-b',
      timestamp: 1_200,
    };
    const session = makeSession([makeUserMessage(turnId)], { [turnId]: [base] });
    const fallbackUsage: Array<{ turnId: string; legacyEventCount: number }> = [];

    applyTurnEventUnion(session, turnId, [legacyA, legacyB], {
      skipThinkingPrune: true,
      onLegacyFallbackIdentityUsed: (params) => fallbackUsage.push(params),
    });

    expect(fallbackUsage).toEqual([{ turnId, legacyEventCount: 2 }]);
  });
});

describe('historyReducer.stripRuntimeFromSessions', () => {
  it('strips runtime field from sessions', () => {
    const session: AgentSessionWithRuntime = {
      ...makeSession(),
      runtime: { startedAt: null, lastActivityAt: null, activeTurnId: null, terminated: false } as unknown as AgentSessionWithRuntime['runtime'],
    };
    const [stripped] = stripRuntimeFromSessions([session]);
    expect('runtime' in stripped).toBe(false);
    expect(stripped.id).toBe('session-1');
  });

  it('preserves all other session fields', () => {
    const session = makeSession();
    const [stripped] = stripRuntimeFromSessions([session]);
    expect(stripped.id).toBe(session.id);
    expect(stripped.title).toBe(session.title);
    expect(stripped.messages).toBe(session.messages);
  });
});
