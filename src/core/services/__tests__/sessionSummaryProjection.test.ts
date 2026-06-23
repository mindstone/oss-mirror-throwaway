import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@shared/types';
import { createMessageSnippet, projectSessionSummaryFields } from '../sessionSummaryProjection';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'sess-1',
    title: 'Test session',
    createdAt: 1000,
    updatedAt: 2000,
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

describe('createMessageSnippet', () => {
  it('returns empty string for null/undefined', () => {
    expect(createMessageSnippet(null)).toBe('');
    expect(createMessageSnippet(undefined)).toBe('');
    expect(createMessageSnippet('')).toBe('');
  });

  it('returns whitespace-only text as empty', () => {
    expect(createMessageSnippet('   ')).toBe('');
  });

  it('returns short text unchanged', () => {
    expect(createMessageSnippet('Hello world')).toBe('Hello world');
  });

  it('truncates text longer than maxLength with ellipsis', () => {
    const long = 'a'.repeat(100);
    const result = createMessageSnippet(long, 10);
    expect(result.length).toBeLessThanOrEqual(12); // 10 + ellipsis
    expect(result).toContain('\u2026');
  });

  it('collapses whitespace', () => {
    expect(createMessageSnippet('hello   world\nnewline')).toBe('hello world newline');
  });
});

describe('projectSessionSummaryFields', () => {
  it('returns correct fields for a full session', () => {
    const session = makeSession({
      messages: [
        { id: 'm1', turnId: 't1', role: 'user', text: 'Hello', createdAt: 1000, isHidden: false },
        { id: 'm2', turnId: 't1', role: 'assistant', text: 'Hi there', createdAt: 1001, isHidden: false },
      ],
      eventsByTurn: {
        't1': [
          { type: 'result', text: 'done', timestamp: 1001, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.01 } },
        ],
      },
    });

    const result = projectSessionSummaryFields(session);

    expect(result.messageCount).toBe(2);
    expect(result.preview).toBe('Hi there');
    expect(result.firstMessagePreview).toBe('Hello');
    expect(result.hasUserMessages).toBe(true);
    expect(result.hasDraft).toBe(false);
    expect(result.hasAnnotations).toBe(false);
    expect(result.draftPreview).toBeNull();
    expect(result.usage).toBeDefined();
    expect(typeof result.usage.costUsd).toBe('number');
    expect(typeof result.usage.inputTokens).toBe('number');
    expect(typeof result.usage.outputTokens).toBe('number');
    expect(typeof result.usage.turnCount).toBe('number');
  });

  it('returns empty previews for session with no messages', () => {
    const session = makeSession({ messages: [] });
    const result = projectSessionSummaryFields(session);

    expect(result.messageCount).toBe(0);
    expect(result.preview).toBe('');
    expect(result.firstMessagePreview).toBe('');
    expect(result.hasUserMessages).toBe(false);
  });

  it('includes draft metadata when draft exists', () => {
    const session = makeSession({
      draft: { text: 'Work in progress', updatedAt: 5000 },
    });

    const result = projectSessionSummaryFields(session);

    expect(result.hasDraft).toBe(true);
    expect(result.draftPreview).toBe('Work in progress');
    expect(result.draftUpdatedAt).toBe(5000);
  });

  it('includes annotation presence metadata when annotations exist', () => {
    const session = makeSession({
      annotations: [{
        id: 'ann-1',
        messageId: 'msg-1',
        text: 'selected text',
        comment: 'remember this',
        createdAt: 5000,
        startOffset: 0,
        endOffset: 13,
      }],
    });

    const result = projectSessionSummaryFields(session);

    expect(result.hasAnnotations).toBe(true);
  });

  it('includes meeting companion when present', () => {
    const session = makeSession({
      meetingCompanion: {
        meetingUrl: 'https://zoom.us/j/123',
        botId: 'bot-123',
        meetingTitle: 'Test Meeting',
        startedAt: 1000,
      },
    });

    const result = projectSessionSummaryFields(session);

    expect(result.meetingCompanion).toEqual({
      meetingUrl: 'https://zoom.us/j/123',
      botId: 'bot-123',
      startedAt: 1000,
    });
  });

  it('omits meeting companion when not present', () => {
    const session = makeSession({});
    const result = projectSessionSummaryFields(session);

    expect(result.meetingCompanion).toBeUndefined();
  });
});
