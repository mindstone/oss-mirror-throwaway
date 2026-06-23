/// <reference types="vitest/globals" />

/**
 * Integration test: verifies that a user_question event in eventsByTurn
 * correctly maps to a question card position in the conversation.
 *
 * Exercises the exact pipeline:
 * 1. processEvent → external Map → eventsByTurn snapshot
 * 2. extractQuestionBatches → finds user_question events
 * 3. selectVisibleMessages → filters messages
 * 4. resolveTurnIdForMessage → matches message turnId to events
 * 5. questionCardByMessageIndex → maps batch to message index
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentEvent } from '@shared/types';
import {
  createSessionStore,
  getCurrentSessionEvents,
  clearCurrentSessionEvents,
} from '../../store/sessionStore';
import { shouldRenderInlineQuestionBatch, computeScrollToAnswerIndex } from '../../components/ConversationPane';
import type { QuestionBatchState } from '../useUserQuestions';
import { extractQuestionBatches, buildQuestionBatchStates, extractAnsweredBatches } from '../useUserQuestions';
import { selectVisibleMessages } from '../../store/selectors';

// Mock window.sessionsApi needed by createSessionStore
vi.stubGlobal('window', {
  ...globalThis.window,
  sessionsApi: { upsert: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) },
  agentApi: { userQuestionResponse: vi.fn().mockResolvedValue({ success: true, continuationMessage: 'test-continuation' }), turn: vi.fn().mockResolvedValue({ turnId: 'fallback-turn' }) },
});

const TURN_ID = 'turn-abc123';
const SESSION_ID = 'session-xyz456';
const BATCH_ID = 'batch-q1';

function makeUserQuestionEvent(): AgentEvent {
  return {
    type: 'user_question',
    batchId: BATCH_ID,
    toolUseId: 'tool-use-1',
    questions: [{
      id: 'q0',
      question: 'What format do you prefer?',
      header: 'Format',
      options: [
        { id: 'q0-opt0', label: 'Bullet points', description: 'Quick scannable overview' },
        { id: 'q0-opt1', label: 'Paragraphs', description: 'Detailed narrative format' },
      ],
      multiSelect: false,
    }],
    timestamp: Date.now(),
  } as AgentEvent;
}

/**
 * Simulate the exact event sequence from the failing scenario:
 * 1. tool start (AskUserQuestion)
 * 2. user_question (from hook)
 * 3. tool end (AskUserQuestion denied)
 * 4. assistant ("It works — the question has been presented to you")
 * 5. result
 */
function simulateFullTurnEvents(): AgentEvent[] {
  const now = Date.now();
  return [
    { type: 'tool', toolName: 'AskUserQuestion', toolUseId: 'tool-use-1', stage: 'start', timestamp: now } as AgentEvent,
    makeUserQuestionEvent(),
    { type: 'tool', toolName: 'AskUserQuestion', toolUseId: 'tool-use-1', stage: 'end', timestamp: now + 6 } as AgentEvent,
    { type: 'assistant', text: 'It works — the question has been presented to you', timestamp: now + 3000 } as AgentEvent,
    { type: 'result', text: '', timestamp: now + 3001 } as AgentEvent,
  ];
}

// Import compaction to test the full pipeline
import { compactTurnEvents, compactCompletedTurns } from '@shared/utils/eventCompaction';

describe('user_question card mapping integration', () => {
  let store: ReturnType<typeof createSessionStore>;

  beforeEach(() => {
    clearCurrentSessionEvents();
    store = createSessionStore();
  });

  it('extractQuestionBatches finds user_question event in eventsByTurn', () => {
    const events = simulateFullTurnEvents();
    for (const event of events) {
      store.getState().processEvent(TURN_ID, event);
    }
    const eventsByTurn = getCurrentSessionEvents();
    const batches = extractQuestionBatches(eventsByTurn, SESSION_ID);

    expect(batches).toHaveLength(1);
    expect(batches[0].batchId).toBe(BATCH_ID);
    expect(batches[0].turnId).toBe(TURN_ID);
    expect(batches[0].questions).toHaveLength(1);
  });

  it('question batch is not marked as answered when no answer event exists', () => {
    const events = simulateFullTurnEvents();
    for (const event of events) {
      store.getState().processEvent(TURN_ID, event);
    }
    const eventsByTurn = getCurrentSessionEvents();
    const eventBatches = extractQuestionBatches(eventsByTurn, SESSION_ID);
    const answeredBatches = extractAnsweredBatches(eventsByTurn);
    const states = buildQuestionBatchStates(eventBatches, answeredBatches);

    expect(states).toHaveLength(1);
    expect(states[0].isAnswered).toBe(false);
  });

  it('visible messages include at least one message matching the turn after full event sequence', () => {
    // Simulate: add user message, assign turn, process events
    const userMsg = store.getState().addUserMessage('can we test if AskUserQuestion works?');
    store.getState().assignTurnToMessage(userMsg.id, TURN_ID, Date.now());

    const events = simulateFullTurnEvents();
    for (const event of events) {
      store.getState().processEvent(TURN_ID, event);
    }

    const messages = store.getState().messages;
    const visible = selectVisibleMessages(messages);

    // User message visible; result may or may not be visible depending on narration pruning
    expect(visible.length).toBeGreaterThanOrEqual(1);

    // At least one visible message should have the right turnId
    const matchingMessages = visible.filter(m => m.turnId === TURN_ID);
    expect(matchingMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('questionCardByMessageIndex maps batch to a visible message (full pipeline)', () => {
    // 1. Add user message and assign turn
    const userMsg = store.getState().addUserMessage('can we test if AskUserQuestion works?');
    store.getState().assignTurnToMessage(userMsg.id, TURN_ID, Date.now());

    // 2. Process all events
    const events = simulateFullTurnEvents();
    for (const event of events) {
      store.getState().processEvent(TURN_ID, event);
    }

    // 3. Get eventsByTurn and extract batches
    const eventsByTurn = getCurrentSessionEvents();
    const eventBatches = extractQuestionBatches(eventsByTurn, SESSION_ID);
    const answeredBatches = extractAnsweredBatches(eventsByTurn);
    const questionBatches = buildQuestionBatchStates(eventBatches, answeredBatches);

    expect(questionBatches).toHaveLength(1);

    // 4. Get visible messages
    const messages = store.getState().messages;
    const visibleMessages = selectVisibleMessages(messages);

    // 5. Simulate questionCardByMessageIndex logic from ConversationPane
    const batchByTurnId = new Map<string, typeof questionBatches[0]>();
    for (const qb of questionBatches) {
      batchByTurnId.set(qb.batch.turnId, qb);
    }

    const map = new Map<number, typeof questionBatches[0]>();
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const msg = visibleMessages[i];
      // Inline resolveTurnIdForMessage logic
      const turnId = (msg.turnId && msg.turnId !== 'FALLBACK_TURN_ID' && eventsByTurn[msg.turnId])
        ? msg.turnId
        : (msg.role !== 'user' && msg.turnId && msg.turnId !== 'FALLBACK_TURN_ID')
          ? msg.turnId
          : null;

      if (turnId && batchByTurnId.has(turnId)) {
        const batch = batchByTurnId.get(turnId)!;
        map.set(i, batch);
        batchByTurnId.delete(turnId);
      }
      if (batchByTurnId.size === 0) break;
    }

    // The card SHOULD be mapped to some message index
    expect(map.size).toBe(1);
    const [index, mappedBatch] = [...map.entries()][0];
    expect(mappedBatch.batch.batchId).toBe(BATCH_ID);
    expect(index).toBeGreaterThanOrEqual(0);
  });

  it('question card renders after events survive LRU compaction (the original bug scenario)', () => {
    // This test exercises the EXACT bug path:
    // 1. Events are stored in eventsByTurn (as if from background session flush)
    // 2. compactCompletedTurns compacts the completed turn
    // 3. The card mapping pipeline runs on the compacted events
    //
    // Before the fix, user_question was dropped by compaction → card wouldn't render.

    // 1. Build a realistic eventsByTurn record (simulating post-flush state)
    const events = simulateFullTurnEvents();
    const eventsByTurn: Record<string, AgentEvent[]> = {
      [TURN_ID]: events,
    };

    // 2. Run compaction (this is what cacheSession does for completed background turns)
    const compactedEventsByTurn = compactCompletedTurns(eventsByTurn);

    // Verify the turn was actually compacted (last event is 'result', so it's completed)
    expect(compactedEventsByTurn[TURN_ID]).not.toBe(eventsByTurn[TURN_ID]);

    // 3. Verify user_question survives compaction
    const compactedTypes = compactedEventsByTurn[TURN_ID].map(e => e.type);
    expect(compactedTypes).toContain('user_question');

    // 4. Extract batches from the COMPACTED events (not the originals)
    const batches = extractQuestionBatches(compactedEventsByTurn, SESSION_ID);
    expect(batches).toHaveLength(1);
    expect(batches[0].batchId).toBe(BATCH_ID);
    expect(batches[0].questions).toHaveLength(1);
    expect(batches[0].questions[0].options).toHaveLength(2);
  });

  it('compactTurnEvents preserves user_question fields needed for card rendering', () => {
    const events = simulateFullTurnEvents();
    const compacted = compactTurnEvents(events);

    const userQuestionEvent = compacted.find(e => e.type === 'user_question');
    expect(userQuestionEvent).toBeDefined();

    // Verify ALL fields needed by useUserQuestions + ConversationPane survive
    if (userQuestionEvent?.type === 'user_question') {
      expect(userQuestionEvent.batchId).toBe(BATCH_ID);
      expect(userQuestionEvent.toolUseId).toBe('tool-use-1');
      expect(userQuestionEvent.questions).toHaveLength(1);
      expect(userQuestionEvent.questions[0].id).toBe('q0');
      expect(userQuestionEvent.questions[0].header).toBe('Format');
      expect(userQuestionEvent.questions[0].options).toHaveLength(2);
      expect(userQuestionEvent.timestamp).toBeGreaterThan(0);
    }
  });

  it('orphaned batch (turn with no visible messages) anchors to closest preceding visible message', () => {
    // Simulates the exact bug: Turn 1 has a visible user message + question.
    // Turn 2 is a system-continuation turn (only isHidden user message) with
    // another question. Turn 2's card had nowhere to anchor and was lost.
    const TURN_1 = 'turn-1-with-visible-msg';
    const TURN_2 = 'turn-2-system-continuation';
    const BATCH_1 = 'batch-turn1';
    const BATCH_2 = 'batch-turn2';
    const now = Date.now();

    // Turn 1: user typed a message, agent asked a question, user answered
    const turn1UserMsg = store.getState().addUserMessage('Install the browser extension');
    store.getState().assignTurnToMessage(turn1UserMsg.id, TURN_1, now);

    const turn1Events: AgentEvent[] = [
      { type: 'user_question', batchId: BATCH_1, toolUseId: 'tu-1', questions: [{
        id: 'q0', question: 'Which browser?', header: 'Browser',
        options: [{ id: 'q0-opt0', label: 'Chrome' }, { id: 'q0-opt1', label: 'Comet' }],
        multiSelect: false,
      }], timestamp: now + 100 } as AgentEvent,
      { type: 'user_question_answered', batchId: BATCH_1, answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt1'] }], timestamp: now + 200 } as AgentEvent,
    ];
    for (const e of turn1Events) store.getState().processEvent(TURN_1, e);

    // Turn 2: system-continuation (hidden user message), agent asked another question, user answered
    const turn2UserMsg = store.getState().addUserMessage(
      'The user answered: Comet', undefined,
      { isHidden: true, messageOrigin: 'system-continuation' },
    );
    store.getState().assignTurnToMessage(turn2UserMsg.id, TURN_2, now + 300);

    const turn2Events: AgentEvent[] = [
      { type: 'user_question', batchId: BATCH_2, toolUseId: 'tu-2', questions: [{
        id: 'q0', question: 'Install now?', header: 'Install',
        options: [{ id: 'q0-opt0', label: 'Yes' }, { id: 'q0-opt1', label: 'Not now' }],
        multiSelect: false,
      }], timestamp: now + 400 } as AgentEvent,
      { type: 'user_question_answered', batchId: BATCH_2, answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }], timestamp: now + 500 } as AgentEvent,
    ];
    for (const e of turn2Events) store.getState().processEvent(TURN_2, e);

    // Extract batches
    const eventsByTurn = getCurrentSessionEvents();
    const eventBatches = extractQuestionBatches(eventsByTurn, SESSION_ID);
    const answeredBatches = extractAnsweredBatches(eventsByTurn);
    const questionBatches = buildQuestionBatchStates(eventBatches, answeredBatches);

    expect(questionBatches).toHaveLength(2);
    expect(questionBatches.every(qb => qb.isAnswered)).toBe(true);

    // Get visible messages — Turn 2's hidden message should be filtered out
    const messages = store.getState().messages;
    const visibleMessages = selectVisibleMessages(messages);
    const turn2Visible = visibleMessages.filter(m => m.turnId === TURN_2);
    expect(turn2Visible).toHaveLength(0); // confirms Turn 2 has no visible message

    // Simulate the FIXED questionCardByMessageIndex logic (with orphan fallback)
    const batchesByTurnId = new Map<string, QuestionBatchState[]>();
    for (const qb of questionBatches) {
      const existing = batchesByTurnId.get(qb.batch.turnId) ?? [];
      existing.push(qb);
      batchesByTurnId.set(qb.batch.turnId, existing);
    }

    const map = new Map<number, QuestionBatchState[]>();
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const msg = visibleMessages[i];
      const turnId = msg.turnId;
      if (turnId && batchesByTurnId.has(turnId)) {
        const batches = batchesByTurnId.get(turnId)!;
        map.set(i, batches);
        batchesByTurnId.delete(turnId);
      }
      if (batchesByTurnId.size === 0) break;
    }

    // Orphan fallback: anchor to closest preceding visible message by timestamp
    if (batchesByTurnId.size > 0) {
      const orphanedBatches = [...batchesByTurnId.values()]
        .flat()
        .sort((a, b) => a.batch.timestamp - b.batch.timestamp);

      for (const orphan of orphanedBatches) {
        let bestIndex = -1;
        for (let i = visibleMessages.length - 1; i >= 0; i--) {
          const msgTime = visibleMessages[i].createdAt ?? 0;
          if (msgTime <= orphan.batch.timestamp) {
            bestIndex = i;
            break;
          }
        }
        if (bestIndex < 0 && visibleMessages.length > 0) {
          bestIndex = visibleMessages.length - 1;
        }
        if (bestIndex >= 0) {
          const existing = map.get(bestIndex) ?? [];
          existing.push(orphan);
          map.set(bestIndex, existing);
        }
      }
    }

    // Both batches should now be mapped
    const allMappedBatches = [...map.values()].flat();
    expect(allMappedBatches).toHaveLength(2);

    // BATCH_2 (orphaned) should be anchored somewhere
    const batch2Mapped = allMappedBatches.find(qb => qb.batch.batchId === BATCH_2);
    expect(batch2Mapped).toBeDefined();
  });

  it('dismissed batch does not appear in inline mapping', () => {
    // Process events to create the turn
    const events = simulateFullTurnEvents();
    for (const event of events) {
      store.getState().processEvent(TURN_ID, event);
    }

    const eventsByTurn = getCurrentSessionEvents();
    const eventBatches = extractQuestionBatches(eventsByTurn, SESSION_ID);
    const answeredBatches = extractAnsweredBatches(eventsByTurn);

    // Mark the batch as dismissed
    const dismissedBatchIds = new Set([BATCH_ID]);
    const states = buildQuestionBatchStates(eventBatches, answeredBatches, { dismissedBatchIds });

    expect(states).toHaveLength(1);
    expect(states[0].dismissed).toBe(true);
    expect(states[0].isAnswered).toBe(false);

    // Use the production render predicate from ConversationPane
    const inlineBatches = states.filter(shouldRenderInlineQuestionBatch);
    expect(inlineBatches).toHaveLength(0);
  });

  it('continuation turn batch anchors to first visible message after batch timestamp (Bug 3 fallback)', () => {
    // Scenario: Turn A asks Q1 → user answers → continuation Turn B asks Q2 →
    // user answers → Turn C shows result. Turn B's only message is hidden
    // system-continuation, so Q2's batch has no visible message match by turnId.
    // The timestamp-based fallback should anchor Q2's card to the result message.
    const TURN_B = 'turn-continuation-b';
    const TURN_C = 'turn-answer-processing-c';
    const BATCH_CONT = 'batch-continuation';
    const now = Date.now();

    // Turn B has a user_question event (asked at now + 1000)
    const eventsByTurn: Record<string, AgentEvent[]> = {
      [TURN_B]: [{
        type: 'user_question',
        batchId: BATCH_CONT,
        toolUseId: 'tool-cont',
        questions: [{
          id: 'q-fruits',
          question: 'Which fruits do you like?',
          header: 'Fruits',
          options: [
            { id: 'opt-apples', label: 'Apples' },
            { id: 'opt-bananas', label: 'Bananas' },
          ],
          multiSelect: false,
        }],
        timestamp: now + 1000,
      } as AgentEvent],
    };

    const eventBatches = extractQuestionBatches(eventsByTurn, SESSION_ID);
    const answeredBatches = extractAnsweredBatches(eventsByTurn);
    const questionBatches = buildQuestionBatchStates(eventBatches, answeredBatches);
    expect(questionBatches).toHaveLength(1);
    expect(questionBatches[0].batch.turnId).toBe(TURN_B);

    // Visible messages: user message (before question), result message (after answer)
    // Turn B has NO visible messages — only hidden system-continuation
    const visibleMessages = [
      { id: 'msg-user', turnId: TURN_ID, role: 'user' as const, text: 'Ask me a question', createdAt: now },
      { id: 'msg-result', turnId: TURN_C, role: 'result' as const, text: 'You picked Apples.', createdAt: now + 5000 },
    ];

    // Simulate questionCardByMessageIndex logic (backward walk + fallback)
    const batchesByTurnId = new Map<string, QuestionBatchState[]>();
    for (const qb of questionBatches) {
      const existing = batchesByTurnId.get(qb.batch.turnId) ?? [];
      existing.push(qb);
      batchesByTurnId.set(qb.batch.turnId, existing);
    }

    const map = new Map<number, QuestionBatchState[]>();

    // Backward walk — should NOT match (Turn B has no visible messages)
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const msg = visibleMessages[i];
      const turnId = (msg.turnId && msg.turnId !== 'FALLBACK_TURN_ID' && eventsByTurn[msg.turnId])
        ? msg.turnId
        : (msg.role !== 'user' && msg.turnId && msg.turnId !== 'FALLBACK_TURN_ID')
          ? msg.turnId
          : null;
      if (turnId && batchesByTurnId.has(turnId)) {
        const batches = batchesByTurnId.get(turnId);
        if (batches) map.set(i, batches);
        batchesByTurnId.delete(turnId);
      }
      if (batchesByTurnId.size === 0) break;
    }

    expect(map.size).toBe(0);
    expect(batchesByTurnId.size).toBe(1);

    // Timestamp-based fallback (matches the ConversationPane fix)
    for (const batches of batchesByTurnId.values()) {
      const batchTimestamp = batches[0]?.batch.timestamp ?? 0;
      if (batchTimestamp === 0) continue;
      let anchorIndex = visibleMessages.length - 1;
      for (let i = 0; i < visibleMessages.length; i++) {
        if (visibleMessages[i].createdAt > batchTimestamp) {
          anchorIndex = i;
          break;
        }
      }
      const existing = map.get(anchorIndex);
      if (existing) {
        existing.push(...batches);
      } else {
        map.set(anchorIndex, batches);
      }
    }

    // Batch should anchor to the result message (index 1, createdAt > question timestamp)
    expect(map.size).toBe(1);
    expect(map.has(1)).toBe(true);
    const anchored = map.get(1)!;
    expect(anchored[0].batch.batchId).toBe(BATCH_CONT);
  });
});

/**
 * Regression tests for the scroll-to-answer effect.
 *
 * Bug: After the user submits an AskUserQuestion answer, the answered card is
 * anchored to the asking turn and can either (A) sit above the viewport after
 * the continuation turn scrolls in, or (B) be unmounted entirely by the
 * virtualizer overscan. computeScrollToAnswerIndex detects newly-answered
 * batches so ConversationPane can call virtualizer.scrollToIndex and nudge the
 * card into view.
 *
 * See docs-private/investigations/260416_answered_question_card_not_visible.md.
 */
describe('computeScrollToAnswerIndex (scroll-to-answer helper)', () => {
  function makeBatchState(batchId: string, turnId: string, isAnswered: boolean): QuestionBatchState {
    return {
      batch: {
        batchId,
        turnId,
        toolUseId: `tool-${batchId}`,
        questions: [],
        timestamp: 1,
        sessionId: SESSION_ID,
      },
      isAnswered,
      answers: isAnswered ? [] : undefined,
      skipped: false,
      dismissed: false,
    } as unknown as QuestionBatchState;
  }

  it('returns -1 when no batch transitioned from unanswered to answered', () => {
    const prev = new Set<string>(['b1']);
    const current = new Set<string>(['b1']);
    const map = new Map<number, QuestionBatchState[]>([
      [3, [makeBatchState('b1', TURN_ID, true)]],
    ]);

    expect(computeScrollToAnswerIndex(prev, current, map)).toBe(-1);
  });

  it('returns -1 when the current answered set is empty', () => {
    const prev = new Set<string>();
    const current = new Set<string>();
    const map = new Map<number, QuestionBatchState[]>();

    expect(computeScrollToAnswerIndex(prev, current, map)).toBe(-1);
  });

  it('returns the anchored message index when a batch transitions to answered', () => {
    const prev = new Set<string>();
    const current = new Set<string>(['b1']);
    const map = new Map<number, QuestionBatchState[]>([
      [1, [makeBatchState('b1', TURN_ID, true)]],
    ]);

    expect(computeScrollToAnswerIndex(prev, current, map)).toBe(1);
  });

  it('returns -1 when the newly-answered batch has no matching message anchor', () => {
    // Edge case: answer arrives before the virtualizer has a visible message
    // for that batch's turnId. Effect should no-op rather than scroll to -1.
    const prev = new Set<string>();
    const current = new Set<string>(['b1']);
    const map = new Map<number, QuestionBatchState[]>();

    expect(computeScrollToAnswerIndex(prev, current, map)).toBe(-1);
  });

  it('prefers the highest (most recent) index when multiple batches are newly answered', () => {
    const prev = new Set<string>();
    const current = new Set<string>(['b1', 'b2']);
    const map = new Map<number, QuestionBatchState[]>([
      [2, [makeBatchState('b1', 'turn-1', true)]],
      [7, [makeBatchState('b2', 'turn-2', true)]],
    ]);

    expect(computeScrollToAnswerIndex(prev, current, map)).toBe(7);
  });

  it('ignores already-answered batches and only targets the newly-answered one', () => {
    const prev = new Set<string>(['b-old']);
    const current = new Set<string>(['b-old', 'b-new']);
    const map = new Map<number, QuestionBatchState[]>([
      [2, [makeBatchState('b-old', 'turn-old', true)]],
      [5, [makeBatchState('b-new', 'turn-new', true)]],
    ]);

    expect(computeScrollToAnswerIndex(prev, current, map)).toBe(5);
  });

  it('end-to-end: simulates user_question_answered arriving and resolves target index', () => {
    // 1. Asking turn fires, batch is unanswered
    const eventsByTurn: Record<string, AgentEvent[]> = {
      [TURN_ID]: simulateFullTurnEvents(),
    };
    const batchesBefore = extractQuestionBatches(eventsByTurn, SESSION_ID);
    const answeredBefore = extractAnsweredBatches(eventsByTurn);
    const statesBefore = buildQuestionBatchStates(batchesBefore, answeredBefore);
    const answeredIdsBefore = new Set(
      statesBefore.filter((s) => s.isAnswered).map((s) => s.batch.batchId),
    );
    expect(answeredIdsBefore.size).toBe(0);

    // 2. user_question_answered event arrives (simulating submit)
    const answeredEvent: AgentEvent = {
      type: 'user_question_answered',
      batchId: BATCH_ID,
      answers: [{ questionId: 'q0', selectedOptionIds: ['q0-opt0'] }],
      timestamp: Date.now(),
    } as AgentEvent;
    eventsByTurn[TURN_ID] = [...eventsByTurn[TURN_ID], answeredEvent];

    const batchesAfter = extractQuestionBatches(eventsByTurn, SESSION_ID);
    const answeredAfter = extractAnsweredBatches(eventsByTurn);
    const statesAfter = buildQuestionBatchStates(batchesAfter, answeredAfter);
    const answeredIdsAfter = new Set(
      statesAfter.filter((s) => s.isAnswered).map((s) => s.batch.batchId),
    );
    expect(answeredIdsAfter.has(BATCH_ID)).toBe(true);

    // 3. Build a plausible questionCardByMessageIndex (batch anchored at index 1)
    const ANCHOR_INDEX = 1;
    const map = new Map<number, QuestionBatchState[]>([
      [ANCHOR_INDEX, statesAfter],
    ]);

    // 4. Helper should target the anchor index → virtualizer can scroll there
    expect(computeScrollToAnswerIndex(answeredIdsBefore, answeredIdsAfter, map)).toBe(ANCHOR_INDEX);
  });
});
