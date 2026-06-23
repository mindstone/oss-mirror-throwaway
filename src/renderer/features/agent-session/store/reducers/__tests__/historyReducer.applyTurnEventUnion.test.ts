import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { AgentSessionWithRuntime } from '../../../types';
import { createRuntimeState } from '../../../utils/runtimeState';
import { applyTurnEventUnion } from '../historyReducer';

const turnId = 'turn-restamp-renderer';

const makeAssistantEvent = (
  seq: number,
  text: string,
  timestamp: number,
): AgentEvent => ({
  type: 'assistant',
  seq,
  text,
  timestamp,
});

const makeResultEvent = (
  seq: number,
  text: string,
  timestamp: number,
): AgentEvent => ({
  type: 'result',
  seq,
  text,
  timestamp,
});

const makeSession = (events: AgentEvent[]): AgentSessionWithRuntime => ({
  id: 'session-restamp',
  title: 'Session',
  createdAt: 1_000,
  updatedAt: 1_000,
  messages: [
    {
      id: 'user-msg-1',
      turnId,
      role: 'user',
      text: 'hi',
      createdAt: 1_000,
    },
  ],
  eventsByTurn: { [turnId]: events },
  activeTurnId: turnId,
  isBusy: true,
  lastError: null,
  resolvedAt: null,
  origin: 'manual',
  runtime: createRuntimeState(),
  terminatedTurnIds: new Set<string>(),
});

describe('applyTurnEventUnion content-equivalence dedup', () => {
  it('treats a content-equivalent restamped assistant event as non-novel', () => {
    const original = makeAssistantEvent(75, 'duplicated answer', 9_999);
    const restamped = makeAssistantEvent(77, 'duplicated answer', 9_999);
    const empty = makeSession([]);

    const afterOriginal = applyTurnEventUnion(empty, turnId, [original]);
    expect(afterOriginal.eventsByTurn[turnId]).toEqual([original]);
    const assistantMessagesAfterOriginal = afterOriginal.messages.filter(
      (m) => m.role === 'assistant',
    );
    expect(assistantMessagesAfterOriginal).toHaveLength(1);

    const onContentEquivalentRestampCollapsed = vi.fn();
    const afterRestamp = applyTurnEventUnion(afterOriginal, turnId, [restamped], {
      onContentEquivalentRestampCollapsed,
    });

    expect(afterRestamp.eventsByTurn[turnId]).toEqual([original]);
    const assistantMessages = afterRestamp.messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0].text).toBe('duplicated answer');
    expect(onContentEquivalentRestampCollapsed).toHaveBeenCalledWith({
      turnId,
      droppedSeq: 77,
      retainedSeq: 75,
    });
  });

  it('treats a content-equivalent restamped result event as non-novel', () => {
    const assistant = makeAssistantEvent(75, 'duplicated answer', 9_999);
    const originalResult = makeResultEvent(76, 'duplicated answer', 10_000);
    const restampedResult = makeResultEvent(78, 'duplicated answer', 10_000);
    const empty = makeSession([]);

    const afterAssistantAndResult = applyTurnEventUnion(empty, turnId, [
      assistant,
      originalResult,
    ]);
    expect(afterAssistantAndResult.eventsByTurn[turnId]).toEqual([
      assistant,
      originalResult,
    ]);
    const baseMessageTextSet = new Set(
      afterAssistantAndResult.messages.map((m) => m.text ?? ''),
    );

    const onContentEquivalentRestampCollapsed = vi.fn();
    const afterRestamp = applyTurnEventUnion(
      afterAssistantAndResult,
      turnId,
      [restampedResult],
      { onContentEquivalentRestampCollapsed },
    );

    expect(afterRestamp.eventsByTurn[turnId]).toEqual([
      assistant,
      originalResult,
    ]);
    // No new messages introduced by the restamped result, and no message
    // text got concatenated/duplicated as a side effect of re-applying.
    expect(afterRestamp.messages).toHaveLength(
      afterAssistantAndResult.messages.length,
    );
    for (const message of afterRestamp.messages) {
      expect(baseMessageTextSet.has(message.text ?? '')).toBe(true);
      expect((message.text ?? '').includes('duplicated answerduplicated answer')).toBe(
        false,
      );
      expect(
        (message.text ?? '').includes('duplicated answer\n\nduplicated answer'),
      ).toBe(false);
    }
    expect(onContentEquivalentRestampCollapsed).toHaveBeenCalledWith({
      turnId,
      droppedSeq: 78,
      retainedSeq: 76,
    });
  });
});
