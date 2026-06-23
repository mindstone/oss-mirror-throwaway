import { describe, it, expect } from 'vitest';
import { mapSummaryToConversation } from '../conversationMapper';
import type { AgentSessionSummary } from '@shared/ipc/schemas/sessions';

function makeSummary(overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary {
  return {
    id: 'session-1',
    title: 'Test Session',
    createdAt: 1000,
    updatedAt: 2000,
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    isCorrupted: false,
    privateMode: false,
    interruptedTurnId: null,
    preview: 'Hello world',
    firstMessagePreview: 'Hello world preview',
    lastMessagePreview: 'Last message',
    messageCount: 5,
    hasUserMessages: true,
    hasDraft: false,
    draftPreview: null,
    draftUpdatedAt: null,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    ...overrides,
  };
}

describe('mapSummaryToConversation', () => {
  it('maps all expected fields from AgentSessionSummary', () => {
    const summary = makeSummary({
      id: 'abc-123',
      title: 'My Chat',
      createdAt: 1000,
      updatedAt: 2000,
      isBusy: true,
      messageCount: 10,
      preview: 'Hello',
      doneAt: 1500,
      starredAt: 1600,
      origin: 'automation',
      deletedAt: null,
      resolvedAt: 3000,
    });

    const result = mapSummaryToConversation(summary);

    expect(result).toEqual({
      id: 'abc-123',
      title: 'My Chat',
      createdAt: 1000,
      updatedAt: 2000,
      isBusy: true,
      messageCount: 10,
      preview: 'Hello',
      doneAt: 1500,
      starredAt: 1600,
      origin: 'automation',
      deletedAt: null,
      resolvedAt: 3000,
    });
  });

  it('preserves null title', () => {
    const result = mapSummaryToConversation(makeSummary({ title: null }));
    expect(result.title).toBeNull();
  });

  it('includes deletedAt when session is soft-deleted', () => {
    const result = mapSummaryToConversation(makeSummary({ deletedAt: 5000 }));
    expect(result.deletedAt).toBe(5000);
  });

  it('includes resolvedAt when session is resolved', () => {
    const result = mapSummaryToConversation(makeSummary({ resolvedAt: 4000 }));
    expect(result.resolvedAt).toBe(4000);
  });

  it('does NOT expose internal fields like privateMode, isCorrupted, lastError', () => {
    const summary = makeSummary({ privateMode: true, isCorrupted: true, lastError: 'oops' });
    const result = mapSummaryToConversation(summary);

    expect(result).not.toHaveProperty('privateMode');
    expect(result).not.toHaveProperty('isCorrupted');
    expect(result).not.toHaveProperty('lastError');
    expect(result).not.toHaveProperty('activeTurnId');
    expect(result).not.toHaveProperty('usage');
    expect(result).not.toHaveProperty('hasDraft');
  });

  it('is a pure function — returns new object each call', () => {
    const summary = makeSummary();
    const a = mapSummaryToConversation(summary);
    const b = mapSummaryToConversation(summary);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});
