import { beforeEach, describe, expect, it, vi } from 'vitest';
const { mockLogger, createIdMock } = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  createIdMock: vi.fn(() => 'mock-id'),
}));
vi.mock('@core/logger', () => ({
  createScopedLogger: () => mockLogger,
}));
vi.mock('@shared/utils/id', () => ({
  createId: createIdMock,
}));
import { LazyContextAccumulator, replayConversationShapeFromScratch } from '../lazyContextAccumulator';
import { resetSessionSeqIndexForTests } from '../sessionSeqIndex';
import type { AgentEvent } from '@shared/types';

const QUESTION_PAUSE_QUIPS = [
  'Did some digging. Had a question.',
  'Reviewed the situation. Needed your take.',
  'Looked into it. One thing needed your call.',
  'Assessed the options. Your turn.',
  'Did the homework. Found a decision point.',
  'Processed everything. Had a follow-up for you.',
] as const;

function toolStart(toolName: string, toolUseId: string, timestamp = 1000): AgentEvent {
  return {
    type: 'tool',
    stage: 'start',
    toolName,
    toolUseId,
    detail: '{}',
    timestamp,
  } as AgentEvent;
}

function toolEnd(toolUseId: string, timestamp = 2000): AgentEvent {
  return {
    type: 'tool',
    stage: 'end',
    toolName: toolUseId,
    toolUseId,
    detail: 'done',
    timestamp,
  } as AgentEvent;
}

function status(message: string, timestamp: number): AgentEvent {
  return { type: 'status', message, timestamp } as AgentEvent;
}

function assistant(text: string, timestamp: number): AgentEvent {
  return { type: 'assistant', text, timestamp } as AgentEvent;
}

function assistantDelta(text: string, timestamp: number): AgentEvent {
  return { type: 'assistant_delta', text, timestamp } as AgentEvent;
}

function thinkingDelta(text: string, timestamp: number): AgentEvent {
  return { type: 'thinking_delta', text, timestamp } as AgentEvent;
}

function result(text: string, timestamp: number, extras?: Record<string, unknown>): AgentEvent {
  return { type: 'result', text, timestamp, ...(extras ?? {}) } as AgentEvent;
}

function errorEvent(error: string, timestamp: number, extras?: Record<string, unknown>): AgentEvent {
  return { type: 'error', error, timestamp, ...(extras ?? {}) } as AgentEvent;
}

function userQuestion(timestamp: number): AgentEvent {
  return {
    type: 'user_question',
    batchId: 'batch-1',
    toolUseId: 'toolu-question',
    questions: [
      {
        id: 'q1',
        question: 'Which option?',
        header: 'Decision',
        options: [{ id: 'a', label: 'A', description: 'Pick A' }],
        multiSelect: false,
      },
    ],
    timestamp,
  } as AgentEvent;
}

function pickQuestionPauseQuip(turnId: string): string {
  let hash = 0;
  for (let i = 0; i < turnId.length; i += 1) {
    hash = ((hash << 5) - hash + turnId.charCodeAt(i)) | 0;
  }
  return QUESTION_PAUSE_QUIPS[Math.abs(hash) % QUESTION_PAUSE_QUIPS.length];
}

describe('LazyContextAccumulator — executed tool side-table', () => {
  beforeEach(() => {
    resetSessionSeqIndexForTests();
    vi.clearAllMocks();
    createIdMock.mockReturnValue('mock-id');
  });

  it('returns empty list when no tools have been dispatched', () => {
    const acc = new LazyContextAccumulator('turn-1');
    expect(acc.getExecutedToolCalls()).toHaveLength(0);
    expect(acc.hasPossiblyMutatingToolCall()).toBe(false);
  });

  it('records tool_use_start events into the side-table', () => {
    const acc = new LazyContextAccumulator('turn-1');
    acc.appendEvent(toolStart('Read', 'toolu_1'));
    acc.appendEvent(toolStart('Write', 'toolu_2'));
    const records = acc.getExecutedToolCalls();
    expect(records).toHaveLength(2);
    expect(records[0]?.toolName).toBe('Read');
    expect(records[0]?.toolUseId).toBe('toolu_1');
    expect(records[1]?.toolName).toBe('Write');
  });

  it('ignores tool_use_end events for the side-table', () => {
    const acc = new LazyContextAccumulator('turn-1');
    acc.appendEvent(toolStart('Read', 'toolu_1'));
    acc.appendEvent(toolEnd('toolu_1'));
    // Only one record (start), not two.
    expect(acc.getExecutedToolCalls()).toHaveLength(1);
  });

  it('populates built-in annotations for known read-only tools', () => {
    const acc = new LazyContextAccumulator('turn-1');
    acc.appendEvent(toolStart('Read', 'toolu_1'));
    acc.appendEvent(toolStart('Grep', 'toolu_2'));
    acc.appendEvent(toolStart('WebFetch', 'toolu_3'));
    const records = acc.getExecutedToolCalls();
    expect(records[0]?.annotations['readOnlyHint']).toBe(true);
    expect(records[1]?.annotations['readOnlyHint']).toBe(true);
    expect(records[2]?.annotations['readOnlyHint']).toBe(true);
  });

  it('populates built-in annotations for known destructive tools', () => {
    const acc = new LazyContextAccumulator('turn-1');
    acc.appendEvent(toolStart('Write', 'toolu_1'));
    acc.appendEvent(toolStart('Bash', 'toolu_2'));
    acc.appendEvent(toolStart('Edit', 'toolu_3'));
    const records = acc.getExecutedToolCalls();
    expect(records[0]?.annotations['destructiveHint']).toBe(true);
    expect(records[1]?.annotations['destructiveHint']).toBe(true);
    expect(records[2]?.annotations['destructiveHint']).toBe(true);
  });

  it('leaves annotations empty for unknown (MCP) tools', () => {
    const acc = new LazyContextAccumulator('turn-1');
    acc.appendEvent(toolStart('Linear__create_attachment', 'toolu_mcp'));
    const records = acc.getExecutedToolCalls();
    expect(records[0]?.annotations).toEqual({});
  });

  it('hasPossiblyMutatingToolCall returns false when all tools are read-only', () => {
    const acc = new LazyContextAccumulator('turn-1');
    acc.appendEvent(toolStart('Read', 'toolu_1'));
    acc.appendEvent(toolStart('Grep', 'toolu_2'));
    acc.appendEvent(toolStart('WebSearch', 'toolu_3'));
    expect(acc.hasPossiblyMutatingToolCall()).toBe(false);
  });

  it('hasPossiblyMutatingToolCall returns true when a destructive tool ran', () => {
    const acc = new LazyContextAccumulator('turn-1');
    acc.appendEvent(toolStart('Read', 'toolu_1'));
    acc.appendEvent(toolStart('Write', 'toolu_2'));
    expect(acc.hasPossiblyMutatingToolCall()).toBe(true);
  });

  it('hasPossiblyMutatingToolCall returns true for unknown MCP tools (conservative)', () => {
    const acc = new LazyContextAccumulator('turn-1');
    acc.appendEvent(toolStart('Linear__create_issue', 'toolu_mcp'));
    expect(acc.hasPossiblyMutatingToolCall()).toBe(true);
  });

  it('recordExecutedToolAnnotations enriches later when annotations become available', () => {
    const acc = new LazyContextAccumulator('turn-1');
    acc.appendEvent(toolStart('Linear__list_projects', 'toolu_mcp'));
    // Initially unknown → conservative mutating
    expect(acc.hasPossiblyMutatingToolCall()).toBe(true);
    // Enrich with MCP-returned annotations
    acc.recordExecutedToolAnnotations('toolu_mcp', { readOnlyHint: true });
    // Now correctly classified as read-only
    expect(acc.hasPossiblyMutatingToolCall()).toBe(false);
  });

  it('recordExecutedToolAnnotations is a no-op for unknown toolUseId', () => {
    const acc = new LazyContextAccumulator('turn-1');
    acc.appendEvent(toolStart('Read', 'toolu_1'));
    acc.recordExecutedToolAnnotations('toolu_unknown', { readOnlyHint: false });
    // Should not crash, should not affect the existing record
    expect(acc.getExecutedToolCalls()).toHaveLength(1);
    expect(acc.getExecutedToolCalls()[0]?.annotations['readOnlyHint']).toBe(true);
  });

  it('preserves existing annotations when enriching — does not overwrite built-ins', () => {
    const acc = new LazyContextAccumulator('turn-1');
    acc.appendEvent(toolStart('Write', 'toolu_1'));
    // Write is built-in destructive; enrichment should merge, not replace
    acc.recordExecutedToolAnnotations('toolu_1', { idempotentHint: false });
    const rec = acc.getExecutedToolCalls()[0];
    expect(rec?.annotations['destructiveHint']).toBe(true);
    expect(rec?.annotations['idempotentHint']).toBe(false);
  });

  it('does not affect existing conversation shape derivation', () => {
    const acc = new LazyContextAccumulator('turn-1');
    acc.appendEvent(toolStart('Read', 'toolu_1'));
    acc.appendEvent(toolEnd('toolu_1'));
    // Existing behavior: shape derivation still works
    const shape = acc.getConversationShape();
    expect(shape.activeTurnId).toBe('turn-1');
  });

  it('shares monotonic seq allocation across turns in the same session', () => {
    const firstTurn = new LazyContextAccumulator('turn-1', 'session-1');
    const secondTurn = new LazyContextAccumulator('turn-2', 'session-1');

    const first = firstTurn.appendEvent({ type: 'status', message: 'a', timestamp: 1_000 } as AgentEvent);
    const second = secondTurn.appendEvent({ type: 'status', message: 'b', timestamp: 2_000 } as AgentEvent);

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
  });

  it('re-stamps invalid seq values and emits an observable warning', () => {
    const acc = new LazyContextAccumulator('turn-invalid', 'session-invalid');
    const stamped = acc.stampSeq(
      { type: 'status', message: 'invalid', timestamp: 3_000, seq: Number.NaN } as AgentEvent,
      'session-invalid',
    );

    expect(Number.isInteger(stamped.seq) && Number(stamped.seq) > 0).toBe(true);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: 'turn-invalid',
        sessionId: 'session-invalid',
        eventType: 'status',
      }),
      'Encountered invalid event seq; re-stamping with next monotonic seq',
    );
  });
});

describe('LazyContextAccumulator — conversation-shape parity', () => {
  beforeEach(() => {
    resetSessionSeqIndexForTests();
    vi.clearAllMocks();
    createIdMock.mockReturnValue('mock-id');
  });

  it('creates a question-pause result quip when empty result follows user_question', () => {
    const turnId = 'turn-question-pause';
    const acc = new LazyContextAccumulator(turnId);
    acc.appendEvent(userQuestion(100));
    // NB: deliberately NO `turnEndReason: 'awaiting_user'`. That reason would
    // satisfy the question-pause branch on its own (conversationState.ts:221),
    // masking a regression in the result-step prefix injection. With it omitted,
    // the quip can fire ONLY via `turnEvents.some(type === 'user_question')`
    // (conversationState.ts:222) — i.e. only if getConversationShape feeds the
    // real prior-event prefix on the terminal `result` step. This is the test
    // that actually guards that injection (plan F1).
    acc.appendEvent(result('', 101));

    const shape = acc.getConversationShape();
    const finalMessage = shape.messages[shape.messages.length - 1];
    expect(finalMessage).toMatchObject({
      turnId,
      role: 'result',
      text: pickQuestionPauseQuip(turnId),
    });
  });

  it('creates interrupted result text for synthetic superseded empty result after prior activity', () => {
    const turnId = 'turn-superseded';
    const acc = new LazyContextAccumulator(turnId);
    acc.appendEvent(status('Working', 200));
    acc.appendEvent(toolStart('Read', 'toolu-superseded', 201));
    acc.appendEvent(assistant('   ', 202));
    acc.appendEvent(result('', 203, { turnEndReason: 'superseded', isSynthetic: true }));

    const shape = acc.getConversationShape();
    const finalMessage = shape.messages[shape.messages.length - 1];
    expect(finalMessage).toMatchObject({
      turnId,
      role: 'result',
      text: 'Interrupted before I could finish.',
      endedWith: 'superseded',
    });
  });

  it('preserves tier-3 transient error anchoring on classified follow-on error', () => {
    const turnId = 'turn-tier3';
    const acc = new LazyContextAccumulator(turnId);
    const substantiveAssistantText = 'Found three concrete constraints and mapped two viable options.';

    acc.appendEvent(assistant(substantiveAssistantText, 300));
    acc.appendEvent(toolStart('Read', 'toolu-tier3', 301));
    acc.appendEvent(errorEvent('Provider returned error', 302));
    acc.appendEvent(
      errorEvent('Rate limit hit', 303, {
        isTransient: true,
        errorKind: 'rate_limit',
      }),
    );

    const shape = acc.getConversationShape();
    expect(shape.messages).toHaveLength(1);
    expect(shape.messages[0]).toMatchObject({
      turnId,
      role: 'result',
      text: substantiveAssistantText,
      endedWith: 'transient_error',
    });
  });

  it('handles tool-start thinking prune and late assistant after result', () => {
    const turnId = 'turn-late-assistant';
    const acc = new LazyContextAccumulator(turnId);
    acc.appendEvent(assistant('Let me check that quickly.', 400));
    acc.appendEvent(toolStart('Read', 'toolu-prune', 401));

    const afterPrune = acc.getConversationShape();
    expect(afterPrune.messages).toHaveLength(0);

    acc.appendEvent(result('Primary answer', 402));
    acc.appendEvent(assistant('Additional details.', 403));
    const finalShape = acc.getConversationShape();
    expect(finalShape.messages).toHaveLength(1);
    expect(finalShape.messages[0]).toMatchObject({
      turnId,
      role: 'result',
      text: 'Primary answer\n\nAdditional details.',
    });
  });

  it('keeps eventsByTurn as an empty object when there are zero events', () => {
    const acc = new LazyContextAccumulator('turn-empty');
    const shape = acc.getConversationShape();
    expect(shape.eventsByTurn).toEqual({});
  });

  // Stage 2 chokepoint: appendEvent must NOT store thinking_delta (manifest
  // persistence.mainAccumulator:false). This is the by-construction guarantee
  // every accumulator-based persistence path inherits (dispatcher, headless/CLI
  // runner). It still consumes a seq so gaps stay legitimate.
  it('does not accumulate or persist thinking_delta, but still consumes a seq', () => {
    const turnId = 'turn-thinking-skip';
    const acc = new LazyContextAccumulator(turnId);
    acc.appendEvent(thinkingDelta('reasoning chunk 1', 700));
    acc.appendEvent(thinkingDelta('reasoning chunk 2', 701));
    const tool = acc.appendEvent(toolStart('Read', 'toolu-skip', 702));
    acc.appendEvent(result('Done', 703));

    // thinking_delta is never stored: getEventCount counts only real events,
    // and the derived shape's eventsByTurn excludes thinking_delta.
    expect(acc.getEventCount()).toBe(2); // tool + result only
    const shape = acc.getConversationShape();
    const persisted = shape.eventsByTurn[turnId] ?? [];
    expect(persisted.some((e) => e.type === 'thinking_delta')).toBe(false);
    expect(persisted.map((e) => e.type)).toEqual(['tool', 'result']);
    // but seq was consumed for the two thinking deltas (legitimate gap): tool is seq 3.
    expect(tool.seq).toBe(3);
  });

  it('matches replayFromScratch at several mid-stream checkpoints', () => {
    const turnId = 'turn-parity';
    const acc = new LazyContextAccumulator(turnId);
    const appliedEvents: AgentEvent[] = [];
    const stream: AgentEvent[] = [
      status('starting', 500),
      assistantDelta('drafting', 501),
      thinkingDelta('reasoning', 502),
      assistant('Interim answer draft.', 503),
      toolStart('Read', 'toolu-parity-1', 504),
      toolEnd('toolu-parity-1', 505),
      assistantDelta('more draft', 506),
      assistant('Final answer ready.', 507),
      result('', 508),
    ];
    const checkpointIndexes = new Set([1, 4, 6, 9]);

    stream.forEach((event, index) => {
      const stamped = acc.appendEvent(event);
      appliedEvents.push(stamped);
      const oneBasedIndex = index + 1;
      if (checkpointIndexes.has(oneBasedIndex)) {
        const expected = replayConversationShapeFromScratch(turnId, appliedEvents);
        const actual = acc.getConversationShape();
        expect(actual).toEqual(expected);
      }
    });
  });

  // Scope note (plan F3): this guards the *defensively-copied* surfaces — the
  // top-level `eventsByTurn` array and the cloned `terminatedTurnIds` Set —
  // against a consumer mutating the returned snapshot and poisoning a later
  // derivation. It does NOT (and cannot, without deep cloning) protect the
  // shared `AgentEvent`/message *objects*; those remain shared with `this.events`,
  // exactly as in the pre-change full-replay path. Re-derivation safety here
  // comes from `appendEvent` rebuilding from `this.events`, not from clone depth.
  it('does not let external mutation of the copied surfaces corrupt future derivations after append invalidation', () => {
    const turnId = 'turn-mutation';
    const acc = new LazyContextAccumulator(turnId);
    const appliedEvents: AgentEvent[] = [];
    appliedEvents.push(acc.appendEvent(status('processing', 600)));
    appliedEvents.push(acc.appendEvent(result('Done', 601)));

    const shape = acc.getConversationShape();
    shape.terminatedTurnIds.add('poison-turn');
    if (shape.eventsByTurn[turnId]) {
      shape.eventsByTurn[turnId].push(status('poison-event', 9999));
    }

    appliedEvents.push(acc.appendEvent(status('post-checkpoint', 602)));
    const expected = replayConversationShapeFromScratch(turnId, appliedEvents);
    const actual = acc.getConversationShape();

    expect(actual).toEqual(expected);
    expect(actual.terminatedTurnIds.has('poison-turn')).toBe(false);
    expect((actual.eventsByTurn[turnId] ?? []).some((event) => event.timestamp === 9999)).toBe(false);
  });
});
