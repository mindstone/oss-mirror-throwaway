import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentSession, AgentTurnMessage } from '@shared/types';
import {
  prepareEligibleMessages,
  buildConversationHistoryContext,
  loadIntelligentConversationHistory,
  type LoadIntelligentConversationHistoryDeps,
} from '../conversationHistoryService';

function makeMessage(overrides: Partial<AgentTurnMessage> & { role: AgentTurnMessage['role']; text: string }): AgentTurnMessage {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    turnId: 'turn-1',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeSession(messages: AgentTurnMessage[], compactionBoundaries?: AgentSession['compactionBoundaries']): AgentSession {
  return {
    id: 'test-session',
    title: 'Test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages,
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...(compactionBoundaries ? { compactionBoundaries } : {}),
  } as unknown as AgentSession;
}

describe('prepareEligibleMessages', () => {
  it('returns empty for sessions with 0 or 1 messages', () => {
    expect(prepareEligibleMessages(makeSession([]))).toEqual([]);
    expect(prepareEligibleMessages(makeSession([
      makeMessage({ role: 'user', text: 'Hello' }),
    ]))).toEqual([]);
  });

  it('filters out hidden messages', () => {
    const msgs = [
      makeMessage({ role: 'user', text: 'Hello' }),
      makeMessage({ role: 'assistant', text: 'hidden', isHidden: true }),
      makeMessage({ role: 'result', text: 'Response' }),
    ];
    const result = prepareEligibleMessages(makeSession(msgs));
    expect(result).toHaveLength(2);
    expect(result.map(m => m.text)).toEqual(['Hello', 'Response']);
  });

  it('filters out warning messages', () => {
    const msgs = [
      makeMessage({ role: 'user', text: 'Hello' }),
      makeMessage({ role: 'assistant', text: 'warning text', isWarning: true }),
      makeMessage({ role: 'result', text: 'Response' }),
    ];
    const result = prepareEligibleMessages(makeSession(msgs));
    expect(result).toHaveLength(2);
  });

  it('filters out empty text messages', () => {
    const msgs = [
      makeMessage({ role: 'user', text: 'Hello' }),
      makeMessage({ role: 'assistant', text: '   ' }),
      makeMessage({ role: 'result', text: 'Response' }),
    ];
    const result = prepareEligibleMessages(makeSession(msgs));
    expect(result).toHaveLength(2);
  });

  it('applies compaction boundary slicing', () => {
    const msgs = [
      makeMessage({ role: 'user', text: 'Old message' }),
      makeMessage({ role: 'result', text: 'Old response' }),
      makeMessage({ role: 'user', text: 'Post-boundary' }),
      makeMessage({ role: 'result', text: 'New response' }),
    ];
    const boundaries = [{ afterMessageIndex: 1, appliedAt: Date.now() }] as unknown as AgentSession['compactionBoundaries'];
    const result = prepareEligibleMessages(makeSession(msgs, boundaries));
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('Post-boundary');
  });

  it('uses the highest boundary index when multiple exist', () => {
    const msgs = [
      makeMessage({ role: 'user', text: 'Old 1' }),
      makeMessage({ role: 'result', text: 'Old resp 1' }),
      makeMessage({ role: 'user', text: 'Old 2' }),
      makeMessage({ role: 'result', text: 'Old resp 2' }),
      makeMessage({ role: 'user', text: 'After last boundary' }),
      makeMessage({ role: 'result', text: 'Latest' }),
    ];
    const boundaries = [
      { afterMessageIndex: 1, appliedAt: Date.now() - 1000 },
      { afterMessageIndex: 3, appliedAt: Date.now() },
    ] as unknown as AgentSession['compactionBoundaries'];
    const result = prepareEligibleMessages(makeSession(msgs, boundaries));
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('After last boundary');
  });

  it('preserves attachment texts on user messages', () => {
    const msgs = [
      makeMessage({ role: 'user', text: 'See doc', attachmentTexts: { 'report.pdf': 'quarterly report data' } }),
      makeMessage({ role: 'result', text: 'Analyzed' }),
    ];
    const result = prepareEligibleMessages(makeSession(msgs));
    expect(result[0].attachmentTexts).toEqual({ 'report.pdf': 'quarterly report data' });
  });

  it('includes hidden system-continuation messages (AskUserQuestion answers)', () => {
    const msgs = [
      makeMessage({ role: 'user', text: 'Help me decide' }),
      makeMessage({ role: 'assistant', text: 'Let me ask you a question' }),
      makeMessage({ role: 'user', text: 'The user answered your questions: ...', isHidden: true, messageOrigin: 'system-continuation' }),
      makeMessage({ role: 'assistant', text: 'Based on your answer' }),
    ];
    const result = prepareEligibleMessages(makeSession(msgs));
    expect(result).toHaveLength(4);
    expect(result[2].text).toContain('The user answered your questions');
  });

  it('excludes hidden messages without a messageOrigin (legacy sessions pre-Stage-1)', () => {
    // Legacy sessions persisted before Stage 1 (April 2026) may have isHidden: true
    // without a messageOrigin stamp. These remain excluded from history injection.
    const msgs = [
      makeMessage({ role: 'user', text: 'Hello' }),
      makeMessage({ role: 'user', text: 'legacy hidden message', isHidden: true }),
      makeMessage({ role: 'result', text: 'Response' }),
    ];
    const result = prepareEligibleMessages(makeSession(msgs));
    expect(result).toHaveLength(2);
    expect(result.map(m => m.text)).toEqual(['Hello', 'Response']);
  });
});

// Direct mock functions for loadIntelligentConversationHistory deps (no vi.mock needed)
const mockGetSession = vi.fn();
const mockGenerateIntelligentSummary = vi.fn();

function makeTestDeps(): LoadIntelligentConversationHistoryDeps {
  return {
    getIncrementalSessionStore: (() => ({ getSession: mockGetSession })) as unknown as LoadIntelligentConversationHistoryDeps['getIncrementalSessionStore'],
    generateIntelligentSummary: mockGenerateIntelligentSummary as unknown as LoadIntelligentConversationHistoryDeps['generateIntelligentSummary'],
    getSettings: (() => ({ behindTheScenesModel: 'claude-sonnet-4-20250514' })) as unknown as LoadIntelligentConversationHistoryDeps['getSettings'],
  };
}

describe('loadIntelligentConversationHistory', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockGenerateIntelligentSummary.mockReset();
  });

  it('returns empty string when resetConversation is true', async () => {
    const result = await loadIntelligentConversationHistory('session-1', undefined, true, makeTestDeps());
    expect(result).toBe('');
  });

  it('returns empty string when session not found', async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await loadIntelligentConversationHistory('session-1', undefined, undefined, makeTestDeps());
    expect(result).toBe('');
  });

  it('returns basic history when intelligent summary returns empty', async () => {
    const session = makeSession([
      makeMessage({ role: 'user', text: 'Hello' }),
      makeMessage({ role: 'result', text: 'Hi there' }),
    ]);
    mockGetSession.mockResolvedValue(session);
    mockGenerateIntelligentSummary.mockResolvedValue({
      olderSummary: '',
      recentMessages: [],
    });

    const result = await loadIntelligentConversationHistory('session-1', undefined, undefined, makeTestDeps());
    expect(result).toContain('<conversation_history>');
    expect(result).toContain('[user]: Hello');
  });

  it('formats intelligent summary with sections when available', async () => {
    const session = makeSession([
      makeMessage({ role: 'user', text: 'First question' }),
      makeMessage({ role: 'result', text: 'First answer' }),
      makeMessage({ role: 'user', text: 'Second question' }),
      makeMessage({ role: 'result', text: 'Second answer' }),
    ]);
    mockGetSession.mockResolvedValue(session);
    mockGenerateIntelligentSummary.mockResolvedValue({
      olderSummary: 'Summary of earlier context',
      recentMessages: [
        makeMessage({ role: 'user', text: 'Second question' }),
        makeMessage({ role: 'result', text: 'Second answer' }),
      ],
    });

    const result = await loadIntelligentConversationHistory('session-1', undefined, undefined, makeTestDeps());
    expect(result).toContain('Earlier context (summarized)');
    expect(result).toContain('Summary of earlier context');
    expect(result).toContain('Recent turns');
    expect(result).toContain('[user]: Second question');
    expect(result).toContain('[assistant]: Second answer');
    expect(result).toContain('intelligently summarized');
  });

  it('falls back to basic history when generateIntelligentSummary throws', async () => {
    const session = makeSession([
      makeMessage({ role: 'user', text: 'Hello' }),
      makeMessage({ role: 'result', text: 'Hi there' }),
    ]);
    mockGetSession.mockResolvedValue(session);
    mockGenerateIntelligentSummary.mockRejectedValue(new Error('BTS failed'));

    const result = await loadIntelligentConversationHistory('session-1', undefined, undefined, makeTestDeps());
    expect(result).toContain('<conversation_history>');
    expect(result).toContain('[user]: Hello');
  });
});

describe('buildConversationHistoryContext uses prepareEligibleMessages', () => {
  it('produces same output as before (regression)', () => {
    const msgs = [
      makeMessage({ role: 'user', text: 'Hello' }),
      makeMessage({ role: 'result', text: 'Hi there' }),
    ];
    const result = buildConversationHistoryContext(makeSession(msgs));
    expect(result).toContain('[user]: Hello');
    expect(result).toContain('[assistant]: Hi there');
    expect(result).toContain('<conversation_history>');
  });

  it('returns empty for single message', () => {
    const msgs = [makeMessage({ role: 'user', text: 'Hello' })];
    expect(buildConversationHistoryContext(makeSession(msgs))).toBe('');
  });
});
