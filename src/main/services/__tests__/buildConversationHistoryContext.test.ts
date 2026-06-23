import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';

// Mock the incrementalSessionStore dependency (only dependency of conversationHistoryService)
vi.mock('../incrementalSessionStore', () => ({
  getIncrementalSessionStore: vi.fn(),
}));

import { buildConversationHistoryContext } from '../conversationHistoryService';
import type { AgentSession, AgentTurnMessage, CompactionBoundary } from '@shared/types';

function createMessage(
  overrides: Partial<AgentTurnMessage> & Pick<AgentTurnMessage, 'role' | 'text'>
): AgentTurnMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 8)}`,
    turnId: 'turn_1',
    createdAt: Date.now(),
    ...overrides,
  };
}

function createSession(messages: AgentTurnMessage[], boundaries?: CompactionBoundary[]): AgentSession {
  return {
    id: 'session_1',
    title: 'Test Session',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages,
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    origin: undefined as any,
    memoryUpdateStatusByTurn: {},
    timeSavedStatusByTurn: {},
    compactionBoundaries: boundaries ?? [],
    privateMode: false,
  };
}

describe('buildConversationHistoryContext', () => {
  it('returns empty string for empty session', () => {
    const session = createSession([]);
    expect(buildConversationHistoryContext(session)).toBe('');
  });

  it('returns empty string for single message', () => {
    const session = createSession([
      createMessage({ role: 'user', text: 'Hello' }),
    ]);
    expect(buildConversationHistoryContext(session)).toBe('');
  });

  it('includes result messages (mapped to [assistant] label)', () => {
    const session = createSession([
      createMessage({ role: 'user', text: 'Write a post', turnId: 'turn_1' }),
      createMessage({ role: 'result', text: 'Here is your post about AI', turnId: 'turn_1' }),
    ]);

    const result = buildConversationHistoryContext(session);
    expect(result).toContain('[user]: Write a post');
    expect(result).toContain('[assistant]: Here is your post about AI');
    expect(result).not.toContain('[result]');
  });

  it('includes both user and result messages across multiple turns', () => {
    const session = createSession([
      createMessage({ role: 'user', text: 'First question', turnId: 'turn_1' }),
      createMessage({ role: 'result', text: 'First answer', turnId: 'turn_1' }),
      createMessage({ role: 'user', text: 'Follow-up', turnId: 'turn_2' }),
      createMessage({ role: 'result', text: 'Follow-up answer', turnId: 'turn_2' }),
    ]);

    const result = buildConversationHistoryContext(session);
    expect(result).toContain('[user]: First question');
    expect(result).toContain('[assistant]: First answer');
    expect(result).toContain('[user]: Follow-up');
    expect(result).toContain('[assistant]: Follow-up answer');
  });

  it('includes assistant messages (in-progress turns not yet promoted to result)', () => {
    const session = createSession([
      createMessage({ role: 'user', text: 'Question', turnId: 'turn_1' }),
      createMessage({ role: 'assistant', text: 'Partial answer', turnId: 'turn_1' }),
    ]);

    const result = buildConversationHistoryContext(session);
    expect(result).toContain('[user]: Question');
    expect(result).toContain('[assistant]: Partial answer');
  });

  it('excludes isWarning messages from history context', () => {
    const session = createSession([
      createMessage({ role: 'user', text: 'Help me draft an email', turnId: 'turn_1' }),
      createMessage({ role: 'assistant', text: 'MCP tools unavailable', turnId: 'turn_warning', isWarning: true }),
      createMessage({ role: 'result', text: 'Here is your draft', turnId: 'turn_1' }),
    ]);

    const result = buildConversationHistoryContext(session);
    expect(result).toContain('[user]: Help me draft an email');
    expect(result).toContain('[assistant]: Here is your draft');
    expect(result).not.toContain('MCP tools unavailable');
  });

  it('excludes isHidden messages', () => {
    const session = createSession([
      createMessage({ role: 'user', text: 'Visible question', turnId: 'turn_1' }),
      createMessage({ role: 'user', text: 'Hidden system prompt', turnId: 'turn_2', isHidden: true }),
      createMessage({ role: 'result', text: 'Answer to visible', turnId: 'turn_1' }),
    ]);

    const result = buildConversationHistoryContext(session);
    expect(result).toContain('[user]: Visible question');
    expect(result).toContain('[assistant]: Answer to visible');
    expect(result).not.toContain('Hidden system prompt');
  });

  it('excludes messages with empty or whitespace-only text', () => {
    const session = createSession([
      createMessage({ role: 'user', text: 'Real question', turnId: 'turn_1' }),
      createMessage({ role: 'result', text: '', turnId: 'turn_1' }),
      createMessage({ role: 'result', text: '   ', turnId: 'turn_2' }),
      createMessage({ role: 'user', text: 'Another question', turnId: 'turn_3' }),
      createMessage({ role: 'result', text: 'Real answer', turnId: 'turn_3' }),
    ]);

    const result = buildConversationHistoryContext(session);
    expect(result).toContain('[user]: Real question');
    expect(result).toContain('[user]: Another question');
    expect(result).toContain('[assistant]: Real answer');
    // Exactly 3 message entries (empty/whitespace result messages excluded)
    expect((result.match(/\[user\]:/g) || []).length).toBe(2);
    expect((result.match(/\[assistant\]:/g) || []).length).toBe(1);
  });

  it('truncates from the front when over character budget', () => {
    const longText = 'A'.repeat(60_000);
    const session = createSession([
      createMessage({ role: 'user', text: longText, turnId: 'turn_1' }),
      createMessage({ role: 'result', text: longText, turnId: 'turn_1' }),
    ]);

    const result = buildConversationHistoryContext(session);
    expect(result).toContain('...(earlier messages truncated)...');
    expect(result.length).toBeLessThan(120_000 + 200); // MAX_CONVERSATION_HISTORY_CHARS + wrapper
  });

  it('wraps output in conversation_history tags', () => {
    const session = createSession([
      createMessage({ role: 'user', text: 'Hi', turnId: 'turn_1' }),
      createMessage({ role: 'result', text: 'Hello!', turnId: 'turn_1' }),
    ]);

    const result = buildConversationHistoryContext(session);
    expect(result).toContain('<conversation_history>');
    expect(result).toContain('</conversation_history>');
    expect(result).toContain('Continue from where we left off');
  });

  describe('compaction boundary awareness', () => {
    it('only includes post-boundary messages when compaction boundary exists', () => {
      const session = createSession(
        [
          createMessage({ role: 'user', text: 'Old question', turnId: 'turn_1' }),
          createMessage({ role: 'result', text: 'Old answer', turnId: 'turn_1' }),
          // Boundary at index 1 (after the old answer)
          createMessage({ role: 'user', text: '=== CONVERSATION SUMMARY ===\nSummary of old convo\n=== CONTINUE ===\nNew question', turnId: 'turn_2' }),
          createMessage({ role: 'result', text: 'New answer', turnId: 'turn_2' }),
        ],
        [{ afterMessageIndex: 1, summary: 'Summary of old convo', timestamp: Date.now(), depth: 1 }]
      );

      const result = buildConversationHistoryContext(session);
      expect(result).not.toContain('Old question');
      expect(result).not.toContain('Old answer');
      expect(result).toContain('CONVERSATION SUMMARY');
      expect(result).toContain('New answer');
    });

    it('uses the last (highest index) boundary when multiple exist', () => {
      const session = createSession(
        [
          createMessage({ role: 'user', text: 'Very old', turnId: 'turn_1' }),
          createMessage({ role: 'result', text: 'Very old answer', turnId: 'turn_1' }),
          // First boundary at index 1
          createMessage({ role: 'user', text: 'Medium old (enhanced prompt 1)', turnId: 'turn_2' }),
          createMessage({ role: 'result', text: 'Medium old answer', turnId: 'turn_2' }),
          // Second boundary at index 3
          createMessage({ role: 'user', text: 'Fresh enhanced prompt', turnId: 'turn_3' }),
          createMessage({ role: 'result', text: 'Fresh answer', turnId: 'turn_3' }),
        ],
        [
          { afterMessageIndex: 1, summary: 'First summary', timestamp: Date.now() - 1000, depth: 1 },
          { afterMessageIndex: 3, summary: 'Second summary', timestamp: Date.now(), depth: 2 },
        ]
      );

      const result = buildConversationHistoryContext(session);
      expect(result).not.toContain('Very old');
      expect(result).not.toContain('Medium old');
      expect(result).toContain('Fresh enhanced prompt');
      expect(result).toContain('Fresh answer');
    });

    it('returns empty string when boundary exists but no post-boundary messages', () => {
      const session = createSession(
        [
          createMessage({ role: 'user', text: 'Only message', turnId: 'turn_1' }),
          createMessage({ role: 'result', text: 'Only answer', turnId: 'turn_1' }),
        ],
        [{ afterMessageIndex: 1, summary: 'Summary', timestamp: Date.now(), depth: 1 }]
      );

      // Boundary is at index 1 (last message), so no post-boundary messages
      const result = buildConversationHistoryContext(session);
      expect(result).toBe('');
    });

    it('falls back to full messages when boundary index is negative', () => {
      const session = createSession(
        [
          createMessage({ role: 'user', text: 'Question', turnId: 'turn_1' }),
          createMessage({ role: 'result', text: 'Answer', turnId: 'turn_1' }),
        ],
        [{ afterMessageIndex: -1, summary: 'Bad boundary', timestamp: Date.now(), depth: 1 }]
      );

      const result = buildConversationHistoryContext(session);
      expect(result).toContain('Question');
      expect(result).toContain('[assistant]: Answer');
    });

    it('falls back to full messages when boundary index is out of bounds', () => {
      const session = createSession(
        [
          createMessage({ role: 'user', text: 'Question', turnId: 'turn_1' }),
          createMessage({ role: 'result', text: 'Answer', turnId: 'turn_1' }),
        ],
        [{ afterMessageIndex: 999, summary: 'Invalid boundary', timestamp: Date.now(), depth: 1 }]
      );

      const result = buildConversationHistoryContext(session);
      expect(result).toContain('Question');
      expect(result).toContain('[assistant]: Answer');
    });

    it('excludes hidden messages in post-boundary context', () => {
      const session = createSession(
        [
          createMessage({ role: 'user', text: 'Pre-compaction', turnId: 'turn_1' }),
          createMessage({ role: 'result', text: 'Pre answer', turnId: 'turn_1' }),
          // Boundary at index 1
          createMessage({ role: 'user', text: 'Hidden system prompt', turnId: 'turn_2', isHidden: true }),
          createMessage({ role: 'user', text: 'Visible enhanced prompt', turnId: 'turn_3' }),
          createMessage({ role: 'result', text: 'Post-compaction answer', turnId: 'turn_3' }),
        ],
        [{ afterMessageIndex: 1, summary: 'Summary', timestamp: Date.now(), depth: 1 }]
      );

      const result = buildConversationHistoryContext(session);
      expect(result).not.toContain('Pre-compaction');
      expect(result).not.toContain('Hidden system prompt');
      expect(result).toContain('Visible enhanced prompt');
      expect(result).toContain('Post-compaction answer');
    });

    it('includes only the enhanced prompt when it is the sole post-boundary message', () => {
      const session = createSession(
        [
          createMessage({ role: 'user', text: 'Old conversation', turnId: 'turn_1' }),
          createMessage({ role: 'result', text: 'Old response', turnId: 'turn_1' }),
          // Boundary at index 1, then only the enhanced prompt exists
          createMessage({ role: 'user', text: '[COMPACTION_DEPTH:1]\n=== SUMMARY ===\nPrior context\n=== CONTINUE ===\nNew request', turnId: 'turn_2' }),
          createMessage({ role: 'result', text: 'Response to compacted request', turnId: 'turn_2' }),
        ],
        [{ afterMessageIndex: 1, summary: 'Prior context', timestamp: Date.now(), depth: 1 }]
      );

      const result = buildConversationHistoryContext(session);
      expect(result).not.toContain('Old conversation');
      expect(result).not.toContain('Old response');
      expect(result).toContain('COMPACTION_DEPTH:1');
      expect(result).toContain('Response to compacted request');
    });
  });
});
