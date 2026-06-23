/**
 * Unit tests for conversationContextService pure functions.
 *
 * Tests cover:
 * - parseConversationSearchKeyword: keyword detection and prompt sanitization
 * - extractBookendExcerpt: conversation excerpt extraction with bookend strategy
 * - formatAutoConversationContext: auto-injected conversation formatting
 * - formatConversationContextForPrompt: explicit @conversations formatting
 * - AUTO_CONVERSATION_THRESHOLD: exported constant value
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

// Mock transitive dependencies that pull in Electron

vi.mock('../conversationIndexService', () => ({
  searchConversations: vi.fn(),
}));

vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(),
}));

import {
  parseConversationSearchKeyword,
  extractBookendExcerpt,
  formatAutoConversationContext,
  formatConversationContextForPrompt,
  loadFilterAndFormatConversations,
  AUTO_CONVERSATION_THRESHOLD,
  HIGH_CONFIDENCE_CONVERSATION_THRESHOLD,
  MAX_AUTO_CONVERSATION_CHARS,
  MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION,
  MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION_HIGH,
  type AutoConversationContextResult,
  type ConversationContextResult,
} from '../conversationContextService';
import type { AgentSession, AgentTurnMessage } from '@shared/types';
import { getIncrementalSessionStore } from '../incrementalSessionStore';

// Helper to create test messages
function createMessage(
  overrides: Partial<AgentTurnMessage> & Pick<AgentTurnMessage, 'role' | 'text'>
): AgentTurnMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    isHidden: false,
    ...overrides,
  } as AgentTurnMessage;
}

function createSession(id: string, title: string, textLength: number): AgentSession {
  const longText = 'x'.repeat(textLength);

  return {
    id,
    title,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [
      createMessage({ id: `${id}-user`, role: 'user', text: longText }),
      createMessage({ id: `${id}-assistant`, role: 'assistant', text: longText }),
    ],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
  };
}

// ─── parseConversationSearchKeyword ─────────────────────────────────────────

describe('parseConversationSearchKeyword', () => {
  describe('valid keyword detection', () => {
    it('detects @conversations at start of message', () => {
      const result = parseConversationSearchKeyword('@conversations find the pricing discussion');
      expect(result.hasConversationSearch).toBe(true);
      expect(result.matchedKeyword).toBe('@conversations');
      expect(result.sanitizedPrompt).toBe('find the pricing discussion');
    });

    it('detects @conversations mid-message', () => {
      const result = parseConversationSearchKeyword('please @conversations for meeting notes');
      expect(result.hasConversationSearch).toBe(true);
      expect(result.matchedKeyword).toBe('@conversations');
      expect(result.sanitizedPrompt).toBe('please for meeting notes');
    });

    it('detects keyword with trailing comma', () => {
      const result = parseConversationSearchKeyword('@conversations, what about pricing?');
      expect(result.hasConversationSearch).toBe(true);
      expect(result.sanitizedPrompt).toBe('what about pricing?');
    });

    it('detects keyword with trailing period', () => {
      const result = parseConversationSearchKeyword('Search @conversations. Find pricing.');
      expect(result.hasConversationSearch).toBe(true);
    });

    it('is case-insensitive', () => {
      expect(parseConversationSearchKeyword('@CONVERSATIONS find stuff').hasConversationSearch).toBe(true);
      expect(parseConversationSearchKeyword('@Conversations search').hasConversationSearch).toBe(true);
    });

    it('detects keyword with newline after it', () => {
      const result = parseConversationSearchKeyword('@conversations\nFind the document');
      expect(result.hasConversationSearch).toBe(true);
    });

    it('handles keyword-only message', () => {
      const result = parseConversationSearchKeyword('@conversations');
      expect(result.hasConversationSearch).toBe(true);
      expect(result.sanitizedPrompt).toBe('');
    });
  });

  describe('false positive prevention', () => {
    it('does not match @conversations-extended', () => {
      const result = parseConversationSearchKeyword('use @conversations-extended mode');
      expect(result.hasConversationSearch).toBe(false);
    });

    it('does not match @conversational', () => {
      const result = parseConversationSearchKeyword('check the @conversational tone');
      expect(result.hasConversationSearch).toBe(false);
    });

    it('does not match partial keyword @convo', () => {
      const result = parseConversationSearchKeyword('@convo find the notes');
      expect(result.hasConversationSearch).toBe(false);
    });

    it('does not match email-like patterns', () => {
      const result = parseConversationSearchKeyword('sent to [external-email]');
      expect(result.hasConversationSearch).toBe(false);
    });
  });

  describe('sanitized prompt', () => {
    it('normalizes multiple spaces after keyword removal', () => {
      const result = parseConversationSearchKeyword('@conversations   find   the   discussion');
      expect(result.sanitizedPrompt).not.toContain('  ');
    });

    it('trims whitespace', () => {
      const result = parseConversationSearchKeyword('  @conversations find stuff  ');
      expect(result.sanitizedPrompt).toBe('find stuff');
    });

    it('returns original prompt when no keyword present', () => {
      const result = parseConversationSearchKeyword('just a normal question');
      expect(result.hasConversationSearch).toBe(false);
      expect(result.sanitizedPrompt).toBe('just a normal question');
    });

    it('handles empty string', () => {
      const result = parseConversationSearchKeyword('');
      expect(result.hasConversationSearch).toBe(false);
      expect(result.sanitizedPrompt).toBe('');
    });
  });
});

// ─── extractBookendExcerpt ──────────────────────────────────────────────────

describe('extractBookendExcerpt', () => {
  it('returns empty excerpt for no messages', () => {
    const { excerpt, messageRange } = extractBookendExcerpt([], 5000);
    expect(excerpt).toBe('');
    expect(messageRange).toBe('no messages');
  });

  it('returns empty excerpt when all messages are hidden', () => {
    const messages = [
      createMessage({ role: 'user', text: 'Hello', isHidden: true }),
      createMessage({ role: 'assistant', text: 'Hi there', isHidden: true }),
    ];
    const { excerpt } = extractBookendExcerpt(messages, 5000);
    expect(excerpt).toBe('');
  });

  it('returns all messages for short conversations (<= 5 relevant messages)', () => {
    const messages = [
      createMessage({ role: 'user', text: 'What is pricing?' }),
      createMessage({ role: 'assistant', text: 'Our pricing starts at $10/month.' }),
      createMessage({ role: 'user', text: 'Any discounts?' }),
      createMessage({ role: 'result', text: 'Yes, annual plans get 20% off.' }),
    ];
    const { excerpt, messageRange } = extractBookendExcerpt(messages, 5000);
    expect(excerpt).toContain('**User:** What is pricing?');
    expect(excerpt).toContain('**Assistant:** Our pricing starts at $10/month.');
    expect(excerpt).toContain('**User:** Any discounts?');
    expect(excerpt).toContain('**Assistant:** Yes, annual plans get 20% off.');
    expect(messageRange).toBe('messages 1-4');
  });

  it('uses bookend strategy for long conversations (first 4 + last assistant)', () => {
    const messages = [
      createMessage({ id: 'm1', role: 'user', text: 'First user message' }),
      createMessage({ id: 'm2', role: 'assistant', text: 'First assistant response' }),
      createMessage({ id: 'm3', role: 'user', text: 'Second user message' }),
      createMessage({ id: 'm4', role: 'assistant', text: 'Second assistant response' }),
      createMessage({ id: 'm5', role: 'user', text: 'Third user message' }),
      createMessage({ id: 'm6', role: 'assistant', text: 'Third assistant response' }),
      createMessage({ id: 'm7', role: 'user', text: 'Fourth user message' }),
      createMessage({ id: 'm8', role: 'result', text: 'Final result message' }),
    ];
    const { excerpt, messageRange } = extractBookendExcerpt(messages, 5000);
    // Should include first 4 messages
    expect(excerpt).toContain('First user message');
    expect(excerpt).toContain('First assistant response');
    expect(excerpt).toContain('Second user message');
    expect(excerpt).toContain('Second assistant response');
    // Should include last assistant/result message
    expect(excerpt).toContain('Final result message');
    // Should include ellipsis indicator for gap
    expect(excerpt).toContain('[...]');
    // Should show range like "messages 1-4, 8"
    expect(messageRange).toMatch(/messages 1-4, \d+/);
  });

  it('truncates to maxChars limit', () => {
    const longText = 'A'.repeat(1000);
    const messages = [
      createMessage({ role: 'user', text: longText }),
      createMessage({ role: 'assistant', text: longText }),
    ];
    const { excerpt } = extractBookendExcerpt(messages, 200);
    expect(excerpt.length).toBeLessThanOrEqual(200);
  });

  it('filters out system messages', () => {
    const messages = [
      createMessage({ role: 'system' as AgentTurnMessage['role'], text: 'System prompt' }),
      createMessage({ role: 'user', text: 'Hello' }),
      createMessage({ role: 'assistant', text: 'Hi' }),
    ];
    const { excerpt } = extractBookendExcerpt(messages, 5000);
    expect(excerpt).not.toContain('System prompt');
    expect(excerpt).toContain('Hello');
  });

  it('maps result role to Assistant label', () => {
    const messages = [
      createMessage({ role: 'user', text: 'Question' }),
      createMessage({ role: 'result', text: 'Final answer' }),
    ];
    const { excerpt } = extractBookendExcerpt(messages, 5000);
    expect(excerpt).toContain('**Assistant:** Final answer');
  });
});

// ─── formatAutoConversationContext ──────────────────────────────────────────

describe('formatAutoConversationContext', () => {
  it('returns empty string for empty array', () => {
    expect(formatAutoConversationContext([])).toBe('');
  });

  it('formats single conversation correctly', () => {
    const conversations: AutoConversationContextResult[] = [
      {
        sessionId: 'abc123',
        title: 'Pricing Analysis Q1',
        score: 0.85,
        excerpt: '**User:** Can you analyze Q1 pricing?\n\n**Assistant:** Based on the data...',
        messageRange: 'messages 1-4, 12',
        totalMessages: 12,
      },
    ];
    const result = formatAutoConversationContext(conversations);

    expect(result).toContain('other past conversations');
    expect(result).toContain('separate threads, not continuations');
    expect(result).toContain('rebel://conversation/abc123');
    expect(result).toContain('Pricing Analysis Q1');
    expect(result).toContain('Past conversation — [Pricing Analysis Q1](rebel://conversation/abc123) (separate thread from the current one)');
    expect(result).toContain('messages 1-4, 12 of 12');
    expect(result).toContain('Can you analyze Q1 pricing?');
  });

  it('formats multiple conversations with separators', () => {
    const conversations: AutoConversationContextResult[] = [
      {
        sessionId: 'abc123',
        title: 'First Discussion',
        score: 0.90,
        excerpt: '**User:** First question',
        messageRange: 'messages 1-2',
        totalMessages: 2,
      },
      {
        sessionId: 'def456',
        title: 'Second Discussion',
        score: 0.80,
        excerpt: '**User:** Second question',
        messageRange: 'messages 1-3',
        totalMessages: 3,
      },
    ];
    const result = formatAutoConversationContext(conversations);

    expect(result).toContain('### Past conversation — [First Discussion](rebel://conversation/abc123) (separate thread from the current one)');
    expect(result).toContain('### Past conversation — [Second Discussion](rebel://conversation/def456) (separate thread from the current one)');
    expect(result).toContain('---');
  });

  it('uses scoped framing for auto-injected conversations while allowing relevant reference', () => {
    const result = formatAutoConversationContext([
      {
        sessionId: 'id-1',
        title: 'Background Thread',
        score: 0.78,
        excerpt: '**User:** Earlier thread',
        messageRange: 'messages 1-2',
        totalMessages: 2,
      },
    ]);

    // Preamble must establish "other/past" scope and "separate thread" boundary
    expect(result).toContain('other past conversations');
    expect(result).toContain('separate threads, not continuations');
    // Preamble must permit (not prohibit) legitimate cross-conversation reference
    expect(result).toContain('genuinely relevant');
    expect(result).toContain('make it clear when you are referencing a past thread');
    // Preamble must provide an ignore escape hatch
    expect(result).toContain('simply ignore them');
    // Per-section headers carry the scoping label
    expect(result).toContain('separate thread from the current one');
  });

  it('escapes special markdown characters in title', () => {
    const conversations: AutoConversationContextResult[] = [
      {
        sessionId: 'id1',
        title: 'Title with [brackets] and (parens)',
        score: 0.75,
        excerpt: '**User:** Test',
        messageRange: 'messages 1-1',
        totalMessages: 1,
      },
    ];
    const result = formatAutoConversationContext(conversations);

    expect(result).toContain('\\[brackets\\]');
    expect(result).toContain('\\(parens\\)');
  });

  it('escapes backslashes in title', () => {
    const conversations: AutoConversationContextResult[] = [
      {
        sessionId: 'id1',
        title: 'Path\\to\\file',
        score: 0.75,
        excerpt: '**User:** Test',
        messageRange: 'messages 1-1',
        totalMessages: 1,
      },
    ];
    const result = formatAutoConversationContext(conversations);

    expect(result).toContain('Path\\\\to\\\\file');
  });

  it('replaces newlines in title with spaces', () => {
    const conversations: AutoConversationContextResult[] = [
      {
        sessionId: 'id1',
        title: 'Title with\nnewline',
        score: 0.75,
        excerpt: '**User:** Test',
        messageRange: 'messages 1-1',
        totalMessages: 1,
      },
    ];
    const result = formatAutoConversationContext(conversations);

    expect(result).not.toContain('Title with\nnewline');
    expect(result).toContain('Title with newline');
  });
});

// ─── formatConversationContextForPrompt ─────────────────────────────────────

describe('formatConversationContextForPrompt', () => {
  it('returns empty string for empty array', () => {
    expect(formatConversationContextForPrompt([])).toBe('');
  });

  it('uses different preamble than auto-inject format', () => {
    const conversations: ConversationContextResult[] = [
      {
        sessionId: 'abc123',
        title: 'Test Discussion',
        score: 0.5,
        excerpt: '**User:** Test',
        messageRange: 'messages 1-2',
        totalMessages: 2,
      },
    ];
    const result = formatConversationContextForPrompt(conversations);

    // Explicit format uses "may be relevant" preamble (not "Use them if helpful")
    expect(result).toContain('may be relevant to this request');
    expect(result).not.toContain('Use them if helpful');
    expect(result).toContain('rebel://conversation/abc123');
  });

  it('escapes markdown characters in title', () => {
    const conversations: ConversationContextResult[] = [
      {
        sessionId: 'id1',
        title: '[Title] with (special) chars',
        score: 0.5,
        excerpt: '**User:** Test',
        messageRange: 'messages 1-1',
        totalMessages: 1,
      },
    ];
    const result = formatConversationContextForPrompt(conversations);

    expect(result).toContain('\\[Title\\]');
    expect(result).toContain('\\(special\\)');
  });
});

// ─── loadFilterAndFormatConversations ───────────────────────────────────────

describe('loadFilterAndFormatConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockSessionStore(sessions: Record<string, AgentSession>) {
    const getSession = vi.fn(async (sessionId: string) => sessions[sessionId] ?? null);
    vi.mocked(getIncrementalSessionStore).mockReturnValue({
      getSession,
    } as unknown as ReturnType<typeof getIncrementalSessionStore>);
    return getSession;
  }

  it('uses larger per-conversation budget for high-confidence matches', async () => {
    const session = createSession('session-high', 'High Confidence Session', 9000);
    mockSessionStore({ 'session-high': session });
    const testLogger = { debug: vi.fn() };

    const high = await loadFilterAndFormatConversations(
      [{ sessionId: 'session-high', title: session.title, score: 0.85 }],
      undefined,
      testLogger,
    );

    const normal = await loadFilterAndFormatConversations(
      [{ sessionId: 'session-high', title: session.title, score: 0.72 }],
      undefined,
      testLogger,
    );

    expect(high).not.toBeNull();
    expect(normal).not.toBeNull();
    expect(high!.totalChars).toBeLessThanOrEqual(MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION_HIGH);
    expect(normal!.totalChars).toBeLessThanOrEqual(MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION);
    expect(high!.totalChars).toBeGreaterThan(normal!.totalChars);
  });

  it('respects total auto-conversation cap across candidates', async () => {
    const first = createSession('session-1', 'First Session', 9000);
    const second = createSession('session-2', 'Second Session', 9000);
    mockSessionStore({
      'session-1': first,
      'session-2': second,
    });
    const testLogger = { debug: vi.fn() };

    const result = await loadFilterAndFormatConversations(
      [
        { sessionId: 'session-1', title: first.title, score: 0.8 },
        { sessionId: 'session-2', title: second.title, score: 0.79 },
      ],
      undefined,
      testLogger,
    );

    expect(result).not.toBeNull();
    expect(result!.count).toBe(2);
    expect(result!.totalChars).toBeLessThanOrEqual(MAX_AUTO_CONVERSATION_CHARS);
    expect(result!.formattedContext).toContain('rebel://conversation/session-1');
    expect(result!.formattedContext).toContain('rebel://conversation/session-2');
  });
});

// ─── Constants ──────────────────────────────────────────────────────────────

describe('exported constants', () => {
  it('AUTO_CONVERSATION_THRESHOLD is 0.70', () => {
    expect(AUTO_CONVERSATION_THRESHOLD).toBe(0.70);
  });

  it('HIGH_CONFIDENCE_CONVERSATION_THRESHOLD is 0.80', () => {
    expect(HIGH_CONFIDENCE_CONVERSATION_THRESHOLD).toBe(0.80);
  });

  it('MAX_AUTO_CONVERSATION_CHARS is 8000', () => {
    expect(MAX_AUTO_CONVERSATION_CHARS).toBe(8000);
  });

  it('MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION is 3500', () => {
    expect(MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION).toBe(3500);
  });

  it('MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION_HIGH stays 5000', () => {
    expect(MAX_AUTO_CONVERSATION_CHARS_PER_CONVERSATION_HIGH).toBe(5000);
  });
});
